import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandDispatcher, invokeEnvelope } from "../../shared/ipc";
import { createReadCommandHandlers } from "./commands";
import { createStructureCommandHandlers } from "../structure-commands";
import { openSqliteStore } from "./sqlite-store";
import { Runtime } from "../runtime";
import { FakeMachineAccess } from "../machine-access";

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

describe("Rust-compatible SQLite store", () => {
  it("persists explicit Run lifecycle audit actions in the same SQLite transaction", () => {
    const store = openSqliteStore(temporaryDatabase());
    const state = store.loadState();
    store.commit({
      state,
      effects: [
        { type: "persist_audit", action: { action: "runFinished", run_id: 42 } },
        { type: "persist_audit", action: { action: "runDeleted", run_id: 42 } },
      ],
    });
    const raw = new DatabaseSync(store.path, { readOnly: true });
    expect(raw.prepare("SELECT action_json FROM audit_entries ORDER BY id").all()).toEqual([
      { action_json: '{"action":"runFinished","run_id":42}' },
      { action_json: '{"action":"runDeleted","run_id":42}' },
    ]);
    raw.close();
  });

  it("round trips Rust-shaped SSH transport JSON and dispatches Machine/Profile commands", async () => {
    const store = openSqliteStore(temporaryDatabase());
    const runtime = new Runtime(store);
    const access = new FakeMachineAccess();
    const handlers = createStructureCommandHandlers(runtime, access, store);
    const dispatch = createCommandDispatcher({ ...createReadCommandHandlers(store), ...handlers });
    const ssh = {
      kind: "ssh" as const,
      host: "build.example",
      user: "piero",
      port: 2222,
      identityFile: "/tmp/build key",
      knownHostsFile: "/tmp/known hosts",
      strictHostKeyChecking: "accept-new",
    };
    const machine = await invokeEnvelope(dispatch, "register_machine", {
      contextId: 1,
      name: "Build",
      socketName: "mission-build",
      transport: ssh,
    });
    expect(machine).toMatchObject({ id: 1, name: "Build" });
    expect(store.loadState().machines[0]).toMatchObject({ id: 1, transport: ssh });
    const raw = new DatabaseSync(store.path, { readOnly: true });
    expect(raw.prepare("SELECT transport_json FROM machines WHERE id=1").get()).toEqual({
      transport_json:
        '{"kind":"ssh","host":"build.example","user":"piero","port":2222,"identity_file":"/tmp/build key","known_hosts_file":"/tmp/known hosts","strict_host_key_checking":"accept-new"}',
    });
    raw.close();
    await invokeEnvelope(dispatch, "set_context_execution_machine", { contextId: 1, machineId: 1 });
    await invokeEnvelope(dispatch, "create_context", { name: "Shared" });
    await invokeEnvelope(dispatch, "set_context_execution_machine", { contextId: 2, machineId: 1 });
    const profile = (await invokeEnvelope(dispatch, "create_cli_configuration_profile", {
      machineId: 1,
      provider: "claude",
      name: "Work",
      appManaged: true,
      existingDirectory: null,
    })) as {
      profile: {
        id: number;
        machineId: number;
        provider: string;
        name: string;
        appManaged: boolean;
      };
      signInCommand: string;
    };
    expect(profile.profile).toMatchObject({
      id: 1,
      machineId: 1,
      provider: "claude",
      name: "Work",
      appManaged: true,
    });
    expect(profile.signInCommand).toBe(
      'CLAUDE_CONFIG_DIR="$HOME/.config/ai-mission-manager/cli-profiles/claude/1" claude',
    );
    let signalShellStarted!: () => void;
    let releaseShell!: () => void;
    const shellStarted = new Promise<void>((resolve) => {
      signalShellStarted = resolve;
    });
    const shellGate = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    access.shellGate = shellGate;
    access.onShellStart = signalShellStarted;
    const createProfile = (name: string) =>
      invokeEnvelope(dispatch, "create_cli_configuration_profile", {
        machineId: 1,
        provider: "claude",
        name,
        appManaged: true,
        existingDirectory: null,
      });
    const firstCreation = createProfile("Concurrent A");
    await shellStarted;
    const secondCreation = createProfile("Concurrent B");
    releaseShell();
    const concurrentProfiles = await Promise.all([firstCreation, secondCreation]);
    expect(
      concurrentProfiles.map((result) => (result as { profile: { id: number } }).profile.id),
    ).toEqual([2, 3]);
    expect(
      access.calls.filter(({ operation }) => operation === "shell").map(({ command }) => command),
    ).toEqual([
      'mkdir -p -- "$HOME/.config/ai-mission-manager/cli-profiles/claude/1"',
      'mkdir -p -- "$HOME/.config/ai-mission-manager/cli-profiles/claude/2"',
      'mkdir -p -- "$HOME/.config/ai-mission-manager/cli-profiles/claude/3"',
    ]);
    access.shellGate = undefined;
    access.onShellStart = undefined;
    await expect(
      invokeEnvelope(dispatch, "create_cli_configuration_profile", {
        machineId: 1,
        provider: "claude",
        name: "Work",
        appManaged: true,
        existingDirectory: null,
      }),
    ).rejects.toBeTruthy();
    expect(access.calls.map(({ operation }) => operation)).toEqual(["shell", "shell", "shell"]);
    await invokeEnvelope(dispatch, "set_context_cli_configuration_profile", {
      contextId: 1,
      provider: "claude",
      profileId: 1,
    });
    await invokeEnvelope(dispatch, "set_context_cli_configuration_profile", {
      contextId: 2,
      provider: "claude",
      profileId: 1,
    });
    expect(await invokeEnvelope(dispatch, "check_machine", { machineId: 1 })).toMatchObject({
      last_observed: "available",
      readiness: { reachable: true, tmuxAvailable: true },
    });
    expect(await invokeEnvelope(dispatch, "list_machines")).toMatchObject([
      { id: 1, last_observed: "available", readiness: { reachable: true, tmuxAvailable: true } },
    ]);
    expect(access.calls.map(({ operation }) => operation)).toEqual([
      "shell",
      "shell",
      "shell",
      "check",
    ]);
    const offlineAccess = new FakeMachineAccess("", {
      reachable: false,
      tmuxAvailable: null,
      bunAvailable: null,
      bunError: null,
      stateDirectoryWritable: null,
      error: "Could not reach Machine Build: Connection timed out",
    });
    const offlineDispatch = createCommandDispatcher({
      ...createReadCommandHandlers(store),
      ...createStructureCommandHandlers(runtime, offlineAccess, store),
    });
    expect(await invokeEnvelope(offlineDispatch, "check_machine", { machineId: 1 })).toMatchObject({
      last_observed: "offline",
      readiness: {
        reachable: false,
        tmuxAvailable: null,
        error: "Could not reach Machine Build: Connection timed out",
      },
    });
    await expect(
      invokeEnvelope(dispatch, "set_context_cli_configuration_profile", {
        contextId: 1,
        provider: "codex",
        profileId: 1,
      }),
    ).rejects.toEqual("CLI configuration profile 1 is for Claude, not Codex");
    await expect(
      invokeEnvelope(dispatch, "delete_cli_configuration_profile", { profileId: 1 }),
    ).rejects.toEqual('CLI configuration profile is selected by Contexts: ["Personal", "Shared"]');
    await invokeEnvelope(dispatch, "set_context_cli_configuration_profile", {
      contextId: 1,
      provider: "claude",
      profileId: null,
    });
    await invokeEnvelope(dispatch, "set_context_cli_configuration_profile", {
      contextId: 2,
      provider: "claude",
      profileId: null,
    });
    expect(
      await invokeEnvelope(dispatch, "delete_cli_configuration_profile", { profileId: 1 }),
    ).toBeNull();
    store.close();
  });

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
    expect(manifest.artifacts).toEqual([
      "rust-persistence.sqlite",
      "domain-state.json",
      "context-write-rust.json",
    ]);
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

describe("Context write transactions", () => {
  it("persists Context, Default Project, configuration, metadata, and both Rust-shaped audit actions", async () => {
    const { Runtime } = await import("../runtime");
    const store = openSqliteStore(temporaryDatabase());
    const runtime = new Runtime(store);
    const before = runtime.snapshot();
    const context = runtime.dispatch({ type: "create_context", name: "Research" }).contexts.at(-1)!;
    expect(context.id).toBe(before.next_context_id);
    expect(runtime.snapshot().projects.at(-1)).toMatchObject({
      context_id: context.id,
      name: "Default",
    });
    const database = new DatabaseSync(store.path, { readOnly: true });
    expect(
      database
        .prepare("SELECT id,name,check_dirty_checkouts FROM contexts WHERE id=?")
        .get(context.id),
    ).toEqual({ id: context.id, name: "Research", check_dirty_checkouts: 1 });
    expect(
      database.prepare("SELECT value FROM metadata WHERE key='next_context_id'").get(),
    ).toEqual({ value: context.id + 1 });
    expect(database.prepare("SELECT action_json FROM audit_entries ORDER BY id").all()).toEqual([
      { action_json: `{"action":"contextCreated","context_id":${context.id}}` },
      { action_json: `{"action":"projectCreated","project_id":${context.id}}` },
    ]);
    database.close();
    store.close();
  });

  it("matches the Rust-generated Context write compatibility fixture byte for byte", async () => {
    const { Runtime } = await import("../runtime");
    const { newContextConfiguration } = await import("./sqlite-store");
    const store = openSqliteStore(temporaryDatabase());
    const seed = new DatabaseSync(store.path);
    seed.exec("PRAGMA foreign_keys=ON");
    seed
      .prepare(
        "INSERT INTO machines(id,context_id,name,socket_name,transport_json,last_observed) VALUES(1,1,'Build','mission','{\"kind\":\"local\"}','unknown')",
      )
      .run();
    seed
      .prepare(
        "INSERT INTO cli_configuration_profiles(id,machine_id,provider,name,directory,app_managed) VALUES(1,1,'claude','Claude','/profiles/claude',0),(2,1,'codex','Codex','/profiles/codex',0)",
      )
      .run();
    seed.prepare("UPDATE metadata SET value=2 WHERE key='next_machine_id'").run();
    seed.prepare("UPDATE metadata SET value=3 WHERE key='next_cli_profile_id'").run();
    seed
      .prepare(
        "INSERT INTO items(id,human_identifier,title,project_id,status,notes) VALUES(77,'I-77','Compat Item',1,'Inbox','')",
      )
      .run();
    seed.close();
    const runtime = new Runtime(store);
    const configuration = newContextConfiguration();
    configuration.name = "Research";
    configuration.executionMachineId = 1;
    configuration.claudeProfileId = 1;
    configuration.codexProfileId = 2;
    configuration.ghExecutablePath = "/tools/gh";
    configuration.twgExecutablePath = "/tools/twg";
    configuration.azExecutablePath = "/tools/az";
    configuration.atlassianSite = "https://acme.atlassian.net";
    configuration.azureDevopsOrganization = "acme-devops";
    configuration.bitbucketWorkspace = "acme-bitbucket";
    configuration.checkDirtyCheckouts = false;
    const context = createStructureCommandHandlers(runtime).create_context_configuration({
      configuration,
    }) as import("../../domain/types").Context;
    const structureCommands = createStructureCommandHandlers(runtime);
    structureCommands.create_project({
      contextId: 1,
      name: "Tools",
      defaultItemStatus: "Active",
      executionMode: "direct",
    });
    structureCommands.update_project({
      projectId: 3,
      name: "Product Tools",
      defaultItemStatus: "Waiting",
      executionMode: "worktree",
    });
    structureCommands.register_repository({
      projectId: 1,
      name: "core",
      remoteUrl: "git@github.com:team/core.git",
    });
    structureCommands.update_repository({
      repositoryId: 1,
      name: "core",
      remoteUrl: "https://github.com/team/core.git",
      baseBranch: "trunk",
    });
    structureCommands.update_repository_location({
      repositoryId: 1,
      previousMachineId: null,
      machineId: 1,
      checkoutPath: "/work/core",
      worktreeRoot: "/worktrees/core",
    });
    const fixture = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "src/main/persistence/fixtures/context-write-rust.json"),
        "utf8",
      ),
    ) as {
      context: Record<string, unknown>;
      project: Record<string, unknown>;
      attention_defaults: Record<string, unknown>[];
      audit_action_jsons: string[];
      projects: unknown[][];
      repositories: unknown[][];
      repository_locations: unknown[][];
      workspaces: unknown[][];
      workspace_repositories: unknown[][];
      metadata: Record<string, number>;
    };
    const database = new DatabaseSync(store.path, { readOnly: true });
    const contextRow = database
      .prepare(
        "SELECT id,name,execution_machine_id,check_dirty_checkouts,grill_agent,grill_model,grill_effort,implement_agent,implement_model,implement_effort,default_workflow,pstack_agent,pstack_model,pstack_effort,pstack_roles_json,claude_profile_id,codex_profile_id,gh_executable_path,twg_executable_path,az_executable_path,atlassian_site,azure_devops_organization,bitbucket_workspace FROM contexts WHERE id=?",
      )
      .get(context.id);
    const projectRow = database
      .prepare(
        "SELECT id,context_id,name,default_item_status,default_execution_mode FROM projects WHERE context_id=?",
      )
      .get(context.id);
    const attentionRows = database
      .prepare(
        "SELECT object_kind,title_attention,state_attention,metadata_attention FROM context_attention_defaults WHERE context_id=? ORDER BY object_kind",
      )
      .all(context.id);
    const auditRows = database
      .prepare("SELECT action_json FROM audit_entries ORDER BY id")
      .all() as { action_json: string }[];
    const projects = database
      .prepare(
        "SELECT id,context_id,name,default_item_status,default_execution_mode FROM projects ORDER BY id",
      )
      .all()
      .map((row) => Object.values(row));
    const repositories = database
      .prepare("SELECT id,project_id,name,remote_url,base_branch FROM repositories ORDER BY id")
      .all()
      .map((row) => Object.values(row));
    const repositoryLocations = database
      .prepare(
        "SELECT repository_id,machine_id,checkout_path,worktree_root FROM repository_locations ORDER BY repository_id,machine_id",
      )
      .all()
      .map((row) => Object.values(row));
    const workspaces = database
      .prepare("SELECT id,item_id,preparation_state FROM workspaces ORDER BY id")
      .all()
      .map((row) => Object.values(row));
    const workspaceRepositories = database
      .prepare(
        "SELECT workspace_id,repository_id,branch,base_branch FROM workspace_repositories ORDER BY workspace_id,repository_id",
      )
      .all()
      .map((row) => Object.values(row));
    const metadata = Object.fromEntries(
      [
        "next_context_id",
        "next_project_id",
        "next_audit_id",
        "next_machine_id",
        "next_cli_profile_id",
        "next_repository_id",
        "next_workspace_id",
      ].map((key) => [
        key,
        (database.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: number })
          .value,
      ]),
    );
    expect(contextRow).toEqual(fixture.context);
    expect(projectRow).toEqual(fixture.project);
    expect(attentionRows).toEqual(fixture.attention_defaults);
    expect(auditRows.map(({ action_json }) => action_json)).toEqual(fixture.audit_action_jsons);
    expect(projects).toEqual(fixture.projects);
    expect(repositories).toEqual(fixture.repositories);
    expect(repositoryLocations).toEqual(fixture.repository_locations);
    expect(workspaces).toEqual(fixture.workspaces);
    expect(workspaceRepositories).toEqual(fixture.workspace_repositories);
    expect(metadata).toEqual(fixture.metadata);
    database.close();
    store.close();
    const reopened = openSqliteStore(store.path);
    expect(reopened.loadState().contexts.find((entry) => entry.id === context.id)).toMatchObject({
      execution_machine_id: 1,
      claude_profile_id: 1,
      codex_profile_id: 2,
      gh_executable_path: "/tools/gh",
      twg_executable_path: "/tools/twg",
      az_executable_path: "/tools/az",
      atlassian_site: "https://acme.atlassian.net",
      azure_devops_organization: "acme-devops",
      bitbucket_workspace: "acme-bitbucket",
    });
    reopened.close();
  });

  it("round-trips dedicated Context defaults and preserves Document attention on a three-policy update", async () => {
    const { Runtime } = await import("../runtime");
    const { newContextConfiguration } = await import("./sqlite-store");
    const store = openSqliteStore(temporaryDatabase());
    const runtime = new Runtime(store);
    runtime.dispatch({
      type: "set_context_grill_defaults",
      contextId: 1,
      defaults: { agent: "claude", model: "claude-opus-5", effort: "medium" },
    });
    runtime.dispatch({
      type: "set_context_implement_defaults",
      contextId: 1,
      defaults: { agent: "codex", model: "gpt-6-sol", effort: "high" },
    });
    for (const objectKind of ["issue", "pull_request", "generic"] as const)
      runtime.dispatch({
        type: "set_context_attention_default",
        contextId: 1,
        objectKind,
        policy: { title: false, state: false, metadata: false },
      });
    runtime.dispatch({
      type: "set_context_attention_default",
      contextId: 1,
      objectKind: "document",
      policy: { title: true, state: false, metadata: true },
    });
    expect(store.loadState().contexts[0]).toMatchObject({
      grill_defaults: { agent: "claude", model: "claude-opus-5", effort: "medium" },
      implement_defaults: { agent: "codex", model: "gpt-6-sol", effort: "high" },
    });
    const configuration = newContextConfiguration();
    configuration.name = "Personal";
    configuration.attentionDefaults = configuration.attentionDefaults
      .filter((entry) => entry.object_kind !== "document")
      .map((entry) => ({ ...entry, context_id: 1 }));
    runtime.dispatch({ type: "update_context_configuration", contextId: 1, configuration });
    expect(store.loadState().attention_defaults).toContainEqual({
      context_id: 1,
      object_kind: "document",
      policy: { title: true, state: false, metadata: true },
    });
    store.close();
  });

  it("keeps in-memory state and rolls back earlier effects if an effect fails", async () => {
    const { Runtime } = await import("../runtime");
    const store = openSqliteStore(temporaryDatabase());
    const runtime = new Runtime(store);
    const before = runtime.snapshot();
    const database = new DatabaseSync(store.path);
    database.exec(
      "CREATE TRIGGER reject_project BEFORE INSERT ON projects WHEN NEW.name='Default' AND NEW.context_id=2 BEGIN SELECT RAISE(ABORT,'write rejected'); END",
    );
    database.close();
    expect(() => runtime.dispatch({ type: "create_context", name: "Research" })).toThrow(
      "write rejected",
    );
    expect(runtime.snapshot()).toEqual(before);
    const verify = new DatabaseSync(store.path, { readOnly: true });
    expect(
      verify.prepare("SELECT COUNT(*) AS count FROM contexts WHERE name='Research'").get(),
    ).toEqual({ count: 0 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM audit_entries").get()).toEqual({
      count: 0,
    });
    verify.close();
    store.close();
  });
});
