// Packed oar records (D-041): once an agent's records move into zstd blocks, every read gives
// back exactly what it gave before, appends go on, and the redaction pass still reaches them.
import type { RawEvent } from "@botiverse/oar";
import { describe, expect, it } from "vitest";
import type { EntryBody } from "../src/shared/entries.ts";
import { AgentLog } from "../src/server/agents/log.ts";
import { Db } from "../src/server/store/db.ts";

const frame = (text: string, type = "stream_event"): RawEvent =>
  ({
    kind: "frame",
    sessionId: "s1",
    agentPath: [],
    seq: 0,
    receivedAt: 0,
    body: { type, native: { text }, events: [{ kind: "text_delta", text }] },
  }) as unknown as RawEvent;

const input = (inputId: string): EntryBody =>
  ({ kind: "input", inputId, text: inputId, mode: "auto", by: { kind: "cli" } }) as unknown as EntryBody;

/** Four turns of 1,200 records each, an input before each, so packs and rows interleave. */
function fill(log: AgentLog, agentId: string): void {
  for (let turn = 0; turn < 4; turn++) {
    log.append(agentId, input(`in-${turn}`));
    for (let i = 0; i < 1200; i++)
      log.append(agentId, { kind: "oar", runId: "r1", record: frame(`${turn}.${i}`) });
  }
}

function reads(log: AgentLog, agentId: string) {
  const followed: number[] = [];
  log.follow(agentId, 2500, (entry) => followed.push(entry.seq))();
  return {
    head: log.head(agentId),
    count: log.count(),
    all: [...log.iterate(agentId)],
    window: log.read(agentId),
    turns: log.read(agentId, { turns: 2 }),
    older: log.read(agentId, { before: 2402, turns: 1 }),
    limited: log.read(agentId, { limit: 100 }),
    after: log.read(agentId, { after: 1199, limit: 10 }),
    followed,
    input: log.findInput(agentId, "in-2"),
  };
}

describe("packing the log", () => {
  it("reads back the same entries, by every read, and appends go on", async () => {
    const log = new AgentLog(new Db(":memory:"));
    fill(log, "ag_a");
    const before = reads(log, "ag_a");

    expect(await log.pack(Date.now() + 1, 1)).toBe(4800);
    expect(reads(new AgentLog(log["db"]), "ag_a")).toEqual(before);
    expect(reads(log, "ag_a")).toEqual(before);

    const next = log.append("ag_a", { kind: "oar", runId: "r1", record: frame("after") });
    expect(next.seq).toBe(before.head + 1);
    expect(new AgentLog(log["db"]).head("ag_a")).toBe(next.seq);
    expect(log.read("ag_a", { after: before.head }).entries).toEqual([next]);
    // Nothing is left to pack until more is old enough.
    expect(await log.pack(Date.now() - 60_000, 1)).toBe(0);
  });

  it("leaves an agent that is still writing alone until enough has waited", async () => {
    const log = new AgentLog(new Db(":memory:"));
    for (let i = 0; i < 10; i++) log.append("ag_live", { kind: "oar", runId: "r1", record: frame(`${i}`) });
    // Its newest record is newer than the cutoff, and too few are older.
    expect(await log.pack(Date.now() - 60_000, 1)).toBe(0);
    expect(await log.pack(Date.now() + 1, 1)).toBe(10);
  });

  it("redacts packed records again when the rules change, once", async () => {
    const log = new AgentLog(new Db(":memory:"));
    log.append("ag_a", { kind: "oar", runId: "r1", record: frame("secret", "_x.ai/mcp/servers_updated") });
    log.append("ag_a", { kind: "oar", runId: "r1", record: frame("plain") });
    await log.pack(Date.now() + 1, 1);
    const redact = (record: RawEvent): RawEvent =>
      record.kind === "frame" && record.body.type.startsWith("_x.ai/mcp/")
        ? { ...record, body: { ...record.body, native: "[redacted]" } }
        : record;
    const rules = { frameTypePrefixes: ["_x.ai/mcp/"], version: 2 };
    expect(await log.rewriteRecords(rules, redact)).toBe(1);
    expect(await log.rewriteRecords(rules, redact)).toBe(0);
    const [first, second] = [...log.iterate("ag_a")];
    expect(first?.kind === "oar" && first.record.kind === "frame" && first.record.body.native).toBe(
      "[redacted]",
    );
    expect(second?.kind === "oar" && second.record.kind === "frame" && second.record.body.native).toEqual({
      text: "plain",
    });
  });
});
