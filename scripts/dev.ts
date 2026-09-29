// `pnpm dev`: a rowrow server under the `dev` profile (with the scripted demo runtime, no
// tokens), and Vite's dev server in front of it with hot reload. Prints a sign-in link for
// the Vite address. Your own `rowrow serve` (profile `default`) is untouched. The kit the iOS
// app runs (dist/kit/kit.js) is rebuilt on every change, so the app picks changes up too.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { profilePaths, rowrowHome } from "../src/server/config.ts";

const root = path.resolve(import.meta.dirname, "..");
const backendPort = Number(process.env["ROWROW_DEV_PORT"] ?? 7374);
const webPort = Number(process.env["ROWROW_WEB_PORT"] ?? 5173);
const webUrl = `http://localhost:${webPort}`;
const children: ChildProcess[] = [];

function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (${code ?? "signal"}); stopping`);
    shutdown();
  });
  children.push(child);
  return child;
}

function shutdown(): void {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start(
  "server",
  process.execPath,
  [
    "--watch-path=src/server",
    "--watch-path=src/shared",
    "src/cli/main.ts",
    "serve",
    "--profile",
    "dev",
    "--port",
    String(backendPort),
    "--public-url",
    webUrl,
    "--test-runtime",
  ],
  {},
);
start("vite", path.join(root, "node_modules/.bin/vite"), [], {
  ROWROW_DEV_BACKEND: `http://127.0.0.1:${backendPort}`,
  ROWROW_WEB_PORT: String(webPort),
});
start(
  "kit",
  path.join(root, "node_modules/.bin/vite"),
  ["build", "--watch", "--config", "vite.kit.config.ts", "--logLevel", "warn"],
  {},
);

// Once the server is up, mint a sign-in link for the Vite address.
const serverFile = profilePaths(rowrowHome(), "dev").serverFile;
const deadline = Date.now() + 20_000;
const timer = setInterval(() => {
  if (Date.now() > deadline) clearInterval(timer);
  if (!fs.existsSync(serverFile)) return;
  clearInterval(timer);
  const pair = spawn(process.execPath, ["src/cli/main.ts", "--profile", "dev", "pair", "dev browser"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  pair.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  pair.on("exit", () =>
    console.log(`\n[dev] open ${webUrl}\n[dev] sign in (once, 10 min): ${out.split("\n")[0] ?? ""}\n`),
  );
}, 300);
