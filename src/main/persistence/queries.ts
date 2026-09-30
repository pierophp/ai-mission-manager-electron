import { DatabaseSync } from "node:sqlite";
import type {
  ActivityTabView,
  AuditEntry,
  CliProfileSettingsView,
  Context,
  ContextAttentionDefault,
  Item,
  Project,
  Repository,
  RepositoryLocation,
  Machine,
} from "../../renderer/runtime/types";
import { asNumber, asString, decodeAuditAction, rows } from "./codecs";
import { loadDomainState } from "./load-state";
import { signInCommand } from "./settings";

type Row = Record<string, unknown>;

export function listContexts(database: DatabaseSync): Context[] {
  return loadDomainState(database).contexts;
}
export function listProjects(database: DatabaseSync): Project[] {
  return loadDomainState(database).projects;
}
export function listRepositories(database: DatabaseSync): Repository[] {
  return loadDomainState(database).repositories;
}
export function listRepositoryLocations(database: DatabaseSync): RepositoryLocation[] {
  return loadDomainState(database).repository_locations;
}
export function listMachines(database: DatabaseSync): Machine[] {
  return loadDomainState(database).machines.map((machine) => ({ ...machine, readiness: null }));
}
export function listCliConfigurationProfiles(database: DatabaseSync): CliProfileSettingsView[] {
  return loadDomainState(database).cli_configuration_profiles.map((profile) => ({
    profile,
    signInCommand: profile.appManaged ? signInCommand(profile.provider, profile.directory) : null,
  }));
}
export function listContextAttentionDefaults(database: DatabaseSync): ContextAttentionDefault[] {
  return loadDomainState(database).attention_defaults;
}
export function listInboxItems(database: DatabaseSync): Item[] {
  return loadDomainState(database).items.filter((item) => item.status === "Inbox");
}
export function listAuditHistory(database: DatabaseSync): AuditEntry[] {
  return rows<Row>(
    database,
    "SELECT id,recorded_at,action_json FROM audit_entries ORDER BY id DESC LIMIT 200",
  ).map((row) => ({
    id: asNumber(row.id, "Audit id"),
    recorded_at: asNumber(row.recorded_at, "Audit timestamp"),
    action: decodeAuditAction(asString(row.action_json, "Audit action")) as AuditEntry["action"],
  }));
}
export function getActivityTab(database: DatabaseSync): ActivityTabView {
  const state = loadDomainState(database);
  const audit_entries = listAuditHistory(database);
  const byId = new Map(state.external_objects.map((object) => [object.id, object]));
  const activities = state.activities
    .slice()
    .reverse()
    .flatMap((activity) => {
      const object = byId.get(activity.external_object_id);
      return object ? [{ activity, object }] : [];
    });
  return { audit_entries, activities };
}
