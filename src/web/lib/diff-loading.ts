// How the Changes view loads diffs as one continuous scroll (roamgate #340): which files start
// collapsed, a queue that bounds how many git.diff calls run at once, and a cache of loaded
// patches that outlives the view (the phone's sheet unmounts it on close).
import type { ChangedFile } from "../../shared/schemas.ts";

/** A diff of at least this many changed lines starts collapsed... */
export const LARGE_DIFF_LINES = 1000;
/** ...and so does a patch this long once it loaded (characters, about bytes). */
export const LARGE_PATCH_CHARS = 128 * 1024;

export interface LoadedDiff {
  /** The workspace's git version it was read at: older ones show until a fresh one arrives. */
  readonly version: number;
  readonly patch: string;
  readonly truncated: boolean;
}

/**
 * Why a file's diff starts collapsed behind "View diff", or null: generated (the server's
 * flag), or large by its line counts or, once loaded, by its patch.
 */
export function collapseReason(
  file: Pick<ChangedFile, "generated" | "additions" | "deletions">,
  loaded?: Pick<LoadedDiff, "patch" | "truncated">,
): string | null {
  if (file.generated === true) return "Generated file";
  const lines = (file.additions ?? 0) + (file.deletions ?? 0);
  if (lines >= LARGE_DIFF_LINES) return `${lines.toLocaleString("en-US")} changed lines`;
  if (
    loaded !== undefined &&
    loaded.patch !== "" &&
    (loaded.truncated || loaded.patch.length >= LARGE_PATCH_CHARS)
  )
    return "Large diff";
  return null;
}

/** What a request the view no longer wants rejects with: nothing to report. */
export class Retired extends Error {
  constructor() {
    super("diff request retired");
  }
}

interface Task {
  readonly key: string | undefined;
  readonly run: () => Promise<{ patch: string }>;
  readonly wanted: () => boolean;
  readonly resolve: (value: { patch: string }) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A queue for diff requests: two at a time to start, up to eight while answers come back fast
 * and small, halved when one is slow or big. Before a request starts it asks `wanted()`; one
 * the view scrolled away from is dropped (rejected with `Retired`).
 */
export function createDiffQueue() {
  const pending: Task[] = [];
  let active = 0;
  let concurrency = 2;
  let fast = 0;

  const pump = (): void => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const task = pending[index];
      if (task === undefined || task.wanted()) continue;
      pending.splice(index, 1);
      task.reject(new Retired());
    }
    while (active < concurrency) {
      const task = pending.shift();
      if (task === undefined) break;
      active += 1;
      void start(task);
    }
  };

  const start = async (task: Task): Promise<void> => {
    const begun = performance.now();
    try {
      const result = await task.run();
      const elapsed = performance.now() - begun;
      if (elapsed > 400 || result.patch.length >= LARGE_PATCH_CHARS) {
        concurrency = Math.max(1, Math.floor(concurrency / 2));
        fast = 0;
      } else if (elapsed < 100 && result.patch.length < LARGE_PATCH_CHARS / 2) {
        fast += 1;
        if (fast >= concurrency * 2) {
          concurrency = Math.min(8, concurrency + 1);
          fast = 0;
        }
      }
      task.resolve(result);
    } catch (error) {
      task.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      active -= 1;
      pump();
    }
  };

  return {
    /** Runs `run` when there's room; `priority` (a file you asked for) goes first. */
    request<T extends { patch: string }>(
      run: () => Promise<T>,
      wanted: () => boolean,
      priority = false,
      key?: string,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        // The task hands back what `run` resolved with, a T.
        const task: Task = {
          key,
          run,
          wanted,
          resolve: resolve as (value: { patch: string }) => void,
          reject,
        };
        if (priority) pending.unshift(task);
        else pending.push(task);
        pump();
      });
    },
    /** Moves a waiting request to the front. */
    prioritize(key: string): void {
      const index = pending.findIndex((task) => task.key === key);
      if (index > 0) pending.unshift(...pending.splice(index, 1));
    },
  };
}

/** The one queue every Changes view shares. */
export const diffQueue = createDiffQueue();

// ─── Cache ───────────────────────────────────────────────────────────────────

/** Loaded patches by `diffKey`, oldest stored first, up to about 16 MB of text. */
const cache = new Map<string, LoadedDiff>();
const CACHE_CHARS = 8_000_000;
let cached = 0;

/** A file's cache key: the workspace, scope and agent its Changes view shows, and its path. */
export function diffKey(scopeKey: string, path: string): string {
  return `${scopeKey}\0${path}`;
}

export function readDiff(key: string): LoadedDiff | undefined {
  return cache.get(key);
}

export function storeDiff(key: string, diff: LoadedDiff): void {
  const old = cache.get(key);
  if (old !== undefined) cached -= old.patch.length;
  cache.delete(key);
  cache.set(key, diff);
  cached += diff.patch.length;
  for (const [oldest, value] of cache) {
    if (cached <= CACHE_CHARS || oldest === key) break;
    cache.delete(oldest);
    cached -= value.patch.length;
  }
}

/** Refresh: every patch of a view reloads, the old ones showing until then. */
export function staleDiffs(scopeKey: string): void {
  for (const [key, value] of cache)
    if (key.startsWith(`${scopeKey}\0`)) cache.set(key, { ...value, version: -1 });
}

// ─── Collapsed files ─────────────────────────────────────────────────────────

/** Files you opened or closed yourself, per view, for the last few views (it outlives remounts). */
const collapsed = new Map<string, ReadonlyMap<string, boolean>>();

export function readCollapsed(scopeKey: string): ReadonlyMap<string, boolean> {
  return collapsed.get(scopeKey) ?? new Map();
}

export function writeCollapsed(scopeKey: string, state: ReadonlyMap<string, boolean>): void {
  collapsed.delete(scopeKey);
  collapsed.set(scopeKey, state);
  for (const oldest of collapsed.keys()) {
    if (collapsed.size <= 8) break;
    collapsed.delete(oldest);
  }
}
