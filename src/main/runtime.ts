import { decide } from "../domain/state-transition";
import type { Event } from "../domain/events";
import type { DomainState } from "../domain/model";
import type { ExternalObject } from "../domain/types";
import type { SqliteStore } from "./persistence/sqlite-store";
import type { TerminalConnection } from "./terminal";

export class Runtime {
  private state: DomainState;
  private reconciliationInProgress = false;
  private readonly externalSnapshotRequestGenerations = new Map<number, number>();
  private readonly externalSnapshotAppliedGenerations = new Map<number, number>();
  private readonly terminalOpenGenerations = new Map<string, number>();
  private readonly terminalConnections = new Map<
    string,
    { generation: number; connection: TerminalConnection }
  >();
  constructor(
    private readonly store: SqliteStore,
    initialState = store.loadState(),
  ) {
    this.state = initialState;
  }
  snapshot(): DomainState {
    return structuredClone(this.state);
  }
  beginReconciliation(): boolean {
    if (this.reconciliationInProgress) return false;
    this.reconciliationInProgress = true;
    return true;
  }
  endReconciliation(): void {
    this.reconciliationInProgress = false;
  }
  beginTerminalOpen(terminalId: string): number {
    const generation = (this.terminalOpenGenerations.get(terminalId) ?? 0) + 1;
    this.terminalOpenGenerations.set(terminalId, generation);
    return generation;
  }
  terminalOpenIsCurrent(terminalId: string, generation: number): boolean {
    return this.terminalOpenGenerations.get(terminalId) === generation;
  }
  terminalConnection(terminalId: string) {
    return this.terminalConnections.get(terminalId);
  }
  setTerminalConnection(
    terminalId: string,
    generation: number,
    connection: TerminalConnection,
  ): TerminalConnection | undefined {
    if (!this.terminalOpenIsCurrent(terminalId, generation)) return undefined;
    const previous = this.terminalConnections.get(terminalId)?.connection;
    this.terminalConnections.set(terminalId, { generation, connection });
    return previous;
  }
  removeTerminalConnection(
    terminalId: string,
    generation?: number,
  ): TerminalConnection | undefined {
    const current = this.terminalConnections.get(terminalId);
    if (!current || (generation !== undefined && current.generation !== generation))
      return undefined;
    this.terminalConnections.delete(terminalId);
    return current.connection;
  }
  auditEntryCount(): number {
    return this.store.auditEntryCount();
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

  beginExternalSnapshotRequest(externalObjectId: number): number {
    const generation = (this.externalSnapshotRequestGenerations.get(externalObjectId) ?? 0) + 1;
    this.externalSnapshotRequestGenerations.set(externalObjectId, generation);
    return generation;
  }

  applyExternalSnapshot(
    object: DomainState["external_objects"][number],
    generation: number,
    snapshot: import("../domain/types").ExternalSnapshotData,
    operation: "poll" | "refresh",
  ): DomainState {
    const externalObjectId = object.id;
    if (
      !this.state.external_objects.some(
        (current) => JSON.stringify(current) === JSON.stringify(object),
      ) ||
      !this.state.links.some((link) => link.external_object_id === externalObjectId)
    )
      throw new Error(
        operation === "poll"
          ? "The External Object changed while it was being polled; poll it again"
          : `External Object ${externalObjectId} changed while it was being refreshed; refresh it again`,
      );
    const currentSnapshot = this.state.snapshots.find(
      (entry) => entry.external_object_id === externalObjectId,
    );
    if (
      (currentSnapshot !== undefined && snapshot.fetched_at < currentSnapshot.fetched_at) ||
      (this.externalSnapshotAppliedGenerations.get(externalObjectId) ?? 0) >= generation
    )
      throw new Error(
        operation === "poll"
          ? `A newer snapshot for External Object ${externalObjectId} was already applied; poll it again`
          : `A newer snapshot for External Object ${externalObjectId} was already applied; refresh it again`,
      );
    const state = this.dispatch({ type: "refresh_external_object", externalObjectId, snapshot });
    this.externalSnapshotAppliedGenerations.set(externalObjectId, generation);
    return state;
  }

  rememberProviderExecutable(
    contextId: number,
    provider: Exclude<ExternalObject["provider"], "generic">,
    executable: string,
  ): void {
    const context = this.state.contexts.find((candidate) => candidate.id === contextId);
    if (!context) throw new Error(`Context ${contextId} does not exist`);
    const key =
      provider === "github"
        ? "gh_executable_path"
        : provider === "atlassian"
          ? "twg_executable_path"
          : "az_executable_path";
    if (context[key] === executable) return;
    this.store.setContextProviderExecutable(contextId, provider, executable);
    context[key] = executable;
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
