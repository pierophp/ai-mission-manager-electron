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
  ExternalChangePolicy,
  LinkPurpose,
} from "./types";
import type { DomainState } from "./model";

export type Event =
  | {
      type: "start_run";
      run: import("./execution-types").Run;
      queueAttachment?: { queueId: number; position: number };
      queueStart?: {
        start: import("./types").ImplementationQueueStart;
        configuration: GrillConfiguration;
        allowDirty: boolean;
        allowSharedCheckouts: boolean;
      };
    }
  | { type: "stop_run"; runId: number }
  | { type: "finish_run"; runId: number }
  | {
      type: "advance_implementation_queue";
      queueId: number;
      runId: number;
      ticketClosed: boolean;
      checkoutClean: boolean;
    }
  | {
      type: "pause_implementation_queue";
      queueId: number;
      reason: import("./types").ImplementationQueuePauseReason;
    }
  | { type: "skip_implementation_queue_entry"; queueId: number; position: number }
  | { type: "cancel_implementation_queue"; queueId: number }
  | { type: "set_implementation_queue_entry_run"; queueId: number; position: number; runId: number }
  | { type: "delete_run"; runId: number }
  | {
      type: "delete_machine";
      machineId: number;
      runIds: number[];
      worktreeIds: number[];
      repositoryLocationRepositoryIds: number[];
    }
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
  | {
      type: "observe_run";
      runId: number;
      state: import("./execution-types").RunState;
      sequence: number | null;
      paneStatus: import("./execution-types").RunPaneStatus;
    }
  | {
      type: "continue_grill";
      runId: number;
      action: import("./execution-types").GrillContinuationAction;
      startedAt: number;
    }
  | { type: "set_run_state"; runId: number; state: import("./execution-types").RunState }
  | {
      type: "record_grill_answers";
      runId: number;
      answers: import("./execution-types").GrillAnswer[];
    }
  | { type: "record_grill_response"; runId: number; response: string }
  | {
      type: "record_run_transcript";
      runId: number;
      transcript: string;
      questionGroup: import("./execution-types").GrillQuestionGroup | null;
    }
  | { type: "record_run_plan"; runId: number; path: string }
  | { type: "go_plan"; runId: number }
  | {
      type: "capture_downstream_issues";
      runId: number;
      action: import("./execution-types").GrillContinuationAction;
      issues: import("./grilling").ConfirmedDownstreamIssue[];
    }
  | {
      type: "attach_untracked_run";
      itemId: number;
      workspaceId: number;
      repositoryId: number;
      worktreeId: number | null;
      machineId: number;
      agent: import("./execution-types").AgentKind;
      workingDirectory: string;
      machineHome: string;
      sessionName: string;
      paneId: string;
      startedAt: number;
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
  | {
      type: "set_link_purpose";
      linkId: number;
      purpose: LinkPurpose;
      specExternalObjectId: number | null;
    }
  | { type: "set_link_watch_until"; linkId: number; watchUntil: string | null }
  | { type: "set_link_review_at"; linkId: number; reviewAt: string | null }
  | { type: "clear_link_review_at"; linkId: number }
  | { type: "set_link_attention_policy"; linkId: number; policy: ExternalChangePolicy | null }
  | { type: "mark_link_reviewed"; linkId: number }
  | {
      type: "delete_project";
      projectId: number;
      itemIds: number[];
      repositoryIds: number[];
      workspaceIds: number[];
    }
  | {
      type: "delete_context";
      contextId: number;
      projectIds: number[];
      itemIds: number[];
      repositoryIds: number[];
      workspaceIds: number[];
      machineIds: number[];
    }
  | { type: "delete_repository"; repositoryId: number; workspaceIds: number[] }
  | { type: "delete_item"; itemId: number }
  | { type: "delete_external_object"; externalObjectId: number }
  | { type: "delete_link"; linkId: number }
  | { type: "remove_worktree"; worktreeId: number }
  | { type: "reset_local_data" };

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
  | { type: "persist_run_observation"; run: import("./execution-types").Run }
  | { type: "persist_audit"; action: import("./types").AuditAction }
  | { type: "persist_run"; run: import("./execution-types").Run; nextRunId: number }
  | { type: "remove_run"; runId: number }
  | { type: "remove_machine"; machineId: number }
  | { type: "persist_implementation_queue"; queue: import("./types").ImplementationQueue }
  | { type: "close_implementation_run_session"; runId: number }
  | { type: "launch_implementation_queue_entry"; queueId: number; position: number }
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
  | { type: "persist_activity"; activity: import("./types").Activity; nextActivityId: number }
  | { type: "remove_repository"; repositoryId: number }
  | { type: "remove_item_cascade"; itemId: number; orphanedExternalObjectIds: number[] }
  | { type: "remove_project_cascade"; projectId: number; orphanedExternalObjectIds: number[] }
  | { type: "remove_context_cascade"; contextId: number; orphanedExternalObjectIds: number[] }
  | { type: "remove_external_object"; externalObjectId: number }
  | { type: "remove_link"; linkId: number; externalObjectId: number }
  | { type: "remove_worktree"; worktreeId: number }
  | {
      type: "reset_local_data";
      context: Context;
      project: Project;
      nextContextId: number;
      nextProjectId: number;
    };

export type Decision = { state: import("./model").DomainState; effects: Effect[] };
