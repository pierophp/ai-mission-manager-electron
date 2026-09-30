import { decide } from "../domain/state-transition";
import type { Event } from "../domain/events";
import type { DomainState } from "../domain/model";
import type { SqliteStore } from "./persistence/sqlite-store";

export class Runtime {
  private state: DomainState;
  constructor(
    private readonly store: SqliteStore,
    initialState = store.loadState(),
  ) {
    this.state = initialState;
  }
  snapshot(): DomainState {
    return structuredClone(this.state);
  }
  dispatch(event: Event): DomainState {
    return this.dispatchMany([event]);
  }
  dispatchMany(events: Event[]): DomainState {
    let nextState = this.state;
    const effects = [] as import("../domain/events").Effect[];
    for (const event of events) {
      const decision = decide(nextState, event);
      nextState = decision.state;
      effects.push(...decision.effects);
    }
    this.store.commit({ state: nextState, effects });
    this.state = nextState;
    this.ensureProjectWorkspaces();
    return this.snapshot();
  }

  ensureProjectWorkspaces(): void {
    for (const item of this.state.items) {
      const workspaces = this.state.workspaces.filter((workspace) => workspace.item_id === item.id);
      const repositories = this.state.repositories
        .filter((repository) => repository.project_id === item.project_id)
        .map((repository) => ({
          repositoryId: repository.id,
          branch: `mission-${item.human_identifier}`,
          baseBranch: repository.base_branch,
        }));
      if (!workspaces.length) {
        if (repositories.length)
          this.dispatch({ type: "create_workspace", itemId: item.id, repositories });
        continue;
      }
      for (const workspace of workspaces) {
        const reconciled = repositories.map((repository) => {
          const existing = workspace.repositories.find(
            (selected) => selected.repositoryId === repository.repositoryId,
          );
          return existing
            ? {
                repositoryId: existing.repositoryId,
                branch: existing.branch,
                baseBranch: existing.baseBranch,
              }
            : repository;
        });
        if (JSON.stringify(workspace.repositories) !== JSON.stringify(reconciled))
          this.dispatch({
            type: "set_workspace_repositories",
            workspaceId: workspace.id,
            repositories: reconciled,
          });
      }
    }
  }
}
