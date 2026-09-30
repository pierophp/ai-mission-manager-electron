import { DomainError } from "./error";
import { defaultPstackRoles, type DomainState } from "./model";
import type { Context, ContextAttentionDefault, ContextConfiguration } from "./types";
import type { Decision, Effect, Event } from "./events";

export function decide(state: DomainState, event: Event): Decision {
  const next = structuredClone(state);
  const effects: Effect[] = [];
  const clean = (value: string) => value.trim();
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
        `CLI configuration profile ${profileId} is for ${profile.provider}, not ${provider}`,
      );
    if (machineId === null || profile.machineId !== machineId)
      throw new DomainError(`CLI configuration profile ${profileId} belongs to another Machine`);
  };
  const applyConfiguration = (
    id: number,
    configuration: ContextConfiguration,
    creating = false,
  ) => {
    const value = context(id);
    const name = validateName(configuration.name, id);
    if (value.execution_machine_id !== configuration.executionMachineId) {
      const itemIds = new Set(
        next.projects
          .filter((project) => project.context_id === id)
          .flatMap((project) =>
            next.items.filter((item) => item.project_id === project.id).map((item) => item.id),
          ),
      );
      const activeRunIds = next.runs
        .filter(
          (run) =>
            itemIds.has(run.item_id) &&
            (run.state !== "finished" ||
              (run.execution_profile === "grill" && run.grill_phase !== "finished") ||
              (run.execution_profile === "plan" && run.plan_phase === "awaitingGo")),
        )
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
  }
  return { state: next, effects };
}
