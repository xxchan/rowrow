// Select a passage the agent wrote, press "Comment", say what should change: the passage
// and your comment join the review comments above the composer (roamgate #182).
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, type RefObject } from "react";
import { addAnnotation } from "../lib/annotations.ts";
import { useNarrow } from "../lib/use-narrow.ts";

interface Picked {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The selection, when it lies entirely in what the agent wrote: both ends in agent messages
 * (the transcript marks them `data-author="agent"`) and none of your messages in between.
 * Not in a diagram: its text is labels, not a passage.
 */
function pickAgentText(root: HTMLElement): Picked | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const byAgent = (node: Node): boolean => {
    const element = node instanceof Element ? node : node.parentElement;
    return (
      root.contains(element) &&
      element?.closest("[data-author]")?.getAttribute("data-author") === "agent" &&
      element.closest("[data-mermaid]") === null
    );
  };
  if (!byAgent(range.startContainer) || !byAgent(range.endContainer)) return null;
  for (const yours of root.querySelectorAll('[data-author="you"]')) {
    if (range.intersectsNode(yours)) return null;
  }
  const text = selection.toString().trim();
  if (text.length < 3) return null;
  const rect = range.getBoundingClientRect();
  return { text, x: rect.left + rect.width / 2, y: rect.bottom };
}

export function SelectionComment({
  container,
  workspaceId,
  agentId,
}: {
  container: RefObject<HTMLElement | null>;
  workspaceId: string;
  agentId: string;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const ui = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  useEffect(() => {
    if (editing) return;
    const read = (event: Event): void => {
      // Pressing our own button must not re-read (and drop) the selection.
      if (event.target instanceof Node && ui.current?.contains(event.target) === true) return;
      const root = container.current;
      setPicked(root === null ? null : pickAgentText(root));
    };
    // Touch selections are adjusted with native handles that send the page no events, so
    // follow the selection itself, once it settles.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (event: Event): void => {
      clearTimeout(timer);
      timer = setTimeout(() => read(event), 300);
    };
    const touch = matchMedia("(any-pointer: coarse)").matches;
    document.addEventListener("mouseup", read);
    document.addEventListener("keyup", read);
    document.addEventListener("scroll", read, { capture: true, passive: true });
    if (touch) document.addEventListener("selectionchange", settle);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseup", read);
      document.removeEventListener("keyup", read);
      document.removeEventListener("scroll", read, { capture: true });
      document.removeEventListener("selectionchange", settle);
    };
  }, [container, editing]);

  if (picked === null) return null;
  const close = (): void => {
    setEditing(false);
    setPicked(null);
    setComment("");
  };
  const save = (): void => {
    if (comment.trim() === "") return;
    addAnnotation(workspaceId, { kind: "transcript", agentId, quote: picked.text }, comment);
    window.getSelection()?.removeAllRanges();
    close();
  };

  if (!editing) {
    return (
      <div
        ref={ui}
        className="fixed z-30 -translate-x-1/2 translate-y-2"
        style={{ left: picked.x, top: picked.y }}
      >
        <Button size="sm" className="shadow-lg" onClick={() => setEditing(true)}>
          Comment
        </Button>
      </div>
    );
  }
  // Under the passage; on a phone, at the top, where the keyboard can't cover it.
  const place = narrow
    ? { top: 16, left: 16, right: 16 }
    : {
        width: 320,
        left: Math.min(Math.max(16, picked.x - 160), window.innerWidth - 336),
        top: Math.min(picked.y + 8, window.innerHeight - 220),
      };
  return (
    <div
      ref={ui}
      className={cn(
        "fixed z-30 flex flex-col gap-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl",
      )}
      style={place}
    >
      <p className="line-clamp-2 text-xs text-muted-foreground">{`“${picked.text}”`}</p>
      <Textarea
        aria-label="Comment"
        value={comment}
        onChange={(event) => setComment(event.currentTarget.value)}
        rows={3}
        autoFocus
        placeholder="What should change?"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") close();
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" disabled={comment.trim() === ""} onClick={save}>
          Comment
        </Button>
      </div>
    </div>
  );
}
