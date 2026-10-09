import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionRefused } from "./file-actions.ts";
import { parseRaw, revertToTurnStart } from "./revert.ts";
import { SnapshotStore } from "./snapshots.ts";
import { commitAll, initRepo, isolateGit, listFiles, removeDir, sh, tempDir, write } from "./testing.ts";

beforeAll(isolateGit);

let tmp: string;
let repo: string;
let store: SnapshotStore;

beforeEach(() => {
  tmp = tempDir();
  repo = initRepo(tmp, "repo", {
    "a.txt": "a at the start\n",
    "keep.txt": "untouched\n",
    "old.txt": "one\ntwo\nthree\nfour\nfive\n",
    "gone.txt": "deleted by the turn\n",
    "run.sh": "#!/bin/sh\necho hi\n",
  });
  fs.chmodSync(path.join(repo, "run.sh"), 0o755);
  commitAll(repo, "run.sh executable");
  store = new SnapshotStore(path.join(tmp, "snapshots"));
});

afterEach(() => removeDir(tmp));

async function snapshot(): Promise<string> {
  const result = await store.capture(repo);
  if (result.kind !== "ok") throw new Error(result.reason);
  return result.tree;
}

const read = (file: string): string => fs.readFileSync(path.join(repo, file), "utf8");
const exists = (file: string): boolean => fs.existsSync(path.join(repo, file));
const index = (): string => fs.readFileSync(path.join(repo, ".git", "index")).toString("base64");

/** A turn: snapshots around `work`. */
async function turn(work: () => void): Promise<{ start: string; end: string }> {
  const start = await snapshot();
  work();
  return { start, end: await snapshot() };
}

describe("revertToTurnStart", () => {
  it("puts back a modified, an added, a deleted and a renamed file, and nothing else", async () => {
    write(repo, "a.txt", "uncommitted before the turn\n"); // the turn's start, not HEAD
    const { start, end } = await turn(() => {
      write(repo, "a.txt", "the turn's version\n");
      write(repo, "new/deep/added.txt", "made by the turn\n");
      fs.rmSync(path.join(repo, "gone.txt"));
      fs.renameSync(path.join(repo, "old.txt"), path.join(repo, "moved.txt"));
      write(repo, "keep.txt", "also changed by the turn\n");
      commitAll(repo, "the agent commits");
    });
    const head = sh(repo, "rev-parse", "HEAD");
    const before = index();
    const revert = (file: string) => revertToTurnStart({ dir: repo, store, start, end, path: file });

    expect(await revert("a.txt")).toEqual({ paths: ["a.txt"] });
    expect(read("a.txt")).toBe("uncommitted before the turn\n");
    expect(await revert("new/deep/added.txt")).toEqual({ paths: ["new/deep/added.txt"] });
    expect(exists("new")).toBe(false); // the folders it left empty go too
    expect(await revert("gone.txt")).toEqual({ paths: ["gone.txt"] });
    expect(read("gone.txt")).toBe("deleted by the turn\n");
    expect(await revert("moved.txt")).toEqual({ paths: ["old.txt", "moved.txt"] });
    expect(read("old.txt")).toBe("one\ntwo\nthree\nfour\nfive\n");
    expect(exists("moved.txt")).toBe(false);

    // Only those files: the other change, the index, HEAD and the commit stay.
    expect(read("keep.txt")).toBe("also changed by the turn\n");
    expect(index()).toBe(before);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    expect(listFiles(repo).filter((f) => !f.startsWith(".git/"))).toEqual([
      "a.txt",
      "gone.txt",
      "keep.txt",
      "old.txt",
      "run.sh",
    ]);
  });

  it("refuses a file that changed since the turn ended, and leaves it alone", async () => {
    const { start, end } = await turn(() => {
      write(repo, "a.txt", "the turn's version\n");
      write(repo, "added.txt", "made by the turn\n");
      fs.rmSync(path.join(repo, "gone.txt"));
    });
    write(repo, "a.txt", "edited after the turn\n");
    write(repo, "gone.txt", "recreated after the turn\n");
    fs.rmSync(path.join(repo, "added.txt"));
    for (const file of ["a.txt", "gone.txt"]) {
      await expect(revertToTurnStart({ dir: repo, store, start, end, path: file })).rejects.toThrow(
        new ActionRefused(
          `${file} changed since the turn ended, so it wasn't reverted: that would lose the newer changes.`,
        ),
      );
    }
    // Gone already, as it was before the turn: nothing to do.
    await expect(revertToTurnStart({ dir: repo, store, start, end, path: "added.txt" })).rejects.toThrow(
      "added.txt is already as it was before this turn.",
    );
    expect(read("a.txt")).toBe("edited after the turn\n");
    expect(read("gone.txt")).toBe("recreated after the turn\n");
  });

  it("keeps the file's permissions, with the executable bit it had when the turn started", async () => {
    const { start, end } = await turn(() => {
      write(repo, "run.sh", "#!/bin/sh\necho changed\n");
      fs.chmodSync(path.join(repo, "run.sh"), 0o640);
    });
    await revertToTurnStart({ dir: repo, store, start, end, path: "run.sh" });
    expect(read("run.sh")).toBe("#!/bin/sh\necho hi\n");
    expect(fs.statSync(path.join(repo, "run.sh")).mode & 0o777).toBe(0o750);
  });

  it("restores a symbolic link as a link, and never writes through one", async () => {
    fs.symlinkSync("a.txt", path.join(repo, "link"));
    commitAll(repo, "a link");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    const { start, end } = await turn(() => {
      fs.rmSync(path.join(repo, "link"));
      write(repo, "link", "a file now\n");
      fs.rmSync(path.join(repo, "gone.txt"));
      fs.mkdirSync(path.join(repo, "dir"));
      write(repo, "dir/x.txt", "x\n");
    });
    await revertToTurnStart({ dir: repo, store, start, end, path: "link" });
    expect(fs.readlinkSync(path.join(repo, "link"))).toBe("a.txt");

    // dir/ became a link to a folder outside the checkout after the turn.
    fs.rmSync(path.join(repo, "dir"), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, "dir"));
    write(outside, "x.txt", "x\n");
    await expect(revertToTurnStart({ dir: repo, store, start, end, path: "dir/x.txt" })).rejects.toThrow(
      /changed since the turn ended/,
    );
    expect(fs.readdirSync(outside)).toEqual(["x.txt"]);
  });

  it("refuses a file the turn didn't change, missing snapshots, and paths outside the checkout", async () => {
    const { start, end } = await turn(() => write(repo, "a.txt", "changed\n"));
    await expect(revertToTurnStart({ dir: repo, store, start, end, path: "keep.txt" })).rejects.toThrow(
      "keep.txt didn't change in this turn.",
    );
    await expect(revertToTurnStart({ dir: repo, store, start, end, path: "../a.txt" })).rejects.toThrow(
      ActionRefused,
    );
    const missing = "0".repeat(start.length - 1) + "1";
    await expect(revertToTurnStart({ dir: repo, store, start: missing, end, path: "a.txt" })).rejects.toThrow(
      "This turn's snapshots are no longer stored, so there is nothing to revert to.",
    );
    expect(read("a.txt")).toBe("changed\n");
  });
});

describe("parseRaw", () => {
  it("gives a rename's row both paths, and a deletion no end", () => {
    const z = "0".repeat(40);
    const out = [
      `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M`,
      "m.txt",
      `:100644 000000 ${"c".repeat(40)} ${z} D`,
      "d.txt",
      `:100644 100755 ${"e".repeat(40)} ${"f".repeat(40)} R087`,
      "old name",
      "new name",
      "",
    ].join("\0");
    const rows = parseRaw(out);
    expect([...rows.keys()]).toEqual(["m.txt", "d.txt", "new name"]);
    expect(rows.get("d.txt")).toEqual([
      { path: "d.txt", start: { mode: "100644", oid: "c".repeat(40) }, end: null },
    ]);
    expect(rows.get("new name")).toEqual([
      { path: "old name", start: { mode: "100644", oid: "e".repeat(40) }, end: null },
      { path: "new name", start: null, end: { mode: "100755", oid: "f".repeat(40) } },
    ]);
  });
});
