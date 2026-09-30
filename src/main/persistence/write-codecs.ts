import type { Context } from "../../domain/types";
import type { MachineTransport } from "../../domain/types";
import type { ItemRelation } from "../../domain/types";
import type { Activity, ExternalMetadata } from "../../domain/types";

/** Serializes the Rust internally-tagged enum and variant fields in declaration order. */
export function encodeMachineTransport(transport: MachineTransport): string {
  if (transport.kind === "local") return JSON.stringify({ kind: "local" });
  return JSON.stringify({
    kind: "ssh",
    host: transport.host,
    user: transport.user,
    port: transport.port,
    identity_file: transport.identityFile,
    known_hosts_file: transport.knownHostsFile,
    strict_host_key_checking: transport.strictHostKeyChecking,
  });
}

/** Serializes the Rust PstackRoleTable JSON shape in struct declaration order. */
export function encodePstackRoleTable(context: Context): string {
  return JSON.stringify(
    (context.pstack_roles ?? []).map(({ role, configuration }) => ({
      role,
      configuration: {
        agent: configuration.agent,
        model: configuration.model,
        effort: configuration.effort,
      },
    })),
  );
}

/** Serializes the Rust AuditAction tagged enum shape for ContextCreated. */
export function encodeContextCreatedAudit(contextId: number): string {
  return JSON.stringify({ action: "contextCreated", context_id: contextId });
}

export function encodeProjectCreatedAudit(projectId: number): string {
  return JSON.stringify({ action: "projectCreated", project_id: projectId });
}

export function encodeRepositoryRegisteredAudit(repositoryId: number): string {
  return JSON.stringify({ action: "repositoryRegistered", repository_id: repositoryId });
}

/** Keeps Rust's enum name casing in audit JSON while SQLite uses snake_case. */
export function encodeItemRelationChangedAudit(relation: ItemRelation): string {
  return JSON.stringify({
    action: "itemRelationChanged",
    from_item_id: relation.from_item_id,
    to_item_id: relation.to_item_id,
    kind: relation.kind,
  });
}

/** Rust ExternalMetadata and ExternalChange are compact struct JSON in field declaration order. */
export function encodeExternalMetadata(metadata: ExternalMetadata[]): string {
  return JSON.stringify(metadata.map(({ key, value }) => ({ key, value })));
}

export function encodeExternalChanges(activity: Activity): string {
  return JSON.stringify(
    activity.changes.map(({ kind, key, previous, current }) => ({ kind, key, previous, current })),
  );
}
