// Transcript search (agents.search, D-055): it finds what the transcript shows (your messages,
// the agent's text, its tool calls' input and output), whole though it streamed in fragments,
// in packed history too; each hit names an item a client folding the log from the hit's
// turnSeq renders; and a long log stays quick to search.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLog } from "../src/server/agents/log.ts";
import { TranscriptSearches } from "../src/server/agents/search.ts";
import { Db } from "../src/server/store/db.ts";
import type { Entry } from "../src/shared/entries.ts";
import { newInputId } from "../src/shared/ids.ts";
import { timelineOf } from "../src/shared/timeline.ts";
import { TranscriptProjector } from "../src/shared/transcript-model.ts";
import { searchEntries } from "../src/shared/transcript-search.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** An agent on the scripted runtime that has done these turns, one after another. */
async function agentWith(server: TestServer, ...turns: string[]): Promise<string> {
  const ws = await server.client.workspaces.add({ path: server.repo() });
  const { agent } = await server.client.agents.create({ workspaceId: ws.id, runtime: "scripted" });
  for (const text of turns) {
    const sent = await server.client.agents.send({
      agentId: agent.id,
      inputId: newInputId(),
      text,
      mode: "auto",
    });
    await server.client.agents.wait({ agentId: agent.id, afterSeq: sent.seq, timeoutMs: 10_000 });
  }
  return agent.id;
}

/** The item ids a client folding these entries renders (the kit's, which the web app puts on its elements). */
function itemIds(entries: readonly Entry[]): readonly string[] {
  return new TranscriptProjector("scripted").update(timelineOf(entries)).order ?? [];
}

describe("transcript search", () => {
  it("finds your messages, the agent's text and its tool calls' input and output, in any case", async () => {
    t = await startTestServer();
    const agentId = await agentWith(
      t,
      "/echo The Needle is here",
      "/run 1 grep needle notes.txt",
      "/echo nothing",
    );
    const found = await t.client.agents.search({ agentId, text: "NEEDLE" });
    expect(found.counts).toEqual({ you: 2, agent: 2, tool: 2 });
    expect(found.more).toBe(false);
    expect(found.hits.map((hit) => [hit.who, hit.field, hit.tool, hit.snippet])).toEqual([
      ["you", "text", null, "/echo The Needle is here"],
      ["agent", "text", null, "The Needle is here"],
      ["you", "text", null, "/run 1 grep needle notes.txt"],
      // Its input as the card shows it: the command, not the JSON around it.
      ["tool", "input", "Bash", "grep needle notes.txt"],
      ["tool", "output", "Bash", "ran grep needle notes.txt"],
      ["agent", "text", null, "Ran `grep needle notes.txt`."],
    ]);
    for (const hit of found.hits) {
      expect(hit.snippet.slice(...hit.match).toLowerCase()).toBe("needle");
      expect(hit.turnSeq).toBeLessThanOrEqual(hit.seq);
    }

    // Each names an item that a client folding the log from its turn renders.
    const all = await t.client.agents.entries({ agentId, after: -1 });
    for (const hit of found.hits) {
      expect(itemIds(all.entries)).toContain(hit.itemId);
      const from = all.entries.filter((entry) => entry.seq >= hit.turnSeq);
      expect(itemIds(from)).toContain(hit.itemId);
    }
    // The second turn, and not the first, is what loads for the tool call.
    const tool = found.hits.find((hit) => hit.who === "tool");
    const second = all.entries.filter((entry) => entry.kind === "input")[1];
    expect(tool?.turnSeq).toBe(second?.seq);

    // Only some kinds, counting all of them still; and nothing for what isn't there.
    const yours = await t.client.agents.search({ agentId, text: "needle", who: ["you"] });
    expect(yours.hits.map((hit) => hit.who)).toEqual(["you", "you"]);
    expect(yours.counts).toEqual(found.counts);
    expect((await t.client.agents.search({ agentId, text: "haystack" })).hits).toEqual([]);
    expect((await t.client.agents.search({ agentId, text: "   " })).hits).toEqual([]);

    // `rowrow agent search`: seq, when, who and the snippet, a line each.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.resolve(import.meta.dirname, "../src/cli/main.ts"), "agent", "search", agentId, "needle"],
      { env: { ...process.env, ROWROW_URL: t.server.url, ROWROW_TOKEN: t.token } },
    );
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^ *\d+ {2}\d\d-\d\d \d\d:\d\d {2}you {12}\/echo The Needle is here$/);
    expect(lines[4]).toMatch(/^ *\d+ {2}\d\d-\d\d \d\d:\d\d {2}Bash output {4}ran grep needle notes\.txt$/);
  });

  it("finds text that streamed in fragments, across them, as plain text", async () => {
    t = await startTestServer();
    const agentId = await agentWith(t, "/stream 4", "/echo a+b (c) [d]*", "/echo two\n\nlines");
    const streamed = await t.client.agents.search({ agentId, text: "chunk 2 chunk 3" });
    expect(streamed.hits.map((hit) => [hit.who, hit.snippet])).toEqual([
      ["agent", "chunk 1 chunk 2 chunk 3 chunk 4"],
    ]);
    // Not a pattern: what you typed, literally.
    const literal = await t.client.agents.search({ agentId, text: "+b (c) [d]*" });
    expect(literal.counts).toEqual({ you: 1, agent: 1, tool: 0 });
    // A space finds any whitespace, as the transcript shows it: the snippet is on one line.
    const lines = await t.client.agents.search({ agentId, text: "two lines", who: ["agent"] });
    expect(lines.hits.map((hit) => hit.snippet)).toEqual(["two lines"]);
  });
});

describe("transcript search over a long log", () => {
  /** A copy of a real scripted conversation's turns, `copies` times, each copy its own run and inputs. */
  async function longLog(copies: number): Promise<{ log: AgentLog; entries: number }> {
    t = await startTestServer();
    const agentId = await agentWith(
      t,
      "/echo Looking for the needle",
      "/run 1 ls\ngrep -rn needle .\ncat notes.txt",
      "/stream 30",
    );
    const page = await t.client.agents.entries({ agentId, after: -1, full: true });
    const log = new AgentLog(new Db(":memory:"));
    const ids = new Set<string>();
    for (const entry of page.entries) {
      if ("runId" in entry && entry.runId !== undefined) ids.add(entry.runId);
      if ("inputId" in entry) ids.add(entry.inputId);
    }
    for (let copy = 0; copy < copies; copy++) {
      for (const entry of page.entries) {
        if (entry.kind === "agent.created" && copy > 0) continue;
        let json = JSON.stringify(entry);
        for (const id of ids) json = json.replaceAll(id, `${id}-${copy}`);
        const { seq: _seq, at: _at, ...body } = JSON.parse(json) as Entry;
        log.append("ag_long", body);
      }
    }
    return { log, entries: log.head("ag_long") + 1 };
  }

  it("keeps the newest matches past the limit, finds the same in packed history, and stays quick", async () => {
    const { log, entries } = await longLog(60);
    expect(entries).toBeGreaterThan(3000);
    const search = (text: string, limit?: number) =>
      searchEntries(log.iterate("ag_long"), "scripted", text, limit === undefined ? {} : { limit });

    let started = performance.now();
    const found = search("needle");
    const fullFold = performance.now() - started;
    // Per copy: your two messages, the agent's two answers, and the grep's input and output.
    expect(found.counts).toEqual({ you: 120, agent: 120, tool: 120 });
    expect(found.hits).toHaveLength(200);
    expect(found.more).toBe(true);
    // The newest 200, oldest first.
    expect(found.hits.at(-1)?.seq).toBe(Math.max(...found.hits.map((hit) => hit.seq)));
    // Six a copy: the last 33 copies and the end of the one before.
    expect(found.hits[0]?.itemId).toContain("-26:");
    expect(search("needle", 5).hits.map((hit) => hit.itemId)).toEqual(
      found.hits.slice(-5).map((hit) => hit.itemId),
    );

    // Packed (D-041): the same hits, read from zstd blocks.
    expect(await log.pack(Date.now() + 1, 1)).toBeGreaterThan(entries / 2);
    started = performance.now();
    const packed = search("needle");
    const packedFold = performance.now() - started;
    expect(packed).toEqual(found);

    // The server keeps the fold: the next search (another letter typed) only searches it.
    const searches = new TranscriptSearches(log, () => "scripted");
    expect(await searches.search("ag_long", "needle")).toEqual(found);
    started = performance.now();
    expect((await searches.search("ag_long", "needl")).counts).toEqual(found.counts);
    const kept = performance.now() - started;
    log.append("ag_long", { kind: "host.error", code: "x", message: "y" });
    expect((await searches.search("ag_long", "needle")).counts).toEqual(found.counts);

    // D-055 quotes these from an idle machine (~100 ms, ~45 ms packed, 2 ms kept); the bounds
    // are generous, since this one may be busy.
    expect(fullFold).toBeLessThan(5000);
    expect(packedFold).toBeLessThan(5000);
    expect(kept).toBeLessThan(1000);
  });
});
