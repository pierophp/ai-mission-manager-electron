import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile as writeFileFs,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Machine } from "../domain/types";
import { cleanMachineTransport } from "../domain/machine-transport";
import {
  buildMachineCheckCommand,
  buildMachineShellArgv,
  LocalSshMachineAccess,
  shellQuote,
} from "./machine-access";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const localMachine: Machine = {
  id: 1,
  context_id: 1,
  name: "Local",
  socket_name: "mission-check-test",
  transport: { kind: "local" },
  last_observed: "unknown",
  last_observed_at: null,
};

describe("MachineAccess", () => {
  it("runs local commands through a login shell", () => {
    expect(buildMachineShellArgv({ kind: "local" }, "printf ok")).toEqual({
      program: "sh",
      args: ["-lc", "printf ok"],
    });
  });

  it("keeps SSH options in argv and forces non-interactive batch mode", () => {
    expect(
      buildMachineShellArgv(
        {
          kind: "ssh",
          host: "build.example",
          user: "piero",
          port: 2222,
          identityFile: "/tmp/key file",
          knownHostsFile: "/tmp/known hosts",
          strictHostKeyChecking: "accept-new",
        },
        "tmux -V",
      ),
    ).toEqual({
      program: "ssh",
      args: [
        "-T",
        "-o",
        "BatchMode=yes",
        "-p",
        "2222",
        "-i",
        "/tmp/key file",
        "-o",
        "UserKnownHostsFile=/tmp/known hosts",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "piero@build.example",
        "tmux -V",
      ],
    });
  });

  it("shell-quotes apostrophes and rejects unsupported SSH settings", () => {
    expect(shellQuote("a'b c")).toBe(`'a'"'"'b c'`);
    expect(() =>
      cleanMachineTransport({
        kind: "ssh",
        host: "bad host",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      }),
    ).toThrow("a remote Machine host contains unsupported characters");
    expect(() =>
      cleanMachineTransport({
        kind: "ssh",
        host: "host",
        user: null,
        port: 0,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      }),
    ).toThrow("a remote Machine SSH port must be positive");
    expect(() =>
      cleanMachineTransport({
        kind: "ssh",
        host: "host",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: "ask",
      }),
    ).toThrow("a remote Machine host-key checking mode is unsupported");
    expect(() =>
      cleanMachineTransport({
        kind: "ssh",
        host: "host",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: "",
      }),
    ).toThrow("a remote Machine host-key checking mode is unsupported");
  });

  it("writes a local file through a private temporary file and atomic rename", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "machine-access-test-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "nested", "profile.json");
    await new LocalSshMachineAccess().writeFile(localMachine, target, Buffer.from("profile"));
    expect(await readFile(target, "utf8")).toBe("profile");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("writes remote bytes atomically over SSH stdin", async () => {
    let invocation: { program: string; args: string[]; input?: Uint8Array } | undefined;
    const access = new LocalSshMachineAccess(async (program, args, input) => {
      invocation = { program, args, input };
      return { stdout: Buffer.from(""), stderr: Buffer.from(""), code: 0 };
    });
    const remote = {
      ...localMachine,
      transport: {
        kind: "ssh" as const,
        host: "build.example",
        user: "runner",
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: "yes",
      },
    };
    const contents = Buffer.from("remote profile");
    await access.writeFile(remote, "/home/runner/.config/profile.json", contents);
    expect(invocation?.program).toBe("ssh");
    expect(invocation?.args.slice(0, 3)).toEqual(["-T", "-o", "BatchMode=yes"]);
    expect(invocation?.args.at(-1)).toContain('temporary="$target.tmp.$$"');
    expect(invocation?.args.at(-1)).toContain('mv -f "$temporary" "$target"');
    expect(Buffer.from(invocation?.input ?? []).equals(contents)).toBe(true);
  });

  it("resolves a remote home and executable through SSH shell commands", async () => {
    const commands: string[] = [];
    const access = new LocalSshMachineAccess(async (_program, args) => {
      const command = args.at(-1) ?? "";
      commands.push(command);
      const stdout = command.includes("$HOME") ? "/home/runner" : "/opt/codex/bin/codex";
      return { stdout: Buffer.from(stdout), stderr: Buffer.from(""), code: 0 };
    });
    const remote = {
      ...localMachine,
      transport: {
        kind: "ssh" as const,
        host: "build.example",
        user: "runner",
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      },
    };
    expect(await access.machineHome(remote)).toBe("/home/runner");
    expect(await access.findExecutable(remote, "codex")).toBe("/opt/codex/bin/codex");
    expect(commands).toEqual(["printf '%s' \"$HOME\"", "command -v 'codex' || true"]);
  });

  it("keeps a reachable Machine online when tmux is missing and still checks Bun/state storage", async () => {
    const commands: string[] = [];
    const access = new LocalSshMachineAccess(async (_program, args) => {
      const command = args.at(-1) ?? "";
      commands.push(command);
      if (command.includes("command -v bun"))
        return { stdout: Buffer.from("/usr/bin/bun"), stderr: Buffer.from(""), code: 0 };
      if (command.includes("tmux -f /dev/null"))
        return { stdout: Buffer.from(""), stderr: Buffer.from("tmux is unavailable"), code: 1 };
      return { stdout: Buffer.from("/home/runner"), stderr: Buffer.from(""), code: 0 };
    });
    const remote = {
      ...localMachine,
      transport: {
        kind: "ssh" as const,
        host: "build.example",
        user: "runner",
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      },
    };
    expect(await access.checkMachine(remote)).toMatchObject({
      reachable: true,
      tmuxAvailable: false,
      bunAvailable: true,
      bunError: null,
      stateDirectoryWritable: true,
      error: "Machine Local does not have a working tmux runtime: tmux is unavailable",
    });
    expect(commands).toHaveLength(4);
    expect(commands[3]).toContain(".local/state/ai-mission-manager/runs");
  });

  it("classifies an SSH host-key failure as unreachable before further probes", async () => {
    const commands: string[] = [];
    const access = new LocalSshMachineAccess(async (_program, args) => {
      commands.push(args.at(-1) ?? "");
      return {
        stdout: Buffer.from(""),
        stderr: Buffer.from("Host key verification failed"),
        code: 255,
      };
    });
    const remote = {
      ...localMachine,
      transport: {
        kind: "ssh" as const,
        host: "build.example",
        user: null,
        port: null,
        identityFile: null,
        knownHostsFile: null,
        strictHostKeyChecking: null,
      },
    };
    expect(await access.checkMachine(remote)).toMatchObject({
      reachable: false,
      tmuxAvailable: null,
      bunAvailable: null,
      stateDirectoryWritable: null,
      error: "Could not reach Machine Local: Host key verification failed",
    });
    expect(commands).toEqual(["printf '%s' \"$HOME\""]);
  });

  it("finds a local executable on PATH and skips executable directories", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "machine-access-path-"));
    temporaryDirectories.push(directory);
    const directoryCandidate = path.join(directory, "first", "codex");
    const executable = path.join(directory, "second", "codex");
    await mkdir(path.dirname(directoryCandidate), { recursive: true });
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(directoryCandidate);
    await chmod(directoryCandidate, 0o755);
    await writeFileFs(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [path.dirname(directoryCandidate), path.dirname(executable)].join(
      path.delimiter,
    );
    try {
      expect(await new LocalSshMachineAccess().findExecutable(localMachine, "codex")).toBe(
        executable,
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("quotes the tmux socket and uses a throwaway server for a machine check", async () => {
    const command = buildMachineCheckCommand({ ...localMachine, socket_name: "odd ' socket" });
    expect(command).toContain(`tmux -f /dev/null -L 'odd '"'"' socket' start-server`);
    expect(command).toContain(`tmux -f /dev/null -L 'odd '"'"' socket' kill-server`);
  });
});
