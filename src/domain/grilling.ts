import type { DomainState } from "./model";
import type {
  GrillAnswer,
  GrillContinuationAction,
  GrillQuestion,
  GrillQuestionGroup,
  Run,
} from "./execution-types";
import type { GrillConfiguration, GrillLanguage, GrillAgentCatalog } from "./types";
import type { ExternalObjectInput, ExternalSnapshotData } from "./types";

export const GRILL_OUTPUT_CONTRACT =
  "Mission Manager output contract (it reads your questions from the terminal and shows them to the user as a form):\n- Start every question on its own line with `❓ **Q<n>** - **<title>**: <question>`. Number questions 1, 2, 3… within the round.\n- Put the recommendation on the line that starts with `➡️`. Do not add prose after the recommendation other than lettered options (`A) …`).\n- Separate questions with a line containing only `---`.\n- Print each round exactly once, at the end of your turn. If a sub-agent you are waiting on changes a question, print only the revised full round; Mission Manager shows only the last round printed in a turn.\n- Keep status notes (what you are checking, what you found) before the first `❓`, never between or after the questions.\n- The user answers every question of the round at once, with one numbered reply (`1. …`, `2. …`). An answer of `ok` accepts your recommendation.";

export type GrillOption = { key: string; label: string };
export type GrillConfigurationView = GrillConfiguration;
export type GrillPhase = Run["grill_phase"];
export type PlanPhase = Run["plan_phase"];
export type DownstreamIssueDiscovery = "structured-event" | "output-url";
export type DownstreamIssueCandidate = {
  url: string;
  discovery: DownstreamIssueDiscovery;
  ordinal: number | null;
  blockedBy: string[];
  runId: number | null;
  action: GrillContinuationAction | null;
};
export type ConfirmedDownstreamIssue = {
  object: ExternalObjectInput;
  snapshot: ExternalSnapshotData;
  discovery: DownstreamIssueDiscovery;
  ordinal: number | null;
  blockedBy: string[];
};
export type LinkProvenance = {
  run_id: number;
  action: GrillContinuationAction;
  discovery: DownstreamIssueDiscovery;
  ordinal: number | null;
  blocked_by: string[];
};

export function grillSkillSnapshot(source: string): string {
  return stripFrontmatter(source);
}
export function implementationSkillSnapshot(source: string): string {
  return stripFrontmatter(source);
}
export function stripFrontmatter(source: string): string {
  if (!source.startsWith("---\n")) return source;
  const end = source.indexOf("\n---\n", 4);
  return end < 0 ? source : source.slice(end + 5);
}

export function nextGrillAction(
  previous: GrillContinuationAction | null,
): GrillContinuationAction | null {
  return previous === null
    ? "to-spec"
    : previous === "to-spec"
      ? "to-tickets"
      : previous === "to-tickets"
        ? "implement"
        : null;
}

export function grillContinuationAvailable(
  phase: GrillPhase,
  previous: GrillContinuationAction | null,
  action: GrillContinuationAction,
): boolean {
  return (
    phase === "awaitingNextAction" ||
    (phase === "waitingForAnswers" && nextGrillAction(previous) === action)
  );
}

export function formatGrillResponse(answers: GrillAnswer[]): string {
  if (!answers.length || answers.some(({ answer }) => !answer.trim()))
    throw new Error("a Grill answer cannot be blank");
  const ordered = [...answers].sort((a, b) => a.questionNumber - b.questionNumber);
  if (
    ordered.some(
      (answer, index) => index > 0 && answer.questionNumber === ordered[index - 1]!.questionNumber,
    )
  )
    throw new Error("a Grill question cannot have more than one answer");
  return ordered
    .map(({ questionNumber, answer }) =>
      answer
        .trim()
        .split("\n")
        .map((line, index) =>
          index === 0 ? `${questionNumber}. ${line.trim()}` : `   ${line.trim()}`,
        )
        .join("\n"),
    )
    .join("\n");
}

export function parseGrillQuestionGroup(transcript: string): GrillQuestionGroup | null {
  const clean = stripTerminalEscapeSequences(transcript);
  let inFence = false;
  let draft: GrillQuestion | null = null;
  let section: "prompt" | "recommendation" | "options" | "closed" = "closed";
  let paragraphBreak = false;
  const questions: GrillQuestion[] = [];
  const finish = () => {
    if (!draft?.prompt) return;
    if (!draft.title) {
      const split = splitLeadingQuestion(draft.prompt);
      if (split) {
        draft.title = split[0];
        draft.prompt = split[1];
      }
    }
    questions.push(draft);
    draft = null;
  };
  for (const raw of clean.split(/\r?\n/)) {
    const trimmed = raw.trimStart();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let line = raw.trim();
    if (/^[•⏺●└]/u.test(line)) {
      line = line.slice(1).trimStart();
      if (draft) section = "closed";
    }
    if (line.startsWith("❓")) {
      finish();
      const parsed = parseQuestionHeader(line.slice(1), questions.length + 1);
      if (questions.length && parsed.number <= questions.at(-1)!.number) questions.length = 0;
      draft = {
        number: parsed.number,
        title: parsed.title,
        prompt: parsed.prompt,
        recommendation: null,
        options: [],
      };
      section = "prompt";
      paragraphBreak = false;
      continue;
    }
    if (!draft || section === "closed") continue;
    if (/^(?:-{3,}|—{3,}|–{3,}|─{3,}|_{3,}|\*{3,})$/.test(line) || line.startsWith("#")) {
      section = "closed";
      continue;
    }
    if (!line) {
      if (section === "prompt") paragraphBreak = true;
      else if (section === "recommendation") section = "options";
      continue;
    }
    const rec = line.startsWith("➡️") ? line.slice(2) : line.startsWith("➡") ? line.slice(1) : null;
    if (rec !== null) {
      const value = cleanMarkup(rec);
      if (value) {
        draft.recommendation = value;
        section = "recommendation";
      }
      continue;
    }
    const option = parseOption(line);
    if (option) {
      draft.options.push(option);
      section = "options";
      continue;
    }
    const value = cleanMarkup(line);
    if (section === "prompt") {
      draft.prompt += `${draft.prompt ? (paragraphBreak ? "\n\n" : startsList(line) ? "\n" : " ") : ""}${value}`;
      paragraphBreak = false;
    } else if (section === "recommendation" && draft.recommendation)
      draft.recommendation += ` ${value}`;
  }
  finish();
  return questions.length ? { round: 0, questions } : null;
}

export function parseGrillQuestionGroupSince(
  previous: string,
  transcript: string,
): GrillQuestionGroup | null {
  const oldText = stripTerminalEscapeSequences(previous),
    newText = stripTerminalEscapeSequences(transcript);
  return parseGrillQuestionGroup(
    newText.startsWith(oldText) ? newText.slice(oldText.length) : newText,
  );
}
export function grillTranscriptExtends(previous: string, transcript: string): boolean {
  return stripTerminalEscapeSequences(transcript).startsWith(
    stripTerminalEscapeSequences(previous),
  );
}

export function reconcileGrillQuestionGroup(
  run: Run,
  transcript: string,
): GrillQuestionGroup | null {
  const extendsPrevious = grillTranscriptExtends(run.transcript, transcript);
  const captured =
    run.grill_decisions.length === 0 && run.grill_response === null
      ? parseGrillQuestionGroup(transcript)
      : parseGrillQuestionGroupSince(run.transcript, transcript);
  const previous = run.grill_question_group;
  if (previous && !captured && (run.state === "working" || run.grill_response === null))
    return structuredClone(previous);
  if (previous && captured && run.grill_response === null) {
    const last = previous.questions.at(-1);
    const first = captured.questions[0];
    if (last && first && first.number > last.number)
      return { round: previous.round, questions: [...previous.questions, ...captured.questions] };
    if (
      previous.questions.length === captured.questions.length &&
      previous.questions.every((question, index) => {
        const next = captured.questions[index];
        return (
          next !== undefined &&
          question.number === next.number &&
          next.prompt.startsWith(question.prompt)
        );
      })
    )
      return structuredClone(previous);
  }
  if (previous && captured && run.grill_response !== null && !extendsPrevious) {
    const previousPrefix = previous.questions.every(
      (question, index) => JSON.stringify(question) === JSON.stringify(captured.questions[index]),
    );
    if (captured.questions.length >= previous.questions.length && previousPrefix) {
      const remaining = captured.questions.slice(previous.questions.length);
      return remaining.length
        ? { round: run.grill_decisions.length, questions: remaining }
        : structuredClone(previous);
    }
    if (
      captured.questions.every(
        (question, index) => JSON.stringify(question) === JSON.stringify(previous.questions[index]),
      )
    )
      return structuredClone(previous);
  }
  return captured ? { ...captured, round: run.grill_decisions.length } : null;
}

export function discoverDownstreamIssueCandidates(output: string): DownstreamIssueCandidate[] {
  const candidates: DownstreamIssueCandidate[] = [];
  let ordinal = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = stripTranscriptListMarker(raw.trim());
    const eventIndex = line.indexOf("AI_MISSION_MANAGER_EVENT ");
    const jsonText = (
      eventIndex >= 0 ? line.slice(eventIndex + "AI_MISSION_MANAGER_EVENT ".length) : line
    ).replace(/^`|`$/g, "");
    if (jsonText.startsWith("{")) {
      try {
        const event = JSON.parse(jsonText) as Record<string, unknown>;
        if (
          ["external.object.created", "github.issue.created"].includes(
            String(event.event ?? event.type ?? event.kind),
          ) &&
          typeof event.url === "string"
        ) {
          const provided = Number(event.ordinal);
          ordinal = Number.isInteger(provided) && provided > 0 ? provided : ordinal + 1;
          ordinal = Math.max(ordinal, provided || ordinal);
          candidates.push({
            url: event.url,
            discovery: "structured-event",
            ordinal,
            blockedBy: Array.isArray(event.blocked_by)
              ? event.blocked_by.filter((value): value is string => typeof value === "string")
              : [],
            runId: Number.isInteger(event.run_id) ? Number(event.run_id) : null,
            action: ["to-spec", "to-tickets", "implement"].includes(String(event.action))
              ? (event.action as GrillContinuationAction)
              : null,
          });
        }
      } catch {
        /* Ignore unrelated or malformed structured events. */
      }
    }
    for (const token of line.split(/\s+/)) {
      const url = token
        .replace(/^[([{<"'`]+|[)\]}>"'`,;!?]+$/g, "")
        .replace(/[.,;!?]+$/, "")
        .replace(/\/$/, "");
      if (isRecognizedCaptureReference(url)) {
        ordinal++;
        candidates.push({
          url,
          discovery: "output-url",
          ordinal,
          blockedBy: [],
          runId: null,
          action: null,
        });
      } else if (
        /^(?:file:\/\/|\.{0,2}\/|\/|\.scratch\/)/.test(url) &&
        /\.(?:md|markdown)$/i.test(url)
      ) {
        ordinal++;
        candidates.push({
          url,
          discovery: "output-url",
          ordinal,
          blockedBy: [],
          runId: null,
          action: null,
        });
      }
    }
  }
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex((other) => other.url.toLowerCase() === candidate.url.toLowerCase()) ===
      index,
  );
}

function stripTranscriptListMarker(line: string): string {
  const match = line.match(/^[•*+\-](\s+)/u);
  return match ? line.slice(match[0].length) : line;
}

function isRecognizedCaptureReference(reference: string): boolean {
  if (reference.startsWith("file://")) return /\.(?:md|markdown)$/i.test(reference);
  if (/^(?:\.{0,2}\/|\/|\.scratch\/)/.test(reference)) return /\.(?:md|markdown)$/i.test(reference);
  try {
    const parsed = new URL(reference);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      (host === "github.com" || host === "www.github.com") &&
      parts.length === 4 &&
      parts[0] &&
      parts[1] &&
      /^(?:issues|pull)$/.test(parts[2]!) &&
      /^\d+$/.test(parts[3]!)
    )
      return true;
    if (
      host.endsWith(".atlassian.net") &&
      parts[0] === "browse" &&
      /^[A-Za-z0-9]+-\d+$/.test(parts[1] ?? "")
    )
      return true;
    if (
      host.endsWith(".atlassian.net") &&
      parts[0] === "wiki" &&
      parts[1] === "spaces" &&
      parts[2] &&
      parts[3] === "pages" &&
      /^\d+$/.test(parts[4] ?? "")
    )
      return true;
    if (
      host === "bitbucket.org" &&
      parts.length === 4 &&
      parts[0] &&
      parts[1] &&
      parts[2] === "pull-requests" &&
      /^\d+$/.test(parts[3]!)
    )
      return true;
    if (
      host === "dev.azure.com" &&
      parts[0] &&
      parts[1] &&
      ((parts[2] === "_workitems" && parts[3] === "edit" && /^\d+$/.test(parts[4] ?? "")) ||
        (parts[2] === "_git" &&
          parts[3] &&
          parts[4] === "pullrequest" &&
          /^\d+$/.test(parts[5] ?? "")))
    )
      return true;
    return false;
  } catch {
    return false;
  }
}

export function downstreamIssueIsNew(
  createdValue: string | undefined,
  actionStartedAt: number | null | undefined,
): boolean {
  if (actionStartedAt == null) return true;
  if (!createdValue) return false;
  if (!createdValue.trim().endsWith("Z")) return false;
  const createdAt = Date.parse(createdValue);
  return Number.isFinite(createdAt) && createdAt / 1000 + 120 >= actionStartedAt;
}

function stripTerminalEscapeSequences(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}
function cleanMarkup(value: string): string {
  return value.replace(/\*\*/g, "").replace(/\*/g, "").trim();
}
function startsList(value: string): boolean {
  return /^(?:[-*•] |\d+\. )/.test(value);
}
function parseOption(line: string): GrillOption | null {
  const match = line.match(/^\(?([A-Z])\)?[.)\:-]\s*(.+)$/);
  return match ? { key: match[1]!, label: cleanMarkup(match[2]!) } : null;
}
function splitLeadingQuestion(value: string): [string, string] | null {
  const end = value.indexOf("?");
  if (end < 0 || end > 120) return null;
  const rest = value.slice(end + 1).trim();
  return rest ? [value.slice(0, end + 1).trim(), rest] : null;
}
function parseQuestionHeader(
  header: string,
  fallback: number,
): { number: number; title: string | null; prompt: string } {
  const cleaned = header
    .replace(/\*\*/g, "")
    .replace(/^[-—–:).\s]+/, "")
    .trim();
  const match = cleaned.match(/^(?:Q|Question)?\s*(\d+)\s*[-—–:).]?\s*(.*)$/i);
  const number = match ? Number(match[1]) : fallback;
  const rest = (match?.[2] ?? cleaned).trim();
  const colon = rest.indexOf(":");
  if (colon > 0) {
    const title = cleanMarkup(rest.slice(0, colon));
    const prompt = cleanMarkup(rest.slice(colon + 1));
    if (title && prompt && !title.includes("?") && title.length <= 80)
      return { number, title, prompt };
  }
  return { number, title: null, prompt: cleanMarkup(rest) };
}

export function composeGrillPrompt(
  state: DomainState,
  itemId: number,
  configuration: GrillConfiguration,
  language: GrillLanguage,
  initialPrompt: string,
  skill: string,
): string {
  if (!configuration.model.trim() || !configuration.effort.trim())
    throw new Error("Grill configuration is invalid");
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Item ${itemId} does not exist`);
  if (!initialPrompt.trim()) throw new Error("Run prompt cannot be empty");
  const context = [`Item objective:\n${item.title}`];
  for (const link of state.links.filter((entry) => entry.item_id === itemId)) {
    const object = state.external_objects.find((entry) => entry.id === link.external_object_id);
    if (!object) continue;
    const title =
      state.snapshots.find((entry) => entry.external_object_id === object.id)?.title ??
      "Linked external object";
    context.push(`Linked source:\n${title}\n${object.canonical_url}`);
  }
  const instruction = responseInstruction(language, true);
  return `You are starting a Grill Run.\n\n${instruction}\n\nGrill configuration: agent=${JSON.stringify(configuration.agent)}, model=${configuration.model}, effort=${configuration.effort}.\n\nGrilling skill snapshot:\n${stripFrontmatter(skill)}\n\n${GRILL_OUTPUT_CONTRACT}\n\nRelevant Item context:\n${context.join("\n\n")}\n\nUser's initial prompt:\n${initialPrompt.trim()}`;
}

export function composeGrillContinuationPrompt(
  state: DomainState,
  runId: number,
  action: GrillContinuationAction,
  skills: Record<GrillContinuationAction, string>,
): string {
  const run = state.runs.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Run ${runId} does not exist`);
  if (run.execution_profile !== "grill") throw new Error(`Run ${runId} is not a Grill Run`);
  const item = state.items.find((entry) => entry.id === run.item_id);
  if (!item) throw new Error(`Item ${run.item_id} does not exist`);
  const context = [`Item objective:\n${item.title}`];
  if (item.notes.trim()) context.push(`Item notes:\n${item.notes.trim()}`);
  for (const link of state.links.filter((entry) => entry.item_id === item.id)) {
    const object = state.external_objects.find((entry) => entry.id === link.external_object_id);
    if (object)
      context.push(
        `Linked source:\n${state.snapshots.find((entry) => entry.external_object_id === object.id)?.title ?? "Linked external object"}\n${object.canonical_url}`,
      );
  }
  const decisions = run.grill_decisions.length
    ? run.grill_decisions
        .map((entry) => `Q${entry.questionNumber}: ${entry.answer.trim().replace(/\n/g, "\n   ")}`)
        .join("\n")
    : run.grill_response?.trim() ||
      (run.grill_answers.length
        ? formatGrillResponse(run.grill_answers)
        : "No structured Grill decisions were recorded.");
  const sections = [
    responseInstruction(languageFromPrompt(run.prompt), false),
    "Continue the existing Grill Run in the same Run and Pane. The Grill conversation is already in your context; use it as the primary source.",
    `Selected downstream action: ${action}`,
    `Downstream skill snapshot (inject this content explicitly; do not rely on the agent having the skill installed):\n${stripFrontmatter(skills[action])}`,
    `Relevant Item context:\n${context.join("\n\n")}`,
    `Recorded Grill decisions:\n${decisions}`,
  ];
  if (run.grill_phase === "waitingForAnswers" && run.grill_question_group) {
    const open = run.grill_question_group.questions
      .map(
        (q) =>
          `Q${q.number}: ${q.title ? `${q.title} ` : ""}${q.prompt.replace(/\n/g, " ")}${q.recommendation ? ` (recommended: ${q.recommendation})` : ""}`,
      )
      .join("\n");
    if (open)
      sections.push(
        run.grill_action === null
          ? `The user stopped the Grill early, before answering these questions. Do not answer them yourself and do not ask them again: record each one in the spec as an open question, with your recommendation.\n${open}`
          : `The user moved on from ${run.grill_action} without answering its last questions. Do not ask them again: treat each one as settled by its recommendation.\n${open}`,
      );
  }
  if (action === "to-tickets") {
    const urls = state.links
      .filter(
        (link) =>
          link.item_id === run.item_id &&
          link.provenance?.run_id === run.id &&
          link.provenance.action === "to-spec",
      )
      .flatMap(
        (link) =>
          state.external_objects.find((obj) => obj.id === link.external_object_id)?.canonical_url ??
          [],
      );
    if (urls.length)
      sections.push(
        `Spec created earlier in this Run (the reference for to-tickets: fetch it and read its full body and comments, and use it as the tickets' parent):\n${urls.join("\n")}`,
      );
  }
  sections.push(
    "Issue tracker configuration: read the repository's AGENTS.md or CLAUDE.md and the files they point to (such as docs/agents/issue-tracker.md and docs/agents/triage-labels.md). Only ask the user to run /setup-matt-pocock-skills when none of them configure a tracker.",
  );
  sections.push(
    `Continuation instruction:\nApply the selected ${action} skill to the Item using the conversation and decisions above. Keep working in the same working directory. Ask any confirmation questions as one grouped frontier that follows the output contract below. Wait for an explicit user decision to finish or stop; never mark the Item Done automatically.`,
  );
  sections.push(GRILL_OUTPUT_CONTRACT);
  sections.push(
    `Mission Manager links the work objects you create to the Item. For to-tickets, set each ticket's native parent to the Spec when the tracker supports it; treat that relation write as best-effort, so a rejection must not stop creation. Mission Manager records the parent locally and never reads tracker relations back. Immediately after creating each object, print one JSON event on a line by itself. Use its canonical URL, or its local Markdown path for files under a registered checkout. Keep objects in publication order; use a 1-based ordinal for each ticket and list any tickets it is blocked by as their URLs or paths in blocked_by. Example: AI_MISSION_MANAGER_EVENT {"event":"external.object.created","url":"<canonical URL or local path>","ordinal":1,"blocked_by":[],"run_id":${run.id},"action":"${action}"}`,
  );
  return sections.join("\n\n");
}

export function composePlanGoPrompt(run: Run): string {
  if (
    run.workflow !== "pstack" ||
    run.execution_profile !== "plan" ||
    run.plan_phase !== "awaitingGo"
  )
    throw new Error(`Go is not available for Plan Run ${run.id}`);
  return `${responseInstruction(languageFromPrompt(run.prompt), false)}\n\nThe user approved continuing this Plan Run by selecting Go. Continue in this same Run, Pane, and working directory. Read and execute the plan at \`${run.plan_path ?? "the plan you just wrote"}\`. Implement its phases, perform the required verification, and report the resulting changes and checks. Do not rewrite the plan unless implementation reveals a concrete blocker.`;
}

export function responseInstruction(language: GrillLanguage, grill: boolean): string {
  const scope = grill
    ? " throughout this Grill Run, including every answer and continuation"
    : " throughout this Run";
  return language === "english"
    ? `GRILL_RESPONSE_LANGUAGE=english\nRespond to the user in English${scope}. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.`
    : grill
      ? "GRILL_RESPONSE_LANGUAGE=portuguese\nRespond to the user in Portuguese throughout this Grill Run, including every answer and continuation. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate."
      : "Respond to the user in Portuguese throughout this Run. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.";
}
function languageFromPrompt(prompt: string): GrillLanguage {
  return prompt.includes("GRILL_RESPONSE_LANGUAGE=english") ? "english" : "portuguese";
}

export function enforceGrillPrompt(language: GrillLanguage, prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith("GRILL_RESPONSE_LANGUAGE=") &&
        !line.startsWith("Respond to the user in Portuguese throughout this Grill Run,") &&
        !line.startsWith("Respond to the user in English throughout this Grill Run,"),
    );
  return `${lines.join("\n").trim()}\n\n${responseInstruction(language, true)}`;
}

export function grillLanguageFromPrompt(prompt: string): GrillLanguage {
  return languageFromPrompt(prompt);
}

const effort = (ids: [string, string][]) => ids.map(([id, label]) => ({ id, label }));
const claudeEfforts = effort([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
]);
const codexEfforts = effort([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
]);
export function grillModelCatalog(): GrillAgentCatalog[] {
  const claudeModels = [
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
    ["claude-opus-4-5-20251101", "Claude Opus 4.5"],
    ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["claude-sonnet-4-5", "Claude Sonnet 4.5 (legacy ID)"],
    ["claude-haiku-4-5", "Claude Haiku 4.5 (legacy ID)"],
  ] as const;
  return [
    {
      agent: "claude",
      models: claudeModels.map(([id, label]) => ({
        id,
        label,
        efforts: structuredClone(claudeEfforts),
      })),
    },
    {
      agent: "codex",
      models: [
        ["gpt-6-sol", "GPT-6 Sol"],
        ["gpt-6-luna", "GPT-6 Luna"],
      ].map(([id, label]) => ({ id, label, efforts: structuredClone(codexEfforts) })),
    },
  ];
}
export function validateGrillConfiguration(configuration: GrillConfiguration): void {
  if (
    configuration.model.trim() &&
    configuration.effort.trim() &&
    (configuration.agent === "codex" ||
      grillModelCatalog()[0]!.models.some((model) => model.id === configuration.model))
  )
    return;
  throw new Error("Invalid Grill configuration");
}
