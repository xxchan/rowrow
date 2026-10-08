// Download a workspace's file or folder (files.download) the way this device should get it
// (download-strategy.ts). Saving fetches first, so a refusal (too big, gone) is a toast that
// says why rather than a failed download in the browser's list.
import { toast } from "sonner";
import {
  chooseStrategy,
  downloadName,
  downloadUrl,
  MAX_SHARE_BYTES,
  type DownloadEnv,
} from "./download-strategy.ts";
import { report } from "./telemetry.ts";

export async function downloadFromWorkspace(
  workspaceId: string,
  path: string,
  kind: "file" | "directory",
): Promise<void> {
  const url = downloadUrl(workspaceId, path);
  const name = downloadName(path, kind);
  const strategy = chooseStrategy(environment());
  const openTab = (): void => {
    window.open(url, "_blank", "noopener");
    toast("Download started", { description: path });
  };
  if (strategy === "new-tab") return openTab();
  const id = toast.loading(`Downloading ${name}`, { description: path });
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(await refusal(response));
    if (strategy === "share" && Number(response.headers.get("content-length") ?? 0) > MAX_SHARE_BYTES) {
      toast.dismiss(id);
      return openTab();
    }
    const blob = await response.blob();
    if (strategy === "share") {
      toast.dismiss(id);
      if (blob.size > MAX_SHARE_BYTES) return openTab();
      try {
        await navigator.share({ files: [new File([blob], name, { type: blob.type })], title: name });
      } catch (error) {
        // Dismissing the sheet is a choice, not a failure.
        if (error instanceof DOMException && error.name === "AbortError") return;
        report("warn", "files.share_failed", error, { path });
        openTab();
      }
      return;
    }
    save(blob, name);
    toast.success("Download started", { id, description: path });
  } catch (error) {
    report("warn", "files.download_failed", error, { path });
    toast.error(`Couldn't download ${name}`, {
      id,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Hand the bytes to the browser as a download with the file's name: no tab, no viewer. */
function save(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** What the server said (the contract's error JSON), or the HTTP status. */
async function refusal(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") return body.message;
  } catch {
    // not JSON: the status says enough
  }
  return `the server answered ${response.status} ${response.statusText}`.trim();
}

function environment(): DownloadEnv {
  const ua = navigator.userAgent;
  let canShareFiles = false;
  try {
    canShareFiles =
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File([""], "probe.txt", { type: "text/plain" })] });
  } catch {
    canShareFiles = false;
  }
  return {
    narrow: matchMedia("(max-width: 767px)").matches,
    // iPadOS asks for desktop sites and says it's a Mac; touch gives it away.
    ios: /iP(hone|ad|od)/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1),
    standalone:
      matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    canShareFiles,
  };
}
