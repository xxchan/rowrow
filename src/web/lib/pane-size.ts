// How wide a pane beside another one is (components/ui/splitter.tsx): the inspector beside the
// conversation, Files' tree beside its preview, Coach pinned beside the page. The width you drag
// a divider to is kept on this device in pixels (lib/device-prefs.ts), so the app's other tabs
// and the next visit show it. A narrower window doesn't change it: the pane is held between its
// minimum and what leaves the other side its own, and gets its width back when there's room.
// With no room for both, the other side keeps its own: the conversation stays readable beside
// an inspector squeezed by a pinned Coach.

/** One resizable pane. */
export interface PaneSizing {
  /** Where its width is kept (a `rowrow.*` device preference). */
  readonly key: string;
  /** Its width until you drag it, and after a double-click on the divider. */
  readonly defaultSize: number;
  readonly min: number;
  /** What the pane on the other side of the divider always keeps. */
  readonly keep: number;
}

/** Which side of its divider the resized pane is on. */
export type PaneSide = "left" | "right";

/** How far an arrow key moves a divider. */
export const KEY_STEP = 24;

/** A stored width: whole pixels, or `fallback` for nothing or junk. */
export function parseWidth(stored: string | null, fallback: number): number {
  const value = Number(stored ?? "");
  return stored !== null && /^\d+$/.test(stored) && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/** A width between `min` and `max`, in whole pixels; with no room for both, `max` (never below 0). */
export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.max(0, Math.min(max, Math.max(min, width))));
}

/** The pane's width after dragging its divider from `from` to `to` (client x). */
export function draggedWidth(
  width: number,
  from: number,
  to: number,
  side: PaneSide,
  min: number,
  max: number,
): number {
  return clampWidth(width + (side === "left" ? to - from : from - to), min, max);
}

/**
 * The pane's width after a key on its divider, or null for a key the divider doesn't take. The
 * arrows move the divider (← widens a pane on its right, narrows one on its left); Home and End
 * make the pane its narrowest and widest.
 */
export function keyedWidth(
  key: string,
  width: number,
  side: PaneSide,
  min: number,
  max: number,
): number | null {
  const move = key === "ArrowLeft" ? -KEY_STEP : key === "ArrowRight" ? KEY_STEP : 0;
  if (move !== 0) return clampWidth(width + (side === "left" ? move : -move), min, max);
  if (key === "Home") return clampWidth(min, min, max);
  if (key === "End") return clampWidth(max, min, max);
  return null;
}
