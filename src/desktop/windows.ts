// The Mac app's windows (docs/desktop.md, D-030). A server's window shows that server's own web
// app, loaded from the server, so what you see always matches the server you talk to, whatever
// version this app is. Each server has its own session (cookies, storage), holding the
// credential this app has there as the web app's session cookie. The app's own pages (servers,
// setting up, offline) are local, at rowrow-app://ui/, and only they get the app's API.
import { BrowserWindow, nativeTheme, session, shell, type Session, type WebContents } from "electron";
import type { Logger } from "./log.ts";
import { windowTitle } from "./window-title.ts";

export const APP_SCHEME = "rowrow-app";
export const UI_ORIGIN = `${APP_SCHEME}://ui`;
/** The web app's session cookie (src/server/api/server.ts). */
const COOKIE = "rowrow_session";

/** Permissions a server's page may have: copy to the clipboard, and full screen. Nothing else. */
const ALLOWED = new Set(["clipboard-sanitized-write", "fullscreen"]);

export interface ServerWindowTarget {
  readonly id: string;
  readonly name: string;
  /** Where the server is, when it can be reached. */
  readonly origin: string | null;
  readonly token: string | null;
}

export function partitionOf(serverId: string): string {
  return `persist:server-${serverId}`;
}

export function isAppPage(url: string): boolean {
  return url.startsWith(`${UI_ORIGIN}/`);
}

export class Windows {
  /** A page of a server this app opened (it gets window.rowrowApp, the updater). */
  isServerPage(url: string): boolean {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    return [...this.origins.values()].includes(origin);
  }

  private readonly preload: string;
  private readonly log: Logger;
  private readonly userAgent: string;
  private readonly prepared = new Set<string>();
  private readonly byServer = new Map<string, Set<BrowserWindow>>();
  private readonly origins = new Map<string, string>();
  private hosts: BrowserWindow | null = null;
  /** Quitting: nothing may keep a window open (an update installs only once every window closed). */
  quitting = false;

  private readonly appPages: (request: Request) => Response | Promise<Response>;
  private readonly several: () => boolean;

  constructor(options: {
    preload: string;
    log: Logger;
    version: string;
    /** Serves rowrow-app://ui: registered in each server's session too, for its offline page. */
    appPages: (request: Request) => Response | Promise<Response>;
    /** Whether this app has more than one server: then a window's title names its server. */
    several: () => boolean;
  }) {
    this.preload = options.preload;
    this.log = options.log;
    this.userAgent = ` rowrow-desktop/${options.version}`;
    this.appPages = options.appPages;
    this.several = options.several;
  }

  private base(): Electron.BrowserWindowConstructorOptions {
    return {
      width: 1280,
      height: 840,
      minWidth: 375,
      minHeight: 480,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1115" : "#ffffff",
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    };
  }

  /** Links to elsewhere open in your browser; a page never opens a window of its own. */
  private guard(
    contents: WebContents,
    sameSite: (url: string) => boolean,
    openHere: (url: string) => void,
  ): void {
    contents.setWindowOpenHandler(({ url }) => {
      if (sameSite(url)) openHere(url);
      else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (details) => {
      if (sameSite(details.url) || isAppPage(details.url)) return;
      details.preventDefault();
      if (/^https?:\/\//.test(details.url)) void shell.openExternal(details.url);
    });
    // A page's "leave this page?" never holds up quitting, or an update would wait forever.
    contents.on("will-prevent-unload", (event) => {
      if (this.quitting) event.preventDefault();
    });
  }

  private prepare(partition: string): Session {
    const ses = session.fromPartition(partition);
    if (this.prepared.has(partition)) return ses;
    this.prepared.add(partition);
    ses.setUserAgent(`${ses.getUserAgent()}${this.userAgent}`);
    // A scheme handled on the default session isn't on this one.
    ses.protocol.handle(APP_SCHEME, this.appPages);
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED.has(permission));
    return ses;
  }

  /** Put this app's credential for a server in its session, as the web app's cookie. */
  async signIn(target: ServerWindowTarget): Promise<void> {
    if (target.origin === null || target.token === null) return;
    const ses = this.prepare(partitionOf(target.id));
    await ses.cookies.set({
      url: target.origin,
      name: COOKIE,
      value: target.token,
      httpOnly: true,
      sameSite: "lax",
      secure: target.origin.startsWith("https:"),
      expirationDate: Math.floor(Date.now() / 1000) + 400 * 24 * 3600,
    });
  }

  /** Sign a server's session in with a one-time code, the way a browser does; its credential, or null. */
  async redeemInBrowser(serverId: string, origin: string, code: string): Promise<string | null> {
    const ses = this.prepare(partitionOf(serverId));
    await ses.fetch(`${origin}/auth/redeem?code=${encodeURIComponent(code)}`, {
      redirect: "manual",
      credentials: "include",
    });
    const [cookie] = await ses.cookies.get({ url: origin, name: COOKIE });
    return cookie?.value ?? null;
  }

  /** A server's window: the one already open (brought forward), or a new one. */
  async openServer(target: ServerWindowTarget, path = "/", newWindow = false): Promise<BrowserWindow> {
    const open = [...(this.byServer.get(target.id) ?? [])];
    const existing = newWindow ? undefined : open.find((w) => !w.isDestroyed());
    if (existing !== undefined) {
      if (target.origin !== null && path !== "/") await this.navigate(target.id, path);
      existing.show();
      existing.focus();
      return existing;
    }
    const partition = partitionOf(target.id);
    this.prepare(partition);
    const base = this.base();
    const window = new BrowserWindow({
      ...base,
      title: windowTitle("rowrow", target.name, this.several()),
      webPreferences: { ...base.webPreferences, partition },
    });
    const windows = this.byServer.get(target.id) ?? new Set<BrowserWindow>();
    windows.add(window);
    this.byServer.set(target.id, windows);
    window.on("closed", () => windows.delete(window));
    window.once("ready-to-show", () => window.show());
    // The server's page sets its own title; the server's name joins it when there are several.
    window.on("page-title-updated", (event, title) => {
      event.preventDefault();
      window.setTitle(windowTitle(title, target.name, this.several()));
    });
    this.guard(
      window.webContents,
      (url) => {
        const origin = this.origins.get(target.id);
        return origin !== undefined && url.startsWith(`${origin}/`);
      },
      (url) => void this.openServer(target, new URL(url).pathname + new URL(url).search, true),
    );
    await this.load(window, target, path);
    return window;
  }

  private async load(window: BrowserWindow, target: ServerWindowTarget, path: string): Promise<void> {
    const offline = `${UI_ORIGIN}/index.html#/offline/${encodeURIComponent(target.id)}`;
    if (target.origin !== null) {
      this.origins.set(target.id, target.origin);
      await this.signIn(target);
    }
    try {
      await window.loadURL(target.origin === null ? offline : `${target.origin}${path}`);
    } catch (error) {
      // Replaced by a newer load (the server came back while the offline page was loading).
      if ((error as { code?: unknown }).code === "ERR_ABORTED" || window.isDestroyed()) return;
      this.log.warn("desktop.window.load_failed", {
        server: target.id,
        err: error instanceof Error ? error.message : String(error),
      });
      if (target.origin !== null) await window.loadURL(offline).catch(() => undefined);
    }
  }

  /** Point a server's windows at where it is now (it came back, moved port, or was upgraded). */
  async refresh(target: ServerWindowTarget, reloadServerPages: boolean): Promise<void> {
    const previous = this.origins.get(target.id);
    for (const window of this.byServer.get(target.id) ?? []) {
      if (window.isDestroyed()) continue;
      const url = window.webContents.getURL();
      const showingServer = previous !== undefined && url.startsWith(`${previous}/`);
      // Gone again: the web app says it's reconnecting, the offline page stays where it is.
      if (target.origin === null) continue;
      if (!showingServer || previous !== target.origin) {
        const path = showingServer ? url.slice((previous ?? "").length) : "/";
        await this.load(window, target, path);
      } else if (reloadServerPages) {
        await this.signIn(target);
        window.webContents.reload();
      }
    }
    if (target.origin !== null) this.origins.set(target.id, target.origin);
  }

  /** Show `path` in a server's window (a notification was clicked). */
  async navigate(serverId: string, path: string): Promise<void> {
    const origin = this.origins.get(serverId);
    const window = [...(this.byServer.get(serverId) ?? [])].find((w) => !w.isDestroyed());
    if (origin === undefined || window === undefined) return;
    await window.loadURL(`${origin}${path}`);
  }

  closeServer(serverId: string): void {
    for (const window of this.byServer.get(serverId) ?? []) if (!window.isDestroyed()) window.close();
    this.byServer.delete(serverId);
    this.origins.delete(serverId);
  }

  async forget(serverId: string): Promise<void> {
    this.closeServer(serverId);
    await session.fromPartition(partitionOf(serverId)).clearStorageData();
  }

  /** The app's own window: servers, adding one, setting this Mac up. */
  async openHosts(route = "/"): Promise<BrowserWindow> {
    if (this.hosts !== null && !this.hosts.isDestroyed()) {
      await this.hosts.loadURL(`${UI_ORIGIN}/index.html#${route}`);
      this.hosts.show();
      this.hosts.focus();
      return this.hosts;
    }
    const window = new BrowserWindow({
      ...this.base(),
      width: 760,
      height: 720,
      minWidth: 375,
      title: "rowrow",
    });
    this.hosts = window;
    window.on("closed", () => {
      if (this.hosts === window) this.hosts = null;
    });
    window.once("ready-to-show", () => window.show());
    this.guard(
      window.webContents,
      () => false,
      () => undefined,
    );
    await window.loadURL(`${UI_ORIGIN}/index.html#${route}`);
    return window;
  }

  /** Server ids with an open window, most recently focused first. */
  openServers(): string[] {
    const focused = BrowserWindow.getFocusedWindow();
    const ids = [...this.byServer.entries()]
      .filter(([, windows]) => [...windows].some((w) => !w.isDestroyed()))
      .map(([id]) => id);
    const first = ids.find((id) => [...(this.byServer.get(id) ?? [])].includes(focused as BrowserWindow));
    return first === undefined ? ids : [first, ...ids.filter((id) => id !== first)];
  }

  anyVisible(): boolean {
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
  }
}
