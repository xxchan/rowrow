import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { installKind, installOfCommand } from "./install.ts";

const home = "/Users/me/.rowrow";

test("where a package lives says how it was installed", () => {
  expect(installKind("/Users/me/.rowrow/versions/0.3.0", home)).toBe("bundle");
  expect(installKind("/usr/local/lib/node_modules/rowrow", home)).toBe("npm");
  expect(installKind("/Users/me/Library/pnpm/global/5/node_modules/rowrow", home)).toBe("pnpm");
  expect(installKind("/Users/me/.npm/_npx/abc123/node_modules/rowrow", home)).toBe("npx");
  // Only a direct child of versions/ is a bundle.
  expect(installKind("/Users/me/.rowrow/versions/0.3.0/node_modules/rowrow", home)).toBe("npm");
  expect(installKind(path.resolve(import.meta.dirname, "../.."), home)).toBe("checkout");
});

test("a service's command says whose rowrow it runs, and which version", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-install-")));
  const bundle = path.join(tmp, "versions", "0.3.0");
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ name: "rowrow", version: "0.3.0" }));
  expect(
    installOfCommand([path.join(bundle, "node"), path.join(bundle, "lib/cli/main.js"), "serve"], tmp),
  ).toEqual({ kind: "bundle", root: bundle, version: "0.3.0" });
  const checkout = path.resolve(import.meta.dirname, "../..");
  expect(installOfCommand(["/opt/node", path.join(checkout, "src/cli/main.ts"), "serve"], tmp)).toMatchObject(
    {
      kind: "checkout",
      root: checkout,
    },
  );
  expect(installOfCommand(["/opt/node", "/somewhere/else.js"], tmp)).toBeNull();
  expect(installOfCommand([], tmp)).toBeNull();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the agents' launcher runs this server's own CLI", async () => {
  const { prependPath, writeCliLauncher } = await import("./cli-launcher.ts");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-it's bin-"));
  const main = path.resolve(import.meta.dirname, "../cli/main.ts");
  writeCliLauncher(dir, process.execPath, main);
  const out = execFileSync(path.join(dir, "rowrow"), ["version", "--json"], { encoding: "utf8" });
  expect(JSON.parse(out)).toMatchObject({ install: { kind: "checkout" } });
  expect(prependPath("/a/bin", "/usr/bin:/a/bin:/bin")).toBe("/a/bin:/usr/bin:/bin");
  expect(prependPath("/a/bin", undefined)).toBe("/a/bin");
  fs.rmSync(dir, { recursive: true, force: true });
});
