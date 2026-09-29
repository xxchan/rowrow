// Throwaway git repositories for the git module's tests. Every git command (the tests'
// own and the module's, which inherit process.env) runs with a fixed identity and without
// the machine's global or system config, so tests neither depend on nor touch the user's
// git setup (a global `commit.gpgsign` or `init.defaultBranch` would otherwise leak in).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupLog } from "../telemetry/log.ts";

const ISOLATED: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "rowrow test",
  GIT_AUTHOR_EMAIL: "test@rowrow.invalid",
  GIT_COMMITTER_NAME: "rowrow test",
  GIT_COMMITTER_EMAIL: "test@rowrow.invalid",
  GIT_TERMINAL_PROMPT: "0",
  // No background maintenance: a commit may start a detached `git maintenance` that writes
  // into .git after the test has moved on (seen on CI: an old ref landing in a re-inited repo).
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

/** Call once per test file, before any git runs. */
export function isolateGit(): void {
  Object.assign(process.env, ISOLATED);
  setupLog({ consoleFormat: "off" });
}

/** A fresh directory (its real path: macOS's tmpdir is behind a symlink, git reports real paths). */
export function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-git-")));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Run git synchronously in `cwd` and return its stdout (throws on a non-zero exit). */
export function sh(cwd: string, ...args: string[]): string {
  return shEnv(cwd, {}, ...args);
}

/** `sh` with extra environment (e.g. a snapshot store's). */
export function shEnv(cwd: string, env: Readonly<Record<string, string>>, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...ISOLATED, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function write(dir: string, file: string, content: string | Buffer): void {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function commitAll(dir: string, message: string): string {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD").trim();
}

/** A new repository at `<parent>/<name>` on `branch`, with one commit of `files`. */
export function initRepo(
  parent: string,
  name: string,
  files: Readonly<Record<string, string>> = { "README.md": "hello\n" },
  branch = "main",
): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", branch);
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  commitAll(dir, "initial");
  return dir;
}

/** Every file path under `dir`, relative, sorted. */
export function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}
