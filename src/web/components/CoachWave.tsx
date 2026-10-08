// Coach's conversation map (roamgate's Ranger "wave bar"): a tick per message at the right
// edge of the chat, longer for yours, accent for the ones on screen. Hover (not touch) to
// preview one, click to jump to it, or use it as a vertical slider with the arrow keys. The
// messages are the transcript's own (`article[data-author]`), read from the page.
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, type RefObject } from "react";

interface Mark {
  readonly element: HTMLElement;
  readonly you: boolean;
  readonly preview: string;
}

/** What a message said, without its footer: the part the transcript marks `data-preview`. */
function preview(element: HTMLElement): string {
  const text = (element.querySelector("[data-preview]") ?? element).textContent ?? "";
  return text.trim().replace(/\s+/g, " ").slice(0, 160) || "No response text yet";
}

export function CoachWave({
  scrollRef,
  contentRef,
  compact,
  onNavigate,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** The floating window: a narrower, shorter bar. */
  compact: boolean;
  /** A jump: the chat stops following new text. */
  onNavigate: () => void;
}) {
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  const [visible, setVisible] = useState<readonly number[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const waveRef = useRef<HTMLDivElement>(null);

  // The messages, as the transcript renders them (it changes while text streams).
  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const read = (): void => {
      const found = [...content.querySelectorAll<HTMLElement>("[data-author]")].map((element) => ({
        element,
        you: element.dataset["author"] === "you",
        preview: preview(element),
      }));
      setMarks((current) =>
        current.length === found.length &&
        current.every((m, i) => m.element === found[i]?.element && m.preview === found[i]?.preview)
          ? current
          : found,
      );
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [contentRef]);

  // Which of them are on screen.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const viewport = scroller.getBoundingClientRect();
      const now = marks.flatMap((mark, index) => {
        const rect = mark.element.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom ? [index] : [];
      });
      setVisible((current) =>
        current.length === now.length && current.every((v, i) => v === now[i]) ? current : now,
      );
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    for (const mark of marks) observer.observe(mark.element);
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [scrollRef, marks]);

  const current = visible[0] ?? 0;
  const now = marks[current] ?? marks[0];
  if (now === undefined) return null;
  const shown = hovered ?? (keyboard ? current : null);
  const shownMark = shown === null ? undefined : marks[shown];
  const indexAt = (clientY: number): number => {
    const rect = waveRef.current?.getBoundingClientRect();
    if (rect === undefined) return 0;
    const at = Math.floor(((clientY - rect.top) / Math.max(1, rect.height)) * marks.length);
    return Math.max(0, Math.min(marks.length - 1, at));
  };
  const navigate = (index: number): void => {
    const scroller = scrollRef.current;
    const mark = marks[index];
    if (scroller === null || mark === undefined) return;
    onNavigate();
    // This scroll container only, at once (no animation to fight new text), 12 px below its top.
    const viewport = scroller.getBoundingClientRect();
    const scale = scroller.offsetHeight === 0 ? 1 : viewport.height / scroller.offsetHeight;
    scroller.scrollTop += (mark.element.getBoundingClientRect().top - viewport.top) / (scale || 1) - 12;
    setHovered(index);
  };
  const who = (mark: Mark): string => (mark.you ? "You" : "Coach");
  const step = compact ? 6 : 8;
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 bottom-0 flex items-center",
        compact ? "right-1 w-5 px-0.5 py-6" : "right-3 w-8 px-[5px] py-8",
      )}
    >
      <div
        ref={waveRef}
        role="slider"
        tabIndex={0}
        aria-label="Coach conversation navigation"
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={marks.length}
        aria-valuenow={current + 1}
        aria-valuetext={`${who(now)}: ${now.preview}`}
        style={{ height: `min(100%, ${marks.length * step}px)`, maxHeight: compact ? 240 : 400 }}
        className={cn(
          "pointer-events-auto relative flex w-full flex-col opacity-60 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-primary motion-safe:transition-opacity",
        )}
        onFocus={(event) => setKeyboard(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => {
          setKeyboard(false);
          setHovered(null);
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "touch") setHovered(indexAt(event.clientY));
        }}
        onPointerLeave={() => setHovered(null)}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setKeyboard(false);
          navigate(indexAt(event.clientY));
        }}
        onKeyDown={(event) => {
          const from = shown ?? current;
          const to =
            event.key === "ArrowUp"
              ? from - 1
              : event.key === "ArrowDown"
                ? from + 1
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? marks.length - 1
                    : null;
          if (to === null) return;
          event.preventDefault();
          setKeyboard(true);
          navigate(Math.max(0, Math.min(marks.length - 1, to)));
        }}
      >
        {marks.map((mark, index) => {
          const seen = visible.includes(index);
          const base = seen ? 16 : mark.you ? 12 : 8;
          const width = shown === null ? base : Math.max(base, 22 - Math.abs(shown - index) * 4);
          return (
            <span key={index} aria-hidden className="flex min-h-0 flex-1 items-center justify-end">
              <span
                style={{ width }}
                className={cn(
                  "h-0.5 rounded-[1px] motion-safe:transition-[width]",
                  seen ? "bg-primary" : mark.you ? "bg-muted-foreground/65" : "bg-muted-foreground/40",
                )}
              />
            </span>
          );
        })}
        {shownMark !== undefined && shown !== null && (
          <div
            role="tooltip"
            style={{ top: `${((shown + 0.5) / marks.length) * 100}%` }}
            className="absolute right-full mr-2 w-[220px] -translate-y-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
          >
            <strong className="flex items-center justify-between text-[11px]">
              {who(shownMark)}
              <span className="font-normal text-muted-foreground">
                {shown + 1} / {marks.length}
              </span>
            </strong>
            <span className="line-clamp-2 text-[11px] text-muted-foreground">{shownMark.preview}</span>
          </div>
        )}
      </div>
    </div>
  );
}
