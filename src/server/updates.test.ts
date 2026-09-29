import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, detectInstall, newerVersion, npmRegistry, updateCommand } from "./updates.ts";

describe("compareVersions", () => {
  it("orders by semver precedence", () => {
    const sorted = [
      "1.0.0",
      "0.2.10",
      "0.2.3",
      "0.3.0-rc.1",
      "0.3.0",
      "0.3.0-rc.10",
      "0.3.0-beta",
      "0.2.3-rc.1",
    ];
    expect(sorted.sort(compareVersions)).toEqual([
      "0.2.3-rc.1",
      "0.2.3",
      "0.2.10",
      "0.3.0-beta",
      "0.3.0-rc.1",
      "0.3.0-rc.10",
      "0.3.0",
      "1.0.0",
    ]);
  });
});

describe("newerVersion", () => {
  it("offers latest when it is newer, and next only to someone on a prerelease", () => {
    expect(newerVersion("0.2.3", { latest: "0.2.4", next: "0.3.0-rc.1" })).toBe("0.2.4");
    expect(newerVersion("0.2.4", { latest: "0.2.4", next: "0.3.0-rc.1" })).toBeNull();
    expect(newerVersion("0.3.0-rc.1", { latest: "0.2.4", next: "0.3.0-rc.2" })).toBe("0.3.0-rc.2");
    expect(newerVersion("0.3.0-rc.2", { latest: "0.3.0", next: "0.3.0-rc.2" })).toBe("0.3.0");
    expect(newerVersion("0.3.0", { latest: "0.2.9" })).toBeNull();
    expect(newerVersion("0.2.3", { latest: "garbage" })).toBeNull();
  });
});

describe("npmRegistry", () => {
  it("takes npm's environment, then ~/.npmrc, then npmjs.org", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-npmrc-"));
    expect(npmRegistry({}, home)).toBe("https://registry.npmjs.org");
    fs.writeFileSync(path.join(home, ".npmrc"), "fund=false\nregistry = https://registry.npmmirror.com/\n");
    expect(npmRegistry({}, home)).toBe("https://registry.npmmirror.com");
    expect(npmRegistry({ npm_config_registry: "http://localhost:4873/" }, home)).toBe(
      "http://localhost:4873",
    );
  });
});

describe("updateCommand", () => {
  it("fits how rowrow was installed and started", () => {
    const npm = detectInstall("/usr/local/lib/node_modules/rowrow", "default", {});
    expect(updateCommand(npm, "0.2.4")).toEqual({
      command: "npm install -g rowrow@0.2.4",
      after: "Then restart `rowrow serve`.",
    });
    const service = detectInstall("/usr/local/lib/node_modules/rowrow", "work", { ROWROW_SERVICE: "1" });
    expect(updateCommand(service, "0.2.4")).toEqual({
      command: "npm install -g rowrow@0.2.4 && rowrow service restart --profile work",
      after: null,
    });
    const launchd = detectInstall("/opt/homebrew/lib/node_modules/rowrow", "default", {
      XPC_SERVICE_NAME: "dev.rowrow.default",
    });
    expect(launchd.service).toBe(true);
    const pnpm = detectInstall("/Users/me/Library/pnpm/global/5/node_modules/rowrow", "default", {});
    expect(updateCommand(pnpm, "0.2.4").command).toBe("pnpm add -g rowrow@0.2.4");
    const npx = detectInstall("/Users/me/.npm/_npx/abc123/node_modules/rowrow", "default", {});
    expect(updateCommand(npx, "0.2.4").command).toBe("npx rowrow@0.2.4 serve");
  });
});
