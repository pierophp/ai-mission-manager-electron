import { homeView, searchItems } from "../domain/projections";
import type { Event } from "../domain/events";
import type { Item, ItemRelation } from "../domain/types";
import type { Runtime } from "./runtime";
import { LocalSshMachineAccess, type MachineAccess } from "./machine-access";
import { GitCli } from "./git";
import { normalizeMachinePath, resolveMachinePath, worktreePath } from "./machine-path";

export function createWorkCommandHandlers(
  runtime: Runtime,
  machineAccess: MachineAccess = new LocalSshMachineAccess(),
) {
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
}
