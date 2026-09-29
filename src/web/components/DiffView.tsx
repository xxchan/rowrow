// A unified diff, rendered line by line with old and new line numbers. Click (or tap) a
// line to comment on it: comments collect into review feedback for the agent
// (lib/annotations.ts). Pure and cheap: the server caps a patch at 512 KB, and a file's
// diff renders only when you open it.
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { memo, useState } from "react";
import type { Annotation } from "../lib/annotations.ts";

export interface DiffLine {
  readonly kind: "meta" | "hunk" | "add" | "del" | "context" | "note";
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

export interface LineRef {
  readonly side: "old" | "new";
  readonly line: number;
  readonly text: string;
}

export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldNo = Number(match?.[1] ?? 0);
      newNo = Number(match?.[2] ?? 0);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
    } else if (!inHunk || raw.startsWith("diff --git")) {
      inHunk = false;
      // The file header says what the list above already says; keep only what it adds.
      if (/^(new file|deleted file|rename |similarity |old mode|new mode|Binary )/.test(raw)) {
        lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
      }
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "note", text: raw, oldNo: null, newNo: null });
    } else {
      lines.push({ kind: "context", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  // A trailing empty context line is the patch's final newline, not content.
  while (lines.at(-1)?.kind === "context" && lines.at(-1)?.text === "") lines.pop();
  return lines;
}

function refOf(line: DiffLine): LineRef | null {
  if (line.kind === "del" && line.oldNo !== null) return { side: "old", line: line.oldNo, text: line.text };
  if ((line.kind === "add" || line.kind === "context") && line.newNo !== null)
    return { side: "new", line: line.newNo, text: line.text };
  return null;
}

const keyOf = (side: "old" | "new", line: number): string => `${side}:${line}`;

export const DiffView = memo(function DiffView({
  patch,
  annotations = [],
  onComment,
  onRemove,
}: {
  patch: string;
  annotations?: readonly Annotation[];
  onComment?: (ref: LineRef, comment: string) => void;
  onRemove?: (id: string) => void;
}) {
  const lines = parsePatch(patch);
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
            {comments.map((a) => (
              <div
                key={a.id}
                className="my-1 ml-[7.8em] flex max-w-xl items-start gap-2 rounded-md border-l-2 border-primary bg-card px-3 py-1.5 font-sans text-sm"
              >
                <p className="min-w-0 flex-1 whitespace-pre-wrap">{a.comment}</p>
                {onRemove !== undefined && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-muted-foreground"
                    aria-label="Remove"
                    onClick={() => onRemove(a.id)}
                  >
                    <X />
                  </Button>
                )}
              </div>
            ))}
            {editing === key && ref !== null && onComment !== undefined && (
              <CommentEditor
                onSave={(comment) => {
                  onComment(ref, comment);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

function CommentEditor({ onSave, onCancel }: { onSave: (comment: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const save = (): void => {
    if (text.trim() !== "") onSave(text);
  };
  return (
    <div className="my-1.5 ml-[7.8em] flex max-w-xl flex-col gap-1.5 rounded-md border-l-2 border-primary bg-card p-2 font-sans">
      <Textarea
        aria-label="Comment"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        rows={2}
        autoFocus
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
