// Identifiers. A prefix says what the id names, so a bare id in a log line or a URL is
// self-describing; the rest is random (Crockford base32, 50 bits), which is plenty within
// one installation. Input ids are client-generated UUIDs instead: they are idempotency
// keys and oar carries them into the runtime.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** tk: a Coach task (D-050); tr: one of its runs; cmd: a command run in a workspace (D-052). */
export type IdKind = "ws" | "ag" | "run" | "dev" | "link" | "tk" | "tr" | "cmd";

export function newId(kind: IdKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte & 31];
  return `${kind}_${id}`;
}

export function newInputId(): string {
  return crypto.randomUUID();
}
