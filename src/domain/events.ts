import type {
  ContextConfiguration,
  ContextAttentionDefault,
  GrillConfiguration,
  Context,
  Project,
  Repository,
  RepositoryLocation,
  WorkspaceRepositoryInput,
} from "./types";
import type { DomainState } from "./model";

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
    }
  | {
      type: "create_project";
      contextId: number;
      name: string;
      defaults: Project["defaults"];
    }
  | {
      type: "update_project";
      projectId: number;
      name: string;
      defaults: Project["defaults"];
    }
  | { type: "register_repository"; projectId: number; name: string; remoteUrl: string }
  | {
      type: "update_repository";
      repositoryId: number;
      name: string;
      remoteUrl: string;
      baseBranch: string;
    }
  | {
      type: "update_repository_location";
      repositoryId: number;
      previousMachineId: number | null;
      machineId: number;
      checkoutPath: string;
      worktreeRoot: string;
    }
  | { type: "create_workspace"; itemId: number; repositories: WorkspaceRepositoryInput[] }
  | {
      type: "set_workspace_repositories";
      workspaceId: number;
      repositories: WorkspaceRepositoryInput[];
    };

export type Effect =
  | { type: "persist_context"; context: Context; nextContextId: number }
  | {
      type: "persist_project";
      project: Project;
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
  | { type: "persist_context_attention_default"; attentionDefault: ContextAttentionDefault }
  | { type: "update_project"; project: Project }
  | { type: "persist_repository"; repository: Repository; nextRepositoryId: number }
  | { type: "update_repository"; repository: Repository }
  | {
      type: "update_repository_location";
      previousMachineId: number | null;
      location: RepositoryLocation;
    }
  | {
      type: "persist_workspace";
      workspace: DomainState["workspaces"][number];
      nextWorkspaceId: number;
    }
  | { type: "persist_workspace_update"; workspace: DomainState["workspaces"][number] };

export type Decision = { state: import("./model").DomainState; effects: Effect[] };
