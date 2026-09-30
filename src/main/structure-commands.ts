import type { Runtime } from "./runtime";
import type { Event } from "../domain/events";
import type {
  ContextConfiguration,
  ExternalChangePolicy,
  ExternalObjectKind,
  GrillConfiguration,
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
  };
}
