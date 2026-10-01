import { describe, expect, it, vi } from "vitest";
import type { Machine } from "../domain/types";
import {
  buildStateFileReadCommand,
  FakeTerminalConnection,
  parseAgentPanes,
  parsePaneSummary,
  parseAgentStateRecord,
  parseStateFilesRead,
  parseTmuxPanes,
  TmuxTerminalRuntime,
} from "./terminal";

describe("tmux observations", () => {
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
