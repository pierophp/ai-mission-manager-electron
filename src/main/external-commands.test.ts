import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime";
import { newContextConfiguration, openSqliteStore } from "./persistence/sqlite-store";
import { createExternalCommandHandlers, githubRepositoryName } from "./external-commands";
import { homeView } from "../domain/projections";

const dirs: string[] = [];
let originalPath: string | undefined;
let shouldRestorePath = false;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (shouldRestorePath) {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    originalPath = undefined;
    shouldRestorePath = false;
  }
});

describe("External Object commands and persistence", () => {
  it("matches Rust GitHub repository remote parsing and validation", () => {
    expect(githubRepositoryName("https://github.com/Acme/App.git")).toBe("acme/app");
    expect(githubRepositoryName("http://www.github.com/Acme/App")).toBe("acme/app");
    expect(githubRepositoryName("git://github.com/Acme/App.git")).toBe("acme/app");
    expect(githubRepositoryName("git@github.com:Acme/App.git")).toBe("acme/app");
    expect(githubRepositoryName("ssh://git@github.com/Acme/App.git")).toBe("acme/app");
    expect(githubRepositoryName("ftp://github.com/acme/app")).toBeNull();
    expect(githubRepositoryName("https://github.com/-acme/app")).toBeNull();
    expect(githubRepositoryName("https://github.com/acme/.app")).toBeNull();
    expect(githubRepositoryName("https://github.com/acme/app/issues")).toBeNull();
  });

  it("rejects a link whose External Object appeared while its snapshot was being fetched", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "external-link-race-"));
    dirs.push(dir);
    const cli = path.join(dir, "gh");
    writeFileSync(
      cli,
      `#!/bin/sh\nprintf '%s' '{"number":90,"title":"Fetched","state":"OPEN","author":{"login":"octocat"},"labels":[],"milestone":null,"createdAt":null,"updatedAt":null}'\n`,
    );
    chmodSync(cli, 0o755);
    const store = openSqliteStore(path.join(dir, "mission-manager.sqlite"));
    const initial = store.loadState();
    initial.contexts[0].gh_executable_path = cli;
    const runtime = new Runtime(store, initial);
    runtime.dispatch({
      type: "create_item",
      title: "Concurrent link",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    const originalSnapshot = runtime.snapshot.bind(runtime);
    let snapshots = 0;
    runtime.snapshot = () => {
      snapshots += 1;
      if (snapshots === 3)
        runtime.dispatch({
          type: "link_external_object",
          itemId: 1,
          object: {
            provider: "github",
            kind: "issue",
            external_key: "issue:acme/app#90",
            canonical_url: "https://github.com/acme/app/issues/90",
          },
          snapshot: null,
        });
      return originalSnapshot();
    };
    const handlers = createExternalCommandHandlers(runtime);
    await expect(
      handlers.link_external_object({
        itemId: 1,
        url: "https://github.com/acme/app/issues/90",
      }),
    ).rejects.toThrow(
      "The Item or External Object changed while the link was being prepared; try again",
    );
    runtime.snapshot = originalSnapshot;
    expect(runtime.snapshot().external_objects).toHaveLength(1);
    expect(runtime.snapshot().snapshots).toHaveLength(0);
    store.close();
  });

  it("links a GitHub snapshot, records refresh changes byte-for-byte, and survives reopen", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "external-object-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "mission-manager.sqlite");
    const calls = path.join(dir, "calls");
    const cli = path.join(dir, "gh");
    writeFileSync(
      cli,
      `#!/bin/sh\nif [ "$1" = issue ] && [ "$2" = view ] && [ "$5" = body ]; then printf '%s' '{"body":"## Problem\\nKeep provider behaviour"}'; exit 0; fi\nif [ "$1" = issue ] && [ "$2" = comment ]; then printf '%s' 'https://github.com/acme/app/issues/7#issuecomment-1'; exit 0; fi\nif [ "$1" = api ] && [ "$2" = repos/acme/app/issues/7/sub_issues ]; then printf '%s\\n' '{"number":8,"title":"Port provider tests","state":"open","html_url":"https://github.com/acme/app/issues/8"}'; exit 0; fi\nif [ "$1" = api ] && [ "$2" = repos/acme/app/issues/7/comments ]; then printf '%s' '[[{"id":12,"user":{"login":"octocat"},"body":"Review this","created_at":"2026-09-30T10:00:00Z"}]]'; exit 0; fi\ncount=0; [ -f '${calls}' ] && count=$(cat '${calls}'); count=$((count + 1)); printf '%s' "$count" > '${calls}'\nif [ "$count" -eq 1 ]; then printf '%s' '{"number":7,"title":"Initial","state":"OPEN","author":{"login":"octocat"},"labels":[{"name":"ready"}],"milestone":null,"createdAt":null,"updatedAt":null}'; else printf '%s' '{"number":7,"title":"Updated","state":"CLOSED","author":{"login":"octocat"},"labels":[{"name":"done"}],"milestone":null,"createdAt":null,"updatedAt":null}'; fi\n`,
    );
    chmodSync(cli, 0o755);
    const store = openSqliteStore(dbPath);
    const initial = store.loadState();
    initial.contexts[0].gh_executable_path = cli;
    initial.contexts[0].atlassian_site = "different";
    initial.contexts[0].twg_executable_path = path.join(dir, "missing-twg");
    const runtime = new Runtime(store, initial);
    runtime.dispatch({
      type: "create_item",
      title: "Track external work",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    const handlers = createExternalCommandHandlers(runtime);
    const linked = await handlers.link_external_object({
      itemId: 1,
      url: "https://github.com/acme/app/issues/7",
    });
    expect(linked.link.object).toMatchObject({
      provider: "github",
      kind: "issue",
      external_key: "issue:acme/app#7",
    });
    expect(handlers.set_link_purpose({ linkId: 1, purpose: "to-spec" }).link.purpose).toBe(
      "to-spec",
    );
    expect(handlers.set_link_purpose({ linkId: 1, purpose: "others" }).link.purpose).toBe("others");
    expect(linked.link.snapshot).toMatchObject({
      title: "Initial",
      state: "OPEN",
      metadata: [
        { key: "number", value: "7" },
        { key: "author", value: "octocat" },
        { key: "labels", value: "ready" },
      ],
    });
    const objectInput = {
      provider: "github" as const,
      kind: "issue" as const,
      external_key: "issue:acme/app#7",
      canonical_url: "https://github.com/acme/app/issues/7",
    };
    expect(() =>
      runtime.dispatch({
        type: "link_external_object",
        itemId: 1,
        object: { ...objectInput, canonical_url: " " },
        snapshot: null,
      }),
    ).toThrow("an external URL cannot be blank");
    expect(() =>
      runtime.dispatch({
        type: "link_external_object",
        itemId: 1,
        object: { ...objectInput, external_key: " " },
        snapshot: null,
      }),
    ).toThrow("an external object key cannot be blank");
    expect(() =>
      runtime.dispatch({
        type: "link_external_object",
        itemId: 1,
        object: objectInput,
        snapshot: null,
      }),
    ).toThrow("the Link already exists");
    const refreshed = await handlers.refresh_external_object({ externalObjectId: 1 });
    expect(refreshed.title).toBe("Updated");
    runtime.dispatch({
      type: "create_item",
      title: "Share external object",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    const { readFile } = await import("node:fs/promises");
    const callsBeforeRelink = await readFile(calls, "utf8");
    const secondLink = await handlers.link_external_object({
      itemId: 2,
      url: "https://github.com/acme/app/issues/7",
    });
    expect(secondLink.link.snapshot?.title).toBe("Updated");
    expect(await readFile(calls, "utf8")).toBe(callsBeforeRelink);
    const home = homeView(runtime.snapshot(), 1, "9999-12-31T23:59:59Z");
    expect(home.attention_entries).toContainEqual(
      expect.objectContaining({ kind: "external_change", link_id: 1, item_id: 1 }),
    );
    expect(home.needs_attention.map(({ item }) => item.id)).toContain(1);
    runtime.dispatch({ type: "mark_link_reviewed", linkId: 1 });
    expect(homeView(runtime.snapshot(), 1, "9999-12-31T23:59:59Z").attention_entries).toEqual([]);
    const scheduledReview = runtime.snapshot();
    scheduledReview.links[0].review_at = "2026-09-30T00:00:00Z";
    expect(homeView(scheduledReview, 1, "2026-09-30T12:00:00Z").attention_entries).toContainEqual(
      expect.objectContaining({ kind: "review", link_id: 1, item_id: 1 }),
    );
    await expect(handlers.fetch_issue_document({ externalObjectId: 1 })).resolves.toEqual({
      body: "## Problem\nKeep provider behaviour",
      bodyFormat: "markdown",
      subIssues: [
        {
          number: 8,
          title: "Port provider tests",
          state: "open",
          url: "https://github.com/acme/app/issues/8",
        },
      ],
    });
    await expect(handlers.fetch_external_comments({ externalObjectId: 1 })).resolves.toEqual([
      { id: 12, author: "octocat", body: "Review this", createdAt: "2026-09-30T10:00:00Z" },
    ]);
    await expect(
      handlers.add_external_comment({ linkId: 1, body: "Looks good" }),
    ).resolves.toMatchObject({ object: { external_key: "issue:acme/app#7" } });
    const jira = await handlers.link_external_object({
      itemId: 1,
      url: "https://acme.atlassian.net/browse/APP-7",
    });
    expect(jira.warning).toContain("Atlassian TWG CLI failed");
    expect(jira.warning).toContain("targets a different site or organization");
    await expect(
      handlers.add_external_comment({ linkId: jira.link.link.id, body: "Looks good" }),
    ).rejects.toThrow("comment writing is not implemented for the Atlassian provider yet");
    const pull = await handlers.link_external_object({
      itemId: 1,
      url: "https://github.com/acme/app/pull/44",
    });
    await expect(
      handlers.fetch_issue_document({ externalObjectId: pull.link.object.id }),
    ).rejects.toThrow("Only Issues and documents can be read as a spec document");
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      raw.prepare("SELECT metadata_json FROM external_snapshots WHERE external_object_id=1").get(),
    ).toEqual({
      metadata_json:
        '[{"key":"number","value":"7"},{"key":"author","value":"octocat"},{"key":"labels","value":"done"}]',
    });
    expect(
      raw.prepare("SELECT changes_json FROM activities WHERE external_object_id=1").get(),
    ).toEqual({
      changes_json:
        '[{"kind":"title","key":null,"previous":"Initial","current":"Updated"},{"kind":"state","key":null,"previous":"OPEN","current":"CLOSED"},{"kind":"metadata","key":"labels","previous":"ready","current":"done"}]',
    });
    raw.close();
    store.close();
    const reopened = openSqliteStore(dbPath);
    expect(reopened.loadState().snapshots[0]).toMatchObject({ title: "Updated", state: "CLOSED" });
    expect(reopened.loadState().activities[0].changes[0]).toEqual({
      kind: "title",
      key: null,
      previous: "Initial",
      current: "Updated",
    });
    reopened.close();
  });

  it("links Markdown inside a registered local checkout and reads its document and ticket files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "external-markdown-"));
    dirs.push(dir);
    const repository = path.join(dir, "repo");
    const issues = path.join(repository, "features", "login", "issues");
    const spec = path.join(repository, "features", "login", "spec.md");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(issues, { recursive: true });
    writeFileSync(
      spec,
      "# Login spec\nstatus: Draft\nSpec body\n\n## Comments\nDiscuss before shipping\n",
    );
    writeFileSync(path.join(issues, "12-auth.md"), "# Add auth flow\nstatus: Open\n");
    const store = openSqliteStore(path.join(dir, "mission-manager.sqlite"));
    const runtime = new Runtime(store);
    runtime.dispatch({
      type: "register_machine",
      contextId: 1,
      name: "Local",
      socketName: "local",
      transport: { kind: "local" },
    });
    runtime.dispatch({ type: "set_context_execution_machine", contextId: 1, machineId: 1 });
    runtime.dispatch({
      type: "register_repository_at_location",
      projectId: 1,
      name: "app",
      remoteUrl: "https://github.com/acme/app.git",
      baseBranch: "main",
      machineId: 1,
      checkoutPath: repository,
      worktreeRoot: path.join(dir, "worktrees"),
    });
    runtime.dispatch({
      type: "create_item",
      title: "Read spec",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    const handlers = createExternalCommandHandlers(runtime);
    const linked = await handlers.link_external_object({ itemId: 1, url: spec });
    expect(linked.link.object).toMatchObject({
      provider: "generic",
      kind: "generic",
      external_key: "local:1#features/login/spec.md",
    });
    expect(linked.link.snapshot).toMatchObject({ title: "Login spec", state: "Draft" });
    await expect(handlers.fetch_issue_document({ externalObjectId: 1 })).resolves.toMatchObject({
      body: "# Login spec\nstatus: Draft\nSpec body",
      subIssues: [
        {
          number: 12,
          title: "Add auth flow",
          state: "Open",
          url: "local:1#features/login/issues/12-auth.md",
        },
      ],
    });
    await expect(handlers.fetch_external_document({ externalObjectId: 1 })).resolves.toBe(
      "# Login spec\nstatus: Draft\nSpec body",
    );
    await expect(handlers.fetch_external_comments({ externalObjectId: 1 })).resolves.toEqual([
      { id: 0, author: "Local Markdown", body: "Discuss before shipping", createdAt: "" },
    ]);
    await expect(handlers.add_external_comment({ linkId: 1, body: "Add note" })).rejects.toThrow(
      "Comments are only supported for provider Issues and pull requests",
    );
    const outside = path.join(dir, "outside.md");
    writeFileSync(outside, "# Outside\n");
    const escape = path.join(repository, "features", "login", "escape.md");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, escape);
    const malicious = runtime.snapshot();
    malicious.external_objects[0].external_key = "local:1#features/login/escape.md";
    const unsafeHandlers = createExternalCommandHandlers(new Runtime(store, malicious));
    await expect(unsafeHandlers.fetch_external_document({ externalObjectId: 1 })).rejects.toThrow(
      "The local Markdown file is outside its registered Repository checkout",
    );
    const issueBackup = `${issues}.backup`;
    const outsideIssues = path.join(dir, "outside-issues");
    mkdirSync(outsideIssues);
    writeFileSync(path.join(outsideIssues, "99-outside.md"), "# Outside ticket\n");
    const { renameSync } = await import("node:fs");
    renameSync(issues, issueBackup);
    symlinkSync(outsideIssues, issues);
    const directoryEscapeHandlers = createExternalCommandHandlers(
      new Runtime(store, runtime.snapshot()),
    );
    await expect(
      directoryEscapeHandlers.fetch_issue_document({ externalObjectId: 1 }),
    ).rejects.toThrow("outside its registered Repository checkout");
    rmSync(issues);
    renameSync(issueBackup, issues);
    symlinkSync(outside, path.join(issues, "14-external-link.md"));
    await expect(handlers.fetch_issue_document({ externalObjectId: 1 })).resolves.toMatchObject({
      subIssues: [expect.objectContaining({ number: 12, title: "Add auth flow" })],
    });
    store.close();
  });

  it("applies only the newest poll observation and persists Link attention fields", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "external-poll-generation-"));
    dirs.push(dir);
    const gate = path.join(dir, "first-poll-started");
    const cli = path.join(dir, "gh");
    writeFileSync(
      cli,
      `#!/bin/sh\nif mkdir '${gate}' 2>/dev/null; then sleep 0.4; printf '%s' '{"number":7,"title":"Old response","state":"OPEN","author":{"login":"octocat"},"labels":[],"milestone":null,"createdAt":null,"updatedAt":null}'; else printf '%s' '{"number":7,"title":"Newest response","state":"CLOSED","author":{"login":"octocat"},"labels":[],"milestone":null,"createdAt":null,"updatedAt":null}'; fi\n`,
    );
    chmodSync(cli, 0o755);
    const dbPath = path.join(dir, "mission-manager.sqlite");
    const store = openSqliteStore(dbPath);
    const initial = store.loadState();
    initial.contexts[0].gh_executable_path = cli;
    const runtime = new Runtime(store, initial);
    runtime.dispatch({
      type: "create_item",
      title: "Watch provider change",
      contextId: 1,
      projectId: 1,
      notes: "",
    });
    runtime.dispatch({
      type: "link_external_object",
      itemId: 1,
      object: {
        provider: "github",
        kind: "issue",
        external_key: "issue:acme/app#7",
        canonical_url: "https://github.com/acme/app/issues/7",
      },
      snapshot: { title: "Initial", state: "OPEN", metadata: [], fetched_at: 1 },
    });
    const handlers = createExternalCommandHandlers(runtime);
    const firstPoll = handlers.poll_external_objects();
    for (
      let attempts = 0;
      attempts < 100 && !(await import("node:fs").then(({ existsSync }) => existsSync(gate)));
      attempts++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const secondPoll = handlers.poll_external_objects();
    await expect(secondPoll).resolves.toMatchObject({ refreshed: 1, failures: [] });
    await expect(firstPoll).resolves.toMatchObject({
      refreshed: 0,
      failures: [
        {
          external_object_id: 1,
          error: "A newer snapshot for External Object 1 was already applied; poll it again",
        },
      ],
    });
    expect(runtime.snapshot().snapshots[0].title).toBe("Newest response");

    const link = runtime.snapshot().links[0];
    const reviewed = await handlers.set_link_attention_policy({
      linkId: link.id,
      policy: { title: true, state: false, metadata: false },
    });
    expect(reviewed.attention_policy).toEqual({ title: true, state: false, metadata: false });
    await handlers.set_link_watch_until({ linkId: link.id, watchUntil: "2026-09-30T10:00" });
    await handlers.set_link_review_at({ linkId: link.id, reviewAt: "2026-10-01T10:00" });
    const updated = runtime.snapshot().links[0];
    updated.provenance = {
      run_id: 9,
      action: "to-tickets",
      discovery: "structured-event",
      ordinal: null,
      blocked_by: ["#4"],
    };
    new Runtime(store, { ...runtime.snapshot(), links: [updated] }).dispatch({
      type: "set_link_attention_policy",
      linkId: link.id,
      policy: { title: false, state: true, metadata: false },
    });
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      raw
        .prepare(
          "SELECT watch_until, review_at, provenance_json FROM link_attention_state WHERE link_id=1",
        )
        .get(),
    ).toEqual({
      watch_until: "2026-09-30T10:00",
      review_at: "2026-10-01T10:00",
      provenance_json:
        '{"run_id":9,"action":"to-tickets","discovery":"structured-event","ordinal":null,"blocked_by":["#4"]}',
    });
    raw.close();
    store.close();
  });

  it("keeps attention independent for each Link to the same External Object", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "external-link-attention-"));
    dirs.push(dir);
    const store = openSqliteStore(path.join(dir, "mission-manager.sqlite"));
    const runtime = new Runtime(store);
    for (const title of ["First commitment", "Second commitment"])
      runtime.dispatch({ type: "create_item", title, contextId: 1, projectId: 1, notes: "" });
    const object = {
      provider: "generic" as const,
      kind: "generic" as const,
      external_key: "shared-object",
      canonical_url: "https://example.com/shared-object",
    };
    for (const itemId of [1, 2])
      runtime.dispatch({
        type: "link_external_object",
        itemId,
        object,
        snapshot: { title: "Initial", state: "open", metadata: [], fetched_at: 1 },
      });
    runtime.dispatch({
      type: "refresh_external_object",
      externalObjectId: 1,
      snapshot: { title: "Updated", state: "open", metadata: [], fetched_at: 2 },
    });
    const handlers = createExternalCommandHandlers(runtime);
    expect(homeView(runtime.snapshot(), 1, "9999-12-31T23:59:59Z").attention_entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "external_change", link_id: 1 }),
        expect.objectContaining({ kind: "external_change", link_id: 2 }),
      ]),
    );
    await handlers.mark_link_reviewed({ linkId: 1 });
    expect(homeView(runtime.snapshot(), 1, "9999-12-31T23:59:59Z").attention_entries).toEqual([
      expect.objectContaining({ kind: "external_change", link_id: 2, item_id: 2 }),
    ]);
    store.close();
  });

  it("polls each linked Context with its provider configuration and skips local objects", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "external-context-poll-"));
    dirs.push(dir);
    const firstCli = path.join(dir, "twg-first");
    const secondCli = path.join(dir, "az-second");
    const thirdCli = path.join(dir, "twg");
    const firstLog = path.join(dir, "first.log");
    const secondLog = path.join(dir, "second.log");
    const thirdLog = path.join(dir, "third.log");
    for (const [executable, script] of [
      [
        firstCli,
        `#!/bin/sh\nprintf '%s\\n' "$*" > '${firstLog}'\nprintf '%s' '{"title":"Jira title","status":"In Progress"}'\n`,
      ],
      [
        secondCli,
        `#!/bin/sh\nprintf '%s\\n' "$*" > '${secondLog}'\nprintf '%s' '{"fields":{"System.Title":"ADO title","System.State":"Active"}}'\n`,
      ],
      [
        thirdCli,
        `#!/bin/sh\nprintf '%s\\n' "$*" > '${thirdLog}'\nprintf '%s' 'isolated Context failure' >&2\nexit 1\n`,
      ],
    ] as const) {
      writeFileSync(executable, script);
      chmodSync(executable, 0o755);
    }

    const store = openSqliteStore(path.join(dir, "mission-manager.sqlite"));
    const runtime = new Runtime(store);
    runtime.dispatch({ type: "create_context", name: "Second Context" });
    runtime.dispatch({ type: "create_context", name: "Third Context" });
    const contextConfig = newContextConfiguration();
    contextConfig.name = "Personal";
    contextConfig.attentionDefaults = contextConfig.attentionDefaults.filter(
      ({ object_kind }) => object_kind !== "document",
    );
    contextConfig.attentionDefaults.forEach((entry) => (entry.context_id = 1));
    contextConfig.twgExecutablePath = firstCli;
    contextConfig.atlassianSite = "first.atlassian.net";
    runtime.dispatch({
      type: "update_context_configuration",
      contextId: 1,
      configuration: contextConfig,
    });
    const secondConfig = newContextConfiguration();
    secondConfig.name = "Second Context";
    secondConfig.attentionDefaults = secondConfig.attentionDefaults.filter(
      ({ object_kind }) => object_kind !== "document",
    );
    secondConfig.attentionDefaults.forEach((entry) => (entry.context_id = 2));
    secondConfig.azExecutablePath = secondCli;
    secondConfig.azureDevopsOrganization = "https://dev.azure.com/second-org";
    runtime.dispatch({
      type: "update_context_configuration",
      contextId: 2,
      configuration: secondConfig,
    });
    const thirdConfig = newContextConfiguration();
    thirdConfig.name = "Third Context";
    thirdConfig.attentionDefaults = thirdConfig.attentionDefaults.filter(
      ({ object_kind }) => object_kind !== "document",
    );
    thirdConfig.attentionDefaults.forEach((entry) => (entry.context_id = 3));
    originalPath = process.env.PATH;
    shouldRestorePath = true;
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
    thirdConfig.twgExecutablePath = null;
    thirdConfig.atlassianSite = "third.atlassian.net";
    runtime.dispatch({
      type: "update_context_configuration",
      contextId: 3,
      configuration: thirdConfig,
    });
    for (const [title, contextId, projectId] of [
      ["First Jira", 1, 1],
      ["Azure work item", 2, 2],
      ["Failing Jira", 3, 3],
    ] as const)
      runtime.dispatch({ type: "create_item", title, contextId, projectId, notes: "" });
    const inputs = [
      {
        itemId: 1,
        object: {
          provider: "atlassian" as const,
          kind: "issue" as const,
          external_key: "jira:PROJ#PROJ-7",
          canonical_url: "https://first.atlassian.net/browse/PROJ-7",
        },
      },
      {
        itemId: 2,
        object: {
          provider: "azure_dev_ops" as const,
          kind: "issue" as const,
          external_key: "ado:second-org/project#12",
          canonical_url: "https://dev.azure.com/second-org/project/_workitems/edit/12",
        },
      },
      {
        itemId: 3,
        object: {
          provider: "atlassian" as const,
          kind: "issue" as const,
          external_key: "jira:FAIL#FAIL-5",
          canonical_url: "https://third.atlassian.net/browse/FAIL-5",
        },
      },
      {
        itemId: 1,
        object: {
          provider: "generic" as const,
          kind: "generic" as const,
          external_key: "local:9#.scratch/spec.md",
          canonical_url: "file:///repository/.scratch/spec.md",
        },
      },
    ];
    for (const { itemId, object } of inputs)
      runtime.dispatch({ type: "link_external_object", itemId, object, snapshot: null });

    const result = await createExternalCommandHandlers(runtime).poll_external_objects();
    expect(result).toMatchObject({
      refreshed: 2,
      failures: [expect.objectContaining({ external_object_id: 3 })],
    });
    expect(result.failures[0].error).toContain("isolated Context failure");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(firstLog, "utf8")).toContain(
      "jira workitem get PROJ-7 --site first.atlassian.net --output json",
    );
    expect(await readFile(secondLog, "utf8")).toContain(
      "--organization https://dev.azure.com/second-org -o json",
    );
    expect(await readFile(thirdLog, "utf8")).toContain("jira workitem get FAIL-5");
    expect(runtime.snapshot().contexts.find(({ id }) => id === 3)?.twg_executable_path).toBe(
      thirdCli,
    );
    const snapshotTitles = runtime.snapshot().snapshots.map(({ title }) => title);
    expect(snapshotTitles).toContain("Jira title");
    expect(snapshotTitles).toContain("ADO title");
    expect(snapshotTitles).not.toContain("Local Markdown");
    store.close();
  });
});
