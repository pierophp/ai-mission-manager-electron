import type { Machine, MachineObservationFailureKind } from "../domain/types";
import type { AgentKind, RunState } from "../domain/execution-types";
import { shellQuote, type MachineAccess } from "./machine-access";

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
export interface TerminalRuntime {
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
    private readonly tmuxExecutable = "tmux",
  ) {}
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
