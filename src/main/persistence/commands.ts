import type {
  ActivityTabView,
  AuditEntry,
  Context,
  ContextAttentionDefault,
  ContextConfiguration,
  Item,
  Project,
  Repository,
  RepositoryLocation,
  SetupState,
} from "../../renderer/runtime/types";
import { newContextConfiguration, type SqliteStore } from "./sqlite-store";

export function createReadCommandHandlers(store: SqliteStore) {
  return {
    get_setup_state: (): SetupState => store.getSetupState(),
    list_contexts: (): Context[] => store.listContexts(),
    list_projects: (): Project[] => store.listProjects(),
    list_repositories: (): Repository[] => store.listRepositories(),
    list_repository_locations: (): RepositoryLocation[] => store.listRepositoryLocations(),
    list_machines: () => store.listMachines(),
    list_cli_configuration_profiles: () => store.listCliConfigurationProfiles(),
    list_context_attention_defaults: (): ContextAttentionDefault[] =>
      store.listContextAttentionDefaults(),
    new_context_configuration: (): ContextConfiguration => newContextConfiguration(),
    list_inbox_items: (): Item[] => store.listInboxItems(),
    list_audit_history: (): AuditEntry[] => store.listAuditHistory(),
    get_activity_tab: (): ActivityTabView => store.getActivityTab(),
  };
}
