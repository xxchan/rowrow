// What changed in a workspace (roamgate #37): the last turn (against the snapshot taken
// when it started), uncommitted work, or the whole branch, as one continuous scroll of every
// file's diff (roamgate #340). Diffs load as they come near the screen, a few at a time, and
// stay cached (lib/diff-loading.ts); generated files and large diffs start collapsed behind
// "View diff"; the File index jumps to a file. Refreshes itself when the workspace's git facts
// change, which happens after every turn. Uncommitted files can be staged, unstaged, discarded
// or deleted; each action carries the file's stamp, so nothing happens to a file that changed
// since you looked (D-019).
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ORPCError } from "@orpc/client";
import { Ellipsis, LoaderCircle, RefreshCw } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { BulkAction, ChangedFile, Changes, DiffScope, FileAction } from "../../shared/schemas.ts";
import {
  addAnnotation,
  annotationsFor,
  compileFeedback,
  removeAnnotations,
  useAnnotations,
  type Annotation,
} from "../lib/annotations.ts";
import type { Client } from "../lib/connection.ts";
import { usePref, writePref } from "../lib/device-prefs.ts";
import {
  collapseReason,
  diffKey,
  diffQueue,
  readCollapsed,
  readDiff,
  Retired,
  staleDiffs,
  storeDiff,
  writeCollapsed,
  type LoadedDiff,
} from "../lib/diff-loading.ts";
import { setDraft, useApp, useClient, useDrafts } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import type { LineRef } from "./DiffView.tsx";
import { ErrorText } from "./ErrorText.tsx";
import { DiffBody, DiffLoading, FileHeader, StatusLetter } from "./FileDiffRow.tsx";
import { MenuActions, type MenuAction } from "./MenuActions.tsx";

const SCOPE_KEY = "rowrow.changesScope";

interface Confirmation {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly run: () => Promise<void>;
}

/**
 * `agentId`: whose composer review feedback goes to ("Add to message"), and whose last turn
 * the Last turn scope shows; without it the feedback can only be copied. `onDelivered` runs
 * after it was added (to close a sheet).
 */
export function ChangesView({
  workspaceId,
  agentId,
  onDelivered,
}: {
  workspaceId: string;
  agentId?: string;
  onDelivered?: () => void;
}) {
  const client = useClient();
  const gitVersion = useApp((s) => s.state?.workspaces[workspaceId]?.git?.updatedAt ?? 0);
  // Per device, and the same in every tab: picking another in one switches the others.
  const scope = usePref(SCOPE_KEY, (saved): DiffScope =>
    saved === "working" || saved === "branch" || saved === "turn" ? saved : "turn",
  );
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    scope: DiffScope;
    changes: Changes | null;
    error: string | null;
  } | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [acting, setActing] = useState(false);
  const key = `${workspaceId}:${scope}:${gitVersion}:${reload}`;
  // What a loaded diff belongs to: the turn scope is per agent, the others aren't.
  const scopeKey = `${workspaceId}\0${scope}\0${scope === "turn" ? (agentId ?? "") : ""}`;

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const changes = await client.git.changes({
          workspaceId,
          scope,
          ...(agentId === undefined ? {} : { agentId }),
        });
        if (!cancelled) setResult({ key, scope, changes, error: null });
      } catch (error) {
        if (!cancelled)
          setResult({
            key,
            scope,
            changes: null,
            error: error instanceof Error ? error.message : String(error),
          });
        report("warn", "changes.load_failed", error, { workspaceId, scope });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, scope, key, agentId]);

  const allAnnotations = useAnnotations((s) => s.items);
  const annotations = annotationsFor(allAnnotations, workspaceId);
  const current = result?.key === key ? result : null;
  // While a refresh loads, keep showing the previous result of the same scope (never another scope's).
  const changes = current?.changes ?? (result?.scope === scope ? result.changes : null);
  const total = changes?.files.reduce(
    (sum, f) => ({ add: sum.add + (f.additions ?? 0), del: sum.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  );

  /** Runs a working-tree action; shows the list it returns, or explains a refusal. */
  const act = async (label: string, run: (c: Client) => Promise<{ changes: Changes }>): Promise<void> => {
    if (client === null) return;
    setActing(true);
    try {
      const { changes: next } = await run(client);
      setResult({ key, scope: "working", changes: next, error: null });
    } catch (error) {
      if (error instanceof ORPCError && error.code === "CONFLICT") {
        toast.warning("That changed since you looked, so nothing was done. Here's the current state.");
        setReload((n) => n + 1);
      } else {
        toast.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        report("warn", "changes.action_failed", error, { workspaceId, action: label });
      }
    } finally {
      setActing(false);
    }
  };

  const fileAction = (file: ChangedFile, action: FileAction): void => {
    const stamp = file.stamp;
    if (stamp === undefined) return;
    const run = (): Promise<void> =>
      act(ACTION_LABEL[action], (c) =>
        c.git.fileAction({ workspaceId, action, path: file.path, oldPath: file.oldPath, stamp }),
      );
    if (action === "discardUnstaged")
      setConfirming({
        title: `Discard the unstaged changes to ${file.path}?`,
        description: "The edits that aren't staged are gone for good. Anything staged stays.",
        action: "Discard",
        run,
      });
    else if (action === "deleteUntracked")
      setConfirming({
        title: `Delete ${file.path}?`,
        description: "It's untracked, so git has no copy of it: it's gone for good.",
        action: "Delete",
        run,
      });
    else void run();
  };

  const bulkAction = (action: BulkAction): void => {
    const files = (changes?.files ?? []).flatMap((f) =>
      f.stamp === undefined ? [] : [{ path: f.path, oldPath: f.oldPath, stamp: f.stamp }],
    );
    const run = (): Promise<void> =>
      act(BULK_LABEL[action], (c) => c.git.bulkAction({ workspaceId, action, files }));
    if (action === "discardAllUnstaged")
      setConfirming({
        title: "Discard every unstaged change?",
        description: "Edits that aren't staged are gone for good, in every file. Staged changes stay.",
        action: "Discard all",
        run,
      });
    else if (action === "deleteAllUntracked")
      setConfirming({
        title: "Delete every untracked file?",
        description: "git has no copy of untracked files: they're gone for good.",
        action: "Delete all",
        run,
      });
    else void run();
  };

  const working = scope === "working" && changes !== null && changes.files.length > 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Tabs value={scope} onValueChange={(value) => writePref(SCOPE_KEY, value)}>
            <TabsList aria-label="Compare" className="h-8">
              <TabsTrigger value="turn" className="px-2.5 text-xs">
                Last turn
              </TabsTrigger>
              <TabsTrigger value="working" className="px-2.5 text-xs">
                Uncommitted
              </TabsTrigger>
              <TabsTrigger value="branch" className="px-2.5 text-xs">
                Branch
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex-1" />
          {(current === null || acting) && (
            <LoaderCircle
              className="size-4 animate-spin text-muted-foreground"
              aria-label="Loading changes"
            />
          )}
          {working && <BulkActions files={changes.files} onAction={bulkAction} />}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Refresh"
            onClick={() => {
              staleDiffs(scopeKey);
              setReload((n) => n + 1);
            }}
          >
            <RefreshCw />
          </Button>
        </div>
        {changes !== null && (changes.baseLabel !== null || changes.files.length > 0) && (
          <p className="truncate text-xs text-muted-foreground">
            {changes.baseLabel === null
              ? ""
              : `${scope === "turn" ? "In" : "Against"} ${changes.baseLabel}. `}
            {changes.files.length > 0 && (
              <>
                {`${changes.files.length} file${changes.files.length === 1 ? "" : "s"}, `}
                <span className="text-success">{`+${total?.add ?? 0}`}</span>{" "}
                <span className="text-destructive">{`−${total?.del ?? 0}`}</span>
                {changes.truncated ? " (first 2000 files)" : ""}
              </>
            )}
          </p>
        )}
      </div>
      <ChangeList
        workspaceId={workspaceId}
        scope={scope}
        scopeKey={scopeKey}
        {...(agentId === undefined ? {} : { agentId })}
        files={changes?.files ?? NO_FILES}
        gitVersion={gitVersion}
        reload={reload}
        annotations={annotations}
        onAction={scope === "working" ? fileAction : undefined}
      >
        {current?.error !== null && current?.error !== undefined && (
          <ErrorText className="px-1">{current.error}</ErrorText>
        )}
        {changes !== null && changes.files.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium">
              {changes.note === null ? "No changes" : "Nothing to compare"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {changes.note ??
                (scope === "turn" ? "The last turn didn't change any files." : "The working tree matches.")}
            </p>
          </div>
        )}
        {annotations.length > 0 && (
          <ReviewBar
            annotations={annotations}
            {...(agentId === undefined ? {} : { agentId })}
            {...(onDelivered === undefined ? {} : { onDelivered })}
          />
        )}
      </ChangeList>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => (open ? undefined : setConfirming(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">{confirming?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const run = confirming?.run;
                setConfirming(null);
                if (run !== undefined) void run();
              }}
            >
              {confirming?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const ACTION_LABEL: Record<FileAction, string> = {
  stage: "Stage",
  unstage: "Unstage",
  discardUnstaged: "Discard",
  deleteUntracked: "Delete",
  markResolved: "Mark resolved",
};

const BULK_LABEL: Record<BulkAction, string> = {
  stageAll: "Stage all",
  unstageAll: "Unstage all",
  discardAllUnstaged: "Discard all",
  deleteAllUntracked: "Delete all untracked",
};

/** The actions that make sense for this file's state. */
function actionsFor(file: ChangedFile): FileAction[] {
  if (file.status === "conflicted") return ["markResolved"];
  const out: FileAction[] = [];
  if (file.unstaged === true) out.push("stage");
  if (file.staged === true) out.push("unstage");
  if (file.status === "untracked") out.push("deleteUntracked");
  else if (file.unstaged === true) out.push("discardUnstaged");
  return out;
}

const NO_FILES: readonly ChangedFile[] = [];
const NO_ANNOTATIONS: readonly Annotation[] = [];
/** Diffs this far above or below the screen load ahead of it (roamgate's margin). */
const NEAR_PX = 1000;
/** At most this many of those are asked for at a time, the nearest first. */
const MAX_NEARBY = 12;
/** A diff line's height in DiffView, to hold a diff's place before it loads. */
const LINE_PX = 19;

interface LoadState {
  readonly pending: ReadonlySet<string>;
  /** By diff key; an error counts for the epoch it happened in. */
  readonly errors: ReadonlyMap<string, { epoch: string; message: string }>;
}

/**
 * Every changed file in one scroll: a sticky header each, then its diff. The diffs near the
 * screen load (nearest first, through the shared queue), stay in the cache, and a newer
 * version replaces one only once it arrived. The index above jumps to a file and says which
 * one is at the top; content loading above the screen doesn't move what you're reading.
 */
function ChangeList({
  workspaceId,
  scope,
  scopeKey,
  agentId,
  files,
  gitVersion,
  reload,
  annotations,
  onAction,
  children,
}: {
  workspaceId: string;
  scope: DiffScope;
  scopeKey: string;
  agentId?: string;
  files: readonly ChangedFile[];
  gitVersion: number;
  reload: number;
  annotations: readonly Annotation[];
  onAction: ((file: ChangedFile, action: FileAction) => void) | undefined;
  /** What goes above the files in the scroll (errors, notes, review comments). */
  children: ReactNode;
}) {
  const client = useClient();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Each file's element, by diff key. */
  const sections = useRef(new Map<string, HTMLElement>());
  const epoch = `${scopeKey}\0${gitVersion}\0${reload}`;
  const [loads, setLoads] = useState<LoadState>({ pending: new Set(), errors: new Map() });
  // For what React doesn't hold: a diff landing in the cache, files coming near the screen.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  /** Paths within NEAR_PX of the screen, as the observer last said. */
  const near = useRef(new Set<string>());
  /** Diff keys you asked to see (View diff, the index): they load even when not near. */
  const asked = useRef(new Set<string>());
  /** The file at the top of the screen and how far into it: kept there while content above changes size. */
  const anchor = useRef<{ path: string; offset: number } | null>(null);
  const [top, setTop] = useState<{ scopeKey: string; path: string } | null>(null);
  const [manual, setManual] = useState(() => ({ scopeKey, state: readCollapsed(scopeKey) }));
  const collapsedState = manual.scopeKey === scopeKey ? manual.state : readCollapsed(scopeKey);

  // The latest of these, for callbacks that outlive a render (a request's answer, a menu).
  const live = useRef({ client, epoch, gitVersion, files, collapsedState, loads, onAction });
  useLayoutEffect(() => {
    live.current = { client, epoch, gitVersion, files, collapsedState, loads, onAction };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const byPath = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const a of annotations)
      if (a.source.kind === "diff" && a.source.scope === scope)
        map.set(a.source.path, [...(map.get(a.source.path) ?? []), a]);
    return map;
  }, [annotations, scope]);

  const isCollapsed = (file: ChangedFile): boolean =>
    collapsedState.get(file.path) ?? collapseReason(file, readDiff(diffKey(scopeKey, file.path))) !== null;

  /** Asks the queue for a file's diff; `priority` when you asked for it. */
  const load = useCallback(
    (file: ChangedFile, priority: boolean): void => {
      const { client: c, epoch: at, gitVersion: version } = live.current;
      if (c === null) return;
      const key = diffKey(scopeKey, file.path);
      if (live.current.loads.pending.has(key)) {
        if (priority) diffQueue.prioritize(key);
        return;
      }
      setLoads((s) => ({ ...s, pending: new Set(s.pending).add(key) }));
      const wanted = (): boolean =>
        mounted.current &&
        live.current.epoch === at &&
        (near.current.has(file.path) || asked.current.has(key));
      void (async () => {
        try {
          const result = await diffQueue.request(
            () =>
              c.git.diff({
                workspaceId,
                scope,
                path: file.path,
                ...(agentId === undefined ? {} : { agentId }),
              }),
            wanted,
            priority,
            key,
          );
          storeDiff(key, { version, patch: result.patch, truncated: result.truncated });
          asked.current.delete(key);
        } catch (error) {
          if (error instanceof Retired) return;
          report("warn", "changes.diff_failed", error, { workspaceId, scope });
          const message = error instanceof Error ? error.message : String(error);
          setLoads((s) => ({ ...s, errors: new Map(s.errors).set(key, { epoch: at, message }) }));
        } finally {
          setLoads((s) => {
            const pending = new Set(s.pending);
            pending.delete(key);
            return { ...s, pending };
          });
        }
      })();
    },
    [workspaceId, scope, agentId, scopeKey],
  );

  // Which files are near the screen: one observer over every file, on the scroll's box.
  const paths = useMemo(() => files.map((file) => file.path).join("\0"), [files]);
  useEffect(() => {
    const root = scroller.current;
    if (root === null || paths === "") return;
    const seen = near.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.diffFile;
          if (path === undefined) continue;
          if (entry.isIntersecting) seen.add(path);
          else seen.delete(path);
        }
        rerender();
      },
      { root, rootMargin: `${NEAR_PX}px 0px` },
    );
    for (const path of paths.split("\0")) {
      const section = sections.current.get(diffKey(scopeKey, path));
      if (section !== undefined) observer.observe(section);
    }
    return () => {
      observer.disconnect();
      seen.clear();
    };
  }, [paths, scopeKey]);

  // Load what's near and open, the nearest first, a dozen at a time.
  useEffect(() => {
    const root = scroller.current;
    if (root === null || client === null) return;
    const view = root.getBoundingClientRect();
    const due = files.flatMap((file) => {
      const key = diffKey(scopeKey, file.path);
      const box = near.current.has(file.path)
        ? sections.current.get(key)?.getBoundingClientRect()
        : undefined;
      if (
        box === undefined ||
        isCollapsed(file) ||
        readDiff(key)?.version === gitVersion ||
        loads.pending.has(key) ||
        loads.errors.get(key)?.epoch === epoch
      )
        return [];
      return [{ file, distance: Math.max(0, box.top - view.bottom, view.top - box.bottom) }];
    });
    due.sort((a, b) => a.distance - b.distance);
    for (const { file } of due.slice(0, MAX_NEARBY)) load(file, false);
  });

  // Remember which file is at the top of the screen, and keep it there when diffs above it
  // load or grow (Safari has no scroll anchoring of its own, so the browser's is off). Another
  // scope has a scroll of its own, from its top.
  useEffect(() => {
    const root = scroller.current;
    const inner = content.current;
    if (root === null || inner === null) return;
    anchor.current = null;
    const at = (path: string, edge: number): { path: string; offset: number } | null => {
      const box = sections.current.get(diffKey(scopeKey, path))?.getBoundingClientRect();
      return box !== undefined && box.top <= edge + 1 && box.bottom > edge + 1
        ? { path, offset: edge - box.top }
        : null;
    };
    const onScroll = (): void => {
      const edge = root.getBoundingClientRect().top;
      let found: { path: string; offset: number } | null = null;
      for (const path of near.current) if ((found = at(path, edge)) !== null) break;
      // Right after a jump the observer may not have caught up.
      if (found === null)
        for (const file of live.current.files) if ((found = at(file.path, edge)) !== null) break;
      if (found === null) return;
      anchor.current = found;
      const path = found.path;
      setTop((current) =>
        current?.path === path && current.scopeKey === scopeKey ? current : { scopeKey, path },
      );
    };
    const resize = new ResizeObserver(() => {
      const kept = anchor.current;
      const box =
        kept === null
          ? undefined
          : sections.current.get(diffKey(scopeKey, kept.path))?.getBoundingClientRect();
      if (kept === null || box === undefined) return;
      const drift = root.getBoundingClientRect().top - box.top - kept.offset;
      if (Math.abs(drift) > 0.5) root.scrollTop -= drift;
    });
    resize.observe(inner);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resize.disconnect();
      root.removeEventListener("scroll", onScroll);
    };
  }, [scopeKey]);

  const register = useCallback((key: string, element: HTMLElement | null): void => {
    if (element === null) sections.current.delete(key);
    else sections.current.set(key, element);
  }, []);

  const setCollapsed = useCallback(
    (path: string, collapsed: boolean): void => {
      const state = new Map(live.current.collapsedState).set(path, collapsed);
      writeCollapsed(scopeKey, state);
      setManual({ scopeKey, state });
    },
    [scopeKey],
  );

  /** Opens a file's diff: it loads first in line, near or not. */
  const open = useCallback(
    (path: string): void => {
      const file = live.current.files.find((f) => f.path === path);
      if (file === undefined) return;
      setCollapsed(path, false);
      const key = diffKey(scopeKey, path);
      if (readDiff(key)?.version === live.current.gitVersion) return;
      asked.current.add(key);
      load(file, true);
    },
    [scopeKey, setCollapsed, load],
  );

  const toggle = useCallback(
    (path: string, collapsed: boolean): void => {
      if (collapsed) open(path);
      else {
        // Closing the file you're in brings its header to the top, not the files after it.
        if (anchor.current?.path === path) anchor.current = { path, offset: 0 };
        setCollapsed(path, true);
      }
    },
    [open, setCollapsed],
  );

  /** The index: the file's header to the top, its diff open. */
  const jump = (path: string): void => {
    open(path);
    const root = scroller.current;
    const box = sections.current.get(diffKey(scopeKey, path))?.getBoundingClientRect();
    if (root === null || box === undefined) return;
    anchor.current = { path, offset: 0 };
    root.scrollTop += box.top - root.getBoundingClientRect().top;
  };

  const comment = useCallback(
    (path: string, ref: LineRef, text: string): void =>
      addAnnotation(workspaceId, { kind: "diff", path, scope, ...ref }, text),
    [workspaceId, scope],
  );
  const act = useCallback(
    (file: ChangedFile, action: FileAction): void => live.current.onAction?.(file, action),
    [],
  );

  const shown =
    top?.scopeKey === scopeKey && files.some((f) => f.path === top.path) ? top.path : files[0]?.path;
  return (
    <>
      {files.length > 1 && shown !== undefined && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <span className="text-xs text-muted-foreground">File</span>
          <Select value={shown} onValueChange={jump}>
            <SelectTrigger
              size="sm"
              aria-label="Jump to changed file"
              className="h-7 min-w-0 flex-1 px-2 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-80 max-w-[min(36rem,calc(100vw-2rem))]">
              {files.map((file) => (
                <SelectItem key={file.path} value={file.path} className="font-mono text-xs">
                  <StatusLetter status={file.status} />
                  <span className="truncate">{file.path}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div key={scopeKey} ref={scroller} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <div ref={content} className="flex flex-col py-2">
          <div className="px-2">{children}</div>
          {files.map((file) => {
            const key = diffKey(scopeKey, file.path);
            const loaded = readDiff(key);
            const error = loads.errors.get(key);
            return (
              <FileSection
                key={key}
                diffKey={key}
                file={file}
                loaded={loaded}
                reason={collapseReason(file, loaded)}
                collapsed={isCollapsed(file)}
                pending={loads.pending.has(key)}
                error={error?.epoch === epoch ? error.message : null}
                annotations={byPath.get(file.path) ?? NO_ANNOTATIONS}
                register={register}
                onToggle={toggle}
                onView={open}
                onComment={comment}
                onAction={onAction === undefined ? undefined : act}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

const removeOne = (id: string): void => removeAnnotations(new Set([id]));

/** One file of the scroll: its sticky header, then its diff, a placeholder its size, or why it's skipped. */
const FileSection = memo(function FileSection({
  diffKey: key,
  file,
  loaded,
  reason,
  collapsed,
  pending,
  error,
  annotations,
  register,
  onToggle,
  onView,
  onComment,
  onAction,
}: {
  diffKey: string;
  file: ChangedFile;
  loaded: LoadedDiff | undefined;
  /** Why it starts collapsed, if it does. */
  reason: string | null;
  collapsed: boolean;
  pending: boolean;
  error: string | null;
  annotations: readonly Annotation[];
  register: (key: string, element: HTMLElement | null) => void;
  onToggle: (path: string, collapsed: boolean) => void;
  onView: (path: string) => void;
  onComment: (path: string, ref: LineRef, comment: string) => void;
  onAction: ((file: ChangedFile, action: FileAction) => void) | undefined;
}) {
  const path = file.path;
  const actions = onAction === undefined || file.stamp === undefined ? [] : actionsFor(file);
  const menu: MenuAction[] = actions.map((action) => ({
    label:
      action === "discardUnstaged"
        ? "Discard unstaged changes…"
        : action === "deleteUntracked"
          ? "Delete file…"
          : ACTION_LABEL[action],
    icon: null,
    destructive: action === "discardUnstaged" || action === "deleteUntracked",
    run: () => onAction?.(file, action),
  }));
  const staged =
    file.staged === true ? (
      <span className="shrink-0 rounded bg-success/15 px-1 text-[10px] font-medium text-success">
        {file.unstaged === true ? "partly staged" : "staged"}
      </span>
    ) : undefined;
  const addComment = useCallback(
    (ref: LineRef, text: string) => onComment(path, ref, text),
    [onComment, path],
  );
  // Before it loads, a diff holds about its own height, so the scroll doesn't jump when it lands.
  const lines = file.additions === null ? 0 : file.additions + (file.deletions ?? 0) + 8;
  return (
    <div
      ref={(element) => register(key, element)}
      role="group"
      aria-label={path}
      data-diff-file={path}
      className="flex flex-col"
    >
      <div className="sticky top-0 z-10 bg-background px-2">
        <FileHeader
          file={file}
          open={!collapsed}
          onToggle={() => onToggle(path, collapsed)}
          annotations={annotations}
          badge={staged}
          menu={menu}
          actions={
            actions.length === 0 ? undefined : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground md:opacity-0 md:group-hover/file:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100"
                    aria-label={`Actions for ${path}`}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <MenuActions
                    actions={menu}
                    parts={{ Item: DropdownMenuItem, Separator: DropdownMenuSeparator }}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
        />
      </div>
      {collapsed ? (
        reason !== null && (
          <div className="mt-1 mr-2 mb-3 ml-3 flex min-h-12 items-center justify-between gap-2 rounded-md border border-dashed px-3 text-xs text-muted-foreground">
            <span>{`${reason}; diff skipped.`}</span>
            <Button variant="outline" size="sm" className="h-7" onClick={() => onView(path)}>
              View diff
            </Button>
          </div>
        )
      ) : (
        <div className="pt-1 pr-2 pb-3 pl-3">
          {error !== null ? (
            <ErrorText className="px-2">{error}</ErrorText>
          ) : loaded === undefined ? (
            <div style={{ height: Math.max(40, lines * LINE_PX) }}>{pending && <DiffLoading />}</div>
          ) : (
            <DiffBody diff={loaded} annotations={annotations} onComment={addComment} onRemove={removeOne} />
          )}
        </div>
      )}
    </div>
  );
});

function BulkActions({
  files,
  onAction,
}: {
  files: readonly ChangedFile[];
  onAction: (action: BulkAction) => void;
}) {
  const anyUnstaged = files.some((f) => f.unstaged === true && f.status !== "conflicted");
  const anyStaged = files.some((f) => f.staged === true);
  const anyModified = files.some(
    (f) => f.unstaged === true && f.status !== "untracked" && f.status !== "conflicted",
  );
  const anyUntracked = files.some((f) => f.status === "untracked");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground">
          All files
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!anyUnstaged} onSelect={() => onAction("stageAll")}>
          Stage all
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!anyStaged} onSelect={() => onAction("unstageAll")}>
          Unstage all
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={!anyModified}
          onSelect={() => onAction("discardAllUnstaged")}
        >
          Discard all unstaged changes…
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={!anyUntracked}
          onSelect={() => onAction("deleteAllUntracked")}
        >
          Delete all untracked files…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Your review comments on this workspace: add them to the agent's message, copy, or clear. */
function ReviewBar({
  annotations,
  agentId,
  onDelivered,
}: {
  annotations: readonly Annotation[];
  agentId?: string;
  onDelivered?: () => void;
}) {
  const draft = useDrafts((s) => (agentId === undefined ? "" : (s.byAgent[agentId] ?? "")));
  const [copied, setCopied] = useState(false);
  const feedback = compileFeedback(annotations);
  const ids = new Set(annotations.map((a) => a.id));
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
      <span className="flex-1 text-xs font-medium">{`${annotations.length} review comment${annotations.length === 1 ? "" : "s"}`}</span>
      {agentId !== undefined && (
        <Button
          size="sm"
          className="h-7"
          onClick={() => {
            setDraft(agentId, draft.trim() === "" ? feedback : `${draft.trimEnd()}\n\n${feedback}`);
            removeAnnotations(ids);
            onDelivered?.();
          }}
        >
          Add to message
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        className="h-7"
        onClick={() => {
          void navigator.clipboard.writeText(feedback).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button size="sm" variant="ghost" className="h-7" onClick={() => removeAnnotations(ids)}>
        Clear
      </Button>
    </div>
  );
}
