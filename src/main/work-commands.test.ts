import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandDispatcher, invokeEnvelope } from "../shared/ipc";
import { Runtime } from "./runtime";
import { createWorkCommandHandlers } from "./work-commands";
import { openSqliteStore } from "./persistence/sqlite-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Item, Home and search commands", () => {
  it("dispatches compatible commands and persists Items, title, reminders and relation casing", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-items-"));
    directories.push(directory);
    const file = path.join(directory, "mission-manager.sqlite");
    const store = openSqliteStore(file);
    const runtime = new Runtime(store);
    const dispatch = createCommandDispatcher(createWorkCommandHandlers(runtime));

    const first = (await invokeEnvelope(dispatch, "create_item", {
      title: "Search persistence",
      contextId: 1,
      projectId: 1,
      notes: "Findable note",
    })) as { id: number; human_identifier: string };
    const second = (await invokeEnvelope(dispatch, "create_item", {
      title: "Second Item",
      contextId: 1,
      projectId: 1,
      notes: "",
    })) as { id: number };
    expect(first).toMatchObject({ id: 1, human_identifier: "I-1" });

    await invokeEnvelope(dispatch, "set_item_title", {
      itemId: first.id,
      title: "Persisted title",
    });
    await invokeEnvelope(dispatch, "set_item_status", { itemId: first.id, status: "Active" });
    await invokeEnvelope(dispatch, "add_item_reminder", {
      itemId: first.id,
      remindAt: "2026-09-29T00:00:00Z",
    });
    const relation = await invokeEnvelope(dispatch, "set_item_relation", {
      fromItemId: first.id,
      toItemId: second.id,
      kind: "Blocks",
    });
    expect(relation).toMatchObject({ kind: "Blocks" });

    const home = (await invokeEnvelope(dispatch, "get_home", {
      contextId: 1,
      now: "2026-09-30T00:00:00Z",
    })) as {
      due: { item: { id: number } }[];
    };
    expect(home.due.map(({ item }) => item.id)).toEqual([first.id]);
    const found = (await invokeEnvelope(dispatch, "search_items_command", {
      query: "findable",
      contextId: 1,
    })) as { item: { id: number } }[];
    expect(found.map(({ item }) => item.id)).toEqual([first.id]);

    const raw = new DatabaseSync(file, { readOnly: true });
    expect(raw.prepare("SELECT title FROM items WHERE id=?").get(first.id)).toEqual({
      title: "Persisted title",
    });
    expect(raw.prepare("SELECT kind FROM item_relationships").get()).toEqual({ kind: "blocks" });
    expect(
      raw.prepare("SELECT action_json FROM audit_entries ORDER BY id DESC LIMIT 1").get(),
    ).toEqual({
      action_json:
        '{"action":"itemRelationChanged","from_item_id":1,"to_item_id":2,"kind":"Blocks"}',
    });
    expect(raw.prepare("SELECT remind_at FROM reminders WHERE item_id=?").get(first.id)).toEqual({
      remind_at: "2026-09-29T00:00:00Z",
    });
    raw.close();
    store.close();

    const reopened = openSqliteStore(file);
    expect(reopened.loadState().items.find(({ id }) => id === first.id)).toMatchObject({
      title: "Persisted title",
      status: "Active",
      reminders: [{ id: 1, remind_at: "2026-09-29T00:00:00Z" }],
    });
    reopened.close();
  });
});
