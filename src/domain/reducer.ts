import { DomainError } from "./error";
import { defaultPstackRoles, type DomainState } from "./model";
import { cleanMachineTransport } from "./machine-transport";
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
  }
  return { state: next, effects };
}
