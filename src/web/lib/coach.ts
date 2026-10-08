// Coach's window (D-044), as roamgate's Ranger has it: closed, floating at the right of the
// page, pinned beside it (and resizable), or maximized over it; full screen on a phone. It
// mounts the first time it opens and then only hides, so a draft, the width and what it shows
// survive closing it. Floating or pinned is remembered in this browser (and follows other tabs);
// the width and maximizing last until the page reloads. Pinned in a narrow page (900 px or
// less), it sits under the page instead of beside it.
import { toast } from "sonner";
import { create } from "zustand";

export type CoachLayout = "floating" | "pinned";

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
  readonly view: "chat" | "settings";
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
