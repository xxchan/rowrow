// A unified diff, rendered line by line with old and new line numbers. Pure and cheap: the
// server caps a patch at 512 KB, and a file's diff renders only when you open it.
import * as stylex from "@stylexjs/stylex";
import { memo } from "react";

export interface DiffLine {
  readonly kind: "meta" | "hunk" | "add" | "del" | "context" | "note";
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
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
      if (raw !== "") lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "note", text: raw, oldNo: null, newNo: null });
    } else if (raw !== "" || lines.length > 0) {
      lines.push({ kind: "context", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  // A trailing empty context line is the patch's final newline, not content.
  while (lines.at(-1)?.kind === "context" && lines.at(-1)?.text === "") lines.pop();
  return lines;
}

export const DiffView = memo(function DiffView({ patch }: { patch: string }) {
  const lines = parsePatch(patch);
  return (
    <div {...stylex.props(styles.diff)} role="table" aria-label="Diff">
      {lines.map((line, index) => (
        <div key={index} {...stylex.props(styles.row, rowStyle[line.kind])} role="row">
          <span {...stylex.props(styles.number)}>{line.oldNo ?? ""}</span>
          <span {...stylex.props(styles.number)}>{line.newNo ?? ""}</span>
          <span {...stylex.props(styles.sign)}>
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
          </span>
          <span {...stylex.props(styles.code)}>{line.text}</span>
        </div>
      ))}
    </div>
  );
});

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
  number: {
    color: "var(--color-text-secondary)",
    textAlign: "right",
    paddingInlineEnd: 6,
    userSelect: "none",
    opacity: 0.7,
  },
  sign: { color: "var(--color-text-secondary)", userSelect: "none", textAlign: "center" },
  code: { whiteSpace: "pre", paddingInlineEnd: 12 },
});

const rowStyle = stylex.create({
  meta: { color: "var(--color-text-secondary)" },
  hunk: { color: "var(--color-text-secondary)", backgroundColor: "var(--color-background-muted)" },
  add: { backgroundColor: "var(--color-success-muted)" },
  del: { backgroundColor: "var(--color-error-muted)" },
  context: {},
  note: { color: "var(--color-text-secondary)", fontStyle: "italic" },
});
