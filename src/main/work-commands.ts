import { homeView, searchItems } from "../domain/projections";
import type { Event } from "../domain/events";
import type { Item, ItemRelation } from "../domain/types";
import type { Runtime } from "./runtime";
import { LocalSshMachineAccess, type MachineAccess } from "./machine-access";
import { GitCli } from "./git";
import { normalizeMachinePath, resolveMachinePath, worktreePath } from "./machine-path";
import { suggestUntrackedRuns } from "../domain/run-suggestions";
import type { RunSuggestion } from "../domain/execution-types";
import { TmuxTerminalRuntime, type AgentStateRecord, type TerminalRuntime } from "./terminal";
import type { RunReconciliationResult, MachineObservationFailure } from "../domain/types";

function sameSuggestion(left: RunSuggestion, right: RunSuggestion): boolean {
  return (
    left.machineId === right.machineId &&
    left.agent === right.agent &&
    left.sessionName === right.sessionName &&
    left.paneId === right.paneId &&
    left.currentPath === right.currentPath &&
    left.itemId === right.itemId &&
    left.contextId === right.contextId &&
    left.workspaceId === right.workspaceId &&
    left.repositoryId === right.repositoryId &&
    left.worktreeId === right.worktreeId &&
    left.locationPath === right.locationPath
  );
}

export function createWorkCommandHandlers(
  runtime: Runtime,
  machineAccess: MachineAccess = new LocalSshMachineAccess(),
  terminalRuntime: TerminalRuntime = new TmuxTerminalRuntime(machineAccess),
  onRunStateChanged: (event: { runId: number; state: string }) => void = () => undefined,
) {
  const reconcileRuns = async (): Promise<RunReconciliationResult> => {
    if (!runtime.beginReconciliation()) return { failures: [], changed: false };
    try {
      const snapshot = runtime.snapshot();
      const machines = new Map<number, (typeof snapshot.machines)[number]>();
      for (const run of snapshot.runs) {
        const machine = snapshot.machines.find((candidate) => candidate.id === run.machine_id);
        if (machine) machines.set(machine.id, machine);
      }
      const observations = new Map<
        number,
        Awaited<ReturnType<TerminalRuntime["observeMachine"]>>
      >();
      const failures: MachineObservationFailure[] = [];
      for (const machine of machines.values()) {
        const ids = snapshot.runs
          .filter((run) => run.machine_id === machine.id)
          .map((run) => run.id);
        const observation = await terminalRuntime.observeMachine(machine, ids);
        observations.set(machine.id, observation);
        if (!(observation.panes instanceof Array))
          failures.push({
            machineId: machine.id,
            machineName: machine.name,
            kind: observation.panes.kind,
            message: observation.panes.error,
          });
      }
      let changed = false;
      for (const run of snapshot.runs) {
        const machine = machines.get(run.machine_id);
        const observation = observations.get(run.machine_id);
        if (!machine || !observation) continue;
        const current = runtime.snapshot();
        const liveRun = current.runs.find((candidate) => candidate.id === run.id);
        const liveMachine = current.machines.find((candidate) => candidate.id === machine.id);
        if (
          !liveRun ||
          JSON.stringify(liveMachine) !== JSON.stringify(machine) ||
          liveRun.machine_id !== run.machine_id ||
          liveRun.session_name !== run.session_name ||
          liveRun.pane_id !== run.pane_id ||
          liveRun.agent !== run.agent
        )
          continue;
        const panes = observation.panes;
        const isUnreachable = !(panes instanceof Array) && panes.kind === "unreachable";
        let paneStatus = run.pane_status;
        if (panes instanceof Array) {
          const exact = panes.some(
            (pane) => pane.sessionName === run.session_name && pane.paneId === run.pane_id,
          );
          const samePane = panes.some((pane) => pane.paneId === run.pane_id);
          if (exact) paneStatus = "available";
          else if (!samePane) paneStatus = "missing";
        } else paneStatus = "unknown";
        const paneRecords =
          panes instanceof Array
            ? panes
                .filter(
                  (pane) => pane.sessionName === run.session_name && pane.paneId === run.pane_id,
                )
                .map((pane) => pane.agentState)
                .filter(
                  (record): record is AgentStateRecord =>
                    record !== null &&
                    Number(record.runId) === run.id &&
                    record.agent === run.agent &&
                    (record.sequence === undefined || record.sequence >= 0),
                )
            : [];
        const paneRecord = paneRecords.sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1))[0];
        const fileRecord = observation.stateRecords
          .filter(
            (record) =>
              Number(record.runId) === run.id &&
              record.agent === run.agent &&
              (record.sequence === undefined || record.sequence >= 0),
          )
          .sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1))[0];
        const record =
          fileRecord && (!paneRecord || (fileRecord.sequence ?? -1) > (paneRecord.sequence ?? -1))
            ? fileRecord
            : paneRecord;
        const stateAccepted =
          !isUnreachable &&
          record !== undefined &&
          (record.sequence === undefined
            ? liveRun.last_applied_agent_state_sequence == null
            : record.sequence >= 0 &&
              (liveRun.last_applied_agent_state_sequence == null ||
                record.sequence > liveRun.last_applied_agent_state_sequence));
        const targetState = stateAccepted ? record!.state : liveRun.state;
        const sequence = stateAccepted
          ? (record!.sequence ?? null)
          : (liveRun.last_applied_agent_state_sequence ?? null);
        if (
          liveRun.pane_status !== paneStatus ||
          liveRun.state !== targetState ||
          (sequence !== null && sequence > (liveRun.last_applied_agent_state_sequence ?? -1))
        ) {
          runtime.dispatch({
            type: "observe_run",
            runId: run.id,
            state: targetState,
            sequence,
            paneStatus,
          });
          changed = true;
          if (liveRun.state !== targetState)
            onRunStateChanged({ runId: run.id, state: targetState });
        }
      }
      return { failures, changed };
    } finally {
      runtime.endReconciliation();
    }
  };
  const updateItem = (event: Event, itemId: number): Item => {
    const state = runtime.dispatch(event);
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    return item;
  };
  const worktreeSetup = (workspaceId: number, repositoryId: number, machineId: number) => {
    const state = runtime.snapshot();
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace)
      throw new Error(`Project Repository execution setup ${workspaceId} does not exist`);
    if (
      state.worktrees.some(
        (entry) => entry.workspaceId === workspaceId && entry.repositoryId === repositoryId,
      )
    )
      throw new Error(`This Item already has a registered Worktree for Repository ${repositoryId}`);
    const selected = workspace.repositories.find((entry) => entry.repositoryId === repositoryId);
    if (!selected)
      throw new Error(
        `Repository ${repositoryId} is not selected for Project Repository execution setup ${workspaceId}`,
      );
    const repository = state.repositories.find((entry) => entry.id === repositoryId);
    if (!repository) throw new Error(`Repository ${repositoryId} does not exist`);
    const item = state.items.find((entry) => entry.id === workspace.item_id);
    if (!item) throw new Error(`Item ${workspace.item_id} does not exist`);
    const machine = state.machines.find((entry) => entry.id === machineId);
    if (!machine) throw new Error(`Machine ${machineId} does not exist`);
    const project = state.projects.find((entry) => entry.id === item.project_id);
    if (!project) throw new Error(`Project ${item.project_id} does not exist`);
    const context = state.contexts.find((entry) => entry.id === project.context_id);
    if (!context) throw new Error(`Context ${project.context_id} does not exist`);
    if (context.execution_machine_id == null)
      throw new Error(`Context ${context.id} has no execution Machine configured`);
    if (context.execution_machine_id !== machineId)
      throw new Error(
        `Machine ${machineId} is not the execution Machine configured for Context ${context.id}`,
      );
    const location = state.repository_locations.find(
      (entry) => entry.repository_id === repositoryId && entry.machine_id === machineId,
    );
    if (!location)
      throw new Error(`Repository ${repositoryId} has no location on Machine ${machineId}`);
    const isCurrent = () => {
      const latest = runtime.snapshot();
      return (
        JSON.stringify(latest.workspaces.find((entry) => entry.id === workspaceId)) ===
          JSON.stringify(workspace) &&
        JSON.stringify(latest.items.find((entry) => entry.id === item.id)) ===
          JSON.stringify(item) &&
        JSON.stringify(latest.projects.find((entry) => entry.id === project.id)) ===
          JSON.stringify(project) &&
        JSON.stringify(latest.contexts.find((entry) => entry.id === context.id)) ===
          JSON.stringify(context) &&
        JSON.stringify(latest.repositories.find((entry) => entry.id === repositoryId)) ===
          JSON.stringify(repository) &&
        JSON.stringify(latest.machines.find((entry) => entry.id === machineId)) ===
          JSON.stringify(machine) &&
        JSON.stringify(
          latest.repository_locations.find(
            (entry) => entry.repository_id === repositoryId && entry.machine_id === machineId,
          ),
        ) === JSON.stringify(location) &&
        !latest.worktrees.some(
          (entry) => entry.workspaceId === workspaceId && entry.repositoryId === repositoryId,
        )
      );
    };
    return {
      workspace,
      selected,
      repository,
      item,
      project,
      context,
      machine,
      location,
      isCurrent,
    };
  };
  const worktreeValue = (
    state: ReturnType<Runtime["snapshot"]>,
    workspaceId: number,
    repositoryId: number,
  ) => {
    const value = state.worktrees.find(
      (entry) => entry.workspaceId === workspaceId && entry.repositoryId === repositoryId,
    );
    if (!value) throw new Error("Worktree creation produced no Worktree");
    return {
      id: value.id,
      workspace_id: value.workspaceId,
      repository_id: value.repositoryId,
      machine_id: value.machineId,
      path: value.path,
      branch: value.branch,
      base_branch: value.baseBranch,
      is_dirty: value.isDirty,
    };
  };
  const prepareWorktree = async (args: Record<string, unknown>) => {
    const workspaceId = Number(args.workspaceId);
    const repositoryId = Number(args.repositoryId);
    const machineId = Number(args.machineId);
    const setup = worktreeSetup(workspaceId, repositoryId, machineId);
    const home = await machineAccess.machineHome(setup.machine);
    const checkout = resolveMachinePath(setup.location.checkout_path, home);
    const destination = worktreePath(
      resolveMachinePath(setup.location.worktree_root, home),
      workspaceId,
      setup.selected.branch,
      setup.repository.name,
    );
    const normalizedDestination = normalizeMachinePath(destination, home);
    let inspection: Awaited<ReturnType<GitCli["prepareWorktree"]>>;
    try {
      inspection = await new GitCli(machineAccess).prepareWorktree(
        setup.machine,
        setup.repository,
        checkout,
        destination,
        setup.selected.branch,
        setup.selected.baseBranch,
        Boolean(args.reuseExistingBranch),
        Boolean(args.confirmDirtyAttachment),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let markError: string | undefined;
      if (setup.isCurrent()) {
        try {
          runtime.dispatch({ type: "mark_workspace_resumable", workspaceId });
        } catch (markFailure) {
          markError = markFailure instanceof Error ? markFailure.message : String(markFailure);
        }
      }
      const recoveryHint = `if Git created the Worktree before failing, it may remain at ${normalizedDestination}`;
      throw new Error(`${detail}; ${recoveryHint}${markError ? `; ${markError}` : ""}`);
    }
    try {
      if (!setup.isCurrent())
        throw new Error(
          "The Workspace or Repository changed while the Worktree was prepared; review it again",
        );
      const next = runtime.dispatch({
        type: "create_worktree",
        workspaceId,
        repositoryId,
        machineId,
        path: normalizedDestination,
        branch: setup.selected.branch,
        baseBranch: setup.selected.baseBranch,
        isDirty: inspection.isDirty,
      });
      return worktreeValue(next, workspaceId, repositoryId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await new GitCli(machineAccess).removeWorktree(setup.machine, checkout, destination);
      } catch (cleanupError) {
        throw new Error(
          `${detail}; the newly prepared Worktree could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw new Error(`${detail}; the newly prepared Worktree was removed`);
    }
  };
  const attachWorktree = async (args: Record<string, unknown>) => {
    const workspaceId = Number(args.workspaceId);
    const repositoryId = Number(args.repositoryId);
    const machineId = Number(args.machineId);
    const setup = worktreeSetup(workspaceId, repositoryId, machineId);
    const home = await machineAccess.machineHome(setup.machine);
    const checkout = resolveMachinePath(setup.location.checkout_path, home);
    const normalizedPath = normalizeMachinePath(String(args.path ?? ""), home);
    const path = resolveMachinePath(normalizedPath, home);
    const inspection = await new GitCli(machineAccess).validateAttachment(
      setup.machine,
      setup.repository,
      checkout,
      path,
      setup.selected.branch,
      Boolean(args.confirmDirtyAttachment),
    );
    if (!setup.isCurrent())
      throw new Error(
        "The Workspace or Repository changed while the Worktree was inspected; review it again",
      );
    const next = runtime.dispatch({
      type: "create_worktree",
      workspaceId,
      repositoryId,
      machineId,
      path: normalizedPath,
      branch: setup.selected.branch,
      baseBranch: setup.selected.baseBranch,
      isDirty: inspection.isDirty,
    });
    return worktreeValue(next, workspaceId, repositoryId);
  };
  return {
    reconcile_runs: reconcileRuns,
    list_run_suggestions: async (): Promise<RunSuggestion[]> => {
      const snapshot = runtime.snapshot();
      const machines = snapshot.machines.filter((machine) =>
        snapshot.contexts.some((context) => context.execution_machine_id === machine.id),
      );
      const observations = [];
      for (const machine of machines) {
        try {
          const [panes, machineHome] = await Promise.all([
            terminalRuntime.listAgentPanes(machine),
            machineAccess.machineHome(machine),
          ]);
          observations.push(
            ...panes.map((pane) => ({
              machineId: machine.id,
              agent: pane.agent,
              sessionName: pane.sessionName,
              paneId: pane.paneId,
              currentPath: pane.currentPath,
              machineHome,
            })),
          );
        } catch (error) {
          console.error(
            `Could not inspect Machine ${machine.name} for agent Panes: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (JSON.stringify(runtime.snapshot()) !== JSON.stringify(snapshot))
        throw new Error(
          "Run or Machine state changed while agent Panes were inspected; refresh suggestions again",
        );
      return suggestUntrackedRuns(snapshot, observations);
    },
    attach_run: async (args: Record<string, unknown>) => {
      const suggestion = args.suggestion as RunSuggestion;
      const candidates = await (async () => {
        const state = runtime.snapshot();
        const machine = state.machines.find((entry) => entry.id === suggestion.machineId);
        if (!machine) throw new Error(`Machine ${suggestion.machineId} does not exist`);
        const [panes, machineHome] = await Promise.all([
          terminalRuntime.listAgentPanes(machine),
          machineAccess.machineHome(machine),
        ]);
        return suggestUntrackedRuns(
          state,
          panes
            .filter(
              (pane) =>
                pane.agent === suggestion.agent &&
                pane.sessionName === suggestion.sessionName &&
                pane.paneId === suggestion.paneId,
            )
            .map((pane) => ({ machineId: machine.id, ...pane, machineHome })),
        );
      })();
      const canonical = candidates.find((candidate) => sameSuggestion(candidate, suggestion));
      if (!canonical)
        throw new Error(
          "The suggested agent or its registered working location changed while it was inspected; refresh suggestions",
        );
      const attachMachine = runtime
        .snapshot()
        .machines.find((machine) => machine.id === canonical.machineId);
      if (!attachMachine) throw new Error(`Machine ${canonical.machineId} does not exist`);
      const machineHome = await machineAccess.machineHome(attachMachine);
      const latest = runtime.snapshot();
      const refreshed = suggestUntrackedRuns(latest, [
        {
          machineId: attachMachine.id,
          agent: canonical.agent,
          sessionName: canonical.sessionName,
          paneId: canonical.paneId,
          currentPath: canonical.currentPath,
          machineHome,
        },
      ]).find((candidate) => sameSuggestion(candidate, canonical));
      if (
        !refreshed ||
        JSON.stringify(latest.machines.find((machine) => machine.id === attachMachine.id)) !==
          JSON.stringify(attachMachine)
      )
        throw new Error(
          "The suggested agent or its registered working location changed while it was inspected; refresh suggestions",
        );
      const state = runtime.dispatch({
        type: "attach_untracked_run",
        itemId: canonical.itemId,
        workspaceId: canonical.workspaceId!,
        repositoryId: canonical.repositoryId!,
        worktreeId: canonical.worktreeId ?? null,
        machineId: canonical.machineId,
        agent: canonical.agent,
        workingDirectory: canonical.locationPath ?? canonical.currentPath,
        machineHome,
        sessionName: canonical.sessionName,
        paneId: canonical.paneId,
        startedAt: Math.floor(Date.now() / 1000),
      });
      const run = state.runs.at(-1);
      if (!run) throw new Error("Run attachment produced no Run");
      return run;
    },
    stop_untracked_agent: async (args: Record<string, unknown>) =>
      controlUntrackedAgent(args.suggestion as RunSuggestion, false),
    delete_untracked_agent: async (args: Record<string, unknown>) =>
      controlUntrackedAgent(args.suggestion as RunSuggestion, true),
    get_home: (args: Record<string, unknown>) =>
      homeView(
        runtime.snapshot(),
        args.contextId == null ? null : Number(args.contextId),
        String(args.now ?? ""),
      ),
    search_items_command: (args: Record<string, unknown>) =>
      searchItems(
        runtime.snapshot(),
        String(args.query ?? ""),
        args.contextId == null ? null : Number(args.contextId),
      ),
    create_item: (args: Record<string, unknown>) => {
      const id = runtime.snapshot().next_item_id;
      const state = runtime.dispatch({
        type: "create_item",
        title: String(args.title ?? ""),
        contextId: Number(args.contextId),
        projectId: Number(args.projectId),
        notes: String(args.notes ?? ""),
      });
      return state.items.find((item) => item.id === id)!;
    },
    set_item_status: (args: Record<string, unknown>) =>
      updateItem(
        {
          type: "set_item_status",
          itemId: Number(args.itemId),
          status: String(args.status) as Item["status"],
        },
        Number(args.itemId),
      ),
    set_item_title: (args: Record<string, unknown>) =>
      updateItem(
        { type: "set_item_title", itemId: Number(args.itemId), title: String(args.title ?? "") },
        Number(args.itemId),
      ),
    set_item_notes: (args: Record<string, unknown>) =>
      updateItem(
        { type: "set_item_notes", itemId: Number(args.itemId), notes: String(args.notes ?? "") },
        Number(args.itemId),
      ),
    add_item_reminder: (args: Record<string, unknown>) =>
      updateItem(
        {
          type: "add_item_reminder",
          itemId: Number(args.itemId),
          remindAt: String(args.remindAt ?? ""),
        },
        Number(args.itemId),
      ),
    remove_item_reminder: (args: Record<string, unknown>) =>
      updateItem(
        {
          type: "remove_item_reminder",
          itemId: Number(args.itemId),
          reminderId: Number(args.reminderId),
        },
        Number(args.itemId),
      ),
    set_item_relation: (args: Record<string, unknown>): ItemRelation => {
      const event: Event = {
        type: "set_item_relation",
        fromItemId: Number(args.fromItemId),
        toItemId: Number(args.toItemId),
        kind: String(args.kind) as ItemRelation["kind"],
      };
      const state = runtime.dispatch(event);
      const relation = state.relationships.at(-1);
      if (!relation) throw new Error("Item relationship produced no relationship");
      return relation;
    },
    create_worktree: (args: Record<string, unknown>) => {
      const state = runtime.dispatch({
        type: "create_worktree",
        workspaceId: Number(args.workspaceId),
        repositoryId: Number(args.repositoryId),
        machineId: Number(args.machineId),
        path: String(args.path ?? ""),
        branch: String(args.branch ?? ""),
        baseBranch: String(args.baseBranch ?? ""),
        isDirty: false,
      });
      return worktreeValue(state, Number(args.workspaceId), Number(args.repositoryId));
    },
    prepare_worktree: prepareWorktree,
    attach_worktree: attachWorktree,
  };

  async function controlUntrackedAgent(suggestion: RunSuggestion, remove: boolean): Promise<null> {
    const state = runtime.snapshot();
    const machine = state.machines.find((entry) => entry.id === suggestion.machineId);
    if (!machine) throw new Error(`Machine ${suggestion.machineId} does not exist`);
    const [panes, machineHome] = await Promise.all([
      terminalRuntime.listAgentPanes(machine),
      machineAccess.machineHome(machine),
    ]);
    const canonical = suggestUntrackedRuns(
      state,
      panes
        .filter(
          (pane) =>
            pane.agent === suggestion.agent &&
            pane.sessionName === suggestion.sessionName &&
            pane.paneId === suggestion.paneId,
        )
        .map((pane) => ({ machineId: machine.id, ...pane, machineHome })),
    ).find((candidate) => sameSuggestion(candidate, suggestion));
    if (!canonical)
      throw new Error(
        "The suggested agent or its registered working location changed while it was inspected; refresh suggestions",
      );
    if (remove) await terminalRuntime.killPane(machine, canonical.sessionName, canonical.paneId);
    else await terminalRuntime.interruptPane(machine, canonical.sessionName, canonical.paneId);
    const latest = runtime.snapshot();
    const stillCurrent = suggestUntrackedRuns(latest, [
      {
        machineId: machine.id,
        agent: canonical.agent,
        sessionName: canonical.sessionName,
        paneId: canonical.paneId,
        currentPath: canonical.currentPath,
        machineHome,
      },
    ]).some((candidate) => sameSuggestion(candidate, canonical));
    if (
      !stillCurrent ||
      JSON.stringify(latest.machines.find((entry) => entry.id === machine.id)) !==
        JSON.stringify(machine)
    )
      throw new Error(
        "The agent Pane was controlled, but its registered working location changed before the operation completed",
      );
    return null;
  }
}
