import { DatabaseSync } from "node:sqlite";
import type { ContextConfiguration, SetupState } from "../../renderer/runtime/types";
import { defaultPstackRoles } from "../../domain/model";
import { optionalString } from "./codecs";

const allAttention = { title: true, state: true, metadata: true };

export function readSetting(database: DatabaseSync, key: string): string | null {
  return optionalString(
    database.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value,
  );
}

export function getSetupState(database: DatabaseSync): SetupState {
  const completed = readSetting(database, "setup_completed") === "true";
  const provider = readSetting(database, "provider_choice");
  if (provider && provider !== "github" && provider !== "none") {
    throw new Error(`Unknown provider choice: ${provider}`);
  }
  return { completed, provider: provider === "none" ? "none" : "github" };
}

export function newContextConfiguration(): ContextConfiguration {
  return {
    name: "",
    executionMachineId: null,
    claudeProfileId: null,
    codexProfileId: null,
    checkDirtyCheckouts: true,
    grillDefaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
    implementDefaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
    defaultWorkflow: "matt-pocock",
    pstackDefaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
    pstackRoles: defaultPstackRoles,
    ghExecutablePath: null,
    twgExecutablePath: null,
    azExecutablePath: null,
    atlassianSite: null,
    azureDevopsOrganization: null,
    bitbucketWorkspace: null,
    attentionDefaults: (["issue", "pull_request", "document", "generic"] as const).map(
      (object_kind) => ({ context_id: 0, object_kind, policy: allAttention }),
    ),
  };
}

export function signInCommand(provider: "claude" | "codex", directory: string): string {
  const environment = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const cli = provider === "claude" ? "claude" : "codex login";
  const escaped = directory.startsWith("~/")
    ? `"$HOME/${directory.slice(2)}"`
    : `'${directory.replaceAll("'", "'\"'\"'")}'`;
  return `${environment}=${escaped} ${cli}`;
}
