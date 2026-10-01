import fs from "node:fs";
import path from "node:path";
import type { AgentKind, RunState } from "../domain/execution-types";
import { shellQuote, type MachineAccess } from "./machine-access";
import type { Machine } from "../domain/types";
import { AGENT_STATE_HOOK_SCRIPT } from "./generated-resources";
export { AGENT_STATE_HOOK_SCRIPT };

export const AGENT_STATE_OPTION = "@ai_mission_manager_run_state";
export const AGENT_STATE_HOOK_RELATIVE_PATH =
  ".local/share/ai-mission-manager/hooks/ai-mission-manager-agent-state-hook.sh";
export const AGENT_STATE_RUNS_RELATIVE_PATH = ".local/state/ai-mission-manager/runs";
export type AgentStateRecord = {
  agent: AgentKind;
  runId: string;
  state: RunState;
  updatedAt: string;
  sequence?: number;
};
export function stateRunsDirectory(home: string) {
  return path.join(home, AGENT_STATE_RUNS_RELATIVE_PATH);
}
export function stateFilePath(directory: string, runId: number) {
  return path.join(directory, "run-" + runId + ".json");
}
export function readStateFile(file: string): AgentStateRecord {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AgentStateRecord;
}

export function stateForHookEvent(agent: AgentKind, event: unknown): RunState | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Record<string, unknown>;
  const name = value.hook_event_name;
  if (name === "SessionStart" || name === "UserPromptSubmit") return "working";
  if (name === "Stop" || name === "SessionEnd") return "finished";
  if (
    agent === "claude" &&
    name === "Notification" &&
    ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"].includes(
      String(value.notification_type),
    )
  )
    return "blocked";
  if (agent === "codex" && name === "PermissionRequest") return "blocked";
  return null;
}

function ensureOwnedDirectories(directory: string) {
  const absolute = path.resolve(directory);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  let owned = false;
  for (const part of parts) {
    current = path.join(current, part);
    owned ||= part === "ai-mission-manager";
    try {
      fs.mkdirSync(current);
      if (owned) fs.chmodSync(current, 0o700);
    } catch (error) {
      if (!fs.existsSync(current))
        throw new Error("Could not create " + current + ": " + String(error));
    }
    if (!fs.statSync(current).isDirectory())
      throw new Error(current + " is not a regular directory");
  }
}
function validateFileTarget(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(file + " is a symbolic link");
    if (!stat.isFile()) throw new Error(file + " is not a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function atomicWrite(file: string, contents: Uint8Array, mode: number) {
  validateFileTarget(file);
  ensureOwnedDirectories(path.dirname(file));
  const temporary = file + "." + process.pid + ".tmp";
  try {
    fs.lstatSync(temporary);
    throw new Error(temporary + " already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode });
    fs.chmodSync(temporary, mode);
    validateFileTarget(file);
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* no temp */
    }
    throw error;
  }
}
export function installAgentStateHook(home: string) {
  const file = path.join(home, AGENT_STATE_HOOK_RELATIVE_PATH);
  if (
    validateFileTarget(file) &&
    fs.readFileSync(file).equals(Buffer.from(AGENT_STATE_HOOK_SCRIPT)) &&
    (fs.statSync(file).mode & 0o111) !== 0
  )
    return file;
  atomicWrite(file, Buffer.from(AGENT_STATE_HOOK_SCRIPT), 0o700);
  return file;
}
export function ensureStateRunsDirectory(home: string) {
  const directory = stateRunsDirectory(home);
  ensureOwnedDirectories(directory);
  const probe = path.join(directory, ".preflight." + process.pid);
  fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
  fs.unlinkSync(probe);
  return directory;
}
export function agentHookEvents(agent: AgentKind): readonly (readonly [string, RunState])[] {
  return agent === "claude"
    ? [
        ["SessionStart", "working"],
        ["UserPromptSubmit", "working"],
        ["Notification", "blocked"],
        ["Stop", "finished"],
        ["SessionEnd", "finished"],
      ]
    : [
        ["SessionStart", "working"],
        ["UserPromptSubmit", "working"],
        ["PermissionRequest", "blocked"],
        ["Stop", "finished"],
        ["SessionEnd", "finished"],
      ];
}
function isOwnedCommand(command: string, script: string, agent: AgentKind) {
  const prefix = shellQuote(script) + " ";
  const args = command.startsWith(prefix) ? command.slice(prefix.length) : null;
  if (
    args !== null &&
    ["unknown", "working", "blocked", "finished"].some((state) => args === state + " " + agent)
  )
    return true;
  const match = command.match(/^'([^']+)' (.*)$/);
  if (!match) return false;
  const executable = match[1]!;
  const oldPath =
    executable.endsWith("/" + AGENT_STATE_HOOK_RELATIVE_PATH) &&
    ["unknown", "working", "blocked", "finished"].some((state) => match[2] === state + " " + agent);
  const oldApp =
    (executable.endsWith(".app/Contents/MacOS/app") ||
      executable.endsWith("/ai-mission-manager")) &&
    match[2] === "--agent-state-hook " + agent;
  return oldPath || oldApp;
}
export function mergeProviderHooks(
  existing: string | null,
  script: string,
  agent: AgentKind,
  events = agentHookEvents(agent),
) {
  const value: unknown = existing === null ? {} : JSON.parse(existing);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("provider settings must contain a JSON object");
  const root = value as Record<string, unknown>;
  root.hooks ??= {};
  if (!root.hooks || typeof root.hooks !== "object" || Array.isArray(root.hooks))
    throw new Error("hooks in provider settings must be a JSON object");
  const hooks = root.hooks as Record<string, unknown>;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.filter((group: any) => {
      if (!group || !Array.isArray(group.hooks)) return true;
      group.hooks = group.hooks.filter(
        (hook: any) =>
          typeof hook?.command !== "string" || !isOwnedCommand(hook.command, script, agent),
      );
      return group.hooks.length > 0;
    });
  }
  for (const [event, state] of events) {
    const groups = (hooks[event] ??= []);
    if (!Array.isArray(groups)) throw new Error("hooks." + event + " must be an array");
    const group: Record<string, unknown> = {
      hooks: [{ type: "command", command: shellQuote(script) + " " + state + " " + agent }],
    };
    if (event === "Notification")
      group.matcher = "permission_prompt|elicitation_dialog|elicitation_url_dialog";
    groups.push(group);
  }
  return JSON.stringify(value, null, 2) + "\n";
}
function writeIfChanged(file: string, contents: string) {
  if (validateFileTarget(file) && fs.readFileSync(file, "utf8") === contents) return;
  atomicWrite(file, Buffer.from(contents), 0o600);
}
export function provisionAgentHooksInDirectory(
  home: string,
  providerDirectory: string,
  agent: AgentKind,
) {
  const script = installAgentStateHook(home);
  const file = path.join(providerDirectory, agent === "claude" ? "settings.json" : "hooks.json");
  const existing = validateFileTarget(file) ? fs.readFileSync(file, "utf8") : null;
  writeIfChanged(file, mergeProviderHooks(existing, script, agent));
}
export function provisionAgentHooksFor(home: string, agent: AgentKind) {
  provisionAgentHooksInDirectory(
    home,
    path.join(home, agent === "claude" ? ".claude" : ".codex"),
    agent,
  );
}

function remoteAtomicWriteCommand(
  target: string,
  mode: 0o600 | 0o700,
  writeTemporary: string,
  requireExecutable: boolean,
) {
  const executableCheck = requireExecutable ? ' && [ -x "$file" ]' : "";
  return (
    "set -eu; umask 077; file=" +
    shellQuote(target) +
    '; [ ! -L "$file" ] || { echo "target is a symbolic link" >&2; exit 1; }; [ ! -e "$file" ] || [ -f "$file" ] || { echo "target is not a regular file" >&2; exit 1; }; temporary="$file.tmp.$$"; trap \'rm -f "$temporary"\' EXIT HUP INT TERM; set -C; ' +
    writeTemporary +
    "; set +C; chmod " +
    mode.toString(8) +
    ' "$temporary"; [ ! -L "$file" ] || exit 1; if [ -f "$file" ] && cmp -s "$temporary" "$file"' +
    executableCheck +
    '; then rm -f "$temporary"; else mv -f "$temporary" "$file"; fi; trap - EXIT HUP INT TERM'
  );
}
function ensureRemoteOwnedDirectory(directory: string) {
  const quoted = shellQuote(directory);
  return (
    "if [ ! -d " +
    quoted +
    " ]; then if mkdir " +
    quoted +
    " 2>/dev/null; then chmod 700 " +
    quoted +
    "; elif [ ! -d " +
    quoted +
    " ]; then exit 1; fi; fi;"
  );
}

export async function provisionAgentState(
  machine: Machine,
  access: MachineAccess,
  home: string,
  agent: AgentKind,
  providerDirectory?: string,
) {
  if (machine.transport.kind === "local") {
    provisionAgentHooksInDirectory(
      home,
      providerDirectory ?? path.join(home, agent === "claude" ? ".claude" : ".codex"),
      agent,
    );
    return;
  }
  const directory =
    providerDirectory ?? path.posix.join(home, agent === "claude" ? ".claude" : ".codex");
  const target = path.posix.join(home, AGENT_STATE_HOOK_RELATIVE_PATH);
  const appDirectory = path.posix.join(home, ".local/share/ai-mission-manager");
  const hookDirectory = path.posix.dirname(target);
  const payload = Buffer.from(AGENT_STATE_HOOK_SCRIPT).toString("base64");
  const filename = agent === "claude" ? "settings.json" : "hooks.json";
  const directories =
    "set -eu; umask 077; mkdir -p " +
    shellQuote(path.posix.dirname(appDirectory)) +
    "; " +
    ensureRemoteOwnedDirectory(appDirectory) +
    " " +
    ensureRemoteOwnedDirectory(hookDirectory) +
    " mkdir -p " +
    shellQuote(directory) +
    ";";
  const writeHook = remoteAtomicWriteCommand(
    target,
    0o700,
    "printf '%s' '" + payload + '\' | base64 -d > "$temporary"',
    true,
  );
  const configPath = path.posix.join(directory, filename);
  const command =
    directories +
    writeHook +
    "; provider_config=" +
    shellQuote(configPath) +
    '; [ ! -L "$provider_config" ] || { echo "provider settings is a symbolic link" >&2; exit 1; }; [ ! -e "$provider_config" ] || [ -f "$provider_config" ] || { echo "provider settings is not a regular file" >&2; exit 1; }; if [ -e "$provider_config" ]; then cat "$provider_config"; else printf \'{}\'; fi';
  const current = await access.runShell(machine, command);
  const merged = mergeProviderHooks(current, target, agent);
  const write = remoteAtomicWriteCommand(configPath, 0o600, 'cat > "$temporary"', false);
  await access.runShell(machine, write, Buffer.from(merged));
}
