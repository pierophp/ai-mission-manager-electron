import type {
  AttentionEntry,
  ExternalLinkView,
  ExternalChange,
  HomeView,
  ItemView,
  WorkspaceRepository,
} from "./types";
import type {
  ExecutionProfile,
  GrillContinuationAction,
  Run,
  RunProjection,
  Workflow,
  RunPromptSelection,
} from "./execution-types";
import type { DomainState } from "./model";
import type { RunLaunchOptions, RunLaunchTargetKind } from "./types";

export function runLaunchOptions(
  state: DomainState,
  itemId: number,
  target: RunLaunchTargetKind,
): RunLaunchOptions {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Item ${itemId} does not exist`);
  const project = state.projects.find((candidate) => candidate.id === item.project_id);
  if (!project) throw new Error(`Project ${item.project_id} does not exist`);
  const context = state.contexts.find((candidate) => candidate.id === project.context_id);
  if (!context) throw new Error(`Context ${project.context_id} does not exist`);
  const offers: Record<Workflow, ExecutionProfile[]> = {
    "matt-pocock": ["grill", "investigate", "implement", "review", "custom"],
    pstack: ["autonomous", "plan", "pstack-review", "custom"],
  };
  const workflows = (Object.keys(offers) as Workflow[]).map((workflow) => ({
    workflow,
    defaultProfile:
      workflow === "pstack"
        ? ("autonomous" as const)
        : target === "worktree"
          ? ("investigate" as const)
          : ("grill" as const),
    profiles: offers[workflow]
      .filter((profile) => !(target === "worktree" && profile === "grill"))
      .map((executionProfile) => ({
        executionProfile,
        configuration:
          workflow === "pstack"
            ? (context.pstack_defaults ?? context.implement_defaults ?? context.grill_defaults)
            : executionProfile === "grill"
              ? context.grill_defaults
              : (context.implement_defaults ?? context.grill_defaults),
        requiresInitialPrompt: ["grill", "custom", "pstack-review"].includes(executionProfile),
      })),
  }));
  return { defaultWorkflow: context.default_workflow ?? "matt-pocock", workflows };
}

export function composeRunPrompt(
  state: DomainState,
  itemId: number,
  profile: ExecutionProfile,
  selection: RunPromptSelection,
  language: "portuguese" | "english" | null,
  initialPrompt: string | null,
  implementationSkillSnapshot = "",
): string {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Item ${itemId} does not exist`);
  const initial = initialPrompt?.trim() || null;
  const sections: string[] = [];
  if (selection.includeObjective) sections.push(`Item objective:\n${item.title}`);
  for (const externalObjectId of selection.externalObjectIds) {
    if (
      !state.links.some(
        (link) => link.item_id === itemId && link.external_object_id === externalObjectId,
      )
    )
      throw new Error(`External Object ${externalObjectId} is not linked to Item ${itemId}`);
    const object = state.external_objects.find((candidate) => candidate.id === externalObjectId);
    if (!object) throw new Error(`External Object ${externalObjectId} does not exist`);
    const title =
      state.snapshots.find((snapshot) => snapshot.external_object_id === externalObjectId)?.title ??
      "Linked external object";
    sections.push(`Linked source:\n${title}\n${object.canonical_url}`);
  }
  const instruction: Partial<Record<ExecutionProfile, string>> = {
    investigate:
      "Investigate this work, inspect the relevant code, and report findings before changing files.",
    implement: implementationSkillSnapshot
      ? `${implementationSkillSnapshot}\n\nImplement this work using the Repositories configured for its Project or a registered Worktree, run the relevant checks, and leave the changes ready for review.`
      : `Implement this work using the Repositories configured for its Project or a registered Worktree, run the relevant checks, and leave the changes ready for review.`,
    review:
      "Review the current changes for this Item for correctness, regressions, and missing test coverage.",
    custom: initial ?? "",
    grill:
      "Use the selected grilling skill to ask a structured frontier of questions before recommending the next decision.",
  };
  if (["autonomous", "plan", "pstack-review"].includes(profile))
    throw new Error(`Execution Profile ${profile} is not in Workflow matt-pocock`);
  if (profile === "custom" && !initial) throw new Error("Run prompt cannot be empty");
  sections.unshift(instruction[profile] ?? "");
  if (profile !== "custom" && initial) sections.push(`User's initial prompt:\n${initial}`);
  if (language)
    sections.unshift(
      `Respond to the user in ${language === "portuguese" ? "Portuguese" : "English"} throughout this Run. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.`,
    );
  return sections.join("\n\n").trim();
}

export function composeGrillPrompt(
  state: DomainState,
  itemId: number,
  configuration: { agent: "claude" | "codex"; model: string; effort: string },
  language: "portuguese" | "english",
  initialPrompt: string,
  grillSkill: string,
): string {
  if (!configuration.model.trim() || !configuration.effort.trim())
    throw new Error("Invalid Grill configuration");
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Item ${itemId} does not exist`);
  const initial = initialPrompt.trim();
  if (!initial) throw new Error("Run prompt cannot be empty");
  const context = [`Item objective:\n${item.title}`];
  for (const link of state.links.filter((candidate) => candidate.item_id === itemId)) {
    const object = state.external_objects.find(
      (candidate) => candidate.id === link.external_object_id,
    );
    if (object) {
      const title =
        state.snapshots.find((snapshot) => snapshot.external_object_id === object.id)?.title ??
        "Linked external object";
      context.push(`Linked source:\n${title}\n${object.canonical_url}`);
    }
  }
  const response =
    language === "portuguese"
      ? "GRILL_RESPONSE_LANGUAGE=portuguese\nRespond to the user in Portuguese throughout this Grill Run, including every answer and continuation. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate."
      : "GRILL_RESPONSE_LANGUAGE=english\nRespond to the user in English throughout this Grill Run, including every answer and continuation. Keep code, identifiers, proper names, and quoted source text in their original language when appropriate.";
  const contract =
    "Mission Manager output contract (it reads your questions from the terminal and shows them to the user as a form):\n- Start every question on its own line with `❓ **Q<n>** - **<title>**: <question>`. Number questions 1, 2, 3… within the round.\n- Put the recommendation on the line that starts with `➡️`. Do not add prose after the recommendation other than lettered options (`A) …`).\n- Separate questions with a line containing only `---`.\n- Print each round exactly once, at the end of your turn. If a sub-agent you are waiting on changes a question, print only the revised full round; Mission Manager shows only the last round printed in a turn.\n- Keep status notes (what you are checking, what you found) before the first `❓`, never between or after the questions.\n- The user answers every question of the round at once, with one numbered reply (`1. …`, `2. …`). An answer of `ok` accepts your recommendation.";
  return `You are starting a Grill Run.\n\n${response}\n\nGrill configuration: agent=${JSON.stringify(configuration.agent)}, model=${configuration.model}, effort=${configuration.effort}.\n\nGrilling skill snapshot:\n${grillSkill}\n\n${contract}\n\nRelevant Item context:\n${context.join("\n\n")}\n\nUser's initial prompt:\n${initial}`;
}

function runIsActive(run: Run): boolean {
  return (
    run.state !== "finished" ||
    (run.execution_profile === "grill" && run.grill_phase !== "finished") ||
    (run.execution_profile === "plan" && run.plan_phase === "awaitingGo")
  );
}

function runSignalActive(run: Run): boolean {
  return (
    runIsActive(run) &&
    run.pane_status !== "missing" &&
    !(
      run.execution_profile === "grill" &&
      run.grill_phase === "waitingForAnswers" &&
      run.grill_response === null
    )
  );
}

function runProjection(run: Run): RunProjection {
  const active = runIsActive(run);
  const grillActions: GrillContinuationAction[] = [];
  if (run.execution_profile === "grill") {
    const nextAction =
      run.grill_action === null
        ? "to-spec"
        : run.grill_action === "to-spec"
          ? "to-tickets"
          : run.grill_action === "to-tickets"
            ? "implement"
            : null;
    if (run.grill_phase === "awaitingNextAction") {
      grillActions.push("to-spec", "to-tickets", "implement");
      if (run.grill_action === "to-spec") grillActions.shift();
    } else if (run.grill_phase === "waitingForAnswers" && nextAction) {
      grillActions.push(nextAction);
    }
  }
  const phase =
    run.execution_profile === "plan" && run.plan_phase === "awaitingGo"
      ? "awaitingGo"
      : run.execution_profile === "grill" && run.grill_phase
        ? (
            {
              starting: "grillStarting",
              working: "grillWorking",
              waitingForAnswers: "grillWaitingForAnswers",
              awaitingNextAction: "grillAwaitingNextAction",
              recoverablePaneLoss: "grillRecoverablePaneLoss",
              finished: "finished",
            } as const
          )[run.grill_phase]
        : run.state;
  return {
    runId: run.id,
    status: active ? "active" : "finished",
    phase,
    continuations: {
      goPlan: run.execution_profile === "plan" && run.plan_phase === "awaitingGo",
      grillActions,
      stop: active && run.pane_status !== "missing",
      finish: active,
      delete: !active,
    },
  };
}

export function itemViews(state: DomainState, contextId?: number | null, now?: string): ItemView[] {
  return state.items.flatMap((item) => {
    const project = state.projects.find((candidate) => candidate.id === item.project_id);
    if (!project || (contextId != null && project.context_id !== contextId)) return [];
    const context = state.contexts.find((candidate) => candidate.id === project.context_id);
    if (!context) return [];
    const relationships = state.relationships.filter(
      (relation) => relation.from_item_id === item.id || relation.to_item_id === item.id,
    );
    const projectRepositories: WorkspaceRepository[] = state.repositories
      .filter((repository) => repository.project_id === item.project_id)
      .map((repository) => ({
        repository_id: repository.id,
        branch: `mission-${item.human_identifier}`,
        base_branch: repository.base_branch,
      }));
    const workspaces = state.workspaces
      .filter((workspace) => workspace.item_id === item.id)
      .map((workspace) => ({ ...workspace, repositories: projectRepositories }));
    const runs = state.runs.filter((run) => run.item_id === item.id);
    const worktrees = state.worktrees
      .filter((worktree) =>
        state.workspaces.some(
          (workspace) => workspace.id === worktree.workspaceId && workspace.item_id === item.id,
        ),
      )
      .map((worktree) => ({
        id: worktree.id,
        workspace_id: worktree.workspaceId,
        repository_id: worktree.repositoryId,
        machine_id: worktree.machineId,
        path: worktree.path,
        branch: worktree.branch,
        base_branch: worktree.baseBranch,
        is_dirty: worktree.isDirty,
      }));
    return [
      {
        item,
        context_id: context.id,
        context_name: context.name,
        project_name: project.name,
        relationships,
        workspaces,
        worktrees,
        runs,
        run_projections: runs.map(runProjection),
        run_signals: {
          grillWaiting: runs.some(
            (run) =>
              run.execution_profile === "grill" &&
              run.grill_phase === "waitingForAnswers" &&
              run.grill_response === null,
          ),
          runActive: runs.some(runSignalActive),
        },
        implementation_queues: state.implementation_queues.filter(
          (queue) => queue.itemId === item.id,
        ),
        links: state.links
          .filter((link) => link.item_id === item.id)
          .flatMap((link) => {
            const object = state.external_objects.find(
              (candidate) => candidate.id === link.external_object_id,
            );
            if (!object) return [];
            const snapshot =
              state.snapshots.find((candidate) => candidate.external_object_id === object.id) ??
              null;
            const attentionPolicy = link.attention_policy ??
              state.attention_defaults.find(
                (entry) => entry.context_id === context.id && entry.object_kind === object.kind,
              )?.policy ?? { title: true, state: true, metadata: true };
            const watchActive =
              now === undefined || link.watch_until === null || link.watch_until > now;
            const activities = state.activities
              .filter(
                (activity) =>
                  watchActive &&
                  activity.external_object_id === object.id &&
                  activity.id > link.reviewed_activity_id,
              )
              .map((activity) => ({
                ...activity,
                changes: activity.changes.filter((change) => attentionPolicy[change.kind]),
              }))
              .filter((activity) => activity.changes.length);
            const attentionEntry = activities.length
              ? {
                  kind: "external_change" as const,
                  link_id: link.id,
                  reminder_id: null,
                  run_id: null,
                  queue_id: null,
                  item_id: item.id,
                  external_object_id: object.id,
                  source_title: snapshot?.title ?? object.canonical_url,
                  source_url: object.canonical_url,
                  activities,
                  summary: activities
                    .flatMap((activity) => activity.changes.map(formatExternalChange))
                    .join("; "),
                }
              : null;
            const local = object.provider === "generic" && object.external_key.startsWith("local:");
            const view: ExternalLinkView = {
              link,
              object,
              snapshot,
              attention_policy: attentionPolicy,
              attention_entry: attentionEntry,
              supports_implementation_spec:
                local ||
                (object.provider === "github" && object.kind === "issue") ||
                (object.provider === "atlassian" &&
                  (object.kind === "issue" || object.kind === "document")),
              supports_implementation_ticket:
                local ||
                (object.provider === "github" && object.kind === "issue") ||
                (object.provider === "atlassian" && object.kind === "issue"),
            };
            return [view];
          }),
      },
    ];
  });
}

function formatExternalChange(change: ExternalChange): string {
  const label =
    change.kind === "title"
      ? "Title"
      : change.kind === "state"
        ? "State"
        : `Metadata ${change.key ?? "value"}`;
  if (change.previous !== null && change.current !== null)
    return `${label} changed from ${change.previous} to ${change.current}`;
  if (change.current !== null) return `${label} added as ${change.current}`;
  if (change.previous !== null) return `${label} removed (was ${change.previous})`;
  return `${label} changed`;
}

export function homeView(
  state: DomainState,
  contextId: number | null | undefined,
  now: string,
): HomeView {
  const views = itemViews(state, contextId, now);
  const entries: AttentionEntry[] = [];
  for (const view of views) {
    const { item } = view;
    for (const { link, object, snapshot, attention_entry: attentionEntry } of view.links) {
      if (attentionEntry) entries.push(attentionEntry);
      if (link.review_at !== null && link.review_at <= now)
        entries.push({
          kind: "review",
          link_id: link.id,
          reminder_id: null,
          run_id: null,
          queue_id: null,
          item_id: item.id,
          external_object_id: object.id,
          source_title: snapshot?.title ?? object.canonical_url,
          source_url: object.canonical_url,
          activities: [],
          summary: `Review scheduled for ${link.review_at}`,
        });
    }
  }
  for (const { item } of views) {
    for (const reminder of item.reminders.filter((candidate) => candidate.remind_at <= now))
      entries.push({
        kind: "reminder",
        link_id: 0,
        reminder_id: reminder.id,
        run_id: null,
        queue_id: null,
        item_id: item.id,
        external_object_id: 0,
        source_title: item.title,
        source_url: "",
        activities: [],
        summary: `Reminder due at ${reminder.remind_at}`,
      });
  }
  for (const run of state.runs.filter((candidate) => candidate.state === "blocked")) {
    const view = views.find(({ item }) => item.id === run.item_id);
    if (!view) continue;
    entries.push({
      kind: "blocked_run",
      link_id: 0,
      reminder_id: null,
      run_id: run.id,
      queue_id: null,
      item_id: run.item_id,
      external_object_id: 0,
      source_title: view.item.title,
      source_url: "",
      activities: [],
      summary: `Run #${run.id} is blocked and needs your input`,
    });
  }
  const home: HomeView = {
    needs_attention: [],
    attention_entries: entries,
    running: [],
    waiting: [],
    due: [],
    completed: [],
  };
  for (const view of views) {
    const due =
      view.item.status !== "Done" &&
      view.item.reminders.some((reminder) => reminder.remind_at <= now);
    if (due) home.due.push(view);
    if (
      due ||
      view.item.status === "Inbox" ||
      (view.item.status !== "Done" && entries.some((entry) => entry.item_id === view.item.id))
    )
      home.needs_attention.push(view);
    if (view.item.status === "Active") home.running.push(view);
    else if (view.item.status === "Waiting") home.waiting.push(view);
    else if (view.item.status === "Done") home.completed.push(view);
  }
  return home;
}

export function searchItems(
  state: DomainState,
  query: string,
  contextId?: number | null,
): ItemView[] {
  const normalized = query.trim().toLowerCase();
  return itemViews(state, contextId).filter(
    ({ item, context_name, project_name }) =>
      !normalized ||
      [item.human_identifier, item.title, item.notes, context_name, project_name].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
  );
}
