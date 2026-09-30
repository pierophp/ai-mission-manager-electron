import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyLocalMarkdown,
  classifyUrl,
  findValue,
  ProviderDispatch,
  readMarkdownSnapshot,
  unwrapData,
} from "./provider";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fakeCli(script: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-test-"));
  dirs.push(dir);
  const cli = path.join(dir, "cli");
  writeFileSync(cli, script);
  chmodSync(cli, 0o755);
  return { dir, cli };
}

describe("provider URL classification", () => {
  it("matches the Rust GitHub and mixed provider identity fixtures", () => {
    expect(classifyUrl("https://github.com/Acme/App/issues/7?foo=bar")).toEqual({
      provider: "github",
      kind: "issue",
      external_key: "issue:acme/app#7",
      canonical_url: "https://github.com/acme/app/issues/7",
    });
    expect(classifyUrl("https://www.github.com/acme/app/pull/7/").canonical_url).toBe(
      "https://github.com/acme/app/pull/7",
    );
    expect(classifyUrl("https://ACME.atlassian.net/browse/PROJ-123/?x=1#comment")).toMatchObject({
      provider: "atlassian",
      kind: "issue",
      external_key: "jira:acme#PROJ-123",
    });
    expect(classifyUrl("https://bitbucket.org/Ws/Repo/pull-requests/89/")).toMatchObject({
      provider: "atlassian",
      kind: "pull_request",
      external_key: "bitbucket:ws/repo#89",
    });
    expect(classifyUrl("https://dev.azure.com/ORG/Proj/_workitems/edit/123?x=1")).toMatchObject({
      provider: "azure_dev_ops",
      kind: "issue",
      external_key: "ado:org/proj#123",
    });
    expect(classifyUrl("https://example.com/a")).toMatchObject({
      provider: "generic",
      kind: "generic",
      canonical_url: "https://example.com/a",
    });
    expect(() => classifyUrl("  ")).toThrow("the external URL cannot be blank");
  });

  it("unwraps nested data and finds values recursively like the Rust parser", () => {
    const value = { data: { result: [{ fields: { title: "nested" } }] } };
    expect(findValue(unwrapData(value), ["title"])).toBe("nested");
  });

  it("classifies local Markdown by repository-relative path and rejects paths outside the checkout", async () => {
    const { dir } = fakeCli("#!/bin/sh\nexit 0\n");
    const root = path.join(dir, "repo");
    const docs = path.join(root, "docs");
    mkdirSync(docs, { recursive: true });
    const markdown = path.join(docs, "Issue 42.md");
    writeFileSync(markdown, "# Ticket");
    await expect(classifyLocalMarkdown(17, root, markdown)).resolves.toMatchObject({
      provider: "generic",
      kind: "generic",
      external_key: "local:17#docs/Issue 42.md",
    });
    await expect(classifyLocalMarkdown(17, root, path.join(dir, "outside.md"))).resolves.toBeNull();
  });
});

describe("local Markdown snapshots", () => {
  it("trims title lines and reads status only from the first twelve lines", async () => {
    const { dir } = fakeCli("");
    const filename = path.join(dir, "spec.md");
    writeFileSync(
      filename,
      `   #  Local title  \n${"\n".repeat(10)} status : In progress \nstatus: Later\n`,
    );
    await expect(readMarkdownSnapshot(filename, 12)).resolves.toMatchObject({
      title: "Local title",
      state: "In progress",
      metadata: [{ key: "status", value: "In progress" }],
      fetched_at: 12,
    });
    writeFileSync(filename, `${"\n".repeat(12)}status: Too late\n`);
    await expect(readMarkdownSnapshot(filename, 13)).resolves.toMatchObject({
      title: "spec",
      state: "Open",
      metadata: [{ key: "status", value: "Open" }],
    });
  });
});

describe("ProviderDispatch", () => {
  it("reads a GitHub snapshot and preserves Rust metadata ordering", async () => {
    const { cli } = fakeCli(
      `#!/bin/sh\nprintf '%s' '{"number":7,"title":"Ship it","state":"OPEN","author":{"login":"octocat"},"labels":[{"name":"ready"}],"milestone":{"title":"v1"},"createdAt":"2026-09-19","updatedAt":"2026-09-20"}'\n`,
    );
    const result = await new ProviderDispatch({ ghPath: cli }).fetchSnapshot(
      classifyUrl("https://github.com/acme/app/issues/7"),
      123,
    );
    expect(result).toEqual({
      title: "Ship it",
      state: "OPEN",
      fetched_at: 123,
      metadata: [
        { key: "number", value: "7" },
        { key: "author", value: "octocat" },
        { key: "labels", value: "ready" },
        { key: "milestone", value: "v1" },
        { key: "created", value: "2026-09-19" },
        { key: "updated", value: "2026-09-20" },
      ],
    });
  });

  it("uses the Rust GitHub comments argv and unwraps paginated slurp output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "provider-test-"));
    dirs.push(dir);
    const cli = path.join(dir, "cli");
    writeFileSync(
      cli,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(dir, "argv")}'\nprintf '%s' '[[{"id":7,"user":{"login":"octocat"},"body":"Please fix this","created_at":"2026-09-19T12:00:00Z"}],[{"id":8,"user":{"login":"hubot"},"body":"Second page","created_at":"2026-09-20T12:00:00Z"}]]'\n`,
    );
    chmodSync(cli, 0o755);
    const comments = await new ProviderDispatch({ ghPath: cli }).fetchComments(
      classifyUrl("https://github.com/acme/app/issues/7"),
    );
    expect(comments).toEqual([
      { id: 7, author: "octocat", body: "Please fix this", createdAt: "2026-09-19T12:00:00Z" },
      { id: 8, author: "hubot", body: "Second page", createdAt: "2026-09-20T12:00:00Z" },
    ]);
    expect(readFileSync(path.join(dir, "argv"), "utf8").trim()).toBe(
      "api repos/acme/app/issues/7/comments --paginate --slurp",
    );
  });

  it("creates a GitHub issue and comments with the documented argv", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "provider-test-"));
    dirs.push(dir);
    const cli = path.join(dir, "cli");
    writeFileSync(
      cli,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${path.join(dir, "argv")}'\nif [ "$1" = api ]; then printf '%s' '{"html_url":"https://github.com/acme/app/issues/42"}'; fi\n`,
    );
    chmodSync(cli, 0o755);
    const provider = new ProviderDispatch({ ghPath: cli });
    expect(await provider.createIssue("acme/app", "Ship the parser", "Keep the Item")).toBe(
      "https://github.com/acme/app/issues/42",
    );
    await provider.addComment(
      classifyUrl("https://github.com/acme/app/issues/42"),
      "Please review",
    );
    expect(readFileSync(path.join(dir, "argv"), "utf8").trim().split("\n")).toEqual([
      "api",
      "repos/acme/app/issues",
      "--method",
      "POST",
      "--raw-field",
      "title=Ship the parser",
      "--raw-field",
      "body=Keep the Item",
      "issue",
      "comment",
      "https://github.com/acme/app/issues/42",
      "--body",
      "Please review",
    ]);
  });

  it("reads an issue body and native sub-issues", async () => {
    const { cli } = fakeCli(
      `#!/bin/sh\nif [ "$1" = issue ]; then printf '%s' '{"body":"## Problem\\nShip safely"}'; else printf '%s\\n' '{"number":8,"state":"open","title":"Gate DevTools","html_url":"https://github.com/acme/app/issues/8"}'; fi\n`,
    );
    const result = await new ProviderDispatch({ ghPath: cli }).fetchIssueDocument(
      classifyUrl("https://github.com/acme/app/issues/7"),
    );
    expect(result).toEqual({
      body: "## Problem\nShip safely",
      bodyFormat: "markdown",
      subIssues: [
        {
          number: 8,
          state: "open",
          title: "Gate DevTools",
          url: "https://github.com/acme/app/issues/8",
        },
      ],
    });
  });

  it("appends TWG and Azure DevOps JSON flags after their operation arguments", async () => {
    const twgDir = mkdtempSync(path.join(tmpdir(), "provider-test-"));
    dirs.push(twgDir);
    const twgPath = path.join(twgDir, "twg");
    writeFileSync(
      twgPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(twgDir, "argv")}'\nprintf '%s' '{"data":{"summary":"Jira title","status":"Open"}}'\n`,
    );
    chmodSync(twgPath, 0o755);
    const jira = classifyUrl("https://acme.atlassian.net/browse/APP-17");
    await new ProviderDispatch({ twgPath, atlassianSite: "acme.atlassian.net" }).fetchSnapshot(
      jira,
      20,
    );
    expect(readFileSync(path.join(twgDir, "argv"), "utf8").trim()).toBe(
      "jira workitem get APP-17 --site acme.atlassian.net --output json",
    );
    const azDir = mkdtempSync(path.join(tmpdir(), "provider-test-"));
    dirs.push(azDir);
    const azPath = path.join(azDir, "az");
    writeFileSync(
      azPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(azDir, "argv")}'\nprintf '%s' '{"fields":{"System.Title":"ADO title","System.State":"Active"}}'\n`,
    );
    chmodSync(azPath, 0o755);
    await new ProviderDispatch({
      azPath,
      azureDevOpsOrganization: "https://dev.azure.com/acme",
    }).fetchSnapshot(classifyUrl("https://dev.azure.com/acme/project/_workitems/edit/23"), 21);
    expect(readFileSync(path.join(azDir, "argv"), "utf8").trim()).toContain(
      "--organization https://dev.azure.com/acme -o json",
    );
  });

  it("reads Jira, Confluence and Bitbucket snapshots, documents, and comments", async () => {
    const { dir } = fakeCli("#!/bin/sh\nexit 1\n");
    const cli = path.join(dir, "twg");
    writeFileSync(
      cli,
      `#!/bin/sh\ncase "$1 $2 $3" in\n  "jira workitem get") printf '%s' '{"key":"APP-7","summary":"Jira title","status":"In Progress","description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Jira "},{"type":"text","text":"description"}]}]}}' ;;\n  "jira workitem comment") printf '%s' '{"comments":[{"id":"31","author":{"displayName":"Ada"},"body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Jira comment"}]}]},"created":"2026-09-01"}]}' ;;\n  "confluence content get") printf '%s' '{"id":"456","title":"Runbook","version":{"number":9},"body":{"storage":{"value":"<p>Safe body</p>"}}}' ;;\n  "confluence content comments") printf '%s' '{"comments":[{"id":"32","author":{"displayName":"Grace"},"body":"Page comment","created":"2026-09-02"}]}' ;;\n  "bitbucket pull-requests get") printf '%s' '{"id":89,"title":"PR title","state":"OPEN"}' ;;\n  "bitbucket pull-requests comment") printf '%s' '{"comments":[{"id":"33","author":{"displayName":"Lin"},"body":"PR comment","created":"2026-09-03"}]}' ;;\nesac\n`,
    );
    chmodSync(cli, 0o755);
    const jira = classifyUrl("https://acme.atlassian.net/browse/APP-7");
    const provider = (site?: string, workspace?: string) =>
      new ProviderDispatch({ twgPath: cli, atlassianSite: site, bitbucketWorkspace: workspace });
    expect(await provider("acme.atlassian.net").fetchSnapshot(jira, 77)).toMatchObject({
      title: "Jira title",
      state: "In Progress",
    });
    expect(await provider("acme.atlassian.net").fetchDocument(jira)).toEqual({
      body: "Jira description",
      bodyFormat: "markdown",
    });
    expect(await provider("acme.atlassian.net").fetchComments(jira)).toMatchObject([
      { author: "Ada", body: "Jira comment" },
    ]);
    await expect(provider("acme.atlassian.net").addComment(jira, "A comment")).rejects.toThrow(
      "comment writing is not implemented for the Atlassian provider yet",
    );
    const page = classifyUrl("https://acme.atlassian.net/wiki/spaces/ENG/pages/456/Runbook");
    expect(await provider("acme.atlassian.net").fetchSnapshot(page, 78)).toMatchObject({
      title: "Runbook",
      state: "9",
      metadata: [{ key: "version", value: "9" }],
    });
    expect(await provider("acme.atlassian.net").fetchDocument(page)).toEqual({
      body: "<p>Safe body</p>",
      bodyFormat: "html",
    });
    expect(await provider("acme.atlassian.net").fetchComments(page)).toMatchObject([
      { author: "Grace", body: "Page comment" },
    ]);
    const pr = classifyUrl("https://bitbucket.org/team/repo/pull-requests/89");
    expect(await provider(undefined, "team").fetchSnapshot(pr, 79)).toMatchObject({
      title: "PR title",
      state: "OPEN",
    });
    expect(await provider(undefined, "team").fetchComments(pr)).toMatchObject([
      { author: "Lin", body: "PR comment" },
    ]);
    await expect(provider(undefined, "team").addComment(pr, "A comment")).rejects.toThrow(
      "comment writing is not implemented for the Atlassian provider yet",
    );
  });

  it("reads Azure DevOps work item and PR data, HTML description, comments, and filters deleted/system replies", async () => {
    const { dir } = fakeCli("#!/bin/sh\nexit 1\n");
    const cli = path.join(dir, "az");
    writeFileSync(
      cli,
      `#!/bin/sh\ncase "$1 $2 $3" in\n  "boards work-item show") if [ "$7" = System.Description ]; then printf '%s' '{"fields":{"System.Description":"<p>Work item body</p>"}}'; else printf '%s' '{"id":123,"fields":{"System.Title":"ADO bug","System.State":"Active","System.WorkItemType":"Bug","System.AssignedTo":{"displayName":"Ada Lovelace"},"System.CreatedDate":"2026-09-02","System.ChangedDate":"2026-09-03","System.Tags":"urgent"}}'; fi ;;\n  "repos pr show") printf '%s' '{"pullRequestId":456,"title":"ADO PR","status":"active","createdBy":{"displayName":"Grace Hopper"},"repository":{"id":"repo-guid-123","name":"engine"},"creationDate":"2026-09-04"}' ;;\nesac\ncase "$*" in\n *"resource workItems/"*) printf '%s' '{"comments":[{"commentId":77,"createdBy":{"displayName":"Lin"},"text":"A comment","createdDate":"2026-09-05"}]}' ;;\n *"resource repositories/"*) printf '%s' '{"value":[{"isDeleted":false,"comments":[{"id":1,"author":{"displayName":"System"},"content":"System update","commentType":"system"}]},{"isDeleted":true,"comments":[{"id":2,"content":"Deleted thread"}]},{"isDeleted":false,"comments":[{"id":4,"author":{"displayName":"Reviewer"},"content":"Review note","commentType":"text"},{"id":5,"content":"Code changed","commentType":"codeChange"},{"id":6,"author":{"displayName":"Reviewer"},"content":"Deleted reply","commentType":"text","isDeleted":true},{"id":7,"author":{"displayName":"Reviewer"},"content":"Reply","commentType":"text"}]}]}' ;;\nesac\n`,
    );
    chmodSync(cli, 0o755);
    const provider = new ProviderDispatch({
      azPath: cli,
      azureDevOpsOrganization: "acme-engineering",
    });
    const issue = classifyUrl(
      "https://dev.azure.com/acme-engineering/Platform/_workitems/edit/123",
    );
    expect(await provider.fetchSnapshot(issue, 800)).toMatchObject({
      title: "ADO bug",
      state: "Active",
      metadata: expect.arrayContaining([{ key: "type", value: "Bug" }]),
    });
    expect(await provider.fetchDocument(issue)).toEqual({
      body: "<p>Work item body</p>",
      bodyFormat: "html",
    });
    expect(await provider.fetchComments(issue)).toMatchObject([
      { author: "Lin", body: "A comment" },
    ]);
    const pr = classifyUrl(
      "https://dev.azure.com/acme-engineering/Platform/_git/engine/pullrequest/456",
    );
    expect(await provider.fetchSnapshot(pr, 801)).toMatchObject({
      title: "ADO PR",
      state: "active",
    });
    expect(await provider.fetchComments(pr)).toMatchObject([
      { author: "Reviewer", body: "Review note" },
      { author: "Reviewer", body: "Reply" },
    ]);
    await expect(provider.addComment(issue, "A comment")).rejects.toThrow(
      "comment writing is not implemented for the AzureDevOps provider yet",
    );
  });

  it("returns provider-prefixed process errors", async () => {
    const { cli } = fakeCli("#!/bin/sh\nprintf '%s' 'bad credentials' >&2\nexit 1\n");
    await expect(
      new ProviderDispatch({ ghPath: cli }).fetchSnapshot(
        classifyUrl("https://github.com/acme/app/issues/7"),
        1,
      ),
    ).rejects.toThrow("GitHub CLI failed: bad credentials");
    const { cli: az } = fakeCli("#!/bin/sh\nprintf '%s' 'not a valid command' >&2\nexit 2\n");
    await expect(
      new ProviderDispatch({
        azPath: az,
        azureDevOpsOrganization: "acme",
      }).fetchSnapshot(classifyUrl("https://dev.azure.com/acme/project/_workitems/edit/7"), 2),
    ).rejects.toThrow(
      "Azure DevOps CLI (az) failed: Azure DevOps CLI extension `azure-devops` is unavailable.",
    );
  });
});
