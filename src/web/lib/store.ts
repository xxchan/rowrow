// Client state: a mirror of the server's AppState (state.watch: snapshot, then patches)
// and the transcripts of agents on screen (agents.entries + agents.watch, folded with the
// same pure fold the server and CLI use). The client owns no truth; it re-syncs from the
// server after every reconnect (docs/architecture.md, "Replicating state to clients").
import { applyPatches, enablePatches } from "immer";
import { useEffect } from "react";
import { create } from "zustand";
import type { Entry } from "../../shared/entries.ts";
import type { AgentState, AppState, StateMessage } from "../../shared/schemas.ts";
import type { Attention } from "../../shared/summary.ts";
import { initialTimeline, reduceTimeline, timelineOf, type Timeline } from "../../shared/timeline.ts";
import { connection, type Client, type ConnectionStatus } from "./connection.ts";
import { report } from "./telemetry.ts";

enablePatches();

// ─── Connection ────────────────────────────────────────────────────────────

export const useConnection = create<{ status: ConnectionStatus }>(() => ({ status: connection.current }));
connection.subscribe((status) => useConnection.setState({ status }));

export function useClient(): Client | null {
  const status = useConnection((s) => s.status);
  return status.kind === "open" ? status.client : null;
}

// ─── App state ─────────────────────────────────────────────────────────────

interface AppStore {
  readonly version: number;
  readonly state: AppState | null;
}

export const useApp = create<AppStore>(() => ({ version: 0, state: null }));

export interface AttentionEvent {
  readonly agent: AgentState;
  readonly from: Attention;
  readonly to: Attention;
}
const attentionListeners = new Set<(event: AttentionEvent) => void>();
export function onAttention(listener: (event: AttentionEvent) => void): () => void {
  attentionListeners.add(listener);
  return () => attentionListeners.delete(listener);
}

function apply(message: StateMessage): void {
  const before = useApp.getState().state;
  const next =
    message.kind === "snapshot"
      ? message.state
      : before === null
        ? null
        : applyPatches(before, [...message.patches]);
  useApp.setState({ version: message.version, state: next });
  if (before === null || next === null || message.kind === "snapshot") return;
  for (const agent of Object.values(next.agents)) {
    const previous = before.agents[agent.id];
    if (previous !== undefined && previous.attention !== agent.attention) {
      for (const listener of attentionListeners)
        listener({ agent, from: previous.attention, to: agent.attention });
    }
  }
}

connection.subscribe((status) => {
  if (status.kind !== "open") return;
  void (async () => {
    try {
      for await (const message of await status.client.state.watch()) {
        if (connection.current !== status) return;
        apply(message);
      }
    } catch (error) {
      if (connection.current === status) report("error", "state.watch_failed", error);
    }
  })();
});

// ─── Transcripts ───────────────────────────────────────────────────────────

export interface TranscriptState {
  readonly entries: readonly Entry[];
  readonly timeline: Timeline;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly error: string | null;
}

const EMPTY: TranscriptState = {
  entries: [],
  timeline: initialTimeline(),
  loading: true,
  hasMore: false,
  loadingOlder: false,
  error: null,
};
const WINDOW_TURNS = 4;

export const useTranscripts = create<{ byAgent: Readonly<Record<string, TranscriptState>> }>(() => ({
  byAgent: {},
}));

function update(agentId: string, change: (current: TranscriptState) => TranscriptState): void {
  useTranscripts.setState((s) => ({
    byAgent: { ...s.byAgent, [agentId]: change(s.byAgent[agentId] ?? EMPTY) },
  }));
}

/** An agent's transcript, kept live while a component using it is mounted. */
export function useTranscript(agentId: string): TranscriptState {
  const client = useClient();
  useEffect(() => {
    if (client === null) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        let current = useTranscripts.getState().byAgent[agentId];
        if (current === undefined || current.entries.length === 0) {
          const page = await client.agents.entries(
            { agentId, turns: WINDOW_TURNS },
            { signal: controller.signal },
          );
          current = {
            ...EMPTY,
            entries: page.entries,
            timeline: timelineOf(page.entries),
            loading: false,
            hasMore: page.hasMore,
          };
          update(agentId, () => current ?? EMPTY);
        } else {
          update(agentId, (s) => ({ ...s, loading: false, error: null }));
        }
        const after = current.timeline.headSeq;
        const stream = await client.agents.watch({ agentId, after }, { signal: controller.signal });
        for await (const batch of stream) {
          update(agentId, (s) => ({
            ...s,
            entries: [...s.entries, ...batch.entries],
            timeline: batch.entries.reduce(reduceTimeline, s.timeline),
          }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        report("warn", "transcript.stream_failed", error, { agentId });
        update(agentId, (s) => ({
          ...s,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    return () => controller.abort();
  }, [agentId, client]);
  return useTranscripts((s) => s.byAgent[agentId] ?? EMPTY);
}

/** Load the turns before the ones on screen. */
export async function loadOlder(client: Client, agentId: string): Promise<void> {
  const current = useTranscripts.getState().byAgent[agentId];
  if (current === undefined || !current.hasMore || current.loadingOlder) return;
  update(agentId, (s) => ({ ...s, loadingOlder: true }));
  try {
    const page = await client.agents.entries({
      agentId,
      before: current.timeline.firstSeq,
      turns: WINDOW_TURNS,
    });
    update(agentId, (s) => {
      const entries = [...page.entries, ...s.entries];
      return { ...s, entries, timeline: timelineOf(entries), hasMore: page.hasMore, loadingOlder: false };
    });
  } catch (error) {
    report("warn", "transcript.older_failed", error, { agentId });
    update(agentId, (s) => ({ ...s, loadingOlder: false }));
  }
}

// ─── Drafts ────────────────────────────────────────────────────────────────

/** What you are typing to each agent. In memory only: a draft may hold a secret (roamgate #70). */
export const useDrafts = create<{ byAgent: Readonly<Record<string, string>> }>(() => ({ byAgent: {} }));
export function setDraft(agentId: string, text: string): void {
  useDrafts.setState((s) => ({ byAgent: { ...s.byAgent, [agentId]: text } }));
}
