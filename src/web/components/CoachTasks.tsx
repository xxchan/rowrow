// Coach's Tasks (D-050), as roamgate's Ranger has them (notes: ranger-spec.md 4.3 to 4.5): the
// list (each task's schedule, its current or last run, its next one), a task (Run now, Pause,
// Stop run, Edit, Delete, and its run history: each run's chat, read here or opened in Chat,
// with its proposals to confirm), and the form that writes one: a name, the exact prompt each
// run sends, how it notifies, and a schedule (once, daily at a time in a time zone, or every N
// minutes). Tasks live in AppState (coach.tasks), so every window follows them as they run.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ChevronLeft, ListChecks, LoaderCircle, MessageSquare, Plus, Settings } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  NOTIFY_LABELS,
  scheduleLabel,
  validateSchedule,
  type CoachTask,
  type CoachTaskRun,
  type TaskNotify,
  type TaskSchedule,
} from "../../shared/coach-tasks.ts";
import { newInputId } from "../../shared/ids.ts";
import type { AppState } from "../../shared/schemas.ts";
import { allowedWorkspaces, runtimeProblem, showCoachView, useCoach } from "../lib/coach.ts";
import { useApp, useClient, useConnection, useTranscript } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { at, CoachCardChat } from "./CoachActionCard.tsx";
import { Transcript } from "./Transcript.tsx";

const hint = "text-[11px] leading-normal text-muted-foreground [overflow-wrap:anywhere]";
const small = "min-h-11 text-[11px] md:min-h-7";

/** Report what went wrong where Coach shows errors. */
function failed(error: unknown): void {
  useCoach.setState({ error: error instanceof Error ? error.message : String(error) });
}

function select(id: string | null, runId: string | null = null): void {
  useCoach.setState({ task: id === null ? null : { id, runId } });
}

/** Once AppState has the task a call just saved (its answer can come before the state's patch). */
function shown(taskId: string): Promise<void> {
  const has = (): boolean => useApp.getState().state?.coach.tasks.some((t) => t.id === taskId) === true;
  if (has()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, 5000);
    const stop = useApp.subscribe(() => {
      if (has()) done();
    });
  });
}

export function CoachTasksView({
  state,
  wide,
  onLayer,
}: {
  state: AppState;
  wide: boolean;
  onLayer: (open: boolean) => void;
}) {
  const selected = useCoach((s) => s.task);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const tasks = state.coach.tasks;
  const task = selected === null ? null : (tasks.find((t) => t.id === selected.id) ?? null);
  // A link to a task that's gone (deleted, or on another server): say so, and show the list.
  const gone = selected !== null && task === null;
  useEffect(() => {
    if (!gone) return;
    select(null);
    useCoach.setState({ error: "This Coach task is no longer available." });
  }, [gone]);
  return (
    <section aria-label="Coach tasks" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
      <div className={cn("grid min-w-0 content-start gap-2.5", wide && "mx-auto w-full max-w-[800px]")}>
        {editor !== null ? (
          <TaskForm
            key={editor === "edit" ? (task?.id ?? "new") : "new"}
            state={state}
            onLayer={onLayer}
            task={editor === "edit" ? task : null}
            onDone={(id) => {
              setEditor(null);
              if (id !== null) select(id);
            }}
          />
        ) : task === null ? (
          <TaskList tasks={tasks} onNew={() => setEditor("new")} />
        ) : (
          <TaskDetail
            state={state}
            task={task}
            runId={selected?.runId ?? null}
            onEdit={() => setEditor("edit")}
            onLayer={onLayer}
          />
        )}
      </div>
    </section>
  );
}

// ─── The list ─────────────────────────────────────────────────────────────────

function TaskList({ tasks, onNew }: { tasks: readonly CoachTask[]; onNew: () => void }) {
  const connected = useConnection((s) => s.status.kind === "open");
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Tasks</h3>
        <Button variant="ghost" size="xs" className={small} disabled={!connected} onClick={onNew}>
          <Plus /> New task
        </Button>
      </div>
      <p className={hint}>Runs continue in the background. Open a task to see its history and results.</p>
      {tasks.length === 0 ? (
        <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 p-[22px] text-center text-muted-foreground">
          <ListChecks className="size-6" aria-hidden />
          <strong className="text-[13px] font-semibold text-foreground">No tasks yet</strong>
          <span className="text-[11px] leading-normal">
            Create a task for a one-time or recurring check of your agents.
          </span>
        </div>
      ) : (
        <ul className="grid gap-1.5">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => select(task.id)}
                className="grid w-full min-w-0 gap-[5px] rounded-md border p-[9px] text-left hover:bg-accent"
              >
                <div className="flex items-start justify-between gap-2">
                  <strong className="min-w-0 text-xs font-semibold [overflow-wrap:anywhere]">
                    {task.title}
                  </strong>
                  <StateChip task={task} />
                </div>
                <span className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                  {scheduleLabel(task.schedule, at)}
                </span>
                <small className="text-[10px] text-muted-foreground">{runLine(task)}</small>
                <small className="text-[10px] text-muted-foreground">{nextLine(task)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function StateChip({ task }: { task: CoachTask }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px]",
        task.status === "active" ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {task.status}
    </span>
  );
}

/** "Current: running", "Last: succeeded", "No runs yet", as Ranger's rows say it. */
function runLine(task: CoachTask): string {
  if (task.currentRun !== null) return `Current: ${task.currentRun.status}`;
  if (task.lastRun !== null) return `Last: ${task.lastRun.status}`;
  return "No runs yet";
}

function nextLine(task: CoachTask): string {
  if (task.queuedAt !== null && task.currentRun === null) return "Queued: runs once the run going now ends";
  if (task.status === "paused") return "Paused: no upcoming run";
  return task.nextRunAt === null ? "No upcoming run" : `Next: ${at(task.nextRunAt)}`;
}

// ─── A task ───────────────────────────────────────────────────────────────────

function TaskDetail({
  state,
  task,
  runId,
  onEdit,
  onLayer,
}: {
  state: AppState;
  task: CoachTask;
  runId: string | null;
  onEdit: () => void;
  onLayer: (open: boolean) => void;
}) {
  const client = useClient();
  const connected = useConnection((s) => s.status.kind === "open");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const open = task.currentRun !== null;
  const disabled = busy || !connected || client === null;
  const act = async (what: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    useCoach.setState({ error: null });
    try {
      await what();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const permission = !task.fullAccess
    ? "Manual permission: operations need confirmation"
    : state.settings.coach.fullAccess
      ? "Full access: supported operations execute automatically"
      : "Full access saved; Coach's Full access is off, so operations need confirmation";
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="xs" className={small} onClick={() => select(null)}>
          <ChevronLeft /> All tasks
        </Button>
        <Button variant="ghost" size="xs" className={small} disabled={disabled} onClick={onEdit}>
          Edit
        </Button>
      </div>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-[13px] font-semibold [overflow-wrap:anywhere]">{task.title}</h3>
        <StateChip task={task} />
      </div>
      <p className={hint}>{`${scheduleLabel(task.schedule, at)} / ${nextLine(task)}`}</p>
      <PromptText text={task.prompt} />
      <span className={hint}>{permission}</span>
      <span className={hint}>{NOTIFY_LABELS[task.notify]}</span>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="xs"
          className={small}
          disabled={disabled || open || task.queuedAt !== null}
          onClick={() => void act(async () => client?.coach.runTask({ taskId: task.id }))}
        >
          Run now
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className={small}
          disabled={disabled}
          onClick={() =>
            void act(async () =>
              client?.coach.pauseTask({ taskId: task.id, paused: task.status === "active" }),
            )
          }
        >
          {task.status === "paused" ? "Resume" : "Pause"}
        </Button>
        {open && (
          <Button
            variant="ghost"
            size="xs"
            className={small}
            disabled={disabled}
            onClick={() => void act(async () => client?.coach.stopTask({ taskId: task.id }))}
          >
            Stop run
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          className={cn(small, "text-destructive hover:text-destructive")}
          disabled={disabled}
          onClick={() => {
            setDeleting(true);
            onLayer(true);
          }}
        >
          Delete task
        </Button>
      </div>
      <RunHistory task={task} runId={runId} onLayer={onLayer} />
      <AlertDialog
        open={deleting}
        onOpenChange={(isOpen) => {
          setDeleting(isOpen);
          if (!isOpen) onLayer(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete this task and all of its run history. A run going now is stopped; a run you
              carried on in Coach's chat stays there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() =>
                void act(async () => {
                  await client?.coach.deleteTask({ taskId: task.id });
                  select(null);
                })
              }
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A task's exact prompt, folded until you open it. */
function PromptText({ text }: { text: string }) {
  return (
    <Collapsible className="group/prompt min-w-0 text-[11px]">
      <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
        <span aria-hidden className="text-[8px]">
          <span className="group-data-[state=open]/prompt:hidden">▶</span>
          <span className="hidden group-data-[state=open]/prompt:inline">▼</span>
        </span>
        Task prompt
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1.5 max-h-60 overflow-auto rounded-md bg-code p-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A task's runs, the one you pick read here: its status, its error, and its chat. */
function RunHistory({
  task,
  runId,
  onLayer,
}: {
  task: CoachTask;
  runId: string | null;
  onLayer: (open: boolean) => void;
}) {
  const client = useClient();
  const [loaded, setLoaded] = useState<{ signature: string; runs: CoachTaskRun[] } | null>(null);
  // Read again whenever a run starts, moves on or ends.
  const signature = JSON.stringify([
    task.currentRun?.id,
    task.currentRun?.status,
    task.currentRun?.chatId,
    task.lastRun?.id,
    task.lastRun?.status,
  ]);
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const runs = await client.coach.taskRuns({ taskId: task.id });
        if (!cancelled) setLoaded({ signature, runs });
      } catch (error) {
        report("warn", "coach.task_runs_failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, task.id, signature]);
  const runs = loaded?.runs;
  if (runs === undefined)
    return (
      <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" /> Loading run history
      </p>
    );
  const chosen =
    runs.find((run) => run.id === runId) ??
    runs.find((run) => run.id === (task.currentRun?.id ?? task.lastRun?.id)) ??
    runs[0];
  return (
    <>
      <div className="grid gap-1">
        <span className="text-[11px] font-medium">Run history</span>
        {chosen === undefined ? (
          <span className={hint}>No runs yet.</span>
        ) : (
          <Select value={chosen.id} onValueChange={(id) => select(task.id, id)} onOpenChange={onLayer}>
            <SelectTrigger aria-label="Task run" className="h-11 w-full text-base md:h-8 md:text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {runs.map((run) => (
                <SelectItem key={run.id} value={run.id}>
                  {`${at(run.scheduledAt)} / ${run.status}${run.manual ? " (Run now)" : ""}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {chosen !== undefined && <RunOutput run={chosen} />}
    </>
  );
}

function RunOutput({ run }: { run: CoachTaskRun }) {
  const client = useClient();
  const live = run.status === "running" || run.status === "waiting";
  const openChat = async (): Promise<void> => {
    if (client === null || run.chatId === null) return;
    useCoach.setState({ error: null });
    try {
      await client.coach.open({ chatId: run.chatId });
      showCoachView("chat");
      useCoach.setState({ follow: useCoach.getState().follow + 1 });
    } catch (error) {
      failed(error);
    }
  };
  return (
    <div aria-label="Task run output" aria-busy={live} className="grid min-w-0 gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span role="status" className="text-[10px] text-muted-foreground">
          {`Run ${run.status} / Started ${at(run.startedAt)}`}
        </span>
        {run.chatId !== null && (
          <Button variant="ghost" size="xs" className={small} onClick={() => void openChat()}>
            <MessageSquare /> Open in chat
          </Button>
        )}
      </div>
      {run.error !== null && (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 p-2 text-[11px] text-destructive [overflow-wrap:anywhere]"
        >
          {run.error}
        </p>
      )}
      {run.chatId !== null && <RunTranscript chatId={run.chatId} working={run.status === "running"} />}
    </div>
  );
}

/** A run's chat, read here like Coach's chat: its proposals are confirmed here too. */
function RunTranscript({ chatId, working }: { chatId: string; working: boolean }) {
  const transcript = useTranscript(chatId);
  const { timeline, entries } = transcript;
  const executing = [...timeline.coachActions.values()].some((action) => action.status === "executing");
  const created = entries.find((entry) => entry.kind === "agent.created");
  const runtime = created?.kind === "agent.created" ? created.runtime : "";
  if (timeline.blocks.length === 0)
    return transcript.loading ? (
      <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" /> Loading the run's chat
      </p>
    ) : null;
  return (
    <CoachCardChat.Provider value={{ chatId, working, executing }}>
      <div className="grid min-w-0 gap-[18px] border-t pt-3">
        <Transcript timeline={timeline} runtime={runtime} coach />
      </div>
    </CoachCardChat.Provider>
  );
}

// ─── The form ─────────────────────────────────────────────────────────────────

/** A datetime-local input's value for an instant, in this browser's time zone. */
function localDateTime(ms: number): string {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function TaskForm({
  state,
  task,
  onDone,
  onLayer,
}: {
  state: AppState;
  task: CoachTask | null;
  onLayer: (open: boolean) => void;
  /** Saved (the task's id) or cancelled (null). */
  onDone: (id: string | null) => void;
}) {
  const client = useClient();
  const connected = useConnection((s) => s.status.kind === "open");
  const schedule = task?.schedule;
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [notify, setNotify] = useState<TaskNotify>(task?.notify ?? "every");
  const [kind, setKind] = useState<TaskSchedule["type"]>(schedule?.type ?? "once");
  const [runAt, setRunAt] = useState(() =>
    localDateTime(schedule?.type === "once" ? Date.parse(schedule.at) : Date.now() + 60_000),
  );
  const [time, setTime] = useState(schedule?.type === "daily" ? schedule.time : "09:00");
  const [timeZone, setTimeZone] = useState(() =>
    schedule?.type === "daily"
      ? schedule.timeZone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [minutes, setMinutes] = useState(schedule?.type === "interval" ? String(schedule.minutes) : "60");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One new task per form, however often Save is pressed.
  const requestId = useRef(newInputId());
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus({ preventScroll: true }), []);
  const ready = runtimeProblem(state) === null && allowedWorkspaces(state).length > 0;
  const fullAccess = state.settings.coach.fullAccess;

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (client === null || saving || !ready) return;
    let checked: TaskSchedule;
    try {
      const date = new Date(runAt);
      checked = validateSchedule(
        kind === "once"
          ? { type: "once", at: Number.isFinite(date.getTime()) ? date.toISOString() : "" }
          : kind === "daily"
            ? { type: "daily", time, timeZone: timeZone.trim() }
            : { type: "interval", minutes: Number(minutes) },
      );
    } catch (failure) {
      setError(failure instanceof Error ? `${failure.message}.` : String(failure));
      return;
    }
    if (title.trim() === "" || prompt.trim() === "") {
      setError("Enter a name, prompt and valid schedule.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const input = { title: title.trim(), prompt: prompt.trim(), schedule: checked, notify };
      const saved =
        task === null
          ? await client.coach.createTask({ ...input, requestId: requestId.current })
          : await client.coach.updateTask({ ...input, taskId: task.id });
      await shown(saved.id);
      onDone(saved.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const field = "grid min-w-0 gap-1 text-[11px] font-medium";
  const control = "h-11 text-base md:h-8 md:text-xs";
  return (
    <form
      aria-label={task === null ? "Create task" : "Edit task"}
      className="grid min-w-0 gap-3"
      onSubmit={(event) => void save(event)}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{task === null ? "New task" : "Edit task"}</h3>
        <Button type="button" variant="ghost" size="xs" className={small} onClick={() => onDone(null)}>
          <ChevronLeft /> Back
        </Button>
      </div>
      <p className={hint}>
        {`Tasks run on this server in their own Coach chats, reading the workspaces Coach may read when they run. Saving uses the current permission mode: ${
          fullAccess
            ? "Full access. Supported workspace operations execute automatically while Full access stays on."
            : "manual. Workspace operations need your confirmation."
        }`}
      </p>
      {!ready && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-[11px] text-muted-foreground">
          <span className="min-w-0">
            Choose Coach's runtime and the workspaces it may read before saving a task.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn(small, "shrink-0")}
            onClick={() => showCoachView("settings")}
          >
            <Settings /> Coach settings
          </Button>
        </div>
      )}
      <fieldset disabled={saving} className="grid min-w-0 gap-3">
        <label className={field}>
          Name
          <Input
            ref={nameRef}
            aria-label="Task name"
            required
            maxLength={100}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className={control}
          />
        </label>
        <label className={field}>
          Prompt
          <Textarea
            aria-label="Task prompt"
            required
            rows={5}
            maxLength={20_000}
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            className="min-h-[90px] resize-y text-base md:text-xs"
          />
        </label>
        <div className={field}>
          Notifications
          <Choice
            label="Task notifications"
            onLayer={onLayer}
            value={notify}
            onChange={(value) => setNotify(value === "coach" ? "coach" : "every")}
            options={[
              ["every", "Notify when each run finishes"],
              ["coach", "Let Coach decide"],
            ]}
          />
          <small className="font-normal text-muted-foreground">
            Coach can send its own notice when needed. Let Coach decide keeps routine checks quiet; failed
            runs and action confirmations still notify.
          </small>
        </div>
        <div className={field}>
          Schedule
          <Choice
            label="Task schedule"
            onLayer={onLayer}
            value={kind}
            onChange={(value) =>
              setKind(value === "daily" ? "daily" : value === "interval" ? "interval" : "once")
            }
            options={[
              ["once", "Once"],
              ["daily", "Daily"],
              ["interval", "Interval"],
            ]}
          />
        </div>
        {kind === "once" ? (
          <label className={field}>
            Run at (your local time)
            <Input
              type="datetime-local"
              aria-label="Run at"
              required
              value={runAt}
              onChange={(event) => setRunAt(event.currentTarget.value)}
              className={control}
            />
          </label>
        ) : kind === "daily" ? (
          <>
            <label className={field}>
              Time
              <Input
                type="time"
                aria-label="Daily time"
                required
                value={time}
                onChange={(event) => setTime(event.currentTarget.value)}
                className={control}
              />
            </label>
            <label className={field}>
              Timezone
              <Input
                aria-label="Task timezone"
                required
                placeholder="Europe/London"
                value={timeZone}
                onChange={(event) => setTimeZone(event.currentTarget.value)}
                className={control}
              />
            </label>
          </>
        ) : (
          <label className={field}>
            Minutes between runs
            <Input
              type="number"
              aria-label="Interval minutes"
              required
              min={1}
              max={525_600}
              step={1}
              value={minutes}
              onChange={(event) => setMinutes(event.currentTarget.value)}
              className={control}
            />
          </label>
        )}
      </fieldset>
      {error !== null && (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 p-2 text-[11px] text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {task?.status === "paused" && <p className={hint}>This task will stay paused after saving.</p>}
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" className={small} onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          className={small}
          disabled={saving || !ready || !connected || title.trim() === "" || prompt.trim() === ""}
        >
          {saving && <LoaderCircle className="animate-spin" />}
          {task === null ? "Save and enable" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function Choice({
  label,
  value,
  onChange,
  onLayer,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onLayer: (open: boolean) => void;
  options: readonly (readonly [string, ReactNode])[];
}) {
  return (
    <Select value={value} onValueChange={onChange} onOpenChange={onLayer}>
      <SelectTrigger aria-label={label} className="h-11 w-full text-base font-normal md:h-8 md:text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([option, name]) => (
          <SelectItem key={option} value={option}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
