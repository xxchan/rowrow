// `rowrow coach tasks` and `rowrow coach task …`: Coach's scheduled tasks (D-050) from the
// command line, through the same coach.* procedures the web app's Tasks view calls.
import {
  scheduleLabel,
  type CoachTask,
  type CoachTaskRun,
  type TaskSchedule,
} from "../shared/coach-tasks.ts";
import { newInputId } from "../shared/ids.ts";
import type { Client } from "./client.ts";

export const COACH_HELP = `Coach
  rowrow coach tasks               Coach's scheduled tasks: schedule, next run, last run
  rowrow coach task new <prompt…> --title T (--at TIME | --daily HH:mm [--tz ZONE] | --every MIN)
                                   [--notify coach]   each run is a new Coach chat sent the prompt;
                                   --notify coach: Coach notifies only when it matters
  rowrow coach task runs <task>    its runs, newest first, each with its chat (rowrow agent view)
  rowrow coach task run|stop|pause|resume|delete <task>
  (a <task> is its id, an id prefix, or a unique part of its title)`;

interface Flags {
  readonly str: (name: string) => string | undefined;
  readonly out: (value: unknown, human: () => string) => void;
}

const when = (ms: number): string =>
  new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export function formatTask(task: CoachTask): string {
  const run = task.currentRun ?? task.lastRun;
  const next =
    task.status === "paused"
      ? "paused"
      : task.queuedAt !== null && task.currentRun === null
        ? "queued"
        : task.nextRunAt === null
          ? "no upcoming run"
          : `next ${when(task.nextRunAt)}`;
  const last =
    run === null
      ? "no runs yet"
      : `${task.currentRun === null ? "last" : "now"}: ${run.status}${run.error === null ? "" : ` (${run.error})`}`;
  return `${task.id}  ${task.title} · ${scheduleLabel(task.schedule, when)} · ${next} · ${last}`;
}

function formatRun(run: CoachTaskRun): string {
  return `${run.id}  ${when(run.scheduledAt)}${run.manual ? " (run now)" : ""} · ${run.status}${run.error === null ? "" : ` (${run.error})`}${run.chatId === null ? "" : ` · chat ${run.chatId}`}`;
}

function resolveTask(tasks: readonly CoachTask[], ref: string): CoachTask {
  if (ref === "") throw new Error("which task? (an id, id prefix, or part of its title)");
  const byId = tasks.filter((t) => t.id === ref || t.id.startsWith(ref) || t.id.startsWith(`tk_${ref}`));
  if (byId.length === 1 && byId[0] !== undefined) return byId[0];
  const byTitle = tasks.filter((t) => t.title.toLowerCase().includes(ref.toLowerCase()));
  if (byTitle.length === 1 && byTitle[0] !== undefined) return byTitle[0];
  const candidates = [...byId, ...byTitle];
  throw new Error(
    candidates.length === 0
      ? `no Coach task matches "${ref}"`
      : `"${ref}" matches ${candidates.length} tasks: ${candidates.map((t) => t.id).join(", ")}`,
  );
}

function scheduleOf(str: Flags["str"]): TaskSchedule {
  const at = str("at");
  const daily = str("daily");
  const every = str("every");
  if ([at, daily, every].filter((value) => value !== undefined).length !== 1)
    throw new Error("give one schedule: --at TIME, --daily HH:mm [--tz ZONE] or --every MINUTES");
  if (at !== undefined) {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) throw new Error(`--at: "${at}" isn't a date and time`);
    return { type: "once", at: date.toISOString() };
  }
  if (daily !== undefined)
    return {
      type: "daily",
      time: daily,
      timeZone: str("tz") ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  return { type: "interval", minutes: Number(every) };
}

export async function coachCommand(client: Client, rest: readonly string[], flags: Flags): Promise<void> {
  const { str, out } = flags;
  const [sub, action, ...args] = rest;
  if (sub === "tasks") {
    const tasks = await client.coach.tasks();
    out(tasks, () =>
      tasks.length === 0
        ? "No Coach tasks yet. Create one: rowrow coach task new <prompt…> --title T --every 60"
        : tasks.map(formatTask).join("\n"),
    );
    return;
  }
  if (sub !== "task") throw new Error(COACH_HELP);
  if (action === "new") {
    const prompt = args.join(" ").trim();
    const title = str("title");
    if (prompt === "" || title === undefined) throw new Error(COACH_HELP);
    const notify = str("notify");
    if (notify !== undefined && notify !== "every" && notify !== "coach")
      throw new Error("--notify: every or coach");
    const task = await client.coach.createTask({
      requestId: newInputId(),
      title,
      prompt,
      schedule: scheduleOf(str),
      notify: notify ?? "every",
    });
    out(task, () => `Created ${formatTask(task)}`);
    return;
  }
  const task = resolveTask(await client.coach.tasks(), args[0] ?? "");
  const taskId = task.id;
  switch (action ?? "") {
    case "runs": {
      const runs = await client.coach.taskRuns({ taskId });
      out(runs, () => (runs.length === 0 ? "No runs yet." : runs.map(formatRun).join("\n")));
      return;
    }
    case "run": {
      const after = await client.coach.runTask({ taskId });
      out(after, () => `Running ${formatTask(after)}`);
      return;
    }
    case "stop": {
      const after = await client.coach.stopTask({ taskId });
      out(after, () => `Stopped its run: ${formatTask(after)}`);
      return;
    }
    case "pause":
    case "resume": {
      const after = await client.coach.pauseTask({ taskId, paused: action === "pause" });
      out(after, () => formatTask(after));
      return;
    }
    case "delete": {
      await client.coach.deleteTask({ taskId });
      out({ ok: true }, () => `Deleted ${task.title} (${taskId}) and its runs`);
      return;
    }
    default:
      throw new Error(COACH_HELP);
  }
}
