// Review feedback (roamgate #38): comments pinned to what they are about, a diff line or a
// passage the agent wrote, compiled into one "Review feedback" message that fills the
// agent's composer. rowrow never sends it for you (PRINCIPLES.md, product 4): you read it
// over and press send. The web app and the iOS app (through the kit) write the same message.
import type { DiffScope } from "./schemas.ts";

export type AnnotationSource =
  | {
      readonly kind: "diff";
      readonly path: string;
      readonly scope: DiffScope;
      readonly side: "old" | "new";
      readonly line: number;
      /** The line as it was when you commented: the message quotes it, so a stale anchor still reads right. */
      readonly text: string;
    }
  | { readonly kind: "transcript"; readonly agentId: string; readonly quote: string };

export interface Annotation {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: AnnotationSource;
  readonly comment: string;
  readonly createdAt: number;
}

/**
 * The message an agent gets: numbered items, each saying exactly where (path and line, or
 * the passage), quoting what was there, then the comment. Self-contained, so it reads right
 * even after the code moved.
 */
export function compileFeedback(annotations: readonly Annotation[]): string {
  const items = annotations.map((a, index) => {
    const n = `${index + 1}.`;
    const quote = (text: string): string =>
      text
        .split("\n")
        .map((line) => `   > ${line}`)
        .join("\n");
    const where =
      a.source.kind === "diff"
        ? `\`${a.source.path}\` line ${a.source.line}${a.source.side === "old" ? " (before the change)" : ""}:\n${quote(a.source.text)}`
        : `About what you wrote:\n${quote(a.source.quote)}`;
    return `${n} ${where}\n   ${a.comment.trim().split("\n").join("\n   ")}`;
  });
  return `Review feedback:\n\n${items.join("\n\n")}\n`;
}
