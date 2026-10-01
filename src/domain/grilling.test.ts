import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DomainState } from "./model";
import { decide } from "./state-transition";
import {
  composePlanGoPrompt,
  discoverDownstreamIssueCandidates,
  downstreamIssueIsNew,
  formatGrillResponse,
  grillModelCatalog,
  grillContinuationAvailable,
  nextGrillAction,
  parseGrillQuestionGroup,
  parseGrillQuestionGroupSince,
  validateGrillConfiguration,
} from "./grilling";

function state(): DomainState {
  return JSON.parse(
    readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
  ) as DomainState;
}

describe("Grilling domain", () => {
  it("parses the marked question frontier and ignores fenced examples", () => {
    expect(
      parseGrillQuestionGroup(
        `\`\`\`md\n❓ **Q9** - **Example**: ignored?\n\`\`\`\nStatus: checking\n❓ **Q1** - **Storage**: Which format?\n➡️ **SQLite**\nA) SQLite\nB) JSON\n---\n❓ **Q2** - **Backup**: Keep snapshots?\n➡️ Yes`,
      ),
    ).toEqual({
      round: 0,
      questions: [
        {
          number: 1,
          title: "Storage",
          prompt: "Which format?",
          recommendation: "SQLite",
          options: [
            { key: "A", label: "SQLite" },
            { key: "B", label: "JSON" },
          ],
        },
        {
          number: 2,
          title: "Backup",
          prompt: "Keep snapshots?",
          recommendation: "Yes",
          options: [],
        },
      ],
    });
  });

  it("parses only new transcript text and formats answers in question order", () => {
    const previous = "old scrollback\n";
    expect(
      parseGrillQuestionGroupSince(previous, `${previous}❓ Q1: First?\n❓ Q2: Second?`),
    ).toMatchObject({ questions: [{ number: 1 }, { number: 2 }] });
    expect(
      formatGrillResponse([
        { questionNumber: 2, answer: "  second\n  detail " },
        { questionNumber: 1, answer: " first " },
      ]),
    ).toBe("1. first\n2. second\n   detail");
    expect(() =>
      formatGrillResponse([
        { questionNumber: 1, answer: "yes" },
        { questionNumber: 1, answer: "no" },
      ]),
    ).toThrow("more than one answer");
  });

  it("advances continuation actions in order and allows only the current frontier", () => {
    expect([
      nextGrillAction(null),
      nextGrillAction("to-spec"),
      nextGrillAction("to-tickets"),
      nextGrillAction("implement"),
    ]).toEqual(["to-spec", "to-tickets", "implement", null]);
    expect(grillContinuationAvailable("waitingForAnswers", null, "to-spec")).toBe(true);
    expect(grillContinuationAvailable("waitingForAnswers", null, "to-tickets")).toBe(false);
    expect(grillContinuationAvailable("awaitingNextAction", "to-spec", "implement")).toBe(true);
  });

  it("accepts provider-discovered Codex effort levels and exposes xhigh in the catalog", () => {
    expect(() =>
      validateGrillConfiguration({
        agent: "codex",
        model: "gpt-6-luna",
        effort: "future-cli-level",
      }),
    ).not.toThrow();
    expect(
      grillModelCatalog()
        .find((entry) => entry.agent === "codex")
        ?.models.find((model) => model.id === "gpt-6-luna")?.efforts,
    ).toContainEqual({ id: "xhigh", label: "Extra high" });
    expect(() =>
      validateGrillConfiguration({ agent: "codex", model: " ", effort: "high" }),
    ).toThrow("Invalid Grill configuration");
  });

  it("extracts structured creation events and output URL references with provenance", () => {
    expect(
      discoverDownstreamIssueCandidates(
        `AI_MISSION_MANAGER_EVENT {"event":"external.object.created","url":"https://github.com/acme/app/issues/8","ordinal":2,"blocked_by":["https://github.com/acme/app/issues/7"],"run_id":4,"action":"to-tickets"}`,
      ),
    ).toEqual([
      {
        url: "https://github.com/acme/app/issues/8",
        discovery: "structured-event",
        ordinal: 2,
        blockedBy: ["https://github.com/acme/app/issues/7"],
        runId: 4,
        action: "to-tickets",
      },
    ]);
  });

  it("accepts only issues created during the downstream action window", () => {
    expect(
      downstreamIssueIsNew("2030-01-01T00:00:00Z", Date.parse("2030-01-01T00:00:00Z") / 1000),
    ).toBe(true);
    expect(
      downstreamIssueIsNew("2029-12-31T23:00:00Z", Date.parse("2030-01-01T00:00:00Z") / 1000),
    ).toBe(false);
  });

  it("moves an approved Plan Run into execution and composes Go in the same Run", () => {
    const domain = state();
    const run = domain.runs[0]!;
    run.execution_profile = "plan";
    run.workflow = "pstack";
    run.state = "finished";
    run.plan_phase = "awaitingGo";
    run.prompt = "GRILL_RESPONSE_LANGUAGE=english\nPlan";
    expect(composePlanGoPrompt(run)).toContain("Read and execute the plan at `/tmp/plan.md`");
    const result = decide(domain, { type: "go_plan", runId: run.id });
    expect(result.state.runs[0]).toMatchObject({ state: "working", plan_phase: "executing" });
    expect(result.effects[0]?.type).toBe("persist_run_observation");
  });

  it("records a transcript frontier, validates every answer, then resumes the Run", () => {
    const domain = state();
    const run = domain.runs[0]!;
    run.execution_profile = "grill";
    run.state = "finished";
    run.grill_phase = "awaitingNextAction";
    run.grill_answers = [];
    run.grill_decisions = [];
    run.grill_response = null;
    const questionGroup = parseGrillQuestionGroup(
      "❓ **Q1** - **Storage**: Which format?\n➡️ SQLite",
    )!;
    const captured = decide(domain, {
      type: "record_run_transcript",
      runId: run.id,
      transcript: "❓ Q1",
      questionGroup,
    });
    expect(captured.state.runs[0]).toMatchObject({
      grill_phase: "waitingForAnswers",
      grill_question_group: questionGroup,
    });
    expect(() =>
      decide(captured.state, { type: "record_grill_answers", runId: run.id, answers: [] }),
    ).toThrow("no parsed Grill question group");
    const answered = decide(captured.state, {
      type: "record_grill_answers",
      runId: run.id,
      answers: [{ questionNumber: 1, answer: "SQLite" }],
    });
    const working = decide(answered.state, {
      type: "set_run_state",
      runId: run.id,
      state: "working",
    });
    const resumed = decide(working.state, {
      type: "record_grill_response",
      runId: run.id,
      response: "1. SQLite",
    });
    expect(resumed.state.runs[0]).toMatchObject({
      grill_answers: [{ questionNumber: 1, answer: "SQLite" }],
      grill_decisions: [{ questionNumber: 1, answer: "SQLite" }],
      grill_response: "1. SQLite",
      state: "working",
      grill_phase: "working",
    });
  });

  it("records downstream Link provenance idempotently", () => {
    const domain = state();
    domain.links = [];
    domain.external_objects = [];
    domain.snapshots = [];
    domain.next_external_object_id = 1;
    domain.next_link_id = 1;
    const run = domain.runs[0]!;
    run.execution_profile = "grill";
    run.grill_action = "to-spec";
    const issue = {
      object: {
        provider: "github" as const,
        kind: "issue" as const,
        external_key: "issue:acme/app#18",
        canonical_url: "https://github.com/acme/app/issues/18",
      },
      snapshot: {
        title: "Spec",
        state: "open",
        metadata: [{ key: "created", value: "2030-01-01T00:00:00Z" }],
        fetched_at: 100,
      },
      discovery: "structured-event" as const,
      ordinal: 1,
      blockedBy: [],
    };
    const first = decide(domain, {
      type: "capture_downstream_issues",
      runId: run.id,
      action: "to-spec",
      issues: [issue],
    });
    const second = decide(first.state, {
      type: "capture_downstream_issues",
      runId: run.id,
      action: "to-spec",
      issues: [issue],
    });
    expect(second.state.links).toHaveLength(1);
    expect(second.state.links[0]).toMatchObject({
      purpose: "to-spec",
      provenance: {
        run_id: run.id,
        action: "to-spec",
        discovery: "structured-event",
        ordinal: 1,
        blocked_by: [],
      },
    });
    expect(second.effects).toEqual([]);
  });

  it("records a captured Spec as the local parent of downstream tickets", () => {
    const domain = state();
    domain.external_objects = [];
    domain.links = [];
    domain.snapshots = [];
    domain.next_external_object_id = 1;
    domain.next_link_id = 1;
    const run = domain.runs[0]!;
    run.execution_profile = "grill";
    run.state = "finished";
    run.pane_status = "available";
    run.grill_phase = "awaitingNextAction";
    run.grill_action = "to-spec";

    const spec = decide(domain, {
      type: "capture_downstream_issues",
      runId: run.id,
      action: "to-spec",
      issues: [
        {
          object: {
            provider: "github",
            kind: "issue",
            external_key: "issue:acme/app#7",
            canonical_url: "https://github.com/acme/app/issues/7",
          },
          snapshot: {
            title: "Feature Spec",
            state: "open",
            metadata: [],
            fetched_at: 100,
          },
          discovery: "structured-event",
          ordinal: 1,
          blockedBy: [],
        },
      ],
    });
    const specObjectId = spec.state.external_objects[0]!.id;
    const ticketsRun = decide(spec.state, {
      type: "continue_grill",
      runId: run.id,
      action: "to-tickets",
      startedAt: 101,
    });
    const captured = decide(ticketsRun.state, {
      type: "capture_downstream_issues",
      runId: run.id,
      action: "to-tickets",
      issues: [
        {
          object: {
            provider: "github",
            kind: "issue",
            external_key: "issue:acme/app#8",
            canonical_url: "https://github.com/acme/app/issues/8",
          },
          snapshot: { title: "Ticket", state: "open", metadata: [], fetched_at: 102 },
          discovery: "structured-event",
          ordinal: 1,
          blockedBy: [],
        },
        {
          object: {
            provider: "azure_dev_ops",
            kind: "issue",
            external_key: "ado:acme/platform#17",
            canonical_url: "https://dev.azure.com/acme/platform/_workitems/edit/17",
          },
          snapshot: { title: "Azure Work Item", state: "open", metadata: [], fetched_at: 102 },
          discovery: "structured-event",
          ordinal: 2,
          blockedBy: [],
        },
      ],
    });

    expect(captured.state.links).toHaveLength(3);
    expect(
      captured.state.links.find((link) => link.external_object_id === specObjectId),
    ).toMatchObject({
      purpose: "to-spec",
    });
    const ticket = captured.state.links.find((link) => link.purpose === "to-tickets");
    expect(ticket).toMatchObject({
      spec_external_object_id: specObjectId,
      provenance: { run_id: run.id, action: "to-tickets", discovery: "structured-event" },
    });
    const azure = captured.state.links.find((link) => link.external_object_id === 3);
    expect(azure).toMatchObject({ purpose: "others", spec_external_object_id: null });
  });
});
