// Files on their way into a message (D-024): uploaded the moment they are pasted, dropped or
// picked, waiting as tiles until the message goes. The composer keys them by agent; the
// new-agent forms by form. In memory only, like drafts.
import type { Attachment } from "../../shared/entries.ts";
import type { Client } from "./connection.ts";
import { attachmentsOf, setAttachments, setDraft, useDrafts, type PendingAttachment } from "./store.ts";
import { report } from "./telemetry.ts";

/** Start uploading `files` as attachments of `key`'s next message; each shows as a tile at once. */
export function attachFiles(client: Client, key: string, files: readonly File[]): void {
  const change = (id: string, patch: Partial<PendingAttachment>): void =>
    setAttachments(key, (list) => list.map((file) => (file.id === id ? { ...file, ...patch } : file)));
  for (const file of files) {
    const pending: PendingAttachment = {
      id: crypto.randomUUID(),
      name: file.name || "pasted file",
      type: file.type,
      preview:
        file.type.startsWith("image/") || file.type.startsWith("video/") ? URL.createObjectURL(file) : null,
      state: "uploading",
    };
    setAttachments(key, (list) => [...list, pending]);
    client.files.upload({ file }).then(
      (uploaded) => change(pending.id, { state: "ready", uploaded }),
      (error: unknown) => {
        change(pending.id, {
          state: "failed",
          error: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        report("warn", "attachment.upload_failed", error, { key });
      },
    );
  }
}

/** Take one file back out of the message. */
export function detachFile(key: string, id: string): void {
  const file = attachmentsOf(key).find((item) => item.id === id);
  if (file?.preview != null) URL.revokeObjectURL(file.preview);
  setAttachments(key, (list) => list.filter((item) => item.id !== id));
}

/** Forget the files after the message went (their tiles and local previews). */
export function clearFiles(key: string): void {
  for (const file of attachmentsOf(key)) if (file.preview !== null) URL.revokeObjectURL(file.preview);
  setAttachments(key, () => []);
}

/**
 * Put a message back into the composer (taken back from the queue, or a delete undone): into
 * an empty one, or after what you're writing, never over it. Its files are uploaded already.
 */
export function putBack(key: string, text: string, attachments: readonly Attachment[]): void {
  const current = useDrafts.getState().byAgent[key] ?? "";
  setDraft(key, current.trim() === "" ? text : text === "" ? current : `${current.trimEnd()}\n\n${text}`);
  if (attachments.length === 0) return;
  const files = attachments.map((uploaded): PendingAttachment => ({
    id: crypto.randomUUID(),
    name: uploaded.name,
    type: uploaded.type,
    preview: null,
    state: "ready",
    uploaded,
  }));
  setAttachments(key, (list) => [...list, ...files]);
}

/** What the message can carry now, or why it can't go yet. */
export function readyFiles(key: string): { attachments: Attachment[] } | { problem: string } {
  const files = attachmentsOf(key);
  if (files.some((file) => file.state === "failed"))
    return { problem: "Remove the files that didn't upload." };
  if (files.some((file) => file.state === "uploading"))
    return { problem: "Wait for the files to finish uploading." };
  return { attachments: files.flatMap((file) => (file.uploaded === undefined ? [] : [file.uploaded])) };
}

/** The files in a clipboard paste or a drop, if any. */
export function filesOf(data: DataTransfer | null): File[] {
  return data === null ? [] : [...data.files];
}
