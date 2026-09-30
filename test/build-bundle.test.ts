// Server bundles (scripts/build-bundle.ts, D-032) leave out what nothing runs: maps, type
// declarations and docs, and packages whose `os` or `cpu` rules out the bundle's platform, read
// the way npm reads them.
import { expect, test } from "vitest";
import { forOtherPlatform, prunable } from "../scripts/build-bundle.ts";

test("maps, type declarations and docs go; code, data and licenses stay", () => {
  for (const name of [
    "index.js.map",
    "index.mjs.map",
    "index.d.ts",
    "index.d.mts",
    "index.d.ts.map",
    "index.d.cts.map",
    "README.md",
    "tsconfig.tsbuildinfo",
  ])
    expect(prunable(name), name).toBe(true);
  for (const name of [
    "index.js",
    "index.mjs",
    "cli.cjs",
    "package.json",
    "LICENSE.md",
    "data.json",
    "map.js",
  ])
    expect(prunable(name), name).toBe(false);
});

test("a package is for another platform when its os or cpu rules out the target, as npm reads them", () => {
  const onMac = (manifest: Parameters<typeof forOtherPlatform>[0]): boolean =>
    forOtherPlatform(manifest, "darwin", "arm64");
  expect(onMac({})).toBe(false);
  expect(onMac({ os: ["darwin"], cpu: ["arm64"] })).toBe(false); // @esbuild/darwin-arm64
  expect(onMac({ os: ["linux"], cpu: ["x64"] })).toBe(true); // @esbuild/linux-x64
  expect(onMac({ os: ["darwin"], cpu: ["x64"] })).toBe(true);
  expect(onMac({ os: "darwin" })).toBe(false);
  expect(onMac({ cpu: ["any"] })).toBe(false);
  expect(onMac({ os: ["!win32"] })).toBe(false);
  expect(onMac({ os: ["!darwin"] })).toBe(true);
  expect(onMac({ os: ["darwin", "!darwin"] })).toBe(true);
  expect(forOtherPlatform({ os: ["darwin", "linux"], cpu: ["x64", "arm64"] }, "linux", "x64")).toBe(false);
});
