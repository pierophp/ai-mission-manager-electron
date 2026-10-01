import type { DomainState } from "./model";
import type {
  ExternalObjectDeletionPlan,
  ItemDeletionPlan,
  ParentDeletionPlan,
  RepositoryDeletionPlan,
  ResetLocalDataSummary,
} from "./types";
import { DomainError } from "./error";
import type { Run } from "./execution-types";

export function runIsActive(run: Run): boolean {
  return (
    run.state !== "finished" ||
    (run.execution_profile === "grill" && run.grill_phase !== "finished") ||
    (run.execution_profile === "plan" && run.plan_phase === "awaitingGo")
  );
}

const idSetsMatch = (a: number[], b: number[]) =>
  [...a].sort((x, y) => x - y).join(",") === [...b].sort((x, y) => x - y).join(",");

export function planItemDeletion(state: DomainState, itemId: number): ItemDeletionPlan {
  const item = state.items.find((value) => value.id === itemId);
  if (!item) throw new DomainError(`Item ${itemId} does not exist`);
  const workspaces = state.workspaces
    .filter((value) => value.item_id === itemId)
    .map(({ id, item_id }) => ({ id, itemId: item_id }));
  const runIds = state.runs.filter((value) => value.item_id === itemId).map(({ id }) => id);
  const activeRunIds = state.runs
    .filter((value) => value.item_id === itemId && runIsActive(value))
    .map(({ id }) => id);
  const linkIds = state.links.filter((value) => value.item_id === itemId).map(({ id }) => id);
  const linkedIds = state.links
    .filter((value) => value.item_id === itemId)
    .map(({ external_object_id }) => external_object_id);
  const orphanedExternalObjectIds = [
    ...new Set(
      linkedIds.filter(
        (externalObjectId) =>
          !state.links.some(
            (link) => link.external_object_id === externalObjectId && link.item_id !== itemId,
          ),
      ),
    ),
  ];
  return {
    itemId,
    humanIdentifier: item.human_identifier,
    title: item.title,
    reminderCount: item.reminders.length,
    relationshipCount: state.relationships.filter(
      (entry) => entry.from_item_id === itemId || entry.to_item_id === itemId,
    ).length,
    workspaces,
    runIds,
    activeRunIds,
    linkIds,
    orphanedExternalObjectIds,
    orphanedSnapshotCount: state.snapshots.filter((entry) =>
      orphanedExternalObjectIds.includes(entry.external_object_id),
    ).length,
    orphanedActivityCount: state.activities.filter((entry) =>
      orphanedExternalObjectIds.includes(entry.external_object_id),
    ).length,
  };
}

export function planExternalObjectDeletion(
  state: DomainState,
  externalObjectId: number,
): ExternalObjectDeletionPlan {
  const object = state.external_objects.find((value) => value.id === externalObjectId);
  if (!object) throw new DomainError(`External Object ${externalObjectId} does not exist`);
  const linkIds = state.links
    .filter((link) => link.external_object_id === externalObjectId)
    .map(({ id }) => id);
  return {
    externalObjectId,
    provider: object.provider,
    kind: object.kind,
    externalKey: object.external_key,
    canonicalUrl: object.canonical_url,
    linkIds,
    snapshotCount: state.snapshots.filter((value) => value.external_object_id === externalObjectId)
      .length,
    activityCount: state.activities.filter((value) => value.external_object_id === externalObjectId)
      .length,
  };
}

export function planRepositoryDeletion(
  state: DomainState,
  repositoryId: number,
): RepositoryDeletionPlan {
  const repository = state.repositories.find((value) => value.id === repositoryId);
  if (!repository) throw new DomainError(`Repository ${repositoryId} does not exist`);
  return {
    repositoryId,
    name: repository.name,
    remoteUrl: repository.remote_url,
    workspaces: state.workspaces
      .filter((workspace) =>
        workspace.repositories.some((entry) => entry.repositoryId === repositoryId),
      )
      .map(({ id, item_id }) => ({ id, itemId: item_id })),
  };
}

export function planParentDeletion(
  state: DomainState,
  contextId: number | null,
  projectId: number | null,
): ParentDeletionPlan {
  const project =
    projectId === null ? undefined : state.projects.find((value) => value.id === projectId);
  const context =
    contextId === null ? undefined : state.contexts.find((value) => value.id === contextId);
  if (projectId !== null && !project) throw new DomainError(`Project ${projectId} does not exist`);
  if (contextId !== null && !context) throw new DomainError(`Context ${contextId} does not exist`);
  const projectIds =
    contextId === null
      ? [projectId!]
      : state.projects.filter((value) => value.context_id === contextId).map(({ id }) => id);
  const projects = state.projects
    .filter((value) => projectIds.includes(value.id))
    .map(({ id, name }) => ({ id, name }));
  const items = state.items
    .filter((value) => projectIds.includes(value.project_id))
    .map(({ id, human_identifier, title, project_id }) => ({
      id,
      humanIdentifier: human_identifier,
      title,
      projectId: project_id,
    }));
  const itemIds = items.map(({ id }) => id);
  const repositories = state.repositories
    .filter((value) => projectIds.includes(value.project_id))
    .map(({ id, name, remote_url, project_id }) => ({
      id,
      name,
      remoteUrl: remote_url,
      projectId: project_id,
    }));
  const workspaces = state.workspaces
    .filter((value) => itemIds.includes(value.item_id))
    .map(({ id, item_id }) => ({ id, itemId: item_id }));
  const machines =
    contextId === null
      ? []
      : state.machines
          .filter((value) => value.context_id === contextId)
          .map(({ id, name }) => ({ id, name }));
  const machineIds = machines.map(({ id }) => id);
  const runs = state.runs
    .filter((run) => itemIds.includes(run.item_id) || machineIds.includes(run.machine_id))
    .map((run) => {
      const item = state.items.find(({ id }) => id === run.item_id);
      if (!item) throw new DomainError(`Item ${run.item_id} does not exist`);
      return {
        id: run.id,
        itemId: run.item_id,
        itemIdentifier: item.human_identifier,
        itemTitle: item.title,
        workspaceId: run.workspace_id,
        worktreeId: run.worktree_id,
        machineId: run.machine_id,
        state: run.state,
        paneStatus: run.pane_status,
      };
    });
  const activeRunIds = state.runs
    .filter(
      (run) =>
        (itemIds.includes(run.item_id) || machineIds.includes(run.machine_id)) && runIsActive(run),
    )
    .map(({ id }) => id);
  const linkIds = state.links.filter((link) => itemIds.includes(link.item_id)).map(({ id }) => id);
  const linkedIds = state.links
    .filter((link) => itemIds.includes(link.item_id))
    .map(({ external_object_id }) => external_object_id);
  const orphanedExternalObjectIds = [
    ...new Set(
      linkedIds.filter(
        (objectId) =>
          !state.links.some(
            (link) => link.external_object_id === objectId && !itemIds.includes(link.item_id),
          ),
      ),
    ),
  ];
  const attentionDefaults =
    contextId === null
      ? []
      : state.attention_defaults.filter((value) => value.context_id === contextId);
  return {
    contextId,
    projectId,
    name: context?.name ?? project!.name,
    projects,
    items,
    repositories,
    machines,
    workspaces,
    runs,
    activeRunIds,
    reminderCount: state.items
      .filter((value) => itemIds.includes(value.id))
      .reduce((n, value) => n + value.reminders.length, 0),
    relationshipCount: state.relationships.filter(
      (value) => itemIds.includes(value.from_item_id) || itemIds.includes(value.to_item_id),
    ).length,
    linkIds,
    attentionDefaults,
    orphanedExternalObjectIds,
    orphanedSnapshotCount: state.snapshots.filter((value) =>
      orphanedExternalObjectIds.includes(value.external_object_id),
    ).length,
    orphanedActivityCount: state.activities.filter((value) =>
      orphanedExternalObjectIds.includes(value.external_object_id),
    ).length,
  };
}

export function planResetLocalData(state: DomainState) {
  const affectedRecords = [
    ...state.contexts.map((value) => ({ kind: "Context", id: value.id, label: value.name })),
    ...state.projects.map((value) => ({ kind: "Project", id: value.id, label: value.name })),
    ...state.repositories.map((value) => ({ kind: "Repository", id: value.id, label: value.name })),
    ...state.items.map((value) => ({
      kind: "Item",
      id: value.id,
      label: `${value.human_identifier} · ${value.title}`,
    })),
    ...state.workspaces.map((value) => ({
      kind: "Workspace",
      id: value.id,
      label: `Item ${value.item_id}`,
    })),
    ...state.machines.map((value) => ({ kind: "Machine", id: value.id, label: value.name })),
    ...state.runs.map((value) => ({
      kind: "Run",
      id: value.id,
      label: `${value.state[0].toUpperCase()}${value.state.slice(1)} · Item ${state.items.find((entry) => entry.id === value.item_id)?.human_identifier ?? "unknown"} · Machine ${state.machines.find((entry) => entry.id === value.machine_id)?.name ?? "unknown"}`,
    })),
    ...state.links.map((value) => ({
      kind: "Link",
      id: value.id,
      label: `Item ${state.items.find((entry) => entry.id === value.item_id)?.human_identifier ?? "unknown"} → ${state.external_objects.find((entry) => entry.id === value.external_object_id)?.external_key ?? "unknown"}`,
    })),
    ...state.external_objects.map((value) => ({
      kind: "External Object",
      id: value.id,
      label: value.external_key,
    })),
  ];
  const summary: ResetLocalDataSummary = {
    contextCount: state.contexts.length,
    projectCount: state.projects.length,
    repositoryCount: state.repositories.length,
    itemCount: state.items.length,
    workspaceCount: state.workspaces.length,
    machineCount: state.machines.length,
    runCount: state.runs.length,
    reminderCount: state.items.reduce((n, value) => n + value.reminders.length, 0),
    relationshipCount: state.relationships.length,
    linkCount: state.links.length,
    externalObjectCount: state.external_objects.length,
    snapshotCount: state.snapshots.length,
    activityCount: state.activities.length,
    attentionDefaultCount: state.attention_defaults.length,
  };
  return {
    summary,
    affectedRecords,
    workspaces: state.workspaces.map(({ id, item_id }) => ({ id, itemId: item_id })),
  };
}

export function parentSelectionMatches(expected: number[], provided: number[]): boolean {
  return idSetsMatch(expected, provided);
}
