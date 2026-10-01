import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteStore } from "./persistence/sqlite-store";
import { Runtime } from "./runtime";
import { FakeMachineAccess } from "./machine-access";
import { createStructureCommandHandlers } from "./structure-commands";
import { createPlanUsageCommandHandlers } from "./plan-usage";

const directories: string[] = [];
const oldPath = process.env.PATH;
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "plan-usage-test-"));
  directories.push(directory);
  return directory;
}
function fixture(name: string) {
  return readFileSync(path.join(process.cwd(), "src/main/fixtures", name), "utf8");
}
async function until(predicate: () => boolean) {
  for (let tries = 0; tries < 100; tries++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("background refresh did not finish");
}
afterEach(() => {
  process.env.PATH = oldPath;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("plan usage and model catalog handlers", () => {
  it("reads fixture usage for each CLI profile and coalesces overlapping refreshes", async () => {
    const store = openSqliteStore(path.join(temporaryDirectory(), "app.sqlite"));
    const runtime = new Runtime(store);
    const structure = createStructureCommandHandlers(runtime, new FakeMachineAccess(), store);
    const machine = structure.register_machine({
      contextId: 1,
      name: "Local",
      socketName: "local",
      transport: { kind: "local" },
    });
    await structure.create_cli_configuration_profile({
      machineId: machine.id,
      provider: "claude",
      name: "Claude",
      appManaged: false,
      existingDirectory: "/profiles/claude",
    });
    await structure.create_cli_configuration_profile({
      machineId: machine.id,
      provider: "codex",
      name: "Codex",
      appManaged: false,
      existingDirectory: "/profiles/codex",
    });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begin = new Promise<void>((resolve) => {
      started = resolve;
    });
    class UsageAccess extends FakeMachineAccess {
      callsToRead = 0;
      override async runShell(
        _machine: Parameters<FakeMachineAccess["runShell"]>[0],
        command: string,
      ) {
        this.callsToRead++;
        started();
        await gate;
        return command.includes("app-server")
          ? fixture("plan-usage-codex.txt")
          : fixture("plan-usage-claude.json");
      }
    }
    const access = new UsageAccess();
    let currentTime = 1_790_709_887_000;
    const now = () => currentTime;
    const handlers = createPlanUsageCommandHandlers(runtime, store, access, { now });
    expect(handlers.list_plan_usage()).toEqual({
      profiles: [],
      fetchedAt: null,
      status: "refreshing",
    });
    await begin;
    handlers.refresh_plan_usage();
    expect(access.callsToRead).toBe(2);
    release();
    await until(() => store.setting("plan_usage_snapshot") !== null);
    const serialized = store.setting("plan_usage_snapshot")!;
    expect(serialized).toContain('"fetchedAt":1790709887,"status":"ready"');
    const snapshot = JSON.parse(serialized) as {
      profiles: { state: string; detail: string | null; windows: { usedPercent: number }[] }[];
    };
    expect(snapshot.profiles.map((profile) => [profile.state, profile.detail])).toEqual([
      ["ready", null],
      ["ready", null],
    ]);
    expect(snapshot.profiles[0]?.windows.map((window) => window.usedPercent)).toEqual([42, 10, 90]);
    expect(snapshot.profiles[1]?.windows.map((window) => window.usedPercent)).toEqual([2, 8]);
    expect(handlers.list_plan_usage().status).toBe("ready");
    expect(access.callsToRead).toBe(2);
    currentTime += 5 * 60 * 1000;
    expect(handlers.list_plan_usage().status).toBe("refreshing");
    await until(
      () =>
        access.callsToRead === 4 &&
        store.setting("plan_usage_snapshot")?.includes('"fetchedAt":1790710187') === true,
    );
  });

  it("discovers Claude effort levels and Codex models into Rust-shaped settings JSON", async () => {
    const directory = temporaryDirectory();
    const bin = path.join(directory, "bin");
    const appDb = path.join(directory, "app.sqlite");
    const store = openSqliteStore(appDb);
    const runtime = new Runtime(store);
    const claude = path.join(bin, "claude");
    const codex = path.join(bin, "codex");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(bin);
    for (const file of [claude, codex]) {
      writeFileSync(file, "#!/bin/sh\nexit 0\n");
      chmodSync(file, 0o755);
    }
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
    const handlers = createPlanUsageCommandHandlers(runtime, store, new FakeMachineAccess(), {
      now: () => 1_790_709_887_000,
      runCommand: async (_program, args) =>
        Buffer.from(
          args[0] === "--help"
            ? fixture("claude-help.txt").replaceAll("\\n", "\n")
            : fixture("codex-model-catalog.json"),
        ),
    });
    handlers.refresh_grill_model_catalog();
    await until(
      () =>
        store.setting("grill_codex_model_catalog") !== null ||
        Boolean(store.setting("grill_codex_model_catalog_error")),
    );
    expect(store.setting("grill_codex_model_catalog")).toBe(
      '{"fetchedAt":1790709887,"models":[{"id":"gpt-test","label":"GPT Test","efforts":[{"id":"high","label":"High"},{"id":"medium","label":"Medium"},{"id":"low","label":"Low"}]}]}',
    );
    const snapshot = handlers.list_grill_model_catalog();
    expect(snapshot.codexStatus).toBe("ready");
    expect(
      snapshot.catalogs
        .find(({ agent }) => agent === "claude")
        ?.models[0]?.efforts.map(({ id }) => id),
    ).toEqual(["low", "medium", "high", "max"]);
    const codexModel = snapshot.catalogs.find(({ agent }) => agent === "codex")?.models[0];
    expect(codexModel?.id).toBe("gpt-test");
    expect(codexModel?.efforts.map(({ id }) => id)).toEqual(["high", "medium", "low"]);
    expect(store.setting("grill_codex_model_catalog_error")).toBe("");
  });
});
