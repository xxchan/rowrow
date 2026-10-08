// Light, dark, or whatever the system says; per device. theme.js applies it before the
// first paint; this keeps it applied as the choice (here or in another tab) or the system changes.
import { useSyncExternalStore } from "react";
import { onPrefChange, readPref, writePref } from "./device-prefs.ts";

export type ThemeMode = "system" | "light" | "dark";

const KEY = "rowrow.theme";
const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): ThemeMode {
  const value = readPref(KEY);
  return value === "system" || value === "light" || value === "dark" ? value : "dark";
}

let mode = stored();

function apply(): void {
  const dark = mode === "dark" || (mode === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#15161e" : "#f6f7fb");
  for (const listener of listeners) listener();
}

/** Keeps the page's theme in step with the choice and, for "system", with the OS. */
export function startTheme(): void {
  media.addEventListener("change", apply);
  onPrefChange(KEY, () => {
    mode = stored();
    apply();
  });
  apply();
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  writePref(KEY, next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chosen mode, and whether the page is dark right now. */
export function useTheme(): { mode: ThemeMode; dark: boolean } {
  const dark = useSyncExternalStore(subscribe, () => document.documentElement.classList.contains("dark"));
  const current = useSyncExternalStore(subscribe, () => mode);
  return { mode: current, dark };
}
