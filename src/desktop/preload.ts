// The app's API for its own pages (src/desktop/ui), as `window.rowrow`. This preload runs in
// every window, sandboxed, but gives the API only to pages at rowrow-app://ui: a server's web
// app never sees it (and the main process checks the sender again, ipc.ts).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopApi, ShellState } from "./api.ts";

// A page's location (this runs in the renderer; the main process's types have no DOM).
const { location } = globalThis as unknown as { location: { protocol: string; host: string } };

if (location.protocol === "rowrow-app:" && location.host === "ui") {
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke("rowrow", method, ...args) as Promise<T>;
  const api: DesktopApi = {
    getState: () => call("getState"),
    onState: (listener) => {
      const handler = (_event: IpcRendererEvent, state: ShellState): void => listener(state);
      ipcRenderer.on("rowrow:state", handler);
      return () => void ipcRenderer.off("rowrow:state", handler);
    },
    setUpLocal: () => call("setUpLocal"),
    addSsh: (destination, name) => call("addSsh", destination, name),
    addLink: (link, name) => call("addLink", link, name),
    open: (serverId) => call("open", serverId),
    remove: (serverId) => call("remove", serverId),
    rename: (serverId, name) => call("rename", serverId, name),
    retry: (serverId) => call("retry", serverId),
    hostAction: (serverId, action) => call("hostAction", serverId, action),
    checkForUpdates: () => call("checkForUpdates"),
    installUpdate: () => call("installUpdate"),
    installCommand: () => call("installCommand"),
    setOpenAtLogin: (open) => call("setOpenAtLogin", open),
    showLogs: (serverId) => call("showLogs", serverId),
  };
  contextBridge.exposeInMainWorld("rowrow", api);
}
