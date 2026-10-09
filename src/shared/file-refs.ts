// File paths in what an agent wrote or did, to open in the inspector (roamgate #208, #272;
// D-054): inline code that names a file (`src/a.ts`, `src/a.ts:42`, `src/a.ts#L42`), the file a
// tool call reads or edits (a Read's offset is its line), and paths in a search's or a command's
// output. A path links only when it names a file of the workspace's checkout as files.list
// lists it: relative to the agent's folder or the checkout's top, absolute under either, or a
// bare name or suffix only one listed file has (Codex's convention for file references). Paths
// outside the checkout, ignored files (node_modules) and files nobody listed stay plain text.
// Pure, so the kit could give the iOS app the same links.
import { classifyTool } from "@botiverse/oar/observe";

/** A path as written, and the line it names (1-based), if any. */
export interface FileRef {
  readonly path: string;
  readonly line: number | null;
}

/** A file of the checkout to open: its path relative to the checkout's top, and a line. */
export interface FileTarget {
  readonly path: string;
  readonly line: number | null;
}

/** The checkout's files (files.list), and where paths the agent writes start from. */
export interface CheckoutFiles {
  /** The checkout's top, absolute: files.list's paths are relative to it. */
  readonly root: string;
  /** The agent's folder (the workspace's), absolute: where a relative path starts. */
  readonly cwd: string;
  /** The agent's folder relative to the top ("" when it is the top). */
  readonly sub: string;
  readonly paths: ReadonlySet<string>;
  /** Listed paths by their last segment, for bare names and suffixes. */
  readonly byName: ReadonlyMap<string, readonly string[]>;
}

export function checkoutFiles(root: string, cwd: string, paths: readonly string[]): CheckoutFiles {
  const top = trimSlash(root);
  const here = trimSlash(cwd);
  // A folder under the top; anything else (the top itself, or the same folder through a
  // symlink: git reports the real path) starts at the top.
  const sub = here.startsWith(`${top}/`) ? here.slice(top.length + 1) : "";
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const same = byName.get(name);
    if (same === undefined) byName.set(name, [path]);
    else same.push(path);
  }
  return { root: top, cwd: here, sub, paths: new Set(paths), byName };
}

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

// `:42`, `:42:7`, `:42-50`; GitHub's `#L42`, `#L42C7`, `#L42-L50`; tsc's `(42,7)`.
const LINE_SUFFIX =
  /(?::(\d+)(?::\d+)?(?:-\d+(?::\d+)?)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|\((\d+)(?:,\s*\d+)?\))$/;
// What no path we link has: globs, shell syntax, quotes, URL parts, Windows separators, colons
// left after the line (a URL, `C:`, `node:fs`, `HEAD:src/a.ts`), and control characters.
// oxlint-disable-next-line no-control-regex
const NOT_A_PATH = /[*?[\]{}<>|"'`$\\:#\u0000-\u001f\u007f]/;
const VERSION = /^v?\d+(?:\.\d+)+(?:[-+][\w.-]*)?$/;

/**
 * A path and line as written in inline code (the whole span), or null when it isn't shaped
 * like a file path: it needs a `/` or a `.` (`a.ts`, `src/a`, `.env`), so commands and words
 * stay plain. Whether the file exists is `resolvePath`'s question.
 */
export function parseFileRef(text: string): FileRef | null {
  let path = text.trim();
  if (path.startsWith("file://")) path = path.slice("file://".length);
  if (path === "" || path.length > 1024) return null;
  let line: number | null = null;
  const suffix = LINE_SUFFIX.exec(path);
  if (suffix !== null) {
    line = Number(suffix[1] ?? suffix[2] ?? suffix[3]);
    path = path.slice(0, suffix.index);
  }
  if (path.startsWith("./")) path = path.slice(2);
  if (
    path === "" ||
    NOT_A_PATH.test(path) ||
    /\s/.test(path.replaceAll(" ", "")) ||
    path.startsWith("~") ||
    path.startsWith("-") ||
    path.startsWith("//") ||
    path.endsWith("/") ||
    VERSION.test(path) ||
    !/[./]/.test(path)
  )
    return null;
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  // No `.` or `..` (nothing climbs out of the checkout), no empty ones.
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment.trim() !== segment,
    )
  )
    return null;
  return { path, line: line === null || line < 1 ? null : line };
}

/**
 * The listed file a written path names, relative to the checkout's top, or null. An absolute
 * path must be under the top or the agent's folder. A relative one is tried from the agent's
 * folder, then from the top, then without a diff's `a/` or `b/`, then as the suffix of exactly
 * one listed file (`FilesTab.tsx`, `components/FilesTab.tsx`).
 */
export function resolvePath(path: string, files: CheckoutFiles): string | null {
  if (path.startsWith("/")) {
    for (const [from, to] of [
      [files.root, ""],
      [files.cwd, files.sub],
    ] as const) {
      if (!path.startsWith(`${from}/`)) continue;
      const relative = join(to, path.slice(from.length + 1));
      if (files.paths.has(relative)) return relative;
    }
    return null;
  }
  const tries = [path, ...(/^[ab]\//.test(path) ? [path.slice(2)] : [])];
  for (const relative of tries)
    for (const candidate of [join(files.sub, relative), relative])
      if (files.paths.has(candidate)) return candidate;
  for (const relative of tries) {
    const name = relative.slice(relative.lastIndexOf("/") + 1);
    const matches = (files.byName.get(name) ?? []).filter(
      (listed) => listed === relative || listed.endsWith(`/${relative}`),
    );
    if (matches.length === 1) return matches[0] ?? null;
  }
  return null;
}

const join = (base: string, path: string): string => (base === "" ? path : `${base}/${path}`);

/** The file inline code names, with its line, when the checkout has it. */
export function fileTarget(text: string, files: CheckoutFiles): FileTarget | null {
  const ref = parseFileRef(text);
  if (ref === null) return null;
  const path = resolvePath(ref.path, files);
  return path === null ? null : { path, line: ref.line };
}

/** Input keys that name the one file of a tool oar doesn't classify (a MultiEdit, a runtime it doesn't know). */
const PATH_KEYS = ["file_path", "filePath", "path", "file", "notebook_path"];

/**
 * The file a tool call names, as its row shows it (oar's `detail` is the first of a file tool's
 * paths), and the line it starts at when the input says: a read's `offset`, or the first change
 * of a Codex file change's diff. Null when the call names no file.
 */
export function toolFileRef(runtime: string, tool: string, input: string | undefined): FileRef | null {
  const action = classifyTool(runtime, tool, input);
  const parsed = parse(input);
  const record =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const path =
    action.paths?.[0] ??
    PATH_KEYS.map((key) => record?.[key]).find(
      (value): value is string => typeof value === "string" && value !== "",
    );
  if (path === undefined || path !== action.detail) return null;
  let line: number | null = null;
  const offset = record?.["offset"];
  if ((action.kind === "read_file" || /^read$/i.test(tool)) && typeof offset === "number" && offset >= 1)
    line = Math.floor(offset);
  if (Array.isArray(parsed)) {
    // Codex's fileChange: [{path, kind, diff}], the diff unified for an update.
    const change = parsed.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && (item as Record<string, unknown>)["path"] === path,
    );
    const diff = change?.["diff"];
    if (typeof diff === "string") line = firstChangedLine(diff);
  }
  return { path, line };
}

/** The file of the checkout a tool call names (as `toolFileRef` reads it), if it lists it. */
export function toolFileTarget(
  runtime: string,
  tool: string,
  input: string | undefined,
  files: CheckoutFiles,
): FileTarget | null {
  const ref = toolFileRef(runtime, tool, input);
  const path = ref === null ? null : resolvePath(ref.path, files);
  return ref === null || path === null ? null : { path, line: ref.line };
}

/** Where a unified diff's first change is in the new file, or null without a hunk. */
export function firstChangedLine(diff: string): number | null {
  const lines = diff.split("\n");
  const at = lines.findIndex((line) => line.startsWith("@@"));
  const start = at < 0 ? null : /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[at] ?? "");
  if (start === null || start === undefined) return null;
  let line = Number(start[1]);
  for (const text of lines.slice(at + 1)) {
    if (!text.startsWith(" ")) break;
    line += 1;
  }
  return Math.max(1, line);
}

/** A path found in free text: where it is (UTF-16 offsets) and what it opens. */
export interface FoundRef {
  readonly start: number;
  readonly end: number;
  readonly target: FileTarget;
}

// roamgate's terminal links (terminalFileLinks.ts), without Windows: an absolute path, a `./`
// one, or a relative one with a `/` in it, then maybe `:line` or `:line:column`; at the start of
// the text or after a space, a quote or an opening bracket.
const IN_TEXT =
  /(?<=^|[\s"'`([{<])(?:\/[\w.~@%+=,-]+(?:\/[\w.~@%+=,-]+)*|\.\/[\w.~@%+=,-]+(?:\/[\w.~@%+=,-]+)*|[\w.~@%+=,-]+(?:\/[\w.~@%+=,-]+)+)(?::\d+(?::\d+)?)?/g;

/**
 * The listed files a tool's output mentions (a search's hits, a test's failures), in order, at
 * most `limit` of them. Trailing punctuation isn't part of a path.
 */
export function findFileRefs(text: string, files: CheckoutFiles, limit = 500): FoundRef[] {
  const found: FoundRef[] = [];
  for (const match of text.matchAll(IN_TEXT)) {
    if (found.length >= limit) break;
    const written = match[0].replace(/[.,;:!?]+$/, "");
    const ref = parseFileRef(written);
    if (ref === null) continue;
    const path = resolvePath(ref.path, files);
    if (path === null) continue;
    found.push({ start: match.index, end: match.index + written.length, target: { path, line: ref.line } });
  }
  return found;
}

function parse(input: string | undefined): unknown {
  if (input === undefined) return null;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}
