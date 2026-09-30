import type {
  ContextConfiguration,
  ContextAttentionDefault,
  GrillConfiguration,
  Context,
} from "./types";

export type Event =
  | { type: "create_context"; name: string }
  | { type: "create_context_configuration"; configuration: ContextConfiguration }
  | { type: "update_context"; contextId: number; name: string }
  | { type: "update_context_configuration"; contextId: number; configuration: ContextConfiguration }
  | { type: "set_context_grill_defaults"; contextId: number; defaults: GrillConfiguration }
  | { type: "set_context_implement_defaults"; contextId: number; defaults: GrillConfiguration }
  | { type: "set_context_dirty_checkout_check"; contextId: number; enabled: boolean }
  | {
      type: "set_context_attention_default";
      contextId: number;
      objectKind: ContextAttentionDefault["object_kind"];
      policy: ContextAttentionDefault["policy"];
    };

export type Effect =
  | { type: "persist_context"; context: Context; nextContextId: number }
  | {
      type: "persist_project";
      project: {
        id: number;
        context_id: number;
        name: string;
        defaults: { item_status: "Inbox"; execution_mode: "worktree" };
      };
      nextProjectId: number;
    }
  | { type: "update_context"; context: Context }
  | { type: "persist_context_grill_defaults"; contextId: number; defaults: GrillConfiguration }
  | { type: "persist_context_implement_defaults"; contextId: number; defaults: GrillConfiguration }
  | {
      type: "persist_context_configuration";
      context: Context;
      attentionDefaults: ContextAttentionDefault[];
    }
  | { type: "persist_context_attention_default"; attentionDefault: ContextAttentionDefault };

export type Decision = { state: import("./model").DomainState; effects: Effect[] };
