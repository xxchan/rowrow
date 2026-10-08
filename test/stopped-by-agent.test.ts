// An aborted turn is yours when rowrow had a stop in flight (an abort or dispose); otherwise the
// runtime stopped it itself (a pi extension, oar 0.44), and the transcript says so.
import type { RawEvent } from "@botiverse/oar";
import { expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { renderText } from "../src/shared/render-text.ts";
import { timelineOf } from "../src/shared/timeline.ts";

let seq = 0;
const entry = (body: unknown): Entry => ({ ...(body as EntryBody), seq: seq++, at: 1000 + seq });
const oar = (record: unknown): Entry =>
  entry({
    kind: "oar",
    runId: "r1",
    record: {
      sessionId: "s1",
      agentPath: [],
      seq,
      receivedAt: 2000 + seq,
      ...(record as object),
    } as unknown as RawEvent,
  });
const frame = (events: unknown[]) => oar({ kind: "frame", body: { type: "event", native: null, events } });

// Built in order: the timeline takes entries by seq.
const turn = (stop = (): Entry[] => [], after = (): Entry[] => []): Entry[] => [
  entry({ kind: "agent.created", workspaceId: "w1", runtime: "pi", by: { kind: "cli" } }),
  entry({ kind: "run.started", runId: "r1", runtime: "pi", cwd: "/w", sessionId: "s1" }),
  oar({ kind: "request", id: "q1", direction: "toRuntime", body: { kind: "prompt", text: "go" } }),
  oar({ kind: "response", requestId: "q1", body: { kind: "accepted" } }),
  frame([{ kind: "turn_started" }]),
  ...stop(),
  frame([{ kind: "turn_ended", outcome: { kind: "aborted" } }]),
  ...after(),
];
const abort = () => oar({ kind: "request", id: "q2", direction: "toRuntime", body: { kind: "abort" } });
const accepted = () => oar({ kind: "response", requestId: "q2", body: { kind: "accepted" } });

it("says the agent stopped a turn no stop from rowrow was in flight for", () => {
  expect(renderText(timelineOf(turn()))).toContain("■ turn aborted by the agent");
});

it("keeps a turn you stopped yours, whenever the runtime answers the abort", () => {
  for (const entries of [
    turn(() => [abort(), accepted()]),
    turn(
      () => [abort()],
      () => [accepted()],
    ),
  ]) {
    const text = renderText(timelineOf(entries));
    expect(text).toContain("■ turn aborted");
    expect(text).not.toContain("by the agent");
  }
});
