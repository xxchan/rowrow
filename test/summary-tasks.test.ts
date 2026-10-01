// Background work in the summary (oar's task events): what's still running shows beside the
// agent, even after its turn ended, and it all ends with the run.
import type { RawEvent } from "@botiverse/oar";
import { describe, expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { summaryOf } from "../src/shared/summary.ts";

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
      seq: seq,
      receivedAt: 2000 + seq,
      body: { type: "system/task", native: null, events },
    } as unknown as RawEvent,
  });

describe("summary tasks", () => {
  it("lists tasks still going, leaves out the runtime's own, and clears them when the run ends", () => {
    seq = 0;
    const started = [
      entry({ kind: "run.started", runId: "r1", runtime: "claude", cwd: "/w", sessionId: "s1" }),
      frame([
        { kind: "task_started", taskId: "t1", taskType: "shell", description: "npm test", background: true },
        { kind: "task_started", taskId: "t2", taskType: "agent", description: "Explore the repo" },
        { kind: "task_started", taskId: "t3", taskType: "other", ambient: true },
      ]),
    ];
    const running = summaryOf(started);
    expect(running.tasks.map((task) => [task.taskId, task.taskType, task.description])).toEqual([
      ["t1", "shell", "npm test"],
      ["t2", "agent", "Explore the repo"],
    ]);

    const ended = summaryOf([...started, frame([{ kind: "task_ended", taskId: "t2", status: "completed" }])]);
    expect(ended.tasks.map((task) => task.taskId)).toEqual(["t1"]);

    const gone = summaryOf([...started, entry({ kind: "run.ended", runId: "r1", reason: "stopped" })]);
    expect(gone.tasks).toEqual([]);
  });
});
