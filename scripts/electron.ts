// Where Electron's binary is, for `pnpm desktop` and the desktop tests: node_modules/electron's,
// downloaded the first time it's needed (pnpm doesn't run its install script; see
// pnpm-workspace.yaml).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

export function electronBinary(): string {
  const dir = path.join(root, "node_modules", "electron");
  const recorded = path.join(dir, "path.txt");
  if (!fs.existsSync(recorded)) {
    console.log("electron: downloading Electron (once)");
    execFileSync(process.execPath, [path.join(dir, "install.js")], { stdio: "inherit" });
  }
  return path.join(dir, "dist", fs.readFileSync(recorded, "utf8").trim());
}
