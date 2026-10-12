// Thinking a model writes into its reply as `<think>…</think>` (DeepSeek, Qwen, MiniMax and GLM
// do through some providers; pi passes it on as text): shown as a thought, not as the reply.
// Markdown would drop the tags and run the thought into the answer in the same style.
import type { ViewPart } from "@botiverse/oar/observe";

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * A reply that opens with a `<think>` block: the thought, the reply after it, and whether the
 * thought is still being written. Null for any other text. While the tag itself streams in
 * (`<thi`), it's an empty open thought rather than a flash of markup.
 */
export function inlineThought(text: string): { thought: string; rest: string; open: boolean } | null {
  const lead = text.trimStart();
  if (!lead.startsWith(OPEN)) {
    return lead !== "" && OPEN.startsWith(lead) ? { thought: "", rest: "", open: true } : null;
  }
  const body = lead.slice(OPEN.length);
  const end = body.indexOf(CLOSE);
  if (end === -1) return { thought: body.trim(), rest: "", open: true };
  return {
    thought: body.slice(0, end).trim(),
    rest: body.slice(end + CLOSE.length).trimStart(),
    open: false,
  };
}

/**
 * The parts with each text that opens with a `<think>` block split in two: the thought as a
 * reasoning part, then the rest of the text. The same array when there's none.
 */
export function withInlineThoughts<T extends ViewPart>(parts: readonly T[]): readonly (T | ViewPart)[] {
  if (!parts.some((part) => part.kind === "text" && inlineThought(part.text) !== null)) return parts;
  return parts.flatMap((part): (T | ViewPart)[] => {
    const split = part.kind === "text" ? inlineThought(part.text) : null;
    if (part.kind !== "text" || split === null) return [part];
    const thought: ViewPart = {
      kind: "reasoning",
      content: { kind: "text", text: split.thought },
      ...(part.messageId === undefined ? {} : { messageId: part.messageId }),
    };
    return split.rest === "" ? [thought] : [thought, { ...part, text: split.rest }];
  });
}

/**
 * The preview fold's state for an inline thought: `head` is a text run's start while it may
 * still be the opening tag (null once it isn't), `thinking` inside a thought, `tail` the end of
 * the thought so far (where its closing tag may be arriving).
 */
export interface PreviewThought {
  readonly head: string | null;
  readonly thinking: boolean;
  readonly tail: string;
}

export const NO_THOUGHT: PreviewThought = { head: null, thinking: false, tail: "" };

/**
 * More of the agent's text for a preview. `fresh`: it starts a new text run. Returns what to show
 * (null: nothing yet), whether it replaces the preview rather than adding to it (the run's first
 * shown text), and the state after it.
 */
export function previewPiece(
  piece: string,
  fresh: boolean,
  state: PreviewThought,
): { text: string | null; restart: boolean; state: PreviewThought } {
  const head = fresh ? "" : state.head;
  let thinking = !fresh && state.thinking;
  let text = piece;
  if (head !== null) {
    const lead = (head + piece).trimStart();
    if (lead.startsWith(OPEN)) {
      thinking = true;
      text = lead.slice(OPEN.length);
    } else if (lead === "" || OPEN.startsWith(lead)) {
      return { text: null, restart: false, state: { head: head + piece, thinking: false, tail: "" } };
    } else {
      return { text: head + piece, restart: true, state: NO_THOUGHT };
    }
  }
  if (!thinking) return { text, restart: false, state: NO_THOUGHT };
  // The closing tag can arrive in pieces: keep enough of the end to find it.
  const buffer = (head === null ? state.tail : "") + text;
  const end = buffer.indexOf(CLOSE);
  if (end === -1)
    return {
      text: null,
      restart: false,
      state: { head: null, thinking: true, tail: buffer.slice(-CLOSE.length) },
    };
  return { text: buffer.slice(end + CLOSE.length).trimStart(), restart: true, state: NO_THOUGHT };
}
