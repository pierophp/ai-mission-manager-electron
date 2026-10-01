import type { Runtime } from "./runtime";
import type { TerminalRuntime } from "./terminal";
import type { Run } from "../domain/types";
import {
  discoverDownstreamIssueCandidates,
  downstreamIssueIsNew,
  reconcileGrillQuestionGroup,
} from "../domain/grilling";
import { resolveMachinePath } from "./machine-path";
import {
  classifyLocalMarkdown,
  classifyUrl,
  ProviderDispatch,
  readMarkdownSnapshot,
} from "./provider";

function recordPlanReadyEvents(runtime: Runtime, runId: number, transcript: string): void {
  for (const line of transcript.split(/\r?\n/)) {
    const marker = line.indexOf("AI_MISSION_MANAGER_EVENT ");
    if (marker < 0) continue;
    try {
      const event = JSON.parse(line.slice(marker + "AI_MISSION_MANAGER_EVENT ".length)) as {
        event?: string;
        path?: string;
      };
      if (event.event === "plan.ready" && event.path)
        runtime.dispatch({ type: "record_run_plan", runId, path: event.path });
    } catch {
      /* Ignore terminal lines that do not contain a complete plan event. */
    }
  }
}

async function captureDownstreamIssues(
  runtime: Runtime,
  runId: number,
  transcript: string,
): Promise<void> {
  const latest = runtime.snapshot();
  const liveRun = latest.runs.find((entry) => entry.id === runId);
  if (!liveRun?.grill_action || !["to-spec", "to-tickets"].includes(liveRun.grill_action)) return;
  const candidates = discoverDownstreamIssueCandidates(transcript);
  const item = latest.items.find((entry) => entry.id === liveRun.item_id);
  const project = item && latest.projects.find((entry) => entry.id === item.project_id);
  const context = project && latest.contexts.find((entry) => entry.id === project.context_id);
  const issues = [];
  for (const candidate of candidates) {
    if (candidate.runId !== null && candidate.runId !== runId) continue;
    if (candidate.action !== null && candidate.action !== liveRun.grill_action) continue;
    try {
      const isLocal = /^(?:file:|.*\.(?:md|markdown)(?:[?#]|$))/i.test(candidate.url);
      let object;
      let snapshot;
      if (isLocal && item && project && context) {
        const machineForContext = latest.machines.find(
          (entry) => entry.id === context.execution_machine_id,
        );
        if (machineForContext?.transport.kind !== "local") continue;
        for (const repository of latest.repositories.filter(
          (entry) => entry.project_id === project.id,
        )) {
          const location = latest.repository_locations.find(
            (entry) =>
              entry.repository_id === repository.id && entry.machine_id === machineForContext.id,
          );
          if (!location) continue;
          const classified = await classifyLocalMarkdown(
            repository.id,
            resolveMachinePath(location.checkout_path, process.env.HOME ?? ""),
            candidate.url,
          );
          if (!classified) continue;
          object = classified;
          snapshot = await readMarkdownSnapshot(
            decodeURIComponent(new URL(classified.canonical_url).pathname),
            Math.floor(Date.now() / 1000),
          );
          break;
        }
      } else {
        object = classifyUrl(candidate.url);
        if (object.provider === "generic" || !context) continue;
        snapshot = await new ProviderDispatch({
          ghPath: context.gh_executable_path,
          twgPath: context.twg_executable_path,
          azPath: context.az_executable_path,
          atlassianSite: context.atlassian_site,
          bitbucketWorkspace: context.bitbucket_workspace,
          azureDevOpsOrganization: context.azure_devops_organization,
        }).fetchSnapshot(object, Math.floor(Date.now() / 1000));
      }
      if (
        object &&
        snapshot &&
        downstreamIssueIsNew(
          snapshot.metadata.find((entry) => entry.key === "created")?.value,
          liveRun.grill_action_started_at,
        )
      )
        issues.push({
          object,
          snapshot,
          discovery: candidate.discovery,
          ordinal: candidate.ordinal,
          blockedBy: candidate.blockedBy,
        });
    } catch {
      /* Transcript references may be incidental or unavailable; keep the Run usable. */
    }
  }
  if (issues.length)
    runtime.dispatch({
      type: "capture_downstream_issues",
      runId,
      action: liveRun.grill_action,
      issues,
    });
}

function reconcileGrillQuestions(
  runtime: Runtime,
  runId: number,
  current: Run,
  transcript: string,
  onRunQuestionsChanged: (runId: number) => void,
): void {
  const group = reconcileGrillQuestionGroup(current, transcript);
  const hasPendingQuestions =
    group !== null &&
    (current.grill_response === null ||
      JSON.stringify(current.grill_question_group) !== JSON.stringify(group));
  const phaseSynchronized =
    current.state !== "finished" ||
    current.grill_phase === "finished" ||
    current.grill_phase === (hasPendingQuestions ? "waitingForAnswers" : "awaitingNextAction");
  if (
    current.transcript !== transcript ||
    JSON.stringify(current.grill_question_group) !== JSON.stringify(group) ||
    !phaseSynchronized
  ) {
    runtime.dispatch({ type: "record_run_transcript", runId, transcript, questionGroup: group });
    if (JSON.stringify(current.grill_question_group) !== JSON.stringify(group))
      onRunQuestionsChanged(runId);
  }
}

export function createRunWorkflowReconciler(
  runtime: Runtime,
  terminalRuntime: TerminalRuntime,
  onRunQuestionsChanged: (runId: number) => void,
) {
  const runAndMachine = (runId: number) => {
    const state = runtime.snapshot();
    const run = state.runs.find((entry) => entry.id === runId);
    if (!run) throw new Error(`Run ${runId} does not exist`);
    const machine = state.machines.find((entry) => entry.id === run.machine_id);
    if (!machine) throw new Error(`Machine ${run.machine_id} does not exist`);
    return { state, run, machine };
  };
  const reconcileRunWorkflowState = async (runId: number) => {
    const { run, machine } = runAndMachine(runId);
    if (run.execution_profile !== "grill" && run.execution_profile !== "plan") return;
    if (run.pane_status !== "available") return;
    const transcript = await terminalRuntime.capturePaneTranscript(machine, run.pane_id);
    if (run.execution_profile === "plan") {
      recordPlanReadyEvents(runtime, runId, transcript);
      return;
    }
    const current = runtime.snapshot().runs.find((entry) => entry.id === runId);
    if (!current || current.machine_id !== run.machine_id || current.pane_id !== run.pane_id)
      return;
    reconcileGrillQuestions(runtime, runId, current, transcript, onRunQuestionsChanged);
    await captureDownstreamIssues(runtime, runId, transcript);
  };
  return reconcileRunWorkflowState;
}
