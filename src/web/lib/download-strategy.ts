// How a download reaches the device (roamgate #35, #60, #312), decided from the layout and
// the browser, never from the file. The desktop layout saves straight to disk, installed web
// apps included. On a phone, iOS gets its share sheet (Save to Files, AirDrop, another app);
// a home-screen app or an iOS browser that can't share files opens the file in a new tab, since
// a download there would leave the app on a page with no way back; anything else downloads.

export type DownloadStrategy = "save" | "share" | "new-tab";

export interface DownloadEnv {
  /** The phone layout (narrower than Tailwind's `md`). */
  readonly narrow: boolean;
  readonly ios: boolean;
  /** Running as an installed (home-screen) web app. */
  readonly standalone: boolean;
  readonly canShareFiles: boolean;
}

/** The share sheet gets files up to this size; bigger ones open in a new tab. */
export const MAX_SHARE_BYTES = 64 * 1024 * 1024;

export function chooseStrategy(env: DownloadEnv): DownloadStrategy {
  if (!env.narrow) return "save";
  if (env.canShareFiles && env.ios) return "share";
  if (env.standalone || env.ios) return "new-tab";
  return "save";
}

/** files.download's GET route: the browser sends its cookie, so a plain URL works anywhere. */
export function downloadUrl(workspaceId: string, path: string): string {
  return `/api/files/download?${new URLSearchParams({ workspaceId, path }).toString()}`;
}

/** The name the server gives it: the file's own, or `<folder>.tar.gz`. */
export function downloadName(path: string, kind: "file" | "directory"): string {
  const base = path.slice(path.lastIndexOf("/") + 1) || "download";
  return kind === "directory" ? `${base}.tar.gz` : base;
}
