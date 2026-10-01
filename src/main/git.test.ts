import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Machine } from "../domain/types";
import type { MachineAccess, MachineProbe } from "./machine-access";
import { GitCli, machinePathArg, parseWorktreeList } from "./git";
import { openSqliteStore } from "./persistence/sqlite-store";
import { Runtime } from "./runtime";
import { createStructureCommandHandlers } from "./structure-commands";
import { createWorkCommandHandlers } from "./work-commands";
import { createDeletionCommandHandlers } from "./deletion-commands";
import { createCommandDispatcher, invokeEnvelope } from "../shared/ipc";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class GitMachineAccess implements MachineAccess {
  readonly calls: string[] = [];
  readonly transports: Machine["transport"][] = [];
  constructor(readonly home: string) {}
  async runShell(machine: Machine, command: string): Promise<string> {
    this.calls.push(command);
    this.transports.push(machine.transport);
    const result = spawnSync("sh", ["-lc", command], {
      encoding: "utf8",
      env: { ...process.env, HOME: this.home },
    });
    if (result.status !== 0)
      throw new Error(result.stderr.trim() || `command exited with ${result.status}`);
    return result.stdout;
  }
  async machineHome(): Promise<string> {
    return this.home;
  }
  async findExecutable(): Promise<string> {
    return "/usr/bin/git";
  }
  async writeFile(): Promise<void> {}
  async checkMachine(): Promise<MachineProbe> {
    return {
      reachable: true,
      tmuxAvailable: true,
      bunAvailable: true,
      bunError: null,
      stateDirectoryWritable: true,
      error: null,
    };
  }
}

const machine: Machine = {
  id: 1,
  context_id: 1,
  name: "Local",
  socket_name: "mission-test",
  transport: { kind: "local" },
  last_observed: "unknown",
  last_observed_at: null,
};

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "mission-git-test-"));
  directories.push(home);
  const seed = path.join(home, "seed");
  const origin = path.join(home, "origin.git");
  await mkdir(seed);
  spawnSync("git", ["init", "--bare", "--initial-branch=main", origin], { encoding: "utf8" });
  spawnSync("git", ["init", "--initial-branch=main", seed], { encoding: "utf8" });
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test User");
  await writeFile(path.join(seed, "README.md"), "initial\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  return { home, seed, origin };
}

describe("Git adapter", () => {
  it("parses porcelain entries and preserves tilde expansion in machine paths", () => {
    expect(
      parseWorktreeList(
        "worktree /tmp/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/detached\nHEAD def\ndetached\n\n",
      ),
    ).toEqual([
      { path: "/tmp/main", branch: "main" },
      { path: "/tmp/detached", branch: null },
    ]);
    expect(machinePathArg("~/worktrees/feature test")).toBe("~/'worktrees/feature test'");
  });

  it("clones the configured remote, fetches base, creates an upstream Worktree, and validates an attachment", async () => {
    const { home, origin } = await fixture();
    const access = new GitMachineAccess(home);
    const gitAdapter = new GitCli(access);
    const checkout = path.join(home, "checkouts", "service");
    const repository = {
      id: 1,
      project_id: 1,
      name: "service",
      remote_url: origin,
      base_branch: "main",
    };
    const adopted = await gitAdapter.cloneRepository(machine, origin, checkout);
    expect(adopted.currentBranch).toBe("main");
    const destination = path.join(home, "worktrees", "feature-service");
    const created = await gitAdapter.prepareWorktree(
      machine,
      repository,
      checkout,
      destination,
      "feature/service",
      "main",
      false,
      false,
    );
    expect(created).toMatchObject({ currentBranch: "feature/service", isDirty: false });
    expect(git(destination, "config", "branch.feature/service.remote")).toBe("origin");
    expect(git(destination, "config", "branch.feature/service.merge")).toBe(
      "refs/heads/feature/service",
    );
    expect(
      (
        await gitAdapter.validateAttachment(
          machine,
          repository,
          checkout,
          destination,
          "feature/service",
          false,
        )
      ).isDirty,
    ).toBe(false);
    expect(access.calls.some((command) => command.includes("worktree list --porcelain"))).toBe(
      true,
    );
  });

  it("rejects remote mismatches, dirty attachments, and branches already attached", async () => {
    const { home, seed, origin } = await fixture();
    const access = new GitMachineAccess(home);
    const adapter = new GitCli(access);
    const checkout = path.join(home, "checkout");
    git(seed, "clone", origin, checkout);
    const repository = {
      id: 1,
      project_id: 1,
      name: "service",
      remote_url: origin,
      base_branch: "main",
    };
    const destination = path.join(home, "worktree");
    await adapter.prepareWorktree(
      machine,
      repository,
      checkout,
      destination,
      "feature/a",
      "main",
      false,
      false,
    );
    await expect(
      adapter.prepareWorktree(
        machine,
        repository,
        checkout,
        path.join(home, "second"),
        "feature/a",
        "main",
        true,
        false,
      ),
    ).rejects.toThrow("target branch is already attached to a Worktree");
    await writeFile(path.join(destination, "dirty.txt"), "dirty\n");
    await expect(
      adapter.validateAttachment(machine, repository, checkout, destination, "feature/a", false),
    ).rejects.toThrow("Git Worktree is dirty and needs explicit confirmation");
    await expect(
      adapter.adoptRepository(machine, checkout, "https://wrong.example/repo"),
    ).rejects.toThrow("Repository remote does not match the configured remote");
  });

  it("uses MachineAccess for SSH Git operations and preserves ~/ paths", async () => {
    const { home, origin } = await fixture();
    await mkdir(path.join(home, "remote-checkouts"));
    const access = new GitMachineAccess(home);
    const sshMachine: Machine = {
      ...machine,
      id: 2,
      name: "Build",
      transport: {
        kind: "ssh",
        host: "build.example",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      },
    };
    const checkout = "~/remote-checkouts/service";
    const repository = {
      id: 1,
      project_id: 1,
      name: "service",
      remote_url: origin,
      base_branch: "main",
    };
    const adapter = new GitCli(access);
    await adapter.cloneRepository(sshMachine, origin, checkout);
    await adapter.prepareWorktree(
      sshMachine,
      repository,
      checkout,
      "~/remote-worktrees/service",
      "feature/remote",
      "main",
      false,
      false,
    );
    expect(
      access.calls.some((command) => command.includes("git -C ~/'remote-checkouts/service'")),
    ).toBe(true);
    expect(access.transports.some((transport) => transport.kind === "ssh")).toBe(true);
    expect(
      await access.runShell(sshMachine, "test -e ~/remote-worktrees/service/.git && printf yes"),
    ).toBe("yes");
  });

  it("rejects failed fetches, absent base refs, existing destinations, and unrequested reuse", async () => {
    const { home, seed, origin } = await fixture();
    const adapter = new GitCli(new GitMachineAccess(home));
    const checkout = path.join(home, "checkout");
    git(home, "clone", origin, checkout);
    const repository = {
      id: 1,
      project_id: 1,
      name: "service",
      remote_url: origin,
      base_branch: "main",
    };
    const occupied = path.join(home, "occupied");
    await mkdir(occupied);
    await expect(
      adapter.prepareWorktree(
        machine,
        repository,
        checkout,
        occupied,
        "feature/a",
        "main",
        false,
        false,
      ),
    ).rejects.toThrow("checkout destination already exists");
    await writeFile(path.join(occupied, "marker.txt"), "non-empty\n");
    await expect(adapter.cloneRepository(machine, origin, occupied)).rejects.toThrow(
      "checkout destination is not empty",
    );
    await expect(
      adapter.prepareWorktree(
        machine,
        repository,
        checkout,
        path.join(home, "missing-base"),
        "feature/base",
        "develop",
        false,
        false,
      ),
    ).rejects.toThrow("configured remote base branch does not exist: origin/develop");
    git(checkout, "branch", "feature/existing");
    await expect(
      adapter.prepareWorktree(
        machine,
        repository,
        checkout,
        path.join(home, "existing-branch"),
        "feature/existing",
        "main",
        false,
        false,
      ),
    ).rejects.toThrow("target branch already exists: feature/existing");
    await adapter.prepareWorktree(
      machine,
      repository,
      checkout,
      path.join(home, "reused-local"),
      "feature/existing",
      "main",
      true,
      false,
    );
    git(seed, "switch", "-c", "feature/remote");
    git(seed, "push", "origin", "feature/remote");
    await adapter.prepareWorktree(
      machine,
      repository,
      checkout,
      path.join(home, "reused-remote"),
      "feature/remote",
      "main",
      true,
      false,
    );
    expect(git(path.join(home, "reused-remote"), "config", "branch.feature/remote.remote")).toBe(
      "origin",
    );
    const missingRemote = path.join(home, "missing-origin.git");
    git(checkout, "remote", "set-url", "origin", missingRemote);
    await expect(
      adapter.prepareWorktree(
        machine,
        { ...repository, remote_url: missingRemote },
        checkout,
        path.join(home, "fetch-failed"),
        "feature/fetch",
        "main",
        false,
        false,
      ),
    ).rejects.toThrow("Git fetch the configured remote failed:");
  });

  it("registers a cloned Repository and prepares a Worktree through IPC and SQLite", async () => {
    const { home, origin } = await fixture();
    await mkdir(path.join(home, "checkouts"));
    const database = path.join(home, "mission-manager.sqlite");
    const store = openSqliteStore(database);
    const runtime = new Runtime(store);
    runtime.dispatch({ type: "create_context", name: "Build" });
    runtime.dispatch({
      type: "register_machine",
      contextId: 2,
      name: "Build Machine",
      socketName: "mission-build",
      transport: { kind: "local" },
    });
    runtime.dispatch({ type: "set_context_execution_machine", contextId: 1, machineId: 1 });
    runtime.dispatch({
      type: "create_item",
      title: "Git adapter",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    const access = new GitMachineAccess(home);
    const dispatch = createCommandDispatcher({
      ...createStructureCommandHandlers(runtime, access, store),
      ...createWorkCommandHandlers(runtime, access),
      ...createDeletionCommandHandlers(runtime, access),
    });
    await invokeEnvelope(dispatch, "register_repository_at_location", {
      projectId: 1,
      name: "service",
      remoteUrl: origin,
      baseBranch: "main",
      machineId: 1,
      checkoutPath: "~/checkouts/service",
      worktreeRoot: "~/worktrees",
      cloneIntoDestination: true,
    });
    await expect(
      invokeEnvelope(dispatch, "register_repository_at_location", {
        projectId: 1,
        name: "service",
        remoteUrl: origin,
        baseBranch: "main",
        machineId: 1,
        checkoutPath: "~/checkouts/service",
        worktreeRoot: "~/worktrees",
        cloneIntoDestination: false,
      }),
    ).rejects.toBe("Repository 1 has already been configured on Machine 1");
    const worktree = (await invokeEnvelope(dispatch, "prepare_worktree", {
      workspaceId: 1,
      repositoryId: 1,
      machineId: 1,
      reuseExistingBranch: false,
      confirmDirtyAttachment: false,
    })) as { id: number; path: string; branch: string; is_dirty: boolean };
    expect(worktree).toMatchObject({
      id: 1,
      path: "~/worktrees/workspace-1/mission-I-1/service",
      branch: "mission-I-1",
      is_dirty: false,
    });
    expect(store.loadState().worktrees).toHaveLength(1);
    expect(store.loadState().workspaces[0].preparation_state).toBe("ready");
    const raw = new DatabaseSync(database, { readOnly: true });
    expect(raw.prepare("SELECT path,branch,is_dirty FROM worktrees WHERE id=1").get()).toEqual({
      path: worktree.path,
      branch: worktree.branch,
      is_dirty: 0,
    });
    raw.close();
    await writeFile(
      path.join(home, "worktrees/workspace-1/mission-I-1/service/dirty.txt"),
      "keep until confirmed\n",
    );
    const removal = (await invokeEnvelope(dispatch, "prepare_worktree_removal", {
      worktreeId: 1,
    })) as { isDirty: boolean; requiresDestructiveConfirmation: boolean };
    expect(removal).toMatchObject({ isDirty: true, requiresDestructiveConfirmation: true });
    await expect(
      invokeEnvelope(dispatch, "remove_worktree", {
        worktreeId: 1,
        confirmed: true,
        destructiveConfirmed: false,
      }),
    ).rejects.toBe("Removing a dirty Worktree requires destructive confirmation");
    await invokeEnvelope(dispatch, "remove_worktree", {
      worktreeId: 1,
      confirmed: true,
      destructiveConfirmed: true,
    });
    expect(store.loadState().worktrees).toHaveLength(0);
    expect(
      git(path.join(home, "checkouts/service"), "show-ref", "--verify", "refs/heads/mission-I-1"),
    ).toContain("refs/heads/mission-I-1");
    runtime.dispatch({
      type: "create_item",
      title: "Attach existing Worktree",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    const checkout = path.join(home, "checkouts", "service");
    const attachedPath = path.join(home, "manual-worktrees", "service");
    await new GitCli(access).prepareWorktree(
      machine,
      { id: 1, project_id: 1, name: "service", remote_url: origin, base_branch: "main" },
      checkout,
      attachedPath,
      "mission-I-2",
      "main",
      false,
      false,
    );
    const attached = (await invokeEnvelope(dispatch, "attach_worktree", {
      workspaceId: 2,
      repositoryId: 1,
      machineId: 1,
      path: "~/manual-worktrees/service",
      confirmDirtyAttachment: false,
    })) as { id: number; path: string; branch: string };
    expect(attached).toMatchObject({
      id: 2,
      path: "~/manual-worktrees/service",
      branch: "mission-I-2",
    });
    runtime.dispatch({
      type: "create_item",
      title: "Create Worktree record",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    const created = (await invokeEnvelope(dispatch, "create_worktree", {
      workspaceId: 3,
      repositoryId: 1,
      machineId: 1,
      path: "~/manually-created/service",
      branch: "mission-I-3",
      baseBranch: "main",
    })) as { id: number; path: string; branch: string };
    expect(created).toMatchObject({
      id: 3,
      path: "~/manually-created/service",
      branch: "mission-I-3",
    });
    expect(store.loadState().worktrees).toHaveLength(2);
    store.close();
  });
});
