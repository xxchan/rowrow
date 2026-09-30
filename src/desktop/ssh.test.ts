import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  backgroundScript,
  cliScript,
  isDestination,
  parseProbe,
  placeBundleScript,
  PROBE,
  scriptArgs,
  shQuote,
  targetOf,
  tunnelArgs,
  untarArgs,
} from "./ssh.ts";

describe("ssh arguments", () => {
  it("takes host names from ~/.ssh/config and user@host, and nothing ssh would read as an option", () => {
    for (const ok of ["devbox", "me@devbox.lan", "build-01", "u@10.0.0.2"])
      expect(isDestination(ok)).toBe(true);
    for (const bad of ["-oProxyCommand=touch /tmp/x", "devbox;rm", "a b", "", "../x", "host:22"])
      expect(isDestination(bad)).toBe(false);
  });

  it("never prompts, and ends options before the destination", () => {
    const args = scriptArgs("devbox");
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(-4)).toEqual(["--", "devbox", "sh", "-s"]);
    expect(tunnelArgs("devbox", 49152, 7373)).toEqual(
      expect.arrayContaining(["-N", "-L", "127.0.0.1:49152:127.0.0.1:7373", "ExitOnForwardFailure=yes"]),
    );
    expect(untarArgs("devbox", "/home/me/.rowrow/versions/.upload.a1B2").slice(-6)).toEqual([
      "devbox",
      "tar",
      "-xzf",
      "-",
      "-C",
      "/home/me/.rowrow/versions/.upload.a1B2",
    ]);
    expect(() => untarArgs("devbox", "/tmp/x; rm -rf ~")).toThrow(/unsafe/);
  });
});

describe("targetOf", () => {
  it("picks the bundle for a host's uname, if there is one", () => {
    expect(targetOf("Linux", "x86_64", null)).toBe("linux-x64");
    expect(targetOf("Linux", "aarch64", null)).toBe("linux-arm64");
    expect(targetOf("Darwin", "arm64", null)).toBe("darwin-arm64");
    expect(targetOf("Darwin", "x86_64", null)).toBeNull();
    expect(targetOf("Linux", "x86_64", "musl")).toBeNull();
    expect(targetOf("FreeBSD", "amd64", null)).toBeNull();
  });
});

describe("the remote scripts, run by this machine's sh", () => {
  const sh = (script: string, env: NodeJS.ProcessEnv): string =>
    execFileSync("sh", ["-s"], { input: script, encoding: "utf8", env: { ...process.env, ...env } });

  it("probe what's installed, place an upload, and run its CLI with awkward arguments", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-ssh-"));
    const rowrowHome = path.join(home, ".rowrow");
    expect(parseProbe(sh(PROBE, { HOME: home, ROWROW_HOME: "" }))).toMatchObject({
      os: os.platform() === "darwin" ? "Darwin" : "Linux",
      home: rowrowHome,
      versions: [],
    });

    // An upload: one directory with a bin/rowrow that echoes its arguments.
    const tmp = path.join(rowrowHome, "versions", ".upload.test");
    const bundle = path.join(tmp, "rowrow-server-9.9.9-test");
    fs.mkdirSync(path.join(bundle, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(bundle, "bin", "rowrow"),
      `#!/bin/sh\nif [ "$1" = version ]; then echo '{"version":"9.9.9"}'; else for a in "$@"; do echo "[$a]"; done; fi\n`,
      { mode: 0o755 },
    );
    expect(sh(placeBundleScript(tmp, "9.9.9"), { HOME: home, ROWROW_HOME: rowrowHome })).toContain('"9.9.9"');
    expect(fs.existsSync(tmp)).toBe(false);
    expect(parseProbe(sh(PROBE, { HOME: home, ROWROW_HOME: rowrowHome })).versions).toEqual(["9.9.9"]);

    const awkward = `it's "quoted" $HOME \`x\``;
    expect(sh(cliScript("9.9.9", ["pair", awkward, "--json"]), { HOME: home, ROWROW_HOME: "" })).toBe(
      `[pair]\n[${awkward}]\n[--json]\n`,
    );
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    expect(() => cliScript("1.0; rm -rf ~", [])).toThrow(/not a version/);
    expect(() => backgroundScript("1.0.0", "../x", [])).toThrow(/not a profile/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
