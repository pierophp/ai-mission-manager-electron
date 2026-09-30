import { homeView, searchItems } from "../domain/projections";
import type { Event } from "../domain/events";
import type { Item, ItemRelation } from "../domain/types";
import type { Runtime } from "./runtime";

export function createWorkCommandHandlers(runtime: Runtime) {
  const updateItem = (event: Event, itemId: number): Item => {
    const state = runtime.dispatch(event);
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Item ${itemId} does not exist`);
    return item;
  };
  return {
    get_home: (args: Record<string, unknown>) =>
      homeView(
        runtime.snapshot(),
        args.contextId == null ? null : Number(args.contextId),
        String(args.now ?? ""),
      ),
    search_items_command: (args: Record<string, unknown>) =>
      searchItems(
        runtime.snapshot(),
        String(args.query ?? ""),
        args.contextId == null ? null : Number(args.contextId),
      ),
    create_item: (args: Record<string, unknown>) => {
      const id = runtime.snapshot().next_item_id;
      const state = runtime.dispatch({
        type: "create_item",
        title: String(args.title ?? ""),
        contextId: Number(args.contextId),
        projectId: Number(args.projectId),
        notes: String(args.notes ?? ""),
      });
      return state.items.find((item) => item.id === id)!;
    },
    set_item_status: (args: Record<string, unknown>) =>
      updateItem(
        {
          type: "set_item_status",
          itemId: Number(args.itemId),
          status: String(args.status) as Item["status"],
        },
        Number(args.itemId),
      ),
    set_item_title: (args: Record<string, unknown>) =>
      updateItem(
        { type: "set_item_title", itemId: Number(args.itemId), title: String(args.title ?? "") },
        Number(args.itemId),
      ),
    set_item_notes: (args: Record<string, unknown>) =>
      updateItem(
        { type: "set_item_notes", itemId: Number(args.itemId), notes: String(args.notes ?? "") },
        Number(args.itemId),
      ),
    add_item_reminder: (args: Record<string, unknown>) =>
      updateItem(
        {
          type: "add_item_reminder",
          itemId: Number(args.itemId),
          remindAt: String(args.remindAt ?? ""),
        },
        Number(args.itemId),
      ),
    remove_item_reminder: (args: Record<string, unknown>) =>
      updateItem(
        {
          type: "remove_item_reminder",
          itemId: Number(args.itemId),
          reminderId: Number(args.reminderId),
        },
        Number(args.itemId),
      ),
    set_item_relation: (args: Record<string, unknown>): ItemRelation => {
      const event: Event = {
        type: "set_item_relation",
        fromItemId: Number(args.fromItemId),
        toItemId: Number(args.toItemId),
        kind: String(args.kind) as ItemRelation["kind"],
      };
      const state = runtime.dispatch(event);
      const relation = state.relationships.at(-1);
      if (!relation) throw new Error("Item relationship produced no relationship");
      return relation;
    },
  };
}
