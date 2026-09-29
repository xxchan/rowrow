// Workspaces: directories agents work in (docs/decisions.md, D-007). The registry is in
// the database; git facts are read from the checkout and kept fresh in AppState. A linked
// worktree is grouped under the workspace of its repository's main checkout, derived from
// git (same common dir), never stored.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId } from "../../shared/ids.ts";
import type { GitSummary, Workspace } from "../../shared/schemas.ts";
import { readGitSummary } from "../git/summary.ts";
import type { StateStore } from "../state/store.ts";
import type { Db } from "../store/db.ts";
import { log, serializeError } from "../telemetry/log.ts";

interface Row {
  id: string;
  path: string;
  custom_label: string | null;
  created_at: number;
  archived: number;
}

export class Workspaces {
  private readonly db: Db;
  private readonly state: StateStore;
  private readonly refreshing = new Map<string, Promise<Workspace>>();
  private readonly soon = new Map<string, NodeJS.Timeout>();

  constructor(db: Db, state: StateStore) {
    this.db = db;
    this.state = state;
  }

  /** Put every registered workspace into AppState, then read their git facts in the background. */
  load(): void {
    const rows = this.db.all<Row>("select * from workspaces order by created_at");
    this.state.update("workspaces.load", (draft) => {
      for (const row of rows) draft.workspaces[row.id] = fromRow(row, null);
    });
    for (const row of rows) void this.refresh(row.id).catch(() => undefined);
  }

  get(id: string): Workspace | undefined {
    return this.state.get().state.workspaces[id];
  }

  list(): Workspace[] {
    return Object.values(this.state.get().state.workspaces);
  }

  async add(input: string, label?: string): Promise<Workspace> {
    const resolved = resolvePath(input);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      throw new Error(`no such directory: ${resolved}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${real}`);
    const existing = this.list().find((w) => w.path === real);
    if (existing !== undefined) {
      if (existing.archived) this.update(existing.id, { archived: false });
      return this.get(existing.id) ?? existing;
    }
    const row: Row = { id: newId("ws"), path: real, custom_label: label ?? null, created_at: Date.now(), archived: 0 };
    this.db.run(
      "insert into workspaces (id, path, custom_label, created_at, archived) values (?, ?, ?, ?, 0)",
      row.id,
      row.path,
      row.custom_label,
      row.created_at,
    );
    this.state.update("workspaces.add", (draft) => {
      draft.workspaces[row.id] = fromRow(row, null);
    });
    log.info("workspace.added", { ws: row.id, path: real });
    return this.refresh(row.id);
  }

  update(id: string, changes: { label?: string | null; archived?: boolean }): Workspace {
    const current = this.require(id);
    if (changes.label !== undefined) this.db.run("update workspaces set custom_label = ? where id = ?", changes.label, id);
    if (changes.archived !== undefined) this.db.run("update workspaces set archived = ? where id = ?", changes.archived ? 1 : 0, id);
    this.state.update("workspaces.update", (draft) => {
      const ws = draft.workspaces[id];
      if (ws === undefined) return;
      if (changes.label !== undefined) ws.customLabel = changes.label;
      if (changes.archived !== undefined) ws.archived = changes.archived;
      ws.label = labelOf(ws.path, ws.customLabel, ws.git);
    });
    log.info("workspace.updated", { ws: id, ...changes });
    return this.get(id) ?? current;
  }

  /** Forget a workspace (the directory is untouched). */
  remove(id: string): void {
    this.db.run("delete from workspaces where id = ?", id);
    this.state.update("workspaces.remove", (draft) => {
      delete draft.workspaces[id];
    });
    this.relink();
  }

  require(id: string): Workspace {
    const ws = this.get(id);
    if (ws === undefined) throw new Error(`no workspace ${id}`);
    return ws;
  }

  /** Re-read git facts now. Concurrent calls share one read. */
  refresh(id: string): Promise<Workspace> {
    const running = this.refreshing.get(id);
    if (running !== undefined) return running;
    const task = this.readAndStore(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, task);
    return task;
  }

  /** Refresh after things settle (a burst of turn ends becomes one git read). */
  refreshSoon(id: string, delayMs = 1500): void {
    clearTimeout(this.soon.get(id));
    const timer = setTimeout(() => {
      this.soon.delete(id);
      void this.refresh(id).catch(() => undefined);
    }, delayMs);
    timer.unref();
    this.soon.set(id, timer);
  }

  private async readAndStore(id: string): Promise<Workspace> {
    const ws = this.require(id);
    const missing = !fs.existsSync(ws.path);
    let git: GitSummary | null = null;
    if (!missing) {
      try {
        git = await readGitSummary(ws.path);
      } catch (error) {
        log.warn("workspace.git_failed", { ws: id, err: serializeError(error) });
      }
    }
    this.state.update("workspaces.git", (draft) => {
      const target = draft.workspaces[id];
      if (target === undefined) return;
      target.missing = missing;
      target.git = git;
      target.label = labelOf(target.path, target.customLabel, git);
    });
    this.relink();
    return this.require(id);
  }

  /** Recompute which workspace each linked worktree belongs under. */
  private relink(): void {
    const all = this.list();
    const mains = new Map<string, string>();
    for (const ws of all) if (ws.git !== null && !ws.git.linked) mains.set(ws.git.repoKey, ws.id);
    this.state.update("workspaces.relink", (draft) => {
      for (const ws of Object.values(draft.workspaces)) {
        const parent = ws.git?.linked === true ? (mains.get(ws.git.repoKey) ?? null) : null;
        if (ws.parentId !== parent) ws.parentId = parent;
      }
    });
  }

  browse(input?: string): { path: string; parent: string | null; entries: { name: string; path: string; repo: boolean }[] } {
    const dir = fs.realpathSync(resolvePath(input ?? "~"));
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .slice(0, 1000)
      .map((entry) => {
        const full = path.join(dir, entry.name);
        return { name: entry.name, path: full, repo: fs.existsSync(path.join(full, ".git")) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, entries };
  }
}

function fromRow(row: Row, git: GitSummary | null): Workspace {
  return {
    id: row.id,
    path: row.path,
    customLabel: row.custom_label,
    label: labelOf(row.path, row.custom_label, git),
    parentId: null,
    createdAt: row.created_at,
    archived: row.archived === 1,
    missing: false,
    git,
  };
}

/** The custom label; for a linked worktree its branch; otherwise the repository or directory name. */
export function labelOf(dir: string, custom: string | null, git: GitSummary | null): string {
  if (custom !== null && custom !== "") return custom;
  if (git?.linked === true) return git.branch ?? path.basename(dir);
  if (git !== null) return path.basename(git.repoRoot);
  return path.basename(dir) || dir;
}

export function resolvePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}
