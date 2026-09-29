// A unified diff, rendered line by line with old and new line numbers. Click (or tap) a
// line to comment on it: comments collect into review feedback for the agent
// (lib/annotations.ts). Pure and cheap: the server caps a patch at 512 KB, and a file's
// diff renders only when you open it.
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import * as stylex from "@stylexjs/stylex";
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
    <div {...stylex.props(styles.diff)} role="table" aria-label="Diff">
      {lines.map((line, index) => {
        const ref = refOf(line);
        const key = ref === null ? null : keyOf(ref.side, ref.line);
        const comments = key === null ? [] : (byLine.get(key) ?? []);
        return (
          <div key={index}>
            <div
              {...stylex.props(
                styles.row,
                rowStyle[line.kind],
                onComment !== undefined && ref !== null && styles.commentable,
              )}
              role="row"
              {...(onComment !== undefined && key !== null
                ? { onClick: () => setEditing(editing === key ? null : key), title: "Comment on this line" }
                : {})}
            >
              <span {...stylex.props(styles.number)}>{line.oldNo ?? ""}</span>
              <span {...stylex.props(styles.number)}>{line.newNo ?? ""}</span>
              <span {...stylex.props(styles.sign)}>
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : comments.length > 0 ? "●" : ""}
              </span>
              <span {...stylex.props(styles.code)}>{line.text}</span>
            </div>
            {comments.map((a) => (
              <div key={a.id} {...stylex.props(styles.comment)}>
                <HStack gap={2} vAlign="start">
                  <Text type="body">{a.comment}</Text>
                  {onRemove !== undefined && (
                    <Button label="Remove" size="sm" variant="ghost" onClick={() => onRemove(a.id)} />
                  )}
                </HStack>
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
    <div {...stylex.props(styles.comment)}>
      <VStack gap={1}>
        <TextArea
          label="Comment"
          isLabelHidden
          value={text}
          onChange={setText}
          rows={2}
          width="100%"
          hasAutoFocus
          placeholder="What should change here?"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") onCancel();
          }}
        />
        <HStack gap={1} hAlign="end">
          <Button label="Cancel" size="sm" variant="ghost" onClick={onCancel} />
          <Button
            label="Comment"
            size="sm"
            variant="primary"
            isDisabled={text.trim() === ""}
            onClick={save}
          />
        </HStack>
      </VStack>
    </div>
  );
}

const styles = stylex.create({
  diff: {
    fontFamily: "var(--font-family-code)",
    fontSize: 12,
    lineHeight: 1.55,
    overflowX: "auto",
    borderRadius: "var(--radius-inner)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-border)",
    backgroundColor: "var(--color-background-surface)",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "3.2em 3.2em 1.2em 1fr",
    minWidth: "max-content",
  },
  commentable: {
    cursor: "pointer",
    outline: { default: "none", ":hover": "1px solid var(--color-border-emphasized)" },
    outlineOffset: -1,
  },
  number: {
    color: "var(--color-text-secondary)",
    textAlign: "right",
    paddingInlineEnd: 6,
    userSelect: "none",
    opacity: 0.7,
  },
  sign: { color: "var(--color-text-secondary)", userSelect: "none", textAlign: "center" },
  code: { whiteSpace: "pre", paddingInlineEnd: 12 },
  comment: {
    fontFamily: "var(--font-family-body)",
    paddingBlock: 6,
    paddingInline: 12,
    marginInlineStart: "7.6em",
    marginBlock: 4,
    borderInlineStartWidth: 3,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: "var(--color-accent)",
    backgroundColor: "var(--color-background-card)",
    maxWidth: 640,
  },
});

const rowStyle = stylex.create({
  meta: { color: "var(--color-text-secondary)" },
  hunk: { color: "var(--color-text-secondary)", backgroundColor: "var(--color-background-muted)" },
  add: { backgroundColor: "var(--color-success-muted)" },
  del: { backgroundColor: "var(--color-error-muted)" },
  context: {},
  note: { color: "var(--color-text-secondary)", fontStyle: "italic" },
});
