// `node scripts/desktop-metadata.ts <dir> <version>`: what the Mac app's updater reads from a
// release (docs/desktop.md, "Releases"): latest-mac.yml (the version, and each file's size and
// sha512) and a blockmap per file, so an update downloads only the blocks that changed (the
// server's Node and most dependencies don't, release to release). Made from the signed,
// notarized files, in a CI job that holds no secrets.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type BuildBlockMap = (file: string, format: "gzip", out: string) => Promise<{ size: number; sha512: string }>;

/** electron-builder's own blockmap writer (in app-builder-lib, which it depends on). */
function blockMapBuilder(): BuildBlockMap {
  const require = createRequire(import.meta.url);
  const fromBuilder = createRequire(require.resolve("electron-builder"));
  return (fromBuilder("app-builder-lib/out/targets/blockmap/blockmap.js") as { buildBlockMap: BuildBlockMap })
    .buildBlockMap;
}

export async function writeMetadata(dir: string, version: string): Promise<string> {
  const buildBlockMap = blockMapBuilder();
  const names = [`rowrow-${version}-mac-arm64.zip`, `rowrow-${version}-mac-arm64.dmg`];
  const files: { url: string; sha512: string; size: number }[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`desktop-metadata: no ${file}`);
    const info = await buildBlockMap(file, "gzip", `${file}.blockmap`);
    files.push({ url: name, sha512: info.sha512, size: info.size });
  }
  const zip = files[0];
  if (zip === undefined) throw new Error("desktop-metadata: no zip");
  const yml = [
    `version: ${version}`,
    "files:",
    ...files.flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${zip.url}`,
    `sha512: ${zip.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
  const out = path.join(dir, "latest-mac.yml");
  fs.writeFileSync(out, yml);
  console.log(`desktop-metadata: ${out} and the blockmaps`);
  return out;
}

if (import.meta.main) {
  const [dir, version] = process.argv.slice(2);
  if (dir === undefined || version === undefined)
    throw new Error("usage: desktop-metadata.ts <dir> <version>");
  await writeMetadata(path.resolve(dir), version);
}
