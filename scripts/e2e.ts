// `pnpm test:e2e [playwright args]`: Playwright against the built web app. Rebuilds dist/web
// first only when something the build reads changed since the last build (quietly: warnings
// and errors only), then passes every argument to Playwright, so one test on one viewport is
// `pnpm test:e2e -g "the inspector" --project desktop`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const built = path.join(root, "dist/web/index.html");
// src/web imports only itself and src/shared (lint enforces it), and packages.
const inputs = ["src/web", "src/shared", "vite.config.ts", "package.json", "pnpm-lock.yaml"];

/** The newest modification under `file`: a directory's own time counts, for deleted files. */
function newest(file: string): number {
  const stat = fs.statSync(file);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of fs.readdirSync(file)) max = Math.max(max, newest(path.join(file, entry)));
  return max;
}

function run(bin: string, args: string[]): void {
  const result = spawnSync(path.join(root, "node_modules/.bin", bin), args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const builtAt = fs.existsSync(built) ? fs.statSync(built).mtimeMs : 0;
if (inputs.some((input) => newest(path.join(root, input)) > builtAt)) {
  console.log("building the web app (its sources changed)");
  run("vite", ["build", "--logLevel", "warn"]);
}
run("playwright", ["test", ...process.argv.slice(2)]);
