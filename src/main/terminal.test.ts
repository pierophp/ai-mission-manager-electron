import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Machine } from "../domain/types";
import {
  buildStateFileReadCommand,
  buildPaneAttachCommand,
  buildTerminalAppleScript,
  decodeControlOutput,
  FakeTerminalConnection,
  parseAgentPanes,
  parsePaneSummary,
  parseAgentStateRecord,
  parseStateFilesRead,
  parseTmuxPanes,
  TmuxTerminalRuntime,
  TmuxControlConnection,
  TerminalCallbackGate,
} from "./terminal";

describe("tmux observations", () => {
  it("buffers only post-snapshot output and holds state and exit until activation", () => {
    const gate = new TerminalCallbackGate();
    const outputs: number[][] = [];
    const states: string[] = [];
    const exits: (number | null)[] = [];
    gate.dispatchOutput(new Uint8Array([1]), (data) => outputs.push([...data]));
    gate.markSnapshotCaptured();
    gate.dispatchOutput(new Uint8Array([2]), (data) => outputs.push([...data]));
    gate.dispatchState(
      { agent: "codex", runId: "3", state: "working", updatedAt: "now" },
      (record) => states.push(record.state),
    );
    gate.dispatchExit(0, (code) => exits.push(code));
    const pending = gate.activateAndDrain();
    expect(pending.terminalEvents).toEqual([
      { kind: "output", data: new Uint8Array([2]) },
      { kind: "exit", code: 0 },
    ]);
    expect(pending.stateRecords.map((record) => record.state)).toEqual(["working"]);
    gate.dispatchOutput(new Uint8Array([3]), (data) => outputs.push([...data]));
    gate.dispatchState(
      { agent: "codex", runId: "3", state: "finished", updatedAt: "later" },
      (record) => states.push(record.state),
    );
    expect(outputs).toEqual([[3]]);
    expect(states).toEqual(["finished"]);
    expect(exits).toEqual([]);
  });

  it("builds exact-pane attach commands for local and SSH Terminal.app sessions", () => {
    const local: Machine = {
      id: 1,
      context_id: 1,
      name: "Local",
      socket_name: "mission.one",
      transport: { kind: "local" },
      last_observed: "unknown",
      last_observed_at: null,
    };
    expect(buildPaneAttachCommand(local, "mission", "%7")).toContain("display-message");
    expect(buildPaneAttachCommand(local, "mission", "%7")).toContain(
      "exec 'tmux' '-f' '/dev/null' '-L' 'mission.one' 'attach-session' '-t' '%7'",
    );
    const remote: Machine = {
      ...local,
      transport: {
        kind: "ssh",
        host: "build.example",
        user: "piero",
        port: 2222,
        identityFile: "/tmp/key file",
        knownHostsFile: "/tmp/known hosts",
        strictHostKeyChecking: "accept-new",
      },
    };
    const command = buildPaneAttachCommand(remote, "mission", "%7");
    expect(command).toContain("'ssh' '-tt' '-o' 'BatchMode=yes' '-p' '2222'");
    expect(command).toContain("'piero@build.example'");
    expect(command).toContain("'UserKnownHostsFile=/tmp/known hosts'");
    expect(buildTerminalAppleScript('echo "hello"')).toContain('do script "echo \\\"hello\\\""');
  });

  it("decodes tmux octal output directly from bytes without losing non-UTF-8 data", () => {
    expect([
      ...decodeControlOutput(Buffer.from([65, 92, 48, 48, 48, 92, 51, 55, 55, 255])),
    ]).toEqual([65, 0, 255, 255]);
  });

  it("pairs control-mode response blocks FIFO and runs the snapshot barrier at the second end", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "amm-tmux-control-"));
    try {
      const fake = path.join(directory, "tmux-fake");
      await writeFile(
        fake,
        `#!/bin/sh\ni=0\nwhile IFS= read -r command; do\n  i=$((i + 1)); printf '%%begin %s 1 0\\n' "$i"\n  case "$command" in\n    *capture-pane*) printf 'screen\\n'; printf '%%output %%7 during-capture\\n'; printf '%%end %s 1 0\\n' "$i"; i=$((i + 1)); printf '%%begin %s 1 0\\n2 1\\n%%end %s 1 0\\n' "$i" "$i" ;;\n    *send-keys*) printf 'denied\\n'; printf '%%error %s 1 0\\n' "$i" ;;\n    *refresh-client*) printf '%s\\n' '%subscription-changed mission-manager-agent-state session 0 window %7 : {"agent":"codex","runId":"3","state":"working","updatedAt":"now","sequence":1}'; printf '%%output %%7 hello\\\\000\\\\377\\n'; printf '%%output %%99 ignored\\n'; printf '%%end %s 1 0\\n' "$i" ;;\n    *) printf '%%end %s 1 0\\n' "$i" ;;\n  esac\ndone\n`,
      );
      await chmod(fake, 0o755);
      const machine: Machine = {
        id: 1,
        context_id: 1,
        name: "Local",
        socket_name: "test",
        transport: { kind: "local" },
        last_observed: "unknown",
        last_observed_at: null,
      };
      const callbacks = { onOutput: vi.fn(), onAgentState: vi.fn(), onExit: vi.fn() };
      const connection = await TmuxControlConnection.attach(
        machine,
        fake,
        "mission",
        "%7",
        callbacks,
      );
      expect([...callbacks.onOutput.mock.calls[0]![0]]).toEqual([...Buffer.from("hello"), 0, 255]);
      expect(callbacks.onOutput).toHaveBeenCalledOnce();
      expect(callbacks.onAgentState).toHaveBeenCalledWith({
        agent: "codex",
        runId: "3",
        state: "working",
        updatedAt: "now",
        sequence: 1,
      });
      await expect(connection.sendInput(new Uint8Array([65]))).rejects.toThrow("denied");
      let afterEnd = false;
      const snapshot = await connection.capturePaneSnapshot(() => {
        afterEnd = true;
      });
      expect(callbacks.onOutput).toHaveBeenCalledTimes(2);
      expect(Buffer.from(callbacks.onOutput.mock.calls[1]![0]).toString()).toBe("during-capture");
      expect(afterEnd).toBe(true);
      expect(Buffer.from(snapshot).toString()).toBe("screen\u001b[0m\u001b[2;3H");
      await connection.close();
      await expect(
        TmuxControlConnection.attach(
          machine,
          path.join(directory, "missing-tmux"),
          "mission",
          "%7",
          callbacks,
        ),
      ).rejects.toThrow("Could not attach to Pane on Machine Local: spawn");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("lists panes in one tmux invocation for one session", async () => {
    const runShell = vi.fn(
      async (_machine: Machine, _command: string) => "%7\t0\t314\t120\t40\tMain\tzsh\t/work\n",
    );
    const runtime = new TmuxTerminalRuntime({
      runShell,
    } as never);
    const machine: Machine = {
      id: 1,
      context_id: 1,
      name: "Local",
      socket_name: "mission-test",
      transport: { kind: "local" },
      last_observed: "unknown",
      last_observed_at: null,
    };
    expect(await runtime.listPanes(machine, "mission")).toEqual([
      {
        paneId: "%7",
        paneIndex: 0,
        panePid: 314,
        paneWidth: 120,
        paneHeight: 40,
        paneTitle: "Main",
        currentCommand: "zsh",
        currentPath: "/work",
      },
    ]);
    expect(runShell).toHaveBeenCalledOnce();
    expect(runShell.mock.calls[0]?.[1]).toContain(" list-panes -t 'mission' -F ");
  });

  it("parses pane state options without inferring state from terminal text", () => {
    expect(
      parseTmuxPanes(
        '$3\t%1\t{"agent":"claude","runId":"7","state":"blocked","updatedAt":"123","sequence":4}\n',
      ),
    ).toEqual([
      {
        sessionName: "$3",
        paneId: "%1",
        agentState: {
          agent: "claude",
          runId: "7",
          state: "blocked",
          updatedAt: "123",
          sequence: 4,
        },
      },
    ]);
    expect(parseTmuxPanes("$3\t%1\tmalformed\n")[0]?.agentState).toBeNull();
    expect(() => parseTmuxPanes("broken\n")).toThrow(
      "Could not parse Machine tmux Pane observation",
    );
  });

  it("recognizes agent executable names in pane command or title", () => {
    expect(
      parseAgentPanes("mission\t%1\t/usr/local/bin/claude --resume\tterminal\t/work\n"),
    ).toEqual([{ agent: "claude", sessionName: "mission", paneId: "%1", currentPath: "/work" }]);
    expect(parseAgentPanes("mission\t%2\tzsh\tCodex\t/work\n")[0]?.agent).toBe("codex");
    expect(parseAgentPanes("mission\t%3\tzsh\tterminal\t/work\n")).toEqual([]);
  });

  it("parses the Rust PaneSummary tmux format and rejects malformed numeric fields", () => {
    expect(parsePaneSummary("%4\t2\t314\t120\t40\tCodex\tcodex\t/work/tree\n")).toEqual([
      {
        paneId: "%4",
        paneIndex: 2,
        panePid: 314,
        paneWidth: 120,
        paneHeight: 40,
        paneTitle: "Codex",
        currentCommand: "codex",
        currentPath: "/work/tree",
      },
    ]);
    expect(parsePaneSummary("")).toEqual([]);
    expect(() => parsePaneSummary("%4\tnot-a-number\t314\t120\t40\tCodex\tcodex\t/work")).toThrow(
      "Pane index is invalid: invalid digit found in string",
    );
    expect(() => parsePaneSummary("%4\t2\t4294967296\t120\t40\tCodex\tcodex\t/work")).toThrow(
      "Pane process ID is invalid: number too large to fit in target type",
    );
    expect(() => parsePaneSummary("%4\t2\t314\t120\t40\tCodex\tcodex")).toThrow(
      "tmux returned an invalid Pane description",
    );
  });

  it("provides a gated TerminalConnection fake with byte snapshots and callbacks", async () => {
    const connection = new FakeTerminalConnection();
    connection.snapshot = new Uint8Array([1, 2, 3]);
    let captured = 0;
    await connection.sendInput(new Uint8Array([4, 5]));
    await connection.resize(100, 30);
    expect(await connection.capturePaneSnapshot(() => captured++)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await connection.close();
    expect(captured).toBe(1);
    expect(connection.closed).toBe(true);
    expect(connection.calls.map(({ operation }) => operation)).toEqual([
      "sendInput",
      "resize",
      "capturePaneSnapshot",
      "close",
    ]);
  });

  it("reads only complete, requested, path-matching state-file records", () => {
    const record =
      '{"agent":"codex","runId":"8","state":"finished","updatedAt":"123","sequence":0}';
    expect(buildStateFileReadCommand([8, 8, -1])).toContain("for run_id in 8; do");
    expect(parseStateFilesRead(`8\0${record}\0`, [8])).toEqual([parseAgentStateRecord(record)]);
    expect(
      parseStateFilesRead(`8\0${record.replace('"runId":"8"', '"runId":"9"')}\0`, [8]),
    ).toEqual([]);
    expect(parseStateFilesRead(`8\0${record}`, [8])).toEqual([]);
  });
});
