import type { DomainState } from "./model";
import type { AgentPaneObservation, RunSuggestion } from "./execution-types";
import { pathIsWithin } from "./paths";

export function suggestUntrackedRuns(
  state: DomainState,
  panes: AgentPaneObservation[],
): RunSuggestion[] {
  const suggestions: RunSuggestion[] = [];
  for (const pane of panes) {
    const machine = state.machines.find((entry) => entry.id === pane.machineId);
    if (
      !machine ||
      !state.contexts.some(
        (context) =>
          context.id === machine.context_id && context.execution_machine_id === machine.id,
      )
    )
      continue;
    if (
      state.runs.some(
        (run) =>
          run.machine_id === pane.machineId &&
          run.session_name === pane.sessionName &&
          run.pane_id === pane.paneId,
      )
    )
      continue;
    const locations: {
      length: number;
      workspaceId: number;
      repositoryId: number;
      worktreeId: number | null;
      path: string;
    }[] = [];
    for (const workspace of state.workspaces) {
      const worktree = state.worktrees
        .filter(
          (entry) =>
            entry.workspaceId === workspace.id &&
            entry.machineId === pane.machineId &&
            pathIsWithin(entry.path, pane.currentPath, pane.machineHome),
        )
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (worktree) {
        locations.push({
          length: worktree.path.length,
          workspaceId: workspace.id,
          repositoryId: worktree.repositoryId,
          worktreeId: worktree.id,
          path: worktree.path,
        });
        continue;
      }
      const item = state.items.find((entry) => entry.id === workspace.item_id);
      if (!item) continue;
      const projectItemCount = state.items.filter(
        (entry) => entry.project_id === item.project_id,
      ).length;
      if (projectItemCount !== 1) continue;
      for (const repository of state.repositories.filter(
        (entry) => entry.project_id === item.project_id,
      )) {
        for (const location of state.repository_locations.filter(
          (entry) =>
            entry.repository_id === repository.id &&
            entry.machine_id === pane.machineId &&
            pathIsWithin(entry.checkout_path, pane.currentPath, pane.machineHome),
        ))
          locations.push({
            length: location.checkout_path.length,
            workspaceId: workspace.id,
            repositoryId: repository.id,
            worktreeId: null,
            path: location.checkout_path,
          });
      }
    }
    locations.sort((a, b) => b.length - a.length);
    const location = locations[0];
    if (!location) continue;
    const workspace = state.workspaces.find((entry) => entry.id === location.workspaceId);
    const item = workspace && state.items.find((entry) => entry.id === workspace.item_id);
    const project = item && state.projects.find((entry) => entry.id === item.project_id);
    const context = project && state.contexts.find((entry) => entry.id === project.context_id);
    if (!item || !context) continue;
    suggestions.push({
      machineId: machine.id,
      machineName: machine.name,
      agent: pane.agent,
      sessionName: pane.sessionName,
      paneId: pane.paneId,
      currentPath: pane.currentPath,
      itemId: item.id,
      itemIdentifier: item.human_identifier,
      itemTitle: item.title,
      contextId: context.id,
      contextName: context.name,
      workspaceId: workspace?.id ?? null,
      repositoryId: location.repositoryId,
      worktreeId: location.worktreeId,
      locationPath: location.path,
    });
  }
  return suggestions.sort(
    (a, b) =>
      a.machineId - b.machineId ||
      a.sessionName.localeCompare(b.sessionName) ||
      a.paneId.localeCompare(b.paneId),
  );
}
