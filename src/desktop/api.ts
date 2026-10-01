// What the Mac app's own pages (src/desktop/ui: servers, setup, offline) see of the main
// process, through the preload's `window.rowrow` (docs/desktop.md). Types only: the main
// process, the preload and the pages all import them, and none of them imports the others.
import type { AppUpdateView } from "../shared/app-bridge.ts";

export type ServerKind = "local" | "ssh" | "url";

export type ServerStatus =
  | { readonly kind: "connecting"; readonly detail: string | null }
  | { readonly kind: "setting-up"; readonly step: string }
  | { readonly kind: "online" }
  | { readonly kind: "offline"; readonly reason: string; readonly since: number }
  /** This Mac's credential stopped working there (revoked, or the server's data was reset). */
  | { readonly kind: "signed-out"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Who runs a host's server (D-032): the app (a bundle it installed, which it upgrades), the
 * CLI (`rowrow service install` from npm, pnpm or a checkout: yours to update), a terminal
 * (`rowrow serve`, not a service), in the background (a host with no service manager, started
 * by the app), or nothing.
 */
export type HostOwner = "app" | "cli" | "terminal" | "background" | "none";

export interface HostView {
  readonly owner: HostOwner;
  /** How the running rowrow was installed there: npm, pnpm, checkout, bundle. */
  readonly installKind: string | null;
  readonly runningVersion: string | null;
  /** What launchd or systemd says. */
  readonly service: string | null;
  /** The app's newer server, waiting to replace the one that runs. */
  readonly upgrade: {
    readonly version: string;
    readonly state: "waiting" | "installing" | "failed";
    /** Agents mid-turn that the upgrade waits for. */
    readonly waitingFor: readonly string[];
    readonly error: string | null;
  } | null;
  readonly logFile: string | null;
}

export interface ServerView {
  readonly id: string;
  readonly name: string;
  readonly kind: ServerKind;
  /** "This Mac", the SSH destination, or the URL. */
  readonly where: string;
  readonly status: ServerStatus;
  /** Agents that need you there, from its notifications; null when unknown. */
  readonly badge: number | null;
  readonly version: string | null;
  /** This Mac's and SSH hosts' server: who runs it, and what the app can do about it. */
  readonly host: HostView | null;
  /** Notifications reach this Mac (the server has notify.watch); null until the app knows. */
  readonly notifications: boolean | null;
}

/** The app's updater, as the menu, its own pages and a server's Settings (window.rowrowApp) show it. */
export type UpdateView = AppUpdateView;

/** What runs on this Mac before the app set anything up: offered on the welcome page. */
export interface LocalFound {
  readonly owner: HostOwner;
  readonly version: string | null;
  readonly url: string | null;
}

export interface ShellState {
  readonly version: string;
  readonly servers: readonly ServerView[];
  readonly update: UpdateView;
  /** This Mac's rowrow when there's no "This Mac" server yet (null: nothing runs, or not looked yet). */
  readonly localFound: LocalFound | null;
  /** The app has a server bundle for this Mac (a packaged app, or a development one). */
  readonly localSupported: boolean;
  /** /usr/local/bin/rowrow points at the app's CLI. */
  readonly commandInstalled: boolean;
  readonly openAtLogin: boolean;
}

export type HostAction = "start" | "stop" | "restart" | "upgrade-now" | "adopt";

export interface DesktopApi {
  getState(): Promise<ShellState>;
  onState(listener: (state: ShellState) => void): () => void;
  /** Run agents on this Mac: install the server here (or connect to the one that runs). */
  setUpLocal(): Promise<void>;
  /** A machine over SSH: put a server there (VS Code's Remote-SSH, for rowrow). */
  addSsh(destination: string, name: string | null): Promise<{ id: string }>;
  /** A server you can reach, by the sign-in link `rowrow pair` or Pair a device gives. */
  addLink(link: string, name: string | null): Promise<{ id: string }>;
  open(serverId: string): Promise<void>;
  remove(serverId: string): Promise<void>;
  rename(serverId: string, name: string): Promise<void>;
  retry(serverId: string): Promise<void>;
  hostAction(serverId: string, action: HostAction): Promise<void>;
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  installCommand(): Promise<void>;
  setOpenAtLogin(open: boolean): Promise<void>;
  showLogs(serverId: string | null): Promise<void>;
}
