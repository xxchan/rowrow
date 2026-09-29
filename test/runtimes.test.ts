// Runtime probing: every runtime is published as soon as its own probe answers, so one slow
// CLI (kimi can take seconds) never hides the others, the scripted one included.
import { scriptedRuntime } from "@botiverse/oar/testing";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Runtimes } from "../src/server/agents/runtimes.ts";

describe("runtimes", () => {
  it("publishes each runtime when its probe answers, not when the slowest does", async () => {
    const slow = {
      ...scriptedRuntime({ id: "slow", turn: () => {} }),
      installation: async () => {
        await sleep(300);
        return { kind: "available", via: "bundled" } as const;
      },
    };
    const runtimes = new Runtimes({ testRuntime: true, probe: false, extra: [slow] });
    const seen: Record<string, boolean>[] = [];
    await runtimes.refresh(() => {
      seen.push(Object.fromEntries(runtimes.list().map((info) => [info.id, info.installed])));
    });
    expect(seen).toEqual([
      { scripted: true, slow: false },
      { scripted: true, slow: true },
    ]);
  });
});
