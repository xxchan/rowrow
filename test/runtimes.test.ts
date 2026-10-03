// Runtime probing: every runtime is published as soon as its own probe answers, so one slow
// CLI (kimi can take seconds) never hides the others, the scripted one included. Update checks
// are cached; an upgrade runs once however often it's asked for, and the new version shows.
import type { AvailableInstallation, SessionOptions } from "@botiverse/oar";
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

  it("checks for updates once an hour, and upgrades only once however often it's asked", async () => {
    let version = "1.0.0";
    let checks = 0;
    let upgrades = 0;
    const fake = {
      ...scriptedRuntime({ id: "fake", turn: () => {} }),
      installation: async () => ({ kind: "available", via: "executable", command: "fake", version }) as const,
      checkUpdate: async () => {
        checks++;
        return {
          kind: "ok",
          installed: version,
          latest: "1.1.0",
          updateAvailable: version !== "1.1.0",
          source: "fake --check",
        } as const;
      },
      upgrade: async () => {
        upgrades++;
        await sleep(50);
        const from = version;
        version = "1.1.0";
        return { kind: "upgraded", from, to: version, output: "x".repeat(10_000) } as const;
      },
    };
    const runtimes = new Runtimes({ testRuntime: true, probe: false, extra: [fake] });
    await runtimes.refresh();
    const available = {
      runtime: "fake",
      check: {
        kind: "ok",
        installed: "1.0.0",
        latest: "1.1.0",
        updateAvailable: true,
        source: "fake --check",
      },
      canUpgrade: true,
    };
    expect(await runtimes.updates(false)).toEqual([available]);
    expect(await runtimes.updates(false)).toEqual([available]);
    expect(checks).toBe(1);

    const [first, second] = await Promise.all([runtimes.upgrade("fake"), runtimes.upgrade("fake")]);
    expect(upgrades).toBe(1);
    expect(second).toBe(first);
    expect(first).toMatchObject({ kind: "upgraded", from: "1.0.0", to: "1.1.0" });
    expect(first.kind === "upgraded" ? first.output.length : 0).toBe(8001);
    expect(runtimes.info("fake")?.version).toBe("1.1.0");
    expect((await runtimes.updates(false))[0]?.check).toMatchObject({ updateAvailable: false });
    expect(checks).toBe(2);
    expect(() => runtimes.upgrade("scripted")).toThrow("no runtime scripted");
  });

  it("gives no environment to a runtime that declares it refuses one (Cursor, through its SDK)", async () => {
    const seen: Record<string, SessionOptions> = {};
    const recording = (id: string, refusesEnv = false) => {
      const base = scriptedRuntime({ id, turn: () => {} });
      return {
        ...base,
        ...(refusesEnv ? { refusedSessionOptions: { env: "runs in this process" } } : {}),
        session: (installation: AvailableInstallation, options: SessionOptions) => {
          seen[id] = options;
          return base.session(installation, options);
        },
      };
    };
    const runtimes = new Runtimes({
      testRuntime: false,
      probe: false,
      extra: [recording("cursor", true), recording("other")],
    });
    await runtimes.refresh();
    const options = { cwd: process.cwd(), env: { ROWROW_URL: "http://127.0.0.1:1" } };
    for (const id of ["cursor", "other"]) await (await runtimes.start(id, options)).dispose();
    expect(seen["cursor"]?.env).toBeUndefined();
    expect(seen["other"]?.env).toEqual(options.env);
  });
});
