// A changed file in a list (status, path, +/−) that opens to its diff, loaded on first open.
// Used for a workspace's changes and for a commit's files; `load` says where the diff comes from.
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ChevronRight, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ChangedFile } from "../../shared/schemas.ts";
import type { Annotation } from "../lib/annotations.ts";
import { DiffView, type LineRef } from "./DiffView.tsx";
import { ErrorText } from "./ErrorText.tsx";
import { CONTEXT_PARTS, copyText, MenuActions, type MenuAction } from "./MenuActions.tsx";

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

type Loaded = { version: string; patch: string; truncated: boolean } | { version: string; error: string };

export function FileDiffRow({
  file,
  version,
  load,
  annotations = [],
  onComment,
  onRemove,
  badge,
  actions,
  menu = [],
}: {
  file: ChangedFile;
  /** Changes when the diff may have: an open row reloads it. */
  version: string;
  load: () => Promise<{ patch: string; truncated: boolean }>;
  annotations?: readonly Annotation[];
  onComment?: (ref: LineRef, comment: string) => void;
  onRemove?: (id: string) => void;
  badge?: ReactNode;
  /** Controls at the end of the row (outside its button). */
  actions?: ReactNode;
  /** The row's right-click menu, after Copy path. */
  menu?: MenuAction[];
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!open || diff?.version === version) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await load();
        if (!cancelled) setDiff({ version, ...result });
      } catch (error) {
        if (!cancelled) setDiff({ version, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, version, diff?.version, load]);

  return (
    <div className="flex flex-col">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/file flex items-center rounded-md hover:bg-accent/60">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
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
              {badge}
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
            {actions}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60" aria-label={`Actions for ${file.path}`}>
          <ContextMenuLabel>{file.path}</ContextMenuLabel>
          <MenuActions
            actions={[
              { label: "Copy path", icon: <Copy />, run: () => void copyText(file.path, "Path") },
              "separator",
              ...menu,
            ]}
            parts={CONTEXT_PARTS}
          />
        </ContextMenuContent>
      </ContextMenu>
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
                {...(onComment === undefined ? {} : { onComment })}
                {...(onRemove === undefined ? {} : { onRemove })}
              />
              {diff.truncated && <p className="px-2 pt-1 text-xs text-muted-foreground">Cut at 512 KB.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
