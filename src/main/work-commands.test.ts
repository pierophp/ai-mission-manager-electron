import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, readFileSync } from "node:fs";
import { createCommandDispatcher, invokeEnvelope } from "../shared/ipc";
import { Runtime } from "./runtime";
import { createWorkCommandHandlers } from "./work-commands";
import { openSqliteStore } from "./persistence/sqlite-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Item, Home and search commands", () => {
  it("submits one complete Grill answer set through the Pane and persists its response", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-grill-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initial = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as import("../domain/model").DomainState;
    const run = structuredClone(initial.runs[0]!);
    run.execution_profile = "grill";
    run.state = "finished";
    run.grill_phase = "waitingForAnswers";
    run.grill_answers = [];
    run.grill_decisions = [];
    run.grill_response = null;
    run.worktree_id = null;
    initial.runs[0] = run;
    const runtime = new Runtime(store, initial);
    const { FakeTerminalRuntime } = await import("./terminal");
    const terminal = new FakeTerminalRuntime();
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );

    let release!: () => void;
    terminal.gates.set(
      run.machine_id,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const request = { runId: run.id, answers: [{ questionNumber: 1, answer: "Keep it" }] };
    const first = invokeEnvelope(dispatch, "submit_grill_answers", request);
    while (!terminal.calls.some((call) => call.operation === "send-keys"))
      await new Promise((resolve) => setTimeout(resolve, 0));
    const second = invokeEnvelope(dispatch, "submit_grill_answers", request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminal.calls.filter((call) => call.operation === "send-keys")).toHaveLength(1);
    release();
    const submitted = (await first) as import("../domain/execution-types").Run;
    expect(submitted).toMatchObject({
      state: "working",
      grill_phase: "working",
      grill_response: "1. Keep it",
      grill_decisions: [{ questionNumber: 1, answer: "Keep it" }],
    });
    expect(store.loadState().runs[0]).toMatchObject({
      grill_phase: "working",
      grill_response: "1. Keep it",
      grill_answers: [{ questionNumber: 1, answer: "Keep it" }],
    });
    await expect(second).rejects.toBe(`Run ${run.id} is not waiting for Grill answers`);
    expect(terminal.calls.filter((call) => call.operation === "send-keys")).toHaveLength(1);
    store.close();
  });

  it("continues a Grill Run through its serialized Run command", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-grill-continue-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initial = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as import("../domain/model").DomainState;
    const run = initial.runs[0]!;
    run.execution_profile = "grill";
    run.state = "finished";
    run.grill_phase = "awaitingNextAction";
    run.grill_question_group = null;
    run.grill_answers = [];
    run.grill_response = null;
    run.grill_action = null;
    run.worktree_id = null;
    const runtime = new Runtime(store, initial);
    const { FakeTerminalRuntime } = await import("./terminal");
    const terminal = new FakeTerminalRuntime();
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );

    const continued = (await invokeEnvelope(dispatch, "continue_grill", {
      runId: run.id,
      action: "to-spec",
    })) as import("../domain/execution-types").Run;
    expect(terminal.calls.filter((call) => call.operation === "send-keys")).toHaveLength(1);
    expect(continued).toMatchObject({
      state: "working",
      grill_phase: "working",
      grill_action: "to-spec",
    });
    expect(continued.grill_action_started_at).toEqual(expect.any(Number));
    store.close();
  });

  it("serializes concurrent Grill continuations so the Pane only receives one", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-grill-continue-race-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initial = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as import("../domain/model").DomainState;
    const run = initial.runs[0]!;
    run.execution_profile = "grill";
    run.state = "finished";
    run.grill_phase = "awaitingNextAction";
    run.grill_question_group = null;
    run.grill_answers = [];
    run.grill_response = null;
    run.grill_action = null;
    run.worktree_id = null;
    const runtime = new Runtime(store, initial);
    const { FakeTerminalRuntime } = await import("./terminal");
    const terminal = new FakeTerminalRuntime();
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );
    let release!: () => void;
    terminal.gates.set(
      run.machine_id,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const request = { runId: run.id, action: "to-spec" };
    const first = invokeEnvelope(dispatch, "continue_grill", request);
    while (!terminal.calls.some((call) => call.operation === "send-keys"))
      await new Promise((resolve) => setTimeout(resolve, 0));
    const second = invokeEnvelope(dispatch, "continue_grill", request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminal.calls.filter((call) => call.operation === "send-keys")).toHaveLength(1);

    release();
    await expect(first).resolves.toMatchObject({
      state: "working",
      grill_phase: "working",
      grill_action: "to-spec",
    });
    await expect(second).rejects.toThrow();
    expect(terminal.calls.filter((call) => call.operation === "send-keys")).toHaveLength(1);
    store.close();
  });

  it("sends Go for an approved Plan Run and persists the executing phase", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-plan-go-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initial = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as import("../domain/model").DomainState;
    const run = initial.runs[0]!;
    run.execution_profile = "plan";
    run.workflow = "pstack";
    run.state = "finished";
    run.plan_phase = "awaitingGo";
    run.plan_path = "/tmp/approved-plan.md";
    run.pane_status = "available";
    run.worktree_id = null;
    const runtime = new Runtime(store, initial);
    const { FakeTerminalRuntime } = await import("./terminal");
    const terminal = new FakeTerminalRuntime();
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );

    const started = (await invokeEnvelope(dispatch, "go_plan", {
      runId: run.id,
    })) as import("../domain/execution-types").Run;

    expect(terminal.calls.filter((call) => call.operation === "send-keys")).toHaveLength(1);
    expect(started).toMatchObject({ state: "working", plan_phase: "executing" });
    expect(store.loadState().runs[0]).toMatchObject({
      state: "working",
      plan_phase: "executing",
      plan_path: "/tmp/approved-plan.md",
    });
    store.close();
  });

  it("captures a Grill-created local Markdown Spec and persists its provenance", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-grill-capture-"));
    directories.push(directory);
    const checkout = path.join(directory, "checkout");
    mkdirSync(path.join(checkout, ".scratch"), { recursive: true });
    writeFileSync(path.join(checkout, ".scratch/spec.md"), "# Captured Spec\n\nDetails.\n");
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initial = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as import("../domain/model").DomainState;
    initial.external_objects = [];
    initial.links = [];
    initial.snapshots = [];
    initial.next_external_object_id = 1;
    initial.next_link_id = 1;
    const raw = new DatabaseSync(file);
    raw.exec(
      "DELETE FROM external_snapshots; DELETE FROM external_links; DELETE FROM external_objects",
    );
    raw.close();
    const run = initial.runs[0]!;
    run.execution_profile = "grill";
    run.state = "finished";
    run.grill_phase = "awaitingNextAction";
    run.grill_action = "to-spec";
    run.grill_action_started_at = null;
    run.pane_status = "available";
    run.worktree_id = null;
    initial.contexts[0]!.execution_machine_id = run.machine_id;
    initial.repository_locations[0]!.checkout_path = checkout;
    const runtime = new Runtime(store, initial);
    const { FakeTerminalRuntime } = await import("./terminal");
    const terminal = new FakeTerminalRuntime();
    terminal.panes.set(run.machine_id, [
      { sessionName: run.session_name, paneId: run.pane_id, agentState: null },
    ]);
    terminal.transcripts.set(
      `${run.machine_id}:${run.pane_id}`,
      `AI_MISSION_MANAGER_EVENT {"event":"external.object.created","url":".scratch/spec.md","run_id":${run.id},"action":"to-spec"}`,
    );
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );

    await invokeEnvelope(dispatch, "reconcile_runs", {});

    expect(runtime.snapshot().external_objects).toHaveLength(1);
    expect(runtime.snapshot().external_objects[0]).toMatchObject({
      provider: "generic",
      external_key: "local:1#.scratch/spec.md",
    });
    expect(runtime.snapshot().links[0]).toMatchObject({
      item_id: run.item_id,
      purpose: "to-spec",
      provenance: {
        run_id: run.id,
        action: "to-spec",
        discovery: "structured-event",
      },
    });
    expect(store.loadState().links[0]).toMatchObject({
      purpose: "to-spec",
      provenance: { run_id: run.id, action: "to-spec" },
    });
    store.close();
  });

  it("resolves a Worktree Run's local Markdown Spec against the registered checkout", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-grill-worktree-capture-"));
    directories.push(directory);
    const checkout = path.join(directory, "checkout");
    const worktree = path.join(directory, "worktree");
    mkdirSync(path.join(checkout, ".scratch"), { recursive: true });
    mkdirSync(path.join(worktree, ".scratch"), { recursive: true });
    writeFileSync(path.join(checkout, ".scratch/spec.md"), "# Registered Checkout Spec\n");
    writeFileSync(path.join(worktree, ".scratch/spec.md"), "# Worktree Copy\n");
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initial = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as import("../domain/model").DomainState;
    initial.external_objects = [];
    initial.links = [];
    initial.snapshots = [];
    initial.next_external_object_id = 1;
    initial.next_link_id = 1;
    const raw = new DatabaseSync(file);
    raw.exec(
      "DELETE FROM external_snapshots; DELETE FROM external_links; DELETE FROM external_objects",
    );
    raw.close();
    const run = initial.runs[0]!;
    run.execution_profile = "grill";
    run.state = "finished";
    run.grill_phase = "awaitingNextAction";
    run.grill_action = "to-spec";
    run.grill_action_started_at = null;
    run.pane_status = "available";
    run.direct_checkouts = [];
    run.worktree_id = 99;
    run.working_directory = worktree;
    initial.contexts[0]!.execution_machine_id = run.machine_id;
    initial.repository_locations[0]!.checkout_path = checkout;
    initial.repository_locations[0]!.worktree_root = worktree;
    const runtime = new Runtime(store, initial);
    const { FakeTerminalRuntime } = await import("./terminal");
    const terminal = new FakeTerminalRuntime();
    terminal.panes.set(run.machine_id, [
      { sessionName: run.session_name, paneId: run.pane_id, agentState: null },
    ]);
    terminal.transcripts.set(
      `${run.machine_id}:${run.pane_id}`,
      `AI_MISSION_MANAGER_EVENT {"event":"external.object.created","url":".scratch/spec.md","run_id":${run.id},"action":"to-spec"}`,
    );
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );

    await invokeEnvelope(dispatch, "reconcile_runs", {});

    expect(runtime.snapshot().external_objects[0]).toMatchObject({
      provider: "generic",
      external_key: "local:1#.scratch/spec.md",
      canonical_url: expect.stringContaining(checkout),
    });
    expect(runtime.snapshot().snapshots[0]).toMatchObject({ title: "Registered Checkout Spec" });
    expect(runtime.snapshot().snapshots[0]?.title).not.toBe("Worktree Copy");
    store.close();
  });

  it("dispatches compatible commands and persists Items, title, reminders and relation casing", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-items-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    const store = openSqliteStore(file);
    const runtime = new Runtime(store);
    const dispatch = createCommandDispatcher(createWorkCommandHandlers(runtime));

    const first = (await invokeEnvelope(dispatch, "create_item", {
      title: "Search persistence",
      contextId: 1,
      projectId: 1,
      notes: "Findable note",
    })) as { id: number; human_identifier: string };
    const second = (await invokeEnvelope(dispatch, "create_item", {
      title: "Second Item",
      contextId: 1,
      projectId: 1,
      notes: "",
    })) as { id: number };
    expect(first).toMatchObject({ id: 1, human_identifier: "I-1" });

    await invokeEnvelope(dispatch, "set_item_title", {
      itemId: first.id,
      title: "Persisted title",
    });
    await invokeEnvelope(dispatch, "set_item_status", { itemId: first.id, status: "Active" });
    await invokeEnvelope(dispatch, "add_item_reminder", {
      itemId: first.id,
      remindAt: "2026-09-29T00:00:00Z",
    });
    const relation = await invokeEnvelope(dispatch, "set_item_relation", {
      fromItemId: first.id,
      toItemId: second.id,
      kind: "Blocks",
    });
    expect(relation).toMatchObject({ kind: "Blocks" });

    const home = (await invokeEnvelope(dispatch, "get_home", {
      contextId: 1,
      now: "2026-09-30T00:00:00Z",
    })) as {
      due: { item: { id: number } }[];
    };
    expect(home.due.map(({ item }) => item.id)).toEqual([first.id]);
    const found = (await invokeEnvelope(dispatch, "search_items_command", {
      query: "findable",
      contextId: 1,
    })) as { item: { id: number } }[];
    expect(found.map(({ item }) => item.id)).toEqual([first.id]);

    const raw = new DatabaseSync(file, { readOnly: true });
    expect(raw.prepare("SELECT title FROM items WHERE id=?").get(first.id)).toEqual({
      title: "Persisted title",
    });
    expect(raw.prepare("SELECT kind FROM item_relationships").get()).toEqual({ kind: "blocks" });
    expect(
      raw.prepare("SELECT action_json FROM audit_entries ORDER BY id DESC LIMIT 1").get(),
    ).toEqual({
      action_json:
        '{"action":"itemRelationChanged","from_item_id":1,"to_item_id":2,"kind":"Blocks"}',
    });
    expect(raw.prepare("SELECT remind_at FROM reminders WHERE item_id=?").get(first.id)).toEqual({
      remind_at: "2026-09-29T00:00:00Z",
    });
    raw.close();
    store.close();

    const reopened = openSqliteStore(file);
    expect(reopened.loadState().items.find(({ id }) => id === first.id)).toMatchObject({
      title: "Persisted title",
      status: "Active",
      reminders: [{ id: 1, remind_at: "2026-09-29T00:00:00Z" }],
    });
    reopened.close();
  });
});

describe("Run reconciliation", () => {
  it("updates Run state and pane status from Rust-compatible records, with single-flight protection", async () => {
    const { copyFileSync } = await import("node:fs");
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-reconcile-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initialState = store.loadState();
    initialState.runs[0]!.execution_profile = "grill";
    initialState.runs[0]!.pane_status = "unknown";
    initialState.runs[0]!.state = "working";
    initialState.implementation_queues[0]!.entries = [
      {
        position: 0,
        ticketNumber: 42,
        ticketTitle: "Follow-up",
        ticketUrl: "https://github.com/acme/app/issues/42",
        ticketState: "OPEN",
        runId: 1,
        done: false,
        skipped: false,
      },
    ];
    const runtime = new Runtime(store, initialState);
    const { FakeTerminalRuntime } = await import("./terminal");
    const { FakeMachineAccess } = await import("./machine-access");
    const terminal = new FakeTerminalRuntime();
    const machine = runtime.snapshot().machines[0]!;
    terminal.panes.set(machine.id, [
      { sessionName: "mission-item-1-run-1", paneId: "%1", agentState: null },
    ]);
    terminal.stateRecords.set(machine.id, [
      { agent: "claude", runId: "1", state: "blocked", updatedAt: "200", sequence: 1 },
    ]);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started!: () => void;
    const observed = new Promise<void>((resolve) => {
      started = resolve;
    });
    terminal.gate = gate;
    terminal.onObserve = started;
    const events: { runId: number; state: string }[] = [];
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, new FakeMachineAccess(), terminal, (event) =>
        events.push(event),
      ),
    );
    const first = invokeEnvelope(dispatch, "reconcile_runs", {});
    await observed;
    expect(await invokeEnvelope(dispatch, "reconcile_runs", {})).toEqual({
      failures: [],
      changed: false,
    });
    expect(terminal.calls.filter((call) => call.operation === "observeMachine")).toHaveLength(1);
    unblock();
    expect(await first).toEqual({ failures: [], changed: true });
    expect(runtime.snapshot().runs[0]).toMatchObject({
      state: "blocked",
      last_applied_agent_state_sequence: 1,
      pane_status: "available",
    });
    expect(events).toEqual([{ runId: 1, state: "blocked" }]);
    terminal.stateRecords.set(machine.id, [
      { agent: "claude", runId: "1", state: "working", updatedAt: "300", sequence: 1 },
    ]);
    terminal.gate = undefined;
    await invokeEnvelope(dispatch, "reconcile_runs", {});
    expect(runtime.snapshot().runs[0]?.state).toBe("blocked");
    terminal.errors.set(machine.id, new Error("Machine Local tmux exited with exit status: 1"));
    const failed = (await invokeEnvelope(dispatch, "reconcile_runs", {})) as {
      failures: { kind: string }[];
      changed: boolean;
    };
    expect(failed.failures).toMatchObject([{ kind: "tmuxQueryFailed" }]);
    expect(runtime.snapshot().runs[0]).toMatchObject({ state: "blocked", pane_status: "unknown" });
    terminal.errors.delete(machine.id);
    terminal.panes.set(machine.id, []);
    terminal.stateRecords.set(machine.id, [
      { agent: "claude", runId: "1", state: "finished", updatedAt: "400", sequence: 2 },
    ]);
    await invokeEnvelope(dispatch, "reconcile_runs", {});
    expect(runtime.snapshot().runs[0]).toMatchObject({
      state: "finished",
      pane_status: "missing",
      last_applied_agent_state_sequence: 2,
      grill_phase: "recoverablePaneLoss",
    });
    expect(runtime.snapshot().implementation_queues[0]?.pausedReason).toEqual({
      kind: "pane_missing",
    });
    const raw = new DatabaseSync(file, { readOnly: true });
    const queueJson = (
      raw.prepare("SELECT queue_json FROM implementation_queues WHERE id=1").get() as {
        queue_json: string;
      }
    ).queue_json;
    expect(JSON.parse(queueJson).pausedReason).toEqual({ kind: "pane_missing" });
    raw.close();
    store.close();
  });
});

describe("embedded terminal commands", () => {
  it("allows a sibling Pane and lets a newer open win over a stale connection", async () => {
    const { copyFileSync } = await import("node:fs");
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-terminal-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initialState = store.loadState();
    initialState.runs[0]!.execution_profile = "grill";
    const runtime = new Runtime(store, initialState);
    const { FakeTerminalConnection } = await import("./terminal");
    const stale = new FakeTerminalConnection();
    const current = new FakeTerminalConnection();
    let releaseStale!: () => void;
    const staleCapture = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    stale.gates.set("capturePaneSnapshot", staleCapture);
    stale.snapshot = new Uint8Array([11]);
    current.snapshot = new Uint8Array([22]);
    let stateListener: ((record: import("./terminal").AgentStateRecord) => void) | undefined;
    let observeCalls = 0;
    const run = runtime.snapshot().runs[0]!;
    const pane = {
      paneId: "%2",
      paneIndex: 0,
      panePid: 123,
      paneWidth: 80,
      paneHeight: 24,
      paneTitle: "Claude",
      currentCommand: "claude",
      currentPath: "/work",
    };
    let attachment = 0;
    const terminal = {
      listPanes: async () => [pane],
      observeMachine: async () => {
        observeCalls += 1;
        return {
          panes: [{ sessionName: run.session_name, paneId: run.pane_id, agentState: null }],
          stateRecords: [],
        };
      },
      attachConnection: async (
        _machine: unknown,
        _session: string,
        _pane: string,
        callbacks: import("./terminal").TerminalConnectionCallbacks,
      ) => {
        stateListener = callbacks.onAgentState;
        return attachment++ === 0 ? stale : current;
      },
    } as never;
    const stateEvents: { runId: number; state: string }[] = [];
    const questionEvents: number[] = [];
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(
        runtime,
        undefined,
        terminal,
        (event) => stateEvents.push(event),
        undefined,
        (runId) => questionEvents.push(runId),
      ),
    );
    const args = {
      runId: 1,
      terminalId: "terminal-a",
      sessionName: "mission-item-1-run-1",
      paneId: "%2",
    };
    const first = invokeEnvelope(dispatch, "open_terminal", args);
    while (stale.calls.every((call) => call.operation !== "capturePaneSnapshot"))
      await new Promise((resolve) => setTimeout(resolve, 0));
    const second = (await invokeEnvelope(dispatch, "open_terminal", args)) as {
      generation: number;
      snapshot: number[];
    };
    expect(second).toMatchObject({ generation: 2, snapshot: [22] });
    expect(runtime.snapshot().runs[0]?.pane_status).toBe("available");
    expect(store.loadState().runs[0]?.pane_status).toBe("available");
    stateListener?.({
      agent: run.agent,
      runId: String(run.id),
      state: "blocked",
      updatedAt: "now",
      sequence: 1,
    });
    expect(runtime.snapshot().runs[0]).toMatchObject({
      state: "blocked",
      last_applied_agent_state_sequence: 1,
    });
    expect(store.loadState().runs[0]).toMatchObject({
      state: "blocked",
      last_applied_agent_state_sequence: 1,
    });
    expect(stateEvents).toEqual([{ runId: run.id, state: "blocked" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observeCalls).toBeGreaterThanOrEqual(3);
    expect(questionEvents).toEqual([run.id]);
    releaseStale();
    await expect(first).rejects.toBe("A newer terminal open superseded this request");
    expect(stale.closed).toBe(true);
    expect(runtime.terminalConnection("terminal-a")?.generation).toBe(2);
    await invokeEnvelope(dispatch, "close_terminal", { terminalId: "terminal-a" });
    store.close();
  });

  it("closes an attached connection when the second live Pane check fails", async () => {
    const { copyFileSync } = await import("node:fs");
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-terminal-list-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const runtime = new Runtime(store);
    const { FakeTerminalConnection } = await import("./terminal");
    const connection = new FakeTerminalConnection();
    let listCount = 0;
    const pane = {
      paneId: "%1",
      paneIndex: 0,
      panePid: 123,
      paneWidth: 80,
      paneHeight: 24,
      paneTitle: "Claude",
      currentCommand: "claude",
      currentPath: "/work",
    };
    const terminal = {
      listPanes: async () => {
        listCount += 1;
        if (listCount === 2) throw new Error("Pane listing failed");
        return [pane];
      },
      attachConnection: async () => connection,
    } as never;
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );
    await expect(
      invokeEnvelope(dispatch, "open_terminal", {
        runId: 1,
        terminalId: "",
        sessionName: "mission-item-1-run-1",
        paneId: "%1",
      }),
    ).rejects.toBe("A terminal identity is required");
    await expect(
      invokeEnvelope(dispatch, "open_terminal", {
        runId: 1,
        terminalId: " \t ",
        sessionName: "mission-item-1-run-1",
        paneId: "%1",
      }),
    ).rejects.toBe("A terminal identity is required");
    await expect(
      invokeEnvelope(dispatch, "terminal_input", { terminalId: "missing", input: [1] }),
    ).rejects.toBe("The embedded terminal is not attached");
    await expect(
      invokeEnvelope(dispatch, "terminal_resize", {
        terminalId: "missing",
        columns: 80,
        rows: 24,
      }),
    ).rejects.toBe("The embedded terminal is not attached");
    const result = await dispatch("open_terminal", {
      runId: 1,
      terminalId: "terminal-b",
      sessionName: "mission-item-1-run-1",
      paneId: "%1",
    });
    expect(result).toEqual({ ok: false, error: "Pane listing failed" });
    expect(connection.closed).toBe(true);
    expect(runtime.terminalConnection("terminal-b")).toBeUndefined();
    store.close();
  });

  it("rejects an open superseded while it closes the previous connection", async () => {
    const { copyFileSync } = await import("node:fs");
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-terminal-close-race-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const runtime = new Runtime(store);
    const { FakeTerminalConnection } = await import("./terminal");
    const connections = [
      new FakeTerminalConnection(),
      new FakeTerminalConnection(),
      new FakeTerminalConnection(),
      new FakeTerminalConnection(),
    ];
    const availableConnections = [...connections];
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    connections[1]!.gates.set("close", closeGate);
    for (const [index, connection] of connections.entries())
      connection.snapshot = new Uint8Array([index]);
    const pane = {
      paneId: "%1",
      paneIndex: 0,
      panePid: 123,
      paneWidth: 80,
      paneHeight: 24,
      paneTitle: "Claude",
      currentCommand: "claude",
      currentPath: "/work",
    };
    const run = runtime.snapshot().runs[0]!;
    const terminal = {
      listPanes: async () => [pane],
      observeMachine: async () => ({
        panes: [{ sessionName: run.session_name, paneId: run.pane_id, agentState: null }],
        stateRecords: [],
      }),
      attachConnection: async () => availableConnections.shift()!,
    } as never;
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, undefined, terminal),
    );
    const args = {
      runId: 1,
      terminalId: "terminal-close-race",
      sessionName: run.session_name,
      paneId: run.pane_id,
    };
    await invokeEnvelope(dispatch, "open_terminal", args);
    await invokeEnvelope(dispatch, "open_terminal", args);
    const superseded = invokeEnvelope(dispatch, "open_terminal", args);
    while (!connections[1]!.calls.some((call) => call.operation === "close"))
      await new Promise((resolve) => setTimeout(resolve, 0));
    const latest = (await invokeEnvelope(dispatch, "open_terminal", args)) as {
      generation: number;
    };
    expect(latest.generation).toBe(4);
    releaseClose();
    await expect(superseded).rejects.toBe("A newer terminal open superseded this request");
    expect(runtime.terminalConnection(args.terminalId)?.generation).toBe(4);
    await invokeEnvelope(dispatch, "close_terminal", { terminalId: args.terminalId });
    store.close();
  });
});

describe("Run suggestions", () => {
  it("suggests and attaches a Pane only to its registered Worktree, then controls it through the fake", async () => {
    const { copyFileSync } = await import("node:fs");
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-attach-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "persistence/fixtures/rust-persistence.sqlite"), file);
    const store = openSqliteStore(file);
    const initialState = store.loadState();
    initialState.contexts[0]!.execution_machine_id = 1;
    initialState.next_run_id = 2;
    const runtime = new Runtime(store, initialState);
    const { FakeTerminalRuntime } = await import("./terminal");
    const { FakeMachineAccess } = await import("./machine-access");
    const terminal = new FakeTerminalRuntime();
    terminal.agentPanes.set(1, [
      {
        agent: "codex",
        sessionName: "manual",
        paneId: "%91",
        currentPath: "/worktrees/fixture/src",
      },
    ]);
    const dispatch = createCommandDispatcher(
      createWorkCommandHandlers(runtime, new FakeMachineAccess(), terminal),
    );
    const suggestions = (await invokeEnvelope(dispatch, "list_run_suggestions", {})) as {
      paneId: string;
      worktreeId: number | null;
    }[];
    expect(suggestions).toMatchObject([{ paneId: "%91", worktreeId: 1 }]);
    await invokeEnvelope(dispatch, "stop_untracked_agent", { suggestion: suggestions[0] });
    expect(terminal.calls.at(-1)?.operation).toBe("interruptPane");
    await invokeEnvelope(dispatch, "delete_untracked_agent", { suggestion: suggestions[0] });
    expect(terminal.calls.at(-1)?.operation).toBe("killPane");
    terminal.agentPanes.set(1, [
      {
        agent: "codex",
        sessionName: "manual",
        paneId: "%92",
        currentPath: "/worktrees/fixture/src",
      },
    ]);
    const nextSuggestions = (await invokeEnvelope(dispatch, "list_run_suggestions", {})) as {
      paneId: string;
      worktreeId: number | null;
    }[];
    const run = (await invokeEnvelope(dispatch, "attach_run", {
      suggestion: nextSuggestions[0],
    })) as { id: number; pane_id: string; worktree_id: number | null };
    expect(run).toMatchObject({ pane_id: "%92", worktree_id: 1 });
    store.close();
  });
});
