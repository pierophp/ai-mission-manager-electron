import { access, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cleanMachineTransport } from "../domain/machine-transport";
import type { Machine, MachineReadiness, MachineTransport } from "../domain/types";

export type MachineProbe = Pick<
  MachineReadiness,
  "reachable" | "tmuxAvailable" | "bunAvailable" | "bunError" | "stateDirectoryWritable" | "error"
>;

export type MachineCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
  timedOut?: boolean;
};
export interface MachineAccess {
  runShell(
    machine: Machine,
    command: string,
    input?: Uint8Array,
    timeoutMs?: number,
  ): Promise<string>;
  machineHome(machine: Machine): Promise<string>;
  findExecutable(machine: Machine, name: string): Promise<string>;
  writeFile(machine: Machine, target: string, contents: Uint8Array): Promise<void>;
  checkMachine(machine: Machine): Promise<MachineProbe>;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildMachineShellArgv(
  transport: MachineTransport,
  command: string,
): { program: string; args: string[] } {
  const normalized = cleanMachineTransport(transport);
  if (normalized.kind === "local") return { program: "sh", args: ["-lc", command] };
  const ssh = normalized;
  const args = ["-T", "-o", "BatchMode=yes"];
  if (ssh.port !== null) args.push("-p", String(ssh.port));
  if (ssh.identityFile) args.push("-i", ssh.identityFile);
  if (ssh.knownHostsFile) args.push("-o", `UserKnownHostsFile=${ssh.knownHostsFile}`);
  if (ssh.strictHostKeyChecking)
    args.push("-o", `StrictHostKeyChecking=${ssh.strictHostKeyChecking}`);
  args.push(`${ssh.user ? `${ssh.user}@` : ""}${ssh.host}`, command);
  return { program: "ssh", args };
}

export function buildMachineCheckCommand(machine: Machine): string {
  const socket = shellQuote(machine.socket_name);
  return `set -eu; trap 'tmux -f /dev/null -L ${socket} kill-server >/dev/null 2>&1 || true' EXIT HUP INT TERM; tmux -f /dev/null -L ${socket} start-server; tmux -f /dev/null -L ${socket} kill-server; trap - EXIT HUP INT TERM`;
}

export function buildStateDirectoryProbeCommand(): string {
  return 'set -eu; state_dir="$HOME/.local/state/ai-mission-manager/runs"; umask 077; mkdir -p "$state_dir"; temporary="$state_dir/.preflight.$$"; (set -C; : > "$temporary"); rm -f "$temporary"';
}

function run(
  program: string,
  args: string[],
  input?: Uint8Array,
  timeoutMs?: number,
): Promise<MachineCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code: code ?? 1,
        timedOut,
      });
    });
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
}

export class LocalSshMachineAccess implements MachineAccess {
  constructor(private readonly runner = run) {}

  async runShell(
    machine: Machine,
    command: string,
    input?: Uint8Array,
    timeoutMs?: number,
  ): Promise<string> {
    const { program, args } = buildMachineShellArgv(machine.transport, command);
    let result: MachineCommandResult;
    try {
      result = await this.runner(program, args, input, timeoutMs);
    } catch (error) {
      const verb = machine.transport.kind === "ssh" ? "connect to" : "inspect";
      throw new Error(
        `Could not ${verb} Machine ${machine.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.code !== 0) {
      if (result.timedOut)
        throw new Error(
          `Timed out after ${Math.ceil((timeoutMs ?? 0) / 1000)} seconds stopping a Run pane on Machine ${machine.name}`,
        );
      const detail = result.stderr.toString("utf8").trim();
      throw new Error(detail || `command exited with ${result.code}`);
    }
    return result.stdout.toString("utf8");
  }

  async machineHome(machine: Machine): Promise<string> {
    if (machine.transport.kind === "local") {
      if (!process.env.HOME) throw new Error("HOME is not set on the local Machine");
      return process.env.HOME;
    }
    const home = (await this.runShell(machine, `printf '%s' "$HOME"`)).trim();
    if (!path.posix.isAbsolute(home))
      throw new Error(`Machine ${machine.name} did not report an absolute home directory`);
    return home;
  }

  async findExecutable(machine: Machine, name: string): Promise<string> {
    if (!name || !/^[A-Za-z0-9-]+$/.test(name))
      throw new Error(`unsupported agent executable name: ${name}`);
    if (machine.transport.kind === "ssh") {
      const found = (await this.runShell(machine, `command -v ${shellQuote(name)} || true`)).trim();
      if (!found) throw new Error(`${name} is not installed on Machine ${machine.name}`);
      if (!path.posix.isAbsolute(found))
        throw new Error(`Machine ${machine.name} returned a non-absolute ${name} executable path`);
      return found;
    }
    for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        return candidate;
      } catch {
        /* try next PATH entry */
      }
    }
    throw new Error(`${name} is not installed on Machine ${machine.name}`);
  }

  async writeFile(machine: Machine, target: string, contents: Uint8Array): Promise<void> {
    if (machine.transport.kind === "ssh") {
      const quoted = shellQuote(target);
      const command = `set -eu; umask 077; target=${quoted}; parent=$(dirname "$target"); mkdir -p "$parent"; temporary="$target.tmp.$$"; trap 'rm -f "$temporary"' EXIT HUP INT TERM; cat > "$temporary"; chmod 600 "$temporary"; mv -f "$temporary" "$target"; trap - EXIT HUP INT TERM`;
      await this.runShell(machine, command, contents);
      return;
    }
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const temporary = `${target}.tmp.${process.pid}`;
    try {
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => undefined);
      throw new Error(
        `Could not install generated file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async checkMachine(machine: Machine) {
    if (machine.transport.kind === "ssh") {
      try {
        const home = (await this.runShell(machine, `printf '%s' "$HOME"`)).trim();
        if (!path.posix.isAbsolute(home))
          return {
            reachable: true,
            tmuxAvailable: null,
            bunAvailable: null,
            bunError: null,
            stateDirectoryWritable: null,
            error: `Machine ${machine.name} did not report an absolute home directory`,
          };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          reachable: false,
          tmuxAvailable: null,
          bunAvailable: null,
          bunError: null,
          stateDirectoryWritable: null,
          error: `Could not reach Machine ${machine.name}: ${detail}`,
        };
      }
    } else {
      try {
        await this.machineHome(machine);
      } catch (error) {
        return {
          reachable: true,
          tmuxAvailable: null,
          bunAvailable: null,
          bunError: null,
          stateDirectoryWritable: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    let bunAvailable = false;
    let bunError: string | null = null;
    if (machine.transport.kind === "local") {
      try {
        await this.findExecutable(machine, "bun");
        bunAvailable = true;
      } catch {
        bunAvailable = false;
      }
    } else {
      try {
        bunAvailable = Boolean((await this.runShell(machine, "command -v bun")).trim());
      } catch (probeError) {
        bunError = `Could not check Bun on Machine ${machine.name}: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
      }
    }

    const command = buildMachineCheckCommand(machine);
    let tmuxAvailable = true;
    let error: string | null = null;
    try {
      await this.runShell(machine, command);
    } catch (tmuxFailure) {
      const message = tmuxFailure instanceof Error ? tmuxFailure.message : String(tmuxFailure);
      tmuxAvailable = false;
      error = `Machine ${machine.name} does not have a working tmux runtime: ${message}`;
    }

    let stateDirectoryWritable = false;
    try {
      await this.runShell(machine, buildStateDirectoryProbeCommand());
      stateDirectoryWritable = true;
    } catch (stateError) {
      if (error === null)
        error = `Agent state directory is not writable on Machine ${machine.name}: ${stateError instanceof Error ? stateError.message : String(stateError)}`;
    }
    return {
      reachable: true,
      tmuxAvailable,
      bunAvailable,
      bunError,
      stateDirectoryWritable,
      error,
    };
  }
}

export class FakeMachineAccess implements MachineAccess {
  readonly calls: { machineId: number; operation: string; command?: string; input?: Uint8Array }[] =
    [];
  shellGate?: Promise<void>;
  onShellStart?: () => void;
  constructor(
    private readonly commandOutput = "",
    private readonly checkResult: MachineProbe = {
      reachable: true,
      tmuxAvailable: true,
      bunAvailable: true,
      bunError: null,
      stateDirectoryWritable: true,
      error: null as string | null,
    },
  ) {}
  async runShell(
    machine: Machine,
    command: string,
    input?: Uint8Array,
    _timeoutMs?: number,
  ): Promise<string> {
    this.calls.push({ machineId: machine.id, operation: "shell", command, input });
    this.onShellStart?.();
    await this.shellGate;
    return this.commandOutput;
  }
  async machineHome(machine: Machine): Promise<string> {
    this.calls.push({ machineId: machine.id, operation: "home" });
    return "/home/test";
  }
  async findExecutable(machine: Machine, name: string): Promise<string> {
    this.calls.push({ machineId: machine.id, operation: `which:${name}` });
    return `/usr/bin/${name}`;
  }
  async writeFile(machine: Machine, target: string, contents: Uint8Array): Promise<void> {
    this.calls.push({ machineId: machine.id, operation: `write:${target}`, input: contents });
  }
  async checkMachine(machine: Machine) {
    this.calls.push({ machineId: machine.id, operation: "check" });
    return this.checkResult;
  }
}
