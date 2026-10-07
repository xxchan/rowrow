// Stored records rewritten in place (oar's redactRecord, for credentials a runtime reported
// before oar redacted them): only the records the rewrite changes are written, across pages,
// and running it again changes nothing.
import type { RawEvent } from "@botiverse/oar";
import { redactRecord } from "@botiverse/oar/observe";
import { describe, expect, it } from "vitest";
import { AgentLog } from "../src/server/agents/log.ts";
import { Db } from "../src/server/store/db.ts";

const frame = (type: string, native: unknown): RawEvent =>
  ({
    kind: "frame",
    sessionId: "s1",
    agentPath: [],
    seq: 0,
    receivedAt: 0,
    body: { type, native, events: [] },
  }) as unknown as RawEvent;

describe("rewriting stored records", () => {
  it("writes back only what the rewrite changed, page after page, and only once", async () => {
    const log = new AgentLog(new Db(":memory:"));
    for (let i = 0; i < 450; i++) {
      log.append("ag_a", {
        kind: "oar",
        runId: "r1",
        record: frame("_x.ai/mcp/servers_updated", { token: `secret-${i}` }),
      });
    }
    log.append("ag_b", {
      kind: "oar",
      runId: "r1",
      record: frame("session/update", { token: "not-this-one" }),
    });
    log.append("ag_b", {
      kind: "oar",
      runId: "r1",
      record: frame("_x.ai/mcp/servers_updated", { token: "[redacted]" }),
    });

    const redact = (record: RawEvent): RawEvent => {
      const body = (record as unknown as { body: { native: { token: string } } }).body;
      return body.native.token === "[redacted]"
        ? record
        : ({ ...record, body: { ...body, native: { token: "[redacted]" } } } as unknown as RawEvent);
    };
    expect(await log.rewriteRecords(["_x.ai/mcp/"], redact)).toBe(450);
    expect(await log.rewriteRecords(["_x.ai/mcp/"], redact)).toBe(0);

    const tokens = (agentId: string) =>
      log
        .read(agentId, { after: -1, limit: 1000 })
        .entries.map((entry) =>
          entry.kind === "oar"
            ? (entry.record as unknown as { body: { native: { token: string } } }).body.native.token
            : null,
        );
    expect(new Set(tokens("ag_a"))).toEqual(new Set(["[redacted]"]));
    expect(tokens("ag_b")).toEqual(["not-this-one", "[redacted]"]);
  });

  it("redacts the env grok's MCP notifications carried, with oar's redactRecord", async () => {
    const log = new AgentLog(new Db(":memory:"));
    const servers = {
      servers: [{ name: "github", command: "gh-mcp", env: [{ name: "GITHUB_TOKEN", value: "ghp_secret" }] }],
    };
    log.append("ag_g", { kind: "oar", runId: "r1", record: frame("_x.ai/mcp/servers_updated", servers) });
    expect(await log.rewriteRecords(["_x.ai/mcp/"], redactRecord)).toBe(1);
    const [entry] = log.read("ag_g", { after: -1 }).entries;
    const stored = JSON.stringify(entry);
    expect(stored).not.toContain("ghp_secret");
    expect(stored).toContain("GITHUB_TOKEN");
    expect(await log.rewriteRecords(["_x.ai/mcp/"], redactRecord)).toBe(0);
  });
});
