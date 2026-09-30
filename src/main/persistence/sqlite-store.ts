import { DatabaseSync } from "node:sqlite";
import type {
  ActivityTabView,
  AuditEntry,
  CliProfileSettingsView,
  Context,
  ContextAttentionDefault,
  Item,
  Machine,
  Project,
  Repository,
  RepositoryLocation,
  SetupState,
} from "../../renderer/runtime/types";
import type { DomainState } from "../../domain/model";
import { loadDomainState } from "./load-state";
import {
  getActivityTab,
  listAuditHistory,
  listCliConfigurationProfiles,
  listContextAttentionDefaults,
  listContexts,
  listInboxItems,
  listMachines,
  listProjects,
  listRepositories,
  listRepositoryLocations,
} from "./queries";
import { openSqliteDatabase } from "./schema";
import { getSetupState, newContextConfiguration, readSetting } from "./settings";

export function openSqliteStore(databasePath?: string): SqliteStore {
  const { database, databasePath: path } = openSqliteDatabase(databasePath);
  return new SqliteStore(database, path);
}

/** Persistence facade consumed by the application layer. */
export class SqliteStore {
  constructor(
    private readonly database: DatabaseSync,
    readonly path: string,
  ) {}

  close(): void {
    this.database.close();
  }
  setting(key: string): string | null {
    return readSetting(this.database, key);
  }
  getSetupState(): SetupState {
    return getSetupState(this.database);
  }
  loadState(): DomainState {
    return loadDomainState(this.database);
  }
  listContexts(): Context[] {
    return listContexts(this.database);
  }
  listProjects(): Project[] {
    return listProjects(this.database);
  }
  listRepositories(): Repository[] {
    return listRepositories(this.database);
  }
  listRepositoryLocations(): RepositoryLocation[] {
    return listRepositoryLocations(this.database);
  }
  listMachines(): Machine[] {
    return listMachines(this.database);
  }
  listCliConfigurationProfiles(): CliProfileSettingsView[] {
    return listCliConfigurationProfiles(this.database);
  }
  listContextAttentionDefaults(): ContextAttentionDefault[] {
    return listContextAttentionDefaults(this.database);
  }
  listInboxItems(): Item[] {
    return listInboxItems(this.database);
  }
  listAuditHistory(): AuditEntry[] {
    return listAuditHistory(this.database);
  }
  getActivityTab(): ActivityTabView {
    return getActivityTab(this.database);
  }
}

export { newContextConfiguration };
