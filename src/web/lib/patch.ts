// A unified diff (git's patch for one or more files) read into rows: hunk headers, added,
// removed and unchanged lines with their numbers, and the file header lines worth showing.
// DiffView draws these when the highlighter can't take the patch, and numbers comments by them.

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
