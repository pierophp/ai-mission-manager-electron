import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DomainState } from "./model";
import { decide } from "./state-transition";
import { homeView } from "./projections";
import { encodeImplementationQueue } from "../main/persistence/write-codecs";
import { implementationTicketIsOpen } from "./implementation-queue";
import { composeImplementationQueuePrompt } from "./implementation-queue";

function stateWithQueue(): DomainState {
  const state = JSON.parse(
    readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
  ) as DomainState;
  state.contexts[0]!.check_dirty_checkouts = false;
  state.implementation_queues = [
    {
      id: 1,
      itemId: 1,
      specExternalObjectId: 1,
      specUrl: "https://github.com/acme/app/issues/1",
      workspaceId: 1,
      repositoryId: 1,
      configuration: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      allowDirty: false,
      allowSharedCheckouts: false,
      entries: [
        {
          position: 0,
          ticketNumber: 89,
          ticketTitle: "First",
          ticketUrl: "https://github.com/acme/app/issues/89",
          ticketState: "open",
          runId: 1,
          done: false,
          skipped: false,
        },
        {
          position: 1,
          ticketNumber: 90,
          ticketTitle: "Second",
          ticketUrl: "https://github.com/acme/app/issues/90",
          ticketState: "open",
          runId: null,
          done: false,
          skipped: false,
        },
      ],
      active: true,
      pausedReason: null,
    },
  ];
  state.runs[0]!.state = "finished";
  return state;
}

function freshQueueStartState() {
  const state = stateWithQueue();
  state.runs = [];
  state.implementation_queues = [];
  state.next_run_id = 1;
  state.contexts[0]!.execution_machine_id = 1;
  const run = JSON.parse(readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"))
    .runs[0] as DomainState["runs"][number];
  run.session_name = "mission-item-1-run-1-new";
  run.pane_id = "%2";
  run.worktree_id = null;
  run.execution_profile = "implement";
  return { state, run };
}

function queueStartEvent(
  run: DomainState["runs"][number],
  specExternalObjectId: number,
  specUrl: string,
  ticketUrl = "https://github.com/acme/app/issues/89",
  ticketState = "OPEN",
) {
  return {
    type: "start_run" as const,
    run,
    queueStart: {
      configuration: { agent: "claude" as const, model: "claude-sonnet-5", effort: "high" },
      allowDirty: false,
      allowSharedCheckouts: false,
      start: {
        specExternalObjectId,
        specUrl,
        entries: [
          {
            position: 0,
            ticketNumber: 89,
            ticketTitle: "First",
            ticketUrl,
            ticketState,
            runId: null,
            done: false,
          },
        ],
      },
    },
  };
}

describe("Implementation Queue transitions", () => {
  it("creates a queue attached to the first Run with an ordered entry snapshot", () => {
    const state = stateWithQueue();
    state.runs = [];
    state.implementation_queues = [];
    state.next_run_id = 1;
    state.contexts[0]!.execution_machine_id = 1;
    const run = JSON.parse(readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"))
      .runs[0] as DomainState["runs"][number];
    run.session_name = "mission-item-1-run-1-new";
    run.pane_id = "%2";
    run.worktree_id = null;
    run.execution_profile = "implement";
    const decision = decide(state, {
      type: "start_run",
      run,
      queueStart: {
        configuration: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
        allowDirty: false,
        allowSharedCheckouts: false,
        start: {
          specExternalObjectId: 1,
          specUrl: "https://github.com/acme/app/issues/1",
          entries: [
            {
              position: 0,
              ticketNumber: 89,
              ticketTitle: "First",
              ticketUrl: "https://github.com/acme/app/issues/89",
              ticketState: "OPEN",
              runId: null,
              done: false,
            },
            {
              position: 1,
              ticketNumber: 90,
              ticketTitle: "Second",
              ticketUrl: "https://github.com/acme/app/issues/90",
              ticketState: "open",
              runId: null,
              done: false,
            },
          ],
        },
      },
    });
    expect(decision.state.implementation_queues[0]).toMatchObject({
      id: 1,
      active: true,
      pausedReason: null,
      entries: [
        { position: 0, runId: 1, skipped: false },
        { position: 1, runId: null, skipped: false },
      ],
    });
    expect(decision.state.runs[0]).toMatchObject({
      implementation_queue_id: 1,
      implementation_queue_position: 0,
    });
  });

  it("accepts Atlassian and local specs only when linked to the Item", () => {
    const supportedSpecs = [
      {
        provider: "atlassian" as const,
        kind: "issue" as const,
        external_key: "jira:APP#APP-12",
        canonical_url: "https://example.atlassian.net/browse/APP-12",
      },
      {
        provider: "generic" as const,
        kind: "generic" as const,
        external_key: "local:1#spec/README.md",
        canonical_url: "file:///repo/spec/README.md",
      },
    ];
    for (const spec of supportedSpecs) {
      for (const linked of [true, false]) {
        const { state, run } = freshQueueStartState();
        const specId = 2;
        state.external_objects.push({ id: specId, ...spec });
        if (linked) {
          state.links.push({
            ...structuredClone(state.links[0]!),
            id: 2,
            item_id: 1,
            external_object_id: specId,
            purpose: "to-spec",
          });
        }
        if (!linked) {
          expect(() => decide(state, queueStartEvent(run, specId, spec.canonical_url))).toThrow(
            "Implementation spec is not linked to the Item",
          );
        } else {
          const decision = decide(state, queueStartEvent(run, specId, spec.canonical_url));
          expect(decision.state.implementation_queues[0]!.specExternalObjectId).toBe(specId);
        }
      }
    }
  });

  it("rejects Azure DevOps work items as queue specs and tickets", () => {
    const { state, run } = freshQueueStartState();
    const azureSpec = {
      id: 2,
      provider: "azure_dev_ops" as const,
      kind: "issue" as const,
      external_key: "ado:org/project#123",
      canonical_url: "https://dev.azure.com/org/project/_workitems/edit/123",
    };
    state.external_objects.push(azureSpec);
    state.links.push({
      ...structuredClone(state.links[0]!),
      id: 2,
      item_id: 1,
      external_object_id: 2,
      purpose: "to-spec",
    });
    expect(() => decide(state, queueStartEvent(run, 2, azureSpec.canonical_url))).toThrow(
      "Implementation spec does not exist or is not supported by an Implementation Queue",
    );

    const ticketCase = freshQueueStartState();
    expect(() =>
      decide(
        ticketCase.state,
        queueStartEvent(
          ticketCase.run,
          1,
          "https://github.com/acme/app/issues/1",
          "https://dev.azure.com/org/project/_workitems/edit/123",
        ),
      ),
    ).toThrow("Implementation Queue entries must be ordered, unique, and open");
  });

  it("rejects a closed ticket and a second active queue for an Item", () => {
    const closedCase = freshQueueStartState();
    expect(() =>
      decide(
        closedCase.state,
        queueStartEvent(
          closedCase.run,
          1,
          "https://github.com/acme/app/issues/1",
          "https://github.com/acme/app/issues/89",
          "CLOSED",
        ),
      ),
    ).toThrow("Implementation Queue entries must be ordered, unique, and open");

    const activeCase = stateWithQueue();
    activeCase.runs = [];
    activeCase.next_run_id = 1;
    activeCase.contexts[0]!.execution_machine_id = 1;
    const run = JSON.parse(readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"))
      .runs[0] as DomainState["runs"][number];
    run.session_name = "mission-item-1-run-1-new";
    run.pane_id = "%2";
    run.worktree_id = null;
    run.execution_profile = "implement";
    expect(() =>
      decide(activeCase, queueStartEvent(run, 1, "https://github.com/acme/app/issues/1")),
    ).toThrow("Item 1 already has an active Implementation Queue");
  });

  it("advances a dirty checkout when the Context disables dirty-checkout checking", () => {
    const state = stateWithQueue();
    state.contexts[0]!.check_dirty_checkouts = false;
    const decision = decide(state, {
      type: "advance_implementation_queue",
      queueId: 1,
      runId: 1,
      ticketClosed: true,
      checkoutClean: false,
    });
    expect(decision.state.implementation_queues[0]!.entries[0]!.done).toBe(true);
    expect(decision.state.implementation_queues[0]!.pausedReason).toBeNull();
    expect(decision.effects).toContainEqual({
      type: "launch_implementation_queue_entry",
      queueId: 1,
      position: 1,
    });
  });

  it("rejects an invalid configuration when creating a queue", () => {
    const state = stateWithQueue();
    state.runs = [];
    state.implementation_queues = [];
    state.next_run_id = 1;
    state.contexts[0]!.execution_machine_id = 1;
    const run = JSON.parse(readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"))
      .runs[0] as DomainState["runs"][number];
    run.session_name = "mission-item-1-run-1-new";
    run.pane_id = "%2";
    run.worktree_id = null;
    run.execution_profile = "implement";
    expect(() =>
      decide(state, {
        type: "start_run",
        run,
        queueStart: {
          configuration: { agent: "claude", model: " ", effort: "high" },
          allowDirty: false,
          allowSharedCheckouts: false,
          start: {
            specExternalObjectId: 1,
            specUrl: "https://github.com/acme/app/issues/1",
            entries: [
              {
                position: 0,
                ticketNumber: 89,
                ticketTitle: "First",
                ticketUrl: "https://github.com/acme/app/issues/89",
                ticketState: "OPEN",
                runId: null,
                done: false,
              },
            ],
          },
        },
      }),
    ).toThrow("Grill configuration is invalid");
  });

  it("advances a finished Run, closes its session, and launches the next entry", () => {
    const decision = decide(stateWithQueue(), {
      type: "advance_implementation_queue",
      queueId: 1,
      runId: 1,
      ticketClosed: true,
      checkoutClean: true,
    });
    expect(decision.state.implementation_queues[0]!.entries[0]!.done).toBe(true);
    expect(decision.effects).toEqual([
      { type: "persist_implementation_queue", queue: decision.state.implementation_queues[0] },
      { type: "close_implementation_run_session", runId: 1 },
      { type: "launch_implementation_queue_entry", queueId: 1, position: 1 },
    ]);
  });

  it("waits for terminal ticket state and exposes the paused reason in Home", () => {
    const decision = decide(stateWithQueue(), {
      type: "advance_implementation_queue",
      queueId: 1,
      runId: 1,
      ticketClosed: false,
      checkoutClean: true,
    });
    expect(decision.state.implementation_queues[0]!.pausedReason).toEqual({
      kind: "ticket_still_open",
    });
    expect(homeView(decision.state, 1, "999").attention_entries).toContainEqual(
      expect.objectContaining({
        kind: "implementation_queue",
        queue_id: 1,
        run_id: 1,
        summary: "Implementation Queue ticket #89 paused: ticket is still open",
      }),
    );
    expect(decision.effects).toEqual([
      { type: "persist_implementation_queue", queue: decision.state.implementation_queues[0] },
    ]);
  });

  it("retains a finished Run session when a paused entry passes its retry checks", () => {
    const state = stateWithQueue();
    state.implementation_queues[0]!.pausedReason = { kind: "ticket_still_open" };
    const decision = decide(state, {
      type: "advance_implementation_queue",
      queueId: 1,
      runId: 1,
      ticketClosed: true,
      checkoutClean: true,
    });
    expect(decision.effects).not.toContainEqual({
      type: "close_implementation_run_session",
      runId: 1,
    });
  });

  it("skips the paused ticket, picks the next nonterminal entry, and cancellation keeps the Run", () => {
    const state = stateWithQueue();
    state.implementation_queues[0]!.pausedReason = { kind: "run_stopped" };
    const skipped = decide(state, {
      type: "skip_implementation_queue_entry",
      queueId: 1,
      position: 0,
    });
    expect(skipped.state.implementation_queues[0]!.entries[0]!.skipped).toBe(true);
    expect(skipped.effects.at(-1)).toEqual({
      type: "launch_implementation_queue_entry",
      queueId: 1,
      position: 1,
    });
    const cancelled = decide(skipped.state, { type: "cancel_implementation_queue", queueId: 1 });
    expect(cancelled.state.implementation_queues[0]).toMatchObject({
      active: false,
      pausedReason: null,
    });
    expect(cancelled.state.runs).toHaveLength(1);
  });

  it("serializes every queue field, entry position, and pausedReason in Rust declaration order", () => {
    const queue = stateWithQueue().implementation_queues[0]!;
    queue.pausedReason = { kind: "launch_failed", message: "could not launch" };
    expect(encodeImplementationQueue(queue)).toBe(
      JSON.stringify({
        id: 1,
        itemId: 1,
        specExternalObjectId: 1,
        specUrl: "https://github.com/acme/app/issues/1",
        workspaceId: 1,
        repositoryId: 1,
        configuration: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
        allowDirty: false,
        allowSharedCheckouts: false,
        entries: [
          {
            position: 0,
            ticketNumber: 89,
            ticketTitle: "First",
            ticketUrl: "https://github.com/acme/app/issues/89",
            ticketState: "open",
            runId: 1,
            done: false,
            skipped: false,
          },
          {
            position: 1,
            ticketNumber: 90,
            ticketTitle: "Second",
            ticketUrl: "https://github.com/acme/app/issues/90",
            ticketState: "open",
            runId: null,
            done: false,
            skipped: false,
          },
        ],
        active: true,
        pausedReason: { kind: "launch_failed", message: "could not launch" },
      }),
    );
  });

  it("matches the Rust terminal-state list for local Markdown Status values", () => {
    for (const status of [
      "Closed",
      "Done",
      "Resolved",
      "Completed",
      "Removed",
      "Cancelled",
      "Canceled",
    ])
      expect(implementationTicketIsOpen(status)).toBe(false);
    for (const status of ["Open", "In Progress", "Review"])
      expect(implementationTicketIsOpen(status)).toBe(true);
  });

  it("rejects canceled statuses when creating a queue because they are terminal in Rust", () => {
    for (const ticketState of ["cancelled", "canceled"]) {
      const state = stateWithQueue();
      state.runs = [];
      state.implementation_queues = [];
      state.next_run_id = 1;
      state.contexts[0]!.execution_machine_id = 1;
      const run = JSON.parse(
        readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
      ).runs[0] as DomainState["runs"][number];
      run.session_name = "mission-item-1-run-1-new";
      run.pane_id = "%2";
      run.worktree_id = null;
      run.execution_profile = "implement";
      const start = {
        specExternalObjectId: 1,
        specUrl: "https://github.com/acme/app/issues/1",
        entries: [
          {
            position: 0,
            ticketNumber: 89,
            ticketTitle: "First",
            ticketUrl: "https://github.com/acme/app/issues/89",
            ticketState,
            runId: null,
            done: false,
          },
        ],
      };
      expect(() =>
        decide(state, {
          type: "start_run",
          run,
          queueStart: {
            configuration: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
            allowDirty: false,
            allowSharedCheckouts: false,
            start,
          },
        }),
      ).toThrow("Implementation Queue entries must be ordered, unique, and open");
    }
  });

  it("clears a paused reason when associating a Run with an entry", () => {
    const state = stateWithQueue();
    state.implementation_queues[0]!.pausedReason = { kind: "launch_failed", message: "retry" };
    const decision = decide(state, {
      type: "set_implementation_queue_entry_run",
      queueId: 1,
      position: 1,
      runId: 2,
    });
    expect(decision.state.implementation_queues[0]!.entries[1]!.runId).toBe(2);
    expect(decision.state.implementation_queues[0]!.pausedReason).toBeNull();
  });

  it("pauses a queue with RunStopped when its active Run is stopped", () => {
    const decision = decide(stateWithQueue(), { type: "stop_run", runId: 1 });
    expect(decision.state.implementation_queues[0]!.pausedReason).toEqual({ kind: "run_stopped" });
    expect(decision.effects.at(-1)).toEqual({
      type: "persist_implementation_queue",
      queue: decision.state.implementation_queues[0],
    });
  });

  it("composes the complete Rust-compatible prompt for GitHub and local tickets", () => {
    const github = composeImplementationQueuePrompt(
      "---\nname: implement\n---\nImplement the work described by the user in the spec or tickets.",
      42,
      "https://github.com/acme/app/issues/42",
      "https://github.com/acme/app/issues/1",
    );
    expect(github).toContain("Implement the work described by the user in the spec or tickets.");
    expect(github).not.toContain("name: implement");
    expect(github).toContain("gh issue view 42 --comments");
    expect(github).toContain("Never close the parent spec or any other issue.");
    const local = composeImplementationQueuePrompt(
      "Implement it.",
      45,
      "file:///repo/.scratch/issues/my%20ticket.md",
      "spec",
    );
    expect(local).toContain("cat '/repo/.scratch/issues/my ticket.md'");
    expect(local).toContain("Status:` line to `Closed");
    expect(local).toContain("Never change the parent Spec's status.");
  });

  it("rejects advancing a Run until its turn has finished", () => {
    const state = stateWithQueue();
    state.runs[0]!.state = "working";
    expect(() =>
      decide(state, {
        type: "advance_implementation_queue",
        queueId: 1,
        runId: 1,
        ticketClosed: true,
        checkoutClean: true,
      }),
    ).toThrow("Run 1 has not finished and cannot advance Implementation Queue 1");
  });
});
