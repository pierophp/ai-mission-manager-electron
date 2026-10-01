import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeGrillPrompt, composeRunPrompt, runLaunchOptions } from "./projections";
import { decide } from "./state-transition";
import type { DomainState } from "./model";
import type { Run } from "./execution-types";
import { composePstackPrompt, pstackRolePath } from "../main/run-launcher";

function state(): DomainState {
  return JSON.parse(
    readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
  ) as DomainState;
}

describe("Run launch domain projections", () => {
  it("offers workflow profiles and excludes Grill for Worktree launches", () => {
    const result = runLaunchOptions(state(), 1, "worktree");
    expect(result.defaultWorkflow).toBe("matt-pocock");
    expect(result.workflows[0]?.profiles.map((profile) => profile.executionProfile)).toEqual([
      "investigate",
      "implement",
      "review",
      "custom",
    ]);
    expect(result.workflows[1]?.profiles.map((profile) => profile.executionProfile)).toEqual([
      "autonomous",
      "plan",
      "pstack-review",
      "custom",
    ]);
  });

  it("composes prompt text in Rust section order and trims the Initial Prompt", () => {
    const prompt = composeRunPrompt(
      state(),
      1,
      "investigate",
      {
        includeObjective: true,
        externalObjectIds: [],
      },
      "english",
      "  inspect the current behavior  ",
    );
    expect(prompt).toBe(
      [
        "Respond to the user in English throughout this Run. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.",
        "Investigate this work, inspect the relevant code, and report findings before changing files.",
        `Item objective:\n${state().items[0]?.title}`,
        "User's initial prompt:\ninspect the current behavior",
      ].join("\n\n"),
    );
  });

  it("composes Implement and Grill prompts byte-for-byte from Rust source sections", () => {
    const domain = state();
    const stripFrontmatter = (source: string) => {
      if (!source.startsWith("---\n")) return source;
      const body = source.slice(4);
      const end = body.indexOf("\n---\n");
      return end < 0 ? source : body.slice(end + 5);
    };
    const implementSkill = stripFrontmatter(
      readFileSync(".agents/skills/implement/SKILL.md", "utf8"),
    );
    expect(
      composeRunPrompt(
        domain,
        1,
        "implement",
        { includeObjective: true, externalObjectIds: [] },
        "english",
        "  Fix the launch gate.  ",
        implementSkill,
      ),
    ).toBe(
      [
        "Respond to the user in English throughout this Run. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.",
        `${implementSkill}\n\nImplement this work using the Repositories configured for its Project or a registered Worktree, run the relevant checks, and leave the changes ready for review.`,
        `Item objective:\n${domain.items[0]?.title}`,
        "User's initial prompt:\nFix the launch gate.",
      ].join("\n\n"),
    );

    const grillSkill = stripFrontmatter(readFileSync(".agents/skills/grilling/SKILL.md", "utf8"));
    const contract = [
      "Mission Manager output contract (it reads your questions from the terminal and shows them to the user as a form):",
      "- Start every question on its own line with `❓ **Q<n>** - **<title>**: <question>`. Number questions 1, 2, 3… within the round.",
      "- Put the recommendation on the line that starts with `➡️`. Do not add prose after the recommendation other than lettered options (`A) …`).",
      "- Separate questions with a line containing only `---`.",
      "- Print each round exactly once, at the end of your turn. If a sub-agent you are waiting on changes a question, print only the revised full round; Mission Manager shows only the last round printed in a turn.",
      "- Keep status notes (what you are checking, what you found) before the first `❓`, never between or after the questions.",
      "- The user answers every question of the round at once, with one numbered reply (`1. …`, `2. …`). An answer of `ok` accepts your recommendation.",
    ].join("\n");
    expect(
      composeGrillPrompt(
        domain,
        1,
        { agent: "claude", model: "claude-sonnet-5", effort: "high" },
        "english",
        "Ask about direct runs.",
        grillSkill,
      ),
    ).toBe(
      `You are starting a Grill Run.\n\nGRILL_RESPONSE_LANGUAGE=english\nRespond to the user in English throughout this Grill Run, including every answer and continuation. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.\n\nGrill configuration: agent="claude", model=claude-sonnet-5, effort=high.\n\nGrilling skill snapshot:\n${grillSkill}\n\n${contract}\n\nRelevant Item context:\nItem objective:\n${domain.items[0]?.title}\n\nLinked source:\nFixture issue\nhttps://github.com/acme/app/issues/1\n\nUser's initial prompt:\nAsk about direct runs.`,
    );
  });

  it("composes the Autonomous pstack prompt byte-for-byte from Rust sections", () => {
    const domain = state();
    const context = domain.contexts.find((candidate) => candidate.id === 1)!;
    const root = "/opt/pstack";
    const rolesPath = pstackRolePath(context, root);
    expect(
      composePstackPrompt(domain, 1, "autonomous", root, "english", "  Fix the SSH launch gate.  "),
    ).toBe(
      `You are starting an Autonomous pstack Run. Read \`${root}/skills/poteto-mode/SKILL.md\` in full before acting. The Skill tool is unavailable because these skills disable model invocation; read any other needed skill by its absolute path under \`${root}/skills/\` instead of relying on the Skill tool. Read the generated role instructions at \`${rolesPath}\` and follow them when delegating. Do not paste skill text into your response.\n\nItem: ${domain.items[0]?.title}\n\nInitial Prompt:\nFix the SSH launch gate.\n\nSpec: https://github.com/acme/app/issues/1\n\nRespond to the user in English throughout this Run. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.\nWrite commits and pull requests in English.\n\nMission Manager event contract:\nWhen a Pull Request is opened, immediately print \`AI_MISSION_MANAGER_EVENT {"event":"pull_request.opened","url":"<canonical Pull Request URL>"}\` on a line by itself. Report every Pull Request opened by this Run. At the end of the final Attention section in your final response, print \`AI_MISSION_MANAGER_EVENT {"event":"attention.final","summary":"<concise Attention summary>"}\`. For a Plan Run, also print \`AI_MISSION_MANAGER_EVENT {"event":"plan.ready","path":"<repository-relative plan path>"}\` after writing the plan. Escape JSON strings correctly.`,
    );
  });
});

describe("Run lifecycle domain events", () => {
  it("persists a Run before release and finishes it without changing its Item", () => {
    const current = state();
    const existing = current.runs[0]!;
    current.contexts.find((context) => context.id === 1)!.execution_machine_id = 1;
    current.runs = [];
    current.next_run_id = 1;
    const run: Run = {
      ...existing,
      id: 1,
      item_id: 1,
      state: "unknown",
      pane_status: "available",
      session_name: "mission-item-1-run-1",
      pane_id: "%9",
      execution_profile: "implement",
      workflow: "matt-pocock",
      worktree_id: null,
      direct_checkouts: [{ repositoryId: 1, path: "/repos/app", branch: "main", isDirty: false }],
      working_directory: "/repos/app",
    };
    const started = decide(current, { type: "start_run", run });
    expect(started.state.runs).toEqual([run]);
    expect(started.state.next_run_id).toBe(2);
    expect(started.effects).toEqual([
      { type: "persist_run", run, nextRunId: 2 },
      { type: "persist_audit", action: { action: "runCreated", run_id: 1 } },
    ]);
    const itemStatus = started.state.items[0]?.status;
    const finished = decide(started.state, { type: "finish_run", runId: 1 });
    expect(finished.state.runs[0]?.state).toBe("finished");
    expect(finished.state.items[0]?.status).toBe(itemStatus);
    expect(finished.effects[0]).toMatchObject({
      type: "persist_run_observation",
      run: { id: 1, state: "finished" },
    });
    expect(finished.effects[1]).toEqual({
      type: "persist_audit",
      action: { action: "runFinished", run_id: 1 },
    });
  });
});
