// Coach's scheduled tasks (D-050), the pure part: when a schedule runs next (DST included), how
// missed occurrences combine into one run, that runs never overlap, and what pausing does.
import { describe, expect, it } from "vitest";
import {
  claimDue,
  firstRunAt,
  nextAfter,
  nextTaskTime,
  nextToRun,
  nextWake,
  paused,
  rescheduled,
  resumed,
  sameSchedule,
  scheduleLabel,
  validateSchedule,
  type TaskSchedule,
  type TaskTimes,
} from "../src/shared/coach-tasks.ts";

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const MIN = 60_000;

describe("A task's schedule", () => {
  it("is checked and made canonical", () => {
    expect(validateSchedule({ type: "once", at: "2026-10-09T15:00:00Z" })).toEqual({
      type: "once",
      at: "2026-10-09T15:00:00.000Z",
    });
    expect(() => validateSchedule({ type: "once", at: "2026-02-30T15:00:00Z" })).toThrow("valid UTC ISO");
    expect(() => validateSchedule({ type: "once", at: "2026-10-09T15:00:00+02:00" })).toThrow(
      "valid UTC ISO",
    );
    expect(validateSchedule({ type: "interval", minutes: 1 })).toEqual({ type: "interval", minutes: 1 });
    expect(() => validateSchedule({ type: "interval", minutes: 0 })).toThrow("1 to 525600 whole minutes");
    expect(() => validateSchedule({ type: "interval", minutes: 2.5 })).toThrow("whole minutes");
    expect(validateSchedule({ type: "daily", time: "09:00", timeZone: "europe/london" })).toEqual({
      type: "daily",
      time: "09:00",
      timeZone: "Europe/London",
    });
    expect(() => validateSchedule({ type: "daily", time: "9:00", timeZone: "UTC" })).toThrow("HH:mm");
    expect(() => validateSchedule({ type: "daily", time: "09:00", timeZone: "+08" })).toThrow("IANA");
    expect(() => validateSchedule({ type: "daily", time: "09:00", timeZone: "Mars/Olympus" })).toThrow(
      "Invalid task timezone",
    );
    expect(() => validateSchedule({ type: "weekly" })).toThrow("Invalid task schedule");
    expect(
      sameSchedule(
        { type: "daily", time: "09:00", timeZone: "europe/london" },
        {
          type: "daily",
          time: "09:00",
          timeZone: "Europe/London",
        },
      ),
    ).toBe(true);
  });

  it("runs once at its time, and never after it", () => {
    const once: TaskSchedule = { type: "once", at: "2026-10-09T15:00:00.000Z" };
    expect(iso(nextTaskTime(once, at("2026-10-09T14:00:00Z")))).toBe("2026-10-09T15:00:00.000Z");
    expect(nextTaskTime(once, at("2026-10-09T15:00:00Z"))).toBeNull();
    // Saved after its time, it still runs (at the next look), as Ranger's does.
    expect(iso(firstRunAt(once, at("2026-10-10T00:00:00Z")))).toBe("2026-10-09T15:00:00.000Z");
  });

  it("runs every N minutes from when it was saved, keeping its cadence after a gap", () => {
    const every: TaskSchedule = { type: "interval", minutes: 5 };
    const saved = at("2026-10-09T10:02:00Z");
    expect(iso(firstRunAt(every, saved))).toBe("2026-10-09T10:07:00.000Z");
    // Due at 10:07, looked at 10:07:30: next 10:12. Down from 10:07 to 10:31: next 10:32, not 10:36.
    expect(iso(nextAfter(every, at("2026-10-09T10:07:00Z"), at("2026-10-09T10:07:30Z")))).toBe(
      "2026-10-09T10:12:00.000Z",
    );
    expect(iso(nextAfter(every, at("2026-10-09T10:07:00Z"), at("2026-10-09T10:31:00Z")))).toBe(
      "2026-10-09T10:32:00.000Z",
    );
    expect(iso(nextAfter(every, at("2026-10-09T10:07:00Z"), at("2026-10-09T10:32:00Z")))).toBe(
      "2026-10-09T10:37:00.000Z",
    );
  });

  it("runs daily at a wall-clock time in its own zone, through DST", () => {
    const london: TaskSchedule = { type: "daily", time: "09:00", timeZone: "Europe/London" };
    // BST (UTC+1) in October, GMT after the clocks go back on Oct 25.
    expect(iso(nextTaskTime(london, at("2026-10-09T07:00:00Z")))).toBe("2026-10-09T08:00:00.000Z");
    expect(iso(nextTaskTime(london, at("2026-10-09T08:00:00Z")))).toBe("2026-10-10T08:00:00.000Z");
    expect(iso(nextTaskTime(london, at("2026-10-24T12:00:00Z")))).toBe("2026-10-25T09:00:00.000Z");

    // New York springs forward on 2026-03-08: 02:30 doesn't exist that day, so it doesn't run.
    const gap: TaskSchedule = { type: "daily", time: "02:30", timeZone: "America/New_York" };
    expect(iso(nextTaskTime(gap, at("2026-03-07T12:00:00Z")))).toBe("2026-03-09T06:30:00.000Z");
    // It falls back on 2026-11-01: 01:30 happens twice, and runs at the first.
    const fold: TaskSchedule = { type: "daily", time: "01:30", timeZone: "America/New_York" };
    const first = nextTaskTime(fold, at("2026-11-01T00:00:00Z"));
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    // …and only once: between the two, the next is the day after.
    expect(iso(nextTaskTime(fold, at("2026-11-01T06:00:00Z")))).toBe("2026-11-02T06:30:00.000Z");

    // Half-hour zones, and a day's wrap.
    const kolkata: TaskSchedule = { type: "daily", time: "00:15", timeZone: "Asia/Kolkata" };
    expect(iso(nextTaskTime(kolkata, at("2026-10-09T12:00:00Z")))).toBe("2026-10-09T18:45:00.000Z");
  });

  it("says what it is, as Ranger does", () => {
    const when = (ms: number) => new Date(ms).toISOString();
    expect(scheduleLabel({ type: "interval", minutes: 1 }, when)).toBe("Every 1 minute");
    expect(scheduleLabel({ type: "interval", minutes: 15 }, when)).toBe("Every 15 minutes");
    expect(scheduleLabel({ type: "daily", time: "09:00", timeZone: "Europe/London" }, when)).toBe(
      "Daily at 09:00 (Europe/London)",
    );
    expect(scheduleLabel({ type: "once", at: "2026-10-09T15:00:00.000Z" }, when)).toBe(
      "Once: 2026-10-09T15:00:00.000Z",
    );
  });
});

describe("The planner", () => {
  const every5: TaskSchedule = { type: "interval", minutes: 5 };
  const t0 = at("2026-10-09T10:00:00Z");
  const times = (over: Partial<TaskTimes> = {}): TaskTimes => ({
    status: "active",
    schedule: every5,
    nextRunAt: t0 + 5 * MIN,
    dueAt: null,
    dueManual: false,
    ...over,
  });

  it("claims an occurrence when it comes due, and combines the ones missed into one", () => {
    expect(claimDue(times(), t0 + 4 * MIN)).toEqual(times());
    const due = claimDue(times(), t0 + 5 * MIN);
    expect(due).toMatchObject({ dueAt: t0 + 5 * MIN, nextRunAt: t0 + 10 * MIN });
    // The server was down for an hour: one run, for the oldest missed occurrence; the cadence holds.
    const back = claimDue(times(), t0 + 63 * MIN);
    expect(back).toMatchObject({ dueAt: t0 + 5 * MIN, nextRunAt: t0 + 65 * MIN });
    // Still due when the next one comes (a run is going): it stays one occurrence, the oldest.
    expect(claimDue(back, t0 + 66 * MIN)).toMatchObject({ dueAt: t0 + 5 * MIN, nextRunAt: t0 + 70 * MIN });
    // A once is claimed once.
    const once = times({ schedule: { type: "once", at: new Date(t0).toISOString() }, nextRunAt: t0 });
    expect(claimDue(once, t0 + MIN)).toMatchObject({ dueAt: t0, nextRunAt: null });
  });

  it("never starts a run while one works, nor a task's next while its last is open", () => {
    const a = { id: "a", open: false, times: times({ dueAt: t0 + 2 * MIN }) };
    const b = { id: "b", open: false, times: times({ dueAt: t0 + MIN }) };
    const c = { id: "c", open: true, times: times({ dueAt: t0 }) };
    expect(nextToRun([a, b, c], true)).toBeNull();
    // The oldest due first; c's last run is still open (it holds proposals for you), so it waits.
    expect(nextToRun([a, b, c], false)?.id).toBe("b");
    expect(nextToRun([c], false)).toBeNull();
    expect(nextToRun([{ id: "d", open: false, times: times() }], false)).toBeNull();
  });

  it("pauses: nothing comes due, an occurrence due goes, Run now still runs", () => {
    const due = times({ dueAt: t0 + 5 * MIN });
    const p = paused(due);
    expect(p).toMatchObject({ status: "paused", dueAt: null });
    expect(claimDue(p, t0 + 60 * MIN)).toEqual(p);
    expect(nextToRun([{ open: false, times: p }], false)).toBeNull();
    expect(nextWake([{ times: p }])).toBeNull();
    const manual = { open: false, times: { ...p, dueAt: t0 + 7 * MIN, dueManual: true } };
    expect(nextToRun([manual], false)).toBe(manual);
    expect(paused(manual.times)).toMatchObject({ dueAt: t0 + 7 * MIN });
  });

  it("resumes without running what passed while paused, except a once that never ran", () => {
    const p = paused(times());
    // Paused at 10:00 with 10:05 next; resumed at 10:31: next 10:35, and nothing due.
    expect(resumed(p, t0 + 31 * MIN)).toMatchObject({
      status: "active",
      nextRunAt: t0 + 35 * MIN,
      dueAt: null,
    });
    expect(resumed(p, t0 + MIN)).toMatchObject({ nextRunAt: t0 + 5 * MIN });
    const daily: TaskSchedule = { type: "daily", time: "09:00", timeZone: "UTC" };
    expect(
      iso(resumed(paused(times({ schedule: daily, nextRunAt: at("2026-10-09T09:00:00Z") })), t0).nextRunAt),
    ).toBe("2026-10-10T09:00:00.000Z");
    const once = times({ schedule: { type: "once", at: new Date(t0).toISOString() }, nextRunAt: t0 });
    expect(resumed(paused(once), t0 + 60 * MIN).nextRunAt).toBe(t0);
  });

  it("times a new schedule afresh, keeping a Run now", () => {
    const due = times({ dueAt: t0 + 5 * MIN });
    expect(rescheduled(due, { type: "interval", minutes: 30 }, t0 + 6 * MIN)).toMatchObject({
      nextRunAt: t0 + 36 * MIN,
      dueAt: null,
    });
    expect(rescheduled({ ...due, dueManual: true }, every5, t0)).toMatchObject({ dueAt: t0 + 5 * MIN });
    expect(nextWake([{ times: times() }, { times: times({ nextRunAt: t0 + MIN }) }])).toBe(t0 + MIN);
  });
});
