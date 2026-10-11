// What a server's web app can ask of rowrow for Mac when it runs inside it, as
// `window.rowrowApp`: the app's own updater, so Settings can say whether the app is up to date
// and update it; and the machines the app knows, so the sidebar can switch between them and
// Settings can list them (D-059). The app gives it only to the top frame of pages of machines it
// opened (src/desktop/preload.ts, ipc.ts); in a browser it isn't there.

export interface AppUpdateView {
  /** The app's version. */
  readonly current: string;
  readonly state: "idle" | "checking" | "downloading" | "ready" | "error" | "disabled";
  /** The newer version, while downloading and once ready. */
  readonly version: string | null;
  readonly progress: number | null;
  readonly error: string | null;
  /** When the last check finished. */
  readonly checkedAt: number | null;
}

/**
 * A machine the app knows, as another machine's page sees it: enough to show it and switch to
 * it. Not where it is (its SSH destination or address) and nothing about its agents but how many
 * need you.
 */
export interface AppMachine {
  readonly id: string;
  readonly name: string;
  /** This Mac, a machine the app reaches over SSH, or one it signed in to by link. */
  readonly kind: "local" | "ssh" | "url";
  readonly status: "connecting" | "setting-up" | "online" | "offline" | "signed-out" | "error";
  /** The status in words: "Connected", "Connecting…", why it can't be reached. */
  readonly statusText: string;
  /** Agents that need you there; null while it isn't connected. */
  readonly needsYou: number | null;
  /** The rowrow it runs. */
  readonly version: string | null;
  /** A newer rowrow the app put there, waiting for agents to finish before it restarts into it. */
  readonly upgrade: {
    readonly version: string;
    readonly state: "waiting" | "installing" | "failed";
    /** How many agents mid-turn it waits for. */
    readonly waitingFor: number;
    readonly error: string | null;
  } | null;
}

export interface AppMachines {
  /** The machine this page is from; null when the app doesn't know it by this window. */
  readonly current: string | null;
  readonly machines: readonly AppMachine[];
}

export interface AppBridge {
  update(): Promise<AppUpdateView>;
  onUpdate(listener: (view: AppUpdateView) => void): () => void;
  checkForUpdates(): Promise<void>;
  /** Quit, install the downloaded update and come back (state "ready"). */
  installUpdate(): Promise<void>;
  // The machines (D-059). Absent in apps older than the web app that asks: check before use.
  machines?(): Promise<AppMachines>;
  onMachines?(listener: (machines: AppMachines) => void): () => void;
  /** Bring that machine's window forward (open one if none is). */
  openMachine?(id: string): Promise<void>;
  /** The app's own window: adding a machine, or the list with everything you can do to them. */
  showMachines?(page: "add" | "manage"): Promise<void>;
  /** The app asks first, in a dialog of its own. */
  removeMachine?(id: string): Promise<void>;
  /** Restart into the waiting upgrade now, or try a failed one again. */
  upgradeMachine?(id: string): Promise<void>;
}
