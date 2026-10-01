import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { openSqliteStore } from "./persistence/sqlite-store";
import { createRunLaunchHandlers } from "./run-launcher";
import { createMachineDeletionHandlers } from "./machine-deletion";
import { FakeMachineAccess } from "./machine-access";
import { TmuxTerminalRuntime } from "./terminal";
import type { DomainState } from "../domain/model";
import type { Machine } from "../domain/types";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Run launch IPC gate", () => {
  it("serializes simultaneous Worktree launches and persists each Run before release", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "run-launch-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "launch.sqlite");
    copyFileSync("src/main/persistence/fixtures/rust-persistence.sqlite", databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(
      "DELETE FROM runs; UPDATE metadata SET value=1 WHERE key='next_run_id'; UPDATE metadata SET value=(SELECT COALESCE(MAX(id),0)+1 FROM audit_entries) WHERE key='next_audit_id'; UPDATE contexts SET execution_machine_id=1 WHERE id=1;",
    );
    const fixture = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as DomainState;
    fixture.runs = [];
    fixture.next_run_id = 1;
    fixture.contexts[0]!.execution_machine_id = 1;
    fixture.implementation_queues[0]!.entries = [
      {
        position: 1,
        ticketNumber: 12,
        ticketTitle: "Queue ticket",
        ticketUrl: "https://github.com/acme/app/issues/12",
        ticketState: "OPEN",
        runId: null,
        done: false,
      },
    ];
    const machine = fixture.machines[0]!;
    machine.transport = {
      kind: "ssh",
      host: "fake",
      user: null,
      port: null,
      identityFile: null,
      knownHostsFile: null,
      strictHostKeyChecking: null,
    };
    database
      .prepare("UPDATE machines SET transport_json=? WHERE id=1")
      .run(JSON.stringify(machine.transport));
    database.close();
    const store = openSqliteStore(databasePath);
    const runtime = new Runtime(store, fixture);
    class RecordingAccess extends FakeMachineAccess {
      releases: { count: number; command: string }[] = [];
      mutateOnKill = false;
      mutateMachineOnStop = false;
      override async machineHome(_machine: Machine) {
        return "/home/test";
      }
      override async runShell(_machine: Machine, command: string): Promise<string> {
        if (command.includes("kill-pane") && this.mutateMachineOnStop) {
          this.mutateMachineOnStop = false;
          const machine = runtime.snapshot().machines.find((entry) => entry.id === 1)!;
          runtime.dispatch({
            type: "update_machine",
            machineId: 1,
            name: "Build after stop mutation",
            socketName: machine.socket_name,
            transport: machine.transport,
          });
        }
        if (command.includes("kill-pane") && this.mutateOnKill) {
          this.mutateOnKill = false;
          runtime.dispatch({
            type: "set_item_notes",
            itemId: 1,
            notes: "changed during pane cleanup",
          });
        }
        if (command.includes("display-message")) return "%1";
        if (command.includes("list-panes")) return "%1|0";
        if (command.includes("wait-for -S")) {
          this.releases.push({ count: store.loadState().runs.length, command });
          return "";
        }
        if (command.includes("rev-parse --show-toplevel")) return "/worktrees/fixture";
        if (command.endsWith(" remote")) return "origin";
        if (command.includes("remote get-url")) return "git@github.com:acme/app.git";
        if (command.includes("symbolic-ref --short HEAD")) return "feature/fixture";
        if (command.includes("status --porcelain")) return "";
        if (command.includes('cat "$provider_config"')) return "{}";
        return "";
      }
    }
    const access = new RecordingAccess();
    const terminal = new TmuxTerminalRuntime(access);
    const handlers = createRunLaunchHandlers(runtime, access, terminal);
    const machineDeletion = createMachineDeletionHandlers(runtime, terminal);
    const request = {
      itemId: 1,
      workspaceId: 1,
      strategy: {
        kind: "worktree" as const,
        worktreeId: 1,
        agent: "claude" as const,
        configuration: null,
        executionProfile: "implement" as const,
        workflow: "matt-pocock" as const,
        prompt: "Implement the change",
        promptSelection: { includeObjective: true, externalObjectIds: [] },
      },
    };
    const [first, second] = await Promise.all([
      handlers.start_run({ request }),
      handlers.start_run({ request }),
    ]);
    expect([first.id, second.id]).toEqual([1, 2]);
    expect(new Set([first.session_name, second.session_name]).size).toBe(2);
    expect(access.releases.map((entry) => entry.count)).toEqual([1, 2]);
    expect(runtime.snapshot().runs.map((run) => run.state)).toEqual(["unknown", "unknown"]);

    const directPreview = await handlers.prepare_direct_run({ itemId: 1, workspaceId: 1 });
    const direct = await handlers.start_run({
      request: {
        itemId: 1,
        workspaceId: 1,
        strategy: {
          kind: "direct",
          machineId: null,
          primaryRepositoryId: 1,
          agent: "claude",
          configuration: null,
          executionProfile: "implement",
          workflow: "matt-pocock",
          prompt: "Inspect direct execution.",
          promptSelection: { includeObjective: true, externalObjectIds: [] },
          expectedCheckouts: directPreview.checkouts,
          allowDirty: false,
          allowSharedCheckouts: true,
        },
        queueAttachment: { queueId: 1, position: 1 },
      },
    });
    expect(direct.id).toBe(3);
    expect(direct.implementation_queue_id).toBe(1);
    expect(direct.implementation_queue_position).toBe(1);
    expect(store.loadState().runs.find((run) => run.id === 3)).toMatchObject({
      implementation_queue_id: 1,
      implementation_queue_position: 1,
    });
    expect(store.loadState().implementation_queues[0]?.entries[0]?.runId).toBe(3);
    expect(access.releases.map((entry) => entry.count)).toEqual([1, 2, 3]);

    await expect(
      handlers.start_run({
        request: {
          ...request,
          strategy: {
            kind: "direct",
            machineId: null,
            primaryRepositoryId: 1,
            agent: "claude",
            configuration: undefined,
            implementationQueue: {
              specExternalObjectId: 1,
              specUrl: "https://github.com/acme/app/issues/1",
              entries: [],
            },
            executionProfile: "implement",
            workflow: "matt-pocock",
            prompt: "Start queue",
            promptSelection: { includeObjective: true, externalObjectIds: [] },
            expectedCheckouts: directPreview.checkouts,
            allowDirty: false,
            allowSharedCheckouts: true,
          },
        },
      }),
    ).rejects.toThrow("Implementation Queue configuration is required");
    expect(access.releases.map((entry) => entry.count)).toEqual([1, 2, 3]);

    const originalItemStatus = runtime.snapshot().items.find((item) => item.id === 1)?.status;
    access.mutateMachineOnStop = true;
    await expect(handlers.stop_run({ runId: 1 })).rejects.toThrow(
      "application identity changed before the stop could be recorded",
    );
    expect(runtime.snapshot().runs.find((run) => run.id === 1)).toMatchObject({
      state: "unknown",
      pane_status: "available",
    });
    const stopped = await handlers.stop_run({ runId: 1 });
    expect(stopped.pane_status).toBe("missing");
    const finished = handlers.finish_run({ runId: 1 });
    expect(finished.state).toBe("finished");
    expect(runtime.snapshot().items.find((item) => item.id === 1)?.status).toBe(originalItemStatus);
    expect(handlers.delete_run({ runId: 1, confirmed: true })).toEqual({ deleted: true });

    const staleDeletionPreview = machineDeletion.prepare_machine_deletion({ machineId: 1 });
    access.mutateOnKill = true;
    await expect(
      machineDeletion.delete_machine({
        machineId: 1,
        runIds: staleDeletionPreview.plan.runs.map((run) => run.id),
        worktreeIds: staleDeletionPreview.plan.worktreeIds,
        repositoryLocationRepositoryIds: staleDeletionPreview.plan.repositoryLocationRepositoryIds,
        confirmed: true,
      }),
    ).rejects.toThrow("changed while its Run panes were being stopped");
    expect(runtime.snapshot().machines.some((entry) => entry.id === 1)).toBe(true);

    const deletionPreview = machineDeletion.prepare_machine_deletion({ machineId: 1 });
    const deleted = await machineDeletion.delete_machine({
      machineId: 1,
      runIds: deletionPreview.plan.runs.map((run) => run.id),
      worktreeIds: deletionPreview.plan.worktreeIds,
      repositoryLocationRepositoryIds: deletionPreview.plan.repositoryLocationRepositoryIds,
      confirmed: true,
    });
    expect(deleted.runCount).toBe(2);
    expect(runtime.snapshot().runs).toEqual([]);
    expect(runtime.snapshot().machines.some((entry) => entry.id === 1)).toBe(false);
    expect(runtime.snapshot().contexts[0]?.execution_machine_id).toBeNull();
    expect(runtime.snapshot().workspaces[0]?.preparation_state).toBe("pending");
  });
});
