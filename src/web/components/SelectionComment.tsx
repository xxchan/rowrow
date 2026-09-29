// Select a passage the agent wrote, press "Comment", say what should change: the passage
// and your comment join the review comments above the composer (roamgate #182).
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import * as stylex from "@stylexjs/stylex";
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
 */
function pickAgentText(root: HTMLElement): Picked | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const byAgent = (node: Node): boolean => {
    const element = node instanceof Element ? node : node.parentElement;
    return (
      root.contains(element) && element?.closest("[data-author]")?.getAttribute("data-author") === "agent"
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
      <div ref={ui} {...stylex.props(styles.bubble, styles.at(picked.x, picked.y))}>
        <Button label="Comment" size="sm" variant="primary" onClick={() => setEditing(true)} />
      </div>
    );
  }
  // Under the passage; on a phone, at the top, where the keyboard can't cover it.
  const place = narrow
    ? styles.top
    : [
        styles.beside,
        styles.at(
          Math.min(Math.max(16, picked.x - 160), window.innerWidth - 336),
          Math.min(picked.y + 8, window.innerHeight - 220),
        ),
      ];
  return (
    <div ref={ui} {...stylex.props(styles.editor, place)}>
      <VStack gap={2}>
        <Text type="supporting" maxLines={2}>{`“${picked.text}”`}</Text>
        <TextArea
          label="Comment"
          isLabelHidden
          value={comment}
          onChange={setComment}
          rows={3}
          width="100%"
          hasAutoFocus
          placeholder="What should change?"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") close();
          }}
        />
        <HStack gap={1} hAlign="end">
          <Button label="Cancel" size="sm" variant="ghost" onClick={close} />
          <Button
            label="Comment"
            size="sm"
            variant="primary"
            isDisabled={comment.trim() === ""}
            onClick={save}
          />
        </HStack>
      </VStack>
    </div>
  );
}

const styles = stylex.create({
  at: (left: number, top: number) => ({ left, top }),
  bubble: {
    position: "fixed",
    zIndex: 20,
    transform: "translate(-50%, 8px)",
  },
  editor: {
    position: "fixed",
    zIndex: 20,
    padding: 12,
    borderRadius: "var(--radius-container)",
    backgroundColor: "var(--color-background-popover)",
    boxShadow: "var(--shadow-high)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-border)",
  },
  beside: {
    width: 320,
  },
  top: {
    top: 16,
    left: 16,
    right: 16,
  },
});
