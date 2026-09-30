import type { DomainState } from "../../domain/model";
import type { Runtime } from "../runtime";

/** Keeps Workspace reconciliation in the startup sequence shared with the Rust runtime. */
export function ensureProjectWorkspaces(runtime: Runtime): void {
  runtime.ensureProjectWorkspaces();
}
export function recoverRunStateRecords(_state: DomainState): void {}
