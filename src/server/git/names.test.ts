import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { randomBranchName, slugify } from "./names.ts";

describe("randomBranchName", () => {
  it("is rowrow/<adjective>-<noun>-<4 hex> and a valid git branch name", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const name = randomBranchName();
      expect(name).toMatch(/^rowrow\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      names.add(name);
    }
    expect(names.size).toBeGreaterThan(45);
    const name = randomBranchName();
    expect(execFileSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8" }).trim()).toBe(
      name,
    );
  });
});

describe("slugify", () => {
  it("lowercases and turns runs of other characters into single dashes", () => {
    expect(slugify("rowrow/brave-river-0a1b")).toBe("rowrow-brave-river-0a1b");
    expect(slugify("Feature/Foo__Bar.baz")).toBe("feature-foo-bar-baz");
    expect(slugify("--x//y--")).toBe("x-y");
    expect(slugify("日本")).toBe("");
  });
});
