// Paths the agent mentions, opened in the inspector (D-054, src/shared/file-refs.ts). Whether a
// path names a file is checked against files.list, which is asked once per workspace and git
// change however many views want it (the transcript's links, the Files tree). A click asks the
// inspector of that workspace to show the file in its temporary tab, at the line the path
// names: the agent page opens the inspector, the inspector turns to Files, and the Files view
// opens the file, now or when it mounts, and takes the request so nothing opens it twice.
import { useEffect, useState } from "react";
import { checkoutFiles, type CheckoutFiles } from "../../shared/file-refs.ts";
import type { FileList } from "../../shared/schemas.ts";
import type { Client } from "./connection.ts";
import { useApp, useClient } from "./store.ts";
import { report } from "./telemetry.ts";

const lists = new Map<string, { version: number; list: Promise<FileList> }>();

/** A workspace's files.list as of a git change (`version`): one request, however many ask. */
export function listFiles(client: Client, workspaceId: string, version: number): Promise<FileList> {
  const cached = lists.get(workspaceId);
  if (cached?.version === version) return cached.list;
  const list = client.files.list({ workspaceId });
  lists.set(workspaceId, { version, list });
  // A failure isn't kept: the next one to ask tries again (and hears why).
  list.catch(() => {
    if (lists.get(workspaceId)?.list === list) lists.delete(workspaceId);
  });
  return list;
}

/**
 * The workspace's checkout for linking paths, kept current as git reports changes; null for
 * a folder that isn't a git checkout, until the list arrives, or when it couldn't be read. A
 * list cut short (50,000 files) still links the files it has.
 */
export function useCheckoutFiles(workspaceId: string): CheckoutFiles | null {
  const client = useClient();
  const root = useApp((s) => s.state?.workspaces[workspaceId]?.git?.repoRoot);
  const cwd = useApp((s) => s.state?.workspaces[workspaceId]?.path);
  const version = useApp((s) => s.state?.workspaces[workspaceId]?.git?.updatedAt ?? 0);
  const [loaded, setLoaded] = useState<{
    key: string;
    paths: readonly string[];
    files: CheckoutFiles;
  } | null>(null);
  const key = `${workspaceId}\n${root ?? ""}\n${cwd ?? ""}`;

  useEffect(() => {
    if (client === null || root === undefined || cwd === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const { paths } = await listFiles(client, workspaceId, version);
        if (cancelled) return;
        // The same files keep the same links: git reports changes to their contents too.
        setLoaded((before) =>
          before?.key === key && samePaths(before.paths, paths)
            ? before
            : { key, paths, files: checkoutFiles(root, cwd, paths) },
        );
      } catch (error) {
        report("warn", "files.links_failed", error, { workspaceId, version });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, root, cwd, version, key]);

  return loaded?.key === key ? loaded.files : null;
}

const samePaths = (a: readonly string[], b: readonly string[]): boolean =>
  a === b || (a.length === b.length && a.every((path, i) => path === b[i]));

/** A file to show in the inspector, asked for by a click on its path. */
export interface FileOpen {
  readonly id: number;
  readonly workspaceId: string;
  /** Relative to the checkout's top. */
  readonly path: string;
  readonly line: number | null;
  readonly at: number;
}

const listeners = new Set<(request: FileOpen) => void>();
let pending: FileOpen | null = null;
let nextId = 1;

/** Shows a workspace's file in its inspector's Files view, in the temporary tab. */
export function openFile(workspaceId: string, path: string, line: number | null = null): void {
  const request = { id: nextId++, workspaceId, path, line, at: Date.now() };
  pending = request;
  for (const listener of listeners) listener(request);
}

/** Hears each file asked for, as it is. */
export function onFileOpen(listener: (request: FileOpen) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The workspace's file asked for that no Files view took yet: the inspector opened for it, and
 * its Files view (loaded after the app) mounts after the click. A minute later it's forgotten.
 */
export function pendingFileOpen(workspaceId: string): FileOpen | null {
  return pending !== null && pending.workspaceId === workspaceId && Date.now() - pending.at < 60_000
    ? pending
    : null;
}

/** A Files view opened it: nothing opens it again (this one remounted, or another one). */
export function tookFileOpen(id: number): void {
  if (pending?.id === id) pending = null;
}
