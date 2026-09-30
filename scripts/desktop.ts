// `pnpm desktop`: the Mac app from this checkout (docs/desktop.md, "Development"). Builds it,
// then runs it on a throwaway home in .dev/desktop, with this checkout's server as the app's
// own child process (no launchd), the scripted runtime (no tokens), and its own app data, so
// your rowrow, your launchd and the installed app are untouched. Any ROWROW_DESKTOP_* you set
// wins (ROWROW_DESKTOP_SUPERVISOR=service tries launchd, with ROWROW_DESKTOP_PROFILE and a
// ROWROW_DESKTOP_PORT of its own).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildDesktop } from "./build-desktop.ts";
import { electronBinary } from "./electron.ts";

const root = path.resolve(import.meta.dirname, "..");
const dev = path.join(root, ".dev", "desktop");

if (import.meta.main) {
  if (!fs.existsSync(path.join(root, "dist", "web", "index.html"))) {
    console.log("desktop: building the web app the server serves");
    execFileSync("pnpm", ["build:web"], { cwd: root, stdio: "inherit" });
  }
  await buildDesktop();
  const electron = electronBinary();
  fs.mkdirSync(dev, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROWROW_"))),
    ROWROW_HOME: path.join(dev, "home"),
    ROWROW_DESKTOP_USER_DATA: path.join(dev, "app"),
    ROWROW_DESKTOP_SUPERVISOR: "child",
    ROWROW_DESKTOP_SERVER: root,
    ROWROW_DESKTOP_NODE: process.execPath,
    ROWROW_DESKTOP_TEST_RUNTIME: "1",
    ROWROW_DESKTOP_PLAIN_TOKENS: "1",
    ROWROW_DESKTOP_BUNDLES: path.join(root, "dist", "bundles"),
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("ROWROW_DESKTOP_"))),
  };
  const child = spawn(electron, [path.join(root, "dist", "desktop"), ...process.argv.slice(2)], {
    env,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
}
