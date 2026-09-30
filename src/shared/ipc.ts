export const INVOKE_CHANNEL = "desktop:invoke";
export const EVENT_CHANNEL = "desktop:event";

export type CommandEnvelope<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const eventNames = [
  "terminal-output",
  "terminal-exit",
  "run-state-changed",
  "run-questions-changed",
] as const;

export type DesktopEventName = (typeof eventNames)[number];

export function createCommandDispatcher(
  handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {},
) {
  return async (name: string, args: Record<string, unknown> = {}): Promise<CommandEnvelope> => {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) return { ok: false, error: `não implementado: ${name}` };

    try {
      return { ok: true, value: await handler(args) };
    } catch (error) {
      return {
        ok: false,
        error: typeof error === "string" ? error : error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export async function invokeEnvelope<T>(
  invoke: (name: string, args?: Record<string, unknown>) => Promise<CommandEnvelope<T>>,
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const result = await invoke(name, args);
  if (result.ok) return result.value;
  throw result.error;
}
