import { describe, expect, test } from "vitest";
import type { UsagePoint } from "../src/shared/schemas.ts";
import { chartSegments, cycleStarts, paceOf } from "../src/shared/usage.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const point = (at: number, left: number, resetsAt: number | null): UsagePoint => ({ at, left, resetsAt });

describe("a window's cycles", () => {
  test("start when the reset passes, or the reset moves more than the readings are apart", () => {
    const points = [
      point(0, 90, 5 * HOUR),
      point(5 * MIN, 88, 5 * HOUR + 30_000), // jitter: same cycle
      point(5 * HOUR + MIN, 100, 10 * HOUR), // the reset passed
      point(5 * HOUR + 6 * MIN, 99, 12 * HOUR), // moved 2 h in 5 min: a new cycle
    ];
    expect(cycleStarts(points)).toEqual([0, 2, 3]);
  });

  test("start when a reset time appears or goes, or, without one, when much more is left", () => {
    expect(cycleStarts([point(0, 50, null), point(MIN, 50, HOUR)])).toEqual([0, 1]);
    expect(cycleStarts([point(0, 50, HOUR), point(MIN, 50, null)])).toEqual([0, 1]);
    expect(cycleStarts([point(0, 50, null), point(MIN, 54, null), point(2 * MIN, 60, null)])).toEqual([0, 2]);
  });
});

describe("a window's pace", () => {
  test("compares what's left with an even burn over the window's length", () => {
    // 3 h 54 m of 5 h to go: an even burn leaves 78%.
    const points = [point(0, 77, 234 * MIN)];
    const pace = paceOf(points, 5 * HOUR, 0);
    expect(pace.kind).toBe("known");
    if (pace.kind === "known") expect(pace.reserve).toBeCloseTo(-1);
    expect(paceOf([point(0, 90, 234 * MIN)], 5 * HOUR, 0)).toMatchObject({ reserve: 12 });
  });

  test("is unknown without a reset time, or once the reset has passed", () => {
    expect(paceOf([point(0, 77, null)], 5 * HOUR, 0)).toEqual({ kind: "unknown" });
    expect(paceOf([point(0, 77, HOUR)], 5 * HOUR, 2 * HOUR)).toEqual({ kind: "unknown" });
  });

  test("without the window's length, needs to have seen the cycle start", () => {
    // History that starts mid-cycle: its first reading isn't the cycle's start.
    expect(paceOf([point(0, 60, 4 * HOUR), point(HOUR, 50, 4 * HOUR)], null, HOUR)).toEqual({
      kind: "unknown",
    });
    // The last cycle ended at 1 h; this one runs from its first reading to 6 h.
    const points = [point(0, 10, HOUR), point(HOUR + MIN, 100, 6 * HOUR), point(2 * HOUR, 90, 6 * HOUR)];
    const pace = paceOf(points, null, 2 * HOUR);
    expect(pace).toMatchObject({ kind: "known", spanMs: 6 * HOUR - (HOUR + MIN) });
  });
});

test("a chart's line breaks at a new cycle and across a long gap the value changed in", () => {
  const points = [
    point(0, 90, 5 * HOUR),
    point(5 * MIN, 90, 5 * HOUR),
    point(HOUR, 90, 5 * HOUR), // a long gap, but nothing changed
    point(2 * HOUR, 70, 5 * HOUR), // a long gap, and it changed
    point(5 * HOUR + MIN, 100, 10 * HOUR), // a new cycle
  ];
  expect(chartSegments(points).map((segment) => segment.length)).toEqual([3, 1, 1]);
});
