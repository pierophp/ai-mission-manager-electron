import type { Context } from "../../domain/types";

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
