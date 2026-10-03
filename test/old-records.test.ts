// Logs written before oar 0.14 keep their tool output: the result was a string then, and oar's
// fold (0.14.2) reads old records upgraded to today's ordered parts.
import type { RawEvent } from "@botiverse/oar";
import { describe, expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { renderText } from "../src/shared/render-text.ts";
import { timelineOf } from "../src/shared/timeline.ts";

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
      body: { type: "scripted/tool", native: null, events },
    } as unknown as RawEvent,
  });

describe("records from older oar", () => {
  it("shows a tool's result recorded as output (before 0.14) and as content (since)", () => {
    seq = 0;
    const text = renderText(
      timelineOf([
        entry({ kind: "run.started", runId: "r1", runtime: "scripted", cwd: "/w", sessionId: "s1" }),
        frame([
          { kind: "tool_call_started", callId: "old", tool: "Bash", input: "ls" },
          { kind: "tool_call_ended", callId: "old", result: "ok", output: "README.md" },
          { kind: "tool_call_started", callId: "new", tool: "Bash", input: "pwd" },
          {
            kind: "tool_call_ended",
            callId: "new",
            result: "ok",
            content: [{ type: "text", text: "/w" }],
          },
        ]),
      ]),
      { toolChars: 80 },
    );
    expect(text).toContain("⎿ README.md");
    expect(text).toContain("⎿ /w");
  });
});
