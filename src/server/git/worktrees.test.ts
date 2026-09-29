import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitAll, initRepo, isolateGit, removeDir, sh, tempDir, write } from "./testing.ts";
import {
  DirtyWorktreeError,
  createWorktree,
  defaultBranch,
  listWorktrees,
  parseLsRemote,
  removeWorktree,
} from "./worktrees.ts";

beforeAll(isolateGit);

let tmp: string;
let origin: string;
let seed: string;
let clone: string;
let root: string;

/** A bare origin whose default branch is `trunk`, a seed repo that pushes to it, and a clone. */
beforeEach(() => {
  tmp = tempDir();
  origin = path.join(tmp, "origin.git");
  sh(tmp, "init", "-q", "--bare", "-b", "trunk", origin);
  seed = initRepo(tmp, "seed", { "README.md": "v1\n" }, "trunk");
  sh(seed, "remote", "add", "origin", origin);
  sh(seed, "push", "-q", "origin", "trunk");
  sh(tmp, "clone", "-q", origin, "app");
  clone = path.join(tmp, "app");
  root = path.join(tmp, "worktrees");
});

afterEach(() => removeDir(tmp));

/** Advance origin's trunk by one commit the clone hasn't fetched. */
function advanceOrigin(): string {
  write(seed, "README.md", "v2\n");
  const commit = commitAll(seed, "v2");
  sh(seed, "push", "-q", "origin", "trunk");
  return commit;
}

describe("defaultBranch", () => {
  it("asks origin, fetches the exact commit and leaves remote-tracking refs alone", async () => {
    const stale = sh(clone, "rev-parse", "refs/remotes/origin/trunk").trim();
    const fresh = advanceOrigin();
    const result = await defaultBranch(clone);
    expect(result).toEqual({ name: "trunk", commit: fresh });
    expect(sh(clone, "cat-file", "-t", fresh).trim()).toBe("commit");
    expect(sh(clone, "rev-parse", "refs/remotes/origin/trunk").trim()).toBe(stale);
    expect(fs.existsSync(path.join(clone, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it("follows origin's HEAD to a non-main branch even when the local origin/HEAD says otherwise", async () => {
    sh(seed, "checkout", "-q", "-b", "develop");
    write(seed, "dev.txt", "dev\n");
    const dev = commitAll(seed, "dev");
    sh(seed, "push", "-q", "origin", "develop");
    sh(origin, "symbolic-ref", "HEAD", "refs/heads/develop");
    expect(sh(clone, "symbolic-ref", "refs/remotes/origin/HEAD").trim()).toBe("refs/remotes/origin/trunk");
    expect(await defaultBranch(clone)).toEqual({ name: "develop", commit: dev });
  });

  it("is null without an origin remote or when origin is empty", async () => {
    const lonely = initRepo(tmp, "lonely");
    expect(await defaultBranch(lonely)).toBeNull();
    sh(tmp, "init", "-q", "--bare", "empty.git");
    sh(lonely, "remote", "add", "origin", path.join(tmp, "empty.git"));
    expect(await defaultBranch(lonely)).toBeNull();
  });

  it("throws when origin can't be reached", async () => {
    const lonely = initRepo(tmp, "lonely");
    sh(lonely, "remote", "add", "origin", path.join(tmp, "missing.git"));
    await expect(defaultBranch(lonely)).rejects.toThrow(/cannot ask origin/);
  });

  it("parses ls-remote output", () => {
    const sha = "a".repeat(40);
    expect(parseLsRemote(`ref: refs/heads/dev\tHEAD\n${sha}\tHEAD\n`)).toEqual({ name: "dev", commit: sha });
    expect(parseLsRemote("")).toEqual({ name: null, commit: null });
  });
});

describe("createWorktree", () => {
  it("branches from origin's freshly fetched default branch", async () => {
    const fresh = advanceOrigin();
    const created = await createWorktree({ repoDir: clone, root });
    expect(created.branch).toMatch(/^rowrow\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    expect(created.path).toBe(path.join(root, "app", created.branch.replace("/", "-")));
    expect(created.base).toBe(fresh);
    expect(created.baseLabel).toBe(`origin/trunk @ ${fresh.slice(0, 7)}`);
    expect(sh(created.path, "rev-parse", "HEAD").trim()).toBe(fresh);
    expect(sh(created.path, "symbolic-ref", "--short", "HEAD").trim()).toBe(created.branch);
    // Based on a commit id, so the new branch doesn't track (or push to) trunk.
    expect(() => sh(created.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
    expect(fs.readFileSync(path.join(created.path, "README.md"), "utf8")).toBe("v2\n");
  });

  it("uses an explicit base", async () => {
    const first = sh(clone, "rev-parse", "HEAD").trim();
    write(clone, "b.txt", "b\n");
    commitAll(clone, "second");
    const created = await createWorktree({ repoDir: clone, root, branch: "Feature/X", base: "HEAD~1" });
    expect(created.path).toBe(path.join(root, "app", "feature-x"));
    expect(created.base).toBe(first);
    expect(created.baseLabel).toBe(`HEAD~1 @ ${first.slice(0, 7)}`);
    expect(sh(created.path, "symbolic-ref", "--short", "HEAD").trim()).toBe("Feature/X");
  });

  it("falls back to local HEAD without an origin", async () => {
    const lonely = initRepo(tmp, "lonely");
    const head = sh(lonely, "rev-parse", "HEAD").trim();
    const created = await createWorktree({ repoDir: lonely, root, branch: "work" });
    expect(created.base).toBe(head);
    expect(created.baseLabel).toBe(`main @ ${head.slice(0, 7)} (local)`);
  });

  it("checks out an existing branch as it is", async () => {
    write(clone, "c.txt", "c\n");
    const tip = commitAll(clone, "feature work");
    sh(clone, "branch", "feature", tip);
    sh(clone, "reset", "-q", "--hard", "HEAD~1");
    const created = await createWorktree({ repoDir: clone, root, branch: "feature" });
    expect(created.base).toBe(tip);
    expect(sh(created.path, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(sh(created.path, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature");
    await expect(
      createWorktree({ repoDir: clone, root: path.join(tmp, "other"), branch: "feature", base: "HEAD" }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses an existing path and invalid branch names", async () => {
    fs.mkdirSync(path.join(root, "app", "taken"), { recursive: true });
    await expect(createWorktree({ repoDir: clone, root, branch: "taken" })).rejects.toThrow(/already exists/);
    await expect(createWorktree({ repoDir: clone, root, branch: "bad..name" })).rejects.toThrow(
      /not a valid branch name/,
    );
    await expect(createWorktree({ repoDir: clone, root, branch: "-f" })).rejects.toThrow(
      /not a valid branch name/,
    );
    await expect(createWorktree({ repoDir: clone, root, branch: "@{-1}" })).rejects.toThrow(
      /not a valid branch name/,
    );
    await expect(createWorktree({ repoDir: clone, root, branch: "ok", base: "--help" })).rejects.toThrow(
      /not a valid base/,
    );
  });
});

describe("removeWorktree and listWorktrees", () => {
  it("removes a clean worktree and keeps its branch", async () => {
    const created = await createWorktree({ repoDir: clone, root, branch: "done" });
    expect((await listWorktrees(clone)).map((w) => w.branch)).toEqual(["trunk", "done"]);
    await removeWorktree({ path: created.path });
    expect(fs.existsSync(created.path)).toBe(false);
    expect(sh(clone, "rev-parse", "--verify", "refs/heads/done").trim()).toBe(created.base);
    expect((await listWorktrees(clone)).map((w) => w.path)).toEqual([clone]);
  });

  it("refuses a dirty worktree unless forced", async () => {
    const created = await createWorktree({ repoDir: clone, root, branch: "dirty" });
    write(created.path, "scratch.txt", "unsaved\n");
    const error: unknown = await removeWorktree({ path: created.path }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DirtyWorktreeError);
    expect((error as Error).message).toMatch(/uncommitted changes.*force/);
    expect(fs.existsSync(path.join(created.path, "scratch.txt"))).toBe(true);
    await removeWorktree({ path: created.path, force: true });
    expect(fs.existsSync(created.path)).toBe(false);
    expect(sh(clone, "rev-parse", "--verify", "refs/heads/dirty").trim()).toBe(created.base);
  });

  it("refuses the main checkout", async () => {
    await expect(removeWorktree({ path: clone })).rejects.toThrow(/main checkout/);
    await expect(removeWorktree({ path: clone, force: true })).rejects.toThrow(/main checkout/);
  });

  it("lists branches and heads, skipping prunable entries", async () => {
    const kept = await createWorktree({ repoDir: clone, root, branch: "kept" });
    const gone = await createWorktree({ repoDir: clone, root, branch: "gone" });
    sh(kept.path, "checkout", "-q", "--detach");
    fs.rmSync(gone.path, { recursive: true, force: true });
    const head = sh(clone, "rev-parse", "HEAD").trim();
    expect(await listWorktrees(clone)).toEqual([
      { path: clone, branch: "trunk", head },
      { path: kept.path, branch: null, head: kept.base },
    ]);
  });
});
