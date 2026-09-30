import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createCommandDispatcher, INVOKE_CHANNEL } from "./shared/ipc";
import { createReadCommandHandlers } from "./main/persistence/commands";
import { createStructureCommandHandlers } from "./main/structure-commands";
import { createSetupCommandHandlers } from "./main/setup";
import { createWorkCommandHandlers } from "./main/work-commands";
import { Runtime } from "./main/runtime";
import { openSqliteStore, type SqliteStore } from "./main/persistence/sqlite-store";
import { ensureProjectWorkspaces, recoverRunStateRecords } from "./main/persistence/startup";

const execFileAsync = promisify(execFile);
const hasSingleInstance = app.requestSingleInstanceLock();

if (!hasSingleInstance) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;
  let store: SqliteStore | undefined;

  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  function registerIpc(dispatchCommand: ReturnType<typeof createCommandDispatcher>) {
    ipcMain.handle(INVOKE_CHANNEL, (_event, name: unknown, args: unknown) => {
      if (typeof name !== "string") {
        return { ok: false, error: "nome de comando inválido" };
      }
      const safeArgs =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      return dispatchCommand(name, safeArgs);
    });
  }

  async function importLoginShellPath() {
    const shellPath = process.env.SHELL || "/bin/zsh";
    try {
      const { stdout } = await execFileAsync(shellPath, ["-lc", 'printf %s "$PATH"']);
      const loginPath = stdout.trim();
      if (loginPath) {
        const pathEntries = [
          ...loginPath.split(path.delimiter),
          ...(process.env.PATH ?? "").split(path.delimiter),
        ];
        process.env.PATH = [...new Set(pathEntries.filter(Boolean))].join(path.delimiter);
      }
    } catch {
      // Keep the process PATH when the configured login shell cannot be queried.
    }
  }

  function createWindow() {
    const window = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 680,
      minHeight: 520,
      title: "AI Mission Manager",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow = window;
    window.once("ready-to-show", () => window.show());

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) void window.loadURL(rendererUrl);
    else void window.loadFile(path.join(__dirname, "index.html"));

    if (process.env.AI_MISSION_MANAGER_OPEN_DEVTOOLS === "true" && rendererUrl) {
      window.webContents.openDevTools({ mode: "detach" });
    }
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = undefined;
    });
    return window;
  }

  ipcMain.handle(
    "desktop:open-directory-dialog",
    async (event, pickerOptions: { title?: string; defaultPath?: string } = {}) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: pickerOptions.title,
        defaultPath: pickerOptions.defaultPath,
        properties: ["openDirectory", "createDirectory"],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle("desktop:reveal-item-in-dir", (_event, filePath: string) => {
    if (typeof filePath !== "string") throw new Error("caminho inválido");
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle("desktop:open-url", async (_event, rawUrl: string) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("URL inválida");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("somente URLs http e https podem ser abertas");
    }
    await shell.openExternal(url.toString());
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (navigationEvent, url) => {
      if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
        return;
      navigationEvent.preventDefault();
    });
  });

  app.whenReady().then(async () => {
    await importLoginShellPath();
    try {
      store = openSqliteStore();
      const state = store.loadState();
      const runtime = new Runtime(store, state);
      ensureProjectWorkspaces(runtime);
      recoverRunStateRecords(runtime.snapshot());
      registerIpc(
        createCommandDispatcher({
          ...createReadCommandHandlers(store),
          ...createSetupCommandHandlers(runtime, store),
          ...createStructureCommandHandlers(runtime, undefined, store),
          ...createWorkCommandHandlers(runtime),
        }),
      );
      mainWindow = createWindow();
    } catch (error) {
      dialog.showErrorBox(
        "AI Mission Manager",
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
      return;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("before-quit", () => {
    store?.close();
    store = undefined;
  });

  app.on("window-all-closed", () => app.quit());
}
