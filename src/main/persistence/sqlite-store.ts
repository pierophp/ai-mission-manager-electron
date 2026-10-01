import { DatabaseSync } from "node:sqlite";
import type {
  ActivityTabView,
  AuditEntry,
  CliProfileSettingsView,
  Context,
  ContextAttentionDefault,
  Item,
  Machine,
  MachineReadiness,
  Project,
  Repository,
  RepositoryLocation,
  SetupState,
} from "../../renderer/runtime/types";
import type { DomainState } from "../../domain/model";
import type { Decision, Effect } from "../../domain/events";
import { loadDomainState } from "./load-state";
import {
  getActivityTab,
  listAuditHistory,
  listCliConfigurationProfiles,
  listContextAttentionDefaults,
  listContexts,
  listInboxItems,
  listMachines,
  listProjects,
  listRepositories,
  listRepositoryLocations,
} from "./queries";
import { openSqliteDatabase } from "./schema";
import {
  encodeContextCreatedAudit,
  encodeItemRelationChangedAudit,
  encodeMachineTransport,
  encodeProjectCreatedAudit,
  encodePstackRoleTable,
  encodeRepositoryRegisteredAudit,
  encodeExternalMetadata,
  encodeExternalChanges,
  encodeLinkProvenance,
} from "./write-codecs";
import { getSetupState, newContextConfiguration, readSetting } from "./settings";

export function openSqliteStore(databasePath?: string): SqliteStore {
  const { database, databasePath: path } = openSqliteDatabase(databasePath);
  return new SqliteStore(database, path);
}

/** Persistence facade consumed by the application layer. */
export class SqliteStore {
  private readonly machineReadiness = new Map<number, MachineReadiness>();
  constructor(
    private readonly database: DatabaseSync,
    readonly path: string,
  ) {}

  close(): void {
    this.database.close();
  }
  setContextProviderExecutable(
    contextId: number,
    provider: "github" | "atlassian" | "azure_dev_ops",
    executable: string,
  ): void {
    const column =
      provider === "github"
        ? "gh_executable_path"
        : provider === "atlassian"
          ? "twg_executable_path"
          : "az_executable_path";
    this.database.prepare(`UPDATE contexts SET ${column}=? WHERE id=?`).run(executable, contextId);
  }
  commit(decision: Decision): void {
    const auditEffects = decision.effects.filter(
      (effect) =>
        effect.type === "persist_context" ||
        effect.type === "persist_project" ||
        effect.type === "persist_repository" ||
        effect.type === "persist_item_relation",
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const effect of decision.effects) this.applyEffect(effect);
      let nextAuditId = Number(
        this.database.prepare("SELECT value FROM metadata WHERE key='next_audit_id'").get()?.value,
      );
      for (const effect of auditEffects) {
        let action: string;
        if (effect.type === "persist_context")
          action = encodeContextCreatedAudit(effect.context.id);
        else if (effect.type === "persist_project")
          action = encodeProjectCreatedAudit(effect.project.id);
        else if (effect.type === "persist_repository")
          action = encodeRepositoryRegisteredAudit(effect.repository.id);
        else if (effect.type === "persist_item_relation")
          action = encodeItemRelationChangedAudit(effect.relation);
        else continue;
        this.database
          .prepare(
            "INSERT INTO audit_entries (id, recorded_at, action_json) VALUES (?, CAST(strftime('%s','now') AS INTEGER), ?)",
          )
          .run(nextAuditId++, action);
      }
      if (auditEffects.length)
        this.database
          .prepare("UPDATE metadata SET value=? WHERE key='next_audit_id'")
          .run(nextAuditId);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* preserve failure */
      }
      throw error;
    }
  }
  private applyEffect(effect: Effect): void {
    const db = this.database;
    const persist = (context: import("../../domain/types").Context) => {
      db.prepare(
        `UPDATE contexts SET name=?, execution_machine_id=?, check_dirty_checkouts=?, claude_profile_id=?, codex_profile_id=?, grill_agent=?, grill_model=?, grill_effort=?, implement_agent=?, implement_model=?, implement_effort=?, default_workflow=?, pstack_agent=?, pstack_model=?, pstack_effort=?, gh_executable_path=?, twg_executable_path=?, az_executable_path=?, atlassian_site=?, azure_devops_organization=?, bitbucket_workspace=?, pstack_roles_json=? WHERE id=?`,
      ).run(
        context.name,
        context.execution_machine_id ?? null,
        context.check_dirty_checkouts === false ? 0 : 1,
        context.claude_profile_id ?? null,
        context.codex_profile_id ?? null,
        context.grill_defaults.agent,
        context.grill_defaults.model,
        context.grill_defaults.effort,
        context.implement_defaults?.agent ?? "claude",
        context.implement_defaults?.model ?? "claude-sonnet-5",
        context.implement_defaults?.effort ?? "high",
        context.default_workflow ?? "matt-pocock",
        context.pstack_defaults?.agent ?? "claude",
        context.pstack_defaults?.model ?? "claude-sonnet-5",
        context.pstack_defaults?.effort ?? "high",
        context.gh_executable_path ?? null,
        context.twg_executable_path ?? null,
        context.az_executable_path ?? null,
        context.atlassian_site ?? null,
        context.azure_devops_organization ?? null,
        context.bitbucket_workspace ?? null,
        encodePstackRoleTable(context),
        context.id,
      );
    };
    switch (effect.type) {
      case "persist_setup":
        this.writeSetting("setup_completed", "true");
        this.writeSetting("provider_choice", effect.provider);
        break;
      case "persist_context": {
        const c = effect.context;
        db.prepare(
          "INSERT INTO contexts (id,name,execution_machine_id,check_dirty_checkouts,grill_agent,grill_model,grill_effort,implement_agent,implement_model,implement_effort,default_workflow,pstack_agent,pstack_model,pstack_effort,pstack_roles_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          c.id,
          c.name,
          c.execution_machine_id ?? null,
          c.check_dirty_checkouts === false ? 0 : 1,
          c.grill_defaults.agent,
          c.grill_defaults.model,
          c.grill_defaults.effort,
          c.implement_defaults?.agent ?? "claude",
          c.implement_defaults?.model ?? "claude-sonnet-5",
          c.implement_defaults?.effort ?? "high",
          c.default_workflow ?? "matt-pocock",
          c.pstack_defaults?.agent ?? "claude",
          c.pstack_defaults?.model ?? "claude-sonnet-5",
          c.pstack_defaults?.effort ?? "high",
          encodePstackRoleTable(c),
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_context_id'").run(
          effect.nextContextId,
        );
        break;
      }
      case "persist_project":
        db.prepare(
          "INSERT INTO projects(id,context_id,name,default_item_status,default_execution_mode) VALUES(?,?,?,?,?)",
        ).run(
          effect.project.id,
          effect.project.context_id,
          effect.project.name,
          effect.project.defaults.item_status,
          effect.project.defaults.execution_mode,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_project_id'").run(
          effect.nextProjectId,
        );
        break;
      case "update_project":
        db.prepare(
          "UPDATE projects SET name=?,default_item_status=?,default_execution_mode=? WHERE id=?",
        ).run(
          effect.project.name,
          effect.project.defaults.item_status,
          effect.project.defaults.execution_mode,
          effect.project.id,
        );
        break;
      case "persist_repository":
        db.prepare(
          "INSERT INTO repositories(id,project_id,name,remote_url,base_branch) VALUES(?,?,?,?,?)",
        ).run(
          effect.repository.id,
          effect.repository.project_id,
          effect.repository.name,
          effect.repository.remote_url,
          effect.repository.base_branch,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_repository_id'").run(
          effect.nextRepositoryId,
        );
        break;
      case "update_repository":
        db.prepare("UPDATE repositories SET name=?,remote_url=?,base_branch=? WHERE id=?").run(
          effect.repository.name,
          effect.repository.remote_url,
          effect.repository.base_branch,
          effect.repository.id,
        );
        break;
      case "update_repository_location":
        if (
          effect.previousMachineId !== null &&
          effect.previousMachineId !== effect.location.machine_id
        )
          db.prepare("DELETE FROM repository_locations WHERE repository_id=? AND machine_id=?").run(
            effect.location.repository_id,
            effect.previousMachineId,
          );
        db.prepare(
          `INSERT INTO repository_locations(repository_id,machine_id,checkout_path,worktree_root)
           VALUES(?,?,?,?) ON CONFLICT(repository_id,machine_id) DO UPDATE SET
           checkout_path=excluded.checkout_path,worktree_root=excluded.worktree_root`,
        ).run(
          effect.location.repository_id,
          effect.location.machine_id,
          effect.location.checkout_path,
          effect.location.worktree_root,
        );
        break;
      case "persist_machine":
        db.prepare(
          "INSERT INTO machines(id,context_id,name,socket_name,transport_json,last_observed,last_observed_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          effect.machine.id,
          effect.machine.context_id,
          effect.machine.name,
          effect.machine.socket_name,
          encodeMachineTransport(effect.machine.transport),
          effect.machine.last_observed,
          effect.machine.last_observed_at,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_machine_id'").run(
          effect.nextMachineId,
        );
        break;
      case "update_machine":
        db.prepare(
          "UPDATE machines SET name=?,socket_name=?,transport_json=?,last_observed=?,last_observed_at=? WHERE id=?",
        ).run(
          effect.machine.name,
          effect.machine.socket_name,
          encodeMachineTransport(effect.machine.transport),
          effect.machine.last_observed,
          effect.machine.last_observed_at,
          effect.machine.id,
        );
        break;
      case "persist_machine_observation":
        db.prepare("UPDATE machines SET last_observed=?,last_observed_at=? WHERE id=?").run(
          effect.machine.last_observed,
          effect.machine.last_observed_at,
          effect.machine.id,
        );
        break;
      case "persist_cli_configuration_profile":
        db.prepare(
          "INSERT INTO cli_configuration_profiles(id,machine_id,provider,name,directory,app_managed) VALUES(?,?,?,?,?,?)",
        ).run(
          effect.profile.id,
          effect.profile.machineId,
          effect.profile.provider,
          effect.profile.name,
          effect.profile.directory,
          Number(effect.profile.appManaged),
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_cli_profile_id'").run(
          effect.nextCliProfileId,
        );
        break;
      case "remove_cli_configuration_profile":
        db.prepare("DELETE FROM cli_configuration_profiles WHERE id=?").run(effect.profileId);
        break;
      case "persist_workspace":
        db.prepare("INSERT INTO workspaces(id,item_id,preparation_state) VALUES(?,?,?)").run(
          effect.workspace.id,
          effect.workspace.item_id,
          effect.workspace.preparation_state,
        );
        this.persistWorkspaceRepositories(effect.workspace);
        db.prepare("UPDATE metadata SET value=? WHERE key='next_workspace_id'").run(
          effect.nextWorkspaceId,
        );
        break;
      case "persist_workspace_update":
        db.prepare("UPDATE workspaces SET preparation_state=? WHERE id=?").run(
          effect.workspace.preparation_state,
          effect.workspace.id,
        );
        this.persistWorkspaceRepositories(effect.workspace);
        break;
      case "persist_worktree":
        db.prepare(
          "INSERT INTO worktrees(id,workspace_id,repository_id,machine_id,path,branch,base_branch,is_dirty) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          effect.worktree.id,
          effect.worktree.workspaceId,
          effect.worktree.repositoryId,
          effect.worktree.machineId,
          effect.worktree.path,
          effect.worktree.branch,
          effect.worktree.baseBranch,
          effect.worktree.isDirty ? 1 : 0,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_worktree_id'").run(
          effect.nextWorktreeId,
        );
        break;
      case "persist_item":
        db.prepare(
          "INSERT INTO items(id,human_identifier,title,project_id,status,notes) VALUES(?,?,?,?,?,?)",
        ).run(
          effect.item.id,
          effect.item.human_identifier,
          effect.item.title,
          effect.item.project_id,
          effect.item.status,
          effect.item.notes,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_item_id'").run(effect.nextItemId);
        db.prepare("UPDATE metadata SET value=? WHERE key='next_item_number'").run(
          effect.nextItemNumber,
        );
        break;
      case "persist_item_update":
        db.prepare("UPDATE items SET title=?,status=?,notes=? WHERE id=?").run(
          effect.item.title,
          effect.item.status,
          effect.item.notes,
          effect.item.id,
        );
        break;
      case "persist_item_reminders":
        db.prepare("UPDATE items SET title=?,status=?,notes=? WHERE id=?").run(
          effect.item.title,
          effect.item.status,
          effect.item.notes,
          effect.item.id,
        );
        db.prepare("DELETE FROM reminders WHERE item_id=?").run(effect.item.id);
        for (const reminder of effect.item.reminders)
          db.prepare("INSERT INTO reminders(id,item_id,remind_at) VALUES(?,?,?)").run(
            reminder.id,
            effect.item.id,
            reminder.remind_at,
          );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_reminder_id'").run(
          effect.nextReminderId,
        );
        break;
      case "persist_item_relation": {
        const kind = {
          Blocks: "blocks",
          BlockedBy: "blocked_by",
          RelatedTo: "related_to",
        }[effect.relation.kind];
        db.prepare(
          "INSERT INTO item_relationships(from_item_id,to_item_id,kind) VALUES(?,?,?)",
        ).run(effect.relation.from_item_id, effect.relation.to_item_id, kind);
        break;
      }
      case "persist_external_object":
        db.prepare(
          "INSERT INTO external_objects(id,provider,kind,external_key,canonical_url) VALUES(?,?,?,?,?)",
        ).run(
          effect.object.id,
          effect.object.provider,
          effect.object.kind,
          effect.object.external_key,
          effect.object.canonical_url,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_external_object_id'").run(
          effect.nextExternalObjectId,
        );
        break;
      case "persist_external_link": {
        const link = effect.link;
        db.prepare(
          "INSERT INTO external_links(id,item_id,external_object_id,purpose,spec_external_object_id) VALUES(?,?,?,?,?)",
        ).run(
          link.id,
          link.item_id,
          link.external_object_id,
          link.purpose,
          link.spec_external_object_id,
        );
        this.persistLinkState(link);
        db.prepare("UPDATE metadata SET value=? WHERE key='next_link_id'").run(effect.nextLinkId);
        break;
      }
      case "persist_link_state":
        this.persistLinkState(effect.link);
        break;
      case "persist_external_snapshot":
        db.prepare(
          "INSERT INTO external_snapshots(external_object_id,title,state,metadata_json,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(external_object_id) DO UPDATE SET title=excluded.title,state=excluded.state,metadata_json=excluded.metadata_json,fetched_at=excluded.fetched_at",
        ).run(
          effect.snapshot.external_object_id,
          effect.snapshot.title,
          effect.snapshot.state,
          encodeExternalMetadata(effect.snapshot.metadata),
          effect.snapshot.fetched_at,
        );
        break;
      case "persist_activity":
        db.prepare(
          "INSERT INTO activities(id,external_object_id,observed_at,changes_json) VALUES(?,?,?,?)",
        ).run(
          effect.activity.id,
          effect.activity.external_object_id,
          effect.activity.observed_at,
          encodeExternalChanges(effect.activity),
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_activity_id'").run(
          effect.nextActivityId,
        );
        break;
      case "remove_repository": {
        const id = effect.repositoryId;
        db.prepare("DELETE FROM repository_locations WHERE repository_id=?").run(id);
        db.prepare("DELETE FROM workspace_repositories WHERE repository_id=?").run(id);
        db.prepare("DELETE FROM repositories WHERE id=?").run(id);
        break;
      }
      case "remove_worktree":
        db.prepare("DELETE FROM worktrees WHERE id=?").run(effect.worktreeId);
        break;
      case "remove_link":
        db.prepare("DELETE FROM external_links WHERE id=?").run(effect.linkId);
        break;
      case "remove_external_object":
        db.prepare("DELETE FROM external_objects WHERE id=?").run(effect.externalObjectId);
        break;
      case "remove_item_cascade": {
        const id = effect.itemId;
        db.prepare("DELETE FROM runs WHERE item_id=?").run(id);
        db.prepare(
          "DELETE FROM worktrees WHERE workspace_id IN (SELECT id FROM workspaces WHERE item_id=?)",
        ).run(id);
        db.prepare(
          "DELETE FROM workspace_repositories WHERE workspace_id IN (SELECT id FROM workspaces WHERE item_id=?)",
        ).run(id);
        db.prepare("DELETE FROM workspaces WHERE item_id=?").run(id);
        db.prepare("DELETE FROM reminders WHERE item_id=?").run(id);
        db.prepare("DELETE FROM item_relationships WHERE from_item_id=? OR to_item_id=?").run(
          id,
          id,
        );
        db.prepare("DELETE FROM external_links WHERE item_id=?").run(id);
        for (const objectId of effect.orphanedExternalObjectIds)
          db.prepare(
            "DELETE FROM external_objects WHERE id=? AND NOT EXISTS (SELECT 1 FROM external_links WHERE external_object_id=external_objects.id)",
          ).run(objectId);
        db.prepare("DELETE FROM items WHERE id=?").run(id);
        break;
      }
      case "remove_project_cascade": {
        const id = effect.projectId;
        db.prepare(
          "DELETE FROM runs WHERE item_id IN (SELECT id FROM items WHERE project_id=?)",
        ).run(id);
        db.prepare(
          "DELETE FROM worktrees WHERE workspace_id IN (SELECT workspaces.id FROM workspaces JOIN items ON items.id=workspaces.item_id WHERE items.project_id=?)",
        ).run(id);
        db.prepare(
          "DELETE FROM workspace_repositories WHERE workspace_id IN (SELECT workspaces.id FROM workspaces JOIN items ON items.id=workspaces.item_id WHERE items.project_id=?)",
        ).run(id);
        db.prepare(
          "DELETE FROM workspaces WHERE item_id IN (SELECT id FROM items WHERE project_id=?)",
        ).run(id);
        db.prepare(
          "DELETE FROM reminders WHERE item_id IN (SELECT id FROM items WHERE project_id=?)",
        ).run(id);
        db.prepare(
          "DELETE FROM item_relationships WHERE from_item_id IN (SELECT id FROM items WHERE project_id=?) OR to_item_id IN (SELECT id FROM items WHERE project_id=?)",
        ).run(id, id);
        db.prepare(
          "DELETE FROM external_links WHERE item_id IN (SELECT id FROM items WHERE project_id=?)",
        ).run(id);
        for (const objectId of effect.orphanedExternalObjectIds)
          db.prepare(
            "DELETE FROM external_objects WHERE id=? AND NOT EXISTS (SELECT 1 FROM external_links WHERE external_object_id=external_objects.id)",
          ).run(objectId);
        db.prepare("DELETE FROM items WHERE project_id=?").run(id);
        db.prepare("DELETE FROM repositories WHERE project_id=?").run(id);
        db.prepare("DELETE FROM projects WHERE id=?").run(id);
        break;
      }
      case "remove_context_cascade": {
        const id = effect.contextId;
        const itemQuery =
          "SELECT items.id FROM items JOIN projects ON projects.id=items.project_id WHERE projects.context_id=?";
        db.prepare(
          `DELETE FROM runs WHERE machine_id IN (SELECT id FROM machines WHERE context_id=?) OR item_id IN (${itemQuery})`,
        ).run(id, id);
        db.prepare(
          `DELETE FROM worktrees WHERE workspace_id IN (SELECT workspaces.id FROM workspaces JOIN items ON items.id=workspaces.item_id JOIN projects ON projects.id=items.project_id WHERE projects.context_id=?)`,
        ).run(id);
        db.prepare(
          `DELETE FROM workspace_repositories WHERE workspace_id IN (SELECT workspaces.id FROM workspaces JOIN items ON items.id=workspaces.item_id JOIN projects ON projects.id=items.project_id WHERE projects.context_id=?)`,
        ).run(id);
        db.prepare(`DELETE FROM workspaces WHERE item_id IN (${itemQuery})`).run(id);
        db.prepare(`DELETE FROM reminders WHERE item_id IN (${itemQuery})`).run(id);
        db.prepare(
          `DELETE FROM item_relationships WHERE from_item_id IN (${itemQuery}) OR to_item_id IN (${itemQuery})`,
        ).run(id, id);
        db.prepare(`DELETE FROM external_links WHERE item_id IN (${itemQuery})`).run(id);
        for (const objectId of effect.orphanedExternalObjectIds)
          db.prepare(
            "DELETE FROM external_objects WHERE id=? AND NOT EXISTS (SELECT 1 FROM external_links WHERE external_object_id=external_objects.id)",
          ).run(objectId);
        db.prepare(
          `DELETE FROM items WHERE project_id IN (SELECT id FROM projects WHERE context_id=?)`,
        ).run(id);
        db.prepare(
          `DELETE FROM repositories WHERE project_id IN (SELECT id FROM projects WHERE context_id=?)`,
        ).run(id);
        db.prepare("DELETE FROM machines WHERE context_id=?").run(id);
        db.prepare("DELETE FROM context_attention_defaults WHERE context_id=?").run(id);
        db.prepare("DELETE FROM projects WHERE context_id=?").run(id);
        db.prepare("DELETE FROM contexts WHERE id=?").run(id);
        break;
      }
      case "reset_local_data": {
        db.exec(
          "DELETE FROM audit_entries; DELETE FROM link_attention_state; DELETE FROM activities; DELETE FROM external_snapshots; DELETE FROM external_links; DELETE FROM external_objects; DELETE FROM context_attention_defaults; DELETE FROM item_relationships; DELETE FROM reminders; DELETE FROM runs; DELETE FROM worktrees; DELETE FROM workspace_repositories; DELETE FROM workspaces; DELETE FROM repository_locations; DELETE FROM items; DELETE FROM repositories; DELETE FROM machines; DELETE FROM cli_configuration_profiles; DELETE FROM projects; DELETE FROM contexts;",
        );
        const c = effect.context;
        db.prepare(
          "INSERT INTO contexts (id,name,execution_machine_id,check_dirty_checkouts,grill_agent,grill_model,grill_effort,implement_agent,implement_model,implement_effort,default_workflow,pstack_agent,pstack_model,pstack_effort,pstack_roles_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          c.id,
          c.name,
          null,
          1,
          c.grill_defaults.agent,
          c.grill_defaults.model,
          c.grill_defaults.effort,
          c.implement_defaults?.agent ?? "claude",
          c.implement_defaults?.model ?? "claude-sonnet-5",
          c.implement_defaults?.effort ?? "high",
          c.default_workflow ?? "matt-pocock",
          c.pstack_defaults?.agent ?? "claude",
          c.pstack_defaults?.model ?? "claude-sonnet-5",
          c.pstack_defaults?.effort ?? "high",
          encodePstackRoleTable(c),
        );
        db.prepare(
          "INSERT INTO projects(id,context_id,name,default_item_status,default_execution_mode) VALUES(?,?,?,?,?)",
        ).run(
          effect.project.id,
          effect.project.context_id,
          effect.project.name,
          effect.project.defaults.item_status,
          effect.project.defaults.execution_mode,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_context_id'").run(
          effect.nextContextId,
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='next_project_id'").run(
          effect.nextProjectId,
        );
        break;
      }
      case "update_context":
        persist(effect.context);
        break;
      case "persist_context_grill_defaults":
        db.prepare("UPDATE contexts SET grill_agent=?,grill_model=?,grill_effort=? WHERE id=?").run(
          effect.defaults.agent,
          effect.defaults.model,
          effect.defaults.effort,
          effect.contextId,
        );
        break;
      case "persist_context_implement_defaults":
        db.prepare(
          "UPDATE contexts SET implement_agent=?,implement_model=?,implement_effort=? WHERE id=?",
        ).run(
          effect.defaults.agent,
          effect.defaults.model,
          effect.defaults.effort,
          effect.contextId,
        );
        break;
      case "persist_context_configuration":
        persist(effect.context);
        for (const row of effect.attentionDefaults)
          db.prepare(
            "INSERT INTO context_attention_defaults(context_id,object_kind,title_attention,state_attention,metadata_attention) VALUES(?,?,?,?,?) ON CONFLICT(context_id,object_kind) DO UPDATE SET title_attention=excluded.title_attention,state_attention=excluded.state_attention,metadata_attention=excluded.metadata_attention",
          ).run(
            row.context_id,
            row.object_kind,
            Number(row.policy.title),
            Number(row.policy.state),
            Number(row.policy.metadata),
          );
        break;
      case "persist_context_attention_default": {
        const row = effect.attentionDefault;
        db.prepare(
          "INSERT INTO context_attention_defaults(context_id,object_kind,title_attention,state_attention,metadata_attention) VALUES(?,?,?,?,?) ON CONFLICT(context_id,object_kind) DO UPDATE SET title_attention=excluded.title_attention,state_attention=excluded.state_attention,metadata_attention=excluded.metadata_attention",
        ).run(
          row.context_id,
          row.object_kind,
          Number(row.policy.title),
          Number(row.policy.state),
          Number(row.policy.metadata),
        );
        break;
      }
    }
  }
  private persistLinkState(link: DomainState["links"][number]): void {
    this.database
      .prepare(
        "INSERT INTO link_attention_state(link_id,reviewed_activity_id,title_attention,state_attention,metadata_attention,watch_until,review_at,provenance_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(link_id) DO UPDATE SET reviewed_activity_id=excluded.reviewed_activity_id,title_attention=excluded.title_attention,state_attention=excluded.state_attention,metadata_attention=excluded.metadata_attention,watch_until=excluded.watch_until,review_at=excluded.review_at,provenance_json=excluded.provenance_json",
      )
      .run(
        link.id,
        link.reviewed_activity_id,
        link.attention_policy === null ? null : Number(link.attention_policy.title),
        link.attention_policy === null ? null : Number(link.attention_policy.state),
        link.attention_policy === null ? null : Number(link.attention_policy.metadata),
        link.watch_until,
        link.review_at,
        encodeLinkProvenance(link),
      );
    this.database
      .prepare("UPDATE external_links SET purpose=?,spec_external_object_id=? WHERE id=?")
      .run(link.purpose, link.spec_external_object_id, link.id);
  }
  private persistWorkspaceRepositories(workspace: DomainState["workspaces"][number]): void {
    this.database
      .prepare("DELETE FROM workspace_repositories WHERE workspace_id=?")
      .run(workspace.id);
    const insert = this.database.prepare(
      "INSERT INTO workspace_repositories(workspace_id,repository_id,branch,base_branch) VALUES(?,?,?,?)",
    );
    for (const repository of workspace.repositories)
      insert.run(workspace.id, repository.repositoryId, repository.branch, repository.baseBranch);
  }
  setting(key: string): string | null {
    return readSetting(this.database, key);
  }
  setSetting(key: string, value: string): void {
    this.writeSetting(key, value);
  }
  private writeSetting(key: string, value: string): void {
    this.database
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  getSetupState(): SetupState {
    return getSetupState(this.database);
  }
  loadState(): DomainState {
    return loadDomainState(this.database);
  }
  listContexts(): Context[] {
    return listContexts(this.database);
  }
  listProjects(): Project[] {
    return listProjects(this.database);
  }
  listRepositories(): Repository[] {
    return listRepositories(this.database);
  }
  listRepositoryLocations(): RepositoryLocation[] {
    return listRepositoryLocations(this.database);
  }
  listMachines(): Machine[] {
    return listMachines(this.database).map((machine) => ({
      ...machine,
      readiness: this.machineReadiness.get(machine.id) ?? null,
    }));
  }
  setMachineReadiness(machineId: number, readiness: MachineReadiness | null): void {
    if (readiness) this.machineReadiness.set(machineId, readiness);
    else this.machineReadiness.delete(machineId);
  }
  listCliConfigurationProfiles(): CliProfileSettingsView[] {
    return listCliConfigurationProfiles(this.database);
  }
  listContextAttentionDefaults(): ContextAttentionDefault[] {
    return listContextAttentionDefaults(this.database);
  }
  listInboxItems(): Item[] {
    return listInboxItems(this.database);
  }
  listAuditHistory(): AuditEntry[] {
    return listAuditHistory(this.database);
  }
  auditEntryCount(): number {
    return Number(
      this.database.prepare("SELECT COUNT(*) AS count FROM audit_entries").get()?.count ?? 0,
    );
  }
  getActivityTab(): ActivityTabView {
    return getActivityTab(this.database);
  }
}

export { newContextConfiguration };
