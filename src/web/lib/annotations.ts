// Review annotations (roamgate #38): comments pinned to what they are about, a diff line
// or a passage the agent wrote, collected while you read, then compiled into one "Review
// feedback" message that fills the agent's composer. rowrow never sends it for you
// (PRINCIPLES.md, product 4): you read it over and press send.
//
// Kept per workspace in this browser (localStorage), so they survive closing the panel or
// reloading; delivered comments are removed once they're in a composer.
import { create } from "zustand";
import type { DiffScope } from "../../shared/schemas.ts";

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

const KEY = "rowrow.annotations";

function load(): Annotation[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? [] : (JSON.parse(raw) as Annotation[]);
  } catch {
    return [];
  }
}

export const useAnnotations = create<{ items: readonly Annotation[] }>(() => ({ items: load() }));

useAnnotations.subscribe((state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state.items));
  } catch {
    // storage full or unavailable: annotations stay in memory
  }
});

export function addAnnotation(workspaceId: string, source: AnnotationSource, comment: string): void {
  const annotation: Annotation = {
    id: crypto.randomUUID(),
    workspaceId,
    source,
    comment: comment.trim(),
    createdAt: Date.now(),
  };
  useAnnotations.setState((s) => ({ items: [...s.items, annotation] }));
}

export function updateAnnotation(id: string, comment: string): void {
  useAnnotations.setState((s) => ({ items: s.items.map((a) => (a.id === id ? { ...a, comment } : a)) }));
}

export function removeAnnotations(ids: ReadonlySet<string>): void {
  useAnnotations.setState((s) => ({ items: s.items.filter((a) => !ids.has(a.id)) }));
}

export function annotationsFor(items: readonly Annotation[], workspaceId: string): Annotation[] {
  return items.filter((a) => a.workspaceId === workspaceId && a.comment.trim() !== "");
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
