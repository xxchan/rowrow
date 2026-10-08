// A steer goes from "steering" to "not read" only when it is dropped: the runtime says so
// (codex, on an interrupt: oar's input_dropped) or its process ends. A stopped turn keeps it.
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

it("keeps a steer through a stopped turn: Claude Code reads it in the next one", () => {
  const by = { kind: "cli" };
  const entries = [
    entry({ kind: "agent.created", workspaceId: "w1", runtime: "claude", by }),
    entry({ kind: "run.started", runId: "r1", runtime: "claude", cwd: "/w", sessionId: "s1" }),
    entry({ kind: "input", inputId: "i2", text: "also check the tests", mode: "steer", by }),
    entry({ kind: "input.result", inputId: "i2", landed: "steered" }),
    frame([{ kind: "turn_ended", outcome: { kind: "aborted" } }]),
  ];
  const stopped = summaryOf(entries);
  expect(stopped.steering.map((q) => q.inputId)).toEqual(["i2"]);
  expect(stopped.unread).toEqual([]);
  // Its process ending is what drops it.
  const ended = summaryOf([...entries, entry({ kind: "run.ended", runId: "r1", reason: "stopped" })]);
  expect(ended.unread.map((q) => q.inputId)).toEqual(["i2"]);
});
