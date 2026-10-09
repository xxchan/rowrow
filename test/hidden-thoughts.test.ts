// Thoughts the runtime keeps to itself (Claude's redacted thinking, Codex's encrypted
// reasoning) say nothing one by one, so back to back they read as one: in the web app, in
// `rowrow agent view`, and in the transcript items the iOS app shows.
import type { RawEvent } from "@botiverse/oar";
import type { ViewPart } from "@botiverse/oar/observe";
import { expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { renderText } from "../src/shared/render-text.ts";
import { foldHiddenThoughts, timelineOf } from "../src/shared/timeline.ts";
import { TranscriptProjector, type TranscriptItem } from "../src/shared/transcript-model.ts";

const hidden: ViewPart = { kind: "reasoning", content: { kind: "redacted" } };
const empty: ViewPart = { kind: "reasoning", content: { kind: "empty" } };
const readable: ViewPart = { kind: "reasoning", content: { kind: "text", text: "Look first" } };
const text: ViewPart = { kind: "text", text: "Done." };
const tool: ViewPart = { kind: "tool", callId: "c1", tool: "Bash", input: "ls", result: "ok" };

it("folds hidden thoughts back to back, and nothing else", () => {
  const runs = foldHiddenThoughts([
    hidden,
    empty,
    hidden,
    readable,
    readable,
    hidden,
    tool,
    hidden,
    hidden,
    text,
  ]);
  expect(runs.map(({ part, index, count }) => [part.kind, index, count])).toEqual([
    ["reasoning", 0, 3],
    ["reasoning", 3, 1],
    ["reasoning", 4, 1],
    ["reasoning", 5, 1],
    ["tool", 6, 1],
    ["reasoning", 7, 2],
    ["text", 9, 1],
  ]);
  expect(foldHiddenThoughts([])).toEqual([]);
});

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
const frame = (...events: unknown[]) => oar({ kind: "frame", body: { type: "event", native: null, events } });
const redacted = () => frame({ kind: "reasoning", content: { kind: "redacted" } });

const start = (): Entry[] => [
  entry({ kind: "agent.created", workspaceId: "w1", runtime: "claude", by: { kind: "cli" } }),
  entry({ kind: "run.started", runId: "r1", runtime: "claude", cwd: "/w", sessionId: "s1" }),
  oar({ kind: "request", id: "q1", direction: "toRuntime", body: { kind: "prompt", text: "go" } }),
  oar({ kind: "response", requestId: "q1", body: { kind: "accepted" } }),
  frame({ kind: "turn_started" }),
];

it("says a run of hidden thoughts once in `rowrow agent view`", () => {
  const entries = [
    ...start(),
    ...Array.from({ length: 7 }, redacted),
    frame({ kind: "reasoning", content: { kind: "text", text: "Now look" } }),
    redacted(),
    frame({ kind: "text_delta", text: "Done." }),
    frame({ kind: "turn_ended", outcome: { kind: "completed" } }),
  ];
  const lines = renderText(timelineOf(entries))
    .split("\n")
    .filter((line) => line.includes("(thinking)"));
  expect(lines).toEqual(["  (thinking) ×7", "  (thinking) Now look", "  (thinking)"]);
});

it("gives the app one item for the run, which counts each new one as it comes", () => {
  const projector = new TranscriptProjector("claude");
  const items = (delta: { items: readonly string[] }) =>
    delta.items.map((json) => JSON.parse(json) as TranscriptItem);
  const entries = [...start(), redacted(), redacted()];
  const first = projector.update(timelineOf(entries));
  const thoughts = items(first).filter((item) => item.kind === "reasoning");
  expect(thoughts).toEqual([expect.objectContaining({ text: null, count: 2, streaming: true })]);
  const id = thoughts[0]?.id;

  // One more hidden thought: the same item, counted again; the order stays.
  entries.push(redacted());
  const more = projector.update(timelineOf(entries));
  expect(more.order).toBeNull();
  expect(items(more)).toEqual([
    expect.objectContaining({ id, kind: "reasoning", count: 3, streaming: true }),
  ]);

  // A tool call ends the run: the thought after it is its own item.
  entries.push(
    frame({ kind: "tool_call_started", callId: "c1", tool: "Bash", input: "ls" }),
    frame({ kind: "tool_call_ended", callId: "c1", outcome: "completed", content: [] }),
    redacted(),
    frame({ kind: "turn_ended", outcome: { kind: "completed" } }),
  );
  const done = projector.update(timelineOf(entries));
  const order = done.order ?? [];
  expect(order.filter((item) => item.includes(":0:"))).toHaveLength(3);
  expect(items(done).filter((item) => item.kind === "reasoning")).toEqual([
    expect.objectContaining({ id, count: 3, streaming: false }),
    expect.objectContaining({ count: 1, streaming: false }),
  ]);
});
