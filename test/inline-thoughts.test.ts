// Thinking a model writes into its reply as <think>…</think> (pi passes it on as text): a thought
// in the transcript, left out of the preview, however the tags arrive.
import type { RawEvent } from "@botiverse/oar";
import type { ViewPart } from "@botiverse/oar/observe";
import { describe, expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import {
  inlineThought,
  NO_THOUGHT,
  previewPiece,
  withInlineThoughts,
} from "../src/shared/inline-thoughts.ts";
import { summaryOf } from "../src/shared/summary.ts";

const ME = { kind: "device", deviceId: "d1", name: "phone" } as const;
let seq = 0;
const entry = (body: EntryBody): Entry => ({ ...body, seq: seq++, at: 1000 + seq });
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
      body: { type: "message_update", native: null, events },
    } as unknown as RawEvent,
  });
const text = (...pieces: string[]): Entry[] =>
  pieces.map((piece) => frame([{ kind: "text_delta", text: piece }]));
const previewOf = (pieces: string[]): string | null => {
  seq = 0;
  return summaryOf([
    entry({ kind: "agent.created", workspaceId: "w", runtime: "pi", by: ME }),
    entry({ kind: "run.started", runId: "r1", runtime: "pi", cwd: "/w", sessionId: "s1" }),
    ...text(...pieces),
  ]).preview;
};

describe("a reply's inline thought", () => {
  it("splits off a leading <think> block, open or closed", () => {
    expect(inlineThought("<think>Keep it short.</think>不全是：")).toEqual({
      thought: "Keep it short.",
      rest: "不全是：",
      open: false,
    });
    expect(inlineThought("\n<think>\nstill going")).toEqual({ thought: "still going", rest: "", open: true });
    // The tag itself streaming in is an empty thought, not markup.
    expect(inlineThought("<thi")).toEqual({ thought: "", rest: "", open: true });
    expect(inlineThought("Use <think> tags like this")).toBeNull();
    expect(inlineThought("<b>bold</b>")).toBeNull();
  });

  it("becomes a reasoning part before the rest of the text, and leaves other parts alone", () => {
    const tool: ViewPart = { kind: "tool", callId: "c1", tool: "bash", result: "ok" };
    const plain: ViewPart[] = [{ kind: "text", text: "hi" }, tool];
    expect(withInlineThoughts(plain)).toBe(plain);
    expect(
      withInlineThoughts([{ kind: "text", text: "<think>a</think>\n\nanswer", messageId: "m1" }, tool]),
    ).toEqual([
      { kind: "reasoning", content: { kind: "text", text: "a" }, messageId: "m1" },
      { kind: "text", text: "answer", messageId: "m1" },
      tool,
    ]);
    expect(withInlineThoughts([{ kind: "text", text: "<think>half" }])).toEqual([
      { kind: "reasoning", content: { kind: "text", text: "half" } },
    ]);
  });

  it("stays out of the preview, with its tags in any pieces", () => {
    expect(previewOf(["<think>Keep it short.</think>", "不全是：", "边界要分清"])).toBe("不全是：边界要分清");
    expect(previewOf(["<", "thi", "nk>Keep it", " short.</th", "ink>\n\n", "答案"])).toBe("答案");
    expect(previewOf(["Plain ", "text"])).toBe("Plain text");
    expect(previewOf(["<b>", "bold</b>"])).toBe("<b>bold</b>");
  });

  it("keeps the last preview while it thinks", () => {
    let step = previewPiece("<think>hmm", true, NO_THOUGHT);
    expect([step.text, step.state.thinking]).toEqual([null, true]);
    step = previewPiece("</think>", false, step.state);
    expect([step.text, step.restart, step.state]).toEqual(["", true, NO_THOUGHT]);
  });
});
