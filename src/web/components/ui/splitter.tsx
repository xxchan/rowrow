// A divider between two panes that resizes one of them (lib/pane-size.ts): drag it, move it with
// the arrow keys (Home and End: the pane's narrowest and widest), or double-click it for the
// default width. A line with a grip, highlighted on hover, focus and while it drags, and a strip
// to grab wider than the line (wider still for a finger). The width is kept on this device and
// follows the app's other tabs. While it drags it sets the pane's width itself and stores it at
// the end, so what the panes show doesn't re-render on every move.
import { usePref, writePref } from "@/lib/device-prefs";
import { draggedWidth, keyedWidth, parseWidth, type PaneSide, type PaneSizing } from "@/lib/pane-size";
import { cn } from "@/lib/utils";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/** A resizable pane's stored width, and its style: give the pane the style, its divider the width. */
export function usePaneWidth(sizing: PaneSizing): { width: number; style: CSSProperties } {
  const width = usePref(sizing.key, (stored) => parseWidth(stored, sizing.defaultSize));
  // A narrower row holds it between its minimum and what the other side keeps, which wins.
  const room = `calc(100% - ${sizing.keep}px)`;
  return { width, style: { width, minWidth: `min(${sizing.min}px, ${room})`, maxWidth: room } };
}

export function Splitter({
  pane,
  width,
  sizing,
  side,
  label,
  controls,
  className,
}: {
  /** The pane it resizes, beside it in the same row. */
  pane: RefObject<HTMLElement | null>;
  /** The pane's stored width (it shows less when the row is too narrow). */
  width: number;
  sizing: PaneSizing;
  side: PaneSide;
  label: string;
  /** The pane's id. */
  controls?: string;
  className?: string;
}) {
  const self = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // What the pane measures and the most it may take, for assistive tech.
  const [measured, setMeasured] = useState<{ now: number; max: number } | null>(null);
  const max = (): number => (self.current?.parentElement?.clientWidth ?? Infinity) - sizing.keep;
  const shown = (): number => pane.current?.getBoundingClientRect().width ?? width;
  useEffect(() => {
    const element = pane.current;
    const row = self.current?.parentElement;
    if (element === null || row === null || row === undefined) return;
    const measure = (): void =>
      setMeasured({
        now: Math.round(element.getBoundingClientRect().width),
        max: Math.max(0, row.clientWidth - sizing.keep),
      });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(row);
    return () => observer.disconnect();
  }, [pane, sizing.keep]);

  const save = (next: number): void => writePref(sizing.key, String(next));
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = pane.current;
    if (event.button !== 0 || element === null) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const from = event.clientX;
    const was = shown();
    const most = max();
    let next: number | null = null;
    setDragging(true);
    // Its cursor wherever the pointer goes, and no text selected on the way (index.css).
    document.documentElement.dataset["resizing"] = "";
    const move = (e: PointerEvent): void => {
      next = draggedWidth(was, from, e.clientX, side, sizing.min, most);
      element.style.width = `${next}px`;
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("lostpointercapture", end);
      delete document.documentElement.dataset["resizing"];
      setDragging(false);
      if (next !== null) save(next);
    };
    handle.addEventListener("pointermove", move);
    // After pointerup and pointercancel alike.
    handle.addEventListener("lostpointercapture", end);
  };

  return (
    <div
      ref={self}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={measured?.now ?? width}
      aria-valuemin={sizing.min}
      aria-valuemax={measured?.max}
      tabIndex={0}
      title="Drag to resize, double-click for the default width"
      data-dragging={dragging || undefined}
      onPointerDown={start}
      onDoubleClick={() => save(sizing.defaultSize)}
      onKeyDown={(event) => {
        const next = keyedWidth(event.key, shown(), side, sizing.min, max());
        if (next === null) return;
        event.preventDefault();
        save(next);
      }}
      className={cn(
        "group relative z-10 flex w-px shrink-0 cursor-col-resize touch-none items-center justify-center bg-border outline-none select-none",
        // The strip to grab.
        "after:absolute after:inset-y-0 after:-inset-x-1 pointer-coarse:after:-inset-x-3",
        // The highlight.
        "before:absolute before:inset-y-0 before:-inset-x-px before:transition-colors hover:before:bg-primary/60 focus-visible:before:bg-primary data-dragging:before:bg-primary",
        className,
      )}
    >
      <span
        aria-hidden
        className="relative h-8 w-1 shrink-0 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-primary group-focus-visible:bg-primary group-data-dragging:bg-primary"
      />
    </div>
  );
}
