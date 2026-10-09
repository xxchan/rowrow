// A workspace's checkout: browse it as a tree (files.list, colored by git status) or find
// anything in it (roamgate #227): file names and contents in one search, .gitignore honored
// (files.search, D-021). A file opens a read-only preview, at the matching line for a search
// hit, in a tab (roamgate #309, lib/file-tabs.ts): a single click uses the temporary tab, a
// double-click keeps it. As wide as roamgate's split (640 px) the tree and the preview sit
// side by side; narrower, the preview covers the tree and Back returns to it. "Mention" puts
// the path in the agent's message, since agents read files by path. A tree row's menu
// (right-click, long press, or its ⋯) and the preview download a file, or a folder as .tar.gz
// (roamgate #312). The History tab opens the same preview on a commit's file as it was then
// (`at`). A path clicked in an agent's transcript, or Open in Files on a diff, opens here as a
// single click in the tree does, at its line (D-054, lib/file-links.ts).
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { ArrowLeft, AtSign, Copy, Download, FileText as FileIcon, LoaderCircle, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import type { ChangedFile, FileText, SearchResult } from "../../shared/schemas.ts";
import { readPref, writePref } from "../lib/device-prefs.ts";
import { downloadFromWorkspace } from "../lib/download.ts";
import { listFiles, onFileOpen, pendingFileOpen, tookFileOpen, type FileOpen } from "../lib/file-links.ts";
import { closeTab, keepTab, openTab, parseTabs, pruneTabs, type FileTabs } from "../lib/file-tabs.ts";
import { setDraft, useApp, useClient, useDrafts } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { ErrorText } from "./ErrorText.tsx";
import { FileTabStrip } from "./FileTabs.tsx";
import { copyText, MenuActions, type MenuAction } from "./MenuActions.tsx";
import { MermaidDiagram, mermaidRenderer } from "./MermaidDiagram.tsx";

/** Where the tree and the preview sit side by side (roamgate's inspector split). */
const SPLIT_PX = 640;

const tabsKey = (workspaceId: string): string => `rowrow.fileTabs.${workspaceId}`;

interface Opened {
  readonly workspaceId: string;
  readonly tabs: FileTabs;
  /** Narrow: the preview covers the tree. */
  readonly shown: boolean;
  /** The line the last opening asked for (a search hit, a path's line): a new one each time. */
  readonly line: { path: string; line: number } | null;
}

/**
 * A workspace's tabs as this device left them: its file showing again, over the tree; or the
 * file a click asked for before this view mounted, opened in them.
 */
function restore(workspaceId: string): Opened {
  const tabs = parseTabs(readPref(tabsKey(workspaceId)));
  const asked = pendingFileOpen(workspaceId);
  return asked === null
    ? { workspaceId, tabs, shown: tabs.active !== null, line: null }
    : opening({ workspaceId, tabs, shown: false, line: null }, asked.path, asked.line);
}

/** Shows a file in the temporary tab (or its own), over the tree, at `line`. */
function opening(opened: Opened, path: string, line: number | null): Opened {
  return {
    ...opened,
    tabs: openTab(opened.tabs, path),
    shown: true,
    line: line === null ? null : { path, line },
  };
}

export function FilesTab({ workspaceId, agentId }: { workspaceId: string; agentId?: string }) {
  const client = useClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [result, setResult] = useState<{
    query: string;
    data: SearchResult | null;
    error: string | null;
  } | null>(null);
  const [state, setState] = useState(() => restore(workspaceId));
  const opened = state.workspaceId === workspaceId ? state : restore(workspaceId);
  // What the tree last listed: tabs of files that are gone drop out.
  const [listed, setListed] = useState<{ workspaceId: string; paths: ReadonlySet<string> } | null>(null);
  const tabs =
    listed?.workspaceId === workspaceId
      ? pruneTabs(opened.tabs, (path) => listed.paths.has(path))
      : opened.tabs;
  const box = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(false);
  const panelId = useId();

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      // Hidden (another inspector tab) measures 0: keep the layout it had.
      if (entry !== undefined && entry.contentRect.width > 0) setSplit(entry.contentRect.width >= SPLIT_PX);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** The next tabs (stored for this workspace), and whether the preview covers the tree. */
  const update = (change: (opened: Opened) => Partial<Omit<Opened, "workspaceId">>): void => {
    const now = { ...opened, tabs };
    const next = { ...now, ...change(now) };
    if (next.tabs !== opened.tabs) writePref(tabsKey(workspaceId), JSON.stringify(next.tabs));
    setState(next);
  };
  const open = (path: string, line: number | null = null): void => update((o) => opening(o, path, line));
  const keep = (path: string): void => update((o) => ({ tabs: keepTab(o.tabs, path) }));
  const select = (path: string): void => update((o) => ({ tabs: openTab(o.tabs, path), shown: true }));
  const close = (path: string): void => update((o) => ({ tabs: closeTab(o.tabs, path) }));
  // A file asked for from elsewhere: opened here, once. One asked for before this view mounted
  // opened with it (restore), and its tab is kept like any other.
  const asked = useEffectEvent((request: FileOpen) => {
    if (request.workspaceId !== workspaceId) return;
    tookFileOpen(request.id);
    open(request.path, request.line);
  });
  const took = useEffectEvent((request: FileOpen) => {
    tookFileOpen(request.id);
    writePref(tabsKey(workspaceId), JSON.stringify(tabs));
  });
  useEffect(() => {
    const before = pendingFileOpen(workspaceId);
    if (before !== null) took(before);
    return onFileOpen(asked);
  }, [workspaceId]);
  const onListed = useCallback(
    (paths: readonly string[]): void => setListed({ workspaceId, paths: new Set(paths) }),
    [workspaceId],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (client === null || debounced === "") return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await client.files.search({ workspaceId, query: debounced, kind: "all" });
        if (!cancelled) setResult({ query: debounced, data, error: null });
      } catch (error) {
        if (!cancelled)
          setResult({
            query: debounced,
            data: null,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, debounced]);

  const shown = debounced === "" ? null : result;
  const loading = debounced !== "" && result?.query !== debounced;
  const active = tabs.active;
  const covering = !split && opened.shown && active !== null;
  return (
    <div ref={box} className="flex h-full min-h-0">
      {/* Hidden, not unmounted, under a preview: the tree keeps its open folders and scroll. */}
      <div
        ref={nav}
        tabIndex={-1}
        className={cn(
          "flex min-h-0 min-w-0 flex-col outline-none",
          split ? "w-[38%] max-w-80 min-w-48 shrink-0 border-r" : "flex-1",
          covering && "hidden",
        )}
      >
        <div className="shrink-0 border-b px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search files"
              placeholder="Search file names and contents"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="h-8 pl-8"
            />
            {loading && (
              <LoaderCircle className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>
        {debounced === "" ? (
          <FileBrowser
            workspaceId={workspaceId}
            onOpen={(path) => open(path)}
            onKeep={keep}
            onListed={onListed}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {shown?.error !== null && shown?.error !== undefined ? (
              <ErrorText className="px-1">{shown.error}</ErrorText>
            ) : shown?.data === null || shown?.data === undefined ? null : (
              <Results data={shown.data} onOpen={open} onKeep={keep} />
            )}
          </div>
        )}
      </div>
      {(split || covering) && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <FileTabStrip
            tabs={tabs}
            panelId={panelId}
            onSelect={select}
            onKeep={keep}
            onClose={close}
            // Not the search box: on a phone that would open the keyboard.
            onEmpty={() => nav.current?.focus()}
          />
          <div
            id={panelId}
            role="tabpanel"
            aria-label={active ?? "File preview"}
            className="flex min-h-0 flex-1 flex-col"
          >
            {active === null ? (
              <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                Open a file from the tree or a search to preview it here.
              </p>
            ) : (
              <FilePreview
                key={active}
                workspaceId={workspaceId}
                path={active}
                line={opened.line?.path === active ? opened.line : null}
                {...(split ? {} : { onBack: () => update(() => ({ shown: false })) })}
                {...(agentId === undefined ? {} : { agentId })}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Every file of the checkout as a tree, git's view of each colored in; clicking a file opens
 * it, double-clicking keeps its tab. `onListed` hears every listing that wasn't cut short.
 */
function FileBrowser({
  workspaceId,
  onOpen,
  onKeep,
  onListed,
}: {
  workspaceId: string;
  onOpen: (path: string) => void;
  onKeep: (path: string) => void;
  onListed: (paths: readonly string[]) => void;
}) {
  const client = useClient();
  const gitVersion = useApp((s) => s.state?.workspaces[workspaceId]?.git?.updatedAt ?? 0);
  const { model } = useFileTree({
    paths: [],
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: "standard",
    // Right-click, Shift+F10, or the ⋯ that follows the row under the pointer or in focus.
    composition: { contextMenu: { enabled: true, triggerMode: "both", buttonVisibility: "when-needed" } },
  });
  const shown = useRef<{ workspaceId: string; paths: readonly string[] } | null>(null);
  const [loaded, setLoaded] = useState<{
    workspaceId: string;
    count: number;
    truncated: boolean;
    error: string | null;
  } | null>(null);

  // Reloads when git reports a change: the status colors always, the tree only when the
  // files changed, keeping the folders that were open.
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [files, changes] = await Promise.all([
          listFiles(client, workspaceId, gitVersion),
          client.git.changes({ workspaceId, scope: "working" }).catch((error: unknown) => {
            report("warn", "files.tree_status_failed", error, { workspaceId, gitVersion });
            return null;
          }),
        ]);
        if (cancelled) return;
        const before = shown.current?.workspaceId === workspaceId ? shown.current.paths : null;
        if (before === null || !samePaths(before, files.paths)) {
          model.resetPaths(files.paths, {
            initialExpandedPaths: before === null ? [] : openFolders(model, before),
          });
          shown.current = { workspaceId, paths: files.paths };
        }
        model.setGitStatus(changes === null ? [] : changes.files.flatMap(gitStatus));
        setLoaded({ workspaceId, count: files.paths.length, truncated: files.truncated, error: null });
        if (!files.truncated) onListed(files.paths);
      } catch (error) {
        report("warn", "files.list_failed", error, { workspaceId, gitVersion });
        if (!cancelled)
          setLoaded({
            workspaceId,
            count: 0,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, model, workspaceId, gitVersion, onListed]);

  const longPress = useLongPress();
  const state = loaded?.workspaceId === workspaceId ? loaded : null;
  if (state?.error !== null && state?.error !== undefined)
    return <ErrorText className="px-3 py-2">{state.error}</ErrorText>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {state === null && (
        <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Loading files
        </div>
      )}
      {state?.count === 0 && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">No files in this checkout yet.</p>
      )}
      <FileTree
        model={model}
        aria-label="Files"
        className={cn(
          "file-tree min-h-0 flex-1 py-1 [-webkit-touch-callout:none]",
          (state === null || state.count === 0) && "hidden",
        )}
        // Rows are buttons inside the tree's shadow root: find the clicked one. Selection
        // events miss a second click on the same file, so this opens it every time.
        onClick={(event) => {
          const row = rowOf(event.nativeEvent);
          if (row?.dataset.itemType === "file" && row.dataset.itemPath !== undefined)
            onOpen(row.dataset.itemPath);
        }}
        onDoubleClick={(event) => {
          const row = rowOf(event.nativeEvent);
          if (row?.dataset.itemType === "file" && row.dataset.itemPath !== undefined)
            onKeep(row.dataset.itemPath);
        }}
        {...longPress}
        renderContextMenu={(item, context) => {
          // The tree names a folder with a trailing slash.
          const path = item.path.replace(/\/+$/, "");
          return (
            <TreeItemMenu
              path={path}
              onClose={() => context.close()}
              actions={[
                {
                  label: item.kind === "directory" ? "Download directory" : "Download file",
                  icon: <Download />,
                  run: () => void downloadFromWorkspace(workspaceId, path, item.kind),
                },
                { label: "Copy path", icon: <Copy />, run: () => void copyText(path, "Path") },
              ]}
            />
          );
        }}
      />
      {state?.truncated === true && (
        <p className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
          Showing the first {state.count.toLocaleString()} files: search finds the rest.
        </p>
      )}
    </div>
  );
}

/** The tree row an event happened on (rows are buttons in the tree's shadow root). */
function rowOf(event: Event): HTMLElement | null {
  for (const target of event.composedPath())
    if (target instanceof HTMLElement && target.dataset.itemPath !== undefined) return target;
  return null;
}

const LONG_PRESS_MS = 550;

/**
 * A long press on a row opens its menu, as a right-click does. Android sends `contextmenu` on a
 * long press by itself; iOS doesn't, so a held, unmoved touch sends one to the row.
 */
function useLongPress(): Pick<
  HTMLAttributes<HTMLElement>,
  "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel" | "onContextMenu"
> {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(
    null,
  );
  const cancel = useCallback((): void => {
    if (press.current !== null) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  return {
    onTouchStart: (event) => {
      cancel();
      const touch = event.touches[0];
      const row = rowOf(event.nativeEvent);
      if (event.touches.length !== 1 || touch === undefined || row === null) return;
      const { clientX: x, clientY: y } = touch;
      const timer = setTimeout(() => {
        if (press.current === null) return;
        press.current.fired = true;
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          }),
        );
      }, LONG_PRESS_MS);
      press.current = { timer, x, y, fired: false };
    },
    onTouchMove: (event) => {
      const touch = event.touches[0];
      const at = press.current;
      if (at === null || touch === undefined) return;
      if (Math.hypot(touch.clientX - at.x, touch.clientY - at.y) > 10) cancel();
    },
    // The press that opened the menu doesn't also open the file.
    onTouchEnd: (event) => {
      if (press.current?.fired === true) event.preventDefault();
      cancel();
    },
    onTouchCancel: cancel,
    // Android's own long-press menu came first: the timer's would be a second one.
    onContextMenu: () => {
      if (press.current?.fired === false) cancel();
    },
  };
}

/** A tree row's menu, in the slot the tree opens at the row (or the pointer). */
function TreeItemMenu({
  path,
  actions,
  onClose,
}: {
  path: string;
  actions: MenuAction[];
  onClose: () => void;
}) {
  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden="true" className="block size-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60"
        aria-label={`Actions for ${path}`}
        // Clicks in the portaled menu aren't outside the tree's menu (see @pierre/trees).
        data-file-tree-context-menu-root="true"
        // The tree puts focus back on the row itself.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel className="truncate">{path}</DropdownMenuLabel>
        <MenuActions actions={actions} parts={{ Item: DropdownMenuItem, Separator: DropdownMenuSeparator }} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const samePaths = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((path, i) => path === b[i]);

/** The folders open in the tree, among the ancestors of `paths`. */
function openFolders(model: ReturnType<typeof useFileTree>["model"], paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths)
    for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) folders.add(path.slice(0, at));
  return [...folders].filter((folder) => {
    const item = model.getItem(folder);
    return item !== null && "isExpanded" in item && item.isExpanded();
  });
}

/** How the tree colors a changed file; deleted files aren't in it. */
function gitStatus(
  file: ChangedFile,
): { path: string; status: "added" | "modified" | "renamed" | "untracked" }[] {
  switch (file.status) {
    case "deleted":
      return [];
    case "added":
    case "copied":
      return [{ path: file.path, status: "added" }];
    case "renamed":
    case "untracked":
      return [{ path: file.path, status: file.status }];
    case "modified":
    case "conflicted":
    case "typechange":
      return [{ path: file.path, status: "modified" }];
  }
}

function Results({
  data,
  onOpen,
  onKeep,
}: {
  data: SearchResult;
  onOpen: (path: string, line: number | null) => void;
  onKeep: (path: string) => void;
}) {
  const byFile = new Map<string, SearchResult["lines"]>();
  for (const hit of data.lines) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
  if (data.names.length === 0 && data.lines.length === 0)
    return (
      <p className="px-4 py-10 text-center text-sm text-muted-foreground">{data.note ?? "No matches."}</p>
    );
  return (
    <div className="flex flex-col gap-4">
      {data.names.length > 0 && (
        <Group label={`Files · ${data.names.length}${data.namesTruncated ? "+" : ""}`}>
          {data.names.map(({ path }) => (
            <button
              key={path}
              type="button"
              onClick={() => onOpen(path, null)}
              onDoubleClick={() => onKeep(path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-[12.5px]">
                <span className="text-muted-foreground">{dirname(path)}</span>
                {basename(path)}
              </span>
            </button>
          ))}
        </Group>
      )}
      {byFile.size > 0 && (
        <Group label={`Matches · ${data.lines.length}${data.linesTruncated ? "+" : ""}`}>
          {[...byFile].map(([path, hits]) => (
            <div key={path} className="flex flex-col">
              <button
                type="button"
                onClick={() => onOpen(path, null)}
                onDoubleClick={() => onKeep(path)}
                className="truncate rounded-md px-2 pt-1.5 pb-0.5 text-left font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
              >
                {path}
              </button>
              {hits.map((hit) => (
                <button
                  key={hit.line}
                  type="button"
                  onClick={() => onOpen(path, hit.line)}
                  onDoubleClick={() => onKeep(path)}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-accent/60"
                >
                  <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {hit.line}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[12px]">
                    {highlight(hit.text, data.query)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </Group>
      )}
      {data.note !== null && <p className="px-2 text-xs text-muted-foreground">{data.note}</p>}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** Marks the query in a line the way the server matched it: case-insensitive unless it has an uppercase letter. */
function highlight(text: string, query: string): ReactNode {
  const smart = query === query.toLowerCase();
  const at = (smart ? text.toLowerCase() : text).indexOf(smart ? query.toLowerCase() : query);
  if (at < 0) return text.trim();
  return (
    <>
      {text.slice(0, at).trimStart()}
      <mark className="rounded-sm bg-warning/30 text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

const dirname = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const LINE = 20; // px, the preview's line height (leading-5)
const plugins = { code, cjk, renderers: [mermaidRenderer] };

/**
 * A read-only view of one file, scrolled to `line` (highlighted) when given. With `at`, the
 * file as it was in a commit: labeled with the commit, and nothing to do to it but read it and
 * copy its path (Download and Mention are for the checkout as it is). Markdown and Mermaid
 * files (.mmd, .mermaid) open drawn, with their source a tab away.
 */
export function FilePreview({
  workspaceId,
  path,
  line,
  onBack,
  backLabel = "Back to results",
  agentId,
  at,
}: {
  workspaceId: string;
  path: string;
  /** The line to show (a new object scrolls to it again). */
  line: { readonly line: number } | null;
  /** Back to the tree or the results (none when they're beside it). */
  onBack?: () => void;
  backLabel?: string;
  agentId?: string;
  /** The commit to read it at (files.read `rev`), and what to say about that version. */
  at?: { rev: string; note: string };
}) {
  const client = useClient();
  const rev = at?.rev;
  const key = `${rev ?? ""}:${path}`;
  const [file, setFile] = useState<{ key: string; data: FileText | null; error: string | null } | null>(null);
  const markdown = /\.(md|markdown|mdx)$/i.test(path);
  const diagram = /\.(mmd|mermaid)$/i.test(path);
  const [view, setView] = useState<"rendered" | "source">(
    (markdown || diagram) && line === null ? "rendered" : "source",
  );
  // A line asked for: show it in the source, where lines are.
  const [lineShown, setLineShown] = useState(line);
  if (lineShown !== line) {
    setLineShown(line);
    if (line !== null) setView("source");
  }
  const scroller = useRef<HTMLDivElement>(null);
  const draft = useDrafts((s) => (agentId === undefined ? "" : (s.byAgent[agentId] ?? "")));

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await client.files.read({ workspaceId, path, ...(rev === undefined ? {} : { rev }) });
        if (!cancelled) setFile({ key, data, error: null });
      } catch (error) {
        if (!cancelled)
          setFile({ key, data: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, path, rev, key]);

  const text = file?.key === key ? file.data?.text : undefined;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (text === undefined || line === null || view !== "source" || element === null) return;
    element.scrollTop = Math.max(0, (line.line - 1) * LINE - element.clientHeight / 3);
  }, [text, line, view]);

  const lines = text === undefined ? 0 : text.split("\n").length;
  const download = (): void => void downloadFromWorkspace(workspaceId, path, "file");
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={at === undefined ? "File preview" : "Historical file preview"}
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        {onBack !== undefined && (
          <Button variant="ghost" size="icon" className="size-8" aria-label={backLabel} onClick={onBack}>
            <ArrowLeft />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-[12.5px]" title={path}>
          {path}
        </span>
        {at !== undefined && (
          <span
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={`As of commit ${at.rev}`}
          >
            {`@ ${at.rev.slice(0, 7)}`}
          </span>
        )}
        {(markdown || diagram) && (
          <Tabs value={view} onValueChange={(value) => setView(value as "rendered" | "source")}>
            <TabsList className="h-7">
              <TabsTrigger value="rendered" className="px-2 text-[11px]">
                {diagram ? "Diagram" : "Preview"}
              </TabsTrigger>
              <TabsTrigger value="source" className="px-2 text-[11px]">
                Source
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Copy the path"
          onClick={() => void navigator.clipboard.writeText(path).then(() => toast.success("Path copied"))}
        >
          <Copy />
        </Button>
        {at === undefined && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Download"
            title="Download"
            onClick={download}
          >
            <Download />
          </Button>
        )}
        {agentId !== undefined && at === undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={() => {
              const mention = `\`${path}\``;
              setDraft(agentId, draft.trim() === "" ? `${mention} ` : `${draft.trimEnd()} ${mention} `);
              toast.success("Added to your message");
            }}
          >
            <AtSign /> Mention
          </Button>
        )}
      </div>
      {at !== undefined && (
        <p className="shrink-0 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          {at.note}
        </p>
      )}
      {file === null || file.key !== key ? (
        <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />{" "}
          {at === undefined ? `Loading ${path}` : "Loading historical file"}
        </div>
      ) : file.error !== null || file.data === null ? (
        <div className="flex flex-col items-start gap-2 px-4 py-3">
          <ErrorText>{file.error ?? "Couldn't read it."}</ErrorText>
          {/* No preview (binary, say) is no reason not to have the file. */}
          {at === undefined && (
            <Button variant="outline" size="sm" onClick={download}>
              <Download /> Download
            </Button>
          )}
        </div>
      ) : view === "rendered" && diagram ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <MermaidDiagram code={file.data.text} fill />
        </div>
      ) : view === "rendered" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Streamdown
            className="text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold"
            plugins={plugins}
            shikiTheme={["github-light", "tokyo-night"]}
            linkSafety={{ enabled: false }}
            mode="static"
          >
            {file.data.text}
          </Streamdown>
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-code">
          <div className="relative flex min-w-max font-mono text-[12px] leading-5">
            {line !== null && (
              <div
                aria-hidden="true"
                data-line={line.line}
                className="pointer-events-none absolute inset-x-0 bg-primary/15"
                style={{ top: 8 + (line.line - 1) * LINE, height: LINE }}
              />
            )}
            <pre className="sticky left-0 z-10 border-r bg-code px-3 py-2 text-right text-muted-foreground/60 select-none">
              {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
            </pre>
            <pre className={cn("px-3 py-2", file.data.truncated && "pb-0")}>{file.data.text}</pre>
          </div>
          {file.data.truncated && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {`Stopped at 1 MiB of ${Math.round(file.data.size / 1024)} KB.`}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
