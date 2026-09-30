// The app's API (window.rowrow, from the preload) and its state as a React hook.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { DesktopApi, ShellState } from "../api.ts";

declare global {
  interface Window {
    readonly rowrow?: DesktopApi;
  }
}

export function api(): DesktopApi {
  const found = window.rowrow;
  if (found === undefined) throw new Error("this page runs only in the rowrow app");
  return found;
}

/** The app's state, kept current by the main process. */
export function useShellState(): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);
  useEffect(() => {
    let live = true;
    const stop = api().onState((next) => live && setState(next));
    void api()
      .getState()
      .then((first) => live && setState((current) => current ?? first));
    return () => {
      live = false;
      stop();
    };
  }, []);
  return state;
}

/** What went wrong, without Electron's "Error invoking remote method…" wrapping. */
export function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** Run an action; a failure becomes a toast saying what went wrong. */
export async function run(what: string, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    toast.error(`${what} failed`, { description: message(error) });
    return false;
  }
}

/** Navigation inside the app's window: #/, #/add, #/add/ssh, #/add/link, #/offline/<id>. */
export function go(route: string): void {
  window.location.hash = route;
}

const readRoute = (): string => window.location.hash.replace(/^#/, "") || "/";

export function useRoute(): string {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const update = (): void => setRoute(readRoute());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
