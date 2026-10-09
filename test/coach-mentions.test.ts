// Coach's references (roamgate #375): where an @ query is, how a picked reference binds to its
// "@label" text and stays bound (or not) as the text changes, how a message is checked and drawn,
// and what @ offers.
import { describe, expect, it } from "vitest";
import {
  adjustMentions,
  insertMention,
  MAX_MENTIONS,
  mentionCandidates,
  mentionLabel,
  mentionQuery,
  mentionSegments,
  mentionsValid,
  trimMentions,
  type CoachMention,
} from "../src/shared/coach-mentions.ts";
import type { AppState } from "../src/shared/schemas.ts";

const agent = { kind: "agent", id: "ag_1", label: "fix login" } as const;
const ws = { kind: "workspace", id: "ws_1", label: "rowrow" } as const;

describe("an @ query", () => {
  it("starts at an @ at the caret, not inside a word or after a space", () => {
    expect(mentionQuery("ask @fi", 7)).toEqual({ start: 4, end: 7, query: "fi" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionQuery("看@fi", 4)).toEqual({ start: 1, end: 4, query: "fi" });
    expect(mentionQuery("mail me@example", 15)).toBeNull();
    expect(mentionQuery("ask @fix it", 11)).toBeNull();
    expect(mentionQuery("ask @fi", 5, 7)).toBeNull();
    expect(mentionQuery("no at", 5)).toBeNull();
  });
});

describe("a reference's binding", () => {
  it("inserts @label and a space for the query, and puts the caret after them", () => {
    const next = insertMention("is @fi done?", [], agent, 3, 6);
    expect(next.text).toBe("is @fix login  done?");
    expect(next.mentions).toEqual([{ ...agent, start: 3, end: 13 }]);
    expect(next.caret).toBe(14);
    expect(mentionsValid(next.text, next.mentions)).toBe(true);
  });

  it("keeps references in order, moving the ones after a new one", () => {
    const first = insertMention("@ and ", [], ws, 0, 1);
    const second = insertMention(first.text, first.mentions, agent, 0, 0);
    expect(second.text).toBe("@fix login @rowrow  and ");
    expect(second.mentions.map((m) => [m.id, m.start, m.end])).toEqual([
      ["ag_1", 0, 10],
      ["ws_1", 11, 18],
    ]);
  });

  it("moves with edits before or after it, and unbinds when its own text changes", () => {
    const mentions: CoachMention[] = [{ ...agent, start: 3, end: 13 }];
    const text = "is @fix login done?";
    expect(adjustMentions(text, `so ${text}`, mentions)).toEqual([{ ...agent, start: 6, end: 16 }]);
    expect(adjustMentions(text, `${text} really`, mentions)).toEqual(mentions);
    expect(adjustMentions(text, "is @fix logn done?", mentions)).toEqual([]);
    expect(adjustMentions(text, "is @fix l0gin done?", mentions)).toEqual([]);
    expect(adjustMentions(text, "is @Fix login done?", mentions)).toEqual([]);
    expect(adjustMentions(text, "is done?", mentions)).toEqual([]);
  });

  it("trusts where the browser says the edit was over guessing from the text", () => {
    // Typing "n" right after "@fix login": the text alone reads as if "login" grew.
    const mentions: CoachMention[] = [{ ...agent, start: 0, end: 10 }];
    expect(adjustMentions("@fix login", "@fix loginn", mentions, { start: 10, end: 10 })).toEqual(mentions);
    // A backspace after it deletes what follows, not the reference.
    const spaced = "@fix login x";
    expect(
      adjustMentions(spaced, "@fix login ", mentions, {
        start: 12,
        end: 12,
        inputType: "deleteContentBackward",
      }),
    ).toEqual(mentions);
    expect(
      adjustMentions(spaced, "@fix logi x", mentions, {
        start: 10,
        end: 10,
        inputType: "deleteContentBackward",
      }),
    ).toEqual([]);
  });

  it("leaves a name typed or pasted as plain text", () => {
    expect(adjustMentions("", "is @fix login done?", [])).toEqual([]);
  });
});

describe("a message's references", () => {
  it("are valid only at their exact @label, in order, without overlap, 32 at most", () => {
    const text = "@fix login and @rowrow";
    const both: CoachMention[] = [
      { ...agent, start: 0, end: 10 },
      { ...ws, start: 15, end: 22 },
    ];
    expect(mentionsValid(text, both)).toBe(true);
    expect(mentionsValid(text, [...both].reverse())).toBe(false);
    expect(mentionsValid(text, [{ ...agent, start: 1, end: 11 }])).toBe(false);
    expect(mentionsValid(text, [{ ...ws, start: 15, end: 30 }])).toBe(false);
    expect(mentionsValid("@a\nb", [{ ...ws, label: "a\nb", start: 0, end: 4 }])).toBe(false);
    const many = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => ({
      ...ws,
      label: "x",
      start: i * 2,
      end: i * 2 + 2,
    }));
    expect(mentionsValid("@x".repeat(MAX_MENTIONS + 1), many)).toBe(false);
    expect(mentionsValid("@x".repeat(MAX_MENTIONS), many.slice(0, MAX_MENTIONS))).toBe(true);
  });

  it("move with the text when it's trimmed to send", () => {
    const sent = trimMentions("  @rowrow ok \n", [{ ...ws, start: 2, end: 9 }]);
    expect(sent).toEqual({ text: "@rowrow ok", mentions: [{ ...ws, start: 0, end: 7 }] });
    expect(mentionsValid(sent.text, sent.mentions)).toBe(true);
  });

  it("cut a message into text and links, or leave it all text when they don't fit it", () => {
    const mention: CoachMention = { ...ws, start: 3, end: 10 };
    expect(mentionSegments("in @rowrow now", [mention])).toEqual([
      { text: "in " },
      { text: "@rowrow", mention },
      { text: " now" },
    ]);
    expect(mentionSegments("in rowrow now", [mention])).toEqual([{ text: "in rowrow now" }]);
    expect(mentionSegments("plain", undefined)).toEqual([{ text: "plain" }]);
  });

  it("carry a label of one line", () => {
    expect(mentionLabel("  fix\nthe\tlogin ", "x")).toBe("fix the login");
    expect(mentionLabel("\n", "Claude Code")).toBe("Claude Code");
    expect(mentionLabel("y".repeat(300), "x")).toHaveLength(200);
  });
});

describe("what @ offers", () => {
  it("the workspaces Coach may read, then their agents not archived, latest first, with where and what", () => {
    const summary = (id: string, workspaceId: string, at: number, extra: object = {}) => ({
      id,
      summary: {
        role: "agent",
        archived: false,
        title: id,
        runtime: "claude",
        workspaceId,
        lastActivityAt: at,
        ...extra,
      },
    });
    const state = {
      workspaces: {
        ws_a: { id: "ws_a", label: "app", path: "/src/app" },
        ws_b: { id: "ws_b", label: "app", path: "/src/other/app" },
        ws_c: { id: "ws_c", label: "secret", path: "/src/secret" },
      },
      agents: {
        old: summary("old", "ws_a", 1),
        new: summary("new", "ws_b", 2, { title: null }),
        gone: summary("gone", "ws_a", 3, { archived: true }),
        hidden: summary("hidden", "ws_c", 4),
      },
      runtimes: { claude: { name: "Claude Code" } },
    } as unknown as Pick<AppState, "agents" | "workspaces" | "runtimes">;
    expect(mentionCandidates(state, ["ws_a", "ws_b"])).toEqual([
      { kind: "workspace", id: "ws_a", label: "app", where: "/src/app", what: "Workspace" },
      { kind: "workspace", id: "ws_b", label: "app", where: "/src/other/app", what: "Workspace" },
      {
        kind: "agent",
        id: "new",
        label: "Claude Code",
        where: "app",
        what: "Claude Code",
        runtime: "claude",
      },
      { kind: "agent", id: "old", label: "old", where: "app", what: "Claude Code", runtime: "claude" },
    ]);
  });
});
