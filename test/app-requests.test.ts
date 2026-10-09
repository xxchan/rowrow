// What a runtime asks the app: an approval or a question makes the agent need you; a client call
// its adapter answers itself (grok's terminal/*) doesn't, and it stays out of the transcript. Nor
// does one the runtime took back.
import type { RawEvent } from "@botiverse/oar";
import { describe, expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { attentionOf, summaryOf } from "../src/shared/summary.ts";

let seq = 0;
const entry = (body: EntryBody): Entry => ({ ...body, seq: seq++, at: 1000 + seq });
const request = (id: string, type: string): Entry =>
  entry({
    kind: "oar",
    runId: "r1",
    record: {
      kind: "request",
      id,
      direction: "toApp",
      sessionId: "s1",
      agentPath: [],
      seq,
      receivedAt: 2000 + seq,
      body: { kind: "native", type, params: {} },
    } as unknown as RawEvent,
  });

const cancelled = (requestId: string, agentPath: string[] = []): Entry =>
  entry({
    kind: "oar",
    runId: "r1",
    record: {
      kind: "frame",
      sessionId: "s1",
      agentPath,
      seq,
      receivedAt: 2000 + seq,
      body: {
        type: "control_cancel_request",
        native: null,
        events: [{ kind: "app_request_cancelled", requestId }],
      },
    } as unknown as RawEvent,
  });

describe("requests to the app", () => {
  it("needs you for an approval, not for a call the adapter answers itself", () => {
    seq = 0;
    const started = entry({ kind: "run.started", runId: "r1", runtime: "grok", cwd: "/w", sessionId: "s1" });
    const service = summaryOf([started, request("q1", "terminal/create")]);
    expect(service.pending).toEqual([]);
    expect(attentionOf(service, -1)).not.toBe("blocked");
    const approval = summaryOf([started, request("q2", "can_use_tool")]);
    expect(approval.pending.map((p) => p.type)).toEqual(["can_use_tool"]);
    expect(attentionOf(approval, -1)).toBe("blocked");
  });

  it("stops needing you when the runtime takes the request back, a sub-agent's too", () => {
    seq = 0;
    const started = entry({
      kind: "run.started",
      runId: "r1",
      runtime: "claude",
      cwd: "/w",
      sessionId: "s1",
    });
    const asked = [started, request("q1", "can_use_tool"), request("q2", "elicitation")];
    const withdrawn = summaryOf([...asked, cancelled("q1"), cancelled("q2", ["sub"])]);
    expect(withdrawn.pending).toEqual([]);
    expect(attentionOf(withdrawn, -1)).not.toBe("blocked");
    const one = summaryOf([...asked, cancelled("q1")]);
    expect(one.pending.map((p) => p.requestId)).toEqual(["q2"]);
  });
});
