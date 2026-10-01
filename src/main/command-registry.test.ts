import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMainCommandHandlers } from "./command-registry";

describe("main-process IPC registry", () => {
  it("registers every command exposed by the renderer contract", async () => {
    const bindingsFile = path.resolve(process.cwd(), "src/renderer/runtime/bindings.ts");
    const bindings = fs.readFileSync(bindingsFile, "utf8");
    const contractCommands = [...bindings.matchAll(/__ELECTRON_INVOKE<[^>]+>\("([a-z0-9_]+)"/g)].map(
      ([, name]) => name!,
    );
    expect(contractCommands.length).toBeGreaterThan(0);

    const handlers = createMainCommandHandlers({
      runtime: {} as never,
      store: {} as never,
      machineAccess: {} as never,
      terminalRuntime: {} as never,
      onRunStateChanged: () => undefined,
      onTerminalEvent: () => undefined,
      onRunQuestionsChanged: () => undefined,
    });
    const missing = contractCommands.filter((name) => !Object.hasOwn(handlers, name));
    expect(missing).toEqual([]);
  });
});
