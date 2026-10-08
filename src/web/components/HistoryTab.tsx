// A workspace's history (roamgate #229): the branch's pull request and its checks (#228),
// then commits, newest first; a commit opens to its message and files, each with its diff
// and a preview of the file as it was in that commit (#304).
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangedFile,
  CommitChanges,
  CommitPage,
  CommitSummary,
  PullRequest,
  PullRequestStatus,
} from "../../shared/schemas.ts";
import { ago } from "../lib/format.ts";
import { useApp, useClient } from "../lib/store.ts";
import { ErrorText } from "./ErrorText.tsx";
import { FileDiffRow } from "./FileDiffRow.tsx";

// The preview comes with the Files tab's code (the tree, Markdown), loaded when first opened.
const FilePreview = lazy(async () => ({ default: (await import("./FilesTab.tsx")).FilePreview }));

export function HistoryTab({ workspaceId }: { workspaceId: string }) {
  const client = useClient();
  const gitVersion = useApp((s) => s.state?.workspaces[workspaceId]?.git?.updatedAt ?? 0);
  const key = `${workspaceId}:${gitVersion}`;
  const [history, setHistory] = useState<{ key: string; pages: CommitPage[]; error: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.git.log({ workspaceId });
        if (!cancelled) setHistory({ key, pages: [page], error: null });
      } catch (error) {
        if (!cancelled)
          setHistory({ key, pages: [], error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, key]);

  if (selected !== null)
    return <CommitView workspaceId={workspaceId} sha={selected} onBack={() => setSelected(null)} />;

  const pages = history?.pages ?? [];
  const last = pages.at(-1);
  const commits = pages.flatMap((p) => p.commits);
  const more = async (): Promise<void> => {
    if (client === null || last?.nextCursor === null || last === undefined) return;
    setLoadingMore(true);
    try {
      const page = await client.git.log({ workspaceId, cursor: last.nextCursor });
      setHistory((h) => (h === null || h.key !== key ? h : { ...h, pages: [...h.pages, page] }));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <PullRequestCard workspaceId={workspaceId} />
      {history === null ? (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Loading history
        </div>
      ) : history.error !== null ? (
        <ErrorText className="px-2">{history.error}</ErrorText>
      ) : (
        <>
          <p className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {pages[0]?.branch === null || pages[0]?.branch === undefined
              ? "Commits (detached HEAD)"
              : `Commits on ${pages[0].branch}`}
          </p>
          {commits.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {pages[0]?.note ?? "No commits yet."}
            </p>
          )}
          <ul className="flex flex-col">
            {commits.map((commit) => (
              <li key={commit.sha}>
                <CommitRow commit={commit} onOpen={() => setSelected(commit.sha)} />
              </li>
            ))}
          </ul>
          {last?.nextCursor !== null && last?.nextCursor !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full text-muted-foreground"
              onClick={() => void more()}
            >
              {loadingMore && <LoaderCircle className="animate-spin" />} Load older commits
            </Button>
          )}
          {last?.nextCursor === null && last.shallow && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              A shallow clone: older commits aren't in it.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function CommitRow({ commit, onOpen }: { commit: CommitSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
    >
      <span className="truncate text-[13px]">{commit.subject}</span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{commit.sha.slice(0, 7)}</span>
        <span>·</span>
        <span className="truncate">{commit.authorName}</span>
        <span>·</span>
        <span className="shrink-0 tabular-nums">{ago(commit.authorDate)}</span>
        {commit.parents.length > 1 && <GitMerge className="size-3" aria-label="Merge commit" />}
      </span>
    </button>
  );
}

/** A file previewed as of a commit: where to read it, what to say about it, and its row. */
interface Historical {
  readonly path: string;
  readonly rev: string;
  readonly note: string;
  readonly row: string;
}

/**
 * The version of a commit's file worth showing: the file as the commit left it, or, when the
 * commit deleted it, as it was just before (in the parent the commit is compared with).
 */
function historical(detail: CommitChanges, file: ChangedFile): Historical | null {
  const { commit } = detail;
  const at = commit.sha.slice(0, 7);
  if (file.status !== "deleted")
    return {
      path: file.path,
      rev: commit.sha,
      note: `As of commit ${at}: ${commit.subject}. Read-only.`,
      row: file.path,
    };
  if (detail.base === null) return null;
  const parent = commit.parents.length > 1 ? "first parent" : "parent";
  return {
    path: file.oldPath ?? file.path,
    rev: detail.base,
    note: `Deleted in commit ${at}: this is the file as of its ${parent} ${detail.base.slice(0, 7)}. Read-only.`,
    row: file.path,
  };
}

function CommitView({ workspaceId, sha, onBack }: { workspaceId: string; sha: string; onBack: () => void }) {
  const client = useClient();
  const [detail, setDetail] = useState<{ data: CommitChanges | null; error: string | null } | null>(null);
  const [preview, setPreview] = useState<Historical | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const backTo = useRef<string | null>(null);

  // Back from a preview: the commit as it was, with that file's diff open and in view.
  useEffect(() => {
    const row = backTo.current;
    if (preview !== null || row === null) return;
    backTo.current = null;
    for (const element of list.current?.querySelectorAll<HTMLElement>("[data-file-row]") ?? [])
      if (element.dataset.fileRow === row) element.scrollIntoView({ block: "nearest" });
  }, [preview]);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await client.git.commit({ workspaceId, sha });
        if (!cancelled) setDetail({ data, error: null });
      } catch (error) {
        if (!cancelled)
          setDetail({ data: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, sha]);

  const load = useCallback(
    (path: string) => async () => {
      if (client === null) throw new Error("not connected");
      return client.git.commitDiff({ workspaceId, sha, path });
    },
    [client, workspaceId, sha],
  );

  const changes = detail?.data ?? null;
  const commit = changes?.commit;
  const body = commit === undefined ? "" : commit.message.split("\n").slice(1).join("\n").trim();
  const toggle = (path: string, shown: boolean): void =>
    setOpen((before) => {
      const next = new Set(before);
      if (shown) next.add(path);
      else next.delete(path);
      return next;
    });
  return (
    <>
      {preview !== null && (
        <Suspense
          fallback={
            <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading historical file
            </div>
          }
        >
          <FilePreview
            workspaceId={workspaceId}
            path={preview.path}
            line={null}
            at={{ rev: preview.rev, note: preview.note }}
            backLabel="Back to diff"
            onBack={() => {
              backTo.current = preview.row;
              toggle(preview.row, true);
              setPreview(null);
            }}
          />
        </Suspense>
      )}
      {/* Hidden, not unmounted, under a preview: the commit keeps its open diffs and scroll. */}
      <div className={cn("flex h-full min-h-0 flex-col", preview !== null && "hidden")}>
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Back to history"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <span className="font-mono text-[12px] text-muted-foreground">{sha.slice(0, 7)}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{commit?.subject ?? ""}</span>
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {detail === null ? (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading the commit
            </div>
          ) : detail.error !== null || changes === null ? (
            <ErrorText className="px-2">{detail.error ?? "Couldn't load it."}</ErrorText>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 px-2 pb-3">
                <p className="text-sm font-medium">{changes.commit.subject}</p>
                {body !== "" && (
                  <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{body}</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {`${changes.commit.authorName} · ${new Date(changes.commit.authorDate).toLocaleString()} · against ${changes.baseLabel}`}
                </p>
              </div>
              {changes.files.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {changes.note ?? "No files changed."}
                </p>
              )}
              {changes.files.map((file) => {
                const version = historical(changes, file);
                const show = (): void => {
                  if (version !== null) setPreview(version);
                };
                return (
                  <FileDiffRow
                    key={file.path}
                    file={file}
                    version={sha}
                    load={load(file.path)}
                    open={open.has(file.path)}
                    onOpenChange={(shown) => toggle(file.path, shown)}
                    menu={
                      version === null ? [] : [{ label: "Preview at this commit", icon: <Eye />, run: show }]
                    }
                    actions={
                      version === null ? undefined : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-[11px] text-muted-foreground"
                          aria-label={`Preview ${file.path} at this commit`}
                          onClick={show}
                        >
                          Preview
                        </Button>
                      )
                    }
                  />
                );
              })}
              {changes.truncated && (
                <p className="px-2 pt-2 text-xs text-muted-foreground">Showing the first 2000 files.</p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The branch's pull request: state, checks and review, from the host's `gh` (D-020). */
function PullRequestCard({ workspaceId }: { workspaceId: string }) {
  const client = useClient();
  const [status, setStatus] = useState<PullRequestStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.git.pullRequest({ workspaceId, refresh: asked > 0 });
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, asked]);

  const refresh = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 text-muted-foreground"
      aria-label="Check the pull request again"
      onClick={() => {
        setRefreshing(true);
        setAsked((n) => n + 1);
      }}
    >
      <RefreshCw className={cn(refreshing && "animate-spin")} />
    </Button>
  );

  if (error !== null) return <ErrorText className="px-2">{`Pull request: ${error}`}</ErrorText>;
  if (status === null)
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Checking for a pull request
      </div>
    );
  if (status.pr === null)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-xs text-muted-foreground">
        <GitPullRequest className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{status.message ?? "No pull request."}</span>
        {refresh}
      </div>
    );
  return <PullRequestSummary pr={status.pr} refresh={refresh} />;
}

const PR_STATE: Record<
  PullRequest["state"],
  { label: string; icon: typeof GitPullRequest; className: string }
> = {
  open: { label: "Open", icon: GitPullRequest, className: "text-success" },
  draft: { label: "Draft", icon: GitPullRequestDraft, className: "text-muted-foreground" },
  merged: { label: "Merged", icon: GitMerge, className: "text-merged" },
  closed: { label: "Closed", icon: GitPullRequestClosed, className: "text-destructive" },
};

function PullRequestSummary({ pr, refresh }: { pr: PullRequest; refresh: React.ReactNode }) {
  const state = PR_STATE[pr.state];
  const { checks } = pr;
  const checksLine =
    checks.state === "passing"
      ? {
          icon: CircleCheck,
          className: "text-success",
          text: `Checks passed (${checks.passed + checks.skipped})`,
        }
      : checks.state === "failing"
        ? {
            icon: CircleX,
            className: "text-destructive",
            text: `${checks.failed} of ${checks.total} checks failing`,
          }
        : checks.state === "pending"
          ? {
              icon: CircleDashed,
              className: "text-warning",
              text: `${checks.pending} of ${checks.total} checks running`,
            }
          : checks.state === "cancelled"
            ? { icon: CircleX, className: "text-muted-foreground", text: "Checks cancelled" }
            : checks.state === "none"
              ? { icon: CircleDashed, className: "text-muted-foreground", text: "No checks" }
              : { icon: CircleDashed, className: "text-muted-foreground", text: "Checks unknown" };
  const review =
    pr.review === "approved"
      ? { text: "Approved", className: "text-success" }
      : pr.review === "changes_requested"
        ? { text: "Changes requested", className: "text-destructive" }
        : pr.review === "review_required"
          ? { text: "Review required", className: "text-warning" }
          : null;
  const Icon = state.icon;
  const ChecksIcon = checksLine.icon;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", state.className)} aria-label={state.label} />
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 text-[13px] font-medium hover:underline"
        >
          {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
          <ExternalLink className="ml-1 inline size-3 text-muted-foreground" />
        </a>
        {refresh}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px] text-muted-foreground">
        <span className={state.className}>{state.label}</span>
        <span className="font-mono">{`${pr.head} → ${pr.base}`}</span>
        <span className={cn("flex items-center gap-1", checksLine.className)}>
          <ChecksIcon className="size-3" /> {checksLine.text}
        </span>
        {review !== null && <span className={review.className}>{review.text}</span>}
      </div>
    </div>
  );
}
