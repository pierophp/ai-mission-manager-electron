import { DomainError } from "./error";
import type { MachineTransport } from "./types";

/** Normalizes and validates the persisted Machine transport shape. */
export function cleanMachineTransport(transport: MachineTransport): MachineTransport {
  if (transport.kind === "local") return { kind: "local" };
  const host = transport.host.trim();
  if (!host) throw new DomainError("a remote Machine host cannot be blank");
  if (![...host].every((character) => /[A-Za-z0-9.@:_-]/.test(character)))
    throw new DomainError("a remote Machine host contains unsupported characters");
  const user = transport.user?.trim() || null;
  if (transport.user !== null && !user)
    throw new DomainError("a remote Machine user cannot be blank");
  if (user && ![...user].every((character) => /[A-Za-z0-9._-]/.test(character)))
    throw new DomainError("a remote Machine user contains unsupported characters");
  if (
    transport.port !== null &&
    (!Number.isInteger(transport.port) || transport.port <= 0 || transport.port > 65535)
  )
    throw new DomainError("a remote Machine SSH port must be positive");
  const strictHostKeyChecking = transport.strictHostKeyChecking;
  if (
    strictHostKeyChecking !== null &&
    !["yes", "accept-new", "no"].includes(strictHostKeyChecking)
  )
    throw new DomainError("a remote Machine host-key checking mode is unsupported");
  return {
    kind: "ssh",
    host,
    user,
    port: transport.port,
    identityFile: transport.identityFile?.trim() || null,
    knownHostsFile: transport.knownHostsFile?.trim() || null,
    strictHostKeyChecking,
  };
}
