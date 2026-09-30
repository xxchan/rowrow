// Server bundles (scripts/build-bundle.ts, D-032): a package whose `os` or `cpu` rules out the
// bundle's platform is removed, and npm's own reading of those rules decides which.
import { expect, test } from "vitest";
import { forOtherPlatform } from "../scripts/build-bundle.ts";

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
