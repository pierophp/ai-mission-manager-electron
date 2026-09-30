import type { Runtime } from "./runtime";
import type { Event } from "../domain/events";
import type {
  ContextConfiguration,
  ExecutionMode,
  ExternalChangePolicy,
  ExternalObjectKind,
  GrillConfiguration,
  ItemStatus,
  Project,
  Repository,
  RepositoryLocation,
  Machine,
  MachineTransport,
  AgentKind,
  MachineReadiness,
  CliProfileSettingsView,
} from "../domain/types";
import { LocalSshMachineAccess, type MachineAccess } from "./machine-access";
import type { SqliteStore } from "./persistence/sqlite-store";
import { decide } from "../domain/state-transition";
import { GitCli } from "./git";
import { normalizeMachinePath, resolveMachinePath } from "./machine-path";

function repositoryRegistrationContents(state: ReturnType<Runtime["snapshot"]>, projectId: number) {
  const repositories = state.repositories
    .filter((repository) => repository.project_id === projectId)
    .sort((left, right) => left.id - right.id);
  const repositoryIds = new Set(repositories.map((repository) => repository.id));
  const locations = state.repository_locations
    .filter((location) => repositoryIds.has(location.repository_id))
    .sort(
      (left, right) =>
        left.repository_id - right.repository_id || left.machine_id - right.machine_id,
    );
  return { repositories, locations };
}

export function createStructureCommandHandlers(
  runtime: Runtime,
  machineAccess: MachineAccess = new LocalSshMachineAccess(),
  store?: SqliteStore,
) {
  const machineCheckGenerations = new Map<number, number>();
  let profileCreationQueue: Promise<void> = Promise.resolve();
  const serializeProfileCreation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = profileCreationQueue.then(operation, operation);
    profileCreationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const dispatchAndSelectContext = (event: Event, contextId?: number) => {
    const state = runtime.dispatch(event);
    return state.contexts.find((entry) => entry.id === contextId) ?? state.contexts.at(-1);
  };
  const dispatchConfiguration = (configuration: ContextConfiguration, contextId?: number) => {
    const isCreate = contextId === undefined;
    const actualId = contextId ?? runtime.snapshot().next_context_id;
    const documentDefault = configuration.attentionDefaults.find(
      (entry) => entry.object_kind === "document",
    );
    const coreConfiguration = {
      ...configuration,
      attentionDefaults: configuration.attentionDefaults.filter(
        (entry) => entry.object_kind !== "document",
      ),
    };
    const events: Event[] = [
      isCreate
        ? { type: "create_context_configuration", configuration: coreConfiguration }
        : {
            type: "update_context_configuration",
            contextId: actualId,
            configuration: coreConfiguration,
          },
    ];
    if (documentDefault)
      events.push({
        type: "set_context_attention_default",
        contextId: actualId,
        objectKind: "document",
        policy: documentDefault.policy,
      });
    const state = runtime.dispatchMany(events);
    return state.contexts.find((entry) => entry.id === actualId);
  };
  const defaults = (args: Record<string, unknown>) => ({
    item_status: String(args.defaultItemStatus ?? "Inbox") as ItemStatus,
    execution_mode: (args.executionMode ?? "worktree") as ExecutionMode,
  });
  const dispatchAndSelectProject = (event: Event, projectId: number) =>
    runtime.dispatch(event).projects.find((entry) => entry.id === projectId);
  const dispatchAndSelectRepository = (event: Event, repositoryId: number) =>
    runtime.dispatch(event).repositories.find((entry) => entry.id === repositoryId);
  return {
    create_context: (args: Record<string, unknown>) =>
      dispatchAndSelectContext({ type: "create_context", name: String(args.name ?? "") }),
    create_context_configuration: (args: Record<string, unknown>) =>
      dispatchConfiguration(args.configuration as ContextConfiguration),
    update_context: (args: Record<string, unknown>) =>
      dispatchAndSelectContext(
        {
          type: "update_context",
          contextId: Number(args.contextId),
          name: String(args.name ?? ""),
        },
        Number(args.contextId),
      ),
    update_context_configuration: (args: Record<string, unknown>) =>
      dispatchConfiguration(args.configuration as ContextConfiguration, Number(args.contextId)),
    set_context_grill_defaults: (args: Record<string, unknown>) =>
      dispatchAndSelectContext(
        {
          type: "set_context_grill_defaults",
          contextId: Number(args.contextId),
          defaults: args.defaults as GrillConfiguration,
        },
        Number(args.contextId),
      ),
    set_context_implement_defaults: (args: Record<string, unknown>) =>
      dispatchAndSelectContext(
        {
          type: "set_context_implement_defaults",
          contextId: Number(args.contextId),
          defaults: args.defaults as GrillConfiguration,
        },
        Number(args.contextId),
      ),
    set_context_dirty_checkout_check: (args: Record<string, unknown>) =>
      dispatchAndSelectContext(
        {
          type: "set_context_dirty_checkout_check",
          contextId: Number(args.contextId),
          enabled: Boolean(args.enabled),
        },
        Number(args.contextId),
      ),
    set_context_attention_default: (args: Record<string, unknown>) => {
      const state = runtime.dispatch({
        type: "set_context_attention_default",
        contextId: Number(args.contextId),
        objectKind: args.objectKind as ExternalObjectKind,
        policy: args.policy as ExternalChangePolicy,
      });
      return state.attention_defaults.find(
        (row) => row.context_id === Number(args.contextId) && row.object_kind === args.objectKind,
      );
    },
    create_project: (args: Record<string, unknown>): Project | undefined =>
      dispatchAndSelectProject(
        {
          type: "create_project",
          contextId: Number(args.contextId),
          name: String(args.name ?? ""),
          defaults: defaults(args),
        },
        runtime.snapshot().next_project_id,
      ),
    update_project: (args: Record<string, unknown>) =>
      dispatchAndSelectProject(
        {
          type: "update_project",
          projectId: Number(args.projectId),
          name: String(args.name ?? ""),
          defaults: defaults(args),
        },
        Number(args.projectId),
      ),
    register_repository: (args: Record<string, unknown>): Repository | undefined =>
      dispatchAndSelectRepository(
        {
          type: "register_repository",
          projectId: Number(args.projectId),
          name: String(args.name ?? ""),
          remoteUrl: String(args.remoteUrl ?? ""),
        },
        runtime.snapshot().next_repository_id,
      ),
    register_repository_at_location: async (args: Record<string, unknown>): Promise<Repository> => {
      const state = runtime.snapshot();
      const projectId = Number(args.projectId);
      const machineId = Number(args.machineId);
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Project ${projectId} does not exist`);
      const machine = state.machines.find((candidate) => candidate.id === machineId);
      if (!machine) throw new Error(`Machine ${machineId} does not exist`);
      const registrationContents = repositoryRegistrationContents(state, projectId);
      const machineHome = await machineAccess.machineHome(machine);
      const normalizedCheckoutPath = normalizeMachinePath(
        String(args.checkoutPath ?? ""),
        machineHome,
      );
      const checkoutPath = resolveMachinePath(normalizedCheckoutPath, machineHome);
      const rawWorktreeRoot = String(args.worktreeRoot ?? "").trim() || "~/worktrees";
      const normalizedWorktreeRoot = normalizeMachinePath(rawWorktreeRoot, machineHome);
      const clone = Boolean(args.cloneIntoDestination);
      const expectedRemote = args.remoteUrl == null ? null : String(args.remoteUrl);
      if (clone && !expectedRemote?.trim())
        throw new Error("A remote URL is required when cloning a Repository");
      const git = new GitCli(machineAccess);
      let inspection;
      if (clone) inspection = await git.cloneRepository(machine, expectedRemote!, checkoutPath);
      else inspection = await git.adoptRepository(machine, checkoutPath, expectedRemote);
      const effectiveRemote = expectedRemote?.trim() || inspection.remoteUrl;
      if (!effectiveRemote) throw new Error("The existing checkout has no Git remote");
      const repositoryName = String(args.name ?? "");
      const baseBranch = String(args.baseBranch ?? "");
      const latest = runtime.snapshot();
      const latestContents = repositoryRegistrationContents(latest, projectId);
      const isCurrent =
        JSON.stringify(latest.projects.find((entry) => entry.id === projectId)) ===
          JSON.stringify(project) &&
        JSON.stringify(latest.machines.find((entry) => entry.id === machineId)) ===
          JSON.stringify(machine) &&
        JSON.stringify(latestContents.repositories) ===
          JSON.stringify(registrationContents.repositories) &&
        JSON.stringify(latestContents.locations) === JSON.stringify(registrationContents.locations);
      if (!isCurrent) {
        const error =
          "The Project, Machine, or Repository registration changed while Git was inspecting the checkout; review it again";
        throw new Error(
          clone ? `${error}; the cloned checkout remains at ${normalizedCheckoutPath}` : error,
        );
      }
      try {
        const result = runtime.dispatch({
          type: "register_repository_at_location",
          projectId,
          name: repositoryName,
          remoteUrl: effectiveRemote,
          baseBranch,
          machineId,
          checkoutPath: normalizedCheckoutPath,
          worktreeRoot: normalizedWorktreeRoot,
        });
        const registered = result.repositories.find(
          (entry) => entry.project_id === projectId && entry.name === repositoryName.trim(),
        );
        if (!registered) throw new Error("Repository registration produced no Repository");
        return registered;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (clone)
          throw new Error(`${detail}; the cloned checkout remains at ${normalizedCheckoutPath}`);
        throw error;
      }
    },
    update_repository: (args: Record<string, unknown>) =>
      dispatchAndSelectRepository(
        {
          type: "update_repository",
          repositoryId: Number(args.repositoryId),
          name: String(args.name ?? ""),
          remoteUrl: String(args.remoteUrl ?? ""),
          baseBranch: String(args.baseBranch ?? ""),
        },
        Number(args.repositoryId),
      ),
    update_repository_location: (args: Record<string, unknown>): RepositoryLocation | undefined => {
      const repositoryId = Number(args.repositoryId);
      const machineId = Number(args.machineId);
      const state = runtime.dispatch({
        type: "update_repository_location",
        repositoryId,
        previousMachineId:
          args.previousMachineId === null || args.previousMachineId === undefined
            ? null
            : Number(args.previousMachineId),
        machineId,
        checkoutPath: String(args.checkoutPath ?? ""),
        worktreeRoot: String(args.worktreeRoot ?? ""),
      });
      return state.repository_locations.find(
        (location) => location.repository_id === repositoryId && location.machine_id === machineId,
      );
    },
    register_machine: (args: Record<string, unknown>): Machine => {
      const id = runtime.snapshot().next_machine_id;
      const state = runtime.dispatch({
        type: "register_machine",
        contextId: Number(args.contextId),
        name: String(args.name ?? ""),
        socketName: String(args.socketName ?? ""),
        transport: args.transport as MachineTransport,
      });
      return state.machines.find((entry) => entry.id === id)!;
    },
    update_machine: (args: Record<string, unknown>): Machine => {
      const machineId = Number(args.machineId);
      machineCheckGenerations.set(machineId, (machineCheckGenerations.get(machineId) ?? 0) + 1);
      const state = runtime.dispatch({
        type: "update_machine",
        machineId,
        name: String(args.name ?? ""),
        socketName: String(args.socketName ?? ""),
        transport: args.transport as MachineTransport,
      });
      store?.setMachineReadiness(machineId, null);
      return state.machines.find((entry) => entry.id === machineId)!;
    },
    set_context_execution_machine: (args: Record<string, unknown>) => {
      const contextId = Number(args.contextId);
      const state = runtime.dispatch({
        type: "set_context_execution_machine",
        contextId,
        machineId:
          args.machineId === null || args.machineId === undefined ? null : Number(args.machineId),
      });
      return state.contexts.find((entry) => entry.id === contextId);
    },
    create_cli_configuration_profile: (
      args: Record<string, unknown>,
    ): Promise<CliProfileSettingsView> =>
      serializeProfileCreation(async () => {
        const machineId = Number(args.machineId);
        const provider = args.provider as AgentKind;
        const appManaged = Boolean(args.appManaged);
        const directory = appManaged
          ? `~/.config/ai-mission-manager/cli-profiles/${provider}/${runtime.snapshot().next_cli_profile_id}`
          : String(args.existingDirectory ?? "");
        const event: Event = {
          type: "create_cli_configuration_profile",
          machineId,
          provider,
          name: String(args.name ?? ""),
          directory,
          appManaged,
        };
        // Validate before making a directory on the target Machine.
        decide(runtime.snapshot(), event);
        if (appManaged) {
          const machine = runtime.snapshot().machines.find((entry) => entry.id === machineId);
          if (!machine) throw new Error(`Machine ${machineId} does not exist`);
          const relativePath = directory.slice(2);
          await machineAccess.runShell(machine, `mkdir -p -- "$HOME/${relativePath}"`);
        }
        const state = runtime.dispatch(event);
        const profile = state.cli_configuration_profiles.at(-1)!;
        return {
          profile,
          signInCommand: appManaged
            ? `${provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"}="$HOME/${directory.slice(2)}" ${provider === "claude" ? "claude" : "codex login"}`
            : null,
        };
      }),
    set_context_cli_configuration_profile: (args: Record<string, unknown>) => {
      const contextId = Number(args.contextId);
      const state = runtime.dispatch({
        type: "set_context_cli_configuration_profile",
        contextId,
        provider: args.provider as AgentKind,
        profileId:
          args.profileId === null || args.profileId === undefined ? null : Number(args.profileId),
      });
      return state.contexts.find((entry) => entry.id === contextId);
    },
    delete_cli_configuration_profile: (args: Record<string, unknown>) => {
      runtime.dispatch({
        type: "delete_cli_configuration_profile",
        profileId: Number(args.profileId),
      });
      return null;
    },
    check_machine: async (args: Record<string, unknown>) => {
      const machineId = Number(args.machineId);
      const machine = runtime.snapshot().machines.find((entry) => entry.id === machineId);
      if (!machine) throw new Error(`Machine ${machineId} does not exist`);
      const generation = (machineCheckGenerations.get(machineId) ?? 0) + 1;
      machineCheckGenerations.set(machineId, generation);
      const observed = await machineAccess.checkMachine(machine);
      if (machineCheckGenerations.get(machineId) !== generation)
        throw new Error(`Machine ${machineId} check result was superseded by a newer check`);
      const current = runtime.snapshot().machines.find((entry) => entry.id === machineId);
      if (!current) throw new Error(`Machine ${machineId} no longer exists`);
      if (
        current.context_id !== machine.context_id ||
        current.name !== machine.name ||
        current.socket_name !== machine.socket_name ||
        JSON.stringify(current.transport) !== JSON.stringify(machine.transport)
      )
        throw new Error(`Machine ${machineId} changed while it was being checked; check it again`);
      const observedAt = Math.floor(Date.now() / 1000);
      const state = runtime.dispatch({
        type: "observe_machine",
        machineId,
        observation: observed.reachable && observed.tmuxAvailable ? "available" : "offline",
        observedAt,
      });
      const updated = state.machines.find((entry) => entry.id === machineId)!;
      const readiness: MachineReadiness = {
        reachable: observed.reachable,
        tmuxAvailable: observed.tmuxAvailable,
        bunAvailable: observed.bunAvailable,
        bunError: observed.bunError,
        claudeExecutableResolved: null,
        codexExecutableResolved: null,
        stateDirectoryWritable: observed.stateDirectoryWritable,
        claudeHooks: { provisioned: null, current: null, error: null },
        codexHooks: { provisioned: null, current: null, error: null },
        lastProvisioningError: null,
        error: observed.error,
      };
      store?.setMachineReadiness(machineId, readiness);
      return { ...updated, readiness };
    },
  };
}
