import { describe, expect, it } from "vitest";
import {
  collapseReason,
  createDiffQueue,
  diffKey,
  LARGE_PATCH_CHARS,
  readDiff,
  Retired,
  staleDiffs,
  storeDiff,
} from "./diff-loading.ts";

/** A request that answers when told to, counting how many run at once. */
function gate() {
  let running = 0;
  let most = 0;
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const run =
    (name: string, patch = "x") =>
    (): Promise<{ patch: string }> => {
      started.push(name);
      running += 1;
      most = Math.max(most, running);
      return new Promise((resolve) => {
        release.set(name, () => {
          running -= 1;
          resolve({ patch });
        });
      });
    };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return { run, started, release, tick, most: () => most };
}

describe("the diff queue", () => {
  it("runs two at a time to start, the next as one finishes", async () => {
    const queue = createDiffQueue();
    const g = gate();
    const done = ["a", "b", "c", "d"].map((name) => queue.request(g.run(name), () => true));
    expect(g.started).toEqual(["a", "b"]);
    g.release.get("a")?.();
    await g.tick();
    expect(g.started).toEqual(["a", "b", "c"]);
    for (const name of ["b", "c"]) g.release.get(name)?.();
    await g.tick();
    g.release.get("d")?.();
    await Promise.all(done);
    expect(g.most()).toBe(2);
  });

  it("puts a file you asked for first, and moves a waiting one up", async () => {
    const queue = createDiffQueue();
    const g = gate();
    for (const name of ["a", "b", "c", "d"]) void queue.request(g.run(name), () => true, false, name);
    void queue.request(g.run("asked"), () => true, true);
    queue.prioritize("d");
    g.release.get("a")?.();
    await g.tick();
    g.release.get("b")?.();
    await g.tick();
    expect(g.started).toEqual(["a", "b", "d", "asked"]);
  });

  it("drops a request nobody wants any more before it starts", async () => {
    const queue = createDiffQueue();
    const g = gate();
    let wanted = true;
    void queue.request(g.run("a"), () => true);
    void queue.request(g.run("b"), () => true);
    const dropped = queue.request(g.run("gone"), () => wanted);
    wanted = false;
    g.release.get("a")?.();
    await expect(dropped).rejects.toBeInstanceOf(Retired);
    expect(g.started).toEqual(["a", "b"]);
  });

  it("goes down to one at a time after a big answer", async () => {
    const queue = createDiffQueue();
    const g = gate();
    void queue.request(g.run("big", "x".repeat(LARGE_PATCH_CHARS)), () => true);
    for (const name of ["a", "b", "c"]) void queue.request(g.run(name), () => true);
    expect(g.started).toEqual(["big", "a"]);
    g.release.get("big")?.();
    g.release.get("a")?.();
    await g.tick();
    // One finished big, so only one runs now.
    expect(g.started).toEqual(["big", "a", "b"]);
  });
});

describe("collapseReason", () => {
  const file = { generated: undefined, additions: 3, deletions: 1 };
  it("starts generated files and large diffs collapsed", () => {
    expect(collapseReason(file)).toBeNull();
    expect(collapseReason({ ...file, generated: true })).toBe("Generated file");
    expect(collapseReason({ ...file, additions: 900, deletions: 100 })).toBe("1,000 changed lines");
    expect(collapseReason({ ...file, additions: null, deletions: null })).toBeNull();
  });

  it("collapses a patch that turns out long or cut, but not an empty one", () => {
    expect(collapseReason(file, { patch: "x".repeat(LARGE_PATCH_CHARS), truncated: false })).toBe(
      "Large diff",
    );
    expect(collapseReason(file, { patch: "x", truncated: true })).toBe("Large diff");
    expect(collapseReason(file, { patch: "", truncated: true })).toBeNull();
    expect(collapseReason(file, { patch: "x", truncated: false })).toBeNull();
  });
});

describe("the diff cache", () => {
  it("keeps the newest patches up to its budget, and marks a view's stale on refresh", () => {
    const big = "x".repeat(3_000_000);
    storeDiff(diffKey("w1", "a"), { version: 1, patch: big, truncated: false });
    storeDiff(diffKey("w1", "b"), { version: 1, patch: big, truncated: false });
    storeDiff(diffKey("w2", "c"), { version: 1, patch: "small", truncated: false });
    // Reading doesn't reorder; storing a third big one drops the oldest.
    storeDiff(diffKey("w2", "d"), { version: 1, patch: big, truncated: false });
    expect(readDiff(diffKey("w1", "a"))).toBeUndefined();
    expect(readDiff(diffKey("w1", "b"))?.version).toBe(1);

    staleDiffs("w2");
    expect(readDiff(diffKey("w2", "c"))).toEqual({ version: -1, patch: "small", truncated: false });
    expect(readDiff(diffKey("w1", "b"))?.version).toBe(1);
  });
});
