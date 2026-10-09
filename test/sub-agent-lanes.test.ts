// A sub-agent's text is never the agent's own reply. Codex runs a sub-agent (spawn_agent) as a
// thread of its own: oar records its work under the child thread's sessionId with an empty
// agentPath ("nested" attribution), while it streams beside the parent. Read by agentPath
// alone, both streams were one lane and every switch between them a paragraph of the reply
// (reported on 0.3.60: an English sub-agent's text cut into a Chinese answer, fragment by
// fragment). Claude names its sub-agents by agentPath instead; that lane is unchanged.
import type { RawEvent } from "@botiverse/oar";
import { describe, expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { renderText } from "../src/shared/render-text.ts";
import { timelineOf } from "../src/shared/timeline.ts";
import { TranscriptProjector, type TranscriptItem } from "../src/shared/transcript-model.ts";

const ROOT = "019a7c1e-5b2a-7f30-9d41-2c6e8a1b3f00";
const CHILD = "019a7c1f-0c4d-7a12-8e55-7b9d3c2e1a44";

/** The parent's answer and the sub-agent's, in the fragments codex streamed them in. */
const ANSWER = [
  "次 `execution.iteration`、前驱输出、工作目录和快照",
  "信息。apply 另含整合来源和",
  "源码状态。\n\n- **Tools**：",
];
const CHILD_SAYS = [
  "re-review material fixes. Stop after at",
  " most 3 review rounds. Respect an explicit review-only request.\n\nTarget or focus",
  ": <命令后面的参数，默认是未提交改动>",
];

function codexRun(): Entry[] {
  let seq = 0;
  let recordSeq = 0;
  const entry = (body: EntryBody): Entry => ({ ...body, seq: seq++, at: 1000 + seq });
  const oar = (record: Record<string, unknown>): Entry =>
    entry({
      kind: "oar",
      runId: "r1",
      record: {
        agentPath: [],
        seq: recordSeq++,
        receivedAt: 2000 + recordSeq,
        ...record,
      } as unknown as RawEvent,
    });
  // One codex notification, as oar's codex projection records it.
  const frame = (thread: string, turnId: string, type: string, native: object, events: object[]): Entry =>
    oar({
      kind: "frame",
      sessionId: thread,
      spanId: turnId,
      body: { type, native: { threadId: thread, turnId, ...native }, events },
    });
  const delta = (thread: string, turnId: string, itemId: string, text: string): Entry =>
    frame(thread, turnId, "item/agentMessage/delta", { itemId, delta: text }, [
      { kind: "text_delta", text, messageId: itemId },
    ]);
  const spawn = {
    type: "subAgentActivity",
    id: "call_spawn",
    kind: "started",
    agentThreadId: CHILD,
    agentPath: "/root/reviewer",
  };
  const entries = [
    entry({ kind: "run.started", runId: "r1", runtime: "codex", cwd: "/w", sessionId: ROOT }),
    oar({
      kind: "request",
      sessionId: ROOT,
      direction: "toRuntime",
      id: "req1",
      body: { kind: "prompt", input: "设计一下" },
    }),
    frame(ROOT, "turn1", "item/completed", { item: spawn }, [
      {
        kind: "task_started",
        taskId: CHILD,
        taskType: "agent",
        nativeType: "subAgent",
        childSessionId: CHILD,
        background: true,
        description: "/root/reviewer",
        toolCallId: "call_spawn",
      },
    ]),
  ];
  // Both stream at once: the child's message and the parent's, fragment by fragment.
  for (let i = 0; i < ANSWER.length; i++) {
    entries.push(delta(CHILD, "turn_c1", "msg_child", CHILD_SAYS[i] ?? ""));
    entries.push(delta(ROOT, "turn1", "msg_root", ANSWER[i] ?? ""));
  }
  entries.push(
    frame(CHILD, "turn_c1", "turn/completed", { turn: { id: "turn_c1", status: "completed" } }, [
      { kind: "turn_ended", outcome: { kind: "completed" } },
    ]),
    frame(ROOT, "turn1", "turn/completed", { turn: { id: "turn1", status: "completed" } }, [
      { kind: "turn_ended", outcome: { kind: "completed" } },
    ]),
  );
  return entries;
}

/** The text items of each lane, joined: what a client shows as one agent's words. */
function saidBy(items: readonly TranscriptItem[]): Map<string, string> {
  const said = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "text") continue;
    const lane = item.lane.join(" / ");
    said.set(lane, (said.get(lane) ?? "") + item.text);
  }
  return said;
}

describe("sub-agent lanes", () => {
  it("keeps a codex sub-agent's text out of the agent's own reply", () => {
    const delta = new TranscriptProjector("codex").update(timelineOf(codexRun()));
    const items = delta.items.map((json) => JSON.parse(json) as TranscriptItem);
    expect(saidBy(items)).toEqual(
      new Map([
        ["", ANSWER.join("")],
        [CHILD, CHILD_SAYS.join("")],
      ]),
    );
  });

  it("shows it as a sub-agent in the plain-text transcript", () => {
    const text = renderText(timelineOf(codexRun()));
    // Every line of the reply is the agent's; the sub-agent's lines sit under its marker.
    const own = text.split("\n").filter((line) => /^ {2}\S/.test(line));
    for (const fragment of CHILD_SAYS) expect(own.join("\n")).not.toContain(fragment.trim().split("\n")[0]);
    expect(text).toContain(`↳ ${CHILD}`);
  });

  it("leaves claude's sub-agents where agentPath puts them", () => {
    let seq = 0;
    const entry = (body: EntryBody): Entry => ({ ...body, seq: seq++, at: 1000 + seq });
    const frame = (agentPath: string[], events: object[]): Entry =>
      entry({
        kind: "oar",
        runId: "r1",
        record: {
          kind: "frame",
          sessionId: "s1",
          agentPath,
          seq,
          receivedAt: 2000 + seq,
          body: { type: "stream_event", native: null, events },
        } as unknown as RawEvent,
      });
    const entries = [
      entry({ kind: "run.started", runId: "r1", runtime: "claude", cwd: "/w", sessionId: "s1" }),
      frame([], [{ kind: "text_delta", text: "Looking into it.", messageId: "msg_1" }]),
      frame(["toolu_A"], [{ kind: "text_delta", text: "Found it.", messageId: "msg_2" }]),
    ];
    const items = new TranscriptProjector("claude")
      .update(timelineOf(entries))
      .items.map((json) => JSON.parse(json) as TranscriptItem);
    expect(saidBy(items)).toEqual(
      new Map([
        ["", "Looking into it."],
        ["toolu_A", "Found it."],
      ]),
    );
  });
});
