import { DatabaseSync } from "node:sqlite";
import type {
  ActivityTabView,
  AuditEntry,
  CliProfileSettingsView,
  Context,
  ContextAttentionDefault,
  Item,
  Machine,
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
  encodeProjectCreatedAudit,
  encodePstackRoleTable,
  encodeRepositoryRegisteredAudit,
} from "./write-codecs";
import { getSetupState, newContextConfiguration, readSetting } from "./settings";

export function openSqliteStore(databasePath?: string): SqliteStore {
  const { database, databasePath: path } = openSqliteDatabase(databasePath);
  return new SqliteStore(database, path);
}

/** Persistence facade consumed by the application layer. */
export class SqliteStore {
  constructor(
    private readonly database: DatabaseSync,
    readonly path: string,
  ) {}

  close(): void {
    this.database.close();
  }
  commit(decision: Decision): void {
    const auditEffects = decision.effects.filter(
      (effect) =>
        effect.type === "persist_context" ||
        effect.type === "persist_project" ||
        effect.type === "persist_repository",
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
    return listMachines(this.database);
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
  getActivityTab(): ActivityTabView {
    return getActivityTab(this.database);
  }
}

export { newContextConfiguration };
