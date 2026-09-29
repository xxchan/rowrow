// The agent log (docs/architecture.md, "The agent log"). One append-only, totally ordered
// log per agent: rowrow's own facts plus oar's records verbatim. Everything the UI shows
// about an agent is a fold over these entries (src/shared/timeline.ts, summary.ts).
import type { RawEvent } from "@botiverse/oar";

/** Who caused an entry. Stamped by the server from the caller's credential, never taken from input. */
export type Actor =
  | { readonly kind: "device"; readonly deviceId: string; readonly name: string }
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "system" };

/**
 * How input should be delivered.
 * - `auto`: prompt when idle; when a turn is running, steer it (or queue, when the runtime can't steer).
 * - `queue`: prompt when idle; when busy, hold it for the next turn.
 * - `interrupt`: abort the running turn, then prompt.
 */
export type InputMode = "auto" | "queue" | "interrupt";

/** Where an input landed, read from oar's answer, never assumed. */
export type InputLanding = "prompted" | "steered" | "queued" | "rejected" | "failed";

export type RunEndReason =
  | "idle" // disposed after the idle timeout
  | "stopped" // someone stopped it
  | "restart" // stopped to restart with new options (for example another model)
  | "archived"
  | "exited" // the runtime process exited on its own
  | "shutdown" // the server shut down
  | "crashed"; // the server died without closing it; recorded at the next boot

export interface AgentChanges {
  readonly title?: string | null;
  readonly model?: string | null;
  readonly archived?: boolean;
}

export type EntryBody =
  | {
      readonly kind: "agent.created";
      readonly workspaceId: string;
      readonly runtime: string;
      readonly model?: string;
      readonly title?: string;
      readonly by: Actor;
    }
  | { readonly kind: "agent.updated"; readonly changes: AgentChanges; readonly by: Actor }
  | {
      readonly kind: "input";
      readonly inputId: string;
      readonly text: string;
      readonly mode: InputMode;
      readonly by: Actor;
      readonly trace?: string;
    }
  | {
      readonly kind: "input.result";
      readonly inputId: string;
      readonly landed: InputLanding;
      readonly runId?: string;
      readonly code?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "run.started";
      readonly runId: string;
      readonly runtime: string;
      readonly model?: string;
      readonly cwd: string;
      /** The runtime session this run resumed, when it did. */
      readonly resume?: string;
      /** The runtime's own session id: what the next run resumes. */
      readonly sessionId: string;
    }
  | { readonly kind: "run.failed"; readonly runId: string; readonly error: string }
  | { readonly kind: "oar"; readonly runId: string; readonly record: RawEvent }
  | {
      readonly kind: "run.ended";
      readonly runId: string;
      readonly reason: RunEndReason;
      readonly code?: number | null;
      readonly error?: string;
    }
  | { readonly kind: "host.error"; readonly code: string; readonly message: string };

export type EntryKind = EntryBody["kind"];

export type Entry = EntryBody & {
  /** Dense per agent, from 0. The cursor. */
  readonly seq: number;
  /** Unix epoch ms when the server appended it. For display, never for order. */
  readonly at: number;
};

export type EntryOf<K extends EntryKind> = Extract<Entry, { readonly kind: K }>;

/**
 * The wire form of an entry for clients: oar frames without their `native` payload (the
 * folds read only oar's typed events, and natives are most of the bytes). Runtime→app
 * requests keep theirs: a UI has to show what the agent is asking. Full entries stay in
 * the database for debugging tools.
 */
export function slimEntry(entry: Entry): Entry {
  if (entry.kind !== "oar") return entry;
  const { record } = entry;
  if (record.kind === "frame") {
    return { ...entry, record: { ...record, body: { ...record.body, native: null } } };
  }
  if (record.kind === "response" && (record.body.kind === "accepted" || record.body.kind === "rejected")) {
    const { native: _dropped, ...body } = record.body;
    return { ...entry, record: { ...record, body } };
  }
  return entry;
}
