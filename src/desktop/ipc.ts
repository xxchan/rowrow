// The main process's side of window.rowrow (preload.ts): each call checked to come from one of
// the app's own pages, its arguments checked, then handed to the Shell. State goes back to every
// app page on each change. A machine's own page gets window.rowrowApp instead: the updater and
// the machines (machines.ts, D-059), each pushed again when it changes.
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { z } from "zod";
import { serializeError, type Logger } from "./log.ts";
import { fromServerPage, machinesFor, parseServerPageCall, upgradeWaiting } from "./machines.ts";
import type { Shell } from "./shell.ts";
import { isAppPage } from "./windows.ts";

const id = z.string().min(1).max(100);
const optionalName = z.string().max(100).nullable();
const action = z.enum(["start", "stop", "restart", "upgrade-now", "adopt"]);

/** What ipc needs of the windows (windows.ts). */
export interface ServerPages {
  /** A page of a machine this app opened. */
  isServerPage(url: string): boolean;
  /** The machine whose window shows this page. */
  serverOf(contents: WebContents): string | null;
  openHosts(route: string): Promise<unknown>;
}

export function registerIpc(shell: Shell, log: Logger, pages: ServerPages): void {
  // A machine's web app (window.rowrowApp): only for the top frame of a machine this app opened.
  ipcMain.handle("rowrow-app", async (event, method: unknown, ...args: unknown[]) => {
    if (!fromServerPage(event.senderFrame, event.sender.mainFrame, (url) => pages.isServerPage(url)))
      throw new Error("not allowed");
    try {
      const call = parseServerPageCall(method, args);
      switch (call.method) {
        case "update":
          return shell.state().update;
        case "checkForUpdates":
          return await shell.checkForUpdates();
        case "installUpdate":
          return await shell.installUpdate();
        case "machines":
          return machinesFor(shell.state(), pages.serverOf(event.sender));
        case "openMachine":
          return await shell.open(call.id);
        case "showMachines":
          await pages.openHosts(call.page === "add" ? "/add" : "/");
          return;
        case "removeMachine":
          // The app asks first (Shell.remove), so a page can't remove a machine by itself.
          return await shell.remove(call.id);
        case "upgradeMachine":
          // Only into an upgrade the app put there: not a restart of any machine's server at will.
          if (!upgradeWaiting(shell.state(), call.id)) throw new Error("no rowrow upgrade waits there");
          return await shell.hostAction(call.id, "upgrade-now");
      }
    } catch (error) {
      log.warn("desktop.ipc.failed", { method: String(method), page: true, err: serializeError(error) });
      throw error;
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
  let machines = "";
  shell.onState((state) => {
    const updateChanged = JSON.stringify(state.update) !== update;
    update = JSON.stringify(state.update);
    const list = JSON.stringify(machinesFor(state, null));
    const machinesChanged = list !== machines;
    machines = list;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      const contents = window.webContents;
      const url = contents.getURL();
      if (isAppPage(url)) contents.send("rowrow:state", state);
      else if (pages.isServerPage(url)) {
        if (updateChanged) contents.send("rowrow-app:update", state.update);
        if (machinesChanged)
          contents.send("rowrow-app:machines", machinesFor(state, pages.serverOf(contents)));
      }
    }
  });
}
