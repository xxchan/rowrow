// Coach's references (roamgate's Ranger mentions, #375): a workspace or an agent you pick with @
// in Coach's composer, bound to the exact "@label" text the picker inserted. A reference focuses
// the question; it is not a permission and sends the agent nothing. It travels with the message
// (coach.send's `mentions`, kept on the input entry) and the server checks it against the turn's
// workspaces before the turn starts. Editing a reference's text unbinds it, so a name you type or
// paste stays plain text. Pure, so the composer, the server and the transcript share it (and no
// zod: the kit folds entries that carry these).
import type { AppState } from "./schemas.ts";

/** References one message may carry at most. */
export const MAX_MENTIONS = 32;
/** Characters of a reference's label at most. */
export const MAX_MENTION_LABEL = 200;

/** What a reference points at: a workspace (ws_…) or an agent (ag_…), and the name it was picked by. */
export interface CoachMentionTarget {
  readonly kind: "workspace" | "agent";
  readonly id: string;
  readonly label: string;
}

/** A reference in a message: its target, and where its "@label" is in the text (UTF-16 offsets). */
export interface CoachMention extends CoachMentionTarget {
  readonly start: number;
  readonly end: number;
}

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A label as a reference carries it: one line, no control characters, at most 200 characters. */
export function mentionLabel(name: string, fallback: string): string {
  const label = name.replace(CONTROL, " ").trim().slice(0, MAX_MENTION_LABEL).trim();
  return label === "" ? fallback.slice(0, MAX_MENTION_LABEL) : label;
}

/** Each reference marks its exact "@label" in the text, in order, none overlapping, 32 at most. */
export function mentionsValid(text: string, mentions: readonly CoachMention[]): boolean {
  if (mentions.length > MAX_MENTIONS) return false;
  let previousEnd = 0;
  return mentions.every((mention) => {
    const ok =
      Number.isSafeInteger(mention.start) &&
      Number.isSafeInteger(mention.end) &&
      mention.start >= previousEnd &&
      mention.end > mention.start &&
      mention.end <= text.length &&
      mention.label === mentionLabel(mention.label, "") &&
      text.slice(mention.start, mention.end) === `@${mention.label}`;
    previousEnd = mention.end;
    return ok;
  });
}

/**
 * The @ being typed at the caret, if any: where it starts and what follows it so far. Not inside
 * a word (an e-mail address), and not once a space follows it. A selection is no query.
 */
export function mentionQuery(
  text: string,
  start: number,
  end = start,
): { start: number; end: number; query: string } | null {
  if (start !== end) return null;
  const before = text.slice(0, start);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const previous = before[at - 1];
  if (previous !== undefined && /[\p{L}\p{N}_./:\\@-]/u.test(previous) && !/\p{Script=Han}/u.test(previous))
    return null;
  if (/[\s@]/.test(before.slice(at + 1))) return null;
  return { start: at, end, query: before.slice(at + 1) };
}

/** Where an edit happened, when the browser said (beforeinput): it beats guessing from the text. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly inputType?: string;
}

/**
 * The references after the text changed from `previous` to `text`: those before or after the
 * change move with it, and one the change touched, or whose "@label" no longer reads the same,
 * is unbound (its text stays, as plain text).
 */
export function adjustMentions(
  previous: string,
  text: string,
  mentions: readonly CoachMention[],
  edit?: TextEdit,
): CoachMention[] {
  if (previous === text && edit === undefined) return [...mentions];
  // The changed range, from the common start and end of the two texts…
  let start = 0;
  while (start < previous.length && start < text.length && previous[start] === text[start]) start++;
  let oldEnd = previous.length;
  let newEnd = text.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === text[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  // …or where the browser said it was: typing "o" after "@foo" changes the text after it, not "@foo".
  if (edit !== undefined) {
    let editStart = edit.start;
    let editEnd = edit.end;
    const removed = previous.length - text.length;
    if (editStart === editEnd && removed > 0) {
      if (edit.inputType?.endsWith("Backward") === true) editStart -= removed;
      else if (edit.inputType?.endsWith("Forward") === true) editEnd += removed;
    }
    const inserted = text.length - previous.length + editEnd - editStart;
    if (
      editStart >= 0 &&
      editEnd <= previous.length &&
      inserted >= 0 &&
      previous.slice(0, editStart) === text.slice(0, editStart) &&
      previous.slice(editEnd) === text.slice(editStart + inserted)
    ) {
      start = editStart;
      oldEnd = editEnd;
      newEnd = start + inserted;
    }
  }
  return mentions.flatMap((mention) => {
    const next =
      mention.end <= start
        ? mention
        : mention.start >= oldEnd
          ? { ...mention, start: mention.start + newEnd - oldEnd, end: mention.end + newEnd - oldEnd }
          : null;
    return next !== null && text.slice(next.start, next.end) === `@${next.label}` ? [next] : [];
  });
}

/** The text with a picked reference in place of the @ query (and a space after it), and the caret. */
export function insertMention(
  text: string,
  mentions: readonly CoachMention[],
  target: CoachMentionTarget,
  start: number,
  end: number,
): { text: string; mentions: CoachMention[]; caret: number } {
  const token = `@${target.label}`;
  const next = `${text.slice(0, start)}${token} ${text.slice(end)}`;
  return {
    text: next,
    mentions: [
      ...adjustMentions(text, next, mentions, { start, end }),
      { kind: target.kind, id: target.id, label: target.label, start, end: start + token.length },
    ].sort((a, b) => a.start - b.start),
    caret: start + token.length + 1,
  };
}

/** The text as it's sent (trimmed, as coach.send trims it), its references moved to match. */
export function trimMentions(
  text: string,
  mentions: readonly CoachMention[],
): { text: string; mentions: CoachMention[] } {
  const trimmed = text.trim();
  const shift = text.length - text.trimStart().length;
  return {
    text: trimmed,
    mentions: mentions
      .map((mention) => ({ ...mention, start: mention.start - shift, end: mention.end - shift }))
      .filter((mention) => mention.start >= 0 && mention.end <= trimmed.length),
  };
}

/** A message cut into its plain text and its references, to draw them as links; all text when they don't fit it. */
export function mentionSegments(
  text: string,
  mentions: readonly CoachMention[] | undefined,
): (
  | { readonly text: string; readonly mention?: undefined }
  | { readonly text: string; readonly mention: CoachMention }
)[] {
  if (mentions === undefined || mentions.length === 0 || !mentionsValid(text, mentions)) return [{ text }];
  const segments: ({ text: string; mention?: undefined } | { text: string; mention: CoachMention })[] = [];
  let at = 0;
  for (const mention of mentions) {
    if (mention.start > at) segments.push({ text: text.slice(at, mention.start) });
    segments.push({ text: text.slice(mention.start, mention.end), mention });
    at = mention.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}

/** What @ offers: a reference's target, with what tells it apart from others of the same name. */
export interface MentionCandidate extends CoachMentionTarget {
  /** Where it is: a workspace's path, an agent's workspace. */
  readonly where: string;
  /** What it is: "Workspace", or the agent's runtime. */
  readonly what: string;
  /** An agent's runtime id (its icon). */
  readonly runtime?: string;
}

/**
 * What @ offers in Coach's composer: the workspaces Coach may read (`allowed`: its settings, or
 * every workspace with Full access), then the agents in them that aren't archived, latest first.
 */
export function mentionCandidates(
  state: Pick<AppState, "agents" | "workspaces" | "runtimes">,
  allowed: readonly string[],
): MentionCandidate[] {
  const workspaces = allowed.flatMap((id) => {
    const ws = state.workspaces[id];
    return ws === undefined
      ? []
      : [
          {
            kind: "workspace" as const,
            id,
            label: mentionLabel(ws.label, id),
            where: ws.path,
            what: "Workspace",
          },
        ];
  });
  const agents = Object.values(state.agents)
    .filter((agent) => agent.summary.role === "agent" && !agent.summary.archived)
    .filter((agent) => allowed.includes(agent.summary.workspaceId))
    // The one you last wrote to first, as in every agent list (byLastPersonInput, D-053).
    .sort((a, b) => b.summary.lastPersonInputAt - a.summary.lastPersonInputAt)
    .map((agent) => {
      const { runtime, title, workspaceId } = agent.summary;
      const what = state.runtimes[runtime]?.name ?? runtime;
      return {
        kind: "agent" as const,
        id: agent.id,
        label: mentionLabel(title ?? "", what),
        where: state.workspaces[workspaceId]?.label ?? workspaceId,
        what,
        runtime,
      };
    });
  return [...workspaces, ...agents];
}
