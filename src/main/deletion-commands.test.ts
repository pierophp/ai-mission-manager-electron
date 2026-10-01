import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandDispatcher, invokeEnvelope } from "../shared/ipc";
import { Runtime } from "./runtime";
import { openSqliteStore } from "./persistence/sqlite-store";
import { FakeMachineAccess } from "./machine-access";
import { createDeletionCommandHandlers } from "./deletion-commands";
import type { Run } from "../domain/execution-types";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "mission-manager-deletion-"));
  directories.push(directory);
  const store = openSqliteStore(path.join(directory, "mission-manager.sqlite"));
  const runtime = new Runtime(store);
  const dispatch = createCommandDispatcher(
    createDeletionCommandHandlers(runtime, new FakeMachineAccess()),
  );
  return { store, runtime, dispatch };
}

describe("deletion commands", () => {
  it("previews item dependencies, rejects stale confirmation, then deletes every local row", async () => {
    const { store, runtime, dispatch } = setup();
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Remove me",
      notes: "",
    });
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Linked item",
      notes: "",
    });
    runtime.dispatch({
      type: "link_external_object",
      itemId: 1,
      object: {
        provider: "generic",
        kind: "generic",
        external_key: "local:file",
        canonical_url: "file:///tmp/file.md",
      },
      snapshot: { title: "file", state: "local", metadata: [], fetched_at: 1 },
    });
    runtime.dispatch({ type: "set_item_relation", fromItemId: 1, toItemId: 2, kind: "Blocks" });
    const preview = (await invokeEnvelope(dispatch, "prepare_item_deletion", { itemId: 1 })) as {
      plan: {
        reminderCount: number;
        relationshipCount: number;
        workspaceCount?: number;
        linkIds: number[];
        orphanedExternalObjectIds: number[];
      };
      blockers: string[];
    };
    expect(preview.plan).toMatchObject({
      reminderCount: 0,
      relationshipCount: 1,
      linkIds: [1],
      orphanedExternalObjectIds: [1],
    });
    expect(preview.plan).not.toHaveProperty("stateFingerprint");
    expect(preview.blockers).toEqual([]);
    runtime.dispatch({ type: "set_item_title", itemId: 2, title: "changed after review" });
    await expect(
      invokeEnvelope(dispatch, "delete_item", { itemId: 1, confirmed: true }),
    ).rejects.toBe("The Item changed after the preview; review the updated deletion preview");

    await invokeEnvelope(dispatch, "prepare_item_deletion", { itemId: 1 });
    const result = await invokeEnvelope(dispatch, "delete_item", { itemId: 1, confirmed: true });
    expect(result).toMatchObject({
      summary: { itemId: 1, relationshipCount: 1, linkCount: 1, externalObjectCount: 1 },
    });
    expect(store.loadState().items.map(({ id }) => id)).toEqual([2]);
    expect(store.loadState().relationships).toEqual([]);
    expect(store.loadState().links).toEqual([]);
    expect(store.loadState().external_objects).toEqual([]);
    const raw = new DatabaseSync(store.path, { readOnly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM reminders WHERE item_id=1").get()).toEqual({
      count: 0,
    });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM external_snapshots").get()).toEqual({
      count: 0,
    });
    raw.close();
    store.close();
  });

  it("deletes a Project using the reviewed selection and preserves shared external objects", async () => {
    const { store, runtime, dispatch } = setup();
    runtime.dispatch({ type: "create_context", name: "Other" });
    runtime.dispatch({
      type: "create_item",
      contextId: 2,
      projectId: 2,
      title: "Ticket",
      notes: "",
    });
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Shared",
      notes: "",
    });
    const object = {
      provider: "generic" as const,
      kind: "generic" as const,
      external_key: "shared",
      canonical_url: "https://example.test/shared",
    };
    runtime.dispatch({ type: "link_external_object", itemId: 2, object, snapshot: null });
    runtime.dispatch({ type: "link_external_object", itemId: 1, object, snapshot: null });
    const preview = (await invokeEnvelope(dispatch, "prepare_project_deletion", {
      projectId: 2,
    })) as {
      plan: {
        items: { id: number }[];
        repositories: { id: number }[];
        workspaces: { id: number }[];
        orphanedExternalObjectIds: number[];
      };
    };
    expect(preview.plan.orphanedExternalObjectIds).toEqual([]);
    const result = await invokeEnvelope(dispatch, "delete_project", {
      projectId: 2,
      itemIds: [1],
      repositoryIds: [],
      workspaceIds: [],
      confirmed: true,
    });
    expect(result).toMatchObject({
      summary: {
        contextId: null,
        projectId: 2,
        itemCount: 1,
        linkCount: 1,
        externalObjectCount: 0,
      },
    });
    expect(store.loadState().projects.map(({ id }) => id)).toEqual([1]);
    expect(store.loadState().external_objects).toHaveLength(1);
    expect(store.loadState().links.map(({ item_id }) => item_id)).toEqual([2]);
    store.close();
  });

  it("deletes a Context using all reviewed ids and rejects deletion of the last Context", async () => {
    const { store, runtime, dispatch } = setup();
    const last = (await invokeEnvelope(dispatch, "prepare_context_deletion", { contextId: 1 })) as {
      blockers: string[];
    };
    expect(last.blockers).toContain(
      "This is the last Context; create another Context before deleting it.",
    );
    await expect(
      invokeEnvelope(dispatch, "delete_context", {
        contextId: 1,
        projectIds: [1],
        itemIds: [],
        repositoryIds: [],
        workspaceIds: [],
        machineIds: [],
        confirmed: true,
      }),
    ).rejects.toBe(
      "Context deletion is blocked:\nThis is the last Context; create another Context before deleting it.",
    );
    runtime.dispatch({ type: "create_context", name: "Disposable" });
    runtime.dispatch({
      type: "register_machine",
      contextId: 2,
      name: "shared execution target",
      socketName: "shared-target",
      transport: { kind: "local" },
    });
    runtime.dispatch({
      type: "create_cli_configuration_profile",
      machineId: 1,
      provider: "claude",
      name: "shared profile",
      directory: "~/.claude",
      appManaged: false,
    });
    runtime.dispatch({ type: "set_context_execution_machine", contextId: 1, machineId: 1 });
    runtime.dispatch({
      type: "set_context_cli_configuration_profile",
      contextId: 1,
      provider: "claude",
      profileId: 1,
    });
    runtime.dispatch({
      type: "create_item",
      contextId: 2,
      projectId: 2,
      title: "Context item",
      notes: "",
    });
    const preview = (await invokeEnvelope(dispatch, "prepare_context_deletion", {
      contextId: 2,
    })) as {
      plan: {
        projects: { id: number }[];
        items: { id: number }[];
        repositories: { id: number }[];
        workspaces: { id: number }[];
        machines: { id: number }[];
      };
    };
    const result = await invokeEnvelope(dispatch, "delete_context", {
      contextId: 2,
      projectIds: preview.plan.projects.map(({ id }) => id),
      itemIds: preview.plan.items.map(({ id }) => id),
      repositoryIds: [],
      workspaceIds: [],
      machineIds: preview.plan.machines.map(({ id }) => id),
      confirmed: true,
    });
    expect(result).toMatchObject({ summary: { contextId: 2, projectCount: 1, itemCount: 1 } });
    expect(store.loadState().contexts).toMatchObject([
      { id: 1, execution_machine_id: null, claude_profile_id: null, codex_profile_id: null },
    ]);
    expect(store.loadState().items).toEqual([]);
    expect(store.loadState().machines).toEqual([]);
    expect(store.loadState().cli_configuration_profiles).toEqual([]);
    store.close();
  });

  it("deletes a Repository without deleting its Item Workspace or other Repository selection", async () => {
    const { store, runtime, dispatch } = setup();
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Keep workspace",
      notes: "",
    });
    runtime.dispatch({
      type: "register_repository",
      projectId: 1,
      name: "remove",
      remoteUrl: "https://example.test/remove.git",
    });
    runtime.dispatch({
      type: "register_repository",
      projectId: 1,
      name: "keep",
      remoteUrl: "https://example.test/keep.git",
    });
    const preview = (await invokeEnvelope(dispatch, "prepare_repository_deletion", {
      repositoryId: 1,
    })) as { plan: { workspaces: { id: number }[] }; blockers: string[] };
    expect(preview).toMatchObject({ blockers: [], plan: { workspaces: [{ id: 1 }] } });
    await invokeEnvelope(dispatch, "delete_repository", {
      repositoryId: 1,
      workspaceIds: [1],
      confirmed: true,
    });

    const state = store.loadState();
    expect(state.repositories.map(({ id }) => id)).toEqual([2]);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].repositories.map(({ repositoryId }) => repositoryId)).toEqual([2]);
    const raw = new DatabaseSync(store.path, { readOnly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT repository_id FROM workspace_repositories").all()).toEqual([
      { repository_id: 2 },
    ]);
    raw.close();
    store.close();
  });

  it("unlinks one Item while retaining a shared object, then locally deletes the object", async () => {
    const { store, runtime, dispatch } = setup();
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Second",
      notes: "",
    });
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Third",
      notes: "",
    });
    const object = {
      provider: "generic" as const,
      kind: "generic" as const,
      external_key: "shared",
      canonical_url: "https://example.test/shared",
    };
    runtime.dispatch({
      type: "link_external_object",
      itemId: 1,
      object,
      snapshot: { title: "Shared", state: "open", metadata: [], fetched_at: 10 },
    });
    runtime.dispatch({ type: "link_external_object", itemId: 2, object, snapshot: null });
    const unlinked = await invokeEnvelope(dispatch, "unlink_external_link", {
      linkId: 1,
      confirmed: true,
    });
    expect(unlinked).toMatchObject({
      linkId: 1,
      externalObjectId: 1,
      externalObjectDeleted: false,
    });
    expect(store.loadState().external_objects).toHaveLength(1);
    const preview = (await invokeEnvelope(dispatch, "prepare_external_object_deletion", {
      externalObjectId: 1,
    })) as { plan: { linkIds: number[]; snapshotCount: number; activityCount: number } };
    expect(preview.plan).toMatchObject({ linkIds: [2], snapshotCount: 1, activityCount: 0 });
    const result = await invokeEnvelope(dispatch, "delete_external_object", {
      externalObjectId: 1,
      confirmed: true,
    });
    expect(result).toMatchObject({
      summary: { externalObjectId: 1, linkCount: 1, snapshotCount: 1 },
    });
    expect(store.loadState().external_objects).toEqual([]);
    expect(store.loadState().links).toEqual([]);
    store.close();
  });

  it("requires the exact reset phrase and replaces all app data with fresh Personal/Default rows", async () => {
    const { store, runtime, dispatch } = setup();
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Reset me",
      notes: "",
    });
    const preview = (await invokeEnvelope(dispatch, "prepare_reset_local_data")) as {
      plan: {
        summary: { contextCount: number; itemCount: number };
        affectedRecords: { kind: string }[];
      };
      confirmationPhrase: string;
    };
    expect(preview.plan.summary).toMatchObject({ contextCount: 1, itemCount: 1 });
    expect(preview.plan.affectedRecords.map(({ kind }) => kind)).toContain("Item");
    await expect(
      invokeEnvelope(dispatch, "reset_all_local_data", { confirmation: "reset all local data" }),
    ).rejects.toBe("Reset requires the exact confirmation phrase: RESET ALL LOCAL DATA");
    runtime.dispatch({ type: "set_item_title", itemId: 1, title: "changed after reset preview" });
    await expect(
      invokeEnvelope(dispatch, "reset_all_local_data", {
        confirmation: preview.confirmationPhrase,
      }),
    ).rejects.toBe(
      "The local model changed after the reset preview; review the updated preview before resetting local data",
    );
    const updatedPreview = (await invokeEnvelope(dispatch, "prepare_reset_local_data")) as {
      confirmationPhrase: string;
    };
    const rawForAudit = new DatabaseSync(store.path);
    const nextAuditId = Number(
      rawForAudit.prepare("SELECT value FROM metadata WHERE key='next_audit_id'").get()?.value,
    );
    rawForAudit
      .prepare("INSERT INTO audit_entries(id,recorded_at,action_json) VALUES(?,?,?)")
      .run(nextAuditId, 1, "{}");
    rawForAudit.close();
    await expect(
      invokeEnvelope(dispatch, "reset_all_local_data", {
        confirmation: updatedPreview.confirmationPhrase,
      }),
    ).rejects.toBe(
      "The local model changed after the reset preview; review the updated preview before resetting local data",
    );
    await invokeEnvelope(dispatch, "prepare_reset_local_data");
    const result = await invokeEnvelope(dispatch, "reset_all_local_data", {
      confirmation: preview.confirmationPhrase,
    });
    expect(result).toMatchObject({ summary: { contextCount: 1, projectCount: 1, itemCount: 1 } });
    expect(store.loadState().contexts.map(({ name }) => name)).toEqual(["Personal"]);
    expect(store.loadState().projects.map(({ name }) => name)).toEqual(["Default"]);
    expect(store.loadState().items).toEqual([]);
    const raw = new DatabaseSync(store.path, { readOnly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM audit_entries").get()).toEqual({ count: 0 });
    raw.close();
    store.close();
  });

  it("reports active Runs and blocks deletion until they are finished", async () => {
    const { store, runtime } = setup();
    runtime.dispatch({
      type: "create_item",
      contextId: 1,
      projectId: 1,
      title: "Active",
      notes: "",
    });
    const state = runtime.snapshot();
    const activeRun: Run = {
      id: 1,
      item_id: 1,
      workspace_id: null,
      repository_id: null,
      worktree_id: null,
      machine_id: 1,
      agent: "claude",
      cli_configuration_profile: null,
      execution_profile: "implement",
      workflow: "matt-pocock",
      model: null,
      effort: null,
      skill_snapshot: null,
      prompt: "",
      working_directory: "",
      session_name: "",
      pane_id: "",
      started_at: 1,
      state: "working",
      pane_status: "missing",
      direct_checkouts: [],
      transcript: "",
      reported_pull_requests: [],
      attention_summary: null,
      grill_question_group: null,
      grill_answers: [],
      grill_decisions: [],
      grill_response: null,
      grill_phase: null,
      grill_action: null,
      plan_phase: null,
      plan_path: null,
    };
    state.runs.push(activeRun);
    const runtimeWithRun = new Runtime(store, state);
    const dispatch = createCommandDispatcher(
      createDeletionCommandHandlers(runtimeWithRun, new FakeMachineAccess()),
    );
    await expect(
      invokeEnvelope(dispatch, "prepare_item_deletion", { itemId: 1 }),
    ).resolves.toMatchObject({
      plan: { runIds: [1], activeRunIds: [1] },
      blockers: ["Run #1 is active; stop it before deleting this Item."],
    });
    await expect(
      invokeEnvelope(dispatch, "delete_item", { itemId: 1, confirmed: true }),
    ).rejects.toBe(
      "Item deletion is blocked:\nRun #1 is active; stop it before deleting this Item.",
    );
    store.close();
  });
});
