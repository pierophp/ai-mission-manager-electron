import { DatabaseSync } from "node:sqlite";
import type {
  Activity,
  Context,
  ContextAttentionDefault,
  ExternalObject,
  ExternalLink,
  ExternalSnapshot,
  ImplementationQueue,
  Item,
  ItemRelation,
  Machine,
  Project,
  Repository,
  RepositoryLocation,
  Workspace,
} from "../../renderer/runtime/types";
import type { Run } from "../../renderer/runtime/execution-types";
import type { DomainState } from "../../domain/model";
import { defaultPstackRoles } from "../../domain/model";
import {
  asBoolean,
  asNumber,
  asString,
  optionalNumber,
  optionalString,
  parseJson,
  rows,
  rustGrillPhase,
  rustPlanPhase,
  rustRelation,
} from "./codecs";

type Row = Record<string, unknown>;

const sequenceKeys = [
  "next_context_id",
  "next_project_id",
  "next_item_id",
  "next_item_number",
  "next_repository_id",
  "next_workspace_id",
  "next_worktree_id",
  "next_machine_id",
  "next_cli_profile_id",
  "next_run_id",
  "next_external_object_id",
  "next_link_id",
  "next_activity_id",
  "next_reminder_id",
] as const;

export function loadDomainState(database: DatabaseSync): DomainState {
  const sequences = Object.fromEntries(
    sequenceKeys.map((key) => {
      const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
      const value = asNumber(row?.value, key);
      if (value < 1) throw new Error(`invalid ${key} value in database: ${value}`);
      return [key, value];
    }),
  ) as Pick<DomainState, (typeof sequenceKeys)[number]>;

  const contexts: Context[] = rows<Row>(database, "SELECT * FROM contexts ORDER BY id").map(
    (row) => ({
      id: asNumber(row.id, "Context id"),
      name: asString(row.name, "Context name"),
      execution_machine_id: optionalNumber(row.execution_machine_id),
      claude_profile_id: optionalNumber(row.claude_profile_id),
      codex_profile_id: optionalNumber(row.codex_profile_id),
      check_dirty_checkouts: asBoolean(row.check_dirty_checkouts),
      grill_defaults: {
        agent: asString(row.grill_agent, "Agent kind") as "claude" | "codex",
        model: asString(row.grill_model, "model"),
        effort: asString(row.grill_effort, "effort"),
      },
      implement_defaults: {
        agent: asString(row.implement_agent, "Agent kind") as "claude" | "codex",
        model: asString(row.implement_model, "model"),
        effort: asString(row.implement_effort, "effort"),
      },
      default_workflow: asString(row.default_workflow, "Workflow") as "matt-pocock" | "pstack",
      pstack_defaults: {
        agent: asString(row.pstack_agent, "Agent kind") as "claude" | "codex",
        model: asString(row.pstack_model, "model"),
        effort: asString(row.pstack_effort, "effort"),
      },
      pstack_roles: parseJson(row.pstack_roles_json, "Pstack role table", defaultPstackRoles),
      gh_executable_path: optionalString(row.gh_executable_path),
      twg_executable_path: optionalString(row.twg_executable_path),
      az_executable_path: optionalString(row.az_executable_path),
      atlassian_site: optionalString(row.atlassian_site),
      azure_devops_organization: optionalString(row.azure_devops_organization),
      bitbucket_workspace: optionalString(row.bitbucket_workspace),
    }),
  );
  const projects: Project[] = rows<Row>(database, "SELECT * FROM projects ORDER BY id").map(
    (row) => ({
      id: asNumber(row.id, "Project id"),
      context_id: asNumber(row.context_id, "Context id"),
      name: asString(row.name, "Project name"),
      defaults: {
        item_status: asString(
          row.default_item_status,
          "Project default status",
        ) as Project["defaults"]["item_status"],
        execution_mode: asString(
          row.default_execution_mode,
          "Execution mode",
        ) as Project["defaults"]["execution_mode"],
      },
    }),
  );
  const repositories: Repository[] = rows<Row>(
    database,
    "SELECT * FROM repositories ORDER BY id",
  ).map((row) => ({
    id: asNumber(row.id, "Repository id"),
    project_id: asNumber(row.project_id, "Project id"),
    name: asString(row.name, "Repository name"),
    remote_url: asString(row.remote_url, "Repository remote"),
    base_branch: asString(row.base_branch, "Repository base branch"),
  }));
  const repository_locations: RepositoryLocation[] = rows<Row>(
    database,
    "SELECT * FROM repository_locations ORDER BY repository_id,machine_id",
  ).map((row) => ({
    repository_id: asNumber(row.repository_id, "Repository id"),
    machine_id: asNumber(row.machine_id, "Machine id"),
    checkout_path: asString(row.checkout_path, "Checkout path"),
    worktree_root: asString(row.worktree_root, "Worktree root"),
  }));
  const machines: Machine[] = rows<Row>(database, "SELECT * FROM machines ORDER BY id").map(
    (row) => ({
      id: asNumber(row.id, "Machine id"),
      context_id: asNumber(row.context_id, "Context id"),
      name: asString(row.name, "Machine name"),
      socket_name: asString(row.socket_name, "Socket name"),
      transport: parseJson(row.transport_json, "Machine transport"),
      last_observed: asString(row.last_observed, "Machine observation") as Machine["last_observed"],
      last_observed_at: optionalNumber(row.last_observed_at),
    }),
  );
  const cli_configuration_profiles = rows<Row>(
    database,
    "SELECT * FROM cli_configuration_profiles ORDER BY id",
  ).map((row) => ({
    id: asNumber(row.id, "Profile id"),
    machineId: asNumber(row.machine_id, "Machine id"),
    provider: asString(row.provider, "Agent kind") as "claude" | "codex",
    name: asString(row.name, "Profile name"),
    directory: asString(row.directory, "Profile directory"),
    appManaged: asBoolean(row.app_managed),
  }));

  const reminders = rows<Row>(database, "SELECT * FROM reminders ORDER BY item_id,id");
  const items: Item[] = rows<Row>(database, "SELECT * FROM items ORDER BY id").map((row) => ({
    id: asNumber(row.id, "Item id"),
    human_identifier: asString(row.human_identifier, "Item identifier"),
    title: asString(row.title, "Item title"),
    project_id: asNumber(row.project_id, "Project id"),
    status: asString(row.status, "Item status") as Item["status"],
    notes: asString(row.notes, "Item notes"),
    reminders: reminders
      .filter((reminder) => reminder.item_id === row.id)
      .map((reminder) => ({
        id: asNumber(reminder.id, "Reminder id"),
        remind_at: asString(reminder.remind_at, "Reminder date"),
      })),
  }));
  const workspaceRepositories = rows<Row>(
    database,
    "SELECT * FROM workspace_repositories ORDER BY workspace_id,repository_id",
  );
  const workspaces: DomainState["workspaces"] = rows<Row>(
    database,
    "SELECT * FROM workspaces ORDER BY id",
  ).map((row) => ({
    id: asNumber(row.id, "Workspace id"),
    item_id: asNumber(row.item_id, "Item id"),
    preparation_state: asString(
      row.preparation_state,
      "Workspace state",
    ) as Workspace["preparation_state"],
    repositories: workspaceRepositories
      .filter((repository) => repository.workspace_id === row.id)
      .map((repository) => ({
        repositoryId: asNumber(repository.repository_id, "Repository id"),
        branch: asString(repository.branch, "branch"),
        baseBranch: asString(repository.base_branch, "base branch"),
      })),
  }));
  const worktrees: DomainState["worktrees"] = rows<Row>(
    database,
    "SELECT * FROM worktrees ORDER BY id",
  ).map((row) => ({
    id: asNumber(row.id, "Worktree id"),
    workspaceId: asNumber(row.workspace_id, "Workspace id"),
    repositoryId: asNumber(row.repository_id, "Repository id"),
    machineId: asNumber(row.machine_id, "Machine id"),
    path: asString(row.path, "Worktree path"),
    branch: asString(row.branch, "branch"),
    baseBranch: asString(row.base_branch, "base branch"),
    isDirty: asBoolean(row.is_dirty),
  }));
  const runs: Run[] = rows<Row>(database, "SELECT * FROM runs ORDER BY id").map((row) => ({
    id: asNumber(row.id, "Run id"),
    item_id: asNumber(row.item_id, "Item id"),
    workspace_id: optionalNumber(row.workspace_id),
    repository_id: optionalNumber(row.repository_id),
    worktree_id: optionalNumber(row.worktree_id),
    machine_id: asNumber(row.machine_id, "Machine id"),
    agent: asString(row.agent, "Agent kind") as Run["agent"],
    cli_configuration_profile: row.cli_configuration_profile_json
      ? parseJson(row.cli_configuration_profile_json, "CLI profile")
      : null,
    execution_profile: asString(
      row.execution_profile,
      "Execution profile",
    ) as Run["execution_profile"],
    workflow: asString(row.workflow, "Workflow") as Run["workflow"],
    model: optionalString(row.model),
    effort: optionalString(row.effort),
    skill_snapshot: optionalString(row.skill_snapshot),
    prompt: asString(row.prompt, "Run prompt"),
    working_directory: asString(row.working_directory, "Run directory"),
    session_name: asString(row.session_name, "Run session"),
    pane_id: asString(row.pane_id, "Pane id"),
    started_at: asNumber(row.started_at, "Run timestamp"),
    state: asString(row.state, "Run state") as Run["state"],
    last_applied_agent_state_sequence: optionalNumber(row.last_applied_agent_state_sequence),
    pane_status: asString(row.pane_status, "Run Pane status") as Run["pane_status"],
    direct_checkouts: parseJson(row.direct_checkouts_json, "Run checkouts", []),
    transcript: asString(row.transcript, "Run transcript"),
    reported_pull_requests: parseJson(
      row.reported_pull_requests_json,
      "reported pull requests",
      [],
    ),
    attention_summary: optionalString(row.attention_summary),
    grill_question_group: row.grill_question_group_json
      ? parseJson(row.grill_question_group_json, "Grill questions")
      : null,
    grill_answers: parseJson(row.grill_answers_json, "Grill answers", []),
    grill_decisions: parseJson(row.grill_decisions_json, "Grill decisions", []),
    grill_response: optionalString(row.grill_response),
    grill_phase: row.grill_phase ? rustGrillPhase(asString(row.grill_phase, "Grill phase")) : null,
    grill_action: optionalString(row.grill_action) as Run["grill_action"],
    grill_action_started_at: optionalNumber(row.grill_action_started_at),
    plan_phase: row.plan_phase ? rustPlanPhase(asString(row.plan_phase, "Plan phase")) : null,
    plan_path: optionalString(row.plan_path),
  }));
  const relationships: ItemRelation[] = rows<Row>(
    database,
    "SELECT * FROM item_relationships ORDER BY from_item_id,to_item_id,kind",
  ).map((row) => ({
    from_item_id: asNumber(row.from_item_id, "Item id"),
    to_item_id: asNumber(row.to_item_id, "Item id"),
    kind: rustRelation(asString(row.kind, "Item relationship")),
  }));
  const external_objects: ExternalObject[] = rows<Row>(
    database,
    "SELECT * FROM external_objects ORDER BY id",
  ).map((row) => ({
    id: asNumber(row.id, "External Object id"),
    provider: asString(row.provider, "External Object provider") as ExternalObject["provider"],
    kind: asString(row.kind, "External Object kind") as ExternalObject["kind"],
    external_key: asString(row.external_key, "External Object key"),
    canonical_url: asString(row.canonical_url, "External Object URL"),
  }));
  const links: DomainState["links"] = rows<Row>(
    database,
    `SELECT l.id,l.item_id,l.external_object_id,COALESCE(a.reviewed_activity_id,0) reviewed_activity_id,a.title_attention,a.state_attention,a.metadata_attention,a.watch_until,a.review_at,a.provenance_json,l.purpose,l.spec_external_object_id FROM external_links l LEFT JOIN link_attention_state a ON a.link_id=l.id ORDER BY l.id`,
  ).map((row) => ({
    id: asNumber(row.id, "Link id"),
    item_id: asNumber(row.item_id, "Item id"),
    external_object_id: asNumber(row.external_object_id, "External Object id"),
    reviewed_activity_id: asNumber(row.reviewed_activity_id, "Activity id"),
    attention_policy:
      row.title_attention === null ||
      row.state_attention === null ||
      row.metadata_attention === null
        ? null
        : {
            title: asBoolean(row.title_attention),
            state: asBoolean(row.state_attention),
            metadata: asBoolean(row.metadata_attention),
          },
    watch_until: optionalString(row.watch_until),
    review_at: optionalString(row.review_at),
    purpose: asString(row.purpose, "Link purpose") as ExternalLink["purpose"],
    spec_external_object_id: optionalNumber(row.spec_external_object_id),
    provenance: row.provenance_json
      ? (parseJson(row.provenance_json, "Link provenance") as ExternalLink["provenance"])
      : null,
  }));
  const snapshots: ExternalSnapshot[] = rows<Row>(
    database,
    "SELECT * FROM external_snapshots ORDER BY external_object_id",
  ).map((row) => ({
    external_object_id: asNumber(row.external_object_id, "External Object id"),
    title: asString(row.title, "External Object title"),
    state: asString(row.state, "External Object state"),
    metadata: parseJson(row.metadata_json, "External Object metadata"),
    fetched_at: asNumber(row.fetched_at, "fetch timestamp"),
  }));
  const activities: Activity[] = rows<Row>(database, "SELECT * FROM activities ORDER BY id").map(
    (row) => ({
      id: asNumber(row.id, "Activity id"),
      external_object_id: asNumber(row.external_object_id, "External Object id"),
      observed_at: asNumber(row.observed_at, "Activity timestamp"),
      changes: parseJson(row.changes_json, "Activity changes"),
    }),
  );
  const attention_defaults: ContextAttentionDefault[] = rows<Row>(
    database,
    "SELECT * FROM context_attention_defaults ORDER BY context_id,object_kind",
  ).map((row) => ({
    context_id: asNumber(row.context_id, "Context id"),
    object_kind: asString(
      row.object_kind,
      "External Object kind",
    ) as ContextAttentionDefault["object_kind"],
    policy: {
      title: asBoolean(row.title_attention),
      state: asBoolean(row.state_attention),
      metadata: asBoolean(row.metadata_attention),
    },
  }));
  const implementation_queues: ImplementationQueue[] = rows<{ queue_json: string }>(
    database,
    "SELECT queue_json FROM implementation_queues ORDER BY id",
  ).map((row) => parseJson(row.queue_json, "Implementation Queue"));
  return {
    ...sequences,
    contexts,
    projects,
    repositories,
    repository_locations,
    items,
    workspaces,
    worktrees,
    machines,
    cli_configuration_profiles,
    runs,
    implementation_queues,
    relationships,
    external_objects,
    links,
    snapshots,
    activities,
    attention_defaults,
  };
}
