// Preferences kept on this device: localStorage, under `rowrow.*` keys (the theme, the
// inspector's tab, the Changes scope…). Every open tab of the app shares them, and a change in
// one reaches the others as a `storage` event; the one listener here hands it to whoever reads
// that key, so the other tabs follow at once (roamgate #353). Preferences that follow you to
// every device are server settings instead (state.settings).
import { useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();
/** What couldn't be stored (storage is off, or full): it lasts until the page reloads. */
const unsaved = new Map<string, string>();

function notify(key: string | null): void {
  // null: another tab cleared the storage, so every key changed.
  const sets = key === null ? [...listeners.values()] : [listeners.get(key) ?? new Set()];
  for (const set of sets) for (const listener of set) listener();
}

addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage) return;
  if (event.key === null) unsaved.clear();
  else unsaved.delete(event.key);
  notify(event.key);
});

/** The stored value, or null. */
export function readPref(key: string): string | null {
  const value = unsaved.get(key);
  if (value !== undefined) return value;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores a value and tells this tab's readers (the other tabs hear of it from the browser). */
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, value);
  }
  notify(key);
}

/** Calls `listener` whenever the key changes, in this tab or another one. */
export function onPrefChange(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (set === undefined) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** A preference, kept current. `parse` turns what's stored (maybe nothing, maybe junk) into a value. */
export function usePref<T extends string | number | boolean | null>(
  key: string,
  parse: (stored: string | null) => T,
): T {
  return useSyncExternalStore(
    (onChange) => onPrefChange(key, onChange),
    () => parse(readPref(key)),
  );
}
