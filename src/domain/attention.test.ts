import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decide } from "./state-transition";
import { homeView, itemViews } from "./projections";
import type { DomainState } from "./model";

function attentionState(): DomainState {
  const state = JSON.parse(
    readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
  ) as DomainState;
  state.next_item_id = 1;
  state.next_item_number = 1;
  state.next_external_object_id = 1;
  state.next_link_id = 1;
  state.next_activity_id = 1;
  state.items = [];
  state.links = [];
  state.external_objects = [];
  state.snapshots = [];
  state.activities = [];
  state.attention_defaults = [];
  state.projects = state.projects.slice(0, 1).map((project) => ({
    ...project,
    id: 1,
    context_id: state.contexts[0].id,
    defaults: { item_status: "Inbox", execution_mode: "worktree" },
  }));
  state.repositories = [];
  state.workspaces = [];
  state.worktrees = [];
  return state;
}

describe("Link attention domain transitions", () => {
  it("keeps policy, watch period, review schedule, and reviewed watermark on one Link", () => {
    let state = decide(attentionState(), {
      type: "create_item",
      title: "Review provider change",
      contextId: 1,
      projectId: 1,
      notes: "",
    }).state;
    state = decide(state, {
      type: "link_external_object",
      itemId: 1,
      object: {
        provider: "generic",
        kind: "generic",
        external_key: "provider-1",
        canonical_url: "https://example.com/provider-1",
      },
      snapshot: {
        title: "Initial title",
        state: "open",
        metadata: [{ key: "owner", value: "team" }],
        fetched_at: 1,
      },
    }).state;
    state = decide(state, {
      type: "refresh_external_object",
      externalObjectId: 1,
      snapshot: {
        title: "Updated title",
        state: "closed",
        metadata: [{ key: "owner", value: "team" }],
        fetched_at: 2,
      },
    }).state;

    expect(homeView(state, 1, "2026-09-20").attention_entries).toHaveLength(1);
    const policy = decide(state, {
      type: "set_link_attention_policy",
      linkId: 1,
      policy: { title: true, state: false, metadata: false },
    });
    state = policy.state;
    expect(itemViews(state, 1)[0].links[0].attention_policy).toEqual({
      title: true,
      state: false,
      metadata: false,
    });
    expect(policy.effects).toEqual([{ type: "persist_link_state", link: state.links[0] }]);

    state = decide(state, {
      type: "set_link_watch_until",
      linkId: 1,
      watchUntil: "2026-09-21",
    }).state;
    expect(homeView(state, 1, "2026-09-22").attention_entries).toEqual([]);
    state = decide(state, {
      type: "set_link_watch_until",
      linkId: 1,
      watchUntil: null,
    }).state;
    state = decide(state, {
      type: "set_link_review_at",
      linkId: 1,
      reviewAt: "2026-09-21T10:00",
    }).state;
    expect(homeView(state, 1, "2026-09-22").attention_entries).toContainEqual(
      expect.objectContaining({ kind: "review", link_id: 1 }),
    );
    state = decide(state, { type: "clear_link_review_at", linkId: 1 }).state;
    state = decide(state, { type: "mark_link_reviewed", linkId: 1 }).state;
    expect(state.links[0].reviewed_activity_id).toBe(1);
    expect(homeView(state, 1, "2026-09-22").attention_entries).toEqual([]);
  });

  it("validates Link purpose and only accepts a same-Item Spec for ticket Links", () => {
    let state = decide(attentionState(), {
      type: "create_item",
      title: "Set implementation purpose",
      contextId: 1,
      projectId: 1,
      notes: "",
    }).state;
    for (const [externalKey, url] of [
      ["spec", "https://github.com/acme/app/issues/1"],
      ["ticket", "https://github.com/acme/app/issues/2"],
    ])
      state = decide(state, {
        type: "link_external_object",
        itemId: 1,
        object: {
          provider: "github",
          kind: "issue",
          external_key: externalKey,
          canonical_url: url,
        },
        snapshot: null,
      }).state;
    state = decide(state, {
      type: "set_link_purpose",
      linkId: 1,
      purpose: "to-spec",
      specExternalObjectId: null,
    }).state;
    expect(
      decide(state, {
        type: "set_link_purpose",
        linkId: 2,
        purpose: "to-tickets",
        specExternalObjectId: 1,
      }).state.links[1],
    ).toMatchObject({ purpose: "to-tickets", spec_external_object_id: 1 });
    expect(() =>
      decide(state, {
        type: "set_link_purpose",
        linkId: 2,
        purpose: "to-tickets",
        specExternalObjectId: 99,
      }),
    ).toThrow("A ticket must reference a supported Spec on the same Item");

    const pullRequestState = decide(state, {
      type: "link_external_object",
      itemId: 1,
      object: {
        provider: "github",
        kind: "pull_request",
        external_key: "pull:acme/app#92",
        canonical_url: "https://github.com/acme/app/pull/92",
      },
      snapshot: null,
    }).state;
    expect(() =>
      decide(pullRequestState, {
        type: "set_link_purpose",
        linkId: 3,
        purpose: "to-spec",
        specExternalObjectId: null,
      }),
    ).toThrow("This External Object cannot have the Spec Link purpose");

    const azureState = decide(pullRequestState, {
      type: "link_external_object",
      itemId: 1,
      object: {
        provider: "azure_dev_ops",
        kind: "issue",
        external_key: "ado:acme/platform#17",
        canonical_url: "https://dev.azure.com/acme/platform/_workitems/edit/17",
      },
      snapshot: null,
    }).state;
    expect(() =>
      decide(azureState, {
        type: "set_link_purpose",
        linkId: 4,
        purpose: "to-spec",
        specExternalObjectId: null,
      }),
    ).toThrow("This External Object cannot have the Spec Link purpose");
    expect(() =>
      decide(azureState, {
        type: "set_link_purpose",
        linkId: 4,
        purpose: "to-tickets",
        specExternalObjectId: null,
      }),
    ).toThrow("This External Object cannot have the Tickets Link purpose");
  });
});
