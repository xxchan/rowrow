// Coach's window (D-044), as roamgate's Ranger has it: closed, floating at the right of the
// page, pinned beside it (and resizable), or maximized over it; full screen on a phone. It
// mounts the first time it opens and then only hides, so a draft, the width and what it shows
// survive closing it. Floating or pinned is remembered in this browser (and follows other tabs);
// the width and maximizing last until the page reloads. Pinned in a narrow page (900 px or
// less), it sits under the page instead of beside it. It shows its chat, its scheduled tasks
// (D-050) or its settings; a notification about a task opens it on that task and run.
import { toast } from "sonner";
import { create } from "zustand";
import { canCoach, CANT_COACH } from "../../shared/coach.ts";
import type { AppState } from "../../shared/schemas.ts";
import { workspaceArchived } from "../../shared/workspaces.ts";

export type CoachLayout = "floating" | "pinned";
export type CoachView = "chat" | "tasks" | "settings";

export const COACH_WIDTH = 380;
export const COACH_MIN_WIDTH = 300;
/** What a pinned Coach always leaves the page beside it. */
export const PAGE_MIN_WIDTH = 240;
/** At this page width or less, a pinned Coach sits under the page. */
export const STACK_WIDTH = 900;
const LAYOUT_KEY = "rowrow.coachLayout";

interface CoachWindow {
  /** Opened once: mounted from then on, hidden while closed. */
  readonly mounted: boolean;
  readonly open: boolean;
  readonly maximized: boolean;
  readonly layout: CoachLayout;
  readonly width: number;
  readonly view: CoachView;
  /** Chat or Tasks: where Settings goes back to. */
  readonly main: "chat" | "tasks";
  /** The task the Tasks view shows (null: the list), and which of its runs. */
  readonly task: { readonly id: string; readonly runId: string | null } | null;
  readonly history: boolean;
  /** Pinned under the page, not beside it (the page is narrow). */
  readonly stacked: boolean;
  /** What went wrong last (a message that didn't send), until dismissed. */
  readonly error: string | null;
  /** Bumped when you send: the conversation follows its end again. */
  readonly follow: number;
}

function savedLayout(): CoachLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "pinned" ? "pinned" : "floating";
  } catch {
    return "floating";
  }
}

export const useCoach = create<CoachWindow>(() => ({
  mounted: false,
  open: false,
  maximized: false,
  layout: savedLayout(),
  width: COACH_WIDTH,
  view: "chat",
  main: "chat",
  task: null,
  history: false,
  stacked: false,
  error: null,
  follow: 0,
}));

export function openCoach(): void {
  useCoach.setState({ mounted: true, open: true });
}

export function closeCoach(): void {
  useCoach.setState({ open: false, maximized: false });
  // Back to the button that opens it, so the keyboard carries on from there.
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-coach-button]")?.focus());
}

export function toggleCoach(): void {
  if (useCoach.getState().open) closeCoach();
  else openCoach();
}

/** Show the chat, the tasks or the settings; Settings goes back to whichever of the others was last. */
export function showCoachView(view: CoachView): void {
  useCoach.setState(view === "settings" ? { view } : { view, main: view });
}

/** Open Coach on a task, with one of its runs (a notification about it, a link). */
export function openCoachTask(taskId: string, runId: string | null): void {
  useCoach.setState({ mounted: true, open: true, view: "tasks", main: "tasks", task: { id: taskId, runId } });
}

export function setCoachLayout(layout: CoachLayout): void {
  useCoach.setState({ layout, maximized: false });
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    toast.error("Coach's layout could not be saved");
  }
}

// Another tab pinned or floated it.
window.addEventListener("storage", (event) => {
  if (event.key === LAYOUT_KEY) useCoach.setState({ layout: savedLayout() });
});

/** A link to a task's run (a notification's: /?coachTask=…&coachRun=…) opens Coach there, once. */
function takeTaskLink(): void {
  const params = new URLSearchParams(location.search);
  const taskId = params.get("coachTask");
  if (taskId === null) return;
  openCoachTask(taskId, params.get("coachRun"));
  params.delete("coachTask");
  params.delete("coachRun");
  const rest = params.toString();
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${rest === "" ? "" : `?${rest}`}${location.hash}`,
  );
}
takeTaskLink();
window.addEventListener("popstate", takeTaskLink);

/** Why Coach can't run on what its settings say, or null. */
export function runtimeProblem(state: AppState): string | null {
  const id = state.settings.coach.runtime;
  const info = state.runtimes[id];
  if (!canCoach(id)) return CANT_COACH;
  if (info === undefined || !info.installed) return `${info?.name ?? id} isn't installed here.`;
  return null;
}

/** The allowed workspaces that are still there (with Full access, all): what the next message may read. */
export function allowedWorkspaces(state: AppState): string[] {
  const { fullAccess, workspaces } = state.settings.coach;
  return (fullAccess ? Object.keys(state.workspaces) : workspaces).filter((id) => {
    const ws = state.workspaces[id];
    return ws !== undefined && !workspaceArchived(state.workspaces, id) && !ws.missing;
  });
}
