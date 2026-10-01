import { readFileSync } from "node:fs";
import path from "node:path";
import type { Runtime } from "../runtime";
import { parseAgentStateRecord } from "../terminal";

/** Keeps Workspace reconciliation in the startup sequence shared with the Rust runtime. */
export function ensureProjectWorkspaces(runtime: Runtime): void {
  runtime.ensureProjectWorkspaces();
}

/** Recovers the pre-hook state files kept beside the database by older Rust builds. */
export function recoverRunStateRecords(runtime: Runtime, databasePath: string): void {
  const directory = path.join(path.dirname(databasePath), "agent-state");
  for (const run of runtime.snapshot().runs) {
    let contents: string;
    try {
      contents = readFileSync(path.join(directory, `run-${run.id}.json`), "utf8");
    } catch {
      continue;
    }
    const record = parseAgentStateRecord(contents);
    if (!record || Number(record.runId) !== run.id || record.agent !== run.agent) continue;
    runtime.dispatch({
      type: "observe_run",
      runId: run.id,
      state: record.state,
      sequence: record.sequence ?? null,
      paneStatus: run.pane_status,
    });
  }
}
