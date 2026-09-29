// `pnpm test:package [rowrow-x.y.z.tgz]`: the npm package, installed and run the way a user
// would (docs/decisions.md, D-018). Packs this checkout (prepack builds dist/web and lib/)
// unless given a tarball, checks what's inside, installs it with npm into a throwaway prefix,
// and drives the installed `rowrow`: --help, serve (scripted runtime, throwaway home), status,
// /healthz, the web app at /, a workspace and an agent that answers, then a clean stop.
// Needs Node 24 with npm, git, and the network (npm installs the package's dependencies).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
};
const PROFILE = "pkgtest";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-package-")));
const prefix = path.join(tmp, "prefix");
const home = path.join(tmp, "home");
const bin = path.join(prefix, "bin", "rowrow");
const env: NodeJS.ProcessEnv = {
  // Never the user's rowrow: no inherited ROWROW_URL/TOKEN/PROFILE, and a throwaway home.
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROWROW_"))),
  ROWROW_HOME: home,
  // The installed bin's `#!/usr/bin/env node` finds the Node running this script.
  PATH: [path.dirname(process.execPath), path.dirname(bin), process.env["PATH"]].join(path.delimiter),
  // Git, here and in the server's turn snapshots, ignores this machine's config.
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "rowrow package test",
  GIT_AUTHOR_EMAIL: "test@rowrow.invalid",
  GIT_COMMITTER_NAME: "rowrow package test",
  GIT_COMMITTER_EMAIL: "test@rowrow.invalid",
};

function step(what: string): void {
  console.log(`\n▸ ${what}`);
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`package test failed: ${what}`);
}

/** Runs the installed CLI and prints the start of what it said. */
function rowrow(...args: string[]): string {
  console.log(`$ rowrow ${args.join(" ")}`);
  const out = execFileSync(bin, args, { env, encoding: "utf8", timeout: 90_000 });
  const lines = out.trimEnd().split("\n");
  console.log(lines.slice(0, 6).join("\n"));
  if (lines.length > 6) console.log(`… and ${lines.length - 6} more`);
  return out;
}

/** In npm's units, to compare with what `npm pack` says. */
function kb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function tarball(): string {
  const given = process.argv[2];
  if (given !== undefined) return path.resolve(given);
  step("npm pack (prepack builds dist/web and lib/)");
  execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: root, stdio: "inherit" });
  return path.join(tmp, `rowrow-${version}.tgz`);
}

function inspect(file: string): void {
  step(`what ${path.basename(file)} contains`);
  const unpacked = path.join(tmp, "unpacked");
  fs.mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", file, "-C", unpacked]);
  const pkg = path.join(unpacked, "package");
  const files = fs
    .readdirSync(pkg, { recursive: true, encoding: "utf8" })
    .filter((name) => fs.statSync(path.join(pkg, name)).isFile())
    .map((name) => name.split(path.sep).join("/"))
    .sort();
  const groups = new Map<string, { files: number; bytes: number }>();
  for (const name of files) {
    const group = name.startsWith("dist/web/")
      ? "dist/web/"
      : name.includes("/")
        ? `${name.split("/")[0]}/`
        : name;
    const sum = groups.get(group) ?? { files: 0, bytes: 0 };
    groups.set(group, { files: sum.files + 1, bytes: sum.bytes + fs.statSync(path.join(pkg, name)).size });
  }
  console.log(`${path.basename(file)}: ${kb(fs.statSync(file).size)} packed, ${files.length} files`);
  for (const [group, sum] of groups)
    console.log(`  ${group.padEnd(14)} ${String(sum.files).padStart(3)} files  ${kb(sum.bytes)}`);

  for (const needed of [
    "package.json",
    "README.md",
    "LICENSE",
    "lib/cli/main.js",
    "lib/server/main.js",
    "dist/web/index.html",
  ])
    check(files.includes(needed), `${needed} is missing`);
  const stray = files.filter(
    (name) =>
      /^(src|test|scripts|docs|node_modules)\//.test(name) ||
      name.includes("/node_modules/") ||
      /\.(ts|map)$/.test(name) ||
      /\.test\./.test(name),
  );
  check(stray.length === 0, `the package shouldn't contain ${stray.join(", ")}`);
}

async function main(): Promise<void> {
  const file = tarball();
  inspect(file);

  step(`npm install --global ${path.basename(file)} (into a throwaway prefix)`);
  execFileSync("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", file], {
    env,
    stdio: "inherit",
  });

  step("the installed CLI");
  check(rowrow("--help").includes("rowrow serve"), "--help doesn't describe serve");

  step(`rowrow serve --profile ${PROFILE} --port 0 --test-runtime`);
  const server = spawn(bin, ["serve", "--profile", PROFILE, "--port", "0", "--test-runtime"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  server.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => server.once("exit", resolve));
  try {
    const serverFile = path.join(home, PROFILE, "server.json");
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(serverFile)) {
      check(server.exitCode === null, `rowrow serve exited early:\n${output}`);
      check(Date.now() < deadline, `rowrow serve didn't start within 30 s:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { url } = JSON.parse(fs.readFileSync(serverFile, "utf8")) as { url: string };
    console.log(`listening on ${url}`);

    step("status, health and the web app");
    check(rowrow("status", "--profile", PROFILE).includes(`rowrow ${version} (${PROFILE})`), "status");
    const health = (await (await fetch(`${url}/healthz`)).json()) as { ok: boolean; version: string };
    console.log(`GET /healthz → ${JSON.stringify(health)}`);
    check(health.ok && health.version === version, "/healthz");
    const page = await fetch(`${url}/`);
    const html = await page.text();
    const script = /<script type="module"[^>]* src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    check(page.ok && script !== undefined, `/ isn't the built web app:\n${html}`);
    const asset = await fetch(`${url}${script}`);
    console.log(`GET / → ${page.status} ${page.headers.get("content-type")}, ${script} → ${asset.status}`);
    check(asset.ok && (asset.headers.get("content-type") ?? "").includes("javascript"), `${script}`);

    step("a workspace and an agent (scripted runtime)");
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    const git = (...args: string[]): void =>
      void execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "# package test\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    rowrow("ws", "add", repo, "--profile", PROFILE);
    const answer = "hi from the installed package";
    const agent = rowrow(
      "agent",
      "new",
      repo,
      "--runtime",
      "scripted",
      `/echo ${answer}`,
      "--wait",
      "--timeout",
      "60s",
      "--profile",
      PROFILE,
    );
    check(agent.includes(answer), "the agent didn't answer");
    check(rowrow("service", "status", "--profile", PROFILE).includes("not installed"), "service status");

    step("stop the server");
    server.kill("SIGTERM");
    const code = await exited;
    console.log(`exit code ${code}`);
    check(code === 0 && !fs.existsSync(serverFile), `rowrow serve didn't stop cleanly:\n${output}`);
    console.log(`\nThe package works: ${path.basename(file)}`);
  } catch (error) {
    console.error(`\nrowrow serve said:\n${output}`);
    throw error;
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
  }
}

try {
  await main();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
