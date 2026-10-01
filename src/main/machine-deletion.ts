import { runIsActive } from "../domain/deletion";
import type { DomainState } from "../domain/model";
import type { Machine } from "../domain/types";
import type { Runtime } from "./runtime";
import type { TerminalRuntime } from "./terminal";

function machineDeletionPlan(state: DomainState, machineId: number) {
  const machine = state.machines.find((candidate) => candidate.id === machineId);
  if (!machine) throw new Error(`Machine ${machineId} does not exist`);
  const runs = state.runs
    .filter((run) => run.machine_id === machineId)
    .map((run) => {
      const item = state.items.find((candidate) => candidate.id === run.item_id);
      if (!item) throw new Error(`Item ${run.item_id} does not exist`);
      return {
        id: run.id,
        itemId: run.item_id,
        itemIdentifier: item.human_identifier,
        itemTitle: item.title,
        workspaceId: run.workspace_id,
        worktreeId: run.worktree_id,
        state: run.state,
        paneStatus: run.pane_status,
      };
    });
  return {
    plan: {
      machineId,
      name: machine.name,
      runs,
      activeRunIds: state.runs
        .filter((run) => run.machine_id === machineId && runIsActive(run))
        .map((run) => run.id),
      worktreeIds: state.worktrees
        .filter((tree) => tree.machineId === machineId)
        .map((tree) => tree.id),
      repositoryLocationRepositoryIds: state.repository_locations
        .filter((location) => location.machine_id === machineId)
        .map((location) => location.repository_id),
    },
    blockers: [] as string[],
  };
}

export function createMachineDeletionHandlers(runtime: Runtime, terminal: TerminalRuntime) {
  const pendingPreviews = new Map<number, string>();
  return {
    prepare_machine_deletion: (args: Record<string, unknown>) => {
      const machineId = Number(args.machineId);
      const preview = machineDeletionPlan(runtime.snapshot(), machineId);
      pendingPreviews.set(machineId, JSON.stringify({ preview, state: runtime.snapshot() }));
      return preview;
    },
    delete_machine: async (args: Record<string, unknown>) => {
      const machineId = Number(args.machineId);
      if (!args.confirmed)
        throw new Error(
          "Machine deletion requires explicit confirmation after reviewing its deletion preview",
        );
      const expected = pendingPreviews.get(machineId);
      if (!expected) throw new Error("Review the Machine deletion preview before deleting it");
      const current = machineDeletionPlan(runtime.snapshot(), machineId);
      if (expected !== JSON.stringify({ preview: current, state: runtime.snapshot() }))
        throw new Error(
          "The Machine or its associated records changed after the preview; review the updated deletion preview before deleting it",
        );
      const arrays: [string, number[], number[]][] = [
        [
          "Run",
          current.plan.runs.map((run) => run.id),
          Array.isArray(args.runIds) ? args.runIds.map(Number) : [],
        ],
        [
          "Worktree",
          current.plan.worktreeIds,
          Array.isArray(args.worktreeIds) ? args.worktreeIds.map(Number) : [],
        ],
        [
          "Repository location",
          current.plan.repositoryLocationRepositoryIds,
          Array.isArray(args.repositoryLocationRepositoryIds)
            ? args.repositoryLocationRepositoryIds.map(Number)
            : [],
        ],
      ];
      for (const [label, ids, provided] of arrays)
        if (
          [...ids].sort((a, b) => a - b).join(",") !== [...provided].sort((a, b) => a - b).join(",")
        )
          throw new Error(
            `The reviewed Machine deletion contents do not match the confirmation; review the preview again (${label})`,
          );
      const snapshot = runtime.snapshot();
      const machine: Machine = snapshot.machines.find((candidate) => candidate.id === machineId)!;
      const runs = snapshot.runs.filter(
        (run) => run.machine_id === machineId && run.pane_status !== "missing",
      );
      let stopFailureCount = 0;
      for (const run of runs)
        try {
          await terminal.killPane(machine, run.session_name, run.pane_id);
        } catch {
          stopFailureCount++;
        }
      const latestState = runtime.snapshot();
      const latestPlan = machineDeletionPlan(latestState, machineId);
      if (expected !== JSON.stringify({ preview: latestPlan, state: latestState }))
        throw new Error(
          "The Machine or its associated records changed while its Run panes were being stopped; review the updated deletion preview before deleting it",
        );
      runtime.dispatch({
        type: "delete_machine",
        machineId,
        runIds: latestPlan.plan.runs.map((run) => run.id),
        worktreeIds: latestPlan.plan.worktreeIds,
        repositoryLocationRepositoryIds: latestPlan.plan.repositoryLocationRepositoryIds,
      });
      pendingPreviews.delete(machineId);
      return {
        machineId,
        runCount: latestPlan.plan.runs.length,
        worktreeCount: latestPlan.plan.worktreeIds.length,
        repositoryLocationCount: latestPlan.plan.repositoryLocationRepositoryIds.length,
        stopAttemptCount: runs.length,
        stopFailureCount,
      };
    },
  };
}
