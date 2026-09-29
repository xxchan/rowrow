import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseStatusRecords, sameStamp, stampBudget, stampOf } from "./status.ts";
import { initRepo, isolateGit, removeDir, sh, tempDir, write } from "./testing.ts";

beforeAll(isolateGit);

describe("parseStatusRecords", () => {
  it("reads changed, unmerged and untracked records, paths with spaces included", () => {
    const out = [
      "1 .M N... 100644 100644 100644 aaaa aaaa a file.txt",
      "1 A. N... 000000 100644 100644 0000 bbbb staged.txt",
      "1 .M S.M. 160000 160000 160000 cccc cccc sub",
      "u UU N... 100644 100644 100644 100644 d1 d2 d3 conflict.txt",
      "? new dir/x.txt",
      "",
    ].join("\0");
    const records = parseStatusRecords(out);
    expect([...records.keys()]).toEqual(["a file.txt", "staged.txt", "sub", "conflict.txt", "new dir/x.txt"]);
    expect(records.get("a file.txt")).toMatchObject({ kind: "changed", x: ".", y: "M", submodule: false });
    expect(records.get("staged.txt")).toMatchObject({ kind: "changed", x: "A", y: "." });
    expect(records.get("sub")).toMatchObject({ submodule: true });
    expect(records.get("conflict.txt")).toMatchObject({ kind: "unmerged", x: "U", y: "U" });
    expect(records.get("new dir/x.txt")).toMatchObject({ kind: "untracked", x: "?", y: "?" });
    expect(records.get("a file.txt")?.fields).toBe("1 .M N... 100644 100644 100644 aaaa aaaa");
  });

  it("skips a rename's original path", () => {
    const records = parseStatusRecords("2 R. N... 100644 100644 100644 aa aa R100 new.txt\0old.txt\0");
    expect([...records.keys()]).toEqual(["new.txt"]);
  });
});

describe("stamps", () => {
  let tmp: string;
  let repo: string;
  beforeEach(() => {
    tmp = tempDir();
    repo = initRepo(tmp, "repo", { "a.txt": "one\n" });
  });
  afterEach(() => removeDir(tmp));

  const stamp = async (file = "a.txt"): Promise<string> => {
    const records = parseStatusRecords(
      sh(repo, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"),
    );
    return stampOf(repo, records, [file], stampBudget());
  };

  it("stays the same while nothing changes", async () => {
    write(repo, "a.txt", "two\n");
    expect(await stamp()).toBe(await stamp());
  });

  it("changes with the content, even at the same size and modification time", async () => {
    write(repo, "a.txt", "two\n");
    const before = await stamp();
    const { mtime } = fs.statSync(path.join(repo, "a.txt"));
    write(repo, "a.txt", "owt\n");
    fs.utimesSync(path.join(repo, "a.txt"), mtime, mtime);
    expect(sameStamp(before, await stamp())).toBe(false);
  });

  it("changes when the file is staged, though the file itself didn't", async () => {
    write(repo, "a.txt", "two\n");
    const before = await stamp();
    sh(repo, "add", "a.txt");
    expect(sameStamp(before, await stamp())).toBe(false);
  });

  it("covers files too big to hash by their metadata", async () => {
    write(repo, "big.bin", Buffer.alloc(9 * 1024 * 1024, 1));
    const before = await stamp("big.bin");
    expect(before.endsWith(".-")).toBe(true);
    expect(sameStamp(before, await stamp("big.bin"))).toBe(true);
    fs.appendFileSync(path.join(repo, "big.bin"), "x");
    expect(sameStamp(before, await stamp("big.bin"))).toBe(false);
  });

  it("compares content only when both sides hashed it", () => {
    expect(sameStamp("aaa.111", "aaa.111")).toBe(true);
    expect(sameStamp("aaa.111", "aaa.222")).toBe(false);
    expect(sameStamp("aaa.-", "aaa.222")).toBe(true);
    expect(sameStamp("aaa.111", "bbb.111")).toBe(false);
    expect(sameStamp("", "aaa.111")).toBe(false);
    expect(sameStamp("garbage", "aaa.111")).toBe(false);
  });
});
