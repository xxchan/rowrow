import { expect, test } from "vitest";
import { cliError, serveFlags } from "./hosts.ts";

test("an upgrade keeps the service's own flags, and no --profile (the app adds its own)", () => {
  expect(
    serveFlags([
      "/Users/me/.rowrow/versions/0.3.0/node",
      "/Users/me/.rowrow/versions/0.3.0/lib/cli/main.js",
      "serve",
      "--profile",
      "work",
      "--host",
      "0.0.0.0",
      "--public-url",
      "https://box.ts.net",
      "--test-runtime",
    ]),
  ).toEqual(["--host", "0.0.0.0", "--public-url", "https://box.ts.net", "--test-runtime"]);
  expect(serveFlags(["/opt/node", "/x/lib/cli/main.js", "serve"])).toEqual([]);
  expect(serveFlags(null)).toEqual([]);
});

test("a failed CLI call says what the CLI said", () => {
  expect(
    cliError({
      code: 1,
      stdout: "",
      stderr:
        '(node:1) ExperimentalWarning: …\nrowrow: a rowrow server for profile "default" is already running (pid 7)\n',
    }),
  ).toBe('a rowrow server for profile "default" is already running (pid 7)');
  expect(cliError({ code: 127, stdout: "", stderr: "sh: 1: rowrow: not found\n" })).toBe(
    "sh: 1: rowrow: not found",
  );
  expect(cliError({ code: 3, stdout: "", stderr: "" })).toBe("exit code 3");
});
