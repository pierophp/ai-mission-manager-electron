import { contextBridge, ipcRenderer } from "electron";
import { EVENT_CHANNEL, eventNames, INVOKE_CHANNEL, type CommandEnvelope, type DesktopEventName } from "./shared/ipc";

const desktop = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  invoke: <T>(name: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke(INVOKE_CHANNEL, name, args) as Promise<CommandEnvelope<T>>,
  listen: <T>(name: DesktopEventName, handler: (event: { payload: T }) => void) => {
    if (!eventNames.includes(name)) throw new Error(`evento não permitido: ${name}`);
    const listener = (_event: Electron.IpcRendererEvent, eventName: DesktopEventName, payload: T) => {
      if (eventName === name) handler({ payload });
    };
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },
  openDirectoryDialog: (options?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke("desktop:open-directory-dialog", options) as Promise<string | null>,
  revealItemInDir: (filePath: string) => ipcRenderer.invoke("desktop:reveal-item-in-dir", filePath) as Promise<void>,
  openUrl: (url: string) => ipcRenderer.invoke("desktop:open-url", url) as Promise<void>,
};

contextBridge.exposeInMainWorld("desktop", desktop);

export type DesktopApi = typeof desktop;
