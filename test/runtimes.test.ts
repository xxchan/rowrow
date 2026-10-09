// Runtime probing: every runtime is published as soon as its own probe answers, so one slow
// CLI (kimi can take seconds) never hides the others, the scripted one included. Update checks
// are cached; an upgrade runs once however often it's asked for, and the new version shows.
// A sign-in shows its progress in the runtime's info, takes its answer, and can be cancelled.
import type { AvailableInstallation, SessionOptions } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { formatLogout } from "../src/cli/login.ts";
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

  it("lists each model's service tiers, and says which runtimes refuse one (Fast mode, D-049)", async () => {
    const codexLike = {
      ...scriptedRuntime({ id: "tiers", turn: () => {} }),
      listModels: async () =>
        ({
          kind: "ok",
          models: [
            { id: "gpt-5.5", serviceTiers: ["priority", "flex"], defaultServiceTier: "flex" },
            { id: "gpt-5-mini" },
          ],
        }) as const,
    };
    const refusing = {
      ...scriptedRuntime({ id: "none", turn: () => {} }),
      refusedSessionOptions: { serviceTier: "none exposes no service tier" },
    };
    const runtimes = new Runtimes({ testRuntime: true, probe: false, extra: [codexLike, refusing] });
    await runtimes.refresh();
    const { models } = await runtimes.listModels("tiers");
    expect(models.map((m) => [m.id, m.serviceTiers])).toEqual([
      ["gpt-5.5", ["priority", "flex"]],
      ["gpt-5-mini", []],
    ]);
    expect((await runtimes.listModels("scripted")).models).toMatchObject([
      { id: "script-1", serviceTiers: ["fast"] },
    ]);
    expect(runtimes.refusal("none", "serviceTier")).toBe("none exposes no service tier");
    expect(runtimes.refusal("tiers", "serviceTier")).toBeNull();
  });

  it("signs a runtime in: progress in its info, the answer to its question, then who it is", async () => {
    let changes = 0;
    const runtimes = new Runtimes({ testRuntime: true, probe: false, changed: () => changes++ });
    await runtimes.refresh();
    expect(runtimes.info("scripted")).toMatchObject({
      auth: { kind: "logged_out" },
      canLogin: true,
      login: null,
    });

    const done = runtimes.login("scripted");
    // Asking again while it runs waits for the same sign-in.
    const again = runtimes.login("scripted");
    await expect.poll(() => runtimes.info("scripted")?.login?.prompt).not.toBeNull();
    const progress = runtimes.info("scripted")?.login;
    expect(progress?.events).toEqual([expect.objectContaining({ kind: "auth_url" })]);
    expect(progress?.prompt).toMatchObject({ kind: "manual_code" });
    expect(() => runtimes.answerLogin("scripted", "not-this-one", "rowrow")).toThrow(/isn't waiting/);
    runtimes.answerLogin("scripted", progress?.prompt?.id ?? "", "rowrow");

    const result = await done;
    expect(result).toEqual({
      kind: "logged_in",
      account: expect.objectContaining({ email: "demo@example.com" }),
    });
    expect(await again).toBe(result);
    expect(runtimes.info("scripted")).toMatchObject({ auth: { kind: "logged_in" }, login: null });
    expect(changes).toBeGreaterThan(2);
  });

  it("cancels a sign-in waiting on its question, and reports a rejected code", async () => {
    const runtimes = new Runtimes({ testRuntime: true, probe: false });
    await runtimes.refresh();
    const cancelled = runtimes.login("scripted");
    await expect.poll(() => runtimes.info("scripted")?.login?.prompt).not.toBeNull();
    runtimes.cancelLogin("scripted");
    expect(await cancelled).toEqual({ kind: "cancelled" });
    expect(runtimes.info("scripted")).toMatchObject({ auth: { kind: "logged_out" }, login: null });

    const rejected = runtimes.login("scripted");
    await expect.poll(() => runtimes.info("scripted")?.login?.prompt).not.toBeNull();
    runtimes.answerLogin("scripted", runtimes.info("scripted")?.login?.prompt?.id ?? "", "wrong");
    expect(await rejected).toMatchObject({ kind: "failed", reason: "rejected" });
  });

  it("signs a runtime out, not while a sign-in runs, and once however often it's asked", async () => {
    const runtimes = new Runtimes({ testRuntime: true, probe: false });
    await runtimes.refresh();
    expect(runtimes.info("scripted")).toMatchObject({ canLogout: true });
    const login = runtimes.login("scripted");
    await expect.poll(() => runtimes.info("scripted")?.login?.prompt).not.toBeNull();
    expect(() => runtimes.logout("scripted")).toThrow(/signing in/);
    runtimes.answerLogin("scripted", runtimes.info("scripted")?.login?.prompt?.id ?? "", "rowrow");
    await login;
    expect(runtimes.info("scripted")).toMatchObject({ auth: { kind: "logged_in" } });

    const done = runtimes.logout("scripted");
    expect(runtimes.logout("scripted")).toBe(done);
    expect(() => runtimes.login("scripted")).toThrow(/signing out/);
    expect(await done).toEqual({ kind: "logged_out" });
    expect(runtimes.info("scripted")).toMatchObject({ auth: { kind: "logged_out" } });
  });

  it("says a Cursor sign-out leaves its API key good, in the CLI too", () => {
    expect(formatLogout("cursor", { kind: "logged_out" })).toMatch(/revoke it in your Cursor dashboard/);
    expect(formatLogout("claude", { kind: "logged_out" })).toBe("signed out");
  });

  it("says which executable it runs, and the copies later on PATH that never run", async () => {
    const twice = {
      ...scriptedRuntime({ id: "twice", turn: () => {} }),
      installation: async () =>
        ({
          kind: "available",
          via: "executable",
          command: "/usr/local/bin/twice",
          version: "1.0.0",
          shadowed: ["/home/me/.local/bin/twice"],
        }) as const,
    };
    const runtimes = new Runtimes({ testRuntime: false, probe: false, extra: [twice] });
    await runtimes.refresh();
    expect(runtimes.info("twice")).toMatchObject({
      version: "1.0.0",
      command: "/usr/local/bin/twice",
      shadowed: ["/home/me/.local/bin/twice"],
    });
  });
});
