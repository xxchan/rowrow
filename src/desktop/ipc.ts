// The main process's side of window.rowrow (preload.ts): each call checked to come from one of
// the app's own pages, its arguments checked, then handed to the Shell. State goes back to every
// app page on each change.
import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import { serializeError, type Logger } from "./log.ts";
import type { Shell } from "./shell.ts";
import { isAppPage } from "./windows.ts";

const id = z.string().min(1).max(100);
const optionalName = z.string().max(100).nullable();
const action = z.enum(["start", "stop", "restart", "upgrade-now", "adopt"]);

export function registerIpc(shell: Shell, log: Logger, isServerPage: (url: string) => boolean): void {
  // A server's web app (window.rowrowApp): the app's updater and nothing else, and only for the
  // top frame of a server this app opened.
  ipcMain.handle("rowrow-app", async (event, method: unknown) => {
    const frame = event.senderFrame;
    if (frame === null || frame !== event.sender.mainFrame || !isServerPage(frame.url))
      throw new Error("not allowed");
    switch (method) {
      case "update":
        return shell.state().update;
      case "checkForUpdates":
        return await shell.checkForUpdates();
      case "installUpdate":
        return await shell.installUpdate();
      default:
        throw new Error(`no method ${String(method)}`);
    }
  });

  ipcMain.handle("rowrow", async (event, method: unknown, ...args: unknown[]) => {
    if (!isAppPage(event.senderFrame?.url ?? "")) throw new Error("not allowed");
    try {
      switch (method) {
        case "getState":
          return shell.state();
        case "setUpLocal":
          return await shell.setUpLocal();
        case "addSsh":
          return await shell.addSsh(z.string().max(300).parse(args[0]), optionalName.parse(args[1]));
        case "addLink":
          return await shell.addLink(z.string().max(2000).parse(args[0]), optionalName.parse(args[1]));
        case "open":
          return await shell.open(id.parse(args[0]));
        case "remove":
          return await shell.remove(id.parse(args[0]));
        case "rename":
          return await shell.rename(id.parse(args[0]), z.string().max(100).parse(args[1]));
        case "retry":
          return await shell.retry(id.parse(args[0]));
        case "hostAction":
          return await shell.hostAction(id.parse(args[0]), action.parse(args[1]));
        case "checkForUpdates":
          return await shell.checkForUpdates();
        case "installUpdate":
          return await shell.installUpdate();
        case "installCommand":
          return await shell.installCommand();
        case "setOpenAtLogin":
          return await shell.setOpenAtLogin(z.boolean().parse(args[0]));
        case "showLogs":
          return await shell.showLogs(id.nullable().parse(args[0] ?? null));
        default:
          throw new Error(`no method ${String(method)}`);
      }
    } catch (error) {
      log.warn("desktop.ipc.failed", { method: String(method), err: serializeError(error) });
      throw error;
    }
  });

  let update = "";
  shell.onState((state) => {
    const updateChanged = JSON.stringify(state.update) !== update;
    update = JSON.stringify(state.update);
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      const url = window.webContents.getURL();
      if (isAppPage(url)) window.webContents.send("rowrow:state", state);
      else if (updateChanged && isServerPage(url)) window.webContents.send("rowrow-app:update", state.update);
    }
  });
}
