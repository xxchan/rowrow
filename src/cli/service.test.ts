import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { launchdPlist, systemdUnit, type ServiceSpec } from "./service.ts";

// Values a shell, XML and systemd would each mangle if they weren't escaped.
const awkward = `/certs/it's "mine" 100%$HOME & <co>.pem`;
const spec: ServiceSpec = {
  profile: "work",
  argv: [
    "/opt/node",
    "/src/cli/main.ts",
    "serve",
    "--public-url",
    "https://box.ts.net/?a=1&b=2",
    "--tls-cert",
    awkward,
  ],
  env: { PATH: "/usr/bin:/opt/$odd%dir", ROWROW_HOME: "/Users/me/rowrow data" },
  workingDirectory: "/Users/me/my code",
  logFile: "/Users/me/.rowrow/work/service.log",
};

test.runIf(process.platform === "darwin")("launchd reads back exactly the command and environment", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-plist-")), "dev.rowrow.work.plist");
  fs.writeFileSync(file, launchdPlist(spec));
  execFileSync("plutil", ["-lint", file]);
  const extract = (key: string, format: "json" | "raw"): string =>
    execFileSync("plutil", ["-extract", key, format, "-o", "-", file], { encoding: "utf8" });
  expect(extract("Label", "raw").trim()).toBe("dev.rowrow.work");
  expect(JSON.parse(extract("ProgramArguments", "json"))).toEqual(spec.argv);
  expect(JSON.parse(extract("EnvironmentVariables", "json"))).toEqual(spec.env);
  expect(extract("WorkingDirectory", "raw").trim()).toBe(spec.workingDirectory);
  expect(JSON.parse(extract("KeepAlive", "json"))).toEqual({ SuccessfulExit: false });
});

test("the launchd plist escapes XML", () => {
  expect(launchdPlist(spec)).toContain(
    "<string>/certs/it&apos;s &quot;mine&quot; 100%$HOME &amp; &lt;co&gt;.pem</string>",
  );
});

test("the systemd unit quotes each word, and escapes specifiers and variables where they apply", () => {
  const unit = systemdUnit(spec);
  expect(unit).toContain(
    'ExecStart="/opt/node" "/src/cli/main.ts" "serve" "--public-url" "https://box.ts.net/?a=1&b=2" "--tls-cert" "/certs/it\'s \\"mine\\" 100%%$$HOME & <co>.pem"\n',
  );
  // Environment= doesn't expand variables, so `$` stays as it is; specifiers still do.
  expect(unit).toContain('Environment="PATH=/usr/bin:/opt/$odd%%dir"\n');
  expect(unit).toContain('Environment="ROWROW_HOME=/Users/me/rowrow data"\n');
  expect(unit).toContain("WorkingDirectory=/Users/me/my code\n");
  expect(unit).toContain("Restart=on-failure\n");
});
