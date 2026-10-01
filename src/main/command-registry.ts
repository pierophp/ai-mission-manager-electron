import type { Run } from "../domain/execution-types";
import type { Runtime } from "./runtime";
import type { SqliteStore } from "./persistence/sqlite-store";
import type { MachineAccess } from "./machine-access";
import type { TerminalRuntime } from "./terminal";
import { createReadCommandHandlers } from "./persistence/commands";
import { createPlanUsageCommandHandlers } from "./plan-usage";
import { createSetupCommandHandlers } from "./setup";
import { createStructureCommandHandlers } from "./structure-commands";
import { createWorkCommandHandlers } from "./work-commands";
import { createRunLaunchHandlers } from "./run-launcher";
import { createMachineDeletionHandlers } from "./machine-deletion";
import { createExternalCommandHandlers } from "./external-commands";
import { createDeletionCommandHandlers } from "./deletion-commands";

export function createMainCommandHandlers(options: {
  runtime: Runtime;
  store: SqliteStore;
  machineAccess: MachineAccess;
  terminalRuntime: TerminalRuntime;
  onRunStateChanged: (event: { runId: number; state: string }) => void;
  onTerminalEvent: (name: "terminal-output" | "terminal-exit", event: unknown) => void;
  onRunQuestionsChanged: (runId: number) => void;
}) {
  const { runtime, store, machineAccess, terminalRuntime } = options;
  const runLaunchHandlers = createRunLaunchHandlers(runtime, machineAccess, terminalRuntime);
  return {
    ...createReadCommandHandlers(store),
    ...createPlanUsageCommandHandlers(runtime, store, machineAccess),
    ...createSetupCommandHandlers(runtime, store),
    ...createStructureCommandHandlers(runtime, machineAccess, store),
    ...createWorkCommandHandlers(
      runtime,
      machineAccess,
      terminalRuntime,
      options.onRunStateChanged,
      options.onTerminalEvent,
      options.onRunQuestionsChanged,
      (request) => runLaunchHandlers.start_run({ request }) as Promise<Run>,
    ),
    ...runLaunchHandlers,
    ...createMachineDeletionHandlers(runtime, terminalRuntime),
    ...createExternalCommandHandlers(runtime),
    ...createDeletionCommandHandlers(runtime, machineAccess),
  };
}
