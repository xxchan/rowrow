import { describe, expect, it } from "vitest";
import { closeTab, keepTab, NO_TABS, openTab, parseTabs, pruneTabs, type FileTabs } from "./file-tabs.ts";

describe("file tabs", () => {
  it("reuses the temporary tab until it's kept", () => {
    let tabs = openTab(NO_TABS, "a.ts");
    expect(tabs).toEqual({ paths: ["a.ts"], active: "a.ts", preview: "a.ts" });
    tabs = openTab(tabs, "b.ts");
    expect(tabs).toEqual({ paths: ["b.ts"], active: "b.ts", preview: "b.ts" });
    tabs = keepTab(tabs, "b.ts");
    expect(tabs).toEqual({ paths: ["b.ts"], active: "b.ts", preview: null });
    tabs = openTab(tabs, "c.ts");
    tabs = openTab(tabs, "d.ts");
    expect(tabs).toEqual({ paths: ["b.ts", "d.ts"], active: "d.ts", preview: "d.ts" });
  });

  it("shows an open file's own tab, kept or not, without moving it", () => {
    const tabs: FileTabs = { paths: ["a.ts", "b.ts"], active: "b.ts", preview: "b.ts" };
    expect(openTab(tabs, "a.ts")).toEqual({ ...tabs, active: "a.ts" });
    expect(openTab(tabs, "b.ts")).toBe(tabs);
    // Keeping another tab than the temporary one changes nothing.
    expect(keepTab(tabs, "a.ts")).toBe(tabs);
  });

  it("closes a tab: the next one shows, or the one before at the end", () => {
    const tabs: FileTabs = { paths: ["a", "b", "c"], active: "b", preview: "c" };
    expect(closeTab(tabs, "b")).toEqual({ paths: ["a", "c"], active: "c", preview: "c" });
    expect(closeTab({ ...tabs, active: "c" }, "c")).toEqual({
      paths: ["a", "b"],
      active: "b",
      preview: null,
    });
    expect(closeTab(tabs, "a")).toEqual({ paths: ["b", "c"], active: "b", preview: "c" });
    expect(closeTab({ paths: ["a"], active: "a", preview: null }, "a")).toEqual(NO_TABS);
    expect(closeTab(tabs, "x")).toBe(tabs);
  });

  it("drops the tabs of files that are gone", () => {
    const tabs: FileTabs = { paths: ["a", "b", "c", "d"], active: "b", preview: "c" };
    const exists = (path: string): boolean => path === "a" || path === "d";
    expect(pruneTabs(tabs, exists)).toEqual({ paths: ["a", "d"], active: "d", preview: null });
    expect(pruneTabs(tabs, () => true)).toBe(tabs);
  });

  it("reads back what it stored, and nothing from junk", () => {
    const tabs: FileTabs = { paths: ["a", "b"], active: "b", preview: "b" };
    expect(parseTabs(JSON.stringify(tabs))).toEqual(tabs);
    expect(parseTabs(JSON.stringify({ paths: ["a", "a", "", 3], active: "gone", preview: "x" }))).toEqual({
      paths: ["a"],
      active: "a",
      preview: null,
    });
    for (const junk of [null, "", "{", "[]", '{"paths":"a"}']) expect(parseTabs(junk)).toEqual(NO_TABS);
  });
});
