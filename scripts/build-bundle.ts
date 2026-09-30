// `pnpm build:bundle [--target darwin-arm64,linux-x64,linux-arm64] [--tarball rowrow-x.y.z.tgz] [--version V]`:
// a rowrow server you can put on any machine (docs/decisions.md, D-032). One directory per
// platform, and a .tar.gz of it:
//
//   rowrow-server-<version>-<os>-<arch>/
//     bin/rowrow      the CLI, run by this directory's own Node (a symlink to it works too)
//     node            Node <devEngines version> for that platform, from nodejs.org, checksummed
//     lib/ dist/ package.json README.md LICENSE    exactly the npm package's files
//     node_modules/   its production dependencies, installed by npm for that platform
//
// The Mac app ships the darwin one and clones it into ~/.rowrow/versions/<version> for its
// launchd service; over SSH it uploads the one for the host (docs/desktop.md). Dependencies
// come from npm with the package's own ranges, as `npm install -g rowrow` gets them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
  devEngines: { runtime: { version: string } };
};
const NODE_VERSION = pkg.devEngines.runtime.version;
export const TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
export type Target = (typeof TARGETS)[number];

/** Files npm installs that nothing runs: source maps, type declarations, docs (licenses stay). */
export function prunable(name: string): boolean {
  return (
    /\.(js|mjs|cjs)\.map$/.test(name) ||
    /\.d\.(ts|mts|cts)$/.test(name) ||
    name.endsWith(".tsbuildinfo") ||
    (/\.md$/i.test(name) && !/^(licen[cs]e|notice|copying)/i.test(name))
  );
}

/**
 * Whether a package's `os` or `cpu` rules it out on the target, read the way npm reads them
 * (npm-install-checks): no "!value" may match, and one of the others must, if there are any.
 */
export function forOtherPlatform(
  manifest: { readonly os?: unknown; readonly cpu?: unknown },
  platform: string,
  arch: string,
): boolean {
  return !allows(manifest.os, platform) || !allows(manifest.cpu, arch);
}

function allows(rule: unknown, value: string): boolean {
  const entries =
    typeof rule === "string"
      ? [rule]
      : Array.isArray(rule)
        ? rule.filter((entry): entry is string => typeof entry === "string")
        : [];
  if (entries.length === 0 || (entries.length === 1 && entries[0] === "any")) return true;
  let excluded = 0;
  let listed = false;
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      excluded++;
      if (entry.slice(1) === value) return false;
    } else if (entry === value) listed = true;
  }
  return listed || excluded === entries.length;
}

/**
 * The CLI's launcher: finds the bundle from its own path, through symlinks (ROWROW_HOME/bin/rowrow
 * is one), and runs the bundle's CLI with the bundle's Node.
 */
export const LAUNCHER = `#!/bin/sh
# rowrow's CLI, run by the Node in this server bundle (docs/desktop.md).
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
here=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$here/node" "$here/lib/cli/main.js" "$@"
`;

function sh(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error(`GET ${url}: HTTP ${response.status}`);
  fs.writeFileSync(`${file}.part`, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(`${file}.part`, file);
}

/** Node for a platform: downloaded once into a cache, and checked against nodejs.org's SHASUMS256. */
async function nodeBinary(target: Target, cache: string): Promise<{ node: string; license: string }> {
  const mirror = (process.env["NODEJS_ORG_MIRROR"] ?? "https://nodejs.org/dist").replace(/\/+$/, "");
  const name = `node-v${NODE_VERSION}-${target}`;
  const dir = path.join(cache, name);
  const node = path.join(dir, "bin", "node");
  if (!fs.existsSync(node)) {
    fs.mkdirSync(cache, { recursive: true });
    const archive = path.join(cache, `${name}.tar.gz`);
    const sums = path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
    if (!fs.existsSync(sums)) await download(`${mirror}/v${NODE_VERSION}/SHASUMS256.txt`, sums);
    if (!fs.existsSync(archive)) {
      console.log(`build:bundle: downloading ${name}.tar.gz`);
      await download(`${mirror}/v${NODE_VERSION}/${name}.tar.gz`, archive);
    }
    const expected = new RegExp(`^([0-9a-f]{64})\\s+${name}\\.tar\\.gz$`, "m").exec(
      fs.readFileSync(sums, "utf8"),
    )?.[1];
    const actual = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (expected === undefined || expected !== actual) {
      fs.rmSync(archive, { force: true });
      throw new Error(`build:bundle: ${name}.tar.gz doesn't match nodejs.org's SHASUMS256 (${actual})`);
    }
    sh("tar", ["-xzf", archive, "-C", cache, `${name}/bin/node`, `${name}/LICENSE`]);
  }
  return { node, license: path.join(dir, "LICENSE") };
}

function packTarball(into: string): string {
  console.log("build:bundle: npm pack (prepack builds dist/web, dist/kit and lib/)");
  sh("npm", ["pack", "--pack-destination", into], { cwd: root });
  return path.join(into, `rowrow-${pkg.version}.tgz`);
}

function prune(dir: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !prunable(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    bytes += fs.statSync(file).size;
    fs.rmSync(file);
  }
  return bytes;
}

/**
 * Packages npm installed for other platforms. npm 11 installs every optional package a
 * dependency's npm-shrinkwrap.json lists, whatever its `os` and `cpu`, --os and --cpu or not
 * (pi-coding-agent's lists esbuild for 26 platforms: docs/upstream.md).
 */
function prunePlatforms(modules: string, platform: string, arch: string): number {
  let bytes = 0;
  for (const dir of packageDirs(modules)) {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const rules = JSON.parse(fs.readFileSync(manifest, "utf8")) as { os?: unknown; cpu?: unknown };
    if (forOtherPlatform(rules, platform, arch)) {
      bytes += sizeOf(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    } else bytes += prunePlatforms(path.join(dir, "node_modules"), platform, arch);
  }
  return bytes;
}

/** The packages in a node_modules directory, scoped ones included. */
function packageDirs(modules: string): string[] {
  if (!fs.existsSync(modules)) return [];
  return fs.readdirSync(modules, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith(".")) return [];
    const dir = path.join(modules, entry.name);
    return entry.name.startsWith("@") ? packageDirs(dir) : [dir];
  });
}

function sizeOf(dir: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  return bytes;
}

export async function buildBundle(
  target: Target,
  tarball: string,
  out: string,
  cache: string,
  version = pkg.version,
): Promise<string> {
  const [platform, arch] = target.split("-") as [string, string];
  const name = `rowrow-server-${version}-${target}`;
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const staging = fs.mkdtempSync(path.join(out, ".staging-"));
  sh("tar", ["-xzf", tarball, "-C", staging]);
  fs.renameSync(path.join(staging, "package"), dir);
  fs.rmSync(staging, { recursive: true, force: true });

  // A runtime artifact, not a checkout: npm would enforce devEngines, and nothing here builds.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const key of ["devEngines", "devDependencies", "scripts", "packageManager"]) delete manifest[key];
  // --version: a build of this checkout that says it's another version (testing upgrades).
  manifest["version"] = version;
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`build:bundle: npm install --omit=dev for ${target}`);
  sh(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      `--os=${platform}`,
      `--cpu=${arch}`,
    ],
    { cwd: dir },
  );
  const elsewhere = prunePlatforms(path.join(dir, "node_modules"), platform, arch);
  const pruned = prune(path.join(dir, "node_modules"));

  const { node, license } = await nodeBinary(target, cache);
  fs.copyFileSync(node, path.join(dir, "node"));
  fs.chmodSync(path.join(dir, "node"), 0o755);
  fs.copyFileSync(license, path.join(dir, "NODE-LICENSE"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "rowrow"), LAUNCHER, { mode: 0o755 });

  // The bundle for this machine runs here and now: its CLI must say its version.
  if (target === `${process.platform}-${process.arch}`) {
    const said = JSON.parse(sh(path.join(dir, "bin", "rowrow"), ["version", "--json"])) as {
      version: string;
      install: { kind: string };
    };
    if (said.version !== version) throw new Error(`build:bundle: ${name} says it is ${said.version}`);
  }

  const archive = path.join(out, `${name}.tar.gz`);
  sh("tar", ["-czf", archive, "-C", out, name]);
  const size = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;
  console.log(
    `build:bundle: ${path.relative(root, archive)} (${size(fs.statSync(archive).size)}; pruned ${size(elsewhere)} of packages for other platforms, ${size(pruned)} of maps, types and docs)`,
  );
  return dir;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: `${process.platform}-${process.arch}` },
      tarball: { type: "string" },
      out: { type: "string", default: path.join(root, "dist", "bundles") },
      version: { type: "string" },
    },
  });
  const targets = (values.target ?? "").split(",").map((t) => t.trim());
  for (const target of targets)
    if (!(TARGETS as readonly string[]).includes(target))
      throw new Error(`build:bundle: no target "${target}" (${TARGETS.join(", ")})`);
  const out = path.resolve(values.out ?? "");
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-bundle-"));
  try {
    const tarball = values.tarball === undefined ? packTarball(tmp) : path.resolve(values.tarball);
    const cache = path.join(root, "node_modules", ".cache", "rowrow-node");
    for (const target of targets)
      await buildBundle(target as Target, tarball, out, cache, values.version ?? pkg.version);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
