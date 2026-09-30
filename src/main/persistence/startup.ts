import type { DomainState } from "../../domain/model";

/**
 * Rust runs these reconciliation steps after loading state. They have no read-only work before
 * persistence effects are ported, but remain explicit here to preserve startup ordering.
 */
export function ensureProjectWorkspaces(_state: DomainState): void {}
export function recoverRunStateRecords(_state: DomainState): void {}
