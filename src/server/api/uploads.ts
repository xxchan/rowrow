// Files people hand to agents (a phone screenshot, a log): stored on the server under the
// profile's uploads/, private to the user (0700 directories, 0600 files), and referred to
// by absolute path in a message, which every agent runtime can read. Kept for a week.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Attachment } from "../../shared/entries.ts";
import { UserError } from "../errors.ts";
import { log } from "../telemetry/log.ts";

export async function saveUpload(dir: string, file: File): Promise<Attachment> {
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
  // A file without a type (the CLI's, some pastes; the transport calls it octet-stream) gets
  // one from its name when it's an image or a video.
  const given = file.type === "application/octet-stream" ? "" : file.type;
  const type = given || mediaTypeOf(target) || "";
  log.info("upload.saved", { path: target, size: file.size, type });
  return { path: target, name: file.name, size: file.size, type };
}

/** The file behind an upload path, when it is one of ours (inside `dir`, a regular file). */
function uploaded(dir: string, file: string): string | null {
  const resolved = path.resolve(file);
  const root = path.resolve(dir);
  if (!resolved.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/** Attachments must be uploads that still exist: an agent is never handed an arbitrary server path this way. */
export function checkAttachments(dir: string, attachments: readonly Attachment[]): void {
  for (const attachment of attachments) {
    if (uploaded(dir, attachment.path) === null)
      throw new UserError(
        `${attachment.name}: not an uploaded file (or it expired after 7 days); upload it again with files.upload`,
      );
  }
}

/** An uploaded file, to show it again (a thumbnail in the transcript). */
export function readUpload(dir: string, file: string): File {
  const found = uploaded(dir, file);
  if (found === null) throw new UserError("no such upload (they are kept for 7 days)", "NOT_FOUND");
  return new File([fs.readFileSync(found)], path.basename(found), {
    type: mediaTypeOf(found) ?? "application/octet-stream",
  });
}

const mediaTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Upload names keep their extension, so it says what an image or a video is. */
function mediaTypeOf(file: string): string | undefined {
  return mediaTypes[path.extname(file).toLowerCase()];
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
