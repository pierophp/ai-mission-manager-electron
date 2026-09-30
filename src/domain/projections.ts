import type { DomainState } from "./model";
import type { AttentionEntry, HomeView, ItemView, WorkspaceRepository } from "./types";
import type { GrillContinuationAction, Run, RunProjection } from "./execution-types";

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

export function itemViews(state: DomainState, contextId?: number | null): ItemView[] {
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
        links: [],
      },
    ];
  });
}

export function homeView(
  state: DomainState,
  contextId: number | null | undefined,
  now: string,
): HomeView {
  const views = itemViews(state, contextId);
  const entries: AttentionEntry[] = [];
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
