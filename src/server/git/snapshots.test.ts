import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SnapshotStore, changedPaths } from "./snapshots.ts";
import {
  commitAll,
  initRepo,
  isolateGit,
  listFiles,
  removeDir,
  sh,
  shEnv,
  tempDir,
  write,
} from "./testing.ts";

beforeAll(isolateGit);

let tmp: string;
let repo: string;
let store: SnapshotStore;

beforeEach(() => {
  tmp = tempDir();
  repo = initRepo(tmp, "repo", { "a.txt": "one\n", "b.txt": "two\n", "src/c.txt": "three\n" });
  store = new SnapshotStore(path.join(tmp, "snapshots"));
});

afterEach(() => removeDir(tmp));

/** Everything a snapshot must not change: the whole .git directory and the worktree. */
function fingerprint(dir: string): unknown {
  const gitDir = path.join(dir, ".git");
  const index = path.join(gitDir, "index");
  return {
    gitFiles: listFiles(gitDir),
    index: fs.readFileSync(index).toString("base64"),
    indexMtime: fs.statSync(index).mtimeMs,
    refs: sh(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: fs.readFileSync(path.join(gitDir, "HEAD"), "utf8"),
    worktree: listFiles(dir)
      .filter((file) => !file.startsWith(".git/"))
      .map((file) => [file, fs.readFileSync(path.join(dir, file), "utf8")]),
  };
}

async function captureOk(dir: string): Promise<string> {
  const result = await store.capture(dir);
  if (result.kind !== "ok") throw new Error(`capture refused: ${result.reason}`);
  return result.tree;
}

async function treeFiles(dir: string, tree: string): Promise<Record<string, string>> {
  const env = await store.env(dir);
  const files: Record<string, string> = {};
  for (const line of shEnv(dir, env, "ls-tree", "-r", "--name-only", "-z", tree).split("\0")) {
    if (line !== "") files[line] = shEnv(dir, env, "cat-file", "-p", `${tree}:${line}`);
  }
  return files;
}

describe("SnapshotStore.capture", () => {
  it("snapshots tracked and untracked files without touching the repository", async () => {
    write(repo, "a.txt", "one, edited\n");
    fs.rmSync(path.join(repo, "b.txt"));
    write(repo, "staged.txt", "staged\n");
    sh(repo, "add", "staged.txt");
    write(repo, "new.txt", "brand new\n");
    write(repo, "deep/er/file.txt", "nested\n");
    write(repo, ".gitignore", "ignored.txt\n");
    write(repo, "ignored.txt", "secret\n");
    const before = fingerprint(repo);

    const result = await store.capture(repo);

    expect(result.kind).toBe("ok");
    expect(fingerprint(repo)).toEqual(before);
    const tree = result.kind === "ok" ? result.tree : "";
    expect(await treeFiles(repo, tree)).toEqual({
      ".gitignore": "ignored.txt\n",
      "a.txt": "one, edited\n",
      "deep/er/file.txt": "nested\n",
      "new.txt": "brand new\n",
      "src/c.txt": "three\n",
      "staged.txt": "staged\n",
    });
    // The tree and new blobs exist only in the private store.
    expect(() => sh(repo, "cat-file", "-e", tree)).toThrow();
    expect(result.kind === "ok" && result.at <= Date.now()).toBe(true);
  });

  it("stays readable after the agent commits and switches branches", async () => {
    write(repo, "a.txt", "work in progress\n");
    const tree = await captureOk(repo);
    commitAll(repo, "wip");
    sh(repo, "checkout", "-q", "-b", "elsewhere", "HEAD~1");
    expect((await treeFiles(repo, tree))["a.txt"]).toBe("work in progress\n");
  });

  it("gives the same tree for the same state, and works from a subdirectory and a linked worktree", async () => {
    write(repo, "x.txt", "x\n");
    const first = await captureOk(repo);
    expect(await captureOk(path.join(repo, "src"))).toBe(first);
    sh(repo, "worktree", "add", "-q", "-b", "side", path.join(tmp, "side"));
    write(path.join(tmp, "side"), "side.txt", "side\n");
    const side = await captureOk(path.join(tmp, "side"));
    expect(Object.keys(await treeFiles(path.join(tmp, "side"), side))).toContain("side.txt");
    expect(Object.keys(await treeFiles(repo, first))).not.toContain("side.txt");
  });

  it("works on a repository with no commits", async () => {
    const fresh = path.join(tmp, "fresh");
    fs.mkdirSync(fresh);
    sh(fresh, "init", "-q");
    write(fresh, "untracked.txt", "u\n");
    expect(await treeFiles(fresh, await captureOk(fresh))).toEqual({ "untracked.txt": "u\n" });
    write(fresh, "staged.txt", "s\n");
    sh(fresh, "add", "staged.txt");
    expect(await treeFiles(fresh, await captureOk(fresh))).toEqual({
      "staged.txt": "s\n",
      "untracked.txt": "u\n",
    });
  });

  it("refuses a file over 8 MiB before hashing anything", async () => {
    await captureOk(repo); // creates the store
    const storeFiles = listFiles(store.root);
    write(repo, "huge.bin", Buffer.alloc(9 * 1024 * 1024, 1));
    const before = fingerprint(repo);
    const result = await store.capture(repo);
    expect(result).toEqual({
      kind: "refused",
      reason: "huge.bin is 9.0 MiB (the limit is 8.0 MiB per file)",
    });
    expect(listFiles(store.root)).toEqual(storeFiles);
    expect(fingerprint(repo)).toEqual(before);
  });

  it("refuses more than 32 MiB in total, and more than 10,000 files", async () => {
    for (let i = 0; i < 5; i++) write(repo, `big${i}.bin`, Buffer.alloc(7 * 1024 * 1024, i + 1));
    expect(await store.capture(repo)).toEqual({
      kind: "refused",
      reason: expect.stringMatching(/add up to more than 32\.0 MiB/),
    });
    for (let i = 0; i < 5; i++) fs.rmSync(path.join(repo, `big${i}.bin`));
    for (let i = 0; i <= 10_000; i++) write(repo, `many/${i % 100}/${i}.txt`, "");
    expect(await store.capture(repo)).toEqual({
      kind: "refused",
      reason: "10001 changed or untracked files (the limit is 10000)",
    });
  });

  it.skipIf(!modesEnforced())("refuses an unreadable file instead of snapshotting around it", async () => {
    write(repo, "locked.txt", "no\n");
    fs.chmodSync(path.join(repo, "locked.txt"), 0);
    const result = await store.capture(repo);
    fs.chmodSync(path.join(repo, "locked.txt"), 0o644);
    expect(result).toEqual({
      kind: "refused",
      reason: expect.stringMatching(/git add failed: .*locked\.txt/s),
    });
  });

  it("refuses a directory that isn't a git repository", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    expect(await store.capture(plain)).toEqual({
      kind: "refused",
      reason: expect.stringMatching(/not a git repository/),
    });
  });
});

describe("SnapshotStore.prune", () => {
  it("deletes objects older than the age and crash leftovers, keeps recent ones", async () => {
    write(repo, "a.txt", "changed\n");
    const tree = await captureOk(repo);
    const [storeDir = ""] = fs.readdirSync(store.root);
    const leftover = path.join(store.root, storeDir, "tmp", "index-crashed");
    fs.mkdirSync(leftover, { recursive: true });
    const old = (Date.now() - 2 * 60 * 60_000) / 1000;
    fs.utimesSync(leftover, old, old);

    await store.prune(60_000);
    expect(fs.existsSync(leftover)).toBe(false);
    expect((await treeFiles(repo, tree))["a.txt"]).toBe("changed\n");

    await store.prune(-1);
    expect(listFiles(path.join(store.root, storeDir, "objects"))).toEqual([]);
    expect(() => shEnv(repo, {}, "cat-file", "-e", tree)).toThrow();
  });
});

describe("changedPaths", () => {
  it("lists worktree changes, conflicts and untracked files, not staged-only changes", () => {
    const out = [
      "1 .M N... 100644 100644 100644 aaa aaa has space.txt",
      "1 M. N... 100644 100644 100644 aaa bbb staged-only.txt",
      "1 A. N... 000000 100644 100644 000 bbb added-staged.txt",
      "1 .D N... 100644 100644 000000 aaa aaa deleted.txt",
      "2 RM N... 100644 100644 100644 aaa bbb R100 renamed.txt",
      "original.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
      "? untracked dir/file.txt",
      "",
    ].join("\0");
    expect(changedPaths(out)).toEqual([
      "has space.txt",
      "deleted.txt",
      "renamed.txt",
      "conflict.txt",
      "untracked dir/file.txt",
    ]);
  });
});

/** Whether a file with mode 0 is unreadable here: not as root, nor in some sandboxes (Fly Sprites). */
function modesEnforced(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-mode-"));
  const file = path.join(dir, "locked");
  fs.writeFileSync(file, "");
  fs.chmodSync(file, 0);
  try {
    fs.readFileSync(file);
    return false;
  } catch {
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
