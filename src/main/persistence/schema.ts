import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableColumns, rows } from "./codecs";

const INCOMPATIBLE_SCHEMA = "database schema is incompatible; remove the database and start again";

export const schemaPrelude =
  "CREATE TABLE IF NOT EXISTS metadata (\n             key TEXT PRIMARY KEY NOT NULL,\n             value INTEGER NOT NULL\n         );\n         CREATE TABLE IF NOT EXISTS settings (\n             key TEXT PRIMARY KEY NOT NULL,\n             value TEXT NOT NULL\n         );\n         CREATE TABLE IF NOT EXISTS contexts (\n             id INTEGER PRIMARY KEY NOT NULL,\n             name TEXT NOT NULL UNIQUE,\n             execution_machine_id INTEGER,\n             check_dirty_checkouts INTEGER NOT NULL DEFAULT 1,\n             grill_agent TEXT NOT NULL DEFAULT 'claude',\n             grill_model TEXT NOT NULL DEFAULT 'claude-sonnet-5',\n             grill_effort TEXT NOT NULL DEFAULT 'high',\n             implement_agent TEXT NOT NULL DEFAULT 'claude',\n             implement_model TEXT NOT NULL DEFAULT 'claude-sonnet-5',\n             implement_effort TEXT NOT NULL DEFAULT 'high',\n             default_workflow TEXT NOT NULL DEFAULT 'matt-pocock',\n             pstack_agent TEXT NOT NULL DEFAULT 'claude',\n             pstack_model TEXT NOT NULL DEFAULT 'claude-sonnet-5',\n             pstack_effort TEXT NOT NULL DEFAULT 'high',\n             pstack_roles_json TEXT NOT NULL DEFAULT '',\n             claude_profile_id INTEGER,\n             codex_profile_id INTEGER,\n             gh_executable_path TEXT,\n             twg_executable_path TEXT,\n             az_executable_path TEXT,\n             atlassian_site TEXT,\n             azure_devops_organization TEXT,\n             bitbucket_workspace TEXT\n         );\n         CREATE TABLE IF NOT EXISTS projects (\n             id INTEGER PRIMARY KEY NOT NULL,\n             context_id INTEGER NOT NULL REFERENCES contexts(id),\n             name TEXT NOT NULL,\n             default_item_status TEXT NOT NULL\n                 CHECK (default_item_status IN ('Inbox', 'Active', 'Waiting', 'Done')),\n             default_execution_mode TEXT NOT NULL DEFAULT 'worktree'\n                 CHECK (default_execution_mode IN ('direct', 'worktree')),\n             UNIQUE (context_id, name)\n         );\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_context_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_project_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_item_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_item_number', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_repository_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_workspace_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_worktree_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_machine_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_cli_profile_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_run_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_external_object_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_link_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_activity_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_reminder_id', 1);\n         INSERT OR IGNORE INTO metadata (key, value) VALUES ('next_audit_id', 1);";
export const schemaRemainder =
  "CREATE INDEX IF NOT EXISTS projects_by_context\n             ON projects (context_id);\n         CREATE INDEX IF NOT EXISTS items_by_project_and_status\n             ON items (project_id, status);\n         CREATE TABLE IF NOT EXISTS repositories (\n             id INTEGER PRIMARY KEY NOT NULL,\n             project_id INTEGER NOT NULL REFERENCES projects(id),\n             name TEXT NOT NULL,\n             remote_url TEXT NOT NULL,\n             base_branch TEXT NOT NULL DEFAULT 'main',\n             UNIQUE (project_id, name)\n         );\n         CREATE INDEX IF NOT EXISTS repositories_by_project\n             ON repositories (project_id, id);\n         CREATE TABLE IF NOT EXISTS machines (\n             id INTEGER PRIMARY KEY NOT NULL,\n             context_id INTEGER NOT NULL REFERENCES contexts(id),\n             name TEXT NOT NULL,\n             socket_name TEXT NOT NULL,\n             transport_json TEXT NOT NULL DEFAULT '{\"kind\":\"local\"}',\n             last_observed TEXT NOT NULL DEFAULT 'unknown',\n             last_observed_at INTEGER,\n             UNIQUE (context_id, name)\n         );\n         CREATE INDEX IF NOT EXISTS machines_by_context\n             ON machines (context_id, id);\n         CREATE TABLE IF NOT EXISTS cli_configuration_profiles (\n             id INTEGER PRIMARY KEY NOT NULL,\n             machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,\n             provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),\n             name TEXT NOT NULL,\n             directory TEXT NOT NULL,\n             app_managed INTEGER NOT NULL,\n             UNIQUE (machine_id, provider, name)\n         );\n         CREATE TABLE IF NOT EXISTS repository_locations (\n             repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,\n             machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,\n             checkout_path TEXT NOT NULL,\n             worktree_root TEXT NOT NULL,\n             PRIMARY KEY (repository_id, machine_id)\n         );\n         CREATE INDEX IF NOT EXISTS repository_locations_by_machine\n             ON repository_locations (machine_id, repository_id);\n         CREATE TABLE IF NOT EXISTS workspaces (\n             id INTEGER PRIMARY KEY NOT NULL,\n             item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,\n             preparation_state TEXT NOT NULL DEFAULT 'pending'\n         );\n         CREATE INDEX IF NOT EXISTS workspaces_by_item\n             ON workspaces (item_id, id);\n         CREATE TABLE IF NOT EXISTS workspace_repositories (\n             workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\n             repository_id INTEGER NOT NULL REFERENCES repositories(id),\n             branch TEXT NOT NULL,\n             base_branch TEXT NOT NULL,\n             PRIMARY KEY (workspace_id, repository_id)\n         );\n         CREATE INDEX IF NOT EXISTS workspace_repositories_by_repository\n             ON workspace_repositories (repository_id);\n         CREATE TABLE IF NOT EXISTS worktrees (\n             id INTEGER PRIMARY KEY NOT NULL,\n             workspace_id INTEGER NOT NULL REFERENCES workspaces(id),\n             repository_id INTEGER NOT NULL REFERENCES repositories(id),\n             machine_id INTEGER NOT NULL REFERENCES machines(id),\n             path TEXT NOT NULL,\n             branch TEXT NOT NULL,\n             base_branch TEXT NOT NULL,\n             is_dirty INTEGER NOT NULL DEFAULT 0\n         );\n         CREATE INDEX IF NOT EXISTS worktrees_by_workspace\n             ON worktrees (workspace_id, id);\n         CREATE INDEX IF NOT EXISTS worktrees_by_repository\n             ON worktrees (repository_id, id);\n         CREATE TABLE IF NOT EXISTS runs (\n             id INTEGER PRIMARY KEY NOT NULL,\n             item_id INTEGER NOT NULL REFERENCES items(id),\n             workspace_id INTEGER REFERENCES workspaces(id),\n             repository_id INTEGER REFERENCES repositories(id),\n             worktree_id INTEGER REFERENCES worktrees(id),\n             machine_id INTEGER NOT NULL REFERENCES machines(id),\n             agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),\n             cli_configuration_profile_json TEXT,\n             execution_profile TEXT NOT NULL\n                 CHECK (execution_profile IN ('investigate', 'implement', 'review', 'custom', 'grill', 'autonomous', 'plan', 'pstack-review')),\n             workflow TEXT NOT NULL DEFAULT 'matt-pocock',\n             model TEXT,\n             effort TEXT,\n             skill_snapshot TEXT,\n             prompt TEXT NOT NULL,\n             working_directory TEXT NOT NULL,\n             session_name TEXT NOT NULL,\n             pane_id TEXT NOT NULL,\n             started_at INTEGER NOT NULL,\n             state TEXT NOT NULL DEFAULT 'unknown',\n             last_applied_agent_state_sequence INTEGER,\n             pane_status TEXT NOT NULL DEFAULT 'unknown',\n             direct_checkouts_json TEXT NOT NULL DEFAULT '[]',\n             transcript TEXT NOT NULL DEFAULT '',\n             reported_pull_requests_json TEXT NOT NULL DEFAULT '[]',\n             attention_summary TEXT,\n             grill_question_group_json TEXT,\n             grill_answers_json TEXT NOT NULL DEFAULT '[]',\n             grill_decisions_json TEXT NOT NULL DEFAULT '[]',\n             grill_response TEXT,\n             grill_phase TEXT,\n             grill_action TEXT,\n             grill_action_started_at INTEGER\n             ,implementation_queue_id INTEGER\n             ,implementation_queue_position INTEGER\n             ,plan_phase TEXT\n             ,plan_path TEXT\n         );\n         CREATE TABLE IF NOT EXISTS implementation_queues (\n             id INTEGER PRIMARY KEY NOT NULL,\n             item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,\n             queue_json TEXT NOT NULL\n         );\n         CREATE INDEX IF NOT EXISTS runs_by_item\n             ON runs (item_id, id);\n         CREATE INDEX IF NOT EXISTS runs_by_workspace\n             ON runs (workspace_id, id);\n         CREATE TABLE IF NOT EXISTS reminders (\n             id INTEGER PRIMARY KEY NOT NULL,\n             item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,\n             remind_at TEXT NOT NULL\n         );\n         CREATE INDEX IF NOT EXISTS reminders_by_item\n             ON reminders (item_id, id);\n         CREATE TABLE IF NOT EXISTS item_relationships (\n             from_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,\n             to_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,\n             kind TEXT NOT NULL CHECK (kind IN ('blocks', 'blocked_by', 'related_to')),\n             PRIMARY KEY (from_item_id, to_item_id, kind)\n         );\n         CREATE INDEX IF NOT EXISTS relationships_by_target\n             ON item_relationships (to_item_id);\n         CREATE TABLE IF NOT EXISTS external_objects (\n             id INTEGER PRIMARY KEY NOT NULL,\n             provider TEXT NOT NULL CHECK (provider IN ('github', 'atlassian', 'azure_dev_ops', 'generic')),\n             kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request', 'document', 'generic')),\n             external_key TEXT NOT NULL,\n             canonical_url TEXT NOT NULL,\n             UNIQUE (provider, external_key)\n         );\n         CREATE TABLE IF NOT EXISTS external_links (\n             id INTEGER PRIMARY KEY NOT NULL,\n             item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,\n             external_object_id INTEGER NOT NULL REFERENCES external_objects(id) ON DELETE CASCADE,\n             purpose TEXT NOT NULL DEFAULT 'others',\n             spec_external_object_id INTEGER REFERENCES external_objects(id) ON DELETE SET NULL,\n             UNIQUE (item_id, external_object_id)\n         );\n         CREATE TABLE IF NOT EXISTS external_snapshots (\n             external_object_id INTEGER PRIMARY KEY NOT NULL REFERENCES external_objects(id) ON DELETE CASCADE,\n             title TEXT NOT NULL,\n             state TEXT NOT NULL,\n             metadata_json TEXT NOT NULL,\n             fetched_at INTEGER NOT NULL\n         );\n         CREATE TABLE IF NOT EXISTS link_attention_state (\n             link_id INTEGER PRIMARY KEY NOT NULL REFERENCES external_links(id) ON DELETE CASCADE,\n             reviewed_activity_id INTEGER NOT NULL DEFAULT 0,\n             title_attention INTEGER,\n             state_attention INTEGER,\n             metadata_attention INTEGER,\n             watch_until TEXT,\n             review_at TEXT,\n             provenance_json TEXT\n         );\n         CREATE TABLE IF NOT EXISTS activities (\n             id INTEGER PRIMARY KEY NOT NULL,\n             external_object_id INTEGER NOT NULL REFERENCES external_objects(id) ON DELETE CASCADE,\n             observed_at INTEGER NOT NULL,\n             changes_json TEXT NOT NULL\n         );\n         CREATE TABLE IF NOT EXISTS context_attention_defaults (\n             context_id INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,\n             object_kind TEXT NOT NULL CHECK (object_kind IN ('issue', 'pull_request', 'document', 'generic')),\n             title_attention INTEGER NOT NULL,\n             state_attention INTEGER NOT NULL,\n             metadata_attention INTEGER NOT NULL,\n             PRIMARY KEY (context_id, object_kind)\n         );\n         CREATE INDEX IF NOT EXISTS external_links_by_item\n             ON external_links (item_id);\n         CREATE INDEX IF NOT EXISTS external_links_by_object\n             ON external_links (external_object_id);\n         CREATE INDEX IF NOT EXISTS activities_by_object\n             ON activities (external_object_id, id);\n         CREATE TABLE IF NOT EXISTS audit_entries (\n             id INTEGER PRIMARY KEY NOT NULL,\n             recorded_at INTEGER NOT NULL,\n             action_json TEXT NOT NULL\n         );\n         CREATE INDEX IF NOT EXISTS audit_entries_by_recorded_at\n             ON audit_entries (recorded_at, id);";

function createFreshDatabase(databasePath: string): void {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 1000,
  });
  try {
    database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA journal_mode = DELETE;",
    );
    database.exec("BEGIN IMMEDIATE");
    database.exec(schemaPrelude);
    database.exec(
      "CREATE TABLE items (id INTEGER PRIMARY KEY NOT NULL, human_identifier TEXT NOT NULL UNIQUE, title TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id), status TEXT NOT NULL CHECK (status IN ('Inbox','Active','Waiting','Done')), notes TEXT NOT NULL DEFAULT '')",
    );
    database.exec(schemaRemainder);
    database.prepare("INSERT INTO contexts (id, name) VALUES (1, 'Personal')").run();
    database
      .prepare(
        "INSERT INTO projects (id, context_id, name, default_item_status) VALUES (1, 1, 'Default', 'Inbox')",
      )
      .run();
    database
      .prepare("UPDATE metadata SET value = 2 WHERE key IN ('next_context_id', 'next_project_id')")
      .run();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* Keep the original error. */
    }
    database.close();
    throw error;
  }
  database.close();
}

/** Opens the current user database; only a missing database is initialized. */
export function openSqliteDatabase(
  databasePath = path.join(homedir(), ".ai-mission-manager", "mission-manager.sqlite"),
) {
  if (!existsSync(databasePath)) createFreshDatabase(databasePath);
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 1000,
  });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
  try {
    const journalMode = rows<{ journal_mode: string }>(database, "PRAGMA journal_mode")[0]
      ?.journal_mode;
    if (journalMode !== "delete")
      throw new Error("database journal mode is incompatible; expected DELETE");
    validateCompatibleSchema(database);
    return { database, databasePath };
  } catch (error) {
    database.close();
    throw error;
  }
}

function validateCompatibleSchema(database: DatabaseSync): void {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec("PRAGMA foreign_keys=ON;");
    expected.exec(schemaPrelude);
    expected.exec(
      "CREATE TABLE items (id INTEGER PRIMARY KEY NOT NULL, human_identifier TEXT NOT NULL UNIQUE, title TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id), status TEXT NOT NULL CHECK (status IN ('Inbox','Active','Waiting','Done')), notes TEXT NOT NULL DEFAULT '')",
    );
    expected.exec(schemaRemainder);
    const tables = rows<{ name: string }>(
      expected,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    for (const { name } of tables) {
      const expectedColumns = tableColumns(expected, name);
      const actualColumns = tableColumns(database, name);
      if (
        expectedColumns.length === 0 ||
        expectedColumns.some((column) => !actualColumns.includes(column))
      ) {
        throw new Error(INCOMPATIBLE_SCHEMA);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === INCOMPATIBLE_SCHEMA) throw error;
    throw new Error(INCOMPATIBLE_SCHEMA);
  } finally {
    expected.close();
  }
}
