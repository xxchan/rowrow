// A unified diff with syntax highlighting (@pierre/diffs, D-034), one line-number column
// (the old number on a removed line, the new one elsewhere) and word-level emphasis on
// changed lines. Click (or tap) a line to comment on it:
// comments collect into review feedback for the agent (lib/annotations.ts). The server caps
// a patch at 512 KB, and a file's diff renders only when you open it. A patch the library
// can't take (no hunks, or one it rejects) falls back to plain rows, never a blank.
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type DiffLineAnnotation, type FileDiffOptions, PatchDiff } from "@pierre/diffs/react";
import { X } from "lucide-react";
import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Annotation } from "../lib/annotations.ts";
import { type DiffLine, parsePatch } from "../lib/patch.ts";
import { report } from "../lib/telemetry.ts";
import { useTheme } from "../lib/theme.ts";

export interface LineRef {
  readonly side: "old" | "new";
  readonly line: number;
  readonly text: string;
}

function refOf(line: DiffLine): LineRef | null {
  if (line.kind === "del" && line.oldNo !== null) return { side: "old", line: line.oldNo, text: line.text };
  if ((line.kind === "add" || line.kind === "context") && line.newNo !== null)
    return { side: "new", line: line.newNo, text: line.text };
  return null;
}

const keyOf = (side: "old" | "new", line: number): string => `${side}:${line}`;

interface Props {
  patch: string;
  annotations?: readonly Annotation[];
  onComment?: (ref: LineRef, comment: string) => void;
  onRemove?: (id: string) => void;
}

export const DiffView = memo(function DiffView(props: Props) {
  const lines = useMemo(() => parsePatch(props.patch), [props.patch]);
  const plain = <PlainDiff {...props} lines={lines} />;
  if (!lines.some((line) => line.kind === "hunk")) return plain;
  return (
    <Fallback fallback={plain}>
      <HighlightedDiff {...props} lines={lines} />
    </Fallback>
  );
});

interface Slot {
  readonly ref: LineRef;
  readonly comments: readonly Annotation[];
  readonly editing: boolean;
}

// The library's own rules sit in layers under `unsafe`, so these win. Its scrollbar shows
// only while the pointer is over the diff; here it takes the app's scrollbar colors.
const SCROLLBAR_CSS = `
[data-code]::-webkit-scrollbar-thumb { border-radius: 9999px; }
:host(:hover) [data-code]::-webkit-scrollbar-thumb { background-color: var(--scrollbar); }
[data-code]::-webkit-scrollbar-thumb:hover { background-color: var(--scrollbar-hover); }
@supports ((-moz-appearance: none)) { [data-code] { scrollbar-color: var(--scrollbar) transparent; } }
`;

// The library's colors, from the app's tokens (index.css), so a diff sits in the page like
// the rest of it in both themes.
const HOST_STYLE = {
  "--diffs-light-bg": "var(--code)",
  "--diffs-dark-bg": "var(--code)",
  // The library mixes a line's background, its number's and the changed words' from these.
  "--diffs-addition-color-override": "var(--success)",
  "--diffs-deletion-color-override": "var(--destructive)",
  "--diffs-bg-separator-override": "var(--diff-hunk)",
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
  "--diffs-line-height": "19px",
} as CSSProperties;

function HighlightedDiff({
  patch,
  lines,
  annotations = [],
  onComment,
  onRemove,
}: Props & { lines: DiffLine[] }) {
  const { dark } = useTheme();
  const [editing, setEditing] = useState<LineRef | null>(null);
  // A clicked line, by the side and number the library reports, to what a comment is about:
  // a context line reports either side and is always about its new line.
  const refs = useMemo(() => {
    const map = new Map<string, LineRef>();
    for (const line of lines) {
      const ref = refOf(line);
      if (ref === null) continue;
      if (line.oldNo !== null) map.set(keyOf("old", line.oldNo), ref);
      if (line.newNo !== null) map.set(keyOf("new", line.newNo), ref);
    }
    return map;
  }, [lines]);
  const slots = useMemo(() => {
    const byKey = new Map<string, Slot>();
    for (const a of annotations) {
      if (a.source.kind !== "diff") continue;
      const ref = refs.get(keyOf(a.source.side, a.source.line));
      if (ref === undefined) continue;
      const key = keyOf(ref.side, ref.line);
      const slot = byKey.get(key);
      byKey.set(key, { ref, comments: [...(slot?.comments ?? []), a], editing: false });
    }
    if (editing !== null) {
      const key = keyOf(editing.side, editing.line);
      byKey.set(key, { ref: editing, comments: byKey.get(key)?.comments ?? [], editing: true });
    }
    return [...byKey.values()].map((slot): DiffLineAnnotation<Slot> => ({
      side: slot.ref.side === "old" ? "deletions" : "additions",
      lineNumber: slot.ref.line,
      metadata: slot,
    }));
  }, [annotations, editing, refs]);
  const options = useMemo(
    (): FileDiffOptions<Slot, undefined> => ({
      theme: { light: "github-light", dark: "tokyo-night" },
      themeType: dark ? "dark" : "light",
      diffStyle: "unified",
      disableFileHeader: true,
      overflow: "scroll",
      hunkSeparators: "line-info-basic",
      unsafeCSS: SCROLLBAR_CSS,
      ...(onComment === undefined
        ? {}
        : {
            lineHoverHighlight: "line" as const,
            onLineClick: ({ annotationSide, lineNumber }) => {
              const ref = refs.get(keyOf(annotationSide === "deletions" ? "old" : "new", lineNumber));
              if (ref === undefined) return;
              setEditing((current) => (current?.side === ref.side && current.line === ref.line ? null : ref));
            },
          }),
    }),
    [dark, onComment, refs],
  );
  const meta = lines.filter((line) => line.kind === "meta");
  return (
    <div role="table" aria-label="Diff" className="overflow-hidden rounded-md border bg-code">
      {meta.length > 0 && (
        <div className="border-b px-3 py-1 font-mono text-[12px] text-muted-foreground">
          {meta.map((line, index) => (
            <div key={index}>{line.text}</div>
          ))}
        </div>
      )}
      <PatchDiff<Slot>
        patch={patch}
        options={options}
        lineAnnotations={slots}
        style={HOST_STYLE}
        className={cn(onComment !== undefined && "cursor-pointer")}
        renderAnnotation={({ metadata: slot }) => (
          <div className="py-0.5">
            {slot.comments.map((a) => (
              <Bubble key={a.id} annotation={a} onRemove={onRemove} />
            ))}
            {slot.editing && onComment !== undefined && (
              <CommentEditor
                onSave={(comment) => {
                  onComment(slot.ref, comment);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        )}
      />
    </div>
  );
}

/** Falls back to plain rows when the library throws on a patch (and says so in the log). */
class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    report("warn", "diff_render_error", error, { componentStack: info.componentStack?.slice(0, 2000) });
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PlainDiff({ lines, annotations = [], onComment, onRemove }: Props & { lines: DiffLine[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const byLine = new Map<string, Annotation[]>();
  for (const a of annotations) {
    if (a.source.kind !== "diff") continue;
    const key = keyOf(a.source.side, a.source.line);
    byLine.set(key, [...(byLine.get(key) ?? []), a]);
  }
  return (
    <div
      role="table"
      aria-label="Diff"
      className="overflow-x-auto rounded-md border bg-code font-mono text-[12px] leading-[1.6]"
    >
      {lines.map((line, index) => {
        const ref = refOf(line);
        const key = ref === null ? null : keyOf(ref.side, ref.line);
        const comments = key === null ? [] : (byLine.get(key) ?? []);
        const commentable = onComment !== undefined && key !== null;
        return (
          <div key={index}>
            <div
              role="row"
              className={cn(
                "grid min-w-max grid-cols-[3.2em_3.2em_1.4em_1fr]",
                ROW[line.kind],
                commentable &&
                  "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-ring/50",
              )}
              {...(commentable
                ? { onClick: () => setEditing(editing === key ? null : key), title: "Comment on this line" }
                : {})}
            >
              <span className="pr-1.5 text-right text-muted-foreground/60 select-none">
                {line.oldNo ?? ""}
              </span>
              <span className="pr-1.5 text-right text-muted-foreground/60 select-none">
                {line.newNo ?? ""}
              </span>
              <span className="text-center text-muted-foreground select-none">
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : comments.length > 0 ? "●" : ""}
              </span>
              <span className="pr-3 whitespace-pre">{line.text}</span>
            </div>
            {comments.length > 0 && (
              <div className="ml-[7.8em]">
                {comments.map((a) => (
                  <Bubble key={a.id} annotation={a} onRemove={onRemove} />
                ))}
              </div>
            )}
            {editing === key && ref !== null && onComment !== undefined && (
              <div className="ml-[7.8em]">
                <CommentEditor
                  onSave={(comment) => {
                    onComment(ref, comment);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Bubble({
  annotation,
  onRemove,
}: {
  annotation: Annotation;
  onRemove?: ((id: string) => void) | undefined;
}) {
  return (
    <div className="my-1 mx-2 flex max-w-xl items-start gap-2 rounded-md border-l-2 border-primary bg-card px-3 py-1.5 font-sans text-sm">
      <p className="min-w-0 flex-1 whitespace-pre-wrap">{annotation.comment}</p>
      {onRemove !== undefined && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label="Remove"
          onClick={() => onRemove(annotation.id)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}

function CommentEditor({ onSave, onCancel }: { onSave: (comment: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // In the highlighted diff the editor mounts before the library draws the slot that shows
  // it, and a node nobody shows can't take focus: try again for a few frames.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const focus = (): void => {
      const box = ref.current;
      if (box === null) return;
      box.focus();
      if (document.activeElement !== box && tries++ < 10) frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = (): void => {
    if (text.trim() !== "") onSave(text);
  };
  return (
    <div className="my-1.5 mx-2 flex max-w-xl flex-col gap-1.5 rounded-md border-l-2 border-primary bg-card p-2 font-sans">
      <Textarea
        aria-label="Comment"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        rows={2}
        ref={ref}
        placeholder="What should change here?"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") onCancel();
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={text.trim() === ""} onClick={save}>
          Comment
        </Button>
      </div>
    </div>
  );
}

const ROW: Record<DiffLine["kind"], string> = {
  meta: "text-muted-foreground",
  hunk: "bg-diff-hunk text-muted-foreground",
  add: "bg-diff-add",
  del: "bg-diff-del",
  context: "",
  note: "text-muted-foreground italic",
};
