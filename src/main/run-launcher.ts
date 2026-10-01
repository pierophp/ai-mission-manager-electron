import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DomainState } from "../domain/model";
import { composeGrillPrompt, composeRunPrompt, runLaunchOptions } from "../domain/projections";
import type { Run, RunLaunchRequest, RunLaunchStrategy } from "../domain/types";
import type { RunPromptSelection } from "../domain/execution-types";
import type { Runtime } from "./runtime";
import type { MachineAccess } from "./machine-access";
import { shellQuote } from "./machine-access";
import { GitCli } from "./git";
import { normalizeMachinePath, resolveMachinePath } from "./machine-path";
import type { TerminalRuntime } from "./terminal";
import { ensureStateRunsDirectory, provisionAgentState, stateFilePath } from "./agent-state";
import { provisionPstackTree, pstackTreeDirectory, pstackSkillSnapshot } from "./pstack";
import { productSkills } from "./generated-resources";
import type { DirectRunPreview, Machine, RunCheckout, Workflow } from "../domain/types";
import { composeImplementationQueuePrompt } from "../domain/implementation-queue";

const execFileAsync = promisify(execFile);

function active(run: Run) {
  return (
    run.state !== "finished" ||
    (run.execution_profile === "grill" && run.grill_phase !== "finished") ||
    (run.execution_profile === "plan" && run.plan_phase === "awaitingGo")
  );
}
function launchIdentity(
  state: DomainState,
  itemId: number,
  workspaceId: number,
  machineId: number,
  worktreeId: number | null,
) {
  const item = state.items.find((entry) => entry.id === itemId);
  const projectId = item?.project_id;
  const contextId = state.projects.find((entry) => entry.id === projectId)?.context_id;
  return {
    nextRunId: state.next_run_id,
    item,
    project: state.projects.find((entry) => entry.id === projectId),
    context: state.contexts.find((entry) => entry.id === contextId),
    workspace: state.workspaces.find((entry) => entry.id === workspaceId),
    machine: state.machines.find((entry) => entry.id === machineId),
    worktree: worktreeId == null ? null : state.worktrees.find((entry) => entry.id === worktreeId),
    repositories: state.repositories.filter((entry) => entry.project_id === projectId),
    locations: state.repository_locations.filter((entry) => entry.machine_id === machineId),
    selectedWorktrees: state.worktrees.filter((entry) => entry.workspaceId === workspaceId),
  };
}
function tmuxPrefix(machine: Machine, executable = "tmux") {
  return `${shellQuote(machine.transport.kind === "local" ? executable : "tmux")} -f /dev/null -L ${shellQuote(machine.socket_name)}`;
}
function launchCommand(
  machine: Machine,
  gate: string,
  runId: number,
  agent: string,
  executable: string,
  prompt: string,
  model?: string,
  effort?: string,
  profileDirectory?: string,
  hookFile?: string,
) {
  const title = `${tmuxPrefix(machine)} select-pane -T ${shellQuote(agent)} -t "$TMUX_PANE"`;
  const wait = `${tmuxPrefix(machine)} wait-for ${shellQuote(gate)}`;
  const env = [
    `AI_MISSION_MANAGER_RUN_ID=${shellQuote(String(runId))}`,
    `AI_MISSION_MANAGER_STATE_FILE=${shellQuote(hookFile ?? "")}`,
    `AI_MISSION_MANAGER_TMUX_PATH=${shellQuote("tmux")}`,
    `AI_MISSION_MANAGER_TMUX_SOCKET=${shellQuote(machine.socket_name)}`,
    `AI_MISSION_MANAGER_PANE_ID="$TMUX_PANE"`,
  ];
  const homeName = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const inheritedCredentials =
    agent === "claude"
      ? [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
        ]
      : [
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "CODEX_ACCESS_TOKEN",
          "OPENAI_FEDERATION_RULE_ID",
          "OPENAI_IDENTITY_TOKEN_FILE",
          "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
        ];
  const profile = profileDirectory
    ? `unset ${inheritedCredentials.join(" ")} && export ${homeName}=${shellQuote(profileDirectory)}`
    : `unset ${homeName}`;
  const args = [
    ...(agent === "codex" ? [executable, "exec"] : [executable]),
    ...(model ? ["--model", model] : []),
    ...(effort
      ? [
          agent === "claude" ? "--effort" : "-c",
          agent === "claude" ? effort : `model_reasoning_effort=${effort}`,
        ]
      : []),
    prompt,
  ]
    .map(shellQuote)
    .join(" ");
  return `${title} && ${wait} && export ${env.join(" ")} && ${profile} && exec ${args}`;
}

function skillBody(source: string): string {
  const body = source.startsWith("---\n") ? source.slice(4) : source;
  const end = body.indexOf("\n---\n");
  return end < 0 ? source : body.slice(end + 5);
}

export function pstackRolePath(context: DomainState["contexts"][number], root: string): string {
  const roles = context.pstack_roles ?? [];
  const option = (value: number | null | undefined) => (value == null ? "None" : `Some(${value})`);
  const identity = `${JSON.stringify(roles)}|${option(context.claude_profile_id)}|${option(context.codex_profile_id)}|${context.id}`;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(identity))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `${root}/roles/context-${context.id}-${hash.toString(16).padStart(16, "0")}.md`;
}

export function composePstackPrompt(
  state: DomainState,
  itemId: number,
  profile: string,
  root: string,
  language: "portuguese" | "english" | null,
  initialPrompt: string | null,
): string {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Item ${itemId} does not exist`);
  const initial = initialPrompt?.trim() || null;
  const project = state.projects.find((candidate) => candidate.id === item.project_id)!;
  const context = state.contexts.find((candidate) => candidate.id === project.context_id)!;
  const spec = state.links.find(
    (link) => link.item_id === itemId && link.purpose === "to-spec",
  )?.external_object_id;
  const specUrl = state.external_objects.find((object) => object.id === spec)?.canonical_url;
  const rolesPath = pstackRolePath(context, root);
  const rolesInstruction = `Read the generated role instructions at \`${rolesPath}\` and follow them when delegating.`;
  if (["pstack-review", "custom"].includes(profile) && !initial)
    throw new Error("Run prompt cannot be empty");
  const mode: Record<string, string> = {
    autonomous: `You are starting an Autonomous pstack Run. Read \`${root}/skills/poteto-mode/SKILL.md\` in full before acting. The Skill tool is unavailable because these skills disable model invocation; read any other needed skill by its absolute path under \`${root}/skills/\` instead of relying on the Skill tool. ${rolesInstruction} Do not paste skill text into your response.`,
    plan: `You are starting a Plan pstack Run. Read \`${root}/skills/poteto-mode/SKILL.md\` in full and follow \`${root}/skills/poteto-mode/playbooks/multi-phase-plan.md\` in full. The Skill tool is unavailable because these skills disable model invocation; read both files by their absolute paths. ${rolesInstruction} Complete the required planning phases, write the plan in the repository, then stop without implementing it. Report the plan's repository-relative path in your final response. Do not delegate implementation.`,
    "pstack-review": `You are starting a pstack Review Run. Read \`${root}/skills/interrogate/SKILL.md\` and follow it to review the Pull Request or branch named in the Initial Prompt. Read the generated role instructions at \`${rolesPath}\` and use its \`Review panel\` entry to configure the read-only reviewers. Review only: do not edit files, commit, push, or apply suggested changes. Synthesize the reviewers' findings into a verdict, including actionable findings and disagreements. Do not use the matt-pocock \`review\` profile instructions.`,
    custom: `You are starting a Custom pstack Run. No skill is selected: do what the Initial Prompt asks. ${rolesInstruction}`,
  };
  const instruction = mode[profile];
  if (!instruction) throw new Error(`Execution Profile ${profile} is not in Workflow pstack`);
  let result = `${instruction}\n\nItem: ${item.title}`;
  if (initial) result += `\n\nInitial Prompt:\n${initial}`;
  if (specUrl) result += `\n\nSpec: ${specUrl}`;
  result += `\n\n${language === "english" ? "Respond to the user in English throughout this Run. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate." : "Respond to the user in Portuguese throughout this Run. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate."}\nWrite commits and pull requests in English.\n\nMission Manager event contract:\nWhen a Pull Request is opened, immediately print \`AI_MISSION_MANAGER_EVENT {"event":"pull_request.opened","url":"<canonical Pull Request URL>"}\` on a line by itself. Report every Pull Request opened by this Run. At the end of the final Attention section in your final response, print \`AI_MISSION_MANAGER_EVENT {"event":"attention.final","summary":"<concise Attention summary>"}\`. For a Plan Run, also print \`AI_MISSION_MANAGER_EVENT {"event":"plan.ready","path":"<repository-relative plan path>"}\` after writing the plan. Escape JSON strings correctly.`;
  if (profile === "pstack-review")
    result +=
      "\n\nThis Run is read-only. Do not edit files, change branches, create commits, push, open or modify pull requests, or apply reviewer suggestions. Return the synthesized verdict in the final response.";
  return result.trim();
}

function composePstackRoleFile(
  state: DomainState,
  context: DomainState["contexts"][number],
  parentAgent: "claude" | "codex",
) {
  let contents =
    "# pstack role assignments\n\nDelegate each task according to its role row. Use the configured model and effort. When the role CLI matches the active parent CLI, spawn the role inside the current harness. When it differs, invoke that CLI as shown, preserving the selected Context profile.\n\n";
  for (const entry of context.pstack_roles ?? []) {
    const config = entry.configuration;
    const profileId =
      config.agent === "claude" ? context.claude_profile_id : context.codex_profile_id;
    const profile = state.cli_configuration_profiles.find(
      (candidate) => candidate.id === profileId,
    );
    const profileLine = profile
      ? `Context CLI profile #${profile.id} (\`${profile.name}\`) at \`${profile.directory}\``
      : "the standard CLI configuration (no Context profile selected)";
    const singleQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const invocation =
      config.agent === "claude"
        ? `\`${profile ? `CLAUDE_CONFIG_DIR=${singleQuote(profile.directory)} ` : ""}claude -p --model ${config.model} --effort ${config.effort}\``
        : `\`${profile ? `CODEX_HOME=${singleQuote(profile.directory)} ` : ""}codex exec --model ${config.model} -c model_reasoning_effort=${config.effort}\``;
    const delegation =
      config.agent === parentAgent
        ? `Spawn this role inside the active ${parentAgent === "claude" ? "claude-code" : "codex"} harness.`
        : `This role uses the other CLI; invoke it using ${invocation} with ${profileLine}.`;
    const roleName: Record<string, string> = {
      "code-delegate": "Code delegate",
      "judge-and-prose": "Judge and prose",
      "review-panel": "Review panel",
      explorers: "Explorers",
    };
    contents += `## ${roleName[entry.role]}\n- CLI: ${config.agent === "claude" ? "claude-code" : "codex"}\n- Model: \`${config.model}\`\n- Effort: \`${config.effort}\`\n- ${delegation}\n\n`;
  }
  return contents;
}

async function validateProfileAuthentication(
  machine: Machine,
  access: MachineAccess,
  agent: "claude" | "codex",
  executable: string,
  directory: string,
) {
  const homeVariable = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const args = agent === "claude" ? ["auth", "status"] : ["login", "status"];
  const inherited =
    agent === "claude"
      ? [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
        ]
      : [
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "CODEX_ACCESS_TOKEN",
          "OPENAI_FEDERATION_RULE_ID",
          "OPENAI_IDENTITY_TOKEN_FILE",
          "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
        ];
  if (machine.transport.kind === "local") {
    const environment = { ...process.env, [homeVariable]: directory };
    for (const variable of inherited) delete environment[variable];
    try {
      await execFileAsync(executable, args, { env: environment });
    } catch (error) {
      const detail =
        error instanceof Error && "stderr" in error
          ? String((error as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "").trim()
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`Selected CLI profile is not signed in or usable at ${directory}: ${detail}`);
    }
    return;
  }
  const command = `set -eu; profile_directory=${shellQuote(directory)}; if [ ! -d "$profile_directory" ]; then printf '%s%s\\n' 'Selected CLI configuration profile directory is unavailable: ' "$profile_directory" >&2; exit 1; fi; ${inherited.map((variable) => `if [ -n "\${${variable}:-}" ]; then printf '%s\\n' ${shellQuote(`Inherited credential source ${variable} is set on the remote Machine and may override the selected profile`)} >&2; exit 1; fi`).join("; ")}; export ${homeVariable}="$profile_directory"; exec ${[executable, ...args].map(shellQuote).join(" ")}`;
  try {
    await access.runShell(machine, command);
  } catch (error) {
    throw new Error(
      `Selected CLI profile is not signed in or usable at ${directory} on Machine ${machine.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createRunLaunchHandlers(
  runtime: Runtime,
  access: MachineAccess,
  terminal: TerminalRuntime,
) {
  let queue: Promise<void> = Promise.resolve();
  const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const previous = queue;
    queue = previous.then(() => turn);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const prompt = async (state: DomainState, args: Record<string, unknown>) => {
    const itemId = Number(args.itemId);
    const profile = String(args.executionProfile) as Run["execution_profile"];
    const language = args.language as "portuguese" | "english" | null;
    const initial = args.initialPrompt == null ? null : String(args.initialPrompt);
    if (args.workflow === "pstack") {
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`Item ${itemId} does not exist`);
      const project = state.projects.find((candidate) => candidate.id === item.project_id)!;
      const context = state.contexts.find((candidate) => candidate.id === project.context_id)!;
      if (context.execution_machine_id == null)
        throw new Error(`Context ${context.name} has no execution Machine`);
      const machine = state.machines.find(
        (candidate) => candidate.id === context.execution_machine_id,
      );
      if (!machine) throw new Error(`Machine ${context.execution_machine_id} does not exist`);
      const home = await access.machineHome(machine);
      return composePstackPrompt(
        state,
        itemId,
        profile,
        pstackTreeDirectory(home),
        language,
        initial,
      );
    }
    const selection = args.promptSelection as RunPromptSelection;
    const sourceBody = skillBody(productSkills.implement);
    return composeRunPrompt(
      state,
      itemId,
      profile,
      selection,
      language,
      initial,
      profile === "implement" ? sourceBody : undefined,
    );
  };
  const directPreview = async (
    itemId: number,
    workspaceId: number,
    machineIdArg: number | null,
  ): Promise<DirectRunPreview> => {
    const state = runtime.snapshot();
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    const workspace = state.workspaces.find(
      (candidate) => candidate.id === workspaceId && candidate.item_id === itemId,
    );
    if (!workspace) throw new Error(`Workspace ${workspaceId} does not belong to Item ${itemId}`);
    const project = state.projects.find((candidate) => candidate.id === item.project_id)!;
    const context = state.contexts.find((candidate) => candidate.id === project.context_id)!;
    const machineId = machineIdArg ?? context.execution_machine_id;
    if (machineId == null) throw new Error(`Context ${context.name} has no execution Machine`);
    const machine = state.machines.find((candidate) => candidate.id === machineId);
    if (!machine) throw new Error(`Machine ${machineId} does not exist`);
    if (context.execution_machine_id !== machineId)
      throw new Error(`Context ${context.name} does not use Machine ${machineId}`);
    const home = await access.machineHome(machine);
    const checkouts: RunCheckout[] = [];
    const actualBranches: string[] = [];
    for (const repository of state.repositories.filter(
      (candidate) => candidate.project_id === item.project_id,
    )) {
      const selected = workspace.repositories.find(
        (candidate) => candidate.repositoryId === repository.id,
      );
      if (!selected) continue;
      const location = state.repository_locations.find(
        (candidate) =>
          candidate.repository_id === repository.id && candidate.machine_id === machineId,
      );
      if (!location)
        throw new Error(
          `Repository ${repository.name} has no checkout registered on Machine ${machine.name}`,
        );
      const checkoutPath = resolveMachinePath(location.checkout_path, home);
      const inspection = await new GitCli(access).inspectCheckout(machine, checkoutPath);
      if (inspection.remoteUrl !== null && inspection.remoteUrl !== repository.remote_url)
        throw new Error(
          `Repository ${repository.name} checkout remote does not match its registered Repository`,
        );
      checkouts.push({
        repositoryId: repository.id,
        path: normalizeMachinePath(checkoutPath, home),
        branch: inspection.currentBranch,
        isDirty: inspection.isDirty,
      });
      actualBranches.push(inspection.currentBranch);
    }
    if (!checkouts.length)
      throw new Error(
        `Workspace ${workspaceId} has no registered Repository checkouts on Machine ${machine.name}`,
      );
    const latest = runtime.snapshot();
    if (
      JSON.stringify(latest.items.find((candidate) => candidate.id === itemId)) !==
        JSON.stringify(item) ||
      JSON.stringify(latest.workspaces.find((candidate) => candidate.id === workspaceId)) !==
        JSON.stringify(workspace)
    )
      throw new Error(
        "The Item or Workspace changed while the Run was being prepared; review it again",
      );
    const checkoutDetails = checkouts.map((checkout) => ({
      repositoryId: checkout.repositoryId,
      repositoryName: state.repositories.find(
        (repository) => repository.id === checkout.repositoryId,
      )!.name,
      path: checkout.path,
      branch: checkout.branch,
      isDirty: checkout.isDirty,
    }));
    const busy = state.runs.filter(
      (run) => run.machine_id === machineId && active(run) && run.pane_status !== "missing",
    );
    const shared = busy.flatMap((run) =>
      checkouts
        .filter((checkout) => run.direct_checkouts.some((entry) => entry.path === checkout.path))
        .map((checkout) => ({ runId: run.id, itemId: run.item_id, path: checkout.path })),
    );
    return {
      workspaceId,
      machineId,
      machineName: machine.name,
      workingDirectory: checkouts[0]!.path,
      checkouts,
      checkoutDetails,
      currentBranches: actualBranches,
      dirtyRepositoryIds:
        context.check_dirty_checkouts === false
          ? []
          : checkouts.filter((entry) => entry.isDirty).map((entry) => entry.repositoryId),
      sharedRuns: shared,
      sharedPaths: [...new Set(shared.map((entry) => entry.path))],
    };
  };
  const createRun = async (request: RunLaunchRequest): Promise<Run> =>
    serial(async () => {
      const state = runtime.snapshot();
      const item = state.items.find((candidate) => candidate.id === request.itemId);
      if (!item) throw new Error(`Item ${request.itemId} does not exist`);
      const project = state.projects.find((candidate) => candidate.id === item.project_id)!;
      const context = state.contexts.find((candidate) => candidate.id === project.context_id)!;
      const strategy = request.strategy as RunLaunchStrategy;
      if (strategy.kind === "direct" && strategy.implementationQueue && !strategy.configuration)
        throw new Error("Implementation Queue configuration is required");
      let machine: Machine;
      let worktreeId: number | null = null;
      let repositoryId: number;
      let cwd: string;
      let checkouts: RunCheckout[] = [];
      if (strategy.kind === "worktree") {
        const worktree = state.worktrees.find((candidate) => candidate.id === strategy.worktreeId);
        if (
          !worktree ||
          worktree.workspaceId !== request.workspaceId ||
          !state.workspaces.some(
            (workspace) =>
              workspace.id === request.workspaceId && workspace.item_id === request.itemId,
          )
        )
          throw new Error(`Worktree ${strategy.worktreeId} is not registered for this Item`);
        machine = state.machines.find((candidate) => candidate.id === worktree.machineId)!;
        worktreeId = worktree.id;
        repositoryId = worktree.repositoryId;
        const repository = state.repositories.find((candidate) => candidate.id === repositoryId);
        if (!repository) throw new Error(`Repository ${repositoryId} does not exist`);
        const home = await access.machineHome(machine);
        cwd = resolveMachinePath(worktree.path, home);
        const inspection = await new GitCli(access).inspectCheckout(machine, cwd);
        if (inspection.currentBranch !== worktree.branch)
          throw new Error(
            "The Worktree branch changed after it was approved; review the Worktree before starting a Run",
          );
        if (inspection.remoteUrl !== repository.remote_url)
          throw new Error(
            inspection.remoteUrl === null
              ? "The Worktree has no configured remote for its registered Repository"
              : "The Worktree remote does not match its registered Repository",
          );
      } else {
        const preview = await directPreview(
          request.itemId,
          request.workspaceId,
          strategy.machineId,
        );
        machine = state.machines.find((candidate) => candidate.id === preview.machineId)!;
        repositoryId = strategy.primaryRepositoryId;
        checkouts = preview.checkouts;
        cwd = checkouts.find((checkout) => checkout.repositoryId === repositoryId)?.path ?? "";
        if (!cwd)
          throw new Error(
            `Repository ${repositoryId} is not selected in Workspace ${request.workspaceId}`,
          );
        const checkDirty = context.check_dirty_checkouts !== false;
        if (
          strategy.expectedCheckouts &&
          (strategy.expectedCheckouts.length !== checkouts.length ||
            strategy.expectedCheckouts.some((expected, index) => {
              const observed = checkouts[index];
              return (
                !observed ||
                expected.repositoryId !== observed.repositoryId ||
                expected.path !== observed.path ||
                expected.branch !== observed.branch ||
                (checkDirty && expected.isDirty !== observed.isDirty)
              );
            }))
        )
          throw new Error("The checkout changed after the Run preview; review it again");
        if (preview.sharedRuns.length && !strategy.allowSharedCheckouts)
          throw new Error(
            "The selected checkout is used by another active Run; review the shared checkout preview and allow it to continue",
          );
        if (checkDirty && checkouts.some((checkout) => checkout.isDirty) && !strategy.allowDirty)
          throw new Error(
            "The checkout is dirty; review the Run preview and allow dirty checkouts to continue",
          );
      }
      const runId = runtime.snapshot().next_run_id;
      const identity = JSON.stringify(
        launchIdentity(state, request.itemId, request.workspaceId, machine.id, worktreeId),
      );
      const identityIsCurrent = () =>
        JSON.stringify(
          launchIdentity(
            runtime.snapshot(),
            request.itemId,
            request.workspaceId,
            machine.id,
            worktreeId,
          ),
        ) === identity;
      const agent = strategy.kind === "grill" ? strategy.configuration.agent : strategy.agent;
      const workflow: Workflow = strategy.kind === "grill" ? "matt-pocock" : strategy.workflow;
      const profile = strategy.kind === "grill" ? "grill" : strategy.executionProfile;
      const configuration = strategy.configuration;
      const profileId = agent === "claude" ? context.claude_profile_id : context.codex_profile_id;
      const cliProfile =
        profileId == null
          ? null
          : (state.cli_configuration_profiles.find(
              (candidate) =>
                candidate.id === profileId &&
                candidate.machineId === machine.id &&
                candidate.provider === agent,
            ) ?? null);
      if (profileId != null && !cliProfile)
        throw new Error(
          `Selected ${agent} configuration profile ${profileId} is unavailable on Machine ${machine.name}`,
        );
      const readiness = await access.checkMachine(machine);
      if (readiness.error)
        throw new Error(
          `Run preflight failed on Machine ${machine.name}. The Run was not started locally: ${readiness.error}`,
        );
      const executable = await access.findExecutable(machine, agent);
      const home = await access.machineHome(machine);
      const stateDir =
        machine.transport.kind === "local"
          ? ensureStateRunsDirectory(home)
          : path.posix.join(home, ".local/state/ai-mission-manager/runs");
      const stateFile = stateFilePath(stateDir, runId);
      const profileDir = cliProfile ? resolveMachinePath(cliProfile.directory, home) : undefined;
      if (cliProfile && machine.transport.kind === "local") {
        if (
          !path.isAbsolute(profileDir!) ||
          !fs.existsSync(profileDir!) ||
          !fs.statSync(profileDir!).isDirectory()
        )
          throw new Error(
            `Selected CLI configuration profile directory is unavailable: ${profileDir}`,
          );
        await validateProfileAuthentication(machine, access, agent, executable, profileDir!);
      } else if (cliProfile)
        await validateProfileAuthentication(machine, access, agent, executable, profileDir!);
      await provisionAgentState(machine, access, home, agent, profileDir);
      let launchPrompt = strategy.prompt;
      if (strategy.kind === "grill") {
        const cleaned = strategy.prompt
          .split("\n")
          .filter(
            (line) =>
              !line.startsWith("GRILL_RESPONSE_LANGUAGE=") &&
              !line.startsWith("Respond to the user in Portuguese throughout this Grill Run,") &&
              !line.startsWith("Respond to the user in English throughout this Grill Run,"),
          )
          .join("\n")
          .trim();
        launchPrompt = `${cleaned}\n\nGRILL_RESPONSE_LANGUAGE=${strategy.language}\nRespond to the user in ${strategy.language === "portuguese" ? "Portuguese" : "English"} throughout this Grill Run, including every answer and continuation. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.`;
      }
      if (strategy.kind === "direct" && strategy.implementationQueue) {
        const ticket = strategy.implementationQueue.entries[0];
        if (!ticket) throw new Error("Implementation Queue has no tickets");
        launchPrompt = composeImplementationQueuePrompt(
          productSkills.implement,
          ticket.ticketNumber,
          ticket.ticketUrl,
          strategy.implementationQueue.specUrl,
        );
      }
      let skillSnapshot: string | null = null;
      if (workflow === "pstack") {
        const root = await provisionPstackTree(machine, access, home);
        skillSnapshot = pstackSkillSnapshot();
        await access.writeFile(
          machine,
          pstackRolePath(context, root),
          Buffer.from(composePstackRoleFile(state, context, agent)),
        );
      } else if (profile === "grill") skillSnapshot = skillBody(productSkills.grilling);
      if (!identityIsCurrent())
        throw new Error(
          "The Item, Workspace, Repository, Worktree, or Machine changed while the Run was being prepared; review it again",
        );
      const session = `mission-item-${request.itemId}-${strategy.kind === "grill" ? "grill" : "run"}-${runId}`;
      const gate = `mission-launch-${runId}-${session}`;
      const tmux = tmuxPrefix(machine);
      const paneCreate = `${tmux} new-session -d -s ${shellQuote(session)} -c ${shellQuote(cwd)} sh -lc ${shellQuote(launchCommand(machine, gate, runId, agent, executable, launchPrompt, configuration?.model, configuration?.effort, profileDir, stateFile))}`;
      await access.runShell(machine, paneCreate);
      let paneId: string;
      try {
        paneId = (
          await access.runShell(
            machine,
            `${tmux} display-message -p -t ${shellQuote(`${session}:0.0`)} '#{pane_id}'`,
          )
        ).trim();
        if (!/^%[0-9]+$/.test(paneId))
          throw new Error(`tmux returned an invalid Pane identity: ${paneId}`);
        const paneStatus = (
          await access.runShell(
            machine,
            `${tmux} list-panes -t ${shellQuote(`${session}:0.0`)} -F '#{pane_id}|#{pane_dead}'`,
          )
        ).trim();
        if (paneStatus !== `${paneId}|0`)
          throw new Error("the agent Pane exited before it could be recorded");
      } catch (error) {
        await terminal.killSession(machine, session).catch(() => undefined);
        throw error;
      }
      const latest = runtime.snapshot();
      if (latest.next_run_id !== runId || !identityIsCurrent()) {
        await terminal.killSession(machine, session).catch(() => undefined);
        throw new Error(
          "The Item, Workspace, Repository, Worktree, or Machine changed before the Run could be recorded; review it again",
        );
      }
      const run: Run = {
        id: runId,
        item_id: request.itemId,
        workspace_id: request.workspaceId,
        repository_id: repositoryId,
        worktree_id: worktreeId,
        machine_id: machine.id,
        agent,
        cli_configuration_profile: cliProfile
          ? { profileId: cliProfile.id, provider: cliProfile.provider, name: cliProfile.name }
          : null,
        execution_profile: profile,
        workflow,
        model: configuration?.model ?? null,
        effort: configuration?.effort ?? null,
        skill_snapshot: skillSnapshot,
        prompt: launchPrompt,
        working_directory: cwd,
        session_name: session,
        pane_id: paneId,
        started_at: Math.floor(Date.now() / 1000),
        state: "unknown",
        last_applied_agent_state_sequence: null,
        pane_status: "available",
        direct_checkouts: checkouts,
        transcript: "",
        reported_pull_requests: [],
        attention_summary: null,
        grill_question_group: null,
        grill_answers: [],
        grill_decisions: [],
        grill_response: null,
        grill_phase: profile === "grill" ? "starting" : null,
        grill_action: null,
        plan_phase: profile === "plan" ? null : null,
        plan_path: null,
      };
      try {
        runtime.dispatch({
          type: "start_run",
          run,
          queueAttachment: request.queueAttachment,
          ...(strategy.kind === "direct" && strategy.implementationQueue && configuration
            ? {
                queueStart: {
                  start: strategy.implementationQueue,
                  configuration,
                  allowDirty: strategy.allowDirty,
                  allowSharedCheckouts: strategy.allowSharedCheckouts,
                },
              }
            : {}),
        });
      } catch (error) {
        await terminal.killSession(machine, session).catch(() => undefined);
        throw error;
      }
      try {
        await access.runShell(machine, `${tmux} wait-for -S ${shellQuote(gate)}`);
      } catch (error) {
        throw new Error(
          `Run ${runId} is recorded but the agent was not released: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const startedRun = runtime.snapshot().runs.find((candidate) => candidate.id === runId);
      if (!startedRun) throw new Error(`Run ${runId} was not available after launch`);
      return startedRun;
    });
  return {
    compose_run_prompt: (args: Record<string, unknown>) => prompt(runtime.snapshot(), args),
    compose_grill_prompt: (args: Record<string, unknown>) => {
      const configuration = args.configuration as {
        agent: "claude" | "codex";
        model: string;
        effort: string;
      };
      return composeGrillPrompt(
        runtime.snapshot(),
        Number(args.itemId),
        configuration,
        args.language as "portuguese" | "english",
        String(args.initialPrompt ?? ""),
        skillBody(productSkills.grilling),
      );
    },
    get_run_launch_options: (args: Record<string, unknown>) =>
      runLaunchOptions(
        runtime.snapshot(),
        Number(args.itemId),
        String(args.target) as "checkout" | "worktree",
      ),
    prepare_direct_run: (args: Record<string, unknown>) =>
      directPreview(
        Number(args.itemId),
        Number(args.workspaceId),
        args.machineId == null ? null : Number(args.machineId),
      ),
    prepare_grill_run: (args: Record<string, unknown>) =>
      directPreview(
        Number(args.itemId),
        Number(args.workspaceId),
        args.machineId == null ? null : Number(args.machineId),
      ),
    start_run: (args: Record<string, unknown>) => createRun(args.request as RunLaunchRequest),
    stop_run: async (args: Record<string, unknown>) => {
      const runId = Number(args.runId);
      const run = runtime.snapshot().runs.find((candidate) => candidate.id === runId);
      if (!run) throw new Error(`Run ${runId} does not exist`);
      const machine = runtime
        .snapshot()
        .machines.find((candidate) => candidate.id === run.machine_id);
      if (!machine) throw new Error(`Machine ${run.machine_id} does not exist`);
      await terminal.killPane(machine, run.session_name, run.pane_id);
      const latest = runtime.snapshot();
      const latestRun = latest.runs.find((candidate) => candidate.id === runId);
      const runIdentityIsCurrent =
        latestRun?.id === run.id &&
        latestRun.machine_id === run.machine_id &&
        latestRun.session_name === run.session_name &&
        latestRun.pane_id === run.pane_id &&
        latestRun.agent === run.agent;
      if (
        !runIdentityIsCurrent ||
        JSON.stringify(latest.machines.find((candidate) => candidate.id === machine.id)) !==
          JSON.stringify(machine)
      )
        throw new Error(
          `Run ${runId}'s Pane was stopped, but its application identity changed before the stop could be recorded`,
        );
      runtime.dispatch({ type: "stop_run", runId });
      return runtime.snapshot().runs.find((candidate) => candidate.id === runId)!;
    },
    finish_run: (args: Record<string, unknown>) => {
      runtime.dispatch({ type: "finish_run", runId: Number(args.runId) });
      return runtime.snapshot().runs.find((candidate) => candidate.id === Number(args.runId))!;
    },
    delete_run: (args: Record<string, unknown>) => {
      if (!args.confirmed) throw new Error("Confirm Run deletion");
      runtime.dispatch({ type: "delete_run", runId: Number(args.runId) });
      return { deleted: true };
    },
  };
}
