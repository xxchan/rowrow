import { describe, expect, it } from "vitest";
import type { ServiceStatus } from "../shared/host.ts";
import { parsePairingLink, planHost, portOf, versionsToKeep } from "./plan.ts";

const server = { url: "http://127.0.0.1:7373", publicUrl: "http://127.0.0.1:7373", pid: 42, startedAt: 1 };
const status = (over: Partial<ServiceStatus>): ServiceStatus => ({
  profile: "default",
  manager: "launchd",
  installed: false,
  file: "/Users/me/Library/LaunchAgents/dev.rowrow.default.plist",
  state: null,
  command: null,
  install: null,
  server: null,
  ...over,
});
const bundle = (version: string): ServiceStatus["install"] => ({
  kind: "bundle",
  root: `/Users/me/.rowrow/versions/${version}`,
  version,
});

describe("planHost: who runs a host's server, and what the app may do", () => {
  it("upgrades only its own bundles, and never downgrades", () => {
    expect(
      planHost(
        status({ installed: true, install: bundle("0.3.0"), server: { ...server, version: "0.3.0" } }),
        "0.3.1",
      ),
    ).toEqual({ owner: "app", runningVersion: "0.3.0", upgrade: true, running: true });
    expect(planHost(status({ installed: true, install: bundle("0.3.1") }), "0.3.1")).toMatchObject({
      owner: "app",
      upgrade: false,
      running: false,
    });
    expect(planHost(status({ installed: true, install: bundle("0.4.0") }), "0.3.1").upgrade).toBe(false);
    expect(planHost(status({ installed: true, install: bundle("0.3.1-rc.2") }), "0.3.1").upgrade).toBe(true);
  });

  it("leaves a service from npm, pnpm or a checkout to you", () => {
    const npm = status({
      installed: true,
      install: { kind: "npm", root: "/usr/local/lib/node_modules/rowrow", version: "0.2.5" },
      server: { ...server, version: "0.2.5" },
    });
    expect(planHost(npm, "0.3.1")).toEqual({
      owner: "cli",
      runningVersion: "0.2.5",
      upgrade: false,
      running: true,
    });
    // A definition rowrow can't read is still someone's service.
    expect(planHost(status({ installed: true, command: ["/bin/sh", "-c", "…"] }), "0.3.1").owner).toBe("cli");
  });

  it("tells a server in a terminal, one the app started without a service, and nothing", () => {
    expect(planHost(status({ server: { ...server, version: "0.2.5" } }), "0.3.1")).toMatchObject({
      owner: "terminal",
      running: true,
    });
    expect(planHost(status({ server: { ...server, version: "0.3.1" } }), "0.3.1", true)).toMatchObject({
      owner: "background",
      upgrade: false,
    });
    expect(planHost(status({ server: { ...server, version: "0.3.0" } }), "0.3.1", true).upgrade).toBe(true);
    // A server in a terminal is yours, whatever its version.
    expect(planHost(status({ server: { ...server, version: "0.3.0" } }), "0.3.1").upgrade).toBe(false);
    expect(planHost(status({}), "0.3.1")).toEqual({
      owner: "none",
      runningVersion: null,
      upgrade: false,
      running: false,
    });
  });
});

describe("versionsToKeep", () => {
  it("keeps the app's, the running one and the one before, and anything that isn't a version", () => {
    const installed = ["0.2.9", "0.3.0", "0.3.1", "0.3.2", "notes"];
    expect([...versionsToKeep(installed, "0.3.2", "0.3.1")].sort()).toEqual([
      "0.3.0",
      "0.3.1",
      "0.3.2",
      "notes",
    ]);
    expect([...versionsToKeep(installed, "0.3.2", null)].sort()).toEqual(["0.3.1", "0.3.2", "notes"]);
    // A newer server than the app's (another Mac upgraded it) stays, and so does the app's own.
    expect([...versionsToKeep(["0.3.0", "0.4.0"], "0.3.0", "0.4.0")].sort()).toEqual(["0.3.0", "0.4.0"]);
  });
});

describe("parsePairingLink", () => {
  it("reads the origin and code from the links rowrow gives out", () => {
    expect(parsePairingLink("  http://127.0.0.1:7373/auth/redeem?code=abc_123 ")).toEqual({
      origin: "http://127.0.0.1:7373",
      code: "abc_123",
    });
    expect(parsePairingLink("https://box.tail.ts.net/auth/redeem?code=xyz")).toEqual({
      origin: "https://box.tail.ts.net",
      code: "xyz",
    });
    expect(
      parsePairingLink(`rowrow://pair?link=${encodeURIComponent("https://box.ts.net/auth/redeem?code=q")}`),
    ).toEqual({ origin: "https://box.ts.net", code: "q" });
  });

  it("refuses what isn't one", () => {
    expect(parsePairingLink("https://box.ts.net/")).toBeNull();
    expect(parsePairingLink("https://box.ts.net/a/ag_1?code=x")).toBeNull();
    expect(parsePairingLink("file:///auth/redeem?code=x")).toBeNull();
    expect(parsePairingLink("devbox")).toBeNull();
  });
});

describe("portOf", () => {
  it("reads a server URL's port", () => {
    expect(portOf("http://127.0.0.1:7373")).toBe(7373);
    expect(portOf("https://box.ts.net")).toBe(443);
    expect(portOf("nonsense")).toBeNull();
  });
});
