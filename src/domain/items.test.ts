import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decide } from "./state-transition";
import { homeView, searchItems } from "./projections";
import type { DomainState } from "./model";
import type { Item } from "./types";

function itemState(): DomainState {
  const state = JSON.parse(
    readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
  ) as DomainState;
  state.next_item_id = 1;
  state.next_item_number = 77;
  state.next_reminder_id = 1;
  state.items = [];
  state.workspaces = [];
  state.worktrees = [];
  state.runs = [];
  state.implementation_queues = [];
  state.relationships = [];
  state.links = [];
  state.snapshots = [];
  state.activities = [];
  state.repositories = [];
  state.projects = state.projects.slice(0, 1).map((project) => ({
    ...project,
    id: 1,
    context_id: state.contexts[0].id,
    defaults: { item_status: "Inbox", execution_mode: "worktree" },
  }));
  return state;
}

describe("Item domain transitions and projections", () => {
  it("creates an Item from metadata sequences with the human I-N identifier", () => {
    const decision = decide(itemState(), {
      type: "create_item",
      title: "  Rebuild search  ",
      contextId: 1,
      projectId: 1,
      notes: "initial note",
    });
    expect(decision.state.items[0]).toMatchObject({
      id: 1,
      human_identifier: "I-77",
      title: "Rebuild search",
      status: "Inbox",
      notes: "initial note",
    });
    expect(decision.state.next_item_id).toBe(2);
    expect(decision.state.next_item_number).toBe(78);
    expect(decision.effects).toEqual([
      { type: "persist_item", item: decision.state.items[0], nextItemId: 2, nextItemNumber: 78 },
    ]);
  });

  it("persists title edits and validates blank titles", () => {
    const state = itemState();
    state.items.push({
      id: 4,
      human_identifier: "I-80",
      title: "Before",
      project_id: 1,
      status: "Inbox",
      notes: "",
      reminders: [],
    });
    const decision = decide(state, { type: "set_item_title", itemId: 4, title: "  After  " });
    expect(decision.state.items[0].title).toBe("After");
    expect(decision.effects).toEqual([
      { type: "persist_item_update", item: decision.state.items[0] },
    ]);
    expect(() => decide(state, { type: "set_item_title", itemId: 4, title: " " })).toThrow(
      "an Item title cannot be blank",
    );
  });

  it("adds and removes reminders with a stable id sequence and stores relation enum casing", () => {
    const state = itemState();
    state.items.push(
      {
        id: 1,
        human_identifier: "I-1",
        title: "One",
        project_id: 1,
        status: "Active",
        notes: "",
        reminders: [],
      },
      {
        id: 2,
        human_identifier: "I-2",
        title: "Two",
        project_id: 1,
        status: "Waiting",
        notes: "",
        reminders: [],
      },
    );
    const added = decide(state, {
      type: "add_item_reminder",
      itemId: 1,
      remindAt: "2030-01-02T03:04:05Z",
    });
    expect(added.state.items[0].reminders).toEqual([{ id: 1, remind_at: "2030-01-02T03:04:05Z" }]);
    expect(added.state.next_reminder_id).toBe(2);
    const related = decide(added.state, {
      type: "set_item_relation",
      fromItemId: 1,
      toItemId: 2,
      kind: "Blocks",
    });
    expect(related.state.relationships[0]).toEqual({
      from_item_id: 1,
      to_item_id: 2,
      kind: "Blocks",
    });
    expect(related.effects).toEqual([
      { type: "persist_item_relation", relation: related.state.relationships[0] },
    ]);
    const removed = decide(related.state, {
      type: "remove_item_reminder",
      itemId: 1,
      reminderId: 1,
    });
    expect(removed.state.items[0].reminders).toEqual([]);
    expect(() =>
      decide(related.state, {
        type: "set_item_relation",
        fromItemId: 1,
        toItemId: 2,
        kind: "Blocks",
      }),
    ).toThrow("the relationship already exists");
    expect(() =>
      decide(related.state, {
        type: "set_item_relation",
        fromItemId: 1,
        toItemId: 1,
        kind: "Blocks",
      }),
    ).toThrow("an Item cannot relate to itself: 1");
  });

  it("rejects enum strings that Rust IPC deserialization would reject", () => {
    const state = itemState();
    state.items.push({
      id: 1,
      human_identifier: "I-1",
      title: "One",
      project_id: 1,
      status: "Inbox",
      notes: "",
      reminders: [],
    });
    expect(() =>
      decide(state, { type: "set_item_status", itemId: 1, status: "Invalid" as Item["status"] }),
    ).toThrow("unknown variant `Invalid`, expected one of `Inbox`, `Active`, `Waiting`, `Done`");
    expect(() =>
      decide(state, {
        type: "set_item_relation",
        fromItemId: 1,
        toItemId: 2,
        kind: "blocks" as "Blocks",
      }),
    ).toThrow("unknown variant `blocks`, expected one of `Blocks`, `BlockedBy` or `RelatedTo`");
  });

  it("projects due and Inbox Items into Home and searches text and Context", () => {
    const state = itemState();
    state.items.push(
      {
        id: 1,
        human_identifier: "I-1",
        title: "Write parser",
        project_id: 1,
        status: "Active",
        notes: "Rust migration",
        reminders: [{ id: 1, remind_at: "2026-09-29T00:00:00Z" }],
      },
      {
        id: 2,
        human_identifier: "I-2",
        title: "Inbox work",
        project_id: 1,
        status: "Inbox",
        notes: "",
        reminders: [],
      },
      {
        id: 3,
        human_identifier: "I-3",
        title: "Done",
        project_id: 1,
        status: "Done",
        notes: "",
        reminders: [{ id: 2, remind_at: "2020-01-01T00:00:00Z" }],
      },
    );
    const home = homeView(state, 1, "2026-09-30T00:00:00Z");
    expect(home.due.map(({ item }) => item.id)).toEqual([1]);
    expect(home.needs_attention.map(({ item }) => item.id)).toEqual([1, 2]);
    expect(home.running.map(({ item }) => item.id)).toEqual([1]);
    expect(home.completed.map(({ item }) => item.id)).toEqual([3]);
    expect(searchItems(state, " RUST ", 1).map(({ item }) => item.id)).toEqual([1]);
    expect(searchItems(state, "personal").map(({ item }) => item.id)).toEqual([1, 2, 3]);
    const otherContext = { ...state.contexts[0], id: 2, name: "Work" };
    state.contexts.push(otherContext);
    state.projects.push({ ...state.projects[0], id: 2, context_id: 2, name: "Operations" });
    state.items.push({
      id: 4,
      human_identifier: "I-4",
      title: "Work item",
      project_id: 2,
      status: "Active",
      notes: "",
      reminders: [],
    });
    expect(searchItems(state, "", 2).map(({ item }) => item.id)).toEqual([4]);
  });

  it("keeps a Plan awaiting Go active in the Item projection", () => {
    const state = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as DomainState;
    const run = state.runs[0];
    run.execution_profile = "plan";
    run.plan_phase = "awaitingGo";
    run.state = "finished";
    const item = searchItems(state, "", null).find(({ item }) => item.id === run.item_id)!;
    expect(item.run_projections).toContainEqual({
      runId: run.id,
      status: "active",
      phase: "awaitingGo",
      continuations: { goPlan: true, grillActions: [], stop: true, finish: true, delete: false },
    });
    expect(item.run_signals).toEqual({ grillWaiting: false, runActive: true });
  });
});
