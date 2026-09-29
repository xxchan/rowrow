// What changed in a workspace (roamgate #37): the last turn (against the snapshot taken
// when it started), uncommitted work, or the whole branch. Files load as a list; a file's
// diff loads when you open it. Refreshes itself when the workspace's git facts change,
// which happens after every turn. Uncommitted files can be staged, unstaged, discarded or
// deleted; each action carries the file's stamp, so nothing happens to a file that changed
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ORPCError } from "@orpc/client";
import { Ellipsis, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { setDraft, useApp, useClient, useDrafts } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { ErrorText } from "./ErrorText.tsx";
import { FileDiffRow } from "./FileDiffRow.tsx";
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
  const [scope, setScope] = useState<DiffScope>(() => {
    const saved = localStorage.getItem(SCOPE_KEY);
    return saved === "working" || saved === "branch" || saved === "turn" ? saved : "turn";
  });
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
          <Tabs
            value={scope}
            onValueChange={(value) => {
              const next = value as DiffScope;
              setScope(next);
              localStorage.setItem(SCOPE_KEY, next);
            }}
          >
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
            onClick={() => setReload((n) => n + 1)}
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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
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
        {changes !== null && (
          <div className="flex flex-col">
            {changes.files.map((file) => (
              <ChangedFileRow
                key={`${scope}:${file.path}`}
                workspaceId={workspaceId}
                scope={scope}
                file={file}
                version={key}
                {...(agentId === undefined ? {} : { agentId })}
                annotations={annotations.filter(
                  (a) => a.source.kind === "diff" && a.source.path === file.path && a.source.scope === scope,
                )}
                onAction={scope === "working" ? (action) => fileAction(file, action) : undefined}
              />
            ))}
          </div>
        )}
      </div>
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

function ChangedFileRow({
  workspaceId,
  scope,
  file,
  version,
  annotations,
  agentId,
  onAction,
}: {
  workspaceId: string;
  scope: DiffScope;
  file: ChangedFile;
  version: string;
  annotations: readonly Annotation[];
  agentId?: string;
  onAction: ((action: FileAction) => void) | undefined;
}) {
  const client = useClient();
  const load = useCallback(async () => {
    if (client === null) throw new Error("not connected");
    return client.git.diff({
      workspaceId,
      scope,
      path: file.path,
      ...(agentId === undefined ? {} : { agentId }),
    });
  }, [client, workspaceId, scope, file.path, agentId]);
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
    run: () => onAction?.(action),
  }));
  const staged =
    file.staged === true ? (
      <span className="shrink-0 rounded bg-success/15 px-1 text-[10px] font-medium text-success">
        {file.unstaged === true ? "partly staged" : "staged"}
      </span>
    ) : undefined;
  return (
    <FileDiffRow
      file={file}
      version={version}
      load={load}
      annotations={annotations}
      onComment={(ref, comment) =>
        addAnnotation(workspaceId, { kind: "diff", path: file.path, scope, ...ref }, comment)
      }
      onRemove={(id) => removeAnnotations(new Set([id]))}
      badge={staged}
      menu={menu}
      actions={
        actions.length === 0 || onAction === undefined ? undefined : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground md:opacity-0 md:group-hover/file:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100"
                aria-label={`Actions for ${file.path}`}
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
  );
}

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
