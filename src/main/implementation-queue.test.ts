import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { openSqliteStore } from "./persistence/sqlite-store";
import { createWorkCommandHandlers } from "./work-commands";
import { FakeTerminalRuntime } from "./terminal";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(dirty = false, localMarkdown = false, ticketUrlOverride?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "mission-queue-"));
  directories.push(directory);
  const store = openSqliteStore(path.join(directory, "db.sqlite"));
  const state = JSON.parse(
    readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
  ) as import("../domain/model").DomainState;
  let checkoutIsDirty = dirty;
  const seed = new DatabaseSync(store.path);
  seed
    .prepare(
      "INSERT INTO items(id,human_identifier,title,project_id,status,notes) VALUES(1,'I-1','Fixture item',1,'Active','')",
    )
    .run();
  seed.close();
  const machine = state.machines[0]!;
  state.contexts[0]!.execution_machine_id = machine.id;
  state.contexts[0]!.check_dirty_checkouts = true;
  state.contexts[0]!.gh_executable_path = path.join(directory, "gh");
  const checkout = path.join(directory, "checkout");
  if (localMarkdown) {
    mkdirSync(checkout);
    writeFileSync(path.join(checkout, "ISSUE.md"), "# First\nStatus: Completed\n");
    state.repository_locations[0]!.checkout_path = checkout;
  }
  const ticketUrl =
    ticketUrlOverride ??
    (localMarkdown
      ? `local:${state.repositories[0]!.id}#ISSUE.md`
      : "https://github.com/acme/app/issues/89");
  state.implementation_queues = [
    {
      id: state.runs[0]!.id,
      itemId: state.items[0]!.id,
      specExternalObjectId: state.external_objects[0]!.id,
      specUrl: state.external_objects[0]!.canonical_url,
      workspaceId: state.runs[0]!.workspace_id!,
      repositoryId: state.runs[0]!.repository_id!,
      configuration: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      allowDirty: false,
      allowSharedCheckouts: false,
      entries: [
        {
          position: 0,
          ticketNumber: 89,
          ticketTitle: "First",
          ticketUrl,
          ticketState: "open",
          runId: 1,
          done: false,
          skipped: false,
        },
        {
          position: 1,
          ticketNumber: 90,
          ticketTitle: "Second",
          ticketUrl: "https://github.com/acme/app/issues/90",
          ticketState: "open",
          runId: null,
          done: false,
          skipped: false,
        },
      ],
      active: true,
      pausedReason: null,
    },
  ];
  state.runs[0]!.execution_profile = "implement";
  state.runs[0]!.state = "working";
  state.runs[0]!.worktree_id = null;
  const writeGhState = (ticketState: string) =>
    writeFileSync(
      state.contexts[0]!.gh_executable_path!,
      `#!/bin/sh\nprintf '%s' '{"number":89,"title":"First","state":"${ticketState}"}'\n`,
    );
  writeGhState("CLOSED");
  chmodSync(state.contexts[0]!.gh_executable_path!, 0o755);
  const runtime = new Runtime(store, state);
  const terminal = new FakeTerminalRuntime();
  terminal.stateRecords.set(machine.id, [
    { agent: "claude", runId: "1", state: "finished", updatedAt: "now", sequence: 1 },
  ]);
  terminal.panes.set(machine.id, [
    { sessionName: state.runs[0]!.session_name, paneId: state.runs[0]!.pane_id, agentState: null },
  ]);
  const access = {
    runShell: async (_machine: unknown, command: string) => {
      if (command.includes("rev-parse --show-toplevel")) return "/repos/app\n";
      if (command.endsWith(" remote")) return "\n";
      if (command.includes("symbolic-ref --short HEAD")) return "main\n";
      if (command.includes("status --porcelain")) return checkoutIsDirty ? " M file\n" : "\n";
      return "";
    },
    machineHome: async () => "/home/test",
    findExecutable: async () => "/bin/true",
    writeFile: async () => undefined,
    checkMachine: async () => ({
      reachable: true,
      tmuxAvailable: true,
      bunAvailable: true,
      bunError: null,
      stateDirectoryWritable: true,
      error: null,
    }),
  };
  let launch!: (
    request: import("../domain/types").RunLaunchRequest,
  ) => Promise<import("../domain/execution-types").Run>;
  const dispatch = createWorkCommandHandlers(
    runtime,
    access,
    terminal,
    undefined,
    undefined,
    undefined,
    async (request) => launch(request),
  );
  return {
    state,
    localTicketPath: path.join(checkout, "ISSUE.md"),
    store,
    runtime,
    terminal,
    dispatch,
    setLaunch(fn: typeof launch) {
      launch = fn;
    },
    setTicketState: writeGhState,
    setDirty(value: boolean) {
      checkoutIsDirty = value;
    },
  };
}

describe("Implementation Queue application lifecycle", () => {
  it("checks provider status and checkout after finished, closes the old session, then gates the next launch", async () => {
    const app = setup(false);
    let release!: () => void;
    let launchStarted!: (request: import("../domain/types").RunLaunchRequest) => void;
    const launched = new Promise<import("../domain/types").RunLaunchRequest>((resolve) => {
      launchStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.setLaunch(async (request) => {
      launchStarted(request);
      await gate;
      return app.runtime.snapshot().runs[0]!;
    });
    const reconcile = app.dispatch.reconcile_runs();
    const request = await launched;
    expect(request.queueAttachment).toEqual({ queueId: 1, position: 1 });
    expect(request.strategy).toMatchObject({
      kind: "direct",
      executionProfile: "implement",
      allowDirty: false,
    });
    expect(request.strategy.kind === "direct" ? request.strategy.prompt : "").toContain(
      "gh issue view 90 --comments",
    );
    expect(request.strategy.kind === "direct" ? request.strategy.prompt : "").toContain(
      "Never close the parent spec or any other issue.",
    );
    expect(request.strategy.kind === "direct" ? request.strategy.workflow : null).toBe(
      "matt-pocock",
    );
    expect(app.runtime.snapshot().implementation_queues[0]!.entries[0]!.done).toBe(true);
    expect(app.terminal.calls).toContainEqual(
      expect.objectContaining({ operation: "kill-session", sessionName: "mission-item-1-run-1" }),
    );
    release();
    await reconcile;
    expect(app.store.loadState().implementation_queues[0]!.entries[0]!.done).toBe(true);
    app.store.close();
  });

  it("pauses instead of advancing when the checkout is dirty", async () => {
    const app = setup(true);
    app.setLaunch(async () => {
      throw new Error("should not launch while dirty");
    });
    await app.dispatch.reconcile_runs();
    expect(app.runtime.snapshot().implementation_queues[0]!.pausedReason).toEqual({
      kind: "checkout_dirty",
    });
    expect(app.terminal.calls.some((call) => call.operation === "kill-session")).toBe(false);
    expect(app.store.loadState().implementation_queues[0]!.pausedReason).toEqual({
      kind: "checkout_dirty",
    });
    app.store.close();
  });

  it("reads a terminal Status from registered local Markdown", async () => {
    const app = setup(false, true);
    app.setLaunch(async () => app.runtime.snapshot().runs[0]!);
    await app.dispatch.reconcile_runs();
    expect(app.runtime.snapshot().implementation_queues[0]!.entries[0]!.done).toBe(true);
    expect(app.runtime.snapshot().implementation_queues[0]!.active).toBe(true);
    app.store.close();
  });

  it("reports a Rust-compatible error when a local ticket Repository is unavailable", async () => {
    const app = setup(false, true, "local:999#ISSUE.md");
    app.runtime.dispatch({ type: "finish_run", runId: 1 });
    app.runtime.dispatch({
      type: "pause_implementation_queue",
      queueId: 1,
      reason: { kind: "ticket_still_open" },
    });
    await expect(app.dispatch.check_implementation_queue({ queueId: 1 })).rejects.toThrow(
      "The Repository for this local Markdown link is unavailable",
    );
    app.store.close();
  });

  it("reports a Rust-compatible error when a local ticket file is missing", async () => {
    const app = setup(false, true, "local:1#MISSING.md");
    app.runtime.dispatch({ type: "finish_run", runId: 1 });
    app.runtime.dispatch({
      type: "pause_implementation_queue",
      queueId: 1,
      reason: { kind: "ticket_still_open" },
    });
    await expect(app.dispatch.check_implementation_queue({ queueId: 1 })).rejects.toThrow(
      /^Local Markdown file 'MISSING\.md' is missing or unreadable in Repository 'app' main checkout:/,
    );
    app.store.close();
  });

  it("reports a Rust-compatible error when the local ticket Context has a remote Machine", async () => {
    const app = setup(false, true);
    app.runtime.dispatch({
      type: "update_machine",
      machineId: 1,
      name: app.state.machines[0]!.name,
      socketName: app.state.machines[0]!.socket_name,
      transport: {
        kind: "ssh",
        host: "example.test",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      },
    });
    app.runtime.dispatch({ type: "finish_run", runId: 1 });
    app.runtime.dispatch({
      type: "pause_implementation_queue",
      queueId: 1,
      reason: { kind: "ticket_still_open" },
    });
    await expect(app.dispatch.check_implementation_queue({ queueId: 1 })).rejects.toThrow(
      "Local Markdown tracker in Context 'Personal' requires a local execution Machine because files are read from the Repository's main checkout",
    );
    app.store.close();
  });

  it("checks a paused queue again and launches the next ticket while retaining its Run", async () => {
    const app = setup();
    app.setTicketState("OPEN");
    let launched: import("../domain/types").RunLaunchRequest | undefined;
    app.setLaunch(async (request) => {
      launched = request;
      return app.runtime.snapshot().runs[0]!;
    });
    await app.dispatch.reconcile_runs();
    expect(app.runtime.snapshot().implementation_queues[0]!.pausedReason).toEqual({
      kind: "ticket_still_open",
    });
    app.setTicketState("CLOSED");
    await app.dispatch.check_implementation_queue({ queueId: 1 });
    expect(app.runtime.snapshot().implementation_queues[0]!.entries[0]!.done).toBe(true);
    expect(launched?.queueAttachment).toEqual({ queueId: 1, position: 1 });
    expect(app.terminal.calls.some((call) => call.operation === "kill-session")).toBe(false);
    app.store.close();
  });
});
