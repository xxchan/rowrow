// Light, dark, or whatever the system says; per device. theme.js applies it before the
// first paint; this keeps it applied as the choice or the system changes.
import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";

const KEY = "rowrow.theme";
const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY);
    return value === "system" || value === "light" || value === "dark" ? value : "dark";
  } catch {
    return "dark";
  }
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
  apply();
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private browsing: the choice lasts for this page.
  }
  apply();
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
