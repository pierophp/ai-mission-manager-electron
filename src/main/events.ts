import { BrowserWindow } from "electron";
import { EVENT_CHANNEL, type DesktopEventName } from "../shared/ipc";

export function emitDesktopEvent(name: DesktopEventName, payload?: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, name, payload);
  }
}
