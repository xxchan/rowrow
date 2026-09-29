// What changed in a workspace (roamgate #37): the last turn (against the snapshot taken
// when it started), uncommitted work, or the whole branch. Files load as a list; a file's
// diff loads when you open it. Refreshes itself when the workspace's git facts change,
// which happens after every turn.
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChangedFile, Changes, DiffScope } from "../../shared/schemas.ts";
import {
  addAnnotation,
  annotationsFor,
  compileFeedback,
  removeAnnotations,
  useAnnotations,
  type Annotation,
} from "../lib/annotations.ts";
import { setDraft, useApp, useClient, useDrafts } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { DiffView } from "./DiffView.tsx";
import { ErrorText } from "./ErrorText.tsx";

const SCOPE_KEY = "rowrow.changesScope";

/**
 * `agentId`: whose composer review feedback goes to ("Add to message"); without it the
 * feedback can only be copied. `onDelivered` runs after it was added (to close a sheet).
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
          {current === null && (
            <LoaderCircle
              className="size-4 animate-spin text-muted-foreground"
              aria-label="Loading changes"
            />
          )}
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
            {changes.files.length === 0 ? (
              ""
            ) : (
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
              <FileRow
                key={`${scope}:${file.path}`}
                workspaceId={workspaceId}
                scope={scope}
                file={file}
                version={key}
                {...(agentId === undefined ? {} : { agentId })}
                annotations={annotations.filter(
                  (a) => a.source.kind === "diff" && a.source.path === file.path && a.source.scope === scope,
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  conflicted: "!",
  typechange: "T",
};

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

function FileRow({
  workspaceId,
  scope,
  file,
  version,
  annotations,
  agentId,
}: {
  workspaceId: string;
  scope: DiffScope;
  file: ChangedFile;
  version: string;
  annotations: readonly Annotation[];
  agentId?: string;
}) {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<
    { version: string; patch: string; truncated: boolean } | { version: string; error: string } | null
  >(null);

  useEffect(() => {
    if (!open || client === null || diff?.version === version) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.git.diff({
          workspaceId,
          scope,
          path: file.path,
          ...(agentId === undefined ? {} : { agentId }),
        });
        if (!cancelled) setDiff({ version, ...result });
      } catch (error) {
        if (!cancelled) setDiff({ version, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, client, workspaceId, scope, file.path, version, diff?.version, agentId]);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/60"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span
          className={cn(
            "w-3.5 shrink-0 text-center font-mono text-[11px] font-semibold",
            STATUS_COLOR[file.status],
          )}
        >
          {STATUS[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
          {file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
        </span>
        {annotations.length > 0 && (
          <span className="shrink-0 text-[11px] text-primary">{`${annotations.length} comment${annotations.length === 1 ? "" : "s"}`}</span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {file.additions === null ? (
            "binary"
          ) : (
            <>
              <span className="text-success">{`+${file.additions}`}</span>{" "}
              <span className="text-destructive">{`−${file.deletions ?? 0}`}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="pt-1 pb-3 pl-1">
          {diff === null || diff.version !== version ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading diff
            </div>
          ) : "error" in diff ? (
            <ErrorText className="px-2">{diff.error}</ErrorText>
          ) : diff.patch === "" ? (
            <p className="px-2 text-xs text-muted-foreground">No textual diff (binary or too large).</p>
          ) : (
            <>
              <DiffView
                patch={diff.patch}
                annotations={annotations}
                onComment={(ref, comment) =>
                  addAnnotation(workspaceId, { kind: "diff", path: file.path, scope, ...ref }, comment)
                }
                onRemove={(id) => removeAnnotations(new Set([id]))}
              />
              {diff.truncated && <p className="px-2 pt-1 text-xs text-muted-foreground">Cut at 512 KB.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<ChangedFile["status"], string> = {
  added: "text-success",
  untracked: "text-success",
  modified: "text-warning",
  renamed: "text-warning",
  copied: "text-warning",
  typechange: "text-warning",
  deleted: "text-destructive",
  conflicted: "text-destructive",
};
