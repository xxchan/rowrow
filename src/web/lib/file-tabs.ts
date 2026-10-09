// The Files view's open files (roamgate #309), as tabs: a single click opens a file in the
// temporary tab (`preview`, shown in italics), which the next single click reuses; a
// double-click, or Enter on the tab, keeps it. Kept per workspace on this device, and the
// tabs of files that are gone are dropped.

export interface FileTabs {
  /** Open files, in tab order. */
  readonly paths: readonly string[];
  /** The one showing. */
  readonly active: string | null;
  /** The temporary tab, if there is one. */
  readonly preview: string | null;
}

export const NO_TABS: FileTabs = { paths: [], active: null, preview: null };

/** Shows a file: its own tab if it has one, else in the temporary tab, which moves to the end. */
export function openTab(tabs: FileTabs, path: string): FileTabs {
  if (tabs.paths.includes(path)) return tabs.active === path ? tabs : { ...tabs, active: path };
  return {
    paths: [...tabs.paths.filter((other) => other !== tabs.preview), path],
    active: path,
    preview: path,
  };
}

/** Makes the temporary tab a kept one. */
export function keepTab(tabs: FileTabs, path: string): FileTabs {
  return tabs.preview === path ? { ...tabs, preview: null } : tabs;
}

/** Closes a tab; when it was showing, the one after it shows (or the one before, at the end). */
export function closeTab(tabs: FileTabs, path: string): FileTabs {
  return dropTabs(tabs, (other) => other === path);
}

/** Drops the tabs of files that no longer exist. */
export function pruneTabs(tabs: FileTabs, exists: (path: string) => boolean): FileTabs {
  return dropTabs(tabs, (path) => !exists(path));
}

function dropTabs(tabs: FileTabs, drop: (path: string) => boolean): FileTabs {
  if (!tabs.paths.some(drop)) return tabs;
  const paths = tabs.paths.filter((path) => !drop(path));
  let active = tabs.active;
  if (active !== null && drop(active)) {
    // The first kept tab at or after its place, else the last one before it.
    const at = tabs.paths.indexOf(active);
    active = tabs.paths.slice(at + 1).find((path) => !drop(path)) ?? paths.at(-1) ?? null;
  }
  return { paths, active, preview: tabs.preview !== null && drop(tabs.preview) ? null : tabs.preview };
}

/** Tabs as stored (maybe nothing, maybe junk), checked. */
export function parseTabs(stored: string | null): FileTabs {
  if (stored === null) return NO_TABS;
  try {
    const value = JSON.parse(stored) as Partial<Record<keyof FileTabs, unknown>>;
    if (!Array.isArray(value.paths)) return NO_TABS;
    const paths = [
      ...new Set(value.paths.filter((path): path is string => typeof path === "string" && path !== "")),
    ];
    const known = (path: unknown): string | null =>
      typeof path === "string" && paths.includes(path) ? path : null;
    return { paths, active: known(value.active) ?? paths[0] ?? null, preview: known(value.preview) };
  } catch {
    return NO_TABS;
  }
}
