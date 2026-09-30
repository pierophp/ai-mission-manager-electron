import type { DependencyStatus, HealthStatus, ProviderChoice, SetupState } from "../domain/types";
import type { Runtime } from "./runtime";
import { checkCommand, dependencyStatus, resolveExecutable } from "./dependencies";
import type { SqliteStore } from "./persistence/sqlite-store";

export function createSetupCommandHandlers(runtime: Runtime, store: SqliteStore) {
  return {
    complete_setup: (args: Record<string, unknown>): SetupState => {
      const provider = parseProvider(args.provider);
      runtime.dispatch({
        type: "complete_setup",
        contextName: String(args.contextName ?? ""),
        provider,
      });
      return store.getSetupState();
    },
    get_health_status: (args: Record<string, unknown>): HealthStatus =>
      getHealthStatus(
        store,
        args.provider === null || args.provider === undefined ? null : parseProvider(args.provider),
      ),
  };
}

export function getHealthStatus(
  store: SqliteStore,
  providerOverride: ProviderChoice | null,
): HealthStatus {
  const runtime = checkRuntimeDependency(store);
  const setup = store.getSetupState();
  const provider = providerOverride ?? setup.provider;
  const providerStatus =
    provider === "github"
      ? checkGithubDependency(store)
      : dependencyStatus(
          "github",
          "GitHub provider",
          "notConfigured",
          null,
          "No provider selected; local Items remain available.",
          "Choose GitHub in setup when you are ready to link external work.",
        );
  const agents = [
    ["claude", "Claude Code", "claude_executable_path"],
    ["codex", "Codex", "codex_executable_path"],
  ].map(([key, label, settingKey]) =>
    checkLocalDependency(
      store,
      key,
      label,
      settingKey,
      `Install ${label} before starting a Run with it.`,
    ),
  );
  return {
    runtime,
    provider: providerStatus,
    agents,
    checkedAt: Math.floor(Date.now() / 1000),
  };
}

function checkRuntimeDependency(store: SqliteStore): DependencyStatus {
  const executable = resolveAndStoreExecutable(store, "tmux", "tmux_executable_path");
  if (!executable)
    return dependencyStatus(
      "tmux",
      "tmux runtime",
      "missing",
      null,
      "tmux was not found.",
      "Install tmux (for example, with `brew install tmux`) and check again.",
    );
  const error = checkCommand(executable, ["-V"], "tmux");
  return error
    ? dependencyStatus(
        "tmux",
        "tmux runtime",
        "unavailable",
        executable,
        `tmux could not be checked: ${error}`,
        "Repair or reinstall tmux, then check again.",
      )
    : dependencyStatus("tmux", "tmux runtime", "available", executable, "tmux is ready.", null);
}

function checkGithubDependency(store: SqliteStore): DependencyStatus {
  const executable = resolveAndStoreExecutable(store, "gh", "gh_executable_path");
  if (!executable)
    return dependencyStatus(
      "github",
      "GitHub provider",
      "missing",
      null,
      "GitHub CLI (`gh`) was not found.",
      "Install GitHub CLI, then authenticate it with `gh auth login`.",
    );
  const versionError = checkCommand(executable, ["--version"]);
  if (versionError)
    return dependencyStatus(
      "github",
      "GitHub provider",
      "unavailable",
      executable,
      `GitHub CLI could not run: ${versionError}`,
      "Repair or reinstall GitHub CLI, then check again.",
    );
  const authError = checkCommand(executable, ["auth", "status", "--hostname", "github.com"]);
  if (!authError)
    return dependencyStatus(
      "github",
      "GitHub provider",
      "available",
      executable,
      "GitHub CLI is installed and authenticated.",
      null,
    );
  if (looksLikeAuthenticationFailure(authError))
    return dependencyStatus(
      "github",
      "GitHub provider",
      "unauthenticated",
      executable,
      `GitHub CLI is not authenticated: ${authError}`,
      "Run `gh auth login` in your terminal; Mission Manager will not log in for you.",
    );
  return dependencyStatus(
    "github",
    "GitHub provider",
    "unavailable",
    executable,
    `GitHub authentication status could not be checked: ${authError}`,
    "Check network access to github.com, then check again.",
  );
}

function checkLocalDependency(
  store: SqliteStore,
  key: string,
  label: string,
  settingKey: string,
  missingAction: string,
): DependencyStatus {
  const executable = resolveAndStoreExecutable(store, key, settingKey);
  if (!executable)
    return dependencyStatus(key, label, "missing", null, `${label} was not found.`, missingAction);
  return dependencyStatus(key, label, "available", executable, `${label} is installed.`, null);
}

function resolveAndStoreExecutable(
  store: SqliteStore,
  name: string,
  settingKey: string,
): string | null {
  const resolved = resolveExecutable(name, store.setting(settingKey));
  if (resolved) store.setSetting(settingKey, resolved);
  return resolved;
}

export function looksLikeAuthenticationFailure(detail: string): boolean {
  const lowercase = detail.toLowerCase();
  return [
    "not logged in",
    "not authenticated",
    "no accounts",
    "authentication token",
    "token is invalid",
  ].some((marker) => lowercase.includes(marker));
}

function parseProvider(value: unknown): ProviderChoice {
  if (value === "github" || value === "none") return value;
  throw new Error(`Unknown provider choice: ${String(value)}`);
}
