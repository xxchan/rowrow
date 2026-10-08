// A steer the runtime dropped (codex, on an interrupt: oar's input_dropped) moves from
// "steering" to "not read" at once, without waiting for the turn to end.
import type { RawEvent } from "@botiverse/oar";
import { expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { summaryOf } from "../src/shared/summary.ts";

let seq = 0;
const entry = (body: unknown): Entry => ({ ...(body as EntryBody), seq: seq++, at: 1000 + seq });
const frame = (events: unknown[]): Entry =>
  entry({
    kind: "oar",
    runId: "r1",
    record: {
      kind: "frame",
      sessionId: "s1",
      agentPath: [],
      seq,
      receivedAt: 2000 + seq,
      body: { type: "turn/completed", native: null, events },
    } as unknown as RawEvent,
  });

it("moves a steer the runtime dropped to the ones not read", () => {
  const by = { kind: "cli" };
  const steered = [
    entry({ kind: "agent.created", workspaceId: "w1", runtime: "codex", by }),
    entry({ kind: "run.started", runId: "r1", runtime: "codex", cwd: "/w", sessionId: "s1" }),
    entry({ kind: "input", inputId: "i1", text: "use the other file", mode: "steer", by }),
    entry({ kind: "input.result", inputId: "i1", landed: "steered" }),
  ];
  expect(summaryOf(steered).steering.map((q) => q.inputId)).toEqual(["i1"]);
  const dropped = summaryOf([
    ...steered,
    frame([{ kind: "input_dropped", inputId: "i1", reason: "turn_interrupted" }]),
  ]);
  expect(dropped.steering).toEqual([]);
  expect(dropped.unread.map((q) => q.inputId)).toEqual(["i1"]);
});
