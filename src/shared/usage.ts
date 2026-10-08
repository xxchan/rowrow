// Folds over a subscription window's stored readings (D-040): where its cycles start, how
// its use compares with an even burn, and where a chart's line breaks. Only readings are
// stored; everything here is computed when it's shown.

import type { RuntimeUsage, UsagePoint } from "./schemas.ts";

const MINUTE = 60_000;
/** A reset that moves by more than the time between two readings, plus this, starts a new cycle. */
const RESET_SLACK_MS = 5 * MINUTE;
/** Without a reset time, this much more left (percentage points) means the window reset. */
const REFILL_POINTS = 5;
/** A chart's line breaks across a gap this long when the value changed in it. */
const GAP_MS = 15 * MINUTE;

/** Whether `next` is the first reading of a new cycle after `prev`. */
function startsCycle(prev: UsagePoint, next: UsagePoint): boolean {
  if (prev.resetsAt !== null && next.resetsAt !== null) {
    return (
      next.at >= prev.resetsAt || Math.abs(next.resetsAt - prev.resetsAt) > next.at - prev.at + RESET_SLACK_MS
    );
  }
  if (prev.resetsAt !== null || next.resetsAt !== null) return true;
  return next.left - prev.left >= REFILL_POINTS;
}

/** The index of each cycle's first reading, oldest first; 0 is always one when there are readings. */
export function cycleStarts(points: readonly UsagePoint[]): number[] {
  return points.flatMap((point, index) => {
    const prev = points[index - 1];
    return prev === undefined || startsCycle(prev, point) ? [index] : [];
  });
}

export type Pace =
  | {
      readonly kind: "known";
      /** Percentage points left beyond an even burn's (negative: a deficit). */
      readonly reserve: number;
      /** How long the cycle is, in ms. */
      readonly spanMs: number;
    }
  | { readonly kind: "unknown" };

/**
 * How the last reading compares with burning the window evenly over its cycle. Unknown
 * without a reset time, once the reset has passed (the new cycle isn't read yet), or without
 * the cycle's length: the window's own, else from this cycle's first reading to its reset,
 * which only counts when the reading before it was the end of the last cycle (history that
 * starts mid-cycle would show a deficit that isn't there).
 */
export function paceOf(points: readonly UsagePoint[], durationMs: number | null, now: number): Pace {
  const last = points.at(-1);
  if (last === undefined || last.resetsAt === null || last.resetsAt <= now) return { kind: "unknown" };
  let spanMs = durationMs;
  if (spanMs === null) {
    const first = points[cycleStarts(points).at(-1) ?? 0];
    if (first === undefined || first === points[0]) return { kind: "unknown" };
    spanMs = last.resetsAt - first.at;
  }
  if (spanMs <= 0) return { kind: "unknown" };
  return { kind: "known", reserve: last.left - evenBurn(last.resetsAt, spanMs, last.at), spanMs };
}

/** What an even burn leaves at `at`, in percent: the share of the cycle still to go. */
export function evenBurn(resetsAt: number, spanMs: number, at: number): number {
  return Math.min(100, Math.max(0, (100 * (resetsAt - at)) / spanMs));
}

/** The readings split where a chart's line breaks: a new cycle, or a long gap the value changed across. */
export function chartSegments(points: readonly UsagePoint[]): UsagePoint[][] {
  const segments: UsagePoint[][] = [];
  let current: UsagePoint[] = [];
  points.forEach((point, index) => {
    const prev = points[index - 1];
    if (
      prev !== undefined &&
      (startsCycle(prev, point) || (point.at - prev.at > GAP_MS && point.left !== prev.left))
    ) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

/** How long until `at`, coarsely: "12m", "3h 54m", "1d 1h". */
export function untilWords(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "Reserve 5%", "Deficit 2%", "On pace" or "Pace unknown". */
export function paceWords(pace: Pace): string {
  if (pace.kind === "unknown") return "Pace unknown";
  const points = Math.round(pace.reserve);
  if (points === 0) return "On pace";
  return points > 0 ? `Reserve ${points}%` : `Deficit ${-points}%`;
}

/** Why there's no usage to show, in a sentence. */
export function usageProblemWords(problem: NonNullable<RuntimeUsage["problem"]>): string {
  switch (problem.kind) {
    case "signed_out":
      return "Not signed in.";
    case "unsupported":
      return "Its provider doesn't report usage for this sign-in (an API key, for one).";
    case "failed":
      return `Couldn't read it: ${problem.detail ?? "it failed"}.`;
  }
}
