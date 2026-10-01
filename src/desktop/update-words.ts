// What the app says about its updates, without Electron (so vitest covers it).
import type { UpdateView } from "./api.ts";

/**
 * What to tell someone who chose Check for Updates, once the check is done: that this is the
 * newest version, that one is on its way, or what went wrong. null when the menu already says it
 * (Restart to Update).
 */
export function checkOutcome(view: UpdateView): { message: string; detail: string } | null {
  switch (view.state) {
    case "idle":
    case "checking":
      return { message: "You're up to date", detail: `rowrow ${view.current} is the newest version.` };
    case "downloading":
      return {
        message: `Downloading rowrow ${view.version ?? "update"}`,
        detail:
          "When it's ready, choose Restart to Update in the rowrow menu (or quit rowrow): it installs then.",
      };
    case "error":
      return { message: "Couldn't update rowrow", detail: view.error ?? "The update check failed." };
    case "disabled":
      return { message: "This build doesn't update itself", detail: "Download rowrow from GitHub Releases." };
    case "ready":
      return null;
  }
}
