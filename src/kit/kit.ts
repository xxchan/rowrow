// The kit: src/shared's folds for clients that aren't JavaScript apps (docs/decisions.md,
// D-027). `pnpm build` bundles this file into dist/kit/kit.js, the server serves it at
// /kit.js, and the iOS app runs it in JavaScriptCore: the app never interprets the agent log
// itself, so it reads every server's log the way that server's own web app does.
//
// Plain JavaScript values cross the boundary as JSON text (one parse on each side), and
// nothing here uses more than the language itself: JavaScriptCore has no DOM, no timers and
// no console of its own.
import type { Entry } from "../shared/entries.ts";
import { statusDot, type StateWords } from "../shared/describe.ts";
import { compileFeedback, type Annotation } from "../shared/feedback.ts";
import { remember, resolveSetup, type AgentSetup, type NewAgentContext } from "../shared/new-agent-setup.ts";
import { parsePrefs } from "../shared/new-agent-setup.ts";
import { renderText } from "../shared/render-text.ts";
import type { AgentState, AppState, EntryPage } from "../shared/schemas.ts";
import { initialTimeline, reduceTimeline, timelineOf, type Timeline } from "../shared/timeline.ts";
import { TRANSCRIPT_MODEL_VERSION, TranscriptProjector } from "../shared/transcript-model.ts";

interface Transcript {
  entries: Entry[];
  timeline: Timeline;
  readonly projector: TranscriptProjector;
  hasMore: boolean;
}

const transcripts = new Map<number, Transcript>();
let nextHandle = 1;

function transcript(handle: number): Transcript {
  const found = transcripts.get(handle);
  if (found === undefined) throw new Error(`no transcript ${handle} (closed?)`);
  return found;
}

/**
 * What the app gets after every change: the cursor to resume from, whether older turns exist,
 * the order of item ids when it changed (null: unchanged), and the items that changed. `reset`
 * says to drop every item it has first.
 */
function delta(t: Transcript, reset: boolean): string {
  if (reset) t.projector.reset();
  const { order, items } = t.projector.update(t.timeline);
  return `{"reset":${reset},"head":${t.timeline.headSeq},"first":${t.timeline.firstSeq},"hasMore":${t.hasMore},"order":${order === null ? "null" : JSON.stringify(order)},"items":[${items.join(",")}]}`;
}

const kit = {
  /** The shape of what the kit returns (transcript items), so an app can tell it can read it. */
  version: TRANSCRIPT_MODEL_VERSION,

  /** A transcript for one agent; `runtime` (claude, codex…) says how to read its tool calls. */
  open(runtime: string): number {
    const handle = nextHandle++;
    transcripts.set(handle, {
      entries: [],
      timeline: initialTimeline(),
      projector: new TranscriptProjector(runtime),
      hasMore: false,
    });
    return handle;
  },

  /** Start from an `agents.entries` page (its JSON), replacing whatever the transcript had. */
  load(handle: number, pageJson: string): string {
    const t = transcript(handle);
    const page = JSON.parse(pageJson) as EntryPage;
    t.entries = [...page.entries];
    t.timeline = timelineOf(t.entries);
    t.hasMore = page.hasMore;
    return delta(t, true);
  },

  /** Entries from `agents.watch` (a batch's JSON, `{entries}`), after what the transcript has. */
  append(handle: number, batchJson: string): string {
    const t = transcript(handle);
    const { entries } = JSON.parse(batchJson) as { entries: Entry[] };
    const fresh = entries.filter((entry) => entry.seq > t.timeline.headSeq);
    t.entries.push(...fresh);
    t.timeline = fresh.reduce(reduceTimeline, t.timeline);
    return delta(t, false);
  },

  /** Older turns (an `agents.entries` page read with `before`), put in front of what it has. */
  prepend(handle: number, pageJson: string): string {
    const t = transcript(handle);
    const page = JSON.parse(pageJson) as EntryPage;
    const first = t.entries[0]?.seq ?? Number.POSITIVE_INFINITY;
    t.entries = [...page.entries.filter((entry) => entry.seq < first), ...t.entries];
    t.timeline = timelineOf(t.entries);
    t.hasMore = page.hasMore;
    return delta(t, true);
  },

  /** One item whole (tool input and output uncut), as JSON; "null" when there is no such item. */
  item(handle: number, id: string): string {
    return JSON.stringify(transcript(handle).projector.full(id));
  },

  /** The transcript as plain text, as `rowrow agent view` prints it. */
  text(handle: number): string {
    return renderText(transcript(handle).timeline);
  },

  close(handle: number): void {
    transcripts.delete(handle);
  },

  /** Each agent's state in words and a tone: `{agents: Record<id, AgentState>}` → `Record<id, StateWords>`. */
  describe(agentsJson: string, now: number): string {
    const agents = JSON.parse(agentsJson) as Record<string, AgentState>;
    const out: Record<string, StateWords> = {};
    for (const [id, agent] of Object.entries(agents)) out[id] = statusDot(agent, now);
    return JSON.stringify(out);
  },

  /** Where and how a new agent starts (D-023), from the app state, where it's started from and what this device remembers. */
  resolveSetup(stateJson: string, contextJson: string, prefsJson: string | null): string {
    const state = JSON.parse(stateJson) as AppState;
    const context = JSON.parse(contextJson) as NewAgentContext;
    return JSON.stringify(resolveSetup(state, context, parsePrefs(prefsJson, null)));
  },

  /** What to remember after starting an agent in a workspace; returns the new preferences. */
  remember(prefsJson: string | null, workspaceId: string, setupJson: string): string {
    return JSON.stringify(
      remember(parsePrefs(prefsJson, null), workspaceId, JSON.parse(setupJson) as AgentSetup),
    );
  },

  /** The review message comments compile into (it fills the composer; you send it). */
  feedback(annotationsJson: string): string {
    return compileFeedback(JSON.parse(annotationsJson) as Annotation[]);
  },
};

(globalThis as { rowrowKit?: typeof kit }).rowrowKit = kit;
