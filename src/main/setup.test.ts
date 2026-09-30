import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCommand, resolveExecutable } from "./dependencies";
import { Runtime } from "./runtime";
import {
  createSetupCommandHandlers,
  getHealthStatus,
  looksLikeAuthenticationFailure,
} from "./setup";
import { openSqliteStore } from "./persistence/sqlite-store";

const directories: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "setup-test-"));
  directories.push(directory);
  return directory;
}

function executable(filePath: string, contents: string) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("setup commands", () => {
  it("completes setup by reusing Personal and persists the provider across reopening", () => {
    const file = path.join(temporaryDirectory(), "mission-manager.sqlite");
    const store = openSqliteStore(file);
    const runtime = new Runtime(store);
    const commands = createSetupCommandHandlers(runtime, store);

    expect(commands.complete_setup({ contextName: " Personal ", provider: "github" })).toEqual({
      completed: true,
      provider: "github",
    });
    expect(runtime.snapshot().contexts).toHaveLength(1);
    store.close();

    const reopened = openSqliteStore(file);
    expect(reopened.getSetupState()).toEqual({ completed: true, provider: "github" });
    reopened.close();
  });

  it("creates the requested Context and rejects a blank name with the Rust message", () => {
    const file = path.join(temporaryDirectory(), "mission-manager.sqlite");
    const store = openSqliteStore(file);
    const runtime = new Runtime(store);
    const commands = createSetupCommandHandlers(runtime, store);

    expect(commands.complete_setup({ contextName: " Studio ", provider: "none" })).toEqual({
      completed: true,
      provider: "none",
    });
    expect(runtime.snapshot().contexts.map(({ name }) => name)).toEqual(["Personal", "Studio"]);
    expect(() => commands.complete_setup({ contextName: "  ", provider: "none" })).toThrow(
      "A Context name is required to finish setup",
    );
    store.close();
  });

  it("resolves a valid stored executable before PATH and returns an absolute path", () => {
    const directory = temporaryDirectory();
    const stored = path.join(directory, "stored-gh");
    const fromPath = path.join(directory, "path-gh");
    executable(stored, "#!/bin/sh\nexit 0\n");
    executable(fromPath, "#!/bin/sh\nexit 0\n");
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      const resolved = resolveExecutable("path-gh", stored);
      expect(resolved).toBe(realpathSync(stored));
      expect(path.isAbsolute(resolved ?? "")).toBe(true);
      expect(resolveExecutable("path-gh", null)).toBe(realpathSync(fromPath));
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("reports healthy tmux independently from GitHub authentication and stores resolved paths", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "mission-manager.sqlite");
    const tmux = path.join(directory, "tmux");
    const gh = path.join(directory, "gh");
    executable(tmux, "#!/bin/sh\nprintf 'tmux 3.4\\n'\n");
    executable(
      gh,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf \'NOT LOGGED IN\\n\' >&2\nexit 1\n',
    );
    const store = openSqliteStore(file);
    store.setSetting("tmux_executable_path", tmux);
    store.setSetting("gh_executable_path", gh);
    store.setSetting("setup_completed", "true");
    store.setSetting("provider_choice", "github");

    const health = getHealthStatus(store, null);
    expect(health.runtime.state).toBe("available");
    expect(health.provider.state).toBe("unauthenticated");
    expect(health.runtime.executablePath).toBe(realpathSync(tmux));
    expect(store.setting("tmux_executable_path")).toBe(realpathSync(tmux));
    expect(health.provider.action).toContain("gh auth login");
    store.close();
  });

  it("uses each Rust authentication marker and returns command stderr", () => {
    for (const marker of [
      "not logged in",
      "not authenticated",
      "no accounts",
      "authentication token",
      "token is invalid",
    ])
      expect(looksLikeAuthenticationFailure(marker.toUpperCase())).toBe(true);
    expect(looksLikeAuthenticationFailure("network is unavailable")).toBe(false);

    const directory = temporaryDirectory();
    const failure = path.join(directory, "failure");
    executable(failure, "#!/bin/sh\nprintf 'not logged in\\n' >&2\nexit 1\n");
    expect(checkCommand(failure, ["auth", "status"])).toBe("not logged in");
  });

  it("matches Rust's fallback health messages when tmux and commands fail silently", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "mission-manager.sqlite");
    const tmux = path.join(directory, "tmux");
    executable(tmux, "#!/bin/sh\nexit 1\n");
    const store = openSqliteStore(file);
    store.setSetting("tmux_executable_path", tmux);

    expect(checkCommand(tmux, ["-V"])).toBe("command exited with exit status: 1");
    expect(getHealthStatus(store, "none").runtime.message).toBe(
      "tmux could not be checked: tmux exited with exit status: 1",
    );
    store.close();
  });

  it("formats process launch failures with Rust's OS error text", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "mission-manager.sqlite");
    const tmux = path.join(directory, "tmux");
    executable(tmux, "#!/missing/interpreter\nexit 1\n");
    const store = openSqliteStore(file);
    store.setSetting("tmux_executable_path", tmux);

    expect(checkCommand(path.join(directory, "missing"), ["-V"])).toBe(
      "No such file or directory (os error 2)",
    );
    expect(getHealthStatus(store, "none").runtime.message).toBe(
      "tmux could not be checked: could not run tmux: No such file or directory (os error 2)",
    );
    store.close();
  });
});
