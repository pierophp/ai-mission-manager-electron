import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decide } from "../domain/state-transition";
import type { DomainState } from "../domain/model";
import { newContextConfiguration } from "./persistence/sqlite-store";

const emptyState = (): DomainState => ({
  next_context_id: 2,
  next_project_id: 2,
  next_item_id: 1,
  next_item_number: 1,
  next_repository_id: 1,
  next_workspace_id: 1,
  next_worktree_id: 1,
  next_machine_id: 1,
  next_cli_profile_id: 1,
  next_run_id: 1,
  next_external_object_id: 1,
  next_link_id: 1,
  next_activity_id: 1,
  next_reminder_id: 1,
  contexts: [
    {
      id: 1,
      name: "Personal",
      grill_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      implement_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      pstack_defaults: { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      pstack_roles: [],
    },
  ],
  projects: [],
  repositories: [],
  repository_locations: [],
  items: [],
  workspaces: [],
  worktrees: [],
  machines: [],
  cli_configuration_profiles: [],
  runs: [],
  implementation_queues: [],
  relationships: [],
  external_objects: [],
  links: [],
  snapshots: [],
  activities: [],
  attention_defaults: [],
});

describe("Context decisions", () => {
  it("creates a Context and its Default Project from the metadata sequences", () => {
    const decision = decide(emptyState(), { type: "create_context", name: "  Research  " });
    expect(decision.state.contexts.at(-1)).toMatchObject({ id: 2, name: "Research" });
    expect(decision.state.projects.at(-1)).toMatchObject({ id: 2, context_id: 2, name: "Default" });
    expect(decision.state.next_context_id).toBe(3);
    expect(decision.state.next_project_id).toBe(3);
    expect(decision.effects.map(({ type }) => type)).toEqual([
      "persist_context",
      "persist_project",
    ]);
  });

  it("applies a full configuration and defaults to the selected Context", () => {
    const config = newContextConfiguration();
    config.name = "Research";
    config.attentionDefaults = config.attentionDefaults.filter(
      (entry) => entry.object_kind !== "document",
    );
    const decision = decide(emptyState(), {
      type: "create_context_configuration",
      configuration: config,
    });
    expect(decision.state.contexts.at(-1)?.name).toBe("Research");
    expect(decision.state.attention_defaults).toHaveLength(3);
    expect(decision.effects.map(({ type }) => type)).toEqual([
      "persist_context",
      "persist_project",
      "persist_context_configuration",
    ]);
  });

  it("rejects duplicate and blank names without changing the input state", () => {
    const before = emptyState();
    expect(() => decide(before, { type: "create_context", name: "Personal" })).toThrow(
      "Context name already exists: Personal",
    );
    expect(() => decide(before, { type: "update_context", contextId: 1, name: "  " })).toThrow(
      "a Context name cannot be blank",
    );
    expect(before.contexts[0].name).toBe("Personal");
  });
  it("validates and emits dedicated defaults effects", () => {
    const defaults = { agent: "claude" as const, model: "claude-opus-5", effort: "high" };
    expect(
      decide(emptyState(), { type: "set_context_grill_defaults", contextId: 1, defaults }).effects,
    ).toEqual([{ type: "persist_context_grill_defaults", contextId: 1, defaults }]);
    expect(
      decide(emptyState(), { type: "set_context_implement_defaults", contextId: 1, defaults })
        .effects,
    ).toEqual([{ type: "persist_context_implement_defaults", contextId: 1, defaults }]);
    expect(() =>
      decide(emptyState(), {
        type: "set_context_grill_defaults",
        contextId: 1,
        defaults: { ...defaults, model: "unsupported" },
      }),
    ).toThrow("Grill configuration is invalid");
  });

  it("preserves the Document attention default while applying the three Rust configuration policies", () => {
    const before = emptyState();
    before.attention_defaults = [
      {
        context_id: 1,
        object_kind: "document",
        policy: { title: true, state: false, metadata: true },
      },
    ];
    const configuration = newContextConfiguration();
    configuration.name = "Personal";
    configuration.attentionDefaults = configuration.attentionDefaults
      .filter((entry) => entry.object_kind !== "document")
      .map((entry) => ({ ...entry, context_id: 1 }));
    const decision = decide(before, {
      type: "update_context_configuration",
      contextId: 1,
      configuration,
    });
    expect(decision.state.attention_defaults).toContainEqual(before.attention_defaults[0]);
    expect(decision.effects).toHaveLength(1);
    expect(decision.effects[0].type).toBe("persist_context_configuration");
  });

  it("blocks a configuration edit that moves a Context with an active Run", () => {
    const fixture = JSON.parse(
      readFileSync("src/main/persistence/fixtures/domain-state.json", "utf8"),
    ) as DomainState;
    const configuration = newContextConfiguration();
    configuration.name = fixture.contexts[0].name;
    configuration.executionMachineId = fixture.machines[0].id;
    configuration.attentionDefaults = configuration.attentionDefaults
      .filter((entry) => entry.object_kind !== "document")
      .map((entry) => ({ ...entry, context_id: fixture.contexts[0].id }));
    expect(() =>
      decide(fixture, {
        type: "update_context_configuration",
        contextId: fixture.contexts[0].id,
        configuration,
      }),
    ).toThrow("has active Runs");
  });

  it("updates the complete Context configuration as one effect", () => {
    const configuration = newContextConfiguration();
    configuration.name = " Renamed Context ";
    configuration.checkDirtyCheckouts = false;
    configuration.grillDefaults = { agent: "codex", model: "gpt-6-sol", effort: "high" };
    configuration.implementDefaults = {
      agent: "claude",
      model: "claude-sonnet-4-5",
      effort: "medium",
    };
    configuration.attentionDefaults = configuration.attentionDefaults
      .filter((entry) => entry.object_kind !== "document")
      .map((entry) => ({ ...entry, context_id: 1 }));
    configuration.attentionDefaults[0] = {
      ...configuration.attentionDefaults[0],
      policy: { title: true, state: false, metadata: true },
    };
    const decision = decide(emptyState(), {
      type: "update_context_configuration",
      contextId: 1,
      configuration,
    });
    expect(decision.state.contexts[0]).toMatchObject({
      name: "Renamed Context",
      check_dirty_checkouts: false,
      grill_defaults: configuration.grillDefaults,
      implement_defaults: configuration.implementDefaults,
    });
    expect(decision.effects.map(({ type }) => type)).toEqual(["persist_context_configuration"]);
  });

  it("rejects unsupported models and provider profiles that do not match", () => {
    const invalidModel = newContextConfiguration();
    invalidModel.name = "Research";
    invalidModel.grillDefaults = { agent: "claude", model: "unsupported-model", effort: "high" };
    invalidModel.attentionDefaults = invalidModel.attentionDefaults.filter(
      (entry) => entry.object_kind !== "document",
    );
    expect(() =>
      decide(emptyState(), { type: "create_context_configuration", configuration: invalidModel }),
    ).toThrow("Grill configuration is invalid");

    const state = emptyState();
    state.machines.push({
      id: 7,
      context_id: 1,
      name: "Build",
      socket_name: "mission",
      transport: { kind: "local" },
      last_observed: "unknown",
      last_observed_at: null,
    });
    state.cli_configuration_profiles.push({
      id: 3,
      machineId: 7,
      provider: "claude",
      name: "default",
      directory: "/profiles/claude",
      appManaged: false,
    });
    const configuration = newContextConfiguration();
    configuration.name = "Personal";
    configuration.executionMachineId = 7;
    configuration.codexProfileId = 3;
    configuration.attentionDefaults = configuration.attentionDefaults
      .filter((entry) => entry.object_kind !== "document")
      .map((entry) => ({ ...entry, context_id: 1 }));
    expect(() =>
      decide(state, { type: "update_context_configuration", contextId: 1, configuration }),
    ).toThrow("is for claude, not codex");
  });
});
