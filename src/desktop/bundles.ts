// Where the Mac app gets a server bundle to put on an SSH host (D-033): the one it ships
// (for an Apple silicon Mac), one in a directory you name (development: `pnpm build:bundle`),
// or the release's own asset on GitHub, checked against the release's SHA256SUMS. Downloads go
// through Electron's network stack, so the system's proxy settings apply, and are kept in the
// app's cache for the next host.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BundleSource } from "./hosts.ts";
import { sha256File } from "./hosts.ts";
import type { Logger } from "./log.ts";
import type { BundleTarget } from "./ssh.ts";

export interface BundleSourceOptions {
  /** Where downloaded and packed bundles are kept. */
  readonly cacheDir: string;
  /** Directories with rowrow-server-<version>-<target>.tar.gz files, looked in first. */
  readonly localDirs: readonly string[];
  /** The bundle inside the app, for hosts of the same platform. */
  readonly own: { readonly dir: string; readonly target: BundleTarget; readonly version: string } | null;
  /** https://github.com/<owner>/<repo>/releases/download */
  readonly releases: string;
  readonly fetch: (url: string) => Promise<Response>;
  readonly log: Logger;
}

export function bundleName(version: string, target: BundleTarget): string {
  return `rowrow-server-${version}-${target}.tar.gz`;
}

export function createBundleSource(options: BundleSourceOptions): BundleSource {
  const { cacheDir, localDirs, own, releases, log } = options;
  const download = async (url: string, file: string): Promise<void> => {
    const response = await options.fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    const tmp = `${file}.${process.pid}.part`;
    fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(tmp, file);
  };
  return {
    async tarball(version, target, step) {
      const name = bundleName(version, target);
      for (const dir of localDirs) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) return file;
      }
      fs.mkdirSync(cacheDir, { recursive: true });
      const cached = path.join(cacheDir, name);
      if (fs.existsSync(cached)) return cached;
      if (own !== null && own.version === version && own.target === target) {
        step(`Packing rowrow ${version}'s server`);
        const tmp = `${cached}.${process.pid}.part`;
        await new Promise<void>((resolve, reject) =>
          execFile(
            "/usr/bin/tar",
            ["-czf", tmp, "-C", path.dirname(own.dir), path.basename(own.dir)],
            (error) => (error === null ? resolve() : reject(error)),
          ),
        );
        fs.renameSync(tmp, cached);
        return cached;
      }
      step(`Downloading rowrow ${version}'s server for ${target}`);
      const base = `${releases}/v${version}`;
      const sums = await (async () => {
        const response = await options.fetch(`${base}/SHA256SUMS`);
        if (!response.ok)
          throw new Error(
            `no rowrow ${version} server for ${target} on GitHub (${base}/SHA256SUMS: HTTP ${response.status})`,
          );
        return response.text();
      })();
      const expected = new RegExp(`^([0-9a-f]{64})\\s+\\*?${name.replaceAll(".", "\\.")}$`, "m").exec(
        sums,
      )?.[1];
      if (expected === undefined)
        throw new Error(`the rowrow ${version} release has no server for ${target}`);
      const tmp = `${cached}.${process.pid}.download`;
      await download(`${base}/${name}`, tmp);
      const actual = await sha256File(tmp);
      if (actual !== expected) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`${name} doesn't match the release's SHA256SUMS; not using it`);
      }
      fs.renameSync(tmp, cached);
      log.info("desktop.bundle.downloaded", { version, target });
      return cached;
    },
  };
}
