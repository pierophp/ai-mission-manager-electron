import type { Machine, MachineObservationFailureKind } from "../domain/types";
import type { AgentKind, RunState } from "../domain/execution-types";
import { buildMachineShellArgv, shellQuote, type MachineAccess } from "./machine-access";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const AGENT_STATE_OPTION = "@ai_mission_manager_run_state";
export type AgentStateRecord = {
  agent: AgentKind;
  runId: string;
  state: RunState;
  updatedAt: string;
  sequence?: number;
};
export type ObservedPane = {
  sessionName: string;
  paneId: string;
  agentState: AgentStateRecord | null;
};
export type MachineObservation = {
  panes: ObservedPane[] | { error: string; kind: MachineObservationFailureKind };
  stateRecords: AgentStateRecord[];
};
export type AgentPaneSummary = {
  agent: AgentKind;
  sessionName: string;
  paneId: string;
  currentPath: string;
};
export type PaneSummary = {
  paneId: string;
  paneIndex: number;
  panePid: number;
  paneWidth: number;
  paneHeight: number;
  paneTitle: string;
  currentCommand: string;
  currentPath: string;
};
/** A live connection seam used by terminal consumers that need more than one-shot tmux commands. */
export interface TerminalConnection {
  sendInput(input: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  capturePaneSnapshot(afterCapture?: () => void): Promise<Uint8Array>;
  close(): Promise<void>;
}
export type TerminalConnectionCallbacks = {
  onOutput: (data: Uint8Array) => void;
  onAgentState: (record: AgentStateRecord) => void;
  onExit: (code: number | null) => void;
};
export interface TerminalRuntime {
  attachConnection?(
    machine: Machine,
    sessionName: string,
    paneId: string,
    callbacks: TerminalConnectionCallbacks,
  ): Promise<TerminalConnection>;
  observeMachine(machine: Machine, runIds: number[]): Promise<MachineObservation>;
  listPanes(machine: Machine, sessionName: string): Promise<PaneSummary[]>;
  listAgentPanes(machine: Machine): Promise<AgentPaneSummary[]>;
  capturePaneTranscript(machine: Machine, paneId: string): Promise<string>;
  sendPaneInput(machine: Machine, paneId: string, input: Uint8Array): Promise<void>;
  killSession(machine: Machine, sessionName: string): Promise<void>;
  killPane(machine: Machine, sessionName: string, paneId: string): Promise<void>;
  killPaneWithTimeout(machine: Machine, paneId: string, timeoutMs: number): Promise<void>;
  interruptPane(machine: Machine, sessionName: string, paneId: string): Promise<void>;
}

function tmuxPrefix(machine: Machine, executable: string): string {
  return `${shellQuote(machine.transport.kind === "local" ? executable : "tmux")} -f /dev/null -L ${shellQuote(machine.socket_name)}`;
}
export function parseAgentStateRecord(raw: string): AgentStateRecord | null {
  try {
    const value = JSON.parse(raw.trim()) as Record<string, unknown>;
    if (
      (value.agent !== "claude" && value.agent !== "codex") ||
      typeof value.runId !== "string" ||
      !/^\d+$/.test(value.runId) ||
      !["unknown", "working", "blocked", "finished"].includes(String(value.state)) ||
      typeof value.updatedAt !== "string"
    )
      return null;
    if (
      value.sequence !== undefined &&
      (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0)
    )
      return null;
    return {
      agent: value.agent,
      runId: value.runId,
      state: value.state as RunState,
      updatedAt: value.updatedAt,
      ...(value.sequence === undefined ? {} : { sequence: value.sequence as number }),
    };
  } catch {
    return null;
  }
}
export function parseTmuxPanes(output: string): ObservedPane[] {
  if (!output.trim()) return [];
  return output
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const [sessionName, paneId, ...rest] = line.split("\t");
      if (!sessionName || !paneId || rest.length !== 1)
        throw new Error("Could not parse Machine tmux Pane observation");
      return { sessionName, paneId, agentState: parseAgentStateRecord(rest[0]!) };
    });
}
export function parseAgentPanes(output: string): AgentPaneSummary[] {
  if (!output.trim()) return [];
  return output
    .replace(/\n$/, "")
    .split("\n")
    .flatMap((line) => {
      const fields = line.split("\t");
      if (fields.length !== 5)
        throw new Error(`tmux returned an invalid agent Pane description: ${line}`);
      const command = [fields[2], fields[3]].map((value) =>
        value!.trim().split(/\s+/)[0]!.split("/").pop()!.toLowerCase(),
      );
      const agent =
        command.includes("claude") || command.includes("claude-code")
          ? "claude"
          : command.includes("codex")
            ? "codex"
            : null;
      return agent
        ? [{ agent, sessionName: fields[0]!, paneId: fields[1]!, currentPath: fields[4]! }]
        : [];
    });
}
export function parsePaneSummary(output: string): PaneSummary[] {
  if (!output.trim()) return [];
  return output
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 8)
        throw new Error(`tmux returned an invalid Pane description: ${line}`);
      return {
        paneId: fields[0]!,
        paneIndex: parsePaneNumber(fields[1]!, "Pane index", 0xffff_ffff),
        panePid: parsePaneNumber(fields[2]!, "Pane process ID", 0xffff_ffff),
        paneWidth: parsePaneNumber(fields[3]!, "Pane columns", 0xffff),
        paneHeight: parsePaneNumber(fields[4]!, "Pane rows", 0xffff),
        paneTitle: fields[5]!,
        currentCommand: fields[6]!,
        currentPath: fields[7]!,
      };
    });
}
function parsePaneNumber(value: string, label: string, maximum: number): number {
  if (!value || !/^\+?\d+$/.test(value)) {
    const parseError = value
      ? "invalid digit found in string"
      : "cannot parse integer from empty string";
    throw new Error(`${label} is invalid: ${parseError}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum)
    throw new Error(`${label} is invalid: number too large to fit in target type`);
  return parsed;
}
function sshUnreachable(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "could not resolve hostname",
    "connection refused",
    "connection timed out",
    "operation timed out",
    "no route to host",
    "network is unreachable",
    "connection reset by peer",
    "connection closed by",
    "ssh: connect to host",
    "permission denied (publickey",
    "host key verification failed",
  ].some((pattern) => lower.includes(pattern));
}
export function buildStateFileReadCommand(runIds: number[]): string | null {
  const ids = [...new Set(runIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort(
    (a, b) => a - b,
  );
  if (!ids.length) return null;
  return `set -eu; state_dir="$HOME/.local/state/ai-mission-manager/runs"; for run_id in ${ids.join(" ")}; do state_file="$state_dir/run-$run_id.json"; if [ -f "$state_file" ] && [ ! -L "$state_file" ] && [ -r "$state_file" ]; then printf '%s\\000' "$run_id"; if cat "$state_file"; then :; fi; printf '\\000'; fi; done`;
}
export function parseStateFilesRead(contents: string, requestedIds: number[]): AgentStateRecord[] {
  const wanted = new Set(requestedIds.filter((id) => id > 0));
  const last = contents.lastIndexOf("\0");
  if (last < 0) return [];
  const fields = contents.slice(0, last).split("\0");
  const records: AgentStateRecord[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const pathId = Number(fields[i]);
    const record = parseAgentStateRecord(fields[i + 1]!);
    if (wanted.has(pathId) && record?.runId === String(pathId)) records.push(record);
  }
  return records;
}
export class TmuxTerminalRuntime implements TerminalRuntime {
  constructor(
    private readonly machineAccess: MachineAccess,
    readonly tmuxExecutable = "tmux",
  ) {}
  async attachConnection(
    machine: Machine,
    sessionName: string,
    paneId: string,
    callbacks: TerminalConnectionCallbacks,
  ): Promise<TerminalConnection> {
    validateTmuxTarget(sessionName);
    validatePaneId(paneId);
    return TmuxControlConnection.attach(
      machine,
      this.tmuxExecutable,
      sessionName,
      paneId,
      callbacks,
    );
  }
  async observeMachine(machine: Machine, runIds: number[]): Promise<MachineObservation> {
    let panes: ObservedPane[] | { error: string; kind: MachineObservationFailureKind };
    const format = `#{session_name}\t#{pane_id}\t#{${AGENT_STATE_OPTION}}`;
    try {
      const output = await this.machineAccess.runShell(
        machine,
        `${tmuxPrefix(machine, this.tmuxExecutable)} list-panes -a -F ${shellQuote(format)}`,
      );
      panes = parseTmuxPanes(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      panes = {
        error: message,
        kind:
          machine.transport.kind === "ssh" && sshUnreachable(message)
            ? "unreachable"
            : "tmuxQueryFailed",
      };
    }
    let stateRecords: AgentStateRecord[] = [];
    const command = buildStateFileReadCommand(runIds);
    if (command) {
      try {
        stateRecords = parseStateFilesRead(
          await this.machineAccess.runShell(machine, command),
          runIds,
        );
      } catch {
        /* the pane option remains a fallback */
      }
    }
    return { panes, stateRecords };
  }
  async listPanes(machine: Machine, sessionName: string): Promise<PaneSummary[]> {
    validateTmuxTarget(sessionName);
    const format =
      "#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_width}\t#{pane_height}\t#{pane_title}\t#{pane_current_command}\t#{pane_current_path}";
    return parsePaneSummary(
      await this.machineAccess.runShell(
        machine,
        `${tmuxPrefix(machine, this.tmuxExecutable)} list-panes -t ${shellQuote(sessionName)} -F ${shellQuote(format)}`,
      ),
    );
  }
  async listAgentPanes(machine: Machine): Promise<AgentPaneSummary[]> {
    const format =
      "#{session_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}";
    return parseAgentPanes(
      await this.machineAccess.runShell(
        machine,
        `${tmuxPrefix(machine, this.tmuxExecutable)} list-panes -a -F ${shellQuote(format)}`,
      ),
    );
  }
  async capturePaneTranscript(machine: Machine, paneId: string): Promise<string> {
    validatePaneId(paneId);
    return this.machineAccess.runShell(
      machine,
      `${tmuxPrefix(machine, this.tmuxExecutable)} capture-pane -p -e -J -S - -t ${shellQuote(paneId)}`,
    );
  }
  async sendPaneInput(machine: Machine, paneId: string, input: Uint8Array): Promise<void> {
    validatePaneId(paneId);
    if (!input.length) return;
    const hex = [...input].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    await this.machineAccess.runShell(
      machine,
      `${tmuxPrefix(machine, this.tmuxExecutable)} send-keys -H -t ${shellQuote(paneId)} ${hex}`,
    );
  }
  async killSession(machine: Machine, sessionName: string): Promise<void> {
    if (!/^[A-Za-z0-9_$@%+.,:=~-]+$/.test(sessionName))
      throw new Error(`invalid tmux target: ${sessionName}`);
    await this.machineAccess.runShell(
      machine,
      `${tmuxPrefix(machine, this.tmuxExecutable)} kill-session -t ${shellQuote(sessionName)}`,
    );
  }
  async killPane(machine: Machine, sessionName: string, paneId: string): Promise<void> {
    validateTmuxTarget(sessionName);
    validatePaneId(paneId);
    await this.machineAccess.runShell(
      machine,
      `${tmuxPrefix(machine, this.tmuxExecutable)} kill-pane -t ${shellQuote(`${sessionName}:${paneId}`)}`,
    );
  }
  async killPaneWithTimeout(machine: Machine, paneId: string, timeoutMs: number): Promise<void> {
    validatePaneId(paneId);
    await this.machineAccess.runShell(
      machine,
      `${tmuxPrefix(machine, this.tmuxExecutable)} kill-pane -t ${shellQuote(paneId)}`,
      undefined,
      timeoutMs,
    );
  }
  async interruptPane(machine: Machine, sessionName: string, paneId: string): Promise<void> {
    validateTmuxTarget(sessionName);
    validatePaneId(paneId);
    await this.machineAccess.runShell(
      machine,
      `${tmuxPrefix(machine, this.tmuxExecutable)} send-keys -t ${shellQuote(`${sessionName}:${paneId}`)} C-c`,
    );
  }
}

function validatePaneId(value: string): void {
  if (!/^%[0-9]+$/.test(value)) throw new Error(`invalid tmux Pane identity: ${value}`);
}
function validateTmuxTarget(value: string): void {
  if (!value || !/^[A-Za-z0-9_$@%+.,:=~-]+$/.test(value))
    throw new Error(`tmux target contains unsupported characters: ${value}`);
}

type ControlResponse = {
  resolve?: (value: Buffer) => void;
  reject?: (error: Error) => void;
  afterEnd?: () => void;
};

/** Persistent tmux control-mode connection; every response is paired FIFO with its command. */
export class TmuxControlConnection implements TerminalConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: ControlResponse[] = [];
  private current: ControlResponse | undefined;
  private currentHeader = "";
  private responseBody: Buffer[] = [];
  private lineBuffer = Buffer.alloc(0);
  private closed = false;
  private finished = false;
  private processError?: Error;

  private constructor(
    private readonly paneId: string,
    child: ChildProcessWithoutNullStreams,
    private readonly callbacks: TerminalConnectionCallbacks,
  ) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.once("error", (error) => {
      this.processError = error;
      this.finish(error);
    });
    child.once("close", (code) => this.finish(undefined, code));
  }

  static async attach(
    machine: Machine,
    tmuxExecutable: string,
    sessionName: string,
    paneId: string,
    callbacks: TerminalConnectionCallbacks,
  ): Promise<TmuxControlConnection> {
    const executable = machine.transport.kind === "local" ? tmuxExecutable : "tmux";
    const command = `${shellQuote(executable)} -C -f /dev/null -L ${shellQuote(machine.socket_name)} attach-session -t ${shellQuote(sessionName)}`;
    const shell =
      machine.transport.kind === "local"
        ? {
            program: executable,
            args: [
              "-C",
              "-f",
              "/dev/null",
              "-L",
              machine.socket_name,
              "attach-session",
              "-t",
              sessionName,
            ],
          }
        : buildMachineShellArgv(machine.transport, `exec ${command}`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell.program, shell.args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.resume();
    } catch (error) {
      throw new Error(
        `Could not attach to Pane on Machine ${machine.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const connection = new TmuxControlConnection(paneId, child, callbacks);
    try {
      await connection.command("list-panes", 2000);
      await connection.command(
        `refresh-client -B ${shellQuote(`mission-manager-agent-state:${paneId}:#{${AGENT_STATE_OPTION}}`)}`,
        2000,
      );
      return connection;
    } catch (error) {
      await connection.close();
      if (connection.processError)
        throw new Error(
          `Could not attach to Pane on Machine ${machine.name}: ${connection.processError.message}`,
        );
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async sendInput(input: Uint8Array): Promise<void> {
    if (!input.length) return;
    const bytes = [...input].map((byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(" ");
    await this.command(`send-keys -t ${this.paneId} -H ${bytes}`);
  }
  async resize(columns: number, rows: number): Promise<void> {
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns <= 0 || rows <= 0)
      throw new Error("Pane dimensions must be positive");
    await this.command(`refresh-client -C ${columns},${rows}`);
  }
  async capturePaneSnapshot(afterCapture?: () => void): Promise<Uint8Array> {
    const first = this.enqueueResponse();
    const second = this.enqueueResponse(afterCapture);
    this.write(
      `capture-pane -p -e -t ${this.paneId} ; display-message -p -t ${this.paneId} '#{cursor_x} #{cursor_y}'`,
    );
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Could not capture Pane snapshot: timeout");
        this.fail(error);
        reject(error);
      }, 15000);
    });
    let screen: Buffer;
    let cursor: Buffer;
    try {
      [screen, cursor] = await Promise.race([Promise.all([first, second]), timeout]);
    } finally {
      clearTimeout(timer!);
    }
    const text = cursor.toString("utf8").trim().split(" ");
    const x = Number(text[0]);
    const y = Number(text[1]);
    const rows = screen.toString("utf8").replace(/\n$/, "").split("\n");
    while (rows.length > 1 && rows.at(-1) === "") rows.pop();
    const snapshot = Buffer.from(
      rows.join("\r\n") +
        "\x1b[0m" +
        (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0
          ? `\x1b[${y + 1};${x + 1}H`
          : ""),
    );
    return snapshot;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.child.kill();
    await exited;
  }
  private enqueueResponse(afterEnd?: () => void): Promise<Buffer> {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject, afterEnd }));
  }
  private command(command: string, timeoutMs = 15000): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error("tmux control client is closed"));
    const response = this.enqueueResponse();
    try {
      this.write(command);
    } catch (error) {
      return Promise.reject(error);
    }
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("tmux control command timed out");
        this.fail(error);
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([response, timeout]).finally(() => clearTimeout(timer!));
  }
  private write(command: string): void {
    if (this.closed || !this.child.stdin.writable) throw new Error("tmux control client is closed");
    this.child.stdin.write(`${command}\n`, (error) => {
      if (error) this.finish(error);
    });
  }
  private consume(chunk: Buffer): void {
    this.lineBuffer = Buffer.concat([this.lineBuffer, chunk]);
    let newline: number;
    while ((newline = this.lineBuffer.indexOf(10)) >= 0) {
      const line = this.lineBuffer.subarray(0, newline + 1);
      this.lineBuffer = this.lineBuffer.subarray(newline + 1);
      this.handleLine(line);
    }
  }
  private handleLine(raw: Buffer): void {
    let line = raw;
    if (line.at(-1) === 10) line = line.subarray(0, -1);
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    const text = line.toString("utf8");
    if (this.handleNotification(line, text)) return;
    if (!this.current && text.startsWith("%begin ")) {
      this.currentHeader = text.slice(7);
      this.current = this.pending.shift() ?? {};
      this.responseBody = [];
      return;
    }
    if (this.current && text === `%end ${this.currentHeader}`) {
      const response = this.current;
      const body = Buffer.concat(this.responseBody);
      response.afterEnd?.();
      response.resolve?.(body);
      this.current = undefined;
      this.currentHeader = "";
      this.responseBody = [];
      return;
    }
    if (this.current && text === `%error ${this.currentHeader}`) {
      const response = this.current;
      const detail = Buffer.concat(this.responseBody).toString("utf8").trim();
      response.reject?.(new Error(detail || "tmux control command failed"));
      this.current = undefined;
      this.currentHeader = "";
      this.responseBody = [];
      return;
    }
    if (this.current) {
      this.responseBody.push(raw);
      return;
    }
  }
  private handleNotification(line: Buffer, text: string): boolean {
    if (line.subarray(0, 8).equals(Buffer.from("%output "))) {
      const space = line.indexOf(32, 8);
      if (space >= 0 && line.subarray(8, space).toString("ascii") === this.paneId)
        this.callbacks.onOutput(decodeControlOutput(line.subarray(space + 1)));
      return true;
    }
    if (line.subarray(0, 22).equals(Buffer.from("%subscription-changed "))) {
      const rest = text.slice(22);
      const sep = rest.indexOf(" : ");
      if (sep < 0) return true;
      const fields = rest.slice(0, sep).split(/\s+/);
      if (fields[0] !== "mission-manager-agent-state" || fields[4] !== this.paneId) return true;
      try {
        const record = parseAgentStateRecord(rest.slice(sep + 3));
        if (record) this.callbacks.onAgentState(record);
      } catch {
        /* Ignore malformed subscription payloads. */
      }
      return true;
    }
    return false;
  }
  private finish(error?: Error, code: number | null = null): void {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    if (this.current)
      this.current.reject?.(new Error("tmux control client closed during a command"));
    for (const response of this.pending.splice(0))
      response.reject?.(new Error("tmux control client closed before a command completed"));
    if (error) this.callbacks.onExit(null);
    else this.callbacks.onExit(code);
  }
  private fail(error: Error): void {
    this.finish(error);
    this.child.kill();
  }
}

export function decodeControlOutput(encoded: Uint8Array): Uint8Array {
  const bytes = Buffer.from(encoded);
  const output: number[] = [];
  for (let index = 0; index < bytes.length;) {
    if (
      bytes[index] === 92 &&
      index + 3 < bytes.length &&
      bytes[index + 1]! >= 48 &&
      bytes[index + 1]! <= 55 &&
      bytes[index + 2]! >= 48 &&
      bytes[index + 2]! <= 55 &&
      bytes[index + 3]! >= 48 &&
      bytes[index + 3]! <= 55
    ) {
      output.push(
        (bytes[index + 1]! - 48) * 64 + (bytes[index + 2]! - 48) * 8 + bytes[index + 3]! - 48,
      );
      index += 4;
    } else {
      output.push(bytes[index]!);
      index += 1;
    }
  }
  return Uint8Array.from(output);
}

export function buildPaneAttachCommand(
  machine: Machine,
  sessionName: string,
  paneId: string,
  tmuxExecutable = "tmux",
): string {
  validateTmuxTarget(machine.socket_name);
  validateTmuxTarget(sessionName);
  validatePaneId(paneId);
  const tmux = machine.transport.kind === "local" ? tmuxExecutable : "tmux";
  const tmuxCommand = (args: string[]) =>
    [tmux, "-f", "/dev/null", "-L", machine.socket_name, ...args].map(shellQuote).join(" ");
  const lookup = tmuxCommand(["display-message", "-p", "-t", paneId, "#{session_name}"]);
  const attach = tmuxCommand(["attach-session", "-t", paneId]);
  const remoteCommand = `actual_session="$(${lookup} 2>/dev/null)"; if [ -z "$actual_session" ]; then printf '%s\\n' ${shellQuote(`Pane ${paneId} in session ${sessionName} was not found`)}; exit 1; fi; if [ "$actual_session" != ${shellQuote(sessionName)} ]; then printf '%s\\n' ${shellQuote(`Pane ${paneId} is not in stored session ${sessionName}`)}; exit 1; fi; exec ${attach}`;
  if (machine.transport.kind === "local") return remoteCommand;
  const transport = machine.transport;
  const sshArgs = ["ssh", "-tt", "-o", "BatchMode=yes"];
  if (transport.port !== null) sshArgs.push("-p", String(transport.port));
  if (transport.identityFile) sshArgs.push("-i", transport.identityFile);
  if (transport.knownHostsFile)
    sshArgs.push("-o", `UserKnownHostsFile=${transport.knownHostsFile}`);
  if (transport.strictHostKeyChecking)
    sshArgs.push("-o", `StrictHostKeyChecking=${transport.strictHostKeyChecking}`);
  sshArgs.push(`${transport.user ? `${transport.user}@` : ""}${transport.host}`, remoteCommand);
  return sshArgs.map(shellQuote).join(" ");
}

export function buildTerminalAppleScript(command: string): string {
  const quote = (value: string) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
  return `tell application ${quote("Terminal")}\nactivate\ndo script ${quote(command)}\nend tell`;
}

export type DeferredTerminalEvent =
  | { kind: "output"; data: Uint8Array }
  | { kind: "exit"; code: number | null };

/** Holds live callbacks until the snapshot boundary and attachment reply are both ready. */
export class TerminalCallbackGate {
  private active = false;
  private snapshotCaptured = false;
  private readonly pendingState: AgentStateRecord[] = [];
  private readonly pendingEvents: DeferredTerminalEvent[] = [];

  dispatchOutput(data: Uint8Array, dispatch: (data: Uint8Array) => void): void {
    if (this.active) dispatch(data);
    else if (this.snapshotCaptured) this.pendingEvents.push({ kind: "output", data: data.slice() });
  }
  dispatchExit(code: number | null, dispatch: (code: number | null) => void): void {
    if (this.active) dispatch(code);
    else this.pendingEvents.push({ kind: "exit", code });
  }
  dispatchState(record: AgentStateRecord, dispatch: (record: AgentStateRecord) => void): void {
    if (this.active) dispatch(record);
    else this.pendingState.push(record);
  }
  markSnapshotCaptured(): void {
    for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1)
      if (this.pendingEvents[index]?.kind === "output") this.pendingEvents.splice(index, 1);
    this.snapshotCaptured = true;
  }
  activateAndDrain(): {
    stateRecords: AgentStateRecord[];
    terminalEvents: DeferredTerminalEvent[];
  } {
    this.active = true;
    return {
      stateRecords: this.pendingState.splice(0),
      terminalEvents: this.pendingEvents.splice(0),
    };
  }
}
export class FakeTerminalRuntime implements TerminalRuntime {
  readonly calls: {
    operation: string;
    machineId: number;
    runIds?: number[];
    sessionName?: string;
    paneId?: string;
  }[] = [];
  readonly panes = new Map<number, ObservedPane[]>();
  readonly stateRecords = new Map<number, AgentStateRecord[]>();
  readonly agentPanes = new Map<number, AgentPaneSummary[]>();
  readonly paneSummaries = new Map<string, PaneSummary[]>();
  readonly errors = new Map<number, Error>();
  readonly commandErrors = new Map<string, Error>();
  readonly transcripts = new Map<string, string>();
  readonly gates = new Map<number, Promise<void>>();
  gate?: Promise<void>;
  onObserve?: () => void;
  private async wait(machineId: number, operation: string): Promise<void> {
    await (this.gates.get(machineId) ?? this.gate);
    const error = this.commandErrors.get(`${machineId}:${operation}`) ?? this.errors.get(machineId);
    if (error) throw error;
  }
  async observeMachine(machine: Machine, runIds: number[]): Promise<MachineObservation> {
    this.calls.push({ operation: "observeMachine", machineId: machine.id, runIds: [...runIds] });
    this.onObserve?.();
    try {
      await this.wait(machine.id, "observeMachine");
      return {
        panes: structuredClone(this.panes.get(machine.id) ?? []),
        stateRecords: structuredClone(this.stateRecords.get(machine.id) ?? []).filter((record) =>
          runIds.includes(Number(record.runId)),
        ),
      };
    } catch (error) {
      return {
        panes: {
          kind: "tmuxQueryFailed",
          error: error instanceof Error ? error.message : String(error),
        },
        stateRecords: [],
      };
    }
  }
  async listAgentPanes(machine: Machine): Promise<AgentPaneSummary[]> {
    this.calls.push({ operation: "listAgentPanes", machineId: machine.id });
    await this.wait(machine.id, "listAgentPanes");
    return structuredClone(this.agentPanes.get(machine.id) ?? []);
  }
  async listPanes(machine: Machine, sessionName: string): Promise<PaneSummary[]> {
    this.calls.push({ operation: "list-panes", machineId: machine.id, sessionName });
    await this.wait(machine.id, "list-panes");
    return structuredClone(this.paneSummaries.get(`${machine.id}:${sessionName}`) ?? []);
  }
  async capturePaneTranscript(machine: Machine, paneId: string): Promise<string> {
    this.calls.push({ operation: "capture-pane", machineId: machine.id, paneId });
    await this.wait(machine.id, "capture-pane");
    return this.transcripts.get(`${machine.id}:${paneId}`) ?? "";
  }
  async sendPaneInput(machine: Machine, paneId: string, _input: Uint8Array): Promise<void> {
    this.calls.push({ operation: "send-keys", machineId: machine.id, paneId });
    await this.wait(machine.id, "send-keys");
  }
  async killSession(machine: Machine, sessionName: string): Promise<void> {
    this.calls.push({ operation: "kill-session", machineId: machine.id, sessionName });
    await this.wait(machine.id, "kill-session");
  }
  async killPane(machine: Machine, sessionName: string, paneId: string): Promise<void> {
    this.calls.push({ operation: "killPane", machineId: machine.id, sessionName, paneId });
    await this.wait(machine.id, "killPane");
  }
  async killPaneWithTimeout(machine: Machine, paneId: string, _timeoutMs: number): Promise<void> {
    this.calls.push({ operation: "killPaneWithTimeout", machineId: machine.id, paneId });
    await this.wait(machine.id, "killPaneWithTimeout");
  }
  async interruptPane(machine: Machine, sessionName: string, paneId: string): Promise<void> {
    this.calls.push({ operation: "interruptPane", machineId: machine.id, sessionName, paneId });
    await this.wait(machine.id, "interruptPane");
  }
}

/** Deterministic connection fake with gates and per-operation failures for adapter tests. */
export class FakeTerminalConnection implements TerminalConnection {
  readonly calls: { operation: string; args: number[] | Uint8Array[] }[] = [];
  readonly gates = new Map<string, Promise<void>>();
  readonly errors = new Map<string, Error>();
  snapshot = new Uint8Array();
  closed = false;

  private async wait(operation: string): Promise<void> {
    await this.gates.get(operation);
    const error = this.errors.get(operation);
    if (error) throw error;
  }

  async sendInput(input: Uint8Array): Promise<void> {
    this.calls.push({ operation: "sendInput", args: [input.slice()] });
    await this.wait("sendInput");
  }

  async resize(columns: number, rows: number): Promise<void> {
    this.calls.push({ operation: "resize", args: [columns, rows] });
    await this.wait("resize");
  }

  async capturePaneSnapshot(afterCapture?: () => void): Promise<Uint8Array> {
    this.calls.push({ operation: "capturePaneSnapshot", args: [] });
    await this.wait("capturePaneSnapshot");
    afterCapture?.();
    return this.snapshot.slice();
  }

  async close(): Promise<void> {
    this.calls.push({ operation: "close", args: [] });
    await this.wait("close");
    this.closed = true;
  }
}
