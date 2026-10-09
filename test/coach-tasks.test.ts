// Coach's scheduled tasks (D-050), the pure part: when a schedule runs next (DST included), how
// missed occurrences combine into one run, that runs never overlap, and what pausing does.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
import { coachActionsOf } from "../src/shared/coach-actions.ts";
import { newInputId } from "../src/shared/ids.ts";
import { eventually, startTestServer, type TestServer } from "./helpers.ts";

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

// ─── The server ───────────────────────────────────────────────────────────────

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setUp() {
  t = await startTestServer();
  const a = await t.client.workspaces.add({ path: t.repo("a") });
  const helper = (await t.client.agents.create({ workspaceId: a.id, runtime: "scripted", title: "helper" }))
    .agent;
  const coach = { workspaces: [a.id], runtime: "scripted", model: null, effort: null, fullAccess: false };
  await t.client.settings.update({ coach });
  return { server: t, a, helper, coach };
}

const hourly: TaskSchedule = { type: "interval", minutes: 60 };

function newTask(
  server: TestServer,
  prompt: string,
  over: Partial<{ title: string; notify: "every" | "coach" }> = {},
) {
  return server.client.coach.createTask({
    requestId: newInputId(),
    title: over.title ?? "Check the helper",
    prompt,
    schedule: hourly,
    notify: over.notify ?? "every",
  });
}

async function taskOf(server: TestServer, id: string) {
  const task = (await server.client.state.get()).state.coach.tasks.find((x) => x.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
}

/** Wait for a task's run to end (or to hold proposals for you), and return it. */
async function ran(server: TestServer, id: string, after = 0, status?: string) {
  return eventually(async () => {
    const task = await taskOf(server, id);
    const run = task.currentRun?.status === "waiting" ? task.currentRun : task.lastRun;
    return run !== null && run.startedAt >= after && (status === undefined || run.status === status)
      ? run
      : undefined;
  }, 20_000);
}

async function textOf(server: TestServer, chatId: string | null): Promise<string> {
  if (chatId === null) throw new Error("no chat");
  return (await server.client.agents.view({ agentId: chatId })).text;
}

describe("Coach's tasks", () => {
  it("are created, edited, paused, run now, and deleted with their runs", async () => {
    const { server } = await setUp();
    const before = Date.now();
    const requestId = newInputId();
    const input = { requestId, title: "Check the helper", prompt: "/echo all quiet", schedule: hourly };
    const task = await server.client.coach.createTask(input);
    expect(task).toMatchObject({ status: "active", notify: "every", fullAccess: false, currentRun: null });
    expect(task.nextRunAt).toBeGreaterThanOrEqual(before + 60 * MIN);
    // A retry is the same task.
    expect((await server.client.coach.createTask(input)).id).toBe(task.id);
    expect((await server.client.coach.tasks()).map((x) => x.id)).toEqual([task.id]);

    // New words keep the next run; a new schedule moves it.
    const renamed = await server.client.coach.updateTask({
      taskId: task.id,
      ...input,
      title: "Watch the helper",
    });
    expect(renamed).toMatchObject({ title: "Watch the helper", nextRunAt: task.nextRunAt });
    const daily = await server.client.coach.updateTask({
      taskId: task.id,
      ...input,
      schedule: { type: "daily", time: "09:00", timeZone: "Europe/London" },
    });
    expect(daily.nextRunAt).toBe(
      nextTaskTime({ type: "daily", time: "09:00", timeZone: "Europe/London" }, Date.now()),
    );
    await expect(
      server.client.coach.updateTask({
        taskId: task.id,
        ...input,
        schedule: { type: "interval", minutes: 0 },
      }),
    ).rejects.toThrow();

    // Paused, it runs only when you say so; the run is a Coach chat of its own, in History.
    expect((await server.client.coach.pauseTask({ taskId: task.id, paused: true })).status).toBe("paused");
    const started = Date.now();
    await server.client.coach.runTask({ taskId: task.id });
    const run = await ran(server, task.id, started, "succeeded");
    expect(run).toMatchObject({ manual: true, error: null });
    expect(await textOf(server, run.chatId)).toContain("all quiet");
    const { entries } = await server.client.agents.entries({ agentId: run.chatId ?? "" });
    expect(entries.find((e) => e.kind === "input")).toMatchObject({
      text: "/echo all quiet",
      by: { kind: "system" },
    });
    const { state } = await server.client.state.get();
    // It never takes the place of the chat you're having.
    expect(state.coach.chat).toBeNull();
    expect(state.agents[run.chatId ?? ""]).toBeUndefined();
    expect((await server.client.coach.chats()).find((c) => c.id === run.chatId)).toMatchObject({
      title: "Check the helper",
      taskId: task.id,
      current: false,
    });
    expect(await taskOf(server, task.id)).toMatchObject({
      status: "paused",
      lastNotice: { title: "Coach task completed", body: "Check the helper: completed successfully." },
    });
    expect(await server.client.coach.taskRuns({ taskId: task.id })).toEqual([run]);

    await server.client.coach.deleteTask({ taskId: task.id });
    expect(await server.client.coach.tasks()).toEqual([]);
    await eventually(async () =>
      (await server.client.coach.chats()).some((c) => c.id === run.chatId) ? undefined : true,
    );
  }, 40_000);

  it("notify as Coach decides: once an event, once a run, and a failure anyway", async () => {
    const { server } = await setUp();
    const notice = JSON.stringify({
      eventKey: "helper-done",
      kind: "completed",
      title: "Helper finished",
      body: "Its tests pass.",
    });
    const task = await newTask(server, `/mcp send_user_notification ${notice}`, { notify: "coach" });
    await server.client.coach.runTask({ taskId: task.id });
    const first = await ran(server, task.id, 0, "succeeded");
    const told = await taskOf(server, task.id);
    expect(told.lastNotice).toMatchObject({
      runId: first.id,
      title: "Helper finished",
      body: "Its tests pass.",
    });
    // Its transcript says so, and the run read what it may notify about.
    const { entries } = await server.client.agents.entries({ agentId: first.chatId ?? "", full: true });
    expect(entries.find((e) => e.kind === "notification.sent")).toMatchObject({
      title: "Helper finished",
      dedupKey: "helper-done",
    });
    expect(JSON.stringify(entries)).toContain("Notification policy for this confirmed task: coach.");

    // The same event again isn't sent again, and a quiet success says nothing.
    const again = Date.now();
    await server.client.coach.runTask({ taskId: task.id });
    const second = await ran(server, task.id, again, "succeeded");
    expect(await textOf(server, second.chatId)).toContain('"reason":"already_notified"');
    expect((await taskOf(server, task.id)).lastNotice?.id).toBe(told.lastNotice?.id);
    const raw = JSON.stringify(
      (await server.client.agents.entries({ agentId: second.chatId ?? "", full: true })).entries,
    );
    expect(raw).toContain("helper-done");

    // A failed run notifies even so.
    const failing = await newTask(server, "/fail the build broke", { notify: "coach", title: "Build" });
    await server.client.coach.runTask({ taskId: failing.id });
    expect(await ran(server, failing.id, 0, "failed")).toMatchObject({ error: "the build broke" });
    expect((await taskOf(server, failing.id)).lastNotice).toMatchObject({
      title: "Coach task failed",
      body: "Build: failed. Open Coach to review the task.",
    });

    // Every run: one notification each.
    const each = await newTask(server, "/echo fine", { title: "Each" });
    await server.client.coach.runTask({ taskId: each.id });
    await ran(server, each.id, 0, "succeeded");
    expect((await taskOf(server, each.id)).lastNotice?.title).toBe("Coach task completed");
  }, 60_000);

  it("keep their tools apart: a chat proposes tasks, a run notifies", async () => {
    const { server } = await setUp();
    const sent = await server.client.coach.send({
      inputId: newInputId(),
      text: '/mcp send_user_notification {"eventKey":"x","kind":"completed","title":"t","body":"b"}',
    });
    await server.client.agents.wait({ agentId: sent.chatId, afterSeq: sent.seq, timeoutMs: 15_000 });
    expect(await textOf(server, sent.chatId)).toContain("Unknown tool: send_user_notification");
    await expect(
      server.client.coach.notify({
        chatId: sent.chatId,
        eventKey: "x",
        kind: "completed",
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow("only for a scheduled task's run");

    const task = await newTask(
      server,
      '/mcp propose_coach_task {"title":"x","prompt":"y","schedule":{"type":"interval","minutes":5}}',
    );
    await server.client.coach.runTask({ taskId: task.id });
    const run = await ran(server, task.id, 0, "succeeded");
    expect(await textOf(server, run.chatId)).toContain("Unknown tool: propose_coach_task");
    expect((await server.client.coach.tasks()).length).toBe(1);
  }, 40_000);

  it("run one at a time, and a run holding a proposal waits for you", async () => {
    const { server, helper } = await setUp();
    const slow = await newTask(server, "/sleep 1500", { title: "Slow" });
    const quick = await newTask(server, "/echo quick", { title: "Quick" });
    await server.client.coach.runTask({ taskId: slow.id });
    await eventually(async () =>
      (await taskOf(server, slow.id)).currentRun?.status === "running" ? true : undefined,
    );
    await server.client.coach.runTask({ taskId: quick.id });
    // Queued behind the slow one, not beside it.
    expect(await taskOf(server, quick.id)).toMatchObject({
      currentRun: null,
      queuedAt: expect.any(Number) as unknown,
    });
    await expect(server.client.coach.runTask({ taskId: slow.id })).rejects.toThrow("still going");
    const slowRun = await ran(server, slow.id, 0, "succeeded");
    const quickRun = await ran(server, quick.id, 0, "succeeded");
    expect(quickRun.startedAt).toBeGreaterThanOrEqual(slowRun.finishedAt ?? Number.POSITIVE_INFINITY);

    // A run that proposes something holds it for you; the task's next run waits for your answer.
    const asks = await newTask(
      server,
      `/mcp propose_agent_prompt {"agentId":"${helper.id}","prompt":"/echo from a task"}`,
      { title: "Asks" },
    );
    await server.client.coach.runTask({ taskId: asks.id });
    const waiting = await ran(server, asks.id, 0, "waiting");
    expect((await taskOf(server, asks.id)).lastNotice).toMatchObject({
      title: "Coach task needs confirmation",
      body: "Asks: needs your confirmation. Open Coach to review the pending action.",
    });
    await expect(server.client.coach.runTask({ taskId: asks.id })).rejects.toThrow("still going");
    const chatId = waiting.chatId ?? "";
    const { entries } = await server.client.agents.entries({ agentId: chatId, full: true });
    const pending = [...coachActionsOf(entries).values()][0];
    expect(pending?.status).toBe("pending");
    const done = await server.client.coach.confirm({ chatId, actionId: pending?.proposal.id ?? "" });
    expect(done.status).toBe("succeeded");
    expect(await ran(server, asks.id, 0, "succeeded")).toMatchObject({ id: waiting.id });

    // Stop ends a run quietly.
    const stopped = await newTask(server, "/sleep 10000", { title: "Stopped" });
    await server.client.coach.runTask({ taskId: stopped.id });
    await eventually(async () => ((await taskOf(server, stopped.id)).currentRun?.chatId ? true : undefined));
    await server.client.coach.stopTask({ taskId: stopped.id });
    expect(await ran(server, stopped.id, 0, "stopped")).toMatchObject({ error: null });
    expect((await taskOf(server, stopped.id)).lastNotice).toBeNull();
  }, 60_000);

  it("act without you only when saved with Full access, while it lasts", async () => {
    const { server, helper, coach } = await setUp();
    const propose = `/mcp propose_agent_prompt {"agentId":"${helper.id}","prompt":"/echo hello"}`;
    // Confirmed from Coach's card: a confirmation never authorizes later runs to act.
    const sent = await server.client.coach.send({
      inputId: newInputId(),
      text: `/mcp propose_coach_task ${JSON.stringify({ title: "Card", prompt: propose, schedule: hourly, notify: "every" })}`,
    });
    await server.client.agents.wait({ agentId: sent.chatId, afterSeq: sent.seq, timeoutMs: 15_000 });
    const card = (await server.client.state.get()).state.coach.chat?.summary.coachActions[0];
    expect(card?.proposal).toMatchObject({
      kind: "create_task",
      params: { title: "Card", schedule: hourly },
    });
    await server.client.settings.update({ coach: { ...coach, fullAccess: true } });
    // (Turning Full access on expired the preview: ask again, and confirm it by hand.)
    const again = await server.client.coach.send({
      inputId: newInputId(),
      text: `/mcp propose_coach_task ${JSON.stringify({ title: "Card", prompt: propose, schedule: hourly })}`,
    });
    await server.client.agents.wait({ agentId: again.chatId, afterSeq: again.seq, timeoutMs: 15_000 });
    const enabled = (await server.client.coach.tasks()).find((x) => x.title === "Card");
    // With Full access, Coach enabled it itself, in that mode.
    expect(enabled?.fullAccess).toBe(true);
    await server.client.coach.deleteTask({ taskId: enabled?.id ?? "" });
    await server.client.settings.update({ coach: { ...coach, fullAccess: false } });
    const third = await server.client.coach.send({
      inputId: newInputId(),
      text: `/mcp propose_coach_task ${JSON.stringify({ title: "Card", prompt: propose, schedule: hourly })}`,
    });
    await server.client.agents.wait({ agentId: third.chatId, afterSeq: third.seq, timeoutMs: 15_000 });
    const proposal = (await server.client.state.get()).state.coach.chat?.summary.coachActions[0];
    const confirmed = await server.client.coach.confirm({
      chatId: third.chatId,
      actionId: proposal?.proposal.id ?? "",
    });
    expect(confirmed).toMatchObject({
      status: "succeeded",
      detail: expect.stringMatching(/^Enabled task Card \(tk_/) as unknown,
    });
    const manual = (await server.client.coach.tasks()).find((x) => x.title === "Card");
    expect(manual?.fullAccess).toBe(false);

    // Full access on, but this task wasn't saved with it: its run asks.
    await server.client.settings.update({ coach: { ...coach, fullAccess: true } });
    await server.client.coach.runTask({ taskId: manual?.id ?? "" });
    expect((await ran(server, manual?.id ?? "", 0, "waiting")).status).toBe("waiting");

    // Saved with Full access (the form, while it's on): its run acts at once.
    const auto = await newTask(server, propose, { title: "Auto" });
    expect(auto.fullAccess).toBe(true);
    await server.client.coach.runTask({ taskId: auto.id });
    const run = await ran(server, auto.id, 0, "succeeded");
    expect(await textOf(server, run.chatId)).toContain('"status":"succeeded"');
    // …but not once Full access is off again.
    await server.client.settings.update({ coach: { ...coach, fullAccess: false } });
    const later = Date.now();
    await server.client.coach.runTask({ taskId: auto.id });
    expect((await ran(server, auto.id, later, "waiting")).status).toBe("waiting");
  }, 60_000);

  it("catch up once after the server was down, and end a run it left behind", async () => {
    const { server } = await setUp();
    const task = await server.client.coach.createTask({
      requestId: newInputId(),
      title: "Every 5",
      prompt: "/echo caught up",
      schedule: { type: "interval", minutes: 5 },
    });
    const sleeper = await newTask(server, "/sleep 20000", { title: "Sleeper" });
    await server.client.coach.runTask({ taskId: sleeper.id });
    await eventually(async () => ((await taskOf(server, sleeper.id)).currentRun?.chatId ? true : undefined));
    const home = server.home;
    await server.server.close();
    // Down for 23 minutes: four occurrences of the 5-minute task were missed.
    const db = new DatabaseSync(path.join(home, "test", "rowrow.db"));
    const due = (task.nextRunAt ?? 0) - 23 * MIN;
    db.prepare("update coach_tasks set next_run_at = ? where id = ?").run(due, task.id);
    db.close();
    t = await startTestServer({ home });
    const back = t;
    // The run the last server left: over, and said so.
    expect((await back.client.coach.taskRuns({ taskId: sleeper.id }))[0]).toMatchObject({
      status: "failed",
      error: "rowrow restarted during this run.",
    });
    // One run for all four, for the oldest; the cadence holds (the fifth is 2 minutes off).
    const run = await ran(back, task.id, 0, "succeeded");
    expect(run.scheduledAt).toBe(due);
    const after = await taskOf(back, task.id);
    expect(after.nextRunAt).toBe(due + 20 * MIN);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await back.client.coach.taskRuns({ taskId: task.id })).toHaveLength(1);
  }, 60_000);
});
