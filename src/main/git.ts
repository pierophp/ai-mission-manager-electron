import path from "node:path";
import type { Machine, Repository } from "../domain/types";
import { shellQuote, type MachineAccess } from "./machine-access";

export type CheckoutInspection = {
  remoteUrl: string | null;
  currentBranch: string;
  isDirty: boolean;
};

export type GitWorktreeEntry = { path: string; branch: string | null };

export function machinePathArg(value: string): string {
  if (value === "~") return "~";
  if (value.startsWith("~/")) return `~/${shellQuote(value.slice(2))}`;
  return shellQuote(value);
}

export function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let currentPath: string | undefined;
  let branch: string | null = null;
  for (const line of [...output.split(/\r?\n/), ""]) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/"))
      branch = line.slice("branch refs/heads/".length);
    else if (!line && currentPath !== undefined) {
      entries.push({ path: currentPath, branch });
      currentPath = undefined;
      branch = null;
    }
  }
  return entries;
}

export class GitCli {
  constructor(private readonly access: MachineAccess) {}

  async inspectCheckout(machine: Machine, checkoutPath: string): Promise<CheckoutInspection> {
    await this.git(
      machine,
      "validate the checkout Git repository",
      checkoutPath,
      "rev-parse --show-toplevel",
    );
    const remoteUrl = await this.repositoryUrl(machine, checkoutPath, "read the checkout remote");
    const currentBranch =
      (await this.optionalGit(machine, checkoutPath, "symbolic-ref --short HEAD"))?.trim() ||
      "HEAD (detached)";
    const status = await this.git(
      machine,
      "read the checkout status",
      checkoutPath,
      "status --porcelain --untracked-files=all",
    );
    return { remoteUrl, currentBranch, isDirty: Boolean(status.trim()) };
  }

  async cloneRepository(
    machine: Machine,
    remoteUrl: string,
    destination: string,
  ): Promise<CheckoutInspection> {
    const remote = remoteUrl.trim();
    if (!remote) throw new Error("Git clone the repository failed: remote URL cannot be blank");
    let destinationExists = false;
    try {
      await this.access.runShell(machine, `test -e ${machinePathArg(destination)}`);
      destinationExists = true;
    } catch {
      // A missing destination is the normal case.
    }
    if (destinationExists) {
      try {
        await this.access.runShell(machine, `test -d ${machinePathArg(destination)}`);
      } catch {
        throw new Error(`checkout destination already exists: ${destination}`);
      }
      let entries: string;
      try {
        entries = await this.access.runShell(
          machine,
          `find ${machinePathArg(destination)} -mindepth 1 -print -quit`,
        );
      } catch (error) {
        throw new Error(
          `could not inspect directory ${destination}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (entries.trim()) throw new Error(`checkout destination is not empty: ${destination}`);
    }
    await this.command(
      machine,
      "clone the repository",
      `git clone ${shellQuote(remote)} ${machinePathArg(destination)}`,
    );
    return this.adoptRepository(machine, destination, remote);
  }

  async adoptRepository(
    machine: Machine,
    checkoutPath: string,
    expectedRemote?: string | null,
  ): Promise<CheckoutInspection> {
    const inspection = await this.inspectCheckout(machine, checkoutPath);
    const expected = expectedRemote?.trim();
    if (!expected) return inspection;
    if (inspection.remoteUrl === expected) return inspection;
    if (inspection.remoteUrl === null)
      throw new Error(`Repository has no configured remote matching ${expected}`);
    throw new Error(
      `Repository remote does not match the configured remote: expected ${expected}, found ${inspection.remoteUrl}`,
    );
  }

  async prepareWorktree(
    machine: Machine,
    repository: Repository,
    checkoutPath: string,
    destination: string,
    branch: string,
    baseBranch: string,
    reuseExistingBranch: boolean,
    confirmDirtyAttachment: boolean,
  ): Promise<CheckoutInspection> {
    if (!branch.trim() || !baseBranch.trim())
      throw new Error(
        `Git prepare the Git Worktree failed: ${!branch.trim() ? "target branch cannot be blank" : "base branch cannot be blank"}`,
      );
    try {
      await this.access.runShell(machine, `test -e ${machinePathArg(destination)}`);
      throw new Error(`checkout destination already exists: ${destination}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("checkout destination already exists:")
      )
        throw error;
    }
    const remote = await this.configuredRemote(machine, checkoutPath, repository.remote_url);
    await this.git(
      machine,
      "fetch the configured remote",
      checkoutPath,
      `fetch ${shellQuote(remote)}`,
    );
    const baseRef = `refs/remotes/${remote}/${baseBranch}`;
    if (
      !(await this.optionalGit(machine, checkoutPath, `rev-parse --verify ${shellQuote(baseRef)}`))
    )
      throw new Error(`configured remote base branch does not exist: ${remote}/${baseBranch}`);
    const attached = (await this.listWorktrees(machine, checkoutPath)).find(
      (entry) => entry.branch === branch,
    );
    if (attached)
      throw new Error(
        `target branch is already attached to a Worktree: ${branch} at ${attached.path}`,
      );
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const localExists = Boolean(
      await this.optionalGit(machine, checkoutPath, `show-ref --verify ${shellQuote(localRef)}`),
    );
    const remoteExists = Boolean(
      await this.optionalGit(machine, checkoutPath, `show-ref --verify ${shellQuote(remoteRef)}`),
    );
    const parent = path.posix.dirname(destination);
    await this.command(
      machine,
      "create the Worktree parent directory",
      `mkdir -p ${machinePathArg(parent)}`,
    );
    if (reuseExistingBranch) {
      if (localExists)
        await this.git(
          machine,
          "attach the existing target branch",
          checkoutPath,
          `worktree add ${machinePathArg(destination)} ${shellQuote(branch)}`,
        );
      else if (remoteExists)
        await this.git(
          machine,
          "attach the existing remote target branch",
          checkoutPath,
          `worktree add --track -b ${shellQuote(branch)} ${machinePathArg(destination)} ${shellQuote(remoteRef)}`,
        );
      else throw new Error(`target branch does not exist for reuse: ${branch}`);
    } else {
      if (localExists || remoteExists) throw new Error(`target branch already exists: ${branch}`);
      await this.git(
        machine,
        "create the target Git Worktree",
        checkoutPath,
        `worktree add -b ${shellQuote(branch)} ${machinePathArg(destination)} ${shellQuote(baseRef)}`,
      );
      await this.git(
        machine,
        "configure the target branch upstream",
        destination,
        `config ${shellQuote(`branch.${branch}.remote`)} ${shellQuote(remote)}`,
      );
      await this.git(
        machine,
        "configure the target branch merge name",
        destination,
        `config ${shellQuote(`branch.${branch}.merge`)} ${shellQuote(`refs/heads/${branch}`)}`,
      );
    }
    return this.validateAttachment(
      machine,
      repository,
      checkoutPath,
      destination,
      branch,
      confirmDirtyAttachment,
    );
  }

  async validateAttachment(
    machine: Machine,
    repository: Repository,
    checkoutPath: string,
    worktreePath: string,
    branch: string,
    confirmDirty: boolean,
  ): Promise<CheckoutInspection> {
    const requested = await this.canonicalPath(machine, worktreePath);
    const canonicalCheckout = await this.canonicalPath(machine, checkoutPath);
    let isRegistered = false;
    for (const entry of await this.listWorktrees(machine, checkoutPath)) {
      const entryPath = await this.canonicalPath(machine, entry.path);
      if (entryPath === requested && entryPath !== canonicalCheckout) {
        isRegistered = true;
        break;
      }
    }
    if (!isRegistered) throw new Error(`path is not a registered Git Worktree: ${worktreePath}`);
    const inspection = await this.inspectCheckout(machine, worktreePath);
    if (inspection.remoteUrl !== repository.remote_url)
      throw new Error(
        `Repository remote does not match the configured remote: expected ${repository.remote_url}, found ${inspection.remoteUrl ?? ""}`,
      );
    if (inspection.currentBranch !== branch)
      throw new Error(
        `Git Worktree branch does not match: expected ${branch}, found ${inspection.currentBranch}`,
      );
    if (inspection.isDirty && !confirmDirty)
      throw new Error(`Git Worktree is dirty and needs explicit confirmation: ${worktreePath}`);
    return inspection;
  }

  async listWorktrees(machine: Machine, checkoutPath: string): Promise<GitWorktreeEntry[]> {
    return parseWorktreeList(
      await this.git(machine, "list Git Worktrees", checkoutPath, "worktree list --porcelain"),
    );
  }

  async removeWorktree(
    machine: Machine,
    checkoutPath: string,
    worktreePath: string,
    destructiveConfirmed = false,
  ): Promise<void> {
    await this.git(
      machine,
      "remove the Git Worktree",
      checkoutPath,
      `worktree remove ${destructiveConfirmed ? "--force " : ""}${machinePathArg(worktreePath)}`,
    );
  }

  private async configuredRemote(
    machine: Machine,
    checkout: string,
    expected: string,
  ): Promise<string> {
    const remotes = (await this.git(machine, "list configured Git remotes", checkout, "remote"))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    for (const remote of remotes)
      if (
        (
          await this.git(
            machine,
            "read configured Git remote",
            checkout,
            `remote get-url ${shellQuote(remote)}`,
          )
        ).trim() === expected
      )
        return remote;
    if (remotes.length) {
      const actual = (
        await this.git(
          machine,
          "read configured Git remote",
          checkout,
          `remote get-url ${shellQuote(remotes[0])}`,
        )
      ).trim();
      throw new Error(
        `Repository remote does not match the configured remote: expected ${expected}, found ${actual}`,
      );
    }
    throw new Error(`Repository has no configured remote matching ${expected}`);
  }

  private async repositoryUrl(
    machine: Machine,
    checkout: string,
    operation: string,
  ): Promise<string | null> {
    const remotes = (await this.git(machine, "list checkout remotes", checkout, "remote"))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    return remotes.length
      ? (
          await this.git(machine, operation, checkout, `remote get-url ${shellQuote(remotes[0])}`)
        ).trim()
      : null;
  }

  private async canonicalPath(machine: Machine, value: string): Promise<string> {
    return (await this.access.runShell(machine, `cd ${machinePathArg(value)} && pwd -P`)).trim();
  }
  private async git(
    machine: Machine,
    operation: string,
    checkout: string,
    args: string,
  ): Promise<string> {
    return this.command(machine, operation, `git -C ${machinePathArg(checkout)} ${args}`);
  }
  private async optionalGit(
    machine: Machine,
    checkout: string,
    args: string,
  ): Promise<string | null> {
    try {
      return await this.access.runShell(machine, `git -C ${machinePathArg(checkout)} ${args}`);
    } catch {
      return null;
    }
  }
  private async command(machine: Machine, operation: string, command: string): Promise<string> {
    try {
      return await this.access.runShell(machine, command);
    } catch (error) {
      throw new Error(
        `Git ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
