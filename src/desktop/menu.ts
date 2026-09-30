// The app menu and the menu-bar item (docs/desktop.md). Both are rebuilt from the ShellState:
// servers with how many agents need you there, and the update's state ("Restart to Update").
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  shell as electronShell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import type { ServerView, ShellState } from "./api.ts";

export interface MenuActions {
  openServer(id: string): void;
  newWindow(): void;
  openHosts(route?: string): void;
  checkForUpdates(): void;
  installUpdate(): void;
  installCommand(): void;
  showLogs(): void;
}

function serverLabel(server: ServerView): string {
  const status =
    server.status.kind === "online"
      ? server.badge !== null && server.badge > 0
        ? `${server.badge} need${server.badge === 1 ? "s" : ""} you`
        : null
      : server.status.kind === "setting-up"
        ? "setting up"
        : server.status.kind === "connecting"
          ? "connecting"
          : server.status.kind === "signed-out"
            ? "signed out"
            : "offline";
  return status === null ? server.name : `${server.name} — ${status}`;
}

function updateItem(state: ShellState, actions: MenuActions): MenuItemConstructorOptions {
  const { update } = state;
  if (update.state === "ready")
    return {
      label: `Restart to Update to ${update.version ?? "the new version"}`,
      click: () => actions.installUpdate(),
    };
  if (update.state === "downloading")
    return {
      label: `Downloading ${update.version ?? "an update"}${update.progress === null ? "" : ` (${Math.round(update.progress * 100)}%)`}…`,
      enabled: false,
    };
  return {
    label: "Check for Updates…",
    enabled: update.state !== "disabled" && update.state !== "checking",
    click: () => actions.checkForUpdates(),
  };
}

export function appMenu(state: ShellState, actions: MenuActions): Menu {
  const servers: MenuItemConstructorOptions[] = state.servers.map((server) => ({
    label: serverLabel(server),
    click: () => actions.openServer(server.id),
  }));
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        updateItem(state, actions),
        { type: "separator" },
        { label: "Servers…", accelerator: "Cmd+,", click: () => actions.openHosts("/") },
        { label: "Install the rowrow Command…", click: () => actions.installCommand() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "Cmd+N", click: () => actions.newWindow() },
        { label: "Add a Server…", accelerator: "Shift+Cmd+N", click: () => actions.openHosts("/add") },
        ...(servers.length === 0 ? [] : [{ type: "separator" as const }, ...servers]),
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "rowrow on GitHub",
          click: () => void electronShell.openExternal("https://github.com/xxchan/rowrow"),
        },
        { label: "Show the App's Log", click: () => actions.showLogs() },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** The menu-bar item: how many agents need you, and one click to the server they're on. */
export class MenuBar {
  private tray: Tray | null = null;
  private readonly icon: string;

  constructor(icon: string) {
    this.icon = icon;
  }

  update(state: ShellState, badge: number, actions: MenuActions): void {
    if (state.servers.length === 0) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (this.tray === null) {
      const image = nativeImage.createFromPath(this.icon);
      image.setTemplateImage(true);
      this.tray = new Tray(image);
      this.tray.setToolTip("rowrow");
    }
    this.tray.setTitle(badge > 0 ? String(badge) : "", { fontType: "monospacedDigit" });
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...state.servers.map((server) => ({
          label: serverLabel(server),
          click: () => actions.openServer(server.id),
        })),
        { type: "separator" },
        { label: "Servers…", click: () => actions.openHosts("/") },
        updateItem(state, actions),
        { type: "separator" },
        { label: "Quit rowrow", click: () => app.quit() },
      ]),
    );
  }
}

/** The focused window's server, for File → New Window. */
export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}
