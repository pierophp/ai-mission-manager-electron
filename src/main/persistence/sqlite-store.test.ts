import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandDispatcher, invokeEnvelope } from "../../shared/ipc";
import { createReadCommandHandlers } from "./commands";
import { openSqliteStore } from "./sqlite-store";

const temporaryDirectories: string[] = [];
function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-sqlite-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "mission-manager.sqlite");
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Rust-compatible read-only SQLite store", () => {
  it("creates the Rust-openable Personal and Default seed using DELETE journaling", () => {
    const databasePath = temporaryDatabase();
    const store = openSqliteStore(databasePath);
    const state = store.loadState();
    expect(state.contexts.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 1, name: "Personal" },
    ]);
    expect(
      state.projects.map(({ id, context_id, name, defaults }) => ({
        id,
        context_id,
        name,
        defaults,
      })),
    ).toEqual([
      {
        id: 1,
        context_id: 1,
        name: "Default",
        defaults: { item_status: "Inbox", execution_mode: "worktree" },
      },
    ]);
    store.close();
    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    check.close();
  });

  it("loads the settings and Activity reads from the existing database", async () => {
    const databasePath = temporaryDatabase();
    openSqliteStore(databasePath).close();
    const writer = new DatabaseSync(databasePath);
    writer.exec("PRAGMA foreign_keys=ON;");
    writer
      .prepare(
        "INSERT INTO settings(key,value) VALUES('setup_completed','true'),('provider_choice','none')",
      )
      .run();
    writer.prepare("INSERT INTO contexts(id,name,pstack_roles_json) VALUES(2,'Research','')").run();
    writer
      .prepare(
        "INSERT INTO projects(id,context_id,name,default_item_status) VALUES(2,2,'Tools','Active')",
      )
      .run();
    writer
      .prepare(
        "INSERT INTO items(id,human_identifier,title,project_id,status,notes) VALUES(7,'I-7','Inbox item',2,'Inbox','')",
      )
      .run();
    writer
      .prepare(
        "INSERT INTO external_objects(id,provider,kind,external_key,canonical_url) VALUES(1,'github','issue','o/r#1','https://github.com/o/r/issues/1')",
      )
      .run();
    writer
      .prepare(
        "INSERT INTO activities(id,external_object_id,observed_at,changes_json) VALUES(1,1,100,'[]')",
      )
      .run();
    writer
      .prepare(
        'INSERT INTO audit_entries(id,recorded_at,action_json) VALUES(1,100,\'{"action":"contextCreated","context_id":2}\')',
      )
      .run();
    writer.close();

    const store = openSqliteStore(databasePath);
    const dispatch = createCommandDispatcher(createReadCommandHandlers(store));
    expect(await invokeEnvelope(dispatch, "get_setup_state")).toEqual({
      completed: true,
      provider: "none",
    });
    expect(await invokeEnvelope(dispatch, "list_contexts")).toMatchObject([
      { id: 1, name: "Personal" },
      { id: 2, name: "Research", pstack_roles: expect.any(Array) },
    ]);
    expect(await invokeEnvelope(dispatch, "list_inbox_items")).toMatchObject([
      { id: 7, human_identifier: "I-7" },
    ]);
    expect(await invokeEnvelope(dispatch, "get_activity_tab")).toMatchObject({
      audit_entries: [{ id: 1, action: { action: "contextCreated", context_id: 2 } }],
      activities: [
        {
          activity: { id: 1 },
          object: { id: 1, canonical_url: "https://github.com/o/r/issues/1" },
        },
      ],
    });
    store.close();
  });

  it("does not rewrite an existing database when it is opened and closed", () => {
    const databasePath = temporaryDatabase();
    openSqliteStore(databasePath).close();
    const before = readFileSync(databasePath);
    const store = openSqliteStore(databasePath);
    store.loadState();
    store.close();
    expect(readFileSync(databasePath).equals(before)).toBe(true);
  });

  it("loads the versioned fixture produced by the Rust persistence test into its expected DomainState", async () => {
    const fixtureDirectory = path.resolve(process.cwd(), "src/main/persistence/fixtures");
    const manifest = JSON.parse(
      readFileSync(path.join(fixtureDirectory, "manifest.json"), "utf8"),
    ) as {
      fixtureVersion: number;
      source: string;
      artifacts: string[];
      rustSource: { commit: string; fixtureGenerator: string };
      typescriptDatabaseOpenValidation: { result: string; command: string };
    };
    expect(manifest.fixtureVersion).toBe(1);
    expect(manifest.source).toContain("Rust persistence test");
    expect(manifest.artifacts).toEqual(["rust-persistence.sqlite", "domain-state.json"]);
    expect(manifest.rustSource.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.rustSource.fixtureGenerator).toContain("persistence/tests.rs");
    expect(manifest.typescriptDatabaseOpenValidation.result).toContain("passed");
    expect(manifest.typescriptDatabaseOpenValidation.command).toContain("cargo test");
    const expectedState = JSON.parse(
      readFileSync(path.join(fixtureDirectory, "domain-state.json"), "utf8"),
    );
    const store = openSqliteStore(path.join(fixtureDirectory, "rust-persistence.sqlite"));
    expect(store.loadState()).toEqual(expectedState);
    const dispatch = createCommandDispatcher(createReadCommandHandlers(store));
    expect(await invokeEnvelope(dispatch, "get_setup_state")).toEqual({
      completed: true,
      provider: "none",
    });
    store.close();
  });

  it("reports the Rust-compatible incompatibility message for a partial schema", () => {
    const databasePath = temporaryDatabase();
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE items(id INTEGER PRIMARY KEY, project_id INTEGER); CREATE TABLE link_attention_state(link_id INTEGER PRIMARY KEY);",
    );
    database.close();
    expect(() => openSqliteStore(databasePath)).toThrow(
      "database schema is incompatible; remove the database and start again",
    );
  });

  it("rejects a schema missing any loader column with the same incompatibility message", () => {
    const databasePath = temporaryDatabase();
    openSqliteStore(databasePath).close();
    const database = new DatabaseSync(databasePath);
    database.exec("ALTER TABLE runs DROP COLUMN plan_path;");
    database.close();

    expect(() => openSqliteStore(databasePath)).toThrow(
      "database schema is incompatible; remove the database and start again",
    );
  });
});
