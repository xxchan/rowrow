import { describe, expect, it } from "vitest";
import { caseSensitive, checkQuery, parseGrep, snippet } from "./search.ts";

describe("parseGrep", () => {
  it("reads path, line and text, whatever the path holds", () => {
    const out = "src/a.ts\x0012\x00const needle = 1;\nweird: name\n.txt\x003\x00a needle\n";
    expect(parseGrep(out, "needle", false, 10)).toEqual({
      hits: [
        { path: "src/a.ts", line: 12, text: "const needle = 1;" },
        { path: "weird: name\n.txt", line: 3, text: "a needle" },
      ],
      more: false,
    });
  });

  it("stops at the limit and drops a record cut short", () => {
    const out = "a\x001\x00x\nb\x002\x00x\nc\x003\x00x\n";
    expect(parseGrep(out, "x", true, 2)).toEqual({
      hits: [
        { path: "a", line: 1, text: "x" },
        { path: "b", line: 2, text: "x" },
      ],
      more: true,
    });
    expect(parseGrep("a\x001\x00x\nb\x002\x00x-without-an-end", "x", true, 10).hits).toHaveLength(1);
  });
});

describe("snippet", () => {
  it("keeps short lines whole and cuts long ones around the match", () => {
    expect(snippet("short line\r", "line", false)).toBe("short line");
    const long = `${"a".repeat(500)}NEEDLE${"b".repeat(500)}`;
    const cut = snippet(long, "needle", false);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toContain("NEEDLE");
    expect(cut.length).toBeLessThanOrEqual(242);
  });
});

describe("queries", () => {
  it("is case-sensitive only with an uppercase letter", () => {
    expect(caseSensitive("needle")).toBe(false);
    expect(caseSensitive("Needle")).toBe(true);
    expect(caseSensitive("ÉCOLE")).toBe(true);
  });

  it("refuses empty, multi-line and huge queries", () => {
    expect(() => checkQuery("   ")).toThrow(/Type something/);
    expect(() => checkQuery("a\nb")).toThrow(/one line/);
    expect(() => checkQuery("x".repeat(201))).toThrow(/at most 200/);
    expect(checkQuery("-e --output=/tmp/x")).toBe("-e --output=/tmp/x");
  });
});
