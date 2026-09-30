import { spawn } from "node:child_process";
import path from "node:path";
import { access, realpath, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ExternalComment,
  ExternalMetadata,
  ExternalObject,
  ExternalSnapshot,
  IssueDocument,
  SubIssue,
} from "../domain/types";

export type ExternalObjectInput = Pick<
  ExternalObject,
  "provider" | "kind" | "external_key" | "canonical_url"
>;
export type ExternalSnapshotData = Omit<ExternalSnapshot, "external_object_id">;
export type ExternalDocument = { body: string; bodyFormat: "markdown" | "html" };
export type ProviderConfig = {
  ghPath?: string | null;
  twgPath?: string | null;
  azPath?: string | null;
  atlassianSite?: string | null;
  bitbucketWorkspace?: string | null;
  azureDevOpsOrganization?: string | null;
};

export function classifyUrl(input: string): ExternalObjectInput {
  const raw = input.trim();
  if (!raw) throw new Error("the external URL cannot be blank");
  const clean = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const p = clean.split("/");
  const https = p[0] === "https:";
  const host = (p[2] ?? "").toLowerCase();
  const github =
    (host === "github.com" || host === "www.github.com") &&
    p.length === 7 &&
    p[3] &&
    p[4] &&
    /^\d+$/.test(p[6]) &&
    (p[5] === "issues" || p[5] === "pull");
  if (https && github) {
    const kind = p[5] === "issues" ? "issue" : "pull_request";
    const owner = p[3].toLowerCase();
    const repo = p[4].toLowerCase();
    const number = String(BigInt(p[6]));
    return {
      provider: "github",
      kind,
      external_key: `${kind === "issue" ? "issue" : "pull"}:${owner}/${repo}#${number}`,
      canonical_url: `https://github.com/${owner}/${repo}/${kind === "issue" ? "issues" : "pull"}/${number}`,
    };
  }
  if (https && host.endsWith(".atlassian.net")) {
    const site = host.slice(0, -".atlassian.net".length);
    if (site && p[3] === "browse" && /^[A-Za-z0-9]+-\d+$/.test(p[4] ?? "")) {
      const key = p[4];
      return {
        provider: "atlassian",
        kind: "issue",
        external_key: `jira:${site}#${key}`,
        canonical_url: `https://${site}.atlassian.net/browse/${key}`,
      };
    }
    if (
      site &&
      p[3] === "wiki" &&
      p[4] === "spaces" &&
      p[5] &&
      p[6] === "pages" &&
      /^\d+$/.test(p[7] ?? "")
    ) {
      const id = String(Number(p[7]));
      return {
        provider: "atlassian",
        kind: "document",
        external_key: `confluence:${site}#${id}`,
        canonical_url: `https://${site}.atlassian.net/wiki/spaces/${p[5]}/pages/${id}`,
      };
    }
  }
  if (
    https &&
    host === "bitbucket.org" &&
    p.length === 7 &&
    p[5] === "pull-requests" &&
    /^\d+$/.test(p[6] ?? "")
  ) {
    const workspace = p[3].toLowerCase();
    const repo = p[4].toLowerCase();
    const id = String(BigInt(p[6]));
    if (workspace && repo)
      return {
        provider: "atlassian",
        kind: "pull_request",
        external_key: `bitbucket:${workspace}/${repo}#${id}`,
        canonical_url: `https://bitbucket.org/${workspace}/${repo}/pull-requests/${id}`,
      };
  }
  if (https && host === "dev.azure.com" && p[3] && p[4]) {
    const org = p[3].toLowerCase();
    const project = p[4].toLowerCase();
    if (p[5] === "_workitems" && p[6] === "edit" && /^\d+$/.test(p[7] ?? "")) {
      const id = String(BigInt(p[7]));
      return {
        provider: "azure_dev_ops",
        kind: "issue",
        external_key: `ado:${org}/${project}#${id}`,
        canonical_url: `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`,
      };
    }
    if (p[5] === "_git" && p[6] && p[7] === "pullrequest" && /^\d+$/.test(p[8] ?? "")) {
      const repo = p[6].toLowerCase();
      const id = String(BigInt(p[8]));
      return {
        provider: "azure_dev_ops",
        kind: "pull_request",
        external_key: `ado:${org}/${project}#${id}`,
        canonical_url: `https://dev.azure.com/${org}/${project}/_git/${repo}/pullrequest/${id}`,
      };
    }
  }
  return { provider: "generic", kind: "generic", external_key: raw, canonical_url: raw };
}

export async function classifyLocalMarkdown(
  repositoryId: number,
  repositoryRoot: string,
  rawPath: string,
): Promise<ExternalObjectInput | null> {
  try {
    const root = await realpath(repositoryRoot);
    let filename = rawPath.startsWith("file://")
      ? fileURLToPath(rawPath)
      : decodeURIComponent(rawPath);
    if (!path.isAbsolute(filename)) filename = path.join(root, filename);
    filename = await realpath(filename);
    const relative = path.relative(root, filename);
    if (
      relative.startsWith("../") ||
      relative === ".." ||
      path.isAbsolute(relative) ||
      !/\.(md|markdown)$/i.test(relative)
    )
      return null;
    const encoded = filename
      .split(path.sep)
      .map((part) => encodeURIComponent(part))
      .join("/")
      .replaceAll("%3A", ":");
    return {
      provider: "generic",
      kind: "generic",
      external_key: `local:${repositoryId}#${relative.split(path.sep).join("/")}`,
      canonical_url: `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`,
    };
  } catch {
    return null;
  }
}

export function unwrapData(value: unknown): unknown {
  return value && typeof value === "object" && "data" in value
    ? (value as { data: unknown }).data
    : value;
}
export function findValue(value: unknown, keys: string[]): unknown {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of keys) if (key in record) return record[key];
    for (const nested of Object.values(record)) {
      const found = findValue(nested, keys);
      if (found !== undefined) return found;
    }
  } else if (Array.isArray(value))
    for (const nested of value) {
      const found = findValue(nested, keys);
      if (found !== undefined) return found;
    }
  return undefined;
}
function valueString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    for (const key of ["name", "value", "displayName"]) {
      const candidate = valueString((value as Record<string, unknown>)[key]);
      if (candidate !== undefined) return candidate;
    }
  }
  return undefined;
}
function nestedOrString(value: unknown, names: readonly string[]): string | undefined {
  for (const name of names) {
    const selected = name
      .split(".")
      .reduce<unknown>(
        (current, part) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[part]
            : undefined,
        value,
      );
    const direct = valueString(selected);
    if (direct !== undefined) return direct;
    if (selected && typeof selected === "object") {
      const nested = selected as Record<string, unknown>;
      for (const key of ["displayName", "name", "uniqueName"]) {
        const candidate = valueString(nested[key]);
        if (candidate !== undefined) return candidate;
      }
    }
  }
  return undefined;
}
const renderValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.storage === "string") return record.storage;
    if (record.storage && typeof record.storage === "object") {
      const storageValue = (record.storage as Record<string, unknown>).value;
      if (typeof storageValue === "string") return storageValue;
    }
    const collect = (node: unknown): string => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return "";
      const current = node as Record<string, unknown>;
      let text = typeof current.text === "string" ? current.text : "";
      if (Array.isArray(current.content)) {
        text += current.content.map(collect).join("");
        if (["paragraph", "heading", "listItem"].includes(String(current.type))) text += "\n";
      }
      return text;
    };
    const collected = collect(record).trim();
    if (collected) return collected;
  }
  return value == null ? "" : JSON.stringify(value);
};
function run(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      }),
    );
  });
}
async function resolveExecutable(
  configured: string | null | undefined,
  name: "gh" | "twg" | "az",
): Promise<string> {
  if (configured?.trim()) {
    const candidate = configured.trim();
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try PATH */
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate, 1);
      return candidate;
    } catch {
      /* continue */
    }
  }
  if (name === "gh")
    throw new Error(
      "GitHub CLI (`gh`) could not be found at the Context path or on PATH. Set its executable path in Settings → Contexts → Providers, or install GitHub CLI.",
    );
  if (name === "twg")
    throw new Error(
      "Teamwork Graph CLI (`twg`) could not be found at the Context path or on PATH. Set its executable path in Settings → Contexts → Providers, or install TWG CLI.",
    );
  throw new Error(
    "Azure CLI (`az`) could not be found at the Context path or on PATH. Set its executable path in Settings → Contexts → Providers, or install Azure CLI with the `azure-devops` extension.",
  );
}
function parseJson(output: string, provider: "GitHub" | "TWG" | "Azure DevOps"): unknown {
  if (!output.trim()) return null;
  try {
    return JSON.parse(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (provider === "TWG")
      throw new Error(`Atlassian TWG CLI failed: TWG returned invalid JSON: ${message}`);
    if (provider === "Azure DevOps")
      throw new Error(
        `Azure DevOps CLI (az) failed: Azure DevOps CLI returned invalid JSON: ${message}`,
      );
    throw new Error(`GitHub returned invalid JSON: ${message}`);
  }
}
function assertResult(
  result: { stdout: string; stderr: string; code: number },
  provider: ExternalObject["provider"],
): string {
  if (!result.code) return result.stdout;
  const detail = result.stderr.trim() || "the command returned a non-zero exit status";
  if (provider === "github") throw new Error(`GitHub CLI failed: ${detail}`);
  if (provider === "atlassian") throw new Error(`Atlassian TWG CLI failed: ${detail}`);
  const ext = /extension|command not found|not a valid command|not recognized/i.test(detail)
    ? `Azure DevOps CLI extension \`azure-devops\` is unavailable. install it with \`az extension add --name azure-devops\`. ${detail}`
    : detail;
  throw new Error(`Azure DevOps CLI (az) failed: ${ext}`);
}

export class ProviderDispatch {
  constructor(private readonly config: ProviderConfig = {}) {}
  private async invoke(
    provider: ExternalObject["provider"],
    args: string[],
    outputFlags: string[],
  ): Promise<unknown> {
    const name = provider === "github" ? "gh" : provider === "atlassian" ? "twg" : "az";
    const executable = await resolveExecutable(
      provider === "github"
        ? this.config.ghPath
        : provider === "atlassian"
          ? this.config.twgPath
          : this.config.azPath,
      name,
    );
    let flags: string[];
    if (provider === "github") flags = outputFlags;
    else if (provider === "atlassian")
      flags = [
        ...(this.config.atlassianSite?.trim() ? ["--site", this.config.atlassianSite.trim()] : []),
        ...(this.config.bitbucketWorkspace?.trim()
          ? ["--workspace", this.config.bitbucketWorkspace.trim()]
          : []),
        "--output",
        "json",
      ];
    else {
      const organization = this.config.azureDevOpsOrganization?.trim().replace(/\/$/, "");
      if (!organization)
        throw new Error(
          "Azure DevOps CLI (`az`) failed: an Azure DevOps organization is not configured for this Context",
        );
      flags = [
        "--organization",
        organization.startsWith("https://")
          ? organization
          : `https://dev.azure.com/${organization}`,
        "-o",
        "json",
      ];
    }
    if (
      provider === "atlassian" &&
      ["jira", "confluence"].includes(args[0]) &&
      !this.config.atlassianSite?.trim()
    )
      throw new Error(
        "Atlassian TWG CLI failed: an Atlassian site is not configured for this Context",
      );
    const result = await run(executable, [...args, ...flags]);
    return parseJson(
      assertResult(result, provider),
      provider === "github" ? "GitHub" : provider === "atlassian" ? "TWG" : "Azure DevOps",
    );
  }
  async fetchSnapshot(
    object: ExternalObjectInput,
    fetchedAt: number,
  ): Promise<ExternalSnapshotData> {
    let value: unknown;
    if (object.provider === "github")
      value = await this.invoke(
        "github",
        [
          object.kind === "pull_request" ? "pr" : "issue",
          "view",
          object.canonical_url,
          "--json",
          "number,title,state,author,labels,milestone,createdAt,updatedAt",
        ],
        [],
      );
    else if (object.provider === "atlassian") {
      const args = object.external_key.startsWith("jira:")
        ? ["jira", "workitem", "get", object.external_key.split("#")[1]]
        : object.external_key.startsWith("confluence:")
          ? ["confluence", "content", "get", object.external_key.split("#")[1], "--detail", "full"]
          : ["bitbucket", "pull-requests", "get", object.canonical_url];
      value = await this.invoke("atlassian", args, []);
    } else if (object.provider === "azure_dev_ops") {
      const id = object.external_key.split("#")[1];
      value =
        object.kind === "issue"
          ? await this.invoke(
              "azure_dev_ops",
              [
                "boards",
                "work-item",
                "show",
                "--id",
                id,
                "--fields",
                "System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.CreatedDate,System.ChangedDate,System.Tags,System.Description",
              ],
              [],
            )
          : await this.invoke("azure_dev_ops", ["repos", "pr", "show", "--id", id], []);
    } else throw new Error("snapshot fetching is not implemented for the Generic provider yet");
    const data = unwrapData(value) as Record<string, unknown>;
    const title = valueString(findValue(data, ["title", "summary", "name", "System.Title"])) ?? "";
    if (!title)
      throw new Error(
        `${object.provider === "github" ? "GitHub" : object.provider === "atlassian" ? "TWG" : "Azure DevOps"} returned an object without a title`,
      );
    const version =
      valueString(findValue(data, ["version"])) ?? valueString(findValue(data, ["number"]));
    const isConfluence = object.external_key.startsWith("confluence:");
    const state = isConfluence
      ? (version ?? "")
      : (valueString(findValue(data, ["state", "status", "System.State"])) ?? "");
    const metadata: ExternalMetadata[] = [];
    if (object.provider === "github") {
      const number = data.number;
      if (number !== undefined && number !== null)
        metadata.push({ key: "number", value: String(number) });
      const author = findValue(data.author, ["login"]);
      if (author != null) metadata.push({ key: "author", value: renderValue(author) });
      const labels = data.labels;
      if (Array.isArray(labels) && labels.length)
        metadata.push({
          key: "labels",
          value: labels
            .map((label) => valueString(findValue(label, ["name"])) ?? "")
            .filter(Boolean)
            .join(", "),
        });
      const milestone = findValue(data.milestone, ["title"]);
      if (milestone != null) metadata.push({ key: "milestone", value: renderValue(milestone) });
      if (data.createdAt != null) metadata.push({ key: "created", value: String(data.createdAt) });
      if (data.updatedAt != null) metadata.push({ key: "updated", value: String(data.updatedAt) });
    } else if (object.provider === "atlassian" && isConfluence) {
      if (version) metadata.push({ key: "version", value: version });
    } else if (object.provider === "azure_dev_ops") {
      const identity = object.external_key.match(/^ado:([^/]+)\/([^#]+)#(\d+)$/);
      if (!identity)
        throw new Error("Azure DevOps CLI (az) failed: invalid Azure DevOps object identifier");
      const [, organization, project, id] = identity;
      metadata.push({ key: "id", value: id });
      const properties =
        object.kind === "issue"
          ? ([
              ["type", ["System.WorkItemType", "type"]],
              ["assignee", ["System.AssignedTo", "assignedTo"]],
              ["created", ["System.CreatedDate", "createdDate"]],
              ["updated", ["System.ChangedDate", "changedDate"]],
              ["tags", ["System.Tags", "tags"]],
            ] as const)
          : ([
              ["author", ["createdBy", "author"]],
              ["repository", ["repository", "repository.name"]],
              ["created", ["creationDate", "createdDate"]],
              ["updated", ["closedDate", "closed_date"]],
            ] as const);
      for (const [key, names] of properties) {
        const entry = findValue(data, [...names]);
        const rendered =
          object.kind === "pull_request"
            ? nestedOrString(data, names)
            : entry == null
              ? undefined
              : renderValue(entry);
        if (rendered !== undefined) metadata.push({ key, value: rendered });
      }
      metadata.push(
        { key: "project", value: project },
        { key: "organization", value: organization },
      );
    } else {
      for (const [key, names] of [
        ["key", ["key"]],
        ["issueKey", ["issueKey"]],
        ["number", ["number"]],
        ["id", ["id"]],
        ["author", ["author"]],
        ["assignee", ["assignee"]],
        ["priority", ["priority"]],
        ["type", ["type"]],
        ["created", ["created"]],
        ["updated", ["updated"]],
        ["url", ["url"]],
      ] as const) {
        const entry = findValue(data, [...names]);
        if (entry != null) metadata.push({ key, value: valueString(entry) ?? renderValue(entry) });
      }
    }
    return { title, state, metadata, fetched_at: fetchedAt };
  }
  async fetchDocument(object: ExternalObjectInput): Promise<ExternalDocument> {
    if (object.provider === "github") {
      if (object.kind !== "issue" && object.kind !== "pull_request")
        throw new Error("only GitHub Issues have a readable issue document");
      const value = await this.invoke(
        "github",
        [
          object.kind === "pull_request" ? "pr" : "issue",
          "view",
          object.canonical_url,
          "--json",
          "body",
        ],
        [],
      );
      return {
        body: valueString(findValue(unwrapData(value), ["body"])) ?? "",
        bodyFormat: "markdown",
      };
    }
    if (object.provider === "atlassian") {
      if (object.external_key.startsWith("jira:")) {
        const value = await this.invoke(
          "atlassian",
          ["jira", "workitem", "get", object.external_key.split("#")[1]],
          [],
        );
        return {
          body: renderValue(findValue(unwrapData(value), ["description", "body"])),
          bodyFormat: "markdown",
        };
      }
      if (object.external_key.startsWith("confluence:")) {
        const value = await this.invoke(
          "atlassian",
          ["confluence", "content", "get", object.external_key.split("#")[1], "--detail", "full"],
          [],
        );
        return {
          body: renderValue(findValue(unwrapData(value), ["body", "bodyHtml", "html"])),
          bodyFormat: "html",
        };
      }
    }
    if (object.provider === "azure_dev_ops" && object.kind === "issue") {
      const id = object.external_key.split("#")[1];
      const value = await this.invoke(
        "azure_dev_ops",
        ["boards", "work-item", "show", "--id", id, "--fields", "System.Description"],
        [],
      );
      return {
        body: renderValue(findValue(unwrapData(value), ["System.Description", "description"])),
        bodyFormat: "html",
      };
    }
    const provider =
      object.provider === "generic"
        ? "Generic"
        : object.provider === "azure_dev_ops"
          ? "AzureDevOps"
          : object.provider;
    throw new Error(`document reading is not implemented for the ${provider} provider yet`);
  }
  async fetchIssueDocument(object: ExternalObjectInput): Promise<IssueDocument> {
    const document = await this.fetchDocument(object);
    let subIssues: SubIssue[] = [];
    if (object.provider === "github" && object.kind === "issue") {
      subIssues = await this.listTickets(object);
    }
    return { ...document, subIssues };
  }
  async listTickets(object: ExternalObjectInput): Promise<SubIssue[]> {
    if (object.provider !== "github" || object.kind !== "issue")
      throw new Error("only GitHub Issues have readable sub-issues");
    const match = object.external_key.match(/^issue:([^/]+)\/(.+)#(\d+)$/);
    if (!match) throw new Error("only GitHub Issues have readable sub-issues");
    const executable = await resolveExecutable(this.config.ghPath, "gh");
    const result = await run(executable, [
      "api",
      `repos/${match[1]}/${match[2]}/issues/${match[3]}/sub_issues`,
      "--paginate",
      "--jq",
      ".[] | {number, title, state, html_url}",
    ]);
    const output = assertResult(result, "github");
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        return {
          number: Number(entry.number),
          title: String(entry.title ?? ""),
          state: String(entry.state ?? ""),
          url: String(entry.html_url ?? ""),
        };
      });
  }
  async fetchComments(object: ExternalObjectInput): Promise<ExternalComment[]> {
    if (object.provider === "github") {
      const m = object.external_key.match(/^(?:issue|pull):([^/]+)\/(.+)#(\d+)$/);
      if (!m) return [];
      const raw = await this.invoke(
        "github",
        ["api", `repos/${m[1]}/${m[2]}/issues/${m[3]}/comments`, "--paginate", "--slurp"],
        [],
      );
      const pages = Array.isArray(raw)
        ? raw.flatMap((page) => (Array.isArray(page) ? page : []))
        : [];
      return pages.map((entry, index) => {
        const c = entry as Record<string, unknown>;
        return {
          id: Number(c.id ?? index),
          author: valueString(findValue(c.user, ["login"])) ?? "Unknown",
          body: valueString(c.body) ?? "",
          createdAt: valueString(c.created_at) ?? "",
        };
      });
    }
    if (object.provider === "atlassian") {
      const args = object.external_key.startsWith("jira:")
        ? ["jira", "workitem", "comment", "query", object.external_key.split("#")[1]]
        : object.external_key.startsWith("confluence:")
          ? ["confluence", "content", "comments", "list", object.external_key.split("#")[1]]
          : ["bitbucket", "pull-requests", "comment", "query", object.canonical_url];
      const raw = await this.invoke("atlassian", args, []);
      const data = unwrapData(raw) as { comments?: unknown[] } | unknown[];
      const entries = Array.isArray(data)
        ? data
        : Array.isArray(data?.comments)
          ? data.comments
          : [];
      return entries.map((entry, index) => {
        const c = entry as Record<string, unknown>;
        return {
          id: Number(valueString(c.id) ?? index),
          author:
            valueString(findValue(c, ["author", "displayName", "name", "login"])) ?? "Unknown",
          body: renderValue(findValue(c, ["body", "text"])),
          createdAt: renderValue(findValue(c, ["created", "createdAt", "created_at"])),
        };
      });
    }
    if (object.provider === "azure_dev_ops") {
      const identity = object.external_key.match(/^ado:([^/]+)\/([^#]+)#(\d+)$/);
      if (!identity)
        throw new Error("Azure DevOps CLI (az) failed: invalid Azure DevOps object identifier");
      const [, , project, id] = identity;
      if (object.kind === "pull_request") {
        const pull = await this.invoke("azure_dev_ops", ["repos", "pr", "show", "--id", id], []);
        const repositoryId = valueString(findValue(pull, ["id"]));
        if (!repositoryId)
          throw new Error(
            "Azure DevOps CLI (az) failed: Azure DevOps did not return a repository id for this pull request",
          );
        const data = await this.invoke(
          "azure_dev_ops",
          [
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "repositories/{repositoryId}/pullRequests/{pullRequestId}/threads",
            "--route-parameters",
            `project=${project}`,
            `repositoryId=${repositoryId}`,
            `pullRequestId=${id}`,
            "--api-version",
            "7.1",
            "--http-method",
            "GET",
          ],
          [],
        );
        const root = unwrapData(data) as Record<string, unknown>;
        const threads = Array.isArray(root)
          ? root
          : Array.isArray(root.value)
            ? root.value
            : Array.isArray(root.threads)
              ? root.threads
              : [];
        return threads.flatMap((thread) => {
          const record = thread as Record<string, unknown>;
          if (record.isDeleted === true || !Array.isArray(record.comments)) return [];
          return record.comments
            .filter((entry) => {
              const comment = entry as Record<string, unknown>;
              if (comment.isDeleted === true) return false;
              const kind = valueString(comment.commentType)?.toLowerCase();
              return kind !== "system" && kind !== "codechange";
            })
            .map((entry) => {
              const comment = entry as Record<string, unknown>;
              return {
                id: Number(valueString(comment.id) ?? 0),
                author:
                  valueString(
                    findValue(comment, ["author", "displayName", "name", "uniqueName"]),
                  ) ?? "Unknown",
                body: renderValue(findValue(comment, ["content"])),
                createdAt: renderValue(findValue(comment, ["publishedDate", "createdDate"])),
              };
            });
        });
      }
      if (object.kind !== "issue")
        throw new Error(
          "Azure DevOps CLI (az) failed: comments are available only for Azure DevOps work items and pull requests",
        );
      const data = await this.invoke(
        "azure_dev_ops",
        [
          "devops",
          "invoke",
          "--area",
          "wit",
          "--resource",
          "workItems/{workItemId}/comments",
          "--route-parameters",
          `project=${project}`,
          `workItemId=${id}`,
          "--api-version",
          "7.1-preview.4",
          "--http-method",
          "GET",
        ],
        [],
      );
      const root = unwrapData(data) as Record<string, unknown>;
      const entries = Array.isArray(root)
        ? root
        : Array.isArray(root.comments)
          ? root.comments
          : [];
      return entries.map((entry, index) => {
        const comment = entry as Record<string, unknown>;
        return {
          id: Number(valueString(comment.commentId ?? comment.id) ?? index),
          author:
            valueString(
              findValue(comment, ["createdBy", "author", "displayName", "name", "uniqueName"]),
            ) ?? "Unknown",
          body: renderValue(findValue(comment, ["text", "body"])),
          createdAt: renderValue(findValue(comment, ["createdDate", "createdAt"])),
        };
      });
    }
    const provider =
      object.provider === "generic"
        ? "Generic"
        : object.provider === "azure_dev_ops"
          ? "AzureDevOps"
          : object.provider;
    throw new Error(`comment reading is not implemented for the ${provider} provider yet`);
  }
  async createIssue(repository: string, title: string, body: string): Promise<string> {
    if (!repository.trim())
      throw new Error("GitHub CLI failed: a GitHub repository is required to create an Issue");
    if (!title.trim()) throw new Error("GitHub CLI failed: a GitHub Issue title cannot be blank");
    const value = await this.invoke(
      "github",
      [
        "api",
        `repos/${repository}/issues`,
        "--method",
        "POST",
        "--raw-field",
        `title=${title}`,
        "--raw-field",
        `body=${body}`,
      ],
      [],
    );
    const url = valueString(findValue(value, ["html_url"]));
    if (!url) throw new Error("GitHub CLI returned an issue without a URL");
    const object = classifyUrl(url);
    if (object.provider !== "github" || object.kind !== "issue")
      throw new Error("GitHub CLI failed: GitHub API returned a URL that is not a GitHub Issue");
    return object.canonical_url;
  }
  async addComment(object: ExternalObjectInput, body: string): Promise<void> {
    if (object.provider !== "github") {
      const providerName =
        object.provider === "azure_dev_ops"
          ? "AzureDevOps"
          : object.provider === "atlassian"
            ? "Atlassian"
            : "Generic";
      throw new Error(`comment writing is not implemented for the ${providerName} provider yet`);
    }
    if (!body.trim()) throw new Error("GitHub CLI failed: a GitHub comment cannot be blank");
    const executable = await resolveExecutable(this.config.ghPath, "gh");
    assertResult(
      await run(executable, ["issue", "comment", object.canonical_url, "--body", body]),
      "github",
    );
  }
}

export async function readMarkdownSnapshot(
  filename: string,
  fetchedAt: number,
): Promise<ExternalSnapshotData> {
  const markdown = await readFile(filename, "utf8");
  const title =
    markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() ||
    path.basename(filename, path.extname(filename)) ||
    "Local Markdown";
  const state =
    markdown
      .split(/\r?\n/)
      .slice(0, 12)
      .map((line) => line.trim())
      .map((line) => {
        const split = line.indexOf(":");
        return split < 0 ? null : [line.slice(0, split).trim(), line.slice(split + 1).trim()];
      })
      .find((entry) => entry?.[0].toLowerCase() === "status" && entry[1])?.[1] || "Open";
  return { title, state, metadata: [{ key: "status", value: state }], fetched_at: fetchedAt };
}
