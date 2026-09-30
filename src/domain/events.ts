import type {
  ContextConfiguration,
  ContextAttentionDefault,
  GrillConfiguration,
  Context,
  Project,
  Repository,
  RepositoryLocation,
  Machine,
  MachineTransport,
  CliConfigurationProfile,
  AgentKind,
  WorkspaceRepositoryInput,
  ProviderChoice,
  ItemStatus,
  Item,
  ItemRelation,
  ExternalObject,
  ExternalObjectInput,
  ExternalSnapshot,
  ExternalSnapshotData,
} from "./types";
import type { DomainState } from "./model";

export type Event =
  | { type: "create_context"; name: string }
  | { type: "complete_setup"; contextName: string; provider: ProviderChoice }
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
      type: "register_repository_at_location";
      projectId: number;
      name: string;
      remoteUrl: string;
      baseBranch: string;
      machineId: number;
      checkoutPath: string;
      worktreeRoot: string;
    }
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
  | {
      type: "register_machine";
      contextId: number;
      name: string;
      socketName: string;
      transport: MachineTransport;
    }
  | {
      type: "update_machine";
      machineId: number;
      name: string;
      socketName: string;
      transport: MachineTransport;
    }
  | {
      type: "observe_machine";
      machineId: number;
      observation: Machine["last_observed"];
      observedAt: number;
    }
  | { type: "set_context_execution_machine"; contextId: number; machineId: number | null }
  | {
      type: "create_cli_configuration_profile";
      machineId: number;
      provider: AgentKind;
      name: string;
      directory: string;
      appManaged: boolean;
    }
  | {
      type: "set_context_cli_configuration_profile";
      contextId: number;
      provider: AgentKind;
      profileId: number | null;
    }
  | { type: "delete_cli_configuration_profile"; profileId: number }
  | { type: "create_workspace"; itemId: number; repositories: WorkspaceRepositoryInput[] }
  | { type: "create_item"; title: string; contextId: number; projectId: number; notes: string }
  | { type: "set_item_status"; itemId: number; status: ItemStatus }
  | { type: "set_item_title"; itemId: number; title: string }
  | { type: "set_item_notes"; itemId: number; notes: string }
  | { type: "add_item_reminder"; itemId: number; remindAt: string }
  | { type: "remove_item_reminder"; itemId: number; reminderId: number }
  | { type: "set_item_relation"; fromItemId: number; toItemId: number; kind: ItemRelation["kind"] }
  | {
      type: "set_workspace_repositories";
      workspaceId: number;
      repositories: WorkspaceRepositoryInput[];
    }
  | {
      type: "create_worktree";
      workspaceId: number;
      repositoryId: number;
      machineId: number;
      path: string;
      branch: string;
      baseBranch: string;
      isDirty: boolean;
    }
  | { type: "mark_workspace_resumable"; workspaceId: number }
  | {
      type: "link_external_object";
      itemId: number;
      object: ExternalObjectInput;
      snapshot: ExternalSnapshotData | null;
    }
  | { type: "refresh_external_object"; externalObjectId: number; snapshot: ExternalSnapshotData }
  | { type: "mark_link_reviewed"; linkId: number };

export type Effect =
  | { type: "persist_context"; context: Context; nextContextId: number }
  | { type: "persist_setup"; provider: ProviderChoice }
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
  | { type: "persist_machine"; machine: Machine; nextMachineId: number }
  | { type: "update_machine"; machine: Machine }
  | { type: "persist_machine_observation"; machine: Machine }
  | {
      type: "persist_cli_configuration_profile";
      profile: CliConfigurationProfile;
      nextCliProfileId: number;
    }
  | { type: "remove_cli_configuration_profile"; profileId: number }
  | {
      type: "persist_workspace";
      workspace: DomainState["workspaces"][number];
      nextWorkspaceId: number;
    }
  | { type: "persist_workspace_update"; workspace: DomainState["workspaces"][number] }
  | { type: "persist_worktree"; worktree: DomainState["worktrees"][number]; nextWorktreeId: number }
  | { type: "persist_item"; item: Item; nextItemId: number; nextItemNumber: number }
  | { type: "persist_item_update"; item: Item }
  | { type: "persist_item_reminders"; item: Item; nextReminderId: number }
  | { type: "persist_item_relation"; relation: ItemRelation }
  | { type: "persist_external_object"; object: ExternalObject; nextExternalObjectId: number }
  | { type: "persist_external_link"; link: DomainState["links"][number]; nextLinkId: number }
  | { type: "persist_link_state"; link: DomainState["links"][number] }
  | { type: "persist_external_snapshot"; snapshot: ExternalSnapshot }
  | { type: "persist_activity"; activity: import("./types").Activity; nextActivityId: number };

export type Decision = { state: import("./model").DomainState; effects: Effect[] };
