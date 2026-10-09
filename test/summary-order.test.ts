// Agent lists sort by when a person last sent the agent a message, or its creation (D-053):
// what the agent does itself never moves it, so two agents at work don't swap places.
import type { RawEvent } from "@botiverse/oar";
import { expect, it } from "vitest";
import type { Actor, Entry, EntryBody } from "../src/shared/entries.ts";
import { byLastPersonInput, type AgentState } from "../src/shared/schemas.ts";
import { summaryOf } from "../src/shared/summary.ts";

let seq = 0;
/** Each entry a second after the one before: `at` is 1000 × (its seq + 1). */
const entry = (body: unknown): Entry => ({ ...(body as EntryBody), seq, at: 1000 * ++seq });
const you: Actor = { kind: "device", deviceId: "dev_phone", name: "iPhone" };
const frame = (events: unknown[]): Entry =>
  entry({
    kind: "oar",
    runId: "r1",
    record: {
      kind: "frame",
      sessionId: "s1",
      agentPath: [],
      seq,
      receivedAt: 0,
      body: { type: "frame", native: null, events },
    } as unknown as RawEvent,
  });
const send = (inputId: string, by: Actor = you, mode = "auto"): Entry =>
  entry({ kind: "input", inputId, text: "go on", mode, by });

it("starts at the agent's creation and moves only when a person sends it a message", () => {
  seq = 0;
  const created = entry({ kind: "agent.created", workspaceId: "w1", runtime: "claude", by: you });
  expect(summaryOf([created]).lastPersonInputAt).toBe(created.at);

  const prompt = send("i1");
  const working = [
    created,
    prompt,
    entry({ kind: "input.result", inputId: "i1", landed: "prompted", runId: "r1" }),
    entry({ kind: "run.started", runId: "r1", runtime: "claude", cwd: "/w", sessionId: "s1" }),
    frame([{ kind: "text_delta", text: "Reading the file" }]),
    frame([{ kind: "tool_call_started", callId: "c1", tool: "Bash", input: "ls" }]),
    frame([{ kind: "tool_call_ended", callId: "c1", outcome: "completed", content: [] }]),
    frame([{ kind: "turn_ended", outcome: { kind: "completed" } }]),
    entry({ kind: "run.ended", runId: "r1", reason: "idle" }),
  ];
  const summary = summaryOf(working);
  // Every entry is activity; only the prompt is a person's.
  expect(summary.lastActivityAt).toBe(working.at(-1)?.at);
  expect(summary.lastPersonInputAt).toBe(prompt.at);
});

it("counts a steer, and a held message when it was queued, not when rowrow sent it on", () => {
  seq = 0;
  const created = entry({ kind: "agent.created", workspaceId: "w1", runtime: "claude", by: you });
  const started = [
    created,
    send("i1"),
    entry({ kind: "input.result", inputId: "i1", landed: "prompted", runId: "r1" }),
    entry({ kind: "run.started", runId: "r1", runtime: "claude", cwd: "/w", sessionId: "s1" }),
  ];
  const steer = send("i2", you, "steer");
  expect(summaryOf([...started, steer]).lastPersonInputAt).toBe(steer.at);

  const queued = send("i3", you, "queue");
  const later = [
    ...started,
    queued,
    entry({ kind: "input.result", inputId: "i3", landed: "queued", held: true }),
    frame([{ kind: "text_delta", text: "still on the first one" }]),
    frame([{ kind: "turn_ended", outcome: { kind: "completed" } }]),
    entry({ kind: "input.sent", inputId: "i3", landed: "prompted", runId: "r1" }),
    frame([{ kind: "text_delta", text: "on to the next" }]),
  ];
  expect(summaryOf(later).queued).toEqual([]);
  expect(summaryOf(later).lastPersonInputAt).toBe(queued.at);
});

it("isn't moved by another agent, Coach acting alone, or a scheduled task", () => {
  seq = 0;
  const created = entry({ kind: "agent.created", workspaceId: "w1", runtime: "codex", by: you });
  const summary = summaryOf([
    created,
    send("i1", { kind: "agent", agentId: "ag_orchestrator" }),
    send("i2", { kind: "system" }),
  ]);
  expect(summary.inputs).toBe(2);
  expect(summary.lastPersonInputAt).toBe(created.at);
});

it("lists the one you wrote to last first, whichever is busier", () => {
  seq = 0;
  // You start one, then write to another, while the first streams on.
  const busy = [
    entry({ kind: "agent.created", workspaceId: "w1", runtime: "claude", by: you }),
    send("b1"),
    entry({ kind: "run.started", runId: "r1", runtime: "claude", cwd: "/w", sessionId: "s1" }),
  ];
  const quiet = summaryOf([
    entry({ kind: "agent.created", workspaceId: "w1", runtime: "claude", by: you }),
    send("q1"),
  ]);
  const streaming = summaryOf([
    ...busy,
    frame([{ kind: "text_delta", text: "chunk" }]),
    frame([{ kind: "text_delta", text: "chunk" }]),
  ]);
  expect(streaming.lastActivityAt).toBeGreaterThan(quiet.lastActivityAt);
  const state = (id: string, summary: typeof quiet): AgentState => ({
    id,
    summary,
    seenSeq: -1,
    attention: "idle",
    pinnedAt: null,
  });
  const agents = [state("busy", streaming), state("quiet", quiet)];
  expect(agents.sort(byLastPersonInput).map((a) => a.id)).toEqual(["quiet", "busy"]);
});
