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
} from "../domain/types";

export function createStructureCommandHandlers(runtime: Runtime) {
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
  };
}
