import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, realpath, stat } from "node:fs/promises";
import type { DomainState } from "../domain/model";
import { itemViews } from "../domain/projections";
import type {
  ExternalLinkAction,
  ExternalLinkView,
  ExternalObject,
  ExternalSnapshot,
  SubIssue,
} from "../domain/types";
import type { Runtime } from "./runtime";
import { resolveMachinePath } from "./machine-path";
import {
  classifyLocalMarkdown,
  classifyUrl,
  ProviderDispatch,
  readMarkdownSnapshot,
  type ExternalObjectInput,
  type ProviderConfig,
} from "./provider";

const nowSeconds = () => Math.floor(Date.now() / 1000);
function objectInput(object: ExternalObject): ExternalObjectInput {
  return {
    provider: object.provider,
    kind: object.kind,
    external_key: object.external_key,
    canonical_url: object.canonical_url,
  };
}
function contextForObject(state: DomainState, objectId: number) {
  const link = state.links.find((entry) => entry.external_object_id === objectId);
  if (!link) throw new Error(`External Object ${objectId} has no Link`);
  const item = state.items.find((entry) => entry.id === link.item_id);
  if (!item) throw new Error(`Item ${link.item_id} does not exist`);
  const project = state.projects.find((entry) => entry.id === item.project_id);
  if (!project) throw new Error(`Project ${item.project_id} does not exist`);
  const context = state.contexts.find((entry) => entry.id === project.context_id);
  if (!context) throw new Error(`Context ${project.context_id} does not exist`);
  return { link, item, project, context };
}
function providerConfig(state: DomainState, contextId: number): ProviderConfig {
  const context = state.contexts.find((entry) => entry.id === contextId);
  if (!context) throw new Error(`Context ${contextId} does not exist`);
  return {
    ghPath: context.gh_executable_path,
    twgPath: context.twg_executable_path,
    azPath: context.az_executable_path,
    atlassianSite: context.atlassian_site,
    bitbucketWorkspace: context.bitbucket_workspace,
    azureDevOpsOrganization: context.azure_devops_organization,
  };
}
function linkView(state: DomainState, linkId: number): ExternalLinkView {
  const link = state.links.find((entry) => entry.id === linkId);
  if (!link) throw new Error(`Link ${linkId} does not exist`);
  const view = itemViews(state)
    .flatMap((item) => item.links)
    .find((entry) => entry.link.id === linkId);
  if (!view) throw new Error("Link did not produce an External Object view");
  return view;
}
export function githubRepositoryName(input: string): string | null {
  const remoteUrl = input.trim();
  let remotePath: string | null = null;
  const gitSsh = remoteUrl.startsWith("git@") ? remoteUrl.slice("git@".length) : null;
  if (gitSsh !== null) {
    const split = gitSsh.indexOf(":");
    if (split < 0 || gitSsh.slice(0, split).toLowerCase() !== "github.com") return null;
    remotePath = gitSsh.slice(split + 1);
  } else if (remoteUrl.startsWith("ssh://")) {
    const rest = remoteUrl.slice("ssh://".length);
    const split = rest.indexOf("/");
    if (split < 0 || rest.slice(0, split).toLowerCase() !== "git@github.com") return null;
    remotePath = rest.slice(split + 1);
  } else {
    const schemeEnd = remoteUrl.indexOf("://");
    if (schemeEnd < 0 || !["https", "http", "git"].includes(remoteUrl.slice(0, schemeEnd)))
      return null;
    const rest = remoteUrl.slice(schemeEnd + 3);
    const split = rest.indexOf("/");
    if (split < 0 || !["github.com", "www.github.com"].includes(rest.slice(0, split).toLowerCase()))
      return null;
    remotePath = rest.slice(split + 1);
  }
  if (remotePath === null) return null;
  const cleanPath = remotePath.replace(/\/+$/, "").replace(/\.git$/, "");
  const segments = cleanPath.split("/");
  const [rawOwner, rawRepository] = segments;
  const owner = rawOwner?.trim();
  const repository = rawRepository?.trim();
  const asciiAlphanumeric = /^[A-Za-z0-9]+$/;
  if (
    segments.length !== 2 ||
    !owner ||
    !repository ||
    owner.length > 39 ||
    !/^[A-Za-z0-9-]+$/.test(owner) ||
    !asciiAlphanumeric.test(owner[0]) ||
    !asciiAlphanumeric.test(owner.at(-1)!) ||
    repository.length > 100 ||
    !/^[A-Za-z0-9._-]+$/.test(repository) ||
    !asciiAlphanumeric.test(repository[0])
  )
    return null;
  return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}
function mismatchWarning(state: DomainState, contextId: number, url: string): string | null {
  const context = state.contexts.find((entry) => entry.id === contextId);
  if (!context) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  const site = context.atlassian_site
    ?.trim()
    .replace(/\.atlassian\.net$/i, "")
    .toLowerCase();
  const org = context.azure_devops_organization
    ?.trim()
    .replace(/\/$/, "")
    .split("/")
    .at(-1)
    ?.toLowerCase();
  const workspace = context.bitbucket_workspace?.trim().toLowerCase();
  const mismatch =
    (host.endsWith(".atlassian.net") && site && host.slice(0, -".atlassian.net".length) !== site) ||
    (host === "dev.azure.com" && org && pathParts[0]?.toLowerCase() !== org) ||
    (host === "bitbucket.org" && workspace && pathParts[0]?.toLowerCase() !== workspace);
  return mismatch
    ? `This External Object targets a different site or organization than the identifiers configured for Context '${context.name}'. The Link was created.`
    : null;
}
async function registeredLocalMarkdown(state: DomainState, itemId: number, url: string) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`Item ${itemId} does not exist`);
  const project = state.projects.find((entry) => entry.id === item.project_id);
  if (!project) throw new Error(`Project ${item.project_id} does not exist`);
  const context = state.contexts.find((entry) => entry.id === project.context_id);
  const machine =
    context?.execution_machine_id == null
      ? undefined
      : state.machines.find((entry) => entry.id === context.execution_machine_id);
  if (machine?.transport.kind !== "local") return null;
  for (const repository of state.repositories.filter((entry) => entry.project_id === project.id)) {
    const location = state.repository_locations.find(
      (entry) => entry.repository_id === repository.id && entry.machine_id === machine.id,
    );
    if (!location) continue;
    const checkout = resolveMachinePath(location.checkout_path, process.env.HOME ?? "");
    const object = await classifyLocalMarkdown(repository.id, checkout, url);
    if (object)
      return {
        object,
        filename: fileURLToPath(object.canonical_url),
        context,
        repository,
        location,
      };
  }
  return null;
}
async function localMarkdownPath(
  state: DomainState,
  objectId: number,
): Promise<{ filename: string; root: string }> {
  const object = state.external_objects.find((entry) => entry.id === objectId);
  if (!object) throw new Error(`External Object ${objectId} does not exist`);
  const { context, project } = contextForObject(state, objectId);
  const identity = object.external_key.match(/^local:(\d+)#(.+)$/);
  if (!identity) throw new Error("This local Markdown link has an invalid repository path");
  const machine = state.machines.find((entry) => entry.id === context.execution_machine_id);
  if (machine?.transport.kind !== "local")
    throw new Error(
      `Local Markdown tracker in Context '${context.name}' requires a local execution Machine because files are read from the Repository's main checkout`,
    );
  const repositoryId = Number(identity[1]);
  const repository = state.repositories.find(
    (entry) =>
      entry.id === repositoryId &&
      state.projects.some(
        (candidate) =>
          candidate.id === entry.project_id && candidate.context_id === project.context_id,
      ),
  );
  if (!repository) throw new Error("The Repository for this local Markdown link is unavailable");
  const location = state.repository_locations.find(
    (entry) => entry.repository_id === repositoryId && entry.machine_id === machine.id,
  );
  if (!location)
    throw new Error(
      `Repository '${repository.name}' has no main checkout registered on local Machine '${machine.name}'`,
    );
  const relative = identity[2];
  const segments = relative.split(/[\\/]/);
  if (
    path.isAbsolute(relative) ||
    segments.some((segment) => segment === "..") ||
    !/\.(md|markdown)$/i.test(relative)
  )
    throw new Error("This local Markdown link has an invalid repository path");
  const checkout = resolveMachinePath(location.checkout_path, process.env.HOME ?? "");
  let root: string;
  try {
    root = await realpath(checkout);
  } catch (error) {
    throw new Error(
      `Could not read Repository '${repository.name}' main checkout at ${location.checkout_path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let filename: string;
  try {
    filename = await realpath(path.join(root, relative));
  } catch (error) {
    throw new Error(
      `Local Markdown file '${relative}' is missing or unreadable in Repository '${repository.name}' main checkout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const relativeToRoot = path.relative(root, filename);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot) ||
    !(await stat(filename)).isFile()
  )
    throw new Error("The local Markdown file is outside its registered Repository checkout");
  return { filename, root };
}
async function localDocument(
  filename: string,
  externalKey: string,
  repositoryRoot: string,
): Promise<{ body: string; bodyFormat: "markdown"; subIssues: SubIssue[] }> {
  const markdown = await readFile(filename, "utf8");
  const body = markdown.split(/^## Comments\s*$/im, 1)[0].trim();
  let subIssues: SubIssue[] = [];
  if (path.basename(filename) === "spec.md") {
    const identity = externalKey.match(/^local:(\d+)#(.+)$/);
    if (!identity) throw new Error("The local Markdown Spec has an invalid repository path");
    const issueDirectory = path.join(path.dirname(filename), "issues");
    try {
      const { readdir } = await import("node:fs/promises");
      let resolvedIssueDirectory: string;
      try {
        resolvedIssueDirectory = await realpath(issueDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { body, bodyFormat: "markdown", subIssues: [] };
        throw error;
      }
      const directoryRelativeToRoot = path.relative(repositoryRoot, resolvedIssueDirectory);
      if (
        directoryRelativeToRoot === ".." ||
        directoryRelativeToRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(directoryRelativeToRoot) ||
        !(await stat(resolvedIssueDirectory)).isDirectory()
      )
        throw new Error(
          "The local Markdown ticket directory is outside its registered Repository checkout",
        );
      const tickets = (await readdir(resolvedIssueDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      subIssues = await Promise.all(
        tickets.map(async (name) => {
          const ticketPath = path.join(resolvedIssueDirectory, name);
          const resolvedTicketPath = await realpath(ticketPath);
          const ticketRelativeToRoot = path.relative(repositoryRoot, resolvedTicketPath);
          if (
            ticketRelativeToRoot === ".." ||
            ticketRelativeToRoot.startsWith(`..${path.sep}`) ||
            path.isAbsolute(ticketRelativeToRoot) ||
            !(await stat(resolvedTicketPath)).isFile()
          )
            throw new Error(
              "The local Markdown ticket is outside its registered Repository checkout",
            );
          const content = await readFile(resolvedTicketPath, "utf8");
          const relative = path.posix.join(path.posix.dirname(identity[2]), "issues", name);
          return {
            number: Number(name.split("-", 1)[0]) || 0,
            title:
              content.match(/^#\s+(.+)$/m)?.[1].trim() || path.basename(name, path.extname(name)),
            state:
              content
                .slice(0, 2000)
                .match(/^status:\s*(.+)$/im)?.[1]
                .trim() || "Open",
            url: `local:${identity[1]}#${relative}`,
          };
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          `Local Markdown ticket directory '${issueDirectory}' could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }
  return { body, bodyFormat: "markdown", subIssues };
}
export function createExternalCommandHandlers(runtime: Runtime) {
  const linkExternalObject = async (args: Record<string, unknown>): Promise<ExternalLinkAction> => {
    const itemId = Number(args.itemId);
    const url = String(args.url ?? "").trim();
    if (!runtime.snapshot().items.some((item) => item.id === itemId))
      throw new Error(`Item ${itemId} does not exist`);
    const state = runtime.snapshot();
    const item = state.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    const project = state.projects.find((entry) => entry.id === item.project_id);
    if (!project) throw new Error(`Project ${item.project_id} does not exist`);
    const contextId = project.context_id;
    const local = await registeredLocalMarkdown(state, itemId, url);
    if (/^(file:|.*\.(md|markdown)(\?|#|$))/i.test(url) && !local) {
      const context = state.contexts.find((entry) => entry.id === contextId)!;
      throw new Error(
        `Local Markdown files must be inside a registered Repository main checkout in a Context with a local execution Machine; Context '${context.name}' does not provide that local file access`,
      );
    }
    const object = local?.object ?? classifyUrl(url);
    const knownObject = state.external_objects.find(
      (entry) => entry.provider === object.provider && entry.external_key === object.external_key,
    );
    const alreadyKnown = knownObject !== undefined;
    let warning: string | null = null;
    let snapshot = null;
    if (!alreadyKnown && local) snapshot = await readMarkdownSnapshot(local.filename, nowSeconds());
    else if (!alreadyKnown && object.provider !== "generic") {
      try {
        snapshot = await new ProviderDispatch(providerConfig(state, contextId)).fetchSnapshot(
          object,
          nowSeconds(),
        );
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error);
      }
    }
    const current = runtime.snapshot();
    const currentObject = current.external_objects.find(
      (entry) => entry.provider === object.provider && entry.external_key === object.external_key,
    );
    const itemIsCurrent = current.items.some((entry) => entry.id === itemId);
    const objectIsCurrent = knownObject
      ? currentObject !== undefined &&
        currentObject.id === knownObject.id &&
        currentObject.kind === knownObject.kind &&
        currentObject.canonical_url === knownObject.canonical_url
      : currentObject === undefined;
    if (!itemIsCurrent || !objectIsCurrent)
      throw new Error(
        "The Item or External Object changed while the link was being prepared; try again",
      );
    const result = runtime.dispatch({ type: "link_external_object", itemId, object, snapshot });
    const link = result.links.find(
      (entry) =>
        entry.item_id === itemId &&
        result.external_objects.find((candidate) => candidate.id === entry.external_object_id)
          ?.external_key === object.external_key,
    );
    if (!link) throw new Error("Link creation produced no Link");
    const mismatch = mismatchWarning(state, contextId, object.canonical_url);
    if (mismatch) warning = warning ? `${warning}; ${mismatch}` : mismatch;
    return { link: linkView(result, link.id), warning };
  };
  return {
    link_external_object: linkExternalObject,
    create_github_issue: async (args: Record<string, unknown>): Promise<ExternalLinkAction> => {
      const state = runtime.snapshot();
      const itemId = Number(args.itemId);
      const repositoryId = Number(args.repositoryId);
      const item = state.items.find((entry) => entry.id === itemId);
      if (!item) throw new Error(`Item ${itemId} does not exist`);
      const repository = state.repositories.find((entry) => entry.id === repositoryId);
      if (!repository) throw new Error(`Repository ${repositoryId} does not exist`);
      if (repository.project_id !== item.project_id)
        throw new Error(
          `Repository ${repositoryId} belongs to another Project than Item ${itemId}`,
        );
      const repositoryName = githubRepositoryName(repository.remote_url);
      if (!repositoryName)
        throw new Error("The selected Repository does not have a valid GitHub remote");
      const context = state.contexts.find(
        (entry) =>
          entry.id === state.projects.find((project) => project.id === item.project_id)!.context_id,
      )!;
      const url = await new ProviderDispatch(providerConfig(state, context.id)).createIssue(
        repositoryName,
        String(args.title ?? "").trim(),
        String(args.body ?? ""),
      );
      const current = runtime.snapshot();
      if (
        !current.items.some(
          (entry) => entry.id === itemId && entry.project_id === item.project_id,
        ) ||
        !current.repositories.some(
          (entry) => entry.id === repositoryId && entry.remote_url === repository.remote_url,
        )
      )
        throw new Error(`GitHub Issue was created at ${url}, but its Item or Repository changed`);
      const linked = await linkExternalObject({ itemId, url });
      return linked;
    },
    add_external_comment: async (args: Record<string, unknown>): Promise<ExternalLinkView> => {
      const state = runtime.snapshot();
      const link = state.links.find((entry) => entry.id === Number(args.linkId));
      if (!link) throw new Error(`Link ${args.linkId} does not exist`);
      const object = state.external_objects.find((entry) => entry.id === link.external_object_id)!;
      const { context } = contextForObject(state, object.id);
      const body = String(args.body ?? "").trim();
      if (!body) throw new Error("A GitHub comment cannot be blank");
      if (object.kind === "generic")
        throw new Error("Comments are only supported for provider Issues and pull requests");
      await new ProviderDispatch(providerConfig(state, context.id)).addComment(
        objectInput(object),
        body,
      );
      const current = runtime.snapshot();
      if (
        !current.links.some(
          (entry) => entry.id === link.id && entry.external_object_id === object.id,
        ) ||
        !current.external_objects.some((entry) => entry.id === object.id)
      )
        throw new Error(
          `The GitHub comment was added to ${object.canonical_url}, but its Link changed while the request was running`,
        );
      return linkView(current, link.id);
    },
    fetch_issue_document: async (args: Record<string, unknown>) => {
      const state = runtime.snapshot();
      const id = Number(args.externalObjectId);
      const object = state.external_objects.find((entry) => entry.id === id);
      if (!object) throw new Error(`External Object ${id} does not exist`);
      if (
        !object.external_key.startsWith("local:") &&
        object.kind !== "issue" &&
        object.kind !== "document"
      )
        throw new Error("Only Issues and documents can be read as a spec document");
      if (object.external_key.startsWith("local:")) {
        const local = await localMarkdownPath(state, id);
        return localDocument(local.filename, object.external_key, local.root);
      }
      const { context } = contextForObject(state, id);
      return new ProviderDispatch(providerConfig(state, context.id)).fetchIssueDocument(
        objectInput(object),
      );
    },
    fetch_external_comments: async (args: Record<string, unknown>) => {
      const state = runtime.snapshot();
      const id = Number(args.externalObjectId);
      const object = state.external_objects.find((entry) => entry.id === id);
      if (!object) throw new Error(`External Object ${id} does not exist`);
      if (object.external_key.startsWith("local:")) {
        const { filename } = await localMarkdownPath(state, id);
        const text = await readFile(filename, "utf8");
        const comments = text
          .split(/^## Comments\s*$/im)[1]
          ?.split(/^##\s+/m, 1)[0]
          .trim();
        return comments ? [{ id: 0, author: "Local Markdown", body: comments, createdAt: "" }] : [];
      }
      const { context } = contextForObject(state, id);
      return new ProviderDispatch(providerConfig(state, context.id)).fetchComments(
        objectInput(object),
      );
    },
    fetch_external_document: async (args: Record<string, unknown>) => {
      const state = runtime.snapshot();
      const id = Number(args.externalObjectId);
      const object = state.external_objects.find((entry) => entry.id === id);
      if (!object) throw new Error(`External Object ${id} does not exist`);
      if (object.external_key.startsWith("local:")) {
        const local = await localMarkdownPath(state, id);
        return (await localDocument(local.filename, object.external_key, local.root)).body;
      }
      const { context } = contextForObject(state, id);
      return (
        await new ProviderDispatch(providerConfig(state, context.id)).fetchDocument(
          objectInput(object),
        )
      ).body;
    },
    refresh_external_object: async (args: Record<string, unknown>): Promise<ExternalSnapshot> => {
      const state = runtime.snapshot();
      const id = Number(args.externalObjectId);
      const object = state.external_objects.find((entry) => entry.id === id);
      if (!object) throw new Error(`External Object ${id} does not exist`);
      const { context } = contextForObject(state, id);
      let snapshot;
      if (object.external_key.startsWith("local:")) {
        const { filename } = await localMarkdownPath(state, id);
        snapshot = await readMarkdownSnapshot(filename, nowSeconds());
      } else
        snapshot = await new ProviderDispatch(providerConfig(state, context.id)).fetchSnapshot(
          objectInput(object),
          nowSeconds(),
        );
      if (!runtime.snapshot().external_objects.some((entry) => entry.id === id))
        throw new Error(`External Object ${id} does not exist`);
      const result = runtime.dispatch({
        type: "refresh_external_object",
        externalObjectId: id,
        snapshot,
      });
      return result.snapshots.find((entry) => entry.external_object_id === id)!;
    },
  };
}
