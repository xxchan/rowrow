// The servers this Mac app knows (docs/desktop.md): this Mac's own, hosts reached over SSH,
// and servers reached by URL. Kept in the app's data directory (servers.json, mode 0600), each
// with the device credential this app holds there, sealed with a key macOS keeps in the
// Keychain (Electron's safeStorage). A credential is a device like any other: the server
// lists it under Devices, and revoking it there signs this app out of that server.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerKind } from "./api.ts";

export interface ServerRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: ServerKind;
  /** This Mac's and SSH hosts' profile (default). */
  readonly profile: string;
  /** SSH: the destination (a host from ~/.ssh/config, or user@host). */
  readonly destination: string | null;
  /** URL servers: the origin. */
  readonly url: string | null;
  /** SSH: this Mac's end of the tunnel, kept so the server's origin (and what the web app stores for it) stays the same. */
  readonly localPort: number | null;
  /** The app started this host's server without a service manager (no systemd --user there). */
  readonly background: boolean;
  readonly token: string | null;
  readonly addedAt: number;
}

/** How credentials are kept on disk: Electron's safeStorage in the app, as-is in tests. */
export interface Sealer {
  seal(text: string): string;
  open(sealed: string): string;
}

interface OnDisk {
  readonly version: 1;
  readonly servers: readonly (Omit<ServerRecord, "token"> & { readonly token: string | null })[];
}

export const LOCAL_ID = "local";

export class ServerStore {
  private readonly file: string;
  private readonly sealer: Sealer;
  private servers: ServerRecord[] = [];

  constructor(file: string, sealer: Sealer) {
    this.file = file;
    this.sealer = sealer;
    this.load();
  }

  private load(): void {
    let disk: OnDisk;
    try {
      disk = JSON.parse(fs.readFileSync(this.file, "utf8")) as OnDisk;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`can't read ${this.file}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    this.servers = disk.servers.map((server) => {
      let token: string | null = null;
      try {
        token = server.token === null ? null : this.sealer.open(server.token);
      } catch {
        // Sealed by another install's key (a restored backup): pair again.
      }
      return { ...server, token };
    });
  }

  private save(): void {
    const disk: OnDisk = {
      version: 1,
      servers: this.servers.map((s) => ({
        ...s,
        token: s.token === null ? null : this.sealer.seal(s.token),
      })),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list(): readonly ServerRecord[] {
    return this.servers;
  }

  get(id: string): ServerRecord | null {
    return this.servers.find((s) => s.id === id) ?? null;
  }

  add(server: Omit<ServerRecord, "id" | "addedAt"> & { readonly id?: string }): ServerRecord {
    const record: ServerRecord = {
      ...server,
      id: server.id ?? `srv_${randomBytes(5).toString("hex")}`,
      addedAt: Date.now(),
    };
    this.servers = [...this.servers.filter((s) => s.id !== record.id), record];
    this.save();
    return record;
  }

  update(id: string, changes: Partial<Omit<ServerRecord, "id" | "kind" | "addedAt">>): ServerRecord {
    const current = this.get(id);
    if (current === null) throw new Error(`no server ${id}`);
    const next = { ...current, ...changes };
    this.servers = this.servers.map((s) => (s.id === id ? next : s));
    this.save();
    return next;
  }

  remove(id: string): void {
    this.servers = this.servers.filter((s) => s.id !== id);
    this.save();
  }
}
