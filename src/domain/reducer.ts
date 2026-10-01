import { DomainError } from "./error";
import { defaultPstackRoles, type DomainState } from "./model";
import { cleanMachineTransport } from "./machine-transport";
import { pathIsWithin } from "./paths";
import type {
  Context,
  ContextAttentionDefault,
  ContextConfiguration,
  Project,
  Repository,
  WorkspaceRepositoryInput,
  Machine,
} from "./types";
import type { Decision, Effect, Event } from "./events";
import {
  planExternalObjectDeletion,
  planItemDeletion,
  planParentDeletion,
  planRepositoryDeletion,
  parentSelectionMatches,
} from "./deletion";

export function decide(state: DomainState, event: Event): Decision {
  const next = structuredClone(state);
  const effects: Effect[] = [];
  const clean = (value: string) => value.trim();
  const debugProvider = (provider: "claude" | "codex") =>
    provider === "claude" ? "Claude" : "Codex";
  const context = (id: number) => {
    const result = next.contexts.find((candidate) => candidate.id === id);
    if (!result) throw new DomainError(`Context ${id} does not exist`);
    return result;
  };
  const validateName = (name: string, exceptId?: number) => {
    const value = clean(name);
    if (!value) throw new DomainError("a Context name cannot be blank");
    if (next.contexts.some((candidate) => candidate.id !== exceptId && candidate.name === value))
      throw new DomainError(`Context name already exists: ${value}`);
    return value;
  };
  const cleanOptional = (value: string | null) => value?.trim() || null;
  const cleanRepositoryName = (name: string) => {
    const value = name.trim();
    if (!value) throw new DomainError("a Repository name cannot be blank");
    if (value === "." || value === ".." || value.includes("/") || value.includes("\\"))
      throw new DomainError("a Repository name must be a single directory name");
    return value;
  };
  const project = (id: number) => {
    const result = next.projects.find((candidate) => candidate.id === id);
    if (!result) throw new DomainError(`Project ${id} does not exist`);
    return result;
  };
  const repository = (id: number) => {
    const result = next.repositories.find((candidate) => candidate.id === id);
    if (!result) throw new DomainError(`Repository ${id} does not exist`);
    return result;
  };
  const normalizeWorkspaceRepositories = (
    projectId: number,
    inputs: WorkspaceRepositoryInput[],
  ) => {
    const normalized: { repositoryId: number; branch: string; baseBranch: string }[] = [];
    for (const input of inputs) {
      const selected = repository(input.repositoryId);
      if (selected.project_id !== projectId)
        throw new DomainError(
          `Repository ${input.repositoryId} belongs to another Project than ${projectId}`,
        );
      if (normalized.some((candidate) => candidate.repositoryId === input.repositoryId))
        throw new DomainError(`Repository ${input.repositoryId} was selected more than once`);
      const branch = input.branch.trim();
      const baseBranch = input.baseBranch.trim();
      if (!branch || !baseBranch) throw new DomainError("a branch cannot be blank");
      normalized.push({ repositoryId: input.repositoryId, branch, baseBranch });
    }
    return normalized;
  };
  const withDefaultProject = (name: string) => {
    const cleanName = validateName(name);
    const id = next.next_context_id;
    const nextContextId = id + 1;
    const projectId = next.next_project_id;
    const nextProjectId = projectId + 1;
    const value: Context = {
      id,
      name: cleanName,
      execution_machine_id: null,
      claude_profile_id: null,
      codex_profile_id: null,
      check_dirty_checkouts: true,
      grill_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      implement_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      default_workflow: "matt-pocock",
      pstack_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      pstack_roles: structuredClone(defaultPstackRoles),
      gh_executable_path: null,
      twg_executable_path: null,
      az_executable_path: null,
      atlassian_site: null,
      azure_devops_organization: null,
      bitbucket_workspace: null,
    };
    const project = {
      id: projectId,
      context_id: id,
      name: "Default",
      defaults: { item_status: "Inbox" as const, execution_mode: "worktree" as const },
    };
    next.next_context_id = nextContextId;
    next.next_project_id = nextProjectId;
    next.contexts.push(value);
    next.projects.push(project);
    effects.push(
      { type: "persist_context", context: value, nextContextId },
      { type: "persist_project", project, nextProjectId },
    );
    return value;
  };
  const validateGrill = (configuration: import("./types").GrillConfiguration) => {
    const validClaude = [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ];
    if (
      !configuration.model.trim() ||
      !configuration.effort.trim() ||
      (configuration.agent === "claude" && !validClaude.includes(configuration.model))
    )
      throw new DomainError(
        `Grill configuration is invalid for ${configuration.agent}: model ${configuration.model}, effort ${configuration.effort}`,
      );
  };
  const validateProfile = (
    profileId: number | null,
    provider: "claude" | "codex",
    machineId: number | null,
  ) => {
    if (profileId === null) return;
    const profile = next.cli_configuration_profiles.find((entry) => entry.id === profileId);
    if (!profile) throw new DomainError(`CLI configuration profile ${profileId} does not exist`);
    if (profile.provider !== provider)
      throw new DomainError(
        `CLI configuration profile ${profileId} is for ${debugProvider(profile.provider)}, not ${debugProvider(provider)}`,
      );
    if (machineId === null || profile.machineId !== machineId)
      throw new DomainError(`CLI configuration profile ${profileId} belongs to another Machine`);
  };
  const contextItemIds = (contextId: number) =>
    new Set(
      next.projects
        .filter((entry) => entry.context_id === contextId)
        .flatMap((entry) =>
          next.items.filter((item) => item.project_id === entry.id).map((item) => item.id),
        ),
    );
  const runIsActive = (run: DomainState["runs"][number]) =>
    run.state !== "finished" ||
    (run.execution_profile === "grill" && run.grill_phase !== "finished") ||
    (run.execution_profile === "plan" && run.plan_phase === "awaitingGo");
  const applyConfiguration = (
    id: number,
    configuration: ContextConfiguration,
    creating = false,
  ) => {
    const value = context(id);
    const name = validateName(configuration.name, id);
    if (value.execution_machine_id !== configuration.executionMachineId) {
      const activeRunIds = next.runs
        .filter((run) => contextItemIds(id).has(run.item_id) && runIsActive(run))
        .map((run) => run.id);
      if (activeRunIds.length)
        throw new DomainError(`Context ${id} has active Runs: [${activeRunIds.join(", ")}]`);
    }
    if (
      configuration.executionMachineId !== null &&
      !next.machines.some((machine) => machine.id === configuration.executionMachineId)
    )
      throw new DomainError(`Machine ${configuration.executionMachineId} does not exist`);
    validateProfile(configuration.claudeProfileId, "claude", configuration.executionMachineId);
    validateProfile(configuration.codexProfileId, "codex", configuration.executionMachineId);
    validateGrill(configuration.grillDefaults);
    validateGrill(configuration.implementDefaults);
    validateGrill(configuration.pstackDefaults);
    if (
      configuration.pstackRoles.length !== 4 ||
      new Set(configuration.pstackRoles.map((entry) => entry.role)).size !== 4
    )
      throw new DomainError("pstack role table must contain each supported role exactly once");
    configuration.pstackRoles.forEach((entry) => validateGrill(entry.configuration));
    if (!creating && configuration.attentionDefaults.some((row) => row.context_id !== id))
      throw new DomainError("Context attention defaults must belong to the configured Context");
    const defaults = configuration.attentionDefaults.map((row) => ({ ...row, context_id: id }));
    const kinds = ["issue", "pull_request", "generic"];
    if (
      defaults.length !== kinds.length ||
      kinds.some((kind) => defaults.filter((row) => row.object_kind === kind).length !== 1)
    )
      throw new DomainError(
        "Context attention defaults must contain one policy for Issue, Pull Request, and generic External Objects",
      );
    value.name = name;
    value.execution_machine_id = configuration.executionMachineId;
    value.claude_profile_id = configuration.claudeProfileId;
    value.codex_profile_id = configuration.codexProfileId;
    value.check_dirty_checkouts = configuration.checkDirtyCheckouts;
    value.grill_defaults = structuredClone(configuration.grillDefaults);
    value.implement_defaults = structuredClone(configuration.implementDefaults);
    value.default_workflow = configuration.defaultWorkflow;
    value.pstack_defaults = structuredClone(configuration.pstackDefaults);
    value.pstack_roles = structuredClone(configuration.pstackRoles);
    value.gh_executable_path = cleanOptional(configuration.ghExecutablePath);
    value.twg_executable_path = cleanOptional(configuration.twgExecutablePath);
    value.az_executable_path = cleanOptional(configuration.azExecutablePath);
    value.atlassian_site = cleanOptional(configuration.atlassianSite);
    value.azure_devops_organization = cleanOptional(configuration.azureDevopsOrganization);
    value.bitbucket_workspace = cleanOptional(configuration.bitbucketWorkspace);
    next.attention_defaults = next.attention_defaults
      .filter((row) => row.context_id !== id || row.object_kind === "document")
      .concat(defaults);
    effects.push({
      type: "persist_context_configuration",
      context: value,
      attentionDefaults: defaults,
    });
  };
  switch (event.type) {
    case "create_context":
      withDefaultProject(event.name);
      break;
    case "complete_setup": {
      const name = event.contextName.trim();
      if (!name) throw new DomainError("A Context name is required to finish setup");
      if (!next.contexts.some((entry) => entry.name === name)) withDefaultProject(name);
      effects.push({ type: "persist_setup", provider: event.provider });
      break;
    }
    case "create_context_configuration": {
      const value = withDefaultProject(event.configuration.name);
      applyConfiguration(value.id, { ...event.configuration, name: value.name }, true);
      break;
    }
    case "update_context": {
      const value = context(event.contextId);
      value.name = validateName(event.name, event.contextId);
      effects.push({ type: "update_context", context: value });
      break;
    }
    case "update_context_configuration":
      applyConfiguration(event.contextId, event.configuration);
      break;
    case "set_context_grill_defaults": {
      const value = context(event.contextId);
      validateGrill(event.defaults);
      value.grill_defaults = structuredClone(event.defaults);
      effects.push({
        type: "persist_context_grill_defaults",
        contextId: event.contextId,
        defaults: structuredClone(event.defaults),
      });
      break;
    }
    case "set_context_implement_defaults": {
      const value = context(event.contextId);
      validateGrill(event.defaults);
      value.implement_defaults = structuredClone(event.defaults);
      effects.push({
        type: "persist_context_implement_defaults",
        contextId: event.contextId,
        defaults: structuredClone(event.defaults),
      });
      break;
    }
    case "set_context_dirty_checkout_check": {
      const value = context(event.contextId);
      value.check_dirty_checkouts = event.enabled;
      effects.push({ type: "update_context", context: value });
      break;
    }
    case "set_context_attention_default": {
      context(event.contextId);
      const row: ContextAttentionDefault = {
        context_id: event.contextId,
        object_kind: event.objectKind,
        policy: structuredClone(event.policy),
      };
      next.attention_defaults = next.attention_defaults
        .filter(
          (candidate) =>
            !(
              candidate.context_id === event.contextId && candidate.object_kind === event.objectKind
            ),
        )
        .concat(row);
      effects.push({ type: "persist_context_attention_default", attentionDefault: row });
      break;
    }
    case "create_project": {
      const name = clean(event.name);
      if (!name) throw new DomainError("a Project name cannot be blank");
      if (!next.contexts.some((candidate) => candidate.id === event.contextId))
        throw new DomainError(`Context ${event.contextId} does not exist`);
      if (
        next.projects.some(
          (candidate) => candidate.context_id === event.contextId && candidate.name === name,
        )
      )
        throw new DomainError(`Project name already exists in Context ${event.contextId}: ${name}`);
      const id = next.next_project_id;
      const nextProjectId = id + 1;
      const value: Project = {
        id,
        context_id: event.contextId,
        name,
        defaults: structuredClone(event.defaults),
      };
      next.next_project_id = nextProjectId;
      next.projects.push(value);
      effects.push({ type: "persist_project", project: value, nextProjectId });
      break;
    }
    case "update_project": {
      const name = clean(event.name);
      if (!name) throw new DomainError("a Project name cannot be blank");
      const current = project(event.projectId);
      if (
        next.projects.some(
          (candidate) =>
            candidate.id !== current.id &&
            candidate.context_id === current.context_id &&
            candidate.name === name,
        )
      )
        throw new DomainError(
          `Project name already exists in Context ${current.context_id}: ${name}`,
        );
      current.name = name;
      current.defaults = structuredClone(event.defaults);
      effects.push({ type: "update_project", project: structuredClone(current) });
      break;
    }
    case "register_repository": {
      const name = cleanRepositoryName(event.name);
      const remoteUrl = event.remoteUrl.trim();
      if (!remoteUrl) throw new DomainError("a Repository remote URL cannot be blank");
      project(event.projectId);
      if (
        next.repositories.some(
          (candidate) => candidate.project_id === event.projectId && candidate.name === name,
        )
      )
        throw new DomainError(
          `Repository name already exists in Project ${event.projectId}: ${name}`,
        );
      const id = next.next_repository_id;
      const nextRepositoryId = id + 1;
      const value: Repository = {
        id,
        project_id: event.projectId,
        name,
        remote_url: remoteUrl,
        base_branch: "main",
      };
      next.next_repository_id = nextRepositoryId;
      next.repositories.push(value);
      effects.push({ type: "persist_repository", repository: value, nextRepositoryId });
      break;
    }
    case "register_repository_at_location": {
      const name = cleanRepositoryName(event.name);
      const remoteUrl = event.remoteUrl.trim();
      const baseBranch = event.baseBranch.trim();
      const checkoutPath = event.checkoutPath.trim();
      const worktreeRoot = event.worktreeRoot.trim();
      if (!remoteUrl) throw new DomainError("a Repository remote URL cannot be blank");
      if (!baseBranch) throw new DomainError("a Repository base branch cannot be blank");
      if (!checkoutPath) throw new DomainError("a Repository checkout path cannot be blank");
      if (!worktreeRoot) throw new DomainError("a Repository Worktree root cannot be blank");
      project(event.projectId);
      // ADR-0014 allows another Context to register a shared execution Machine.
      const machine = next.machines.find((candidate) => candidate.id === event.machineId);
      if (!machine) throw new DomainError(`Machine ${event.machineId} does not exist`);
      let current = next.repositories.find(
        (candidate) => candidate.project_id === event.projectId && candidate.name === name,
      );
      let nextRepositoryId = next.next_repository_id;
      if (current) {
        if (current.remote_url !== remoteUrl)
          throw new DomainError(
            `Repository ${name} in Project ${event.projectId} has a different remote URL`,
          );
        if (
          next.repository_locations.some(
            (location) =>
              location.repository_id === current!.id && location.machine_id === event.machineId,
          )
        )
          throw new DomainError(
            `Repository ${current.id} has already been configured on Machine ${event.machineId}`,
          );
        current = { ...current, base_branch: baseBranch };
        next.repositories = next.repositories.map((candidate) =>
          candidate.id === current!.id ? current! : candidate,
        );
        effects.push({ type: "update_repository", repository: current });
      } else {
        const id = next.next_repository_id;
        nextRepositoryId = id + 1;
        current = {
          id,
          project_id: event.projectId,
          name,
          remote_url: remoteUrl,
          base_branch: baseBranch,
        };
        next.next_repository_id = nextRepositoryId;
        next.repositories.push(current);
        effects.push({ type: "persist_repository", repository: current, nextRepositoryId });
      }
      const location = {
        repository_id: current.id,
        machine_id: event.machineId,
        checkout_path: checkoutPath,
        worktree_root: worktreeRoot,
      };
      next.repository_locations.push(location);
      effects.push({ type: "update_repository_location", previousMachineId: null, location });
      break;
    }
    case "update_repository": {
      const name = cleanRepositoryName(event.name);
      const remoteUrl = event.remoteUrl.trim();
      const baseBranch = event.baseBranch.trim();
      if (!remoteUrl) throw new DomainError("a Repository remote URL cannot be blank");
      if (!baseBranch) throw new DomainError("a Repository base branch cannot be blank");
      const current = repository(event.repositoryId);
      if (
        next.repositories.some(
          (candidate) =>
            candidate.id !== current.id &&
            candidate.project_id === current.project_id &&
            candidate.name === name,
        )
      )
        throw new DomainError(
          `Repository name already exists in Project ${current.project_id}: ${name}`,
        );
      current.name = name;
      current.remote_url = remoteUrl;
      current.base_branch = baseBranch;
      effects.push({ type: "update_repository", repository: structuredClone(current) });
      break;
    }
    case "update_repository_location": {
      const currentRepository = repository(event.repositoryId);
      const currentProject = project(currentRepository.project_id);
      const machine = next.machines.find((candidate) => candidate.id === event.machineId);
      if (!machine) throw new DomainError(`Machine ${event.machineId} does not exist`);
      if (machine.context_id !== currentProject.context_id)
        throw new DomainError(`Machine ${event.machineId} belongs to another Context`);
      if (
        event.previousMachineId !== null &&
        !next.repository_locations.some(
          (location) =>
            location.repository_id === event.repositoryId &&
            location.machine_id === event.previousMachineId,
        )
      )
        throw new DomainError(
          `Repository ${event.repositoryId} has no location on Machine ${event.previousMachineId}`,
        );
      if (
        event.previousMachineId !== event.machineId &&
        next.repository_locations.some(
          (location) =>
            location.repository_id === event.repositoryId &&
            location.machine_id === event.machineId,
        )
      )
        throw new DomainError(
          `Repository ${event.repositoryId} has already been configured on Machine ${event.machineId}`,
        );
      const checkoutPath = event.checkoutPath.trim();
      const worktreeRoot = event.worktreeRoot.trim();
      if (!checkoutPath) throw new DomainError("a Repository checkout path cannot be blank");
      if (!worktreeRoot) throw new DomainError("a Repository Worktree root cannot be blank");
      const location = {
        repository_id: event.repositoryId,
        machine_id: event.machineId,
        checkout_path: checkoutPath,
        worktree_root: worktreeRoot,
      };
      if (event.previousMachineId !== null)
        next.repository_locations = next.repository_locations.filter(
          (candidate) =>
            !(
              candidate.repository_id === event.repositoryId &&
              candidate.machine_id === event.previousMachineId
            ),
        );
      next.repository_locations.push(location);
      effects.push({
        type: "update_repository_location",
        previousMachineId: event.previousMachineId,
        location,
      });
      break;
    }
    case "register_machine": {
      context(event.contextId);
      const name = clean(event.name);
      const socketName = clean(event.socketName);
      if (!name) throw new DomainError("a Machine name cannot be blank");
      if (!socketName) throw new DomainError("a Machine socket name cannot be blank");
      const transport = cleanMachineTransport(event.transport);
      if (next.machines.some((m) => m.context_id === event.contextId && m.name === name))
        throw new DomainError(`Machine name already exists in Context ${event.contextId}: ${name}`);
      const id = next.next_machine_id;
      const machine: Machine = {
        id,
        context_id: event.contextId,
        name,
        socket_name: socketName,
        transport,
        last_observed: "unknown",
        last_observed_at: null,
      };
      next.next_machine_id++;
      next.machines.push(machine);
      effects.push({ type: "persist_machine", machine, nextMachineId: next.next_machine_id });
      break;
    }
    case "update_machine": {
      const current = next.machines.find((m) => m.id === event.machineId);
      if (!current) throw new DomainError(`Machine ${event.machineId} does not exist`);
      const name = clean(event.name);
      const socketName = clean(event.socketName);
      if (!name) throw new DomainError("a Machine name cannot be blank");
      if (!socketName) throw new DomainError("a Machine socket name cannot be blank");
      if (
        next.machines.some(
          (m) => m.id !== current.id && m.context_id === current.context_id && m.name === name,
        )
      )
        throw new DomainError(
          `Machine name already exists in Context ${current.context_id}: ${name}`,
        );
      current.name = name;
      current.socket_name = socketName;
      current.transport = cleanMachineTransport(event.transport);
      effects.push({ type: "update_machine", machine: structuredClone(current) });
      break;
    }
    case "observe_machine": {
      const machine = next.machines.find((m) => m.id === event.machineId);
      if (!machine) throw new DomainError(`Machine ${event.machineId} does not exist`);
      machine.last_observed = event.observation;
      machine.last_observed_at = event.observedAt;
      effects.push({ type: "persist_machine_observation", machine: structuredClone(machine) });
      break;
    }
    case "observe_run": {
      const run = next.runs.find((candidate) => candidate.id === event.runId);
      if (!run) throw new DomainError(`Run ${event.runId} does not exist`);
      const validSequence = event.sequence === null || event.sequence >= 0;
      const acceptsState =
        validSequence &&
        (event.sequence === null
          ? run.last_applied_agent_state_sequence == null
          : run.last_applied_agent_state_sequence == null ||
            event.sequence > run.last_applied_agent_state_sequence);
      if (acceptsState && event.sequence !== null)
        run.last_applied_agent_state_sequence = event.sequence;
      if (acceptsState && run.state !== event.state) {
        run.state = event.state;
        if (run.execution_profile === "plan") {
          if (run.plan_phase === "executing") run.plan_phase = "executing";
          else run.plan_phase = event.state === "finished" ? "awaitingGo" : null;
        }
        if (run.execution_profile === "grill") {
          run.grill_phase =
            event.state === "unknown"
              ? (run.grill_phase ?? "starting")
              : event.state === "working"
                ? "working"
                : event.state === "blocked"
                  ? "waitingForAnswers"
                  : run.grill_question_group && run.grill_response === null
                    ? "waitingForAnswers"
                    : "awaitingNextAction";
        }
      }
      run.pane_status = event.paneStatus;
      effects.push({ type: "persist_run_observation", run: structuredClone(run) });
      if (run.execution_profile === "grill") {
        if (event.paneStatus === "missing" && runIsActive(run)) {
          run.grill_phase = "recoverablePaneLoss";
          effects[effects.length - 1] = {
            type: "persist_run_observation",
            run: structuredClone(run),
          };
        } else if (
          event.paneStatus === "available" &&
          (run.grill_phase === null || run.grill_phase === "recoverablePaneLoss")
        ) {
          run.grill_phase =
            run.state === "unknown"
              ? "starting"
              : run.state === "working"
                ? "working"
                : run.state === "blocked"
                  ? "waitingForAnswers"
                  : run.grill_question_group && run.grill_response === null
                    ? "waitingForAnswers"
                    : "awaitingNextAction";
          effects[effects.length - 1] = {
            type: "persist_run_observation",
            run: structuredClone(run),
          };
        }
      }
      if (event.paneStatus === "missing") {
        const queue = next.implementation_queues.find(
          (candidate) =>
            candidate.active &&
            candidate.entries.some((entry) => entry.runId === run.id && !entry.done),
        );
        if (queue) {
          queue.pausedReason = { kind: "pane_missing" };
          effects.push({ type: "persist_implementation_queue", queue: structuredClone(queue) });
        }
      }
      break;
    }
    case "attach_untracked_run": {
      const item = next.items.find((entry) => entry.id === event.itemId);
      if (!item) throw new DomainError(`Item ${event.itemId} does not exist`);
      const workspace = next.workspaces.find(
        (entry) => entry.id === event.workspaceId && entry.item_id === item.id,
      );
      if (!workspace)
        throw new DomainError(`Workspace ${event.workspaceId} does not exist for Item ${item.id}`);
      const repository = next.repositories.find((entry) => entry.id === event.repositoryId);
      if (!repository) throw new DomainError(`Repository ${event.repositoryId} does not exist`);
      if (repository.project_id !== item.project_id)
        throw new DomainError(
          `Repository ${event.repositoryId} does not belong to Item ${item.id}'s Project`,
        );
      const machine = next.machines.find((entry) => entry.id === event.machineId);
      if (!machine) throw new DomainError(`Machine ${event.machineId} does not exist`);
      const project = next.projects.find((entry) => entry.id === item.project_id);
      const context = project && next.contexts.find((entry) => entry.id === project.context_id);
      if (!context) throw new DomainError(`Context for Item ${item.id} does not exist`);
      if (context.execution_machine_id !== machine.id)
        throw new DomainError(
          `Machine ${machine.id} is not the execution Machine configured for Context ${context.id}`,
        );
      const worktree =
        event.worktreeId == null
          ? null
          : next.worktrees.find((entry) => entry.id === event.worktreeId);
      if (
        event.worktreeId != null &&
        (!worktree ||
          worktree.workspaceId !== workspace.id ||
          worktree.repositoryId !== repository.id ||
          worktree.path !== event.workingDirectory)
      )
        throw new DomainError(`Run working directory does not match Repository ${repository.id}`);
      if (event.worktreeId == null) {
        const location = next.repository_locations.find(
          (entry) => entry.repository_id === repository.id && entry.machine_id === machine.id,
        );
        if (
          !location ||
          !pathIsWithin(location.checkout_path, event.workingDirectory, event.machineHome)
        )
          throw new DomainError(`Run working directory does not match Repository ${repository.id}`);
      }
      if (
        next.runs.some(
          (run) =>
            run.machine_id === machine.id &&
            run.session_name === event.sessionName &&
            run.pane_id === event.paneId,
        )
      )
        throw new DomainError("The suggested agent is already attached to a Run");
      const id = next.next_run_id++;
      const run: import("./execution-types").Run = {
        id,
        item_id: item.id,
        workspace_id: workspace.id,
        repository_id: event.repositoryId,
        worktree_id: event.worktreeId,
        machine_id: machine.id,
        agent: event.agent,
        cli_configuration_profile: null,
        execution_profile: "custom",
        workflow: "matt-pocock",
        model: null,
        effort: null,
        skill_snapshot: null,
        prompt: "Attached existing agent",
        working_directory: event.workingDirectory,
        session_name: event.sessionName,
        pane_id: event.paneId,
        started_at: event.startedAt,
        state: "unknown",
        last_applied_agent_state_sequence: null,
        pane_status: "available",
        direct_checkouts: [],
        transcript: "",
        reported_pull_requests: [],
        attention_summary: null,
        grill_question_group: null,
        grill_answers: [],
        grill_decisions: [],
        grill_response: null,
        grill_phase: null,
        grill_action: null,
        plan_phase: null,
        plan_path: null,
      };
      next.runs.push(run);
      effects.push({ type: "persist_run", run: structuredClone(run), nextRunId: next.next_run_id });
      break;
    }
    case "set_context_execution_machine": {
      const value = context(event.contextId);
      if (event.machineId !== null && !next.machines.some((m) => m.id === event.machineId))
        throw new DomainError(`Machine ${event.machineId} does not exist`);
      if (value.execution_machine_id !== event.machineId) {
        const itemIds = contextItemIds(event.contextId);
        const activeRunIds = next.runs
          .filter((run) => itemIds.has(run.item_id) && runIsActive(run))
          .map((run) => run.id);
        if (activeRunIds.length)
          throw new DomainError(
            `Context ${event.contextId} has active Runs: [${activeRunIds.join(", ")}]`,
          );
      }
      const usesLocalTracker = next.links.some(
        (link) =>
          next.external_objects.some(
            (object) =>
              object.id === link.external_object_id && object.external_key.startsWith("local:"),
          ) &&
          next.items.some(
            (item) =>
              item.id === link.item_id &&
              next.projects.some(
                (p) => p.id === item.project_id && p.context_id === event.contextId,
              ),
          ),
      );
      if (
        usesLocalTracker &&
        (event.machineId === null ||
          next.machines.find((m) => m.id === event.machineId)?.transport.kind !== "local")
      )
        throw new DomainError(
          `local Markdown tracker in Context ${event.contextId} requires a local execution Machine because its files are read from the Repository's main checkout`,
        );
      for (const [provider, profileId] of [
        ["claude", value.claude_profile_id],
        ["codex", value.codex_profile_id],
      ] as const) {
        if (profileId !== null && profileId !== undefined)
          validateProfile(profileId, provider, event.machineId);
      }
      value.execution_machine_id = event.machineId;
      effects.push({ type: "update_context", context: structuredClone(value) });
      break;
    }
    case "create_cli_configuration_profile": {
      const machine = next.machines.find((m) => m.id === event.machineId);
      if (!machine) throw new DomainError(`Machine ${event.machineId} does not exist`);
      const name = clean(event.name);
      const directory = clean(event.directory);
      if (!name) throw new DomainError("CLI configuration profile name cannot be blank");
      if (!directory) throw new DomainError("CLI configuration profile directory cannot be blank");
      if (
        next.cli_configuration_profiles.some(
          (p) =>
            p.machineId === event.machineId && p.provider === event.provider && p.name === name,
        )
      )
        throw new DomainError(
          `CLI configuration profile name already exists on Machine ${event.machineId}: ${name}`,
        );
      const profile = {
        id: next.next_cli_profile_id++,
        machineId: event.machineId,
        provider: event.provider,
        name,
        directory,
        appManaged: event.appManaged,
      };
      next.cli_configuration_profiles.push(profile);
      effects.push({
        type: "persist_cli_configuration_profile",
        profile,
        nextCliProfileId: next.next_cli_profile_id,
      });
      break;
    }
    case "set_context_cli_configuration_profile": {
      const value = context(event.contextId);
      validateProfile(event.profileId, event.provider, value.execution_machine_id ?? null);
      if (event.provider === "claude") value.claude_profile_id = event.profileId;
      else value.codex_profile_id = event.profileId;
      effects.push({ type: "update_context", context: structuredClone(value) });
      break;
    }
    case "delete_cli_configuration_profile": {
      const index = next.cli_configuration_profiles.findIndex((p) => p.id === event.profileId);
      if (index < 0)
        throw new DomainError(`CLI configuration profile ${event.profileId} does not exist`);
      const contexts = next.contexts
        .filter(
          (c) => c.claude_profile_id === event.profileId || c.codex_profile_id === event.profileId,
        )
        .map((c) => c.name);
      if (contexts.length)
        throw new DomainError(
          `CLI configuration profile is selected by Contexts: [${contexts.map((name) => JSON.stringify(name)).join(", ")}]`,
        );
      next.cli_configuration_profiles.splice(index, 1);
      effects.push({ type: "remove_cli_configuration_profile", profileId: event.profileId });
      break;
    }
    case "create_item": {
      if (!event.title.trim()) throw new DomainError("an Item title cannot be blank");
      const owner = context(event.contextId);
      const project = next.projects.find((candidate) => candidate.id === event.projectId);
      if (!project) throw new DomainError(`Project ${event.projectId} does not exist`);
      if (project.context_id !== owner.id)
        throw new DomainError(`Project ${event.projectId} belongs to another Context`);
      const id = next.next_item_id;
      const number = next.next_item_number;
      const nextItemId = id + 1;
      const nextItemNumber = number + 1;
      if (!Number.isSafeInteger(nextItemId) || !Number.isSafeInteger(nextItemNumber))
        throw new DomainError("the Item identifier sequence is exhausted");
      const item = {
        id,
        human_identifier: `I-${number}`,
        title: event.title.trim(),
        project_id: project.id,
        status: project.defaults.item_status,
        notes: event.notes,
        reminders: [],
      };
      next.next_item_id = nextItemId;
      next.next_item_number = nextItemNumber;
      next.items.push(item);
      effects.push({ type: "persist_item", item, nextItemId, nextItemNumber });
      break;
    }
    case "set_item_status":
    case "set_item_title":
    case "set_item_notes": {
      if (
        event.type === "set_item_status" &&
        !["Inbox", "Active", "Waiting", "Done"].includes(event.status)
      ) {
        throw new DomainError(
          `unknown variant \`${String(event.status)}\`, expected one of \`Inbox\`, \`Active\`, \`Waiting\`, \`Done\``,
        );
      }
      const item = next.items.find((candidate) => candidate.id === event.itemId);
      if (!item) throw new DomainError(`Item ${event.itemId} does not exist`);
      if (event.type === "set_item_status") item.status = event.status;
      else if (event.type === "set_item_title") {
        const title = event.title.trim();
        if (!title) throw new DomainError("an Item title cannot be blank");
        item.title = title;
      } else item.notes = event.notes;
      effects.push({ type: "persist_item_update", item: structuredClone(item) });
      break;
    }
    case "add_item_reminder": {
      const item = next.items.find((candidate) => candidate.id === event.itemId);
      if (!item) throw new DomainError(`Item ${event.itemId} does not exist`);
      const remindAt = event.remindAt.trim();
      if (!remindAt) throw new DomainError("a Reminder date cannot be blank");
      const id = next.next_reminder_id;
      const nextReminderId = id + 1;
      if (!Number.isSafeInteger(nextReminderId))
        throw new DomainError("the Item identifier sequence is exhausted");
      item.reminders.push({ id, remind_at: remindAt });
      next.next_reminder_id = nextReminderId;
      effects.push({ type: "persist_item_reminders", item: structuredClone(item), nextReminderId });
      break;
    }
    case "remove_item_reminder": {
      const item = next.items.find((candidate) => candidate.id === event.itemId);
      if (!item) throw new DomainError(`Item ${event.itemId} does not exist`);
      if (!item.reminders.some((reminder) => reminder.id === event.reminderId))
        throw new DomainError(
          `Reminder ${event.reminderId} does not exist on Item ${event.itemId}`,
        );
      item.reminders = item.reminders.filter((reminder) => reminder.id !== event.reminderId);
      effects.push({
        type: "persist_item_reminders",
        item: structuredClone(item),
        nextReminderId: next.next_reminder_id,
      });
      break;
    }
    case "set_item_relation": {
      if (!["Blocks", "BlockedBy", "RelatedTo"].includes(event.kind))
        throw new DomainError(
          `unknown variant \`${String(event.kind)}\`, expected one of \`Blocks\`, \`BlockedBy\` or \`RelatedTo\``,
        );
      if (event.fromItemId === event.toItemId)
        throw new DomainError(`an Item cannot relate to itself: ${event.fromItemId}`);
      const itemContext = (itemId: number) => {
        const item = next.items.find((candidate) => candidate.id === itemId);
        if (!item) throw new DomainError(`Item ${itemId} does not exist`);
        const owner = next.projects.find((candidate) => candidate.id === item.project_id);
        if (!owner) throw new DomainError(`Project ${item.project_id} does not exist`);
        return owner.context_id;
      };
      if (itemContext(event.fromItemId) !== itemContext(event.toItemId))
        throw new DomainError(
          `Items ${event.fromItemId} and ${event.toItemId} belong to different Contexts`,
        );
      const relation = {
        from_item_id: event.fromItemId,
        to_item_id: event.toItemId,
        kind: event.kind,
      };
      if (
        next.relationships.some(
          (entry) =>
            entry.from_item_id === relation.from_item_id &&
            entry.to_item_id === relation.to_item_id &&
            entry.kind === relation.kind,
        )
      )
        throw new DomainError("the relationship already exists");
      next.relationships.push(relation);
      effects.push({ type: "persist_item_relation", relation });
      break;
    }
    case "create_workspace": {
      const item = next.items.find((candidate) => candidate.id === event.itemId);
      if (!item) throw new DomainError(`Item ${event.itemId} does not exist`);
      if (!event.repositories.length)
        throw new DomainError(
          "Project Repository execution setup must include at least one Repository",
        );
      const repositories = normalizeWorkspaceRepositories(item.project_id, event.repositories);
      const id = next.next_workspace_id;
      const nextWorkspaceId = id + 1;
      const workspace = {
        id,
        item_id: event.itemId,
        repositories,
        preparation_state: "pending" as const,
      };
      next.next_workspace_id = nextWorkspaceId;
      next.workspaces.push(workspace);
      effects.push({ type: "persist_workspace", workspace, nextWorkspaceId });
      break;
    }
    case "set_workspace_repositories": {
      const workspace = next.workspaces.find((candidate) => candidate.id === event.workspaceId);
      if (!workspace)
        throw new DomainError(
          `Project Repository execution setup ${event.workspaceId} does not exist`,
        );
      const item = next.items.find((candidate) => candidate.id === workspace.item_id);
      if (!item) throw new DomainError(`Item ${workspace.item_id} does not exist`);
      const repositories = normalizeWorkspaceRepositories(item.project_id, event.repositories);
      if (JSON.stringify(workspace.repositories) === JSON.stringify(repositories)) break;
      workspace.repositories = repositories;
      const projectRepositories = next.repositories.filter(
        (candidate) => candidate.project_id === item.project_id,
      );
      const complete =
        projectRepositories.length > 0 &&
        projectRepositories.every((candidate) =>
          next.worktrees.some(
            (worktree) =>
              worktree.workspaceId === workspace.id && worktree.repositoryId === candidate.id,
          ),
        );
      if (complete) workspace.preparation_state = "ready";
      else if (workspace.preparation_state !== "resumable") workspace.preparation_state = "pending";
      effects.push({ type: "persist_workspace_update", workspace: structuredClone(workspace) });
      break;
    }
    case "create_worktree": {
      const workspace = next.workspaces.find((candidate) => candidate.id === event.workspaceId);
      if (!workspace)
        throw new DomainError(
          `Project Repository execution setup ${event.workspaceId} does not exist`,
        );
      const item = next.items.find((candidate) => candidate.id === workspace.item_id);
      if (!item) throw new DomainError(`Item ${workspace.item_id} does not exist`);
      const repository = next.repositories.find((candidate) => candidate.id === event.repositoryId);
      if (!repository) throw new DomainError(`Repository ${event.repositoryId} does not exist`);
      if (repository.project_id !== item.project_id)
        throw new DomainError(
          `Repository ${event.repositoryId} belongs to another Project than ${item.project_id}`,
        );
      if (
        next.worktrees.some(
          (candidate) =>
            candidate.workspaceId === event.workspaceId &&
            candidate.repositoryId === event.repositoryId,
        )
      )
        throw new DomainError(
          `Repository ${event.repositoryId} already has a registered Worktree for this Item`,
        );
      const machine = next.machines.find((candidate) => candidate.id === event.machineId);
      if (!machine) throw new DomainError(`Machine ${event.machineId} does not exist`);
      const itemProject = next.projects.find((candidate) => candidate.id === item.project_id);
      if (!itemProject) throw new DomainError(`Project ${item.project_id} does not exist`);
      const context = next.contexts.find((candidate) => candidate.id === itemProject.context_id);
      if (!context) throw new DomainError(`Context ${itemProject.context_id} does not exist`);
      if (context.execution_machine_id == null)
        throw new DomainError(`Context ${context.id} has no execution Machine configured`);
      if (context.execution_machine_id !== event.machineId)
        throw new DomainError(
          `Machine ${event.machineId} is not the execution Machine configured for Context ${context.id}`,
        );
      const cleanPath = event.path.trim();
      const branch = event.branch.trim();
      const baseBranch = event.baseBranch.trim();
      if (!cleanPath) throw new DomainError("a Worktree path cannot be blank");
      if (!branch) throw new DomainError("a branch cannot be blank");
      if (!baseBranch) throw new DomainError("a base branch cannot be blank");
      const worktree = {
        id: next.next_worktree_id,
        workspaceId: event.workspaceId,
        repositoryId: event.repositoryId,
        machineId: event.machineId,
        path: cleanPath,
        branch,
        baseBranch,
        isDirty: event.isDirty,
      };
      next.next_worktree_id += 1;
      next.worktrees.push(worktree);
      const allRepositoriesPrepared = next.repositories
        .filter((candidate) => candidate.project_id === item.project_id)
        .every((candidate) =>
          next.worktrees.some(
            (candidateWorktree) =>
              candidateWorktree.workspaceId === event.workspaceId &&
              candidateWorktree.repositoryId === candidate.id,
          ),
        );
      if (
        allRepositoriesPrepared &&
        next.repositories.some((candidate) => candidate.project_id === item.project_id)
      )
        workspace.preparation_state = "ready";
      effects.push({ type: "persist_worktree", worktree, nextWorktreeId: next.next_worktree_id });
      if (workspace.preparation_state === "ready")
        effects.push({ type: "persist_workspace_update", workspace: structuredClone(workspace) });
      break;
    }
    case "mark_workspace_resumable": {
      const workspace = next.workspaces.find((candidate) => candidate.id === event.workspaceId);
      if (!workspace)
        throw new DomainError(
          `Project Repository execution setup ${event.workspaceId} does not exist`,
        );
      workspace.preparation_state = "resumable";
      effects.push({ type: "persist_workspace_update", workspace: structuredClone(workspace) });
      break;
    }
    case "link_external_object": {
      const item = next.items.find((candidate) => candidate.id === event.itemId);
      if (!item) throw new DomainError(`Item ${event.itemId} does not exist`);
      if (!event.object.canonical_url.trim())
        throw new DomainError("an external URL cannot be blank");
      if (!event.object.external_key.trim())
        throw new DomainError("an external object key cannot be blank");
      const existing = next.external_objects.find(
        (candidate) =>
          candidate.provider === event.object.provider &&
          candidate.external_key === event.object.external_key,
      );
      const object = existing ?? {
        ...event.object,
        canonical_url: event.object.canonical_url.trim(),
        id: next.next_external_object_id,
      };
      if (!existing) {
        next.next_external_object_id += 1;
        next.external_objects.push(object);
        effects.push({
          type: "persist_external_object",
          object,
          nextExternalObjectId: next.next_external_object_id,
        });
      }
      if (
        next.links.some((link) => link.item_id === item.id && link.external_object_id === object.id)
      )
        throw new DomainError("the Link already exists");
      const link = {
        id: next.next_link_id++,
        item_id: item.id,
        external_object_id: object.id,
        reviewed_activity_id: next.activities
          .filter((activity) => activity.external_object_id === object.id)
          .reduce((id, activity) => Math.max(id, activity.id), 0),
        attention_policy: null,
        watch_until: null,
        review_at: null,
        purpose: "others" as const,
        spec_external_object_id: null,
        provenance: null,
      };
      next.links.push(link);
      effects.push({
        type: "persist_external_link",
        link: structuredClone(link),
        nextLinkId: next.next_link_id,
      });
      if (event.snapshot) {
        const snapshot = { external_object_id: object.id, ...event.snapshot };
        const index = next.snapshots.findIndex((entry) => entry.external_object_id === object.id);
        if (index < 0 || JSON.stringify(next.snapshots[index]) !== JSON.stringify(snapshot)) {
          if (index < 0) next.snapshots.push(snapshot);
          else next.snapshots[index] = snapshot;
          effects.push({ type: "persist_external_snapshot", snapshot });
        }
      }
      break;
    }
    case "refresh_external_object": {
      if (!next.external_objects.some((object) => object.id === event.externalObjectId))
        throw new DomainError(`External Object ${event.externalObjectId} does not exist`);
      const snapshot = { external_object_id: event.externalObjectId, ...event.snapshot };
      const previous = next.snapshots.find(
        (entry) => entry.external_object_id === event.externalObjectId,
      );
      const changes = previous ? snapshotChanges(previous, snapshot) : [];
      if (changes.length) {
        const activity = {
          id: next.next_activity_id++,
          external_object_id: event.externalObjectId,
          observed_at: snapshot.fetched_at,
          changes,
        };
        next.activities.push(activity);
        effects.push({ type: "persist_activity", activity, nextActivityId: next.next_activity_id });
      }
      const index = next.snapshots.findIndex(
        (entry) => entry.external_object_id === event.externalObjectId,
      );
      if (index < 0) next.snapshots.push(snapshot);
      else next.snapshots[index] = snapshot;
      effects.push({ type: "persist_external_snapshot", snapshot });
      break;
    }
    case "set_link_purpose": {
      const link = next.links.find((candidate) => candidate.id === event.linkId);
      if (!link) throw new DomainError(`Link ${event.linkId} does not exist`);
      const object = next.external_objects.find(
        (candidate) => candidate.id === link.external_object_id,
      );
      if (!object)
        throw new DomainError(`External Object ${link.external_object_id} does not exist`);
      const isLocal = object.provider === "generic" && object.external_key.startsWith("local:");
      const supportsSpec =
        isLocal ||
        (object.provider === "github" && object.kind === "issue") ||
        (object.provider === "atlassian" && ["issue", "document"].includes(object.kind));
      const supportsTicket =
        isLocal ||
        (object.provider === "github" && object.kind === "issue") ||
        (object.provider === "atlassian" && object.kind === "issue");
      if (event.purpose === "to-spec" && !supportsSpec)
        throw new DomainError("This External Object cannot have the Spec Link purpose");
      if (event.purpose === "to-tickets") {
        if (!supportsTicket)
          throw new DomainError("This External Object cannot have the Tickets Link purpose");
        if (event.specExternalObjectId !== null) {
          const specLink = next.links.find(
            (candidate) =>
              candidate.item_id === link.item_id &&
              candidate.external_object_id === event.specExternalObjectId &&
              candidate.external_object_id !== link.external_object_id &&
              candidate.purpose === "to-spec",
          );
          const specObject = next.external_objects.find(
            (candidate) =>
              candidate.id === event.specExternalObjectId &&
              ((candidate.provider === "generic" && candidate.external_key.startsWith("local:")) ||
                (candidate.provider === "github" && candidate.kind === "issue") ||
                (candidate.provider === "atlassian" && candidate.kind === "document")),
          );
          if (!specLink || !specObject)
            throw new DomainError("A ticket must reference a supported Spec on the same Item");
        }
      }
      const previousSpecId = link.external_object_id;
      link.purpose = event.purpose;
      link.spec_external_object_id =
        event.purpose === "to-tickets" ? event.specExternalObjectId : null;
      effects.push({ type: "persist_link_state", link: structuredClone(link) });
      if (event.purpose !== "to-spec") {
        for (const ticketLink of next.links) {
          if (
            ticketLink.item_id === link.item_id &&
            ticketLink.purpose === "to-tickets" &&
            ticketLink.spec_external_object_id === previousSpecId
          ) {
            ticketLink.spec_external_object_id = null;
            effects.push({ type: "persist_link_state", link: structuredClone(ticketLink) });
          }
        }
      }
      break;
    }
    case "set_link_watch_until": {
      const link = next.links.find((candidate) => candidate.id === event.linkId);
      if (!link) throw new DomainError(`Link ${event.linkId} does not exist`);
      link.watch_until = event.watchUntil;
      effects.push({ type: "persist_link_state", link: structuredClone(link) });
      break;
    }
    case "set_link_review_at": {
      const link = next.links.find((candidate) => candidate.id === event.linkId);
      if (!link) throw new DomainError(`Link ${event.linkId} does not exist`);
      link.review_at = event.reviewAt;
      effects.push({ type: "persist_link_state", link: structuredClone(link) });
      break;
    }
    case "clear_link_review_at": {
      const link = next.links.find((candidate) => candidate.id === event.linkId);
      if (!link) throw new DomainError(`Link ${event.linkId} does not exist`);
      link.review_at = null;
      effects.push({ type: "persist_link_state", link: structuredClone(link) });
      break;
    }
    case "set_link_attention_policy": {
      const link = next.links.find((candidate) => candidate.id === event.linkId);
      if (!link) throw new DomainError(`Link ${event.linkId} does not exist`);
      link.attention_policy = event.policy;
      effects.push({ type: "persist_link_state", link: structuredClone(link) });
      break;
    }
    case "mark_link_reviewed": {
      const link = next.links.find((candidate) => candidate.id === event.linkId);
      if (!link) throw new DomainError(`Link ${event.linkId} does not exist`);
      link.reviewed_activity_id = next.activities
        .filter((activity) => activity.external_object_id === link.external_object_id)
        .reduce((id, activity) => Math.max(id, activity.id), link.reviewed_activity_id);
      effects.push({ type: "persist_link_state", link: structuredClone(link) });
      break;
    }
    case "delete_repository": {
      const plan = planRepositoryDeletion(next, event.repositoryId);
      if (
        !parentSelectionMatches(
          plan.workspaces.map((entry) => entry.id),
          event.workspaceIds,
        )
      )
        throw new DomainError(
          `Repository ${event.repositoryId} Workspaces do not match the deletion preview`,
        );
      const run = next.runs.find(
        (candidate) =>
          candidate.repository_id === event.repositoryId ||
          candidate.direct_checkouts.some(
            (checkout) => checkout.repositoryId === event.repositoryId,
          ) ||
          (candidate.worktree_id !== null &&
            next.worktrees.some(
              (tree) =>
                tree.id === candidate.worktree_id && tree.repositoryId === event.repositoryId,
            )),
      );
      if (run) throw new DomainError(`Repository ${event.repositoryId} is used by Run ${run.id}`);
      next.repositories = next.repositories.filter((entry) => entry.id !== event.repositoryId);
      next.repository_locations = next.repository_locations.filter(
        (entry) => entry.repository_id !== event.repositoryId,
      );
      const affectedIds = plan.workspaces.map((entry) => entry.id);
      const removedWorktreeIds = next.worktrees
        .filter(
          (entry) =>
            affectedIds.includes(entry.workspaceId) && entry.repositoryId === event.repositoryId,
        )
        .map(({ id }) => id);
      next.worktrees = next.worktrees.filter(
        (entry) =>
          !(affectedIds.includes(entry.workspaceId) && entry.repositoryId === event.repositoryId),
      );
      next.workspaces = next.workspaces.map((workspace) => {
        if (!affectedIds.includes(workspace.id)) return workspace;
        const repositories = workspace.repositories.filter(
          (entry) => entry.repositoryId !== event.repositoryId,
        );
        const projectId = next.items.find((item) => item.id === workspace.item_id)?.project_id;
        const required = next.repositories.filter(
          (repository) => repository.project_id === projectId,
        );
        const complete =
          required.length > 0 &&
          required.every((repository) =>
            next.worktrees.some(
              (tree) => tree.workspaceId === workspace.id && tree.repositoryId === repository.id,
            ),
          );
        const preparation_state: typeof workspace.preparation_state = complete
          ? "ready"
          : workspace.preparation_state === "resumable"
            ? "resumable"
            : "pending";
        return { ...workspace, repositories, preparation_state };
      });
      effects.push(
        ...removedWorktreeIds.map((worktreeId) => ({
          type: "remove_worktree" as const,
          worktreeId,
        })),
      );
      for (const workspace of next.workspaces.filter((entry) => affectedIds.includes(entry.id)))
        effects.push({ type: "persist_workspace_update", workspace: structuredClone(workspace) });
      effects.push({ type: "remove_repository", repositoryId: event.repositoryId });
      break;
    }
    case "delete_item": {
      const plan = planItemDeletion(next, event.itemId);
      if (plan.activeRunIds.length)
        throw new DomainError(
          `Item deletion is blocked:\n${plan.activeRunIds.map((id) => `Run #${id} is active; stop it before deleting this Item.`).join("\n")}`,
        );
      const orphaned = plan.orphanedExternalObjectIds;
      next.items = next.items.filter((entry) => entry.id !== event.itemId);
      const workspaceIds = plan.workspaces.map((entry) => entry.id);
      next.workspaces = next.workspaces.filter((entry) => !workspaceIds.includes(entry.id));
      next.worktrees = next.worktrees.filter((entry) => !workspaceIds.includes(entry.workspaceId));
      next.runs = next.runs.filter((entry) => entry.item_id !== event.itemId);
      next.relationships = next.relationships.filter(
        (entry) => entry.from_item_id !== event.itemId && entry.to_item_id !== event.itemId,
      );
      next.links = next.links.filter((entry) => entry.item_id !== event.itemId);
      next.external_objects = next.external_objects.filter((entry) => !orphaned.includes(entry.id));
      next.snapshots = next.snapshots.filter(
        (entry) => !orphaned.includes(entry.external_object_id),
      );
      next.activities = next.activities.filter(
        (entry) => !orphaned.includes(entry.external_object_id),
      );
      effects.push({
        type: "remove_item_cascade",
        itemId: event.itemId,
        orphanedExternalObjectIds: orphaned,
      });
      break;
    }
    case "delete_project": {
      const plan = planParentDeletion(next, null, event.projectId);
      if (
        !parentSelectionMatches(
          plan.items.map((entry) => entry.id),
          event.itemIds,
        ) ||
        !parentSelectionMatches(
          plan.repositories.map((entry) => entry.id),
          event.repositoryIds,
        ) ||
        !parentSelectionMatches(
          plan.workspaces.map((entry) => entry.id),
          event.workspaceIds,
        )
      )
        throw new DomainError(`Project ${event.projectId} deletion plan does not match`);
      if (plan.activeRunIds.length)
        throw new DomainError(
          `Project deletion is blocked:\n${plan.activeRunIds.map((id) => `Run #${id} is active; stop it before deleting this Project.`).join("\n")}`,
        );
      const itemIds = plan.items.map((entry) => entry.id);
      const workspaceIds = plan.workspaces.map((entry) => entry.id);
      const repositoryIds = plan.repositories.map((entry) => entry.id);
      const orphaned = plan.orphanedExternalObjectIds;
      next.items = next.items.filter((entry) => !itemIds.includes(entry.id));
      next.workspaces = next.workspaces.filter((entry) => !workspaceIds.includes(entry.id));
      next.worktrees = next.worktrees.filter((entry) => !workspaceIds.includes(entry.workspaceId));
      next.runs = next.runs.filter((entry) => !itemIds.includes(entry.item_id));
      next.relationships = next.relationships.filter(
        (entry) => !itemIds.includes(entry.from_item_id) && !itemIds.includes(entry.to_item_id),
      );
      next.links = next.links.filter((entry) => !itemIds.includes(entry.item_id));
      next.external_objects = next.external_objects.filter((entry) => !orphaned.includes(entry.id));
      next.snapshots = next.snapshots.filter(
        (entry) => !orphaned.includes(entry.external_object_id),
      );
      next.activities = next.activities.filter(
        (entry) => !orphaned.includes(entry.external_object_id),
      );
      next.repositories = next.repositories.filter((entry) => !repositoryIds.includes(entry.id));
      next.repository_locations = next.repository_locations.filter(
        (entry) => !repositoryIds.includes(entry.repository_id),
      );
      next.projects = next.projects.filter((entry) => entry.id !== event.projectId);
      effects.push({
        type: "remove_project_cascade",
        projectId: event.projectId,
        orphanedExternalObjectIds: orphaned,
      });
      break;
    }
    case "delete_context": {
      const plan = planParentDeletion(next, event.contextId, null);
      if (next.contexts.length === 1) throw new DomainError("Cannot delete the last Context");
      if (
        !parentSelectionMatches(
          plan.projects.map((entry) => entry.id),
          event.projectIds,
        ) ||
        !parentSelectionMatches(
          plan.items.map((entry) => entry.id),
          event.itemIds,
        ) ||
        !parentSelectionMatches(
          plan.repositories.map((entry) => entry.id),
          event.repositoryIds,
        ) ||
        !parentSelectionMatches(
          plan.workspaces.map((entry) => entry.id),
          event.workspaceIds,
        ) ||
        !parentSelectionMatches(
          plan.machines.map((entry) => entry.id),
          event.machineIds,
        )
      )
        throw new DomainError(`Context ${event.contextId} deletion plan does not match`);
      if (plan.activeRunIds.length)
        throw new DomainError(
          `Context deletion is blocked:\n${plan.activeRunIds.map((id) => `Run #${id} is active; stop it before deleting this Context.`).join("\n")}`,
        );
      const projectIds = plan.projects.map((entry) => entry.id);
      const itemIds = plan.items.map((entry) => entry.id);
      const repositoryIds = plan.repositories.map((entry) => entry.id);
      const workspaceIds = plan.workspaces.map((entry) => entry.id);
      const machineIds = plan.machines.map((entry) => entry.id);
      const orphaned = plan.orphanedExternalObjectIds;
      const contextsUsingDeletedMachines = next.contexts
        .filter(
          (entry) =>
            entry.id !== event.contextId &&
            typeof entry.execution_machine_id === "number" &&
            machineIds.includes(entry.execution_machine_id),
        )
        .map((entry) => ({
          ...entry,
          execution_machine_id: null,
          claude_profile_id: null,
          codex_profile_id: null,
        }));
      next.contexts = next.contexts.map(
        (entry) => contextsUsingDeletedMachines.find((updated) => updated.id === entry.id) ?? entry,
      );
      next.contexts = next.contexts.filter((entry) => entry.id !== event.contextId);
      next.projects = next.projects.filter((entry) => !projectIds.includes(entry.id));
      next.items = next.items.filter((entry) => !itemIds.includes(entry.id));
      next.repositories = next.repositories.filter((entry) => !repositoryIds.includes(entry.id));
      next.repository_locations = next.repository_locations.filter(
        (entry) => !repositoryIds.includes(entry.repository_id),
      );
      next.workspaces = next.workspaces.filter((entry) => !workspaceIds.includes(entry.id));
      next.worktrees = next.worktrees.filter((entry) => !workspaceIds.includes(entry.workspaceId));
      next.runs = next.runs.filter((entry) => !plan.runs.some((run) => run.id === entry.id));
      next.machines = next.machines.filter((entry) => !machineIds.includes(entry.id));
      next.cli_configuration_profiles = next.cli_configuration_profiles.filter(
        (entry) => !machineIds.includes(entry.machineId),
      );
      next.relationships = next.relationships.filter(
        (entry) => !itemIds.includes(entry.from_item_id) && !itemIds.includes(entry.to_item_id),
      );
      next.links = next.links.filter((entry) => !itemIds.includes(entry.item_id));
      next.external_objects = next.external_objects.filter((entry) => !orphaned.includes(entry.id));
      next.snapshots = next.snapshots.filter(
        (entry) => !orphaned.includes(entry.external_object_id),
      );
      next.activities = next.activities.filter(
        (entry) => !orphaned.includes(entry.external_object_id),
      );
      next.attention_defaults = next.attention_defaults.filter(
        (entry) => entry.context_id !== event.contextId,
      );
      effects.push(
        ...contextsUsingDeletedMachines.map((context) => ({
          type: "update_context" as const,
          context: structuredClone(context),
        })),
        {
          type: "remove_context_cascade",
          contextId: event.contextId,
          orphanedExternalObjectIds: orphaned,
        },
      );
      break;
    }
    case "delete_external_object": {
      planExternalObjectDeletion(next, event.externalObjectId);
      next.links = next.links.filter(
        (entry) => entry.external_object_id !== event.externalObjectId,
      );
      next.external_objects = next.external_objects.filter(
        (entry) => entry.id !== event.externalObjectId,
      );
      next.snapshots = next.snapshots.filter(
        (entry) => entry.external_object_id !== event.externalObjectId,
      );
      next.activities = next.activities.filter(
        (entry) => entry.external_object_id !== event.externalObjectId,
      );
      effects.push({ type: "remove_external_object", externalObjectId: event.externalObjectId });
      break;
    }
    case "delete_link": {
      const link = next.links.find((entry) => entry.id === event.linkId);
      if (!link) throw new DomainError(`Link ${event.linkId} does not exist`);
      const externalObjectId = link.external_object_id;
      const detached =
        link.purpose === "to-spec"
          ? next.links
              .filter(
                (entry) =>
                  entry.item_id === link.item_id &&
                  entry.spec_external_object_id === externalObjectId &&
                  entry.id !== link.id,
              )
              .map((entry) => {
                entry.spec_external_object_id = null;
                return structuredClone(entry);
              })
          : [];
      next.links = next.links.filter((entry) => entry.id !== event.linkId);
      const orphaned = !next.links.some((entry) => entry.external_object_id === externalObjectId);
      if (orphaned) {
        next.external_objects = next.external_objects.filter(
          (entry) => entry.id !== externalObjectId,
        );
        next.snapshots = next.snapshots.filter(
          (entry) => entry.external_object_id !== externalObjectId,
        );
        next.activities = next.activities.filter(
          (entry) => entry.external_object_id !== externalObjectId,
        );
      }
      effects.push(
        ...detached.map((entry) => ({ type: "persist_link_state" as const, link: entry })),
        { type: "remove_link", linkId: event.linkId, externalObjectId },
      );
      if (orphaned) effects.push({ type: "remove_external_object", externalObjectId });
      break;
    }
    case "remove_worktree": {
      const worktree = next.worktrees.find((entry) => entry.id === event.worktreeId);
      if (!worktree) throw new DomainError(`Worktree ${event.worktreeId} does not exist`);
      next.worktrees = next.worktrees.filter((entry) => entry.id !== event.worktreeId);
      const workspace = next.workspaces.find((entry) => entry.id === worktree.workspaceId);
      if (!workspace) throw new DomainError(`Workspace ${worktree.workspaceId} does not exist`);
      const itemProjectId = next.items.find((entry) => entry.id === workspace.item_id)?.project_id;
      const repositories = next.repositories.filter((entry) => entry.project_id === itemProjectId);
      const complete =
        repositories.length > 0 &&
        repositories.every((repository) =>
          next.worktrees.some(
            (entry) => entry.workspaceId === workspace.id && entry.repositoryId === repository.id,
          ),
        );
      const preparation_state: typeof workspace.preparation_state = complete
        ? "ready"
        : workspace.preparation_state === "resumable"
          ? "resumable"
          : "pending";
      const updated = { ...workspace, preparation_state };
      next.workspaces = next.workspaces.map((entry) => (entry.id === updated.id ? updated : entry));
      effects.push(
        { type: "remove_worktree", worktreeId: event.worktreeId },
        { type: "persist_workspace_update", workspace: updated },
      );
      break;
    }
    case "reset_local_data": {
      const active = next.runs.filter(runIsActive).map(({ id }) => id);
      if (active.length) throw new DomainError(`Reset has active Runs: [${active.join(", ")}]`);
      const contextId = next.next_context_id;
      const nextContextId = contextId + 1;
      const projectId = next.next_project_id;
      const nextProjectId = projectId + 1;
      const context: Context = {
        id: contextId,
        name: "Personal",
        execution_machine_id: null,
        claude_profile_id: null,
        codex_profile_id: null,
        check_dirty_checkouts: true,
        grill_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
        implement_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
        default_workflow: "matt-pocock",
        pstack_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
        pstack_roles: structuredClone(defaultPstackRoles),
        gh_executable_path: null,
        twg_executable_path: null,
        az_executable_path: null,
        atlassian_site: null,
        azure_devops_organization: null,
        bitbucket_workspace: null,
      };
      const project: Project = {
        id: projectId,
        context_id: contextId,
        name: "Default",
        defaults: { item_status: "Inbox", execution_mode: "worktree" },
      };
      Object.assign(next, {
        next_context_id: nextContextId,
        next_project_id: nextProjectId,
        contexts: [context],
        projects: [project],
        repositories: [],
        repository_locations: [],
        items: [],
        workspaces: [],
        worktrees: [],
        machines: [],
        cli_configuration_profiles: [],
        runs: [],
        implementation_queues: [],
        relationships: [],
        external_objects: [],
        links: [],
        snapshots: [],
        activities: [],
        attention_defaults: [],
      });
      effects.push({ type: "reset_local_data", context, project, nextContextId, nextProjectId });
      break;
    }
  }
  return { state: next, effects };
}

function snapshotChanges(
  previous: import("./types").ExternalSnapshot,
  current: import("./types").ExternalSnapshot,
): import("./types").ExternalChange[] {
  const changes: import("./types").ExternalChange[] = [];
  if (previous.title !== current.title)
    changes.push({ kind: "title", key: null, previous: previous.title, current: current.title });
  if (previous.state !== current.state)
    changes.push({ kind: "state", key: null, previous: previous.state, current: current.state });
  const keys = [
    ...new Set([
      ...previous.metadata.map((entry) => entry.key),
      ...current.metadata.map((entry) => entry.key),
    ]),
  ].sort();
  for (const key of keys) {
    const before = previous.metadata.find((entry) => entry.key === key)?.value ?? null;
    const after = current.metadata.find((entry) => entry.key === key)?.value ?? null;
    if (before !== after) changes.push({ kind: "metadata", key, previous: before, current: after });
  }
  return changes;
}
