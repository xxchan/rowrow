// Files people hand to agents (a phone screenshot, a log): stored on the server under the
// profile's uploads/, private to the user (0700 directories, 0600 files), and referred to
// by absolute path in a message, which every agent runtime can read. Kept for a week.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../telemetry/log.ts";

export async function saveUpload(
  dir: string,
  file: File,
): Promise<{ path: string; name: string; size: number; type: string }> {
  const day = new Date().toISOString().slice(0, 10);
  const folder = path.join(dir, day);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // A name that pastes safely unquoted into a shell or a message.
  const safe =
    (file.name || "file")
      .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "")
      .slice(-80) || "file";
  const target = path.join(folder, `${randomBytes(4).toString("hex")}-${safe}`);
  fs.writeFileSync(target, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
  log.info("upload.saved", { path: target, size: file.size, type: file.type });
  return { path: target, name: file.name, size: file.size, type: file.type };
}

/** Delete uploads older than `maxAgeMs` (whole days at a time). */
export function pruneUploads(dir: string, maxAgeMs: number): void {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const day of fs.readdirSync(dir)) {
    const folder = path.join(dir, day);
    const time = Date.parse(day);
    if (!Number.isNaN(time) && time < cutoff) {
      fs.rmSync(folder, { recursive: true, force: true });
      log.info("upload.pruned", { folder });
    }
  }
}
