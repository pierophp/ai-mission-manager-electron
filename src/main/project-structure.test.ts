import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { createStructureCommandHandlers } from "./structure-commands";
import { openSqliteStore } from "./persistence/sqlite-store";
import { ensureProjectWorkspaces } from "./persistence/startup";
import type { Project, Repository } from "../domain/types";
import { decide } from "../domain/state-transition";
import { createCommandDispatcher } from "../shared/ipc";

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(path.join(tmpdir(), "project-structure-test-"));
  directories.push(directory);
  return path.join(directory, "mission-manager.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Project and Repository commands", () => {
  it("persists Project defaults, Repositories, locations, and hidden execution Workspaces", async () => {
    const file = databasePath();
    const store = openSqliteStore(file);
    const seed = new DatabaseSync(file);
    seed
      .prepare(
        "INSERT INTO items(id,human_identifier,title,project_id,status,notes) VALUES(1,'I-23','Task',1,'Inbox','')",
      )
      .run();
    seed
      .prepare(
        "INSERT INTO machines(id,context_id,name,socket_name,transport_json) VALUES(1,1,'Local','mission','{\"kind\":\"local\"}'),(2,1,'Build','build','{\"kind\":\"local\"}')",
      )
      .run();
    seed.close();

    const runtime = new Runtime(store);
    const dispatch = createCommandDispatcher(createStructureCommandHandlers(runtime));
    const invoke = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = await dispatch(name, args);
      if (!result.ok) throw result.error;
      return result.value as T;
    };
    const project = await invoke<Project>("create_project", {
      name: "  Product  ",
      contextId: 1,
      defaultItemStatus: "Active",
      executionMode: "direct",
    });
    expect(project).toMatchObject({
      id: 2,
      context_id: 1,
      name: "Product",
      defaults: { item_status: "Active", execution_mode: "direct" },
    });
    await invoke("update_project", {
      projectId: 2,
      name: "Product Tools",
      defaultItemStatus: "Waiting",
      executionMode: "worktree",
    });
    await expect(
      invoke("create_project", {
        name: "Product Tools",
        contextId: 1,
        defaultItemStatus: "Inbox",
        executionMode: "worktree",
      }),
    ).rejects.toThrow("Project name already exists in Context 1: Product Tools");

    const repository = await invoke<Repository>("register_repository", {
      projectId: 1,
      name: "  core  ",
      remoteUrl: "  git@github.com:team/core.git  ",
    });
    expect(repository).toMatchObject({
      id: 1,
      project_id: 1,
      name: "core",
      remote_url: "git@github.com:team/core.git",
      base_branch: "main",
    });
    await invoke("update_repository", {
      repositoryId: 1,
      name: "core",
      remoteUrl: "https://github.com/team/core.git",
      baseBranch: "trunk",
    });
    await invoke("update_repository_location", {
      repositoryId: 1,
      previousMachineId: null,
      machineId: 1,
      checkoutPath: "/work/core",
      worktreeRoot: "/worktrees/core",
    });
    await invoke("update_repository_location", {
      repositoryId: 1,
      previousMachineId: 1,
      machineId: 2,
      checkoutPath: "/build/core",
      worktreeRoot: "/build/worktrees/core",
    });
    runtime.dispatch({
      type: "set_workspace_repositories",
      workspaceId: 1,
      repositories: [{ repositoryId: 1, branch: "feature/keep", baseBranch: "release" }],
    });
    await invoke<Repository>("register_repository", {
      projectId: 1,
      name: "docs",
      remoteUrl: "git@github.com:team/docs.git",
    });

    const inspection = new DatabaseSync(file, { readOnly: true });
    expect(
      inspection
        .prepare(
          "SELECT id,name,default_item_status,default_execution_mode FROM projects WHERE id=2",
        )
        .get(),
    ).toEqual({
      id: 2,
      name: "Product Tools",
      default_item_status: "Waiting",
      default_execution_mode: "worktree",
    });
    expect(
      inspection
        .prepare("SELECT id,project_id,name,remote_url,base_branch FROM repositories WHERE id=1")
        .get(),
    ).toEqual({
      id: 1,
      project_id: 1,
      name: "core",
      remote_url: "https://github.com/team/core.git",
      base_branch: "trunk",
    });
    expect(
      inspection
        .prepare(
          "SELECT repository_id,machine_id,checkout_path,worktree_root FROM repository_locations",
        )
        .get(),
    ).toEqual({
      repository_id: 1,
      machine_id: 2,
      checkout_path: "/build/core",
      worktree_root: "/build/worktrees/core",
    });
    expect(
      inspection.prepare("SELECT value FROM metadata WHERE key='next_repository_id'").get(),
    ).toEqual({ value: 3 });
    expect(inspection.prepare("SELECT action_json FROM audit_entries ORDER BY id").all()).toEqual([
      { action_json: '{"action":"projectCreated","project_id":2}' },
      { action_json: '{"action":"repositoryRegistered","repository_id":1}' },
      { action_json: '{"action":"repositoryRegistered","repository_id":2}' },
    ]);
    expect(inspection.prepare("SELECT id,item_id,preparation_state FROM workspaces").all()).toEqual(
      [{ id: 1, item_id: 1, preparation_state: "pending" }],
    );
    expect(
      inspection
        .prepare(
          "SELECT workspace_id,repository_id,branch,base_branch FROM workspace_repositories ORDER BY repository_id",
        )
        .all(),
    ).toEqual([
      { workspace_id: 1, repository_id: 1, branch: "feature/keep", base_branch: "release" },
      { workspace_id: 1, repository_id: 2, branch: "mission-I-23", base_branch: "main" },
    ]);
    inspection.close();
    store.close();

    const reopened = openSqliteStore(file);
    expect(reopened.loadState()).toMatchObject({
      projects: [
        { id: 1, name: "Default" },
        {
          id: 2,
          name: "Product Tools",
          defaults: { item_status: "Waiting", execution_mode: "worktree" },
        },
      ],
      repositories: [
        {
          id: 1,
          name: "core",
          remote_url: "https://github.com/team/core.git",
          base_branch: "trunk",
        },
        { id: 2, name: "docs", remote_url: "git@github.com:team/docs.git", base_branch: "main" },
      ],
      repository_locations: [
        {
          repository_id: 1,
          machine_id: 2,
          checkout_path: "/build/core",
          worktree_root: "/build/worktrees/core",
        },
      ],
      workspaces: [
        {
          id: 1,
          item_id: 1,
          repositories: [
            { repositoryId: 1, branch: "feature/keep", baseBranch: "release" },
            { repositoryId: 2, branch: "mission-I-23", baseBranch: "main" },
          ],
        },
      ],
    });
    reopened.close();
  });

  it("runs workspace reconciliation again when startup loads an existing Item and Repository", () => {
    const file = databasePath();
    const store = openSqliteStore(file);
    const seed = new DatabaseSync(file);
    seed
      .prepare(
        "INSERT INTO items(id,human_identifier,title,project_id,status,notes) VALUES(1,'I-42','Task',1,'Inbox','')",
      )
      .run();
    seed
      .prepare(
        "INSERT INTO repositories(id,project_id,name,remote_url,base_branch) VALUES(1,1,'core','git@github.com:team/core.git','main')",
      )
      .run();
    seed.prepare("UPDATE metadata SET value=2 WHERE key='next_repository_id'").run();
    seed.close();

    const runtime = new Runtime(store);
    ensureProjectWorkspaces(runtime);
    ensureProjectWorkspaces(runtime);
    expect(runtime.snapshot().workspaces).toMatchObject([
      {
        id: 1,
        item_id: 1,
        repositories: [{ repositoryId: 1, branch: "mission-I-42", baseBranch: "main" }],
      },
    ]);
    const persisted = new DatabaseSync(file, { readOnly: true });
    expect(persisted.prepare("SELECT id,item_id FROM workspaces").all()).toEqual([
      { id: 1, item_id: 1 },
    ]);
    persisted.close();
    store.close();
  });

  it("validates and moves Repository locations with the Rust error messages", () => {
    const file = databasePath();
    const store = openSqliteStore(file);
    const seed = new DatabaseSync(file);
    seed.exec("PRAGMA foreign_keys=ON");
    seed.prepare("INSERT INTO contexts(id,name) VALUES(2,'Other')").run();
    seed
      .prepare(
        "INSERT INTO projects(id,context_id,name,default_item_status) VALUES(2,2,'Other','Inbox')",
      )
      .run();
    seed
      .prepare(
        "INSERT INTO machines(id,context_id,name,socket_name,transport_json) VALUES(1,1,'Local','local','{\"kind\":\"local\"}'),(2,1,'Build','build','{\"kind\":\"local\"}'),(3,2,'Other','other','{\"kind\":\"local\"}')",
      )
      .run();
    seed
      .prepare(
        "INSERT INTO repositories(id,project_id,name,remote_url,base_branch) VALUES(1,1,'core','git@github.com:team/core.git','main')",
      )
      .run();
    seed
      .prepare(
        "INSERT INTO repository_locations(repository_id,machine_id,checkout_path,worktree_root) VALUES(1,1,'/work/core','/worktrees/core')",
      )
      .run();
    seed.close();

    const state = store.loadState();
    const decision = decide(state, {
      type: "update_repository_location",
      repositoryId: 1,
      previousMachineId: 1,
      machineId: 2,
      checkoutPath: " /build/core ",
      worktreeRoot: " /build/worktrees/core ",
    });
    expect(decision.state.repository_locations).toEqual([
      {
        repository_id: 1,
        machine_id: 2,
        checkout_path: "/build/core",
        worktree_root: "/build/worktrees/core",
      },
    ]);
    expect(decision.effects).toEqual([
      {
        type: "update_repository_location",
        previousMachineId: 1,
        location: {
          repository_id: 1,
          machine_id: 2,
          checkout_path: "/build/core",
          worktree_root: "/build/worktrees/core",
        },
      },
    ]);
    expect(() =>
      decide(state, {
        type: "update_repository_location",
        repositoryId: 99,
        previousMachineId: null,
        machineId: 2,
        checkoutPath: "/build/core",
        worktreeRoot: "/build/worktrees/core",
      }),
    ).toThrow("Repository 99 does not exist");
    expect(() =>
      decide(state, {
        type: "update_repository_location",
        repositoryId: 1,
        previousMachineId: 9,
        machineId: 2,
        checkoutPath: "/build/core",
        worktreeRoot: "/build/worktrees/core",
      }),
    ).toThrow("Repository 1 has no location on Machine 9");
    expect(() =>
      decide(state, {
        type: "update_repository_location",
        repositoryId: 1,
        previousMachineId: null,
        machineId: 9,
        checkoutPath: "/build/core",
        worktreeRoot: "/build/worktrees/core",
      }),
    ).toThrow("Machine 9 does not exist");
    expect(() =>
      decide(state, {
        type: "update_repository_location",
        repositoryId: 1,
        previousMachineId: 1,
        machineId: 3,
        checkoutPath: "/other/core",
        worktreeRoot: "/other/worktrees/core",
      }),
    ).toThrow("Machine 3 belongs to another Context");
    expect(() =>
      decide(
        {
          ...state,
          repository_locations: [
            ...state.repository_locations,
            {
              repository_id: 1,
              machine_id: 2,
              checkout_path: "/build/core",
              worktree_root: "/build/worktrees/core",
            },
          ],
        },
        {
          type: "update_repository_location",
          repositoryId: 1,
          previousMachineId: 1,
          machineId: 2,
          checkoutPath: "/build/core",
          worktreeRoot: "/build/worktrees/core",
        },
      ),
    ).toThrow("Repository 1 has already been configured on Machine 2");
    expect(() =>
      decide(state, {
        type: "update_repository_location",
        repositoryId: 1,
        previousMachineId: 1,
        machineId: 2,
        checkoutPath: " ",
        worktreeRoot: "/build/worktrees/core",
      }),
    ).toThrow("a Repository checkout path cannot be blank");
    expect(() =>
      decide(state, {
        type: "update_repository_location",
        repositoryId: 1,
        previousMachineId: 1,
        machineId: 2,
        checkoutPath: "/build/core",
        worktreeRoot: " ",
      }),
    ).toThrow("a Repository Worktree root cannot be blank");
    store.close();
  });
});
