// Review annotations (roamgate #38): comments pinned to what they are about, a diff line
// or a passage the agent wrote, collected while you read, then compiled into one "Review
// feedback" message that fills the agent's composer. rowrow never sends it for you
// (PRINCIPLES.md, product 4): you read it over and press send.
//
// Kept per workspace in this browser (localStorage), so they survive closing the panel or
// reloading, and every tab sees the same ones; delivered comments are removed once they're in
// a composer.
import { create } from "zustand";
import type { Annotation, AnnotationSource } from "../../shared/feedback.ts";
import { onPrefChange } from "./device-prefs.ts";

export { compileFeedback, type Annotation, type AnnotationSource } from "../../shared/feedback.ts";

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

// Another tab added or sent some: take its list, so writing ours doesn't drop them.
onPrefChange(KEY, () => useAnnotations.setState({ items: load() }));

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
