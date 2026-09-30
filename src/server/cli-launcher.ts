// Agents use the `rowrow` CLI to see and drive other agents (their env has ROWROW_URL and
// ROWROW_TOKEN). The rowrow on the user's PATH may be another version, or missing altogether
// when the Mac app runs a server bundle (D-032), so the server writes a launcher for its own
// CLI into the profile at every start and puts that directory first on its agents' PATH.
import fs from "node:fs";
import path from "node:path";

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Writes `<dir>/rowrow`, which runs `main` with `node`; returns the directory. */
export function writeCliLauncher(dir: string, node: string, main: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "rowrow");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `#!/bin/sh
# The CLI of the rowrow server that runs this profile, first on its agents' PATH (written at
# every start, so it matches that server).
exec ${quote(node)} ${quote(main)} "$@"
`,
    { mode: 0o755 },
  );
  fs.renameSync(tmp, file);
  return dir;
}

/** `dir` first on a PATH, without repeating it. */
export function prependPath(dir: string, current: string | undefined): string {
  return [dir, ...(current ?? "").split(path.delimiter).filter((p) => p !== "" && p !== dir)].join(
    path.delimiter,
  );
}
