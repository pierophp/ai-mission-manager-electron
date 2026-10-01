import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "../runtime";
import { recoverRunStateRecords } from "./startup";
import { openSqliteStore } from "./sqlite-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("legacy Run state recovery", () => {
  it("reads the old database-adjacent state record and respects sequence ordering", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-legacy-state-"));
    directories.push(directory);
    const database = path.join(directory, "mission-manager.sqlite");
    copyFileSync(path.join(__dirname, "fixtures/rust-persistence.sqlite"), database);
    mkdirSync(path.join(directory, "agent-state"));
    writeFileSync(
      path.join(directory, "agent-state/run-1.json"),
      JSON.stringify({
        agent: "claude",
        runId: "1",
        state: "blocked",
        updatedAt: "100",
        sequence: 3,
      }),
    );
    const store = openSqliteStore(database);
    const runtime = new Runtime(store);
    recoverRunStateRecords(runtime, database);
    expect(runtime.snapshot().runs[0]).toMatchObject({
      state: "blocked",
      last_applied_agent_state_sequence: 3,
    });
    writeFileSync(
      path.join(directory, "agent-state/run-1.json"),
      JSON.stringify({
        agent: "claude",
        runId: "1",
        state: "working",
        updatedAt: "200",
        sequence: 2,
      }),
    );
    recoverRunStateRecords(runtime, database);
    expect(runtime.snapshot().runs[0]?.state).toBe("blocked");
    store.close();
  });
});
