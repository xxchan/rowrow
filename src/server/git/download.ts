// Downloads (roamgate #312, docs/git.md "Downloads"): any file of a checkout as it is on disk,
// binary or not, and a folder as a .tar.gz of what the file tree shows in it (tracked and
// untracked files, .gitignore honored, never .git). The same path rules as the preview
// (resolveInCheckout). A file is sent from disk as it is read; an archive is built in memory,
// by the `tar` every macOS and Linux has. Both stop at DOWNLOAD_MAX_BYTES, with a message.
import fs from "node:fs";
import path from "node:path";
import { git, run } from "./exec.ts";
import { resolveInCheckout, SearchError } from "./search.ts";

/** The most a download sends: a file's size, or a folder's files added up before compression. */
export const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
const TAR_TIMEOUT_MS = 120_000;
const QUIET = { GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" } as const;

/** A file of the checkout, or a folder of it as `<folder>.tar.gz`, by its path relative to the top. */
export async function downloadWorkspacePath(input: {
  readonly dir: string;
  readonly path: string;
}): Promise<File> {
  const { top, real, inside, stat } = await resolveInCheckout(input.dir, input.path);
  if (stat.isFile()) {
    if (stat.size > DOWNLOAD_MAX_BYTES)
      throw new SearchError(
        `${input.path} is ${mib(stat.size)}: downloads stop at ${mib(DOWNLOAD_MAX_BYTES)}. Copy it off the machine another way (scp, rsync).`,
      );
    // Read from disk as the response is sent, not into memory first.
    const blob = await fs.openAsBlob(real);
    return new File([blob], path.posix.basename(input.path), { type: "application/octet-stream" });
  }
  if (stat.isDirectory()) return archive(top, inside, input.path);
  throw new SearchError(`${input.path} isn't a file or a folder`);
}

async function archive(top: string, inside: string, asked: string): Promise<File> {
  const folder = inside.split(path.sep).join("/");
  const list = (args: string[]) => git(args, { cwd: top, env: QUIET, maxBytes: 64 * 1024 * 1024 });
  const [listed, deleted] = await Promise.all([
    list(["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", folder]),
    list(["ls-files", "--deleted", "-z", "--", folder]),
  ]);
  if (listed.code !== 0 || listed.capped) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const gone = new Set(deleted.stdout.split("\0"));
  const files = [...new Set(listed.stdout.split("\0"))].filter((file) => file !== "" && !gone.has(file));
  if (files.length === 0)
    throw new SearchError(`${asked} has no files to download: git ignores everything in it`);
  const sizes = await Promise.all(
    files.map((file) =>
      fs.promises.lstat(path.join(top, file)).then(
        (s) => s.size,
        () => 0,
      ),
    ),
  );
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > DOWNLOAD_MAX_BYTES)
    throw new SearchError(
      `${asked} holds ${mib(total)} in ${files.length.toLocaleString("en")} file${files.length === 1 ? "" : "s"}: downloads stop at ${mib(DOWNLOAD_MAX_BYTES)}. Download a folder inside it, or copy it off the machine another way (scp, rsync).`,
    );
  // Entries start with the folder's own name: `-C` its parent, and name each file from there.
  const parent = path.posix.dirname(folder);
  const strip = parent === "." ? 0 : parent.length + 1;
  const result = await run(
    "tar",
    ["-c", "-z", "-f", "-", "--no-recursion", "--null", "-C", path.join(top, parent), "-T", "-"],
    {
      cwd: top,
      // macOS tar would add AppleDouble `._` files for extended attributes.
      env: { COPYFILE_DISABLE: "1" },
      input: `${files.map((file) => file.slice(strip)).join("\0")}\0`,
      maxBytes: DOWNLOAD_MAX_BYTES,
      stopAtMax: true,
      timeoutMs: TAR_TIMEOUT_MS,
    },
  );
  if (result.spawnError === "ENOENT")
    throw new SearchError("Downloading a folder needs tar on the server's machine, and it isn't installed.");
  if (result.capped)
    throw new SearchError(
      `${asked} is over ${mib(DOWNLOAD_MAX_BYTES)} compressed: download a folder inside it.`,
    );
  if (result.code !== 0)
    throw new Error(
      `tar failed: ${result.timedOut ? "it took over 2 minutes" : result.stderr || `exit code ${result.code}`}`,
    );
  // Buffer.concat's memory is a plain ArrayBuffer, never a shared one.
  const bytes = (result.bytes ?? Buffer.alloc(0)) as Uint8Array<ArrayBuffer>;
  return new File([bytes], `${path.posix.basename(folder)}.tar.gz`, {
    type: "application/gzip",
  });
}

function mib(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024)).toLocaleString("en")} MiB`;
}
