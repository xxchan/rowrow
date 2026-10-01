// What a server's web app can ask of rowrow for Mac when it runs inside it, as
// `window.rowrowApp`: only the app's own updater, so Settings can say whether the app is up to
// date and update it. The app gives it only to the pages of servers it opened
// (src/desktop/preload.ts, ipc.ts); in a browser it isn't there.

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

export interface AppBridge {
  update(): Promise<AppUpdateView>;
  onUpdate(listener: (view: AppUpdateView) => void): () => void;
  checkForUpdates(): Promise<void>;
  /** Quit, install the downloaded update and come back (state "ready"). */
  installUpdate(): Promise<void>;
}
