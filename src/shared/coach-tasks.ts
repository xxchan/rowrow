// Coach's scheduled tasks (docs/decisions.md, D-050), as roamgate's Ranger has them (notes:
// ranger-spec.md, section 4): a prompt you wrote, or confirmed from Coach's proposal, and a
// schedule. Each run is a fresh Coach chat on that prompt, started by the server whether or not
// a window is open; runs never overlap, and occurrences missed while a run went on or the server
// was down are combined into one. This module is what every side shares: the schedule's math
// (pure, so tests pin DST and catch-up), the planner the server's timer follows, and the words.
// No zod here: the kit (src/kit) reads these too.

/** Tasks one server keeps at most (Ranger's). */
export const MAX_TASKS = 50;
/** Runs kept per task, newest first: older run chats go (Ranger keeps 20 too). */
export const MAX_RUNS_KEPT = 20;
/** Notifications Coach sent per task that stay on record, to tell a repeat (Ranger's 100). */
export const MAX_NOTICES = 100;
export const MAX_TITLE_CHARS = 100;
/** Every N minutes: from 1 to a year, as Ranger allows. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 525_600;

export type TaskSchedule =
  /** Once, at this instant (UTC ISO 8601, ending in Z). */
  | { readonly type: "once"; readonly at: string }
  /** Every day at this wall-clock time in an IANA time zone. */
  | { readonly type: "daily"; readonly time: string; readonly timeZone: string }
  /** Every N minutes, the first N minutes after it was saved. */
  | { readonly type: "interval"; readonly minutes: number };

/** "every": a notification when each run finishes; "coach": Coach decides (failures still notify). */
export type TaskNotify = "every" | "coach";

/** What a task's run is: working, holding proposals for you, or over. */
export type TaskRunStatus = "running" | "waiting" | "succeeded" | "failed" | "stopped";

/** A task as every client sees it (AppState's coach.tasks). */
export interface CoachTask {
  readonly id: string;
  readonly title: string;
  /** The exact message each run sends Coach: the user's own words, written in advance. */
  readonly prompt: string;
  readonly schedule: TaskSchedule;
  readonly notify: TaskNotify;
  readonly status: "active" | "paused";
  /**
   * Saved while Full access was on (created in the form, or enabled by Coach with Full access):
   * its runs act without asking while Full access stays on. A task you confirmed from a card
   * never does: a confirmation doesn't authorize future automatic effects (Ranger's rule).
   */
  readonly fullAccess: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The next scheduled occurrence (epoch ms); null when none is coming. */
  readonly nextRunAt: number | null;
  /** An occurrence that came due and waits for its run: another run is going, or Run now. */
  readonly queuedAt: number | null;
  /** Its run that is working or holds proposals for you. */
  readonly currentRun: CoachTaskRun | null;
  /** Its latest run that is over. */
  readonly lastRun: CoachTaskRun | null;
  /** The latest notification about it, as it went out: windows show it as it arrives. */
  readonly lastNotice: TaskNotice | null;
}

export interface CoachTaskRun {
  readonly id: string;
  readonly taskId: string;
  /** Its Coach chat; null when it failed before one started (Coach can't run, nothing to read). */
  readonly chatId: string | null;
  readonly status: TaskRunStatus;
  /** The occurrence it runs for (the oldest, when missed ones were combined); a Run now's click. */
  readonly scheduledAt: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error: string | null;
  /** Run now, not the schedule. */
  readonly manual: boolean;
}

export interface TaskNotice {
  /** Unique per notification: a window shows each once. */
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly body: string;
  readonly at: number;
}

/** What Coach's notification tool takes (send_user_notification). */
export interface TaskNoticeInput {
  /** Names the agent and the outcome: the same key is never sent twice for a task. */
  readonly eventKey: string;
  readonly kind: "completed" | "attention";
  readonly title: string;
  readonly body: string;
}

/** A notification Coach sent for a task, as the next runs read it (they don't repeat it). */
export interface TaskNoticeReceipt extends TaskNoticeInput {
  readonly runId: string;
  readonly createdAt: string;
}

// ─── Schedules ──────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/** A schedule as given (a form, Coach's tool), checked and made canonical; throws with what's wrong. */
export function validateSchedule(value: unknown): TaskSchedule {
  if (typeof value !== "object" || value === null) throw new Error("Invalid task schedule");
  const s = value as Record<string, unknown>;
  if (s["type"] === "once") {
    const at = s["at"];
    const match =
      typeof at === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(at) : null;
    if (match !== null) {
      const date = new Date(at as string);
      const canonical = `${match[1]}T${match[2]}:${match[3]}.${(match[4] ?? "").padEnd(3, "0")}Z`;
      // Date normalizes impossible dates (February 30): those aren't the date that was asked for.
      if (Number.isFinite(date.getTime()) && date.toISOString() === canonical)
        return { type: "once", at: canonical };
    }
    throw new Error("Task time must be a valid UTC ISO timestamp");
  }
  if (s["type"] === "interval") {
    const minutes = s["minutes"];
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < MIN_INTERVAL_MINUTES ||
      minutes > MAX_INTERVAL_MINUTES
    )
      throw new Error(
        `Task interval must be ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} whole minutes`,
      );
    return { type: "interval", minutes };
  }
  if (s["type"] === "daily") {
    const { time, timeZone } = s;
    if (
      typeof time !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      typeof timeZone !== "string" ||
      timeZone.trim() === "" ||
      /^[+-]/.test(timeZone)
    )
      throw new Error("Daily tasks require HH:mm and an IANA timezone");
    let zone: string;
    try {
      zone = formatter(timeZone.trim()).resolvedOptions().timeZone;
    } catch {
      throw new Error("Invalid task timezone");
    }
    return { type: "daily", time, timeZone: zone };
  }
  throw new Error("Invalid task schedule");
}

/** Zoned calendar fields encoded as UTC, for calendar arithmetic (not an instant). */
function wallClock(format: Intl.DateTimeFormat, instant: number): Date {
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  const date = new Date(0);
  // setUTCFullYear: Date.UTC reads years 0 to 99 as 1900 to 1999.
  const year = Number(parts["year"]);
  date.setUTCFullYear(
    parts["era"] === "BC" ? 1 - year : year,
    Number(parts["month"]) - 1,
    Number(parts["day"]),
  );
  date.setUTCHours(Number(parts["hour"]), Number(parts["minute"]), Number(parts["second"]), 0);
  return date;
}

/**
 * The first occurrence after `after` (epoch ms), or null: a once that has passed. A daily time
 * is that wall-clock time in its zone, whatever the server's: one a DST gap skips doesn't run
 * that day, and one a fold repeats runs once, at its first occurrence (Ranger's rule).
 */
export function nextTaskTime(schedule: TaskSchedule, after: number): number | null {
  if (schedule.type === "once") {
    const at = Date.parse(schedule.at);
    return at > after ? at : null;
  }
  if (schedule.type === "interval") return after + schedule.minutes * MINUTE;
  const format = formatter(schedule.timeZone);
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  const date = wallClock(format, after);
  date.setUTCHours(hour, minute, 0, 0);
  // A day at a time, not a minute; the bound also ends the search for a time that never comes.
  for (let day = 0; day < 370 && Number.isFinite(date.getTime()); day++) {
    const local = date.getTime();
    const offsets = new Set<number>();
    // The zone's offsets on both sides of a clock change (half hours and date-line moves too).
    for (let hours = -36; hours <= 36; hours += 6) {
      const probe = local + hours * HOUR;
      offsets.add(wallClock(format, probe).getTime() - probe);
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const offset of offsets) {
      const candidate = local - offset;
      if (wallClock(format, candidate).getTime() === local) earliest = Math.min(earliest, candidate);
    }
    // A gap has no candidate; a fold counts only its first, even when `after` falls between the two.
    if (Number.isFinite(earliest) && earliest > after) return earliest;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return null;
}

/**
 * The occurrence after the one that came due at `previous`, now that it's `now`: an interval
 * keeps its cadence (previous + k·N, the first after now) rather than drifting with downtime.
 */
export function nextAfter(schedule: TaskSchedule, previous: number, now: number): number | null {
  if (schedule.type !== "interval") return nextTaskTime(schedule, Math.max(previous, now));
  const every = schedule.minutes * MINUTE;
  return previous + (Math.floor((Math.max(now, previous) - previous) / every) + 1) * every;
}

/** The first occurrence of a schedule saved now: a once at its time, even one already past. */
export function firstRunAt(schedule: TaskSchedule, now: number): number | null {
  return schedule.type === "once" ? Date.parse(schedule.at) : nextTaskTime(schedule, now);
}

/** Whether two schedules run at the same times (an edit that changes only words keeps its next run). */
export function sameSchedule(a: TaskSchedule, b: TaskSchedule): boolean {
  return JSON.stringify(validateSchedule(a)) === JSON.stringify(validateSchedule(b));
}

// ─── The planner ────────────────────────────────────────────────────────────

/** A task's timing, as the server's timer keeps it. */
export interface TaskTimes {
  readonly status: "active" | "paused";
  readonly schedule: TaskSchedule;
  readonly nextRunAt: number | null;
  /** An occurrence that came due and hasn't run: the oldest, when several did. */
  readonly dueAt: number | null;
  /** That occurrence is a Run now: it runs even while the task is paused. */
  readonly dueManual: boolean;
}

/**
 * Claim what came due by `now`. An active task whose next occurrence has passed holds it as due
 * (keeping one already due: missed ones combine into one run, never a backlog) and moves on to
 * the next one after now. A paused task claims nothing.
 */
export function claimDue(times: TaskTimes, now: number): TaskTimes {
  if (times.status !== "active" || times.nextRunAt === null || times.nextRunAt > now) return times;
  return {
    ...times,
    dueAt: times.dueAt ?? times.nextRunAt,
    nextRunAt: nextAfter(times.schedule, times.nextRunAt, now),
  };
}

/**
 * Which task runs next: none while a run is working (runs never overlap), else the one due the
 * longest among those with no run of their own still open (working, or holding proposals for
 * you: its next occurrences wait for it). Paused tasks run only for a Run now.
 */
export function nextToRun<T extends { readonly times: TaskTimes; readonly open: boolean }>(
  tasks: readonly T[],
  working: boolean,
): T | null {
  if (working) return null;
  let next: T | null = null;
  for (const task of tasks) {
    const { dueAt, status, dueManual } = task.times;
    if (task.open || dueAt === null || (status !== "active" && !dueManual)) continue;
    if (next === null || dueAt < (next.times.dueAt ?? Number.POSITIVE_INFINITY)) next = task;
  }
  return next;
}

/** When the timer should look again: the earliest next occurrence of an active task, or never. */
export function nextWake(tasks: readonly { readonly times: TaskTimes }[]): number | null {
  let wake: number | null = null;
  for (const { times } of tasks)
    if (times.status === "active" && times.nextRunAt !== null)
      wake = wake === null ? times.nextRunAt : Math.min(wake, times.nextRunAt);
  return wake;
}

/** Pause: no more occurrences, and one already due goes (a Run now still runs). */
export function paused(times: TaskTimes): TaskTimes {
  return { ...times, status: "paused", ...(times.dueManual ? {} : { dueAt: null }) };
}

/**
 * Resume: what passed while it was paused doesn't run (an interval keeps its cadence, a daily
 * waits for its next time), except a once that never ran: that one is still owed.
 */
export function resumed(times: TaskTimes, now: number): TaskTimes {
  const { schedule, nextRunAt } = times;
  const next =
    schedule.type === "once" || (nextRunAt !== null && nextRunAt > now)
      ? nextRunAt
      : nextRunAt === null
        ? nextTaskTime(schedule, now)
        : nextAfter(schedule, nextRunAt, now);
  return { ...times, status: "active", nextRunAt: next };
}

/** A new schedule: timed afresh from now, dropping an occurrence due under the old one. */
export function rescheduled(times: TaskTimes, schedule: TaskSchedule, now: number): TaskTimes {
  return {
    ...times,
    schedule,
    nextRunAt: firstRunAt(schedule, now),
    ...(times.dueManual ? {} : { dueAt: null }),
  };
}

// ─── Words ──────────────────────────────────────────────────────────────────

/** "Once: Oct 9, 3:00 PM", "Daily at 09:00 (Europe/London)", "Every 5 minutes", as Ranger says them. */
export function scheduleLabel(schedule: TaskSchedule, when: (at: number) => string): string {
  if (schedule.type === "once") return `Once: ${when(Date.parse(schedule.at))}`;
  if (schedule.type === "daily") return `Daily at ${schedule.time} (${schedule.timeZone})`;
  return `Every ${schedule.minutes} minute${schedule.minutes === 1 ? "" : "s"}`;
}

export const NOTIFY_LABELS: Readonly<Record<TaskNotify, string>> = {
  every: "Notify when each run finishes",
  coach: "Coach decides when to notify",
};

/** The notifications a run's end sends by itself (with "coach", only failures and confirmations). */
export const RUN_ALERTS = {
  succeeded: {
    title: "Coach task completed",
    body: (task: string) => `${task}: completed successfully.`,
  },
  failed: {
    title: "Coach task failed",
    body: (task: string) => `${task}: failed. Open Coach to review the task.`,
  },
  waiting: {
    title: "Coach task needs confirmation",
    body: (task: string) => `${task}: needs your confirmation. Open Coach to review the pending action.`,
  },
} as const;

/** Why a run ended without an answer, or was given up. */
export const RUN_ERRORS = {
  restarted: "rowrow restarted during this run.",
  previewsExpired: "rowrow restarted and this run's previews expired. Ask Coach for a fresh preview.",
  exited: "Coach's runtime exited before it answered.",
  gone: "This run's chat is no longer there.",
} as const;

/** Where a notification about a task's run takes you: Coach, on that task, with that run open. */
export function taskUrl(taskId: string, runId: string | null): string {
  const params = new URLSearchParams({ coachTask: taskId, ...(runId === null ? {} : { coachRun: runId }) });
  return `/?${params.toString()}`;
}
