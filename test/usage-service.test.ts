// Subscription usage (D-040): readings are stored sparsely per account and window, a failed
// read keeps the last good windows and says why, and a signed-out runtime isn't asked.
import type { AccountUsageSnapshot } from "@botiverse/oar";
import type { UtcInstant } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, it } from "vitest";
import { Runtimes } from "../src/server/agents/runtimes.ts";
import { Db } from "../src/server/store/db.ts";
import { UsageService } from "../src/server/usage.ts";

const MIN = 60_000;
const RESET = Date.UTC(2026, 9, 8, 12, 0, 0);

async function setup() {
  let next: () => Promise<AccountUsageSnapshot> = async () => ({ kind: "unsupported" });
  let signedIn = true;
  const fake = {
    ...scriptedRuntime({ id: "fake", turn: () => {} }),
    installation: async () =>
      ({ kind: "available", via: "executable", command: "fake", version: "1" }) as const,
    authStatus: async () =>
      signedIn
        ? ({ kind: "logged_in", source: "fake" } as const)
        : ({ kind: "logged_out", source: "fake" } as const),
    accountUsage: () => next(),
  };
  const runtimes = new Runtimes({ testRuntime: false, probe: false, extra: [fake] });
  await runtimes.refresh();
  let now = RESET - 60 * MIN;
  const usage = new UsageService({
    db: new Db(":memory:"),
    readers: () => runtimes.usageReaders(),
    now: () => now,
  });
  return {
    runtimes,
    usage,
    reads: (snapshot: () => Promise<AccountUsageSnapshot>) => (next = snapshot),
    advance: (ms: number) => (now += ms),
    signOut: () => (signedIn = false),
  };
}

const available = (usedRatio: number, email = "me@example.com"): AccountUsageSnapshot => ({
  kind: "available",
  email,
  plan: "max",
  rateLimited: false,
  windows: [
    // A reset time that jitters by seconds from read to read is the same reset.
    {
      id: "five_hour",
      label: "5-hour",
      usedRatio,
      durationMs: 300 * MIN,
      resetsAt: new Date(RESET + 7_000).toISOString() as UtcInstant,
    },
  ],
});

it("keeps a run of equal readings as its first and last, and every change", async () => {
  const { usage, reads, advance } = await setup();
  for (const used of [0.2, 0.2, 0.2, 0.2, 0.25]) {
    reads(async () => available(used));
    await usage.readAll();
    advance(5 * MIN);
  }
  const [fake] = usage.list();
  expect(fake).toMatchObject({
    runtime: "fake",
    problem: null,
    account: { email: "me@example.com", plan: "max" },
  });
  const start = RESET - 60 * MIN;
  expect(fake?.windows[0]?.history).toEqual([
    { at: start, left: 80, resetsAt: RESET },
    { at: start + 15 * MIN, left: 80, resetsAt: RESET },
    { at: start + 20 * MIN, left: 75, resetsAt: RESET },
  ]);
});

it("keeps the last good windows when a read fails, and says why", async () => {
  const { usage, reads } = await setup();
  reads(async () => available(0.5));
  await usage.readAll();
  reads(async () => {
    throw new Error("Failed to read usage");
  });
  await usage.readAll();
  const [fake] = usage.list();
  expect(fake?.problem).toEqual({ kind: "failed", detail: "Failed to read usage" });
  expect(fake?.windows[0]?.history.at(-1)?.left).toBe(50);
});

it("keeps each account's history apart, and forgets the windows once signed out", async () => {
  const { usage, reads, runtimes, signOut } = await setup();
  reads(async () => available(0.5, "a@example.com"));
  await usage.readAll();
  reads(async () => available(0.1, "b@example.com"));
  await usage.readAll();
  expect(usage.list()[0]?.windows[0]?.history.map((point) => point.left)).toEqual([90]);

  reads(async () => ({ kind: "reauth_required", reason: "not_authenticated" }));
  await usage.readAll();
  expect(usage.list()[0]).toMatchObject({
    problem: { kind: "signed_out", detail: "not_authenticated" },
    account: null,
    windows: [],
  });

  // Once rowrow knows it's signed out, it isn't asked at all.
  signOut();
  await runtimes.refresh();
  expect(usage.list()).toEqual([]);
});

it("a read asked for while one runs is a fresh one, after it", async () => {
  const { usage, reads } = await setup();
  // The running read asked before the account changed (say, before a sign-in finished).
  let answer: (snapshot: AccountUsageSnapshot) => void = () => {};
  reads(() => new Promise((resolve) => (answer = resolve)));
  const running = usage.readAll();
  let asked = 0;
  reads(async () => {
    asked += 1;
    return available(0.4);
  });
  const checkNow = usage.readAll();
  const alsoNow = usage.readAll();
  answer(available(0.9));
  await running;
  expect(usage.list()[0]?.windows[0]?.history.at(-1)?.left).toBe(10);
  // One more read for both, and it saw the change.
  await Promise.all([checkNow, alsoNow]);
  expect(asked).toBe(1);
  expect(usage.list()[0]?.windows[0]?.history.at(-1)?.left).toBe(60);
});
