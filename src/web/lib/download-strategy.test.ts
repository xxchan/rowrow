import { describe, expect, it } from "vitest";
import { chooseStrategy, downloadName, downloadUrl } from "./download-strategy.ts";

const env = { narrow: true, ios: false, standalone: false, canShareFiles: false };

describe("chooseStrategy", () => {
  it("saves straight to disk in the desktop layout, installed web apps and iPads included", () => {
    expect(chooseStrategy({ ...env, narrow: false })).toBe("save");
    expect(chooseStrategy({ narrow: false, ios: true, standalone: true, canShareFiles: true })).toBe("save");
  });

  it("shares on an iPhone, and opens a tab where iOS can't share or a home-screen app would be trapped", () => {
    expect(chooseStrategy({ ...env, ios: true, canShareFiles: true })).toBe("share");
    expect(chooseStrategy({ ...env, ios: true })).toBe("new-tab");
    expect(chooseStrategy({ ...env, standalone: true })).toBe("new-tab");
    // Android's Chrome downloads, even though it can share files.
    expect(chooseStrategy({ ...env, canShareFiles: true })).toBe("save");
  });
});

describe("download names and URLs", () => {
  it("names a file after itself and a folder as its archive", () => {
    expect(downloadName("dist/app.bin", "file")).toBe("app.bin");
    expect(downloadName("src/web", "directory")).toBe("web.tar.gz");
    expect(downloadName("README.md", "file")).toBe("README.md");
  });

  it("puts the workspace and the path in the query", () => {
    expect(downloadUrl("ws_1", "a b/c&d.txt")).toBe(
      "/api/files/download?workspaceId=ws_1&path=a+b%2Fc%26d.txt",
    );
  });
});
