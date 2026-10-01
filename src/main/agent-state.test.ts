import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_STATE_HOOK_RELATIVE_PATH,
  AGENT_STATE_HOOK_SCRIPT,
  ensureStateRunsDirectory,
  installAgentStateHook,
  mergeProviderHooks,
  provisionAgentHooksFor,
  provisionAgentHooksInDirectory,
  provisionAgentState,
  readStateFile,
  stateForHookEvent,
  stateRunsDirectory,
} from "./agent-state";

const homes: string[] = [];
function home() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "agent-state-"));
  homes.push(value);
  return value;
}
afterEach(() => {
  for (const value of homes.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("agent state hooks", () => {
  it("maps Claude and Codex events without guessing unknown states", () => {
    expect(stateForHookEvent("claude", { hook_event_name: "SessionStart" })).toBe("working");
    expect(
      stateForHookEvent("claude", {
        hook_event_name: "Notification",
        notification_type: "elicitation_dialog",
      }),
    ).toBe("blocked");
    expect(stateForHookEvent("codex", { hook_event_name: "Notification" })).toBeNull();
    expect(stateForHookEvent("codex", { hook_event_name: "PermissionRequest" })).toBe("blocked");
    expect(stateForHookEvent("codex", { hook_event_name: "SessionEnd" })).toBe("finished");
  });

  it("installs byte-identical hook once, with executable mode, and merges provider settings", () => {
    const root = home();
    const script = installAgentStateHook(root);
    const before = fs.statSync(script);
    expect(fs.readFileSync(script, "utf8")).toBe(AGENT_STATE_HOOK_SCRIPT);
    expect(before.mode & 0o777).toBe(0o700);
    expect(installAgentStateHook(root)).toBe(script);
    expect(fs.statSync(script).ino).toBe(before.ino);
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(
      path.join(root, ".claude/settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(*)"] },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "user-hook" }] }] },
      }),
    );
    provisionAgentHooksFor(root, "claude");
    const merged = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
    expect(merged.permissions).toEqual({ allow: ["Bash(*)"] });
    expect(merged.hooks.SessionStart).toHaveLength(2);
    expect(merged.hooks.Notification[0].matcher).toBe(
      "permission_prompt|elicitation_dialog|elicitation_url_dialog",
    );
    expect(fs.statSync(path.join(root, ".claude/settings.json")).mode & 0o777).toBe(0o600);
    const first = fs.statSync(script).ino;
    provisionAgentHooksFor(root, "claude");
    expect(fs.statSync(script).ino).toBe(first);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")).hooks
        .SessionStart,
    ).toHaveLength(2);
  });

  it("rejects symlink provider targets and hook targets", () => {
    const root = home();
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "{}");
    fs.mkdirSync(path.join(root, ".claude"));
    fs.symlinkSync(outside, path.join(root, ".claude/settings.json"));
    expect(() => provisionAgentHooksFor(root, "claude")).toThrow(/symbolic link/);
    const hooks = path.join(root, AGENT_STATE_HOOK_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(hooks), { recursive: true });
    fs.unlinkSync(hooks);
    fs.symlinkSync(outside, hooks);
    expect(() => installAgentStateHook(root)).toThrow(/symbolic link/);
  });

  it("rejects dangling links, directories, and preexisting atomic-write temporaries", () => {
    const root = home();
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile);
    const settings = path.join(profile, "settings.json");
    fs.symlinkSync(path.join(root, "missing"), settings);
    expect(() => provisionAgentHooksInDirectory(root, profile, "claude")).toThrow(/symbolic link/);
    fs.unlinkSync(settings);
    fs.mkdirSync(settings);
    expect(() => provisionAgentHooksInDirectory(root, profile, "claude")).toThrow(/regular file/);
    fs.rmdirSync(settings);
    fs.writeFileSync(settings + "." + process.pid + ".tmp", "do not clobber");
    expect(() => provisionAgentHooksInDirectory(root, profile, "claude")).toThrow(/already exists/);
    expect(fs.readFileSync(settings + "." + process.pid + ".tmp", "utf8")).toBe("do not clobber");
    const hook = path.join(root, AGENT_STATE_HOOK_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.unlinkSync(hook);
    fs.symlinkSync(path.join(root, "unrelated"), hook + "." + process.pid + ".tmp");
    expect(() => installAgentStateHook(root)).toThrow(/already exists/);
  });

  it("creates private state directories and the hook writes incrementing records", () => {
    const root = home();
    const appStateDirectory = path.dirname(stateRunsDirectory(root));
    fs.mkdirSync(appStateDirectory, { recursive: true });
    fs.chmodSync(appStateDirectory, 0o755);
    const directory = ensureStateRunsDirectory(root);
    expect(directory).toBe(stateRunsDirectory(root));
    expect(fs.statSync(path.dirname(directory)).mode & 0o777).toBe(0o755);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const script = installAgentStateHook(root);
    const stateFile = path.join(directory, "run-41.json");
    const env = {
      ...process.env,
      HOME: root,
      AI_MISSION_MANAGER_RUN_ID: "41",
      AI_MISSION_MANAGER_STATE_FILE: stateFile,
    };
    for (const state of ["working", "blocked", "finished"]) {
      const result = spawnSync("/bin/sh", [script, state, "claude"], {
        env,
        input: '{"opaque":true}',
      });
      expect(result.status).toBe(0);
    }
    const record = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(record).toMatchObject({ agent: "claude", runId: "41", state: "finished", sequence: 3 });
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    fs.writeFileSync(
      path.join(directory, "run-42.json"),
      '{"agent":"codex","runId":"42","state":"working","updatedAt":"now"}',
    );
    expect(readStateFile(path.join(directory, "run-42.json")).sequence).toBeUndefined();
    expect(
      spawnSync("/bin/sh", [script, "blocked", "claude"], {
        env: { ...env, AI_MISSION_MANAGER_RUN_ID: "42" },
        input: "ignored",
      }).status,
    ).toBe(1);
  });

  it("drains opaque input, and keeps a record if atomic replacement fails", () => {
    const root = home();
    const script = installAgentStateHook(root);
    expect(
      spawnSync("/bin/sh", [script, "working", "claude"], {
        env: { ...process.env, HOME: root },
        input: "not-json",
      }).status,
    ).toBe(0);
    const directory = ensureStateRunsDirectory(root);
    const target = path.join(directory, "run-8.json");
    const original =
      '{"agent":"claude","runId":"8","state":"blocked","updatedAt":"old","sequence":4}\n';
    fs.writeFileSync(target, original, { mode: 0o600 });
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const fakeMv = path.join(bin, "mv");
    fs.writeFileSync(fakeMv, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    fs.chmodSync(fakeMv, 0o700);
    const result = spawnSync("/bin/sh", [script, "finished", "claude"], {
      env: {
        ...process.env,
        HOME: root,
        PATH: bin + path.delimiter + (process.env.PATH ?? ""),
        AI_MISSION_MANAGER_RUN_ID: "8",
        AI_MISSION_MANAGER_STATE_FILE: target,
      },
      input: "opaque",
    });
    expect(result.status).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe(original);

    const notifyBin = path.join(root, "notify-bin");
    fs.mkdirSync(notifyBin);
    const tmux = path.join(notifyBin, "tmux");
    fs.writeFileSync(tmux, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    fs.chmodSync(tmux, 0o700);
    const notifyResult = spawnSync("/bin/sh", [script, "working", "claude"], {
      env: {
        ...process.env,
        HOME: root,
        PATH: notifyBin + path.delimiter + (process.env.PATH ?? ""),
        AI_MISSION_MANAGER_RUN_ID: "9",
        AI_MISSION_MANAGER_STATE_FILE: path.join(directory, "run-9.json"),
        AI_MISSION_MANAGER_TMUX_PATH: tmux,
        AI_MISSION_MANAGER_TMUX_SOCKET: "private",
        AI_MISSION_MANAGER_PANE_ID: "%9",
      },
      input: "opaque",
    });
    expect(notifyResult.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "run-9.json"), "utf8")).state).toBe(
      "working",
    );
  });

  it("provisions hooks in a selected profile while keeping the hook machine-scoped", () => {
    const root = home();
    const claudeProfile = path.join(root, "profiles/claude");
    const codexProfile = path.join(root, "profiles/codex");
    fs.mkdirSync(claudeProfile, { recursive: true });
    fs.mkdirSync(codexProfile, { recursive: true });
    provisionAgentHooksInDirectory(root, claudeProfile, "claude");
    provisionAgentHooksInDirectory(root, codexProfile, "codex");
    expect(fs.existsSync(path.join(root, AGENT_STATE_HOOK_RELATIVE_PATH))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(claudeProfile, "settings.json"), "utf8")).hooks
        .SessionStart,
    ).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(codexProfile, "hooks.json"), "utf8")).hooks
        .PermissionRequest,
    ).toHaveLength(1);
  });

  it("streams remote hook/config writes over MachineAccess stdin with private modes", async () => {
    const calls: { command: string; input?: Uint8Array }[] = [];
    const remote = {
      id: 1,
      context_id: 1,
      name: "remote",
      socket_name: "test",
      last_observed: "unknown",
      last_observed_at: null,
      transport: {
        kind: "ssh",
        host: "host",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      },
    } as unknown as import("../domain/types").Machine;
    const access = {
      runShell: async (_machine: unknown, command: string, input?: Uint8Array) => {
        calls.push({ command, input });
        return calls.length === 1
          ? '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"custom"}]}]}}'
          : "";
      },
    };
    await provisionAgentState(
      remote,
      access as never,
      "/home/remote",
      "claude",
      "/home/remote/profile",
    );
    expect(calls).toHaveLength(2);
    expect(spawnSync("/bin/sh", ["-n", "-c", calls[0]!.command]).status).toBe(0);
    expect(spawnSync("/bin/sh", ["-n", "-c", calls[1]!.command]).status).toBe(0);
    expect(calls[0]!.command).toContain("chmod 700");
    expect(calls[0]!.command).toContain("elif [ ! -d");
    expect(calls[0]!.command).toContain('[ ! -L "$file" ]');
    expect(calls[0]!.command).toContain('[ ! -L "$provider_config" ]');
    expect(calls[0]!.command).toContain('[ ! -e "$provider_config" ] || [ -f "$provider_config" ]');
    expect(calls[1]!.command).toContain("chmod 600");
    expect(calls[1]!.input).toBeInstanceOf(Buffer);
    expect(JSON.parse(Buffer.from(calls[1]!.input!).toString()).hooks.SessionStart).toHaveLength(2);
  });

  it("handles concurrent first-time remote hook provisioning", async () => {
    const root = home();
    const remote = {
      id: 1,
      context_id: 1,
      name: "remote",
      socket_name: "test",
      last_observed: "unknown",
      last_observed_at: null,
      transport: {
        kind: "ssh",
        host: "host",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      },
    } as unknown as import("../domain/types").Machine;
    let firstCalls = 0;
    let release: (() => void) | undefined;
    const firstCallBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runShell = async (_machine: unknown, command: string, input?: Uint8Array) => {
      if (!input) {
        firstCalls += 1;
        if (firstCalls === 2) release?.();
        await firstCallBarrier;
      }
      return await new Promise<string>((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) reject(new Error(Buffer.concat(stderr).toString("utf8")));
          else resolve(Buffer.concat(stdout).toString("utf8"));
        });
        child.stdin.end(input ? Buffer.from(input) : undefined);
      });
    };
    const access = { runShell };
    await Promise.all([
      provisionAgentState(remote, access as never, root, "claude"),
      provisionAgentState(remote, access as never, root, "claude"),
    ]);
    const hook = path.join(root, AGENT_STATE_HOOK_RELATIVE_PATH);
    const settings = path.join(root, ".claude/settings.json");
    expect(fs.readFileSync(hook, "utf8")).toBe(AGENT_STATE_HOOK_SCRIPT);
    expect(fs.statSync(path.join(root, ".local/share/ai-mission-manager")).mode & 0o777).toBe(
      0o700,
    );
    expect(fs.statSync(path.dirname(hook)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(hook).mode & 0o777).toBe(0o700);
    expect(fs.statSync(settings).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.SessionStart).toHaveLength(1);
  });

  it("removes legacy app hooks while preserving unrelated entries", () => {
    const script =
      "/home/user/.local/share/ai-mission-manager/hooks/ai-mission-manager-agent-state-hook.sh";
    const existing = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "'/old/.local/share/ai-mission-manager/hooks/ai-mission-manager-agent-state-hook.sh' finished claude",
              },
              { type: "command", command: "my-custom-command" },
            ],
          },
        ],
      },
    });
    const merged = JSON.parse(mergeProviderHooks(existing, script, "claude"));
    expect(merged.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "my-custom-command" }] },
      { hooks: [{ type: "command", command: "'" + script + "' finished claude" }] },
    ]);
  });
});
