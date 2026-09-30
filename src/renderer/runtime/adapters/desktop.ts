import type { DesktopEventName } from "../../../shared/ipc";

export function listen<T>(name: DesktopEventName, handler: (event: { payload: T }) => void) {
  return Promise.resolve(window.desktop.listen(name, handler));
}
