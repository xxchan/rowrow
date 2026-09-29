// Project search (roamgate #227, docs/git.md "Search"): file names and contents across a
// checkout, through git's own view of it: `git ls-files` for names and `git grep` for
// contents, both tracked and untracked files, both honoring .gitignore the same way, with
// binary files skipped. Results are bounded and say when they were cut. Read-only, and it
// never takes the index lock. `readWorkspaceFile` is the preview a result opens.
import fs from "node:fs";
import path from "node:path";
import type { FileText, SearchKind, SearchResult } from "../../shared/schemas.ts";
import { git } from "./exec.ts";

export const SEARCH_LIMIT = 200;
export const MAX_QUERY = 200;
/** A preview stops at this many bytes (on a line boundary). */
export const READ_MAX_BYTES = 1024 * 1024;
const GREP_MAX_BYTES = 2 * 1024 * 1024;
const GREP_TIMEOUT_MS = 10_000;
const NAMES_MAX_BYTES = 64 * 1024 * 1024;
/** A matching line is cut to about this many characters around its first match. */
const SNIPPET = 240;

export class SearchError extends Error {}

const QUIET = { GIT_OPTIONAL_LOCKS: "0" } as const;

/** The query as git grep's fixed string: one line, not empty, not huge. */
export function checkQuery(query: string): string {
  if (query.trim() === "") throw new SearchError("Type something to search for.");
  if (query.length > MAX_QUERY) throw new SearchError(`Search for at most ${MAX_QUERY} characters.`);
  if (/[\0\r\n]/.test(query)) throw new SearchError("Search for one line of text.");
  return query;
}

/** Smart case, as in ripgrep: a query with an uppercase letter matches case exactly. */
export function caseSensitive(query: string): boolean {
  return /\p{Lu}/u.test(query);
}

export async function searchWorkspace(input: {
  readonly dir: string;
  readonly query: string;
  readonly kind?: SearchKind;
}): Promise<SearchResult> {
  const query = checkQuery(input.query);
  const kind = input.kind ?? "all";
  const top = await topOf(input.dir);
  const [names, lines] = await Promise.all([
    kind === "content" ? null : searchNames(top, query),
    kind === "names" ? null : searchLines(top, query),
  ]);
  const notes = [names?.note, lines?.note].filter((n): n is string => n !== null && n !== undefined);
  return {
    query,
    names: names?.hits ?? [],
    namesTruncated: names?.truncated ?? false,
    lines: lines?.hits ?? [],
    linesTruncated: lines?.truncated ?? false,
    note: notes.length === 0 ? null : notes.join(" "),
  };
}

async function searchNames(
  top: string,
  query: string,
): Promise<{ hits: { path: string }[]; truncated: boolean; note: string | null }> {
  const listed = await git(
    ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"],
    {
      cwd: top,
      env: QUIET,
      maxBytes: NAMES_MAX_BYTES,
    },
  );
  if (listed.code !== 0 && !listed.capped) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const records = listed.stdout.split("\0");
  if (listed.capped) records.pop(); // the last one may be cut
  const exact = caseSensitive(query);
  const fold = (text: string): string => (exact ? text : text.toLowerCase());
  const words = fold(query)
    .split(/\s+/)
    .filter((word) => word !== "");
  const whole = fold(query.trim());
  const matches = records.filter((file) => {
    if (file === "") return false;
    const target = fold(file);
    return words.every((word) => target.includes(word));
  });
  // The file's own name first, then shorter paths.
  const rank = (file: string): number => (fold(path.posix.basename(file)).includes(whole) ? 0 : 1);
  matches.sort((a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  // Deleted but still tracked files are listed too; show only what a preview can open.
  const hits: { path: string }[] = [];
  let at = 0;
  for (; at < matches.length && hits.length < SEARCH_LIMIT; at++) {
    const file = matches[at] ?? "";
    if (await exists(path.join(top, file))) hits.push({ path: file });
  }
  return {
    hits,
    truncated: at < matches.length || listed.capped,
    note: listed.capped ? "The checkout has too many files: only some were searched by name." : null,
  };
}

async function searchLines(
  top: string,
  query: string,
): Promise<{ hits: SearchResult["lines"]; truncated: boolean; note: string | null }> {
  const exact = caseSensitive(query);
  const result = await git(
    [
      "grep",
      "--untracked",
      "-I",
      "-n",
      "--no-column",
      "--full-name",
      "--no-color",
      "-z",
      "-F",
      ...(exact ? [] : ["-i"]),
      "-e",
      query,
    ],
    { cwd: top, env: QUIET, maxBytes: GREP_MAX_BYTES, stopAtMax: true, timeoutMs: GREP_TIMEOUT_MS },
  );
  // 1: no match. A search cut short (by the cap or the clock) still has results worth showing.
  if (result.code !== 0 && result.code !== 1 && !result.capped && !result.timedOut)
    throw new Error(`git grep failed: ${result.stderr || `exit code ${result.code}`}`);
  const { hits, more } = parseGrep(result.stdout, query, exact, SEARCH_LIMIT);
  hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return {
    hits,
    truncated: more || result.capped || result.timedOut,
    note: result.timedOut ? `The content search stopped after ${GREP_TIMEOUT_MS / 1000} s.` : null,
  };
}

/**
 * `git grep -n -z` output: `<path>\0<line>\0<text>\n` per match. The path can hold any byte
 * but NUL, the text any byte but a newline, so it is read field by field. An incomplete last
 * record (output cut short) is dropped.
 */
export function parseGrep(
  out: string,
  query: string,
  exact: boolean,
  limit: number,
): { hits: SearchResult["lines"]; more: boolean } {
  const hits: SearchResult["lines"] = [];
  let at = 0;
  while (at < out.length) {
    const pathEnd = out.indexOf("\0", at);
    const lineEnd = pathEnd === -1 ? -1 : out.indexOf("\0", pathEnd + 1);
    const textEnd = lineEnd === -1 ? -1 : out.indexOf("\n", lineEnd + 1);
    if (textEnd === -1) break;
    if (hits.length === limit) return { hits, more: true };
    hits.push({
      path: out.slice(at, pathEnd),
      line: Number(out.slice(pathEnd + 1, lineEnd)),
      text: snippet(out.slice(lineEnd + 1, textEnd), query, exact),
    });
    at = textEnd + 1;
  }
  return { hits, more: false };
}

/** The line, or a window of it around its first match, with … where it was cut. */
export function snippet(line: string, query: string, exact: boolean): string {
  const text = line.replace(/\r$/, "");
  if (text.length <= SNIPPET) return text;
  const found = exact ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, Math.min((found === -1 ? 0 : found) - 60, text.length - SNIPPET));
  const end = Math.min(text.length, start + SNIPPET);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * A file's text for a preview, by its path relative to the top of the checkout. Refuses
 * anything outside the checkout (`..`, absolute paths, symlinks that lead out), inside
 * `.git`, not a regular file, or binary; stops at 1 MiB.
 */
export async function readWorkspaceFile(input: {
  readonly dir: string;
  readonly path: string;
}): Promise<FileText> {
  const file = input.path;
  const parts = file.split("/");
  if (
    file === "" ||
    file.includes("\0") ||
    path.isAbsolute(file) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    file.split(/[\\/]/).includes("..")
  )
    throw new SearchError(`invalid path "${file}": it must be relative to the checkout, without "." or ".."`);
  if (parts.some((part) => part.toLowerCase() === ".git")) throw new SearchError(`"${file}" is inside .git`);
  const top = await fs.promises.realpath(await topOf(input.dir));
  let real: string;
  try {
    real = await fs.promises.realpath(path.join(top, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SearchError(`${file} doesn't exist`);
    throw error;
  }
  const inside = path.relative(top, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
    throw new SearchError(`${file} leads outside the checkout`);
  if (inside.split(path.sep).some((part) => part.toLowerCase() === ".git"))
    throw new SearchError(`${file} leads into .git`);
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) throw new SearchError(`${file} isn't a file`);
  const handle = await fs.promises.open(real, "r");
  let data: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, READ_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    data = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (data.subarray(0, 8000).includes(0)) throw new SearchError(`${file} is a binary file: no preview`);
  const truncated = stat.size > data.length;
  if (truncated) {
    const end = data.lastIndexOf(10);
    if (end !== -1) data = data.subarray(0, end + 1);
  }
  return { path: file, text: data.toString("utf8"), size: stat.size, truncated };
}

async function topOf(dir: string): Promise<string> {
  const result = await git(["rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 10_000 });
  if (result.code !== 0) throw new SearchError(`${dir} is not in a git repository`);
  return result.stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch {
    return false;
  }
}
