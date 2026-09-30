import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ItemRelation } from "../../renderer/runtime/types";
import type { Run } from "../../renderer/runtime/execution-types";

export function parseJson<T>(value: unknown, description: string, fallback?: T): T {
  if (typeof value !== "string" || value.trim() === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`invalid ${description} in database`);
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`invalid ${description} in database`);
  }
}

export function asString(value: unknown, description: string): string {
  if (typeof value !== "string") throw new Error(`invalid ${description} in database`);
  return value;
}
export function asNumber(value: unknown, description: string): number {
  if (typeof value !== "number") throw new Error(`invalid ${description} in database`);
  return value;
}
export function asBoolean(value: unknown): boolean {
  return Number(value) !== 0;
}
export function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
export function rows<T>(database: DatabaseSync, sql: string, params: SQLInputValue[] = []): T[] {
  return database.prepare(sql).all(...params) as T[];
}
export function tableColumns(database: DatabaseSync, table: string): string[] {
  return rows<{ name: string }>(database, `PRAGMA table_info(${table})`).map((row) => row.name);
}

export function rustGrillPhase(value: string): Run["grill_phase"] {
  const map: Record<string, NonNullable<Run["grill_phase"]>> = {
    starting: "starting",
    working: "working",
    waiting_for_answers: "waitingForAnswers",
    awaiting_next_action: "awaitingNextAction",
    recoverable_pane_loss: "recoverablePaneLoss",
    finished: "finished",
  };
  const phase = map[value];
  if (!phase) throw new Error(`invalid Grill phase in database: ${value}`);
  return phase;
}
export function rustPlanPhase(value: string): Run["plan_phase"] {
  const map: Record<string, NonNullable<Run["plan_phase"]>> = {
    awaiting_go: "awaitingGo",
    executing: "executing",
  };
  const phase = map[value];
  if (!phase) throw new Error(`invalid Plan phase in database: ${value}`);
  return phase;
}
export function rustRelation(value: string): ItemRelation["kind"] {
  const map: Record<string, ItemRelation["kind"]> = {
    blocks: "Blocks",
    blocked_by: "BlockedBy",
    related_to: "RelatedTo",
  };
  const kind = map[value];
  if (!kind) throw new Error(`invalid Item relationship kind in database: ${value}`);
  return kind;
}
export function decodeAuditAction(json: string): unknown {
  const raw = parseJson<Record<string, unknown>>(json, "audit action");
  if (typeof raw.action !== "string") throw new Error(`invalid audit action in database: ${json}`);
  return raw;
}
