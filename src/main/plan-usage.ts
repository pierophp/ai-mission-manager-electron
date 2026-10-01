import type {
  GrillAgentCatalog,
  GrillEffort,
  GrillModel,
  PlanUsageSnapshot,
  ProfilePlanUsage,
  UsageWindow,
} from "../domain/types";
import type { Runtime } from "./runtime";
import type { SqliteStore } from "./persistence/sqlite-store";
import type { MachineAccess } from "./machine-access";
import { shellQuote } from "./machine-access";
import { grillModelCatalog } from "../domain/grilling";
import { resolveExecutable } from "./dependencies";
import { spawn } from "node:child_process";

const PLAN_USAGE_KEY = "plan_usage_snapshot";
const CODEX_CATALOG_KEY = "grill_codex_model_catalog";
const CODEX_CATALOG_ERROR_KEY = "grill_codex_model_catalog_error";
const PLAN_TTL_SECONDS = 5 * 60;
const PLAN_RETRY_SECONDS = 60;
const CATALOG_TTL_SECONDS = 24 * 60 * 60;
const CATALOG_RETRY_SECONDS = 5 * 60;
const CLAUDE_STATE_BYTE_LIMIT = 32 * 1024 * 1024;
const CODEX_REPLY_WAIT_SECONDS = 8;
const COMMAND_TIMEOUT_MS = 20_000;

type Failure = { state: ProfilePlanUsage["state"]; detail: string };
type Reading = Pick<ProfilePlanUsage, "plan" | "observedAt" | "windows">;
type CatalogCache = { fetchedAt: number; models: GrillModel[] };
type RunCommand = (program: string, args: string[], timeoutMs?: number) => Promise<Buffer>;
type Options = { now?: () => number; runCommand?: RunCommand };

function seconds(now: () => number) {
  return Math.floor(now() / 1000);
}

function runCommand(
  program: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "ignore"] });
    const output: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not start the provider CLI"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Provider model discovery timed out"));
      else if (code !== 0) reject(new Error("Provider CLI could not discover its model catalog"));
      else resolve(Buffer.concat(output));
    });
  });
}

function parseJsonLines(text: string): unknown[] {
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseClaudeUsage(payload: string): Reading {
  if (!payload.trim())
    throw {
      state: "signedOut",
      detail: "Claude Code has not been run with this profile yet",
    } satisfies Failure;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw { state: "notReported", detail: "Claude Code state could not be read" } satisfies Failure;
  }
  const cached = record(state.cachedUsageUtilization);
  if (!cached)
    throw {
      state: "notReported",
      detail: "Claude Code has not recorded plan usage for this profile yet",
    } satisfies Failure;
  const utilization = record(cached.utilization);
  if (!utilization)
    throw { state: "notReported", detail: "Claude Code reported no plan usage" } satisfies Failure;
  const windows: UsageWindow[] = [];
  const labels: [string, string][] = [
    ["five_hour", "5-hour window"],
    ["seven_day", "Weekly"],
    ["seven_day_opus", "Weekly (Opus)"],
    ["seven_day_sonnet", "Weekly (Sonnet)"],
  ];
  for (const [id, label] of labels) {
    const window = record(utilization[id]);
    const fraction = number(window?.utilization);
    if (!window || fraction === undefined) continue;
    windows.push({
      id,
      label,
      usedPercent: Math.max(0, Math.min(100, fraction * 100)),
      resetsAt: number(window.resets_at) ?? null,
    });
  }
  const extra = record(utilization.extra_usage);
  if (extra?.is_enabled === true && number(extra.utilization) !== undefined)
    windows.push({
      id: "extra_usage",
      label: "Extra usage",
      usedPercent: Math.max(0, Math.min(100, number(extra.utilization)!)),
      resetsAt: null,
    });
  if (!windows.length)
    throw {
      state: "notReported",
      detail: "Claude Code reported no plan limits for this profile",
    } satisfies Failure;
  return {
    plan: null,
    observedAt:
      number(cached.fetchedAtMs) === undefined
        ? null
        : Math.floor(number(cached.fetchedAtMs)! / 1000),
    windows,
  };
}

function windowLabel(minutes: number | undefined) {
  if (minutes === 300) return "5-hour window";
  if (minutes === 10080) return "Weekly";
  if (minutes !== undefined && minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes !== undefined && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return minutes === undefined ? "Plan limit" : `${minutes}-minute window`;
}
function codexWindow(id: string, value: unknown): UsageWindow | undefined {
  const entry = record(value);
  const used = number(entry?.usedPercent);
  if (!entry || used === undefined) return undefined;
  return {
    id,
    label: windowLabel(number(entry.windowDurationMins)),
    usedPercent: Math.max(0, Math.min(100, used)),
    resetsAt: number(entry.resetsAt) ?? null,
  };
}
function parseCodexUsage(payload: string): Reading {
  const reply = parseJsonLines(payload)
    .map(record)
    .find((entry) => number(entry?.id) === 2);
  if (!reply)
    throw {
      state: "signedOut",
      detail: "Codex did not report plan usage; the profile may not be signed in",
    } satisfies Failure;
  const error = record(reply.error);
  if (error)
    throw {
      state: "signedOut",
      detail: string(error.message) ?? "Codex refused to report plan usage",
    } satisfies Failure;
  const result = record(reply.result);
  const limits = record(result?.rateLimits);
  if (!limits)
    throw { state: "notReported", detail: "Codex reported no plan limits" } satisfies Failure;
  const windows = [
    codexWindow("primary", limits.primary),
    codexWindow("secondary", limits.secondary),
  ].filter((window): window is UsageWindow => window !== undefined);
  if (!windows.length)
    throw { state: "notReported", detail: "Codex reported no plan limits" } satisfies Failure;
  return { plan: string(limits.planType) ?? null, observedAt: null, windows };
}

async function readProfile(
  machine: ReturnType<Runtime["snapshot"]>["machines"][number],
  profile: ReturnType<Runtime["snapshot"]>["cli_configuration_profiles"][number],
  access: MachineAccess,
): Promise<ProfilePlanUsage> {
  const base: ProfilePlanUsage = {
    profileId: profile.id,
    profileName: profile.name,
    provider: profile.provider,
    machineId: machine.id,
    machineName: machine.name,
    state: "notReported",
    detail: null,
    plan: null,
    observedAt: null,
    windows: [],
  };
  try {
    let reading: Reading;
    if (profile.provider === "claude") {
      const directory = shellQuote(profile.directory);
      const command = `set -eu; directory=${directory}; for candidate in "$directory/.claude.json" "$HOME/.claude.json"; do if [ -f "$candidate" ]; then head -c ${CLAUDE_STATE_BYTE_LIMIT} -- "$candidate"; exit 0; fi; done; exit 0`;
      reading = parseClaudeUsage(await access.runShell(machine, command));
    } else {
      let executable: string;
      try {
        executable = await access.findExecutable(machine, "codex");
      } catch (error) {
        throw {
          state: "notReported",
          detail: error instanceof Error ? error.message : String(error),
        } satisfies Failure;
      }
      const directory = shellQuote(profile.directory);
      const quotedExecutable = shellQuote(executable);
      const init =
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"ai-mission-manager","version":"1"}}}';
      const initialized = '{"jsonrpc":"2.0","method":"initialized","params":{}}';
      const read = '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}';
      const command = `set -eu; export CODEX_HOME=${directory}; { printf '%s\\n' '${init}'; printf '%s\\n' '${initialized}'; printf '%s\\n' '${read}'; sleep ${CODEX_REPLY_WAIT_SECONDS}; } | ${quotedExecutable} app-server 2>/dev/null`;
      reading = parseCodexUsage(await access.runShell(machine, command));
    }
    return { ...base, ...reading, state: "ready" };
  } catch (error) {
    const failure = record(error) as Failure | undefined;
    const state =
      failure && ["signedOut", "machineUnreachable", "notReported"].includes(failure.state)
        ? failure.state
        : "machineUnreachable";
    const detail = failure?.detail ?? (error instanceof Error ? error.message : String(error));
    return { ...base, state, detail };
  }
}

function readSettingRecord(store: SqliteStore, key: string): Record<string, unknown> | undefined {
  const serialized = store.setting(key);
  if (!serialized) return undefined;
  try {
    const value: unknown = JSON.parse(serialized);
    return record(value);
  } catch {
    return undefined;
  }
}
function cachedPlan(store: SqliteStore): PlanUsageSnapshot | undefined {
  const value = readSettingRecord(store, PLAN_USAGE_KEY);
  if (
    !value ||
    !Array.isArray(value.profiles) ||
    !["ready", "refreshing", "never"].includes(String(value.status))
  )
    return undefined;
  if (
    value.fetchedAt !== null &&
    (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt))
  )
    return undefined;
  return value as unknown as PlanUsageSnapshot;
}
function readCatalogCache(store: SqliteStore): CatalogCache | undefined {
  const value = readSettingRecord(store, CODEX_CATALOG_KEY);
  if (
    !value ||
    typeof value.fetchedAt !== "number" ||
    !Number.isFinite(value.fetchedAt) ||
    !Array.isArray(value.models)
  )
    return undefined;
  return value as unknown as CatalogCache;
}
function effortLabel(id: string): string {
  if (id === "xhigh") return "Extra high";
  if (id === "ultra") return "Ultra";
  return id ? id[0]!.toUpperCase() + id.slice(1) : "";
}
function parseCodexCatalog(payload: Buffer): GrillModel[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Codex CLI returned an invalid model catalog");
  }
  if (!Array.isArray(parsed.models)) throw new Error("Codex CLI returned no model catalog");
  const models = parsed.models.flatMap((value): GrillModel[] => {
    const model = record(value);
    if (
      !model ||
      (typeof model.visibility === "string" && model.visibility.toLowerCase() === "hidden")
    )
      return [];
    const id = string(model.slug);
    if (!id || !Array.isArray(model.supported_reasoning_levels)) return [];
    const efforts: GrillEffort[] = model.supported_reasoning_levels.flatMap((entry) => {
      const effort = string(record(entry)?.effort);
      return effort ? [{ id: effort, label: effortLabel(effort) }] : [];
    });
    if (!efforts.length) return [];
    const defaultLevel = string(model.default_reasoning_level);
    const index = efforts.findIndex(({ id: effort }) => effort === defaultLevel);
    if (index > 0) [efforts[0], efforts[index]] = [efforts[index]!, efforts[0]!];
    return [{ id, label: string(model.display_name)?.trim() || id, efforts }];
  });
  if (!models.length) throw new Error("Codex CLI returned no usable models");
  return models;
}
function discoverClaudeEfforts(help: Buffer): GrillEffort[] {
  const text = help.toString("utf8").replaceAll("\n", " ");
  const match = /--effort <level>\s*\(([^)]*)\)/.exec(text);
  return (
    match?.[1]
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id, label: effortLabel(id) })) ?? []
  );
}

export function createPlanUsageCommandHandlers(
  runtime: Runtime,
  store: SqliteStore,
  machineAccess: MachineAccess,
  options: Options = {},
) {
  const now = options.now ?? Date.now;
  const execute = options.runCommand ?? runCommand;
  let planInFlight: Promise<void> | undefined;
  let planLastAttempt = 0;
  let catalogInFlight: Promise<void> | undefined;
  let catalogLastAttempt = 0;
  let claudeEfforts: GrillEffort[] | undefined;
  const discoverCatalog = async (): Promise<GrillAgentCatalog[]> => {
    const catalogs: GrillAgentCatalog[] = [];
    const claudeExecutable = resolveExecutable("claude", null);
    if (claudeExecutable) {
      if (!claudeEfforts) {
        try {
          claudeEfforts = discoverClaudeEfforts(await execute(claudeExecutable, ["--help"]));
        } catch {
          claudeEfforts = [];
        }
      }
      const claude = grillModelCatalog().find(({ agent }) => agent === "claude");
      const models = claudeEfforts.length
        ? (claude?.models.map((model) => ({ ...model, efforts: claudeEfforts! })) ?? [])
        : [];
      if (models.length) catalogs.push({ agent: "claude", models });
    }
    const codexExecutable = resolveExecutable("codex", null);
    if (codexExecutable) {
      const models = parseCodexCatalog(await execute(codexExecutable, ["debug", "models"]));
      catalogs.push({ agent: "codex", models });
    } else throw new Error("Codex CLI was not found on PATH");
    return catalogs;
  };
  const startPlanRefresh = (force: boolean) => {
    const at = seconds(now);
    if (planInFlight || (!force && at - planLastAttempt < PLAN_RETRY_SECONDS)) return;
    planLastAttempt = at;
    planInFlight = (async () => {
      const state = runtime.snapshot();
      const machines = new Map(state.machines.map((machine) => [machine.id, machine]));
      const profiles = await Promise.all(
        state.cli_configuration_profiles.flatMap((profile) => {
          const machine = machines.get(profile.machineId);
          return machine ? [readProfile(machine, profile, machineAccess)] : [];
        }),
      );
      const snapshot: PlanUsageSnapshot = { profiles, fetchedAt: seconds(now), status: "ready" };
      store.setSetting(PLAN_USAGE_KEY, JSON.stringify(snapshot));
    })()
      .catch(() => undefined)
      .finally(() => {
        planInFlight = undefined;
      });
  };
  const startCatalogRefresh = (force: boolean) => {
    const at = seconds(now);
    if (catalogInFlight || (!force && at - catalogLastAttempt < CATALOG_RETRY_SECONDS)) return;
    catalogLastAttempt = at;
    catalogInFlight = (async () => {
      try {
        const catalogs = await discoverCatalog();
        const models = catalogs.find(({ agent }) => agent === "codex")?.models;
        if (!models?.length) throw new Error("Codex CLI returned no usable models");
        const cache: CatalogCache = { fetchedAt: seconds(now), models };
        store.setSetting(CODEX_CATALOG_KEY, JSON.stringify(cache));
        store.setSetting(CODEX_CATALOG_ERROR_KEY, "");
      } catch (error) {
        store.setSetting(
          CODEX_CATALOG_ERROR_KEY,
          error instanceof Error ? error.message : String(error),
        );
      }
    })().finally(() => {
      catalogInFlight = undefined;
    });
  };
  return {
    list_plan_usage: () => {
      const cache = cachedPlan(store);
      if (!cache || cache.fetchedAt === null || seconds(now) - cache.fetchedAt >= PLAN_TTL_SECONDS)
        startPlanRefresh(false);
      if (planInFlight) {
        if (!cache)
          return {
            profiles: [],
            fetchedAt: null,
            status: "refreshing",
          } satisfies PlanUsageSnapshot;
        return { ...cache, status: "refreshing" } satisfies PlanUsageSnapshot;
      }
      return (
        cache ?? ({ profiles: [], fetchedAt: null, status: "never" } satisfies PlanUsageSnapshot)
      );
    },
    refresh_plan_usage: () => {
      startPlanRefresh(true);
    },
    list_grill_model_catalog: () => {
      const cache = readCatalogCache(store);
      const stale = !cache || seconds(now) - cache.fetchedAt >= CATALOG_TTL_SECONDS;
      if (stale) startCatalogRefresh(false);
      const error = store.setting(CODEX_CATALOG_ERROR_KEY);
      const codexStatus = catalogInFlight ? "refreshing" : stale ? "error" : "ready";
      const catalogs: GrillAgentCatalog[] = [];
      if (claudeEfforts?.length) {
        const claude = grillModelCatalog().find(({ agent }) => agent === "claude");
        const models = claude?.models.map((model) => ({ ...model, efforts: claudeEfforts! })) ?? [];
        if (models.length) catalogs.push({ agent: "claude", models });
      }
      if (cache) catalogs.push({ agent: "codex", models: cache.models });
      return {
        catalogs,
        codexStatus,
        codexError:
          codexStatus === "error" ? error || "Codex model discovery is unavailable" : null,
        codexFetchedAt: cache?.fetchedAt ?? null,
      };
    },
    refresh_grill_model_catalog: () => {
      startCatalogRefresh(true);
    },
  };
}
