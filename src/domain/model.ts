import type {
  Activity,
  CliConfigurationProfile,
  Context,
  ContextAttentionDefault,
  ExternalObject,
  ExternalSnapshot,
  ImplementationQueue,
  Item,
  ItemRelation,
  Machine,
  Project,
  Repository,
  RepositoryLocation,
  Workspace,
} from "../renderer/runtime/types";
import type { Run } from "../renderer/runtime/execution-types";

/** The persisted domain model loaded from the Rust-compatible SQLite store. */
export type DomainState = {
  next_context_id: number;
  next_project_id: number;
  next_item_id: number;
  next_item_number: number;
  next_repository_id: number;
  next_workspace_id: number;
  next_worktree_id: number;
  next_machine_id: number;
  next_cli_profile_id: number;
  next_run_id: number;
  next_external_object_id: number;
  next_link_id: number;
  next_activity_id: number;
  next_reminder_id: number;
  contexts: Context[];
  projects: Project[];
  repositories: Repository[];
  repository_locations: RepositoryLocation[];
  items: Item[];
  workspaces: (Omit<Workspace, "repositories"> & {
    repositories: { repositoryId: number; branch: string; baseBranch: string }[];
  })[];
  worktrees: {
    id: number;
    workspaceId: number;
    repositoryId: number;
    machineId: number;
    path: string;
    branch: string;
    baseBranch: string;
    isDirty: boolean;
  }[];
  machines: Machine[];
  cli_configuration_profiles: CliConfigurationProfile[];
  runs: Run[];
  implementation_queues: ImplementationQueue[];
  relationships: ItemRelation[];
  external_objects: ExternalObject[];
  links: {
    id: number;
    item_id: number;
    external_object_id: number;
    reviewed_activity_id: number;
    attention_policy: { title: boolean; state: boolean; metadata: boolean } | null;
    watch_until: string | null;
    review_at: string | null;
    purpose: "to-spec" | "to-tickets" | "others";
    spec_external_object_id: number | null;
    provenance: Record<string, unknown> | null;
  }[];
  snapshots: ExternalSnapshot[];
  activities: Activity[];
  attention_defaults: ContextAttentionDefault[];
};

export const defaultPstackRoles: NonNullable<Context["pstack_roles"]> = [
  {
    role: "code-delegate",
    configuration: { agent: "claude", model: "claude-opus-5", effort: "high" },
  },
  {
    role: "judge-and-prose",
    configuration: { agent: "codex", model: "gpt-6-sol", effort: "high" },
  },
  { role: "review-panel", configuration: { agent: "codex", model: "gpt-6-sol", effort: "high" } },
  {
    role: "explorers",
    configuration: { agent: "claude", model: "claude-sonnet-5", effort: "medium" },
  },
];
