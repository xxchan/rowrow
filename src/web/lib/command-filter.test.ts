import { describe, expect, it } from "vitest";
import { commandFilter } from "./command-filter.ts";

const agent = (title: string, id: string, workspace: string) =>
  [`agent:${id}`, [title, id, workspace, "scripted", "done", "main"]] as const;

describe("commandFilter", () => {
  it("matches words as typed, never letters scattered across an id and a workspace", () => {
    const [value, keywords] = agent("finished one", "ag_q8x1", "rowrow-e2e-repo-uNTjbR");
    expect(commandFilter(value, "quiet", keywords)).toBe(0);
    const [quietValue, quietKeywords] = agent("quiet one", "ag_4m4e", "rowrow-e2e-repo-uNTjbR");
    expect(commandFilter(quietValue, "quiet", quietKeywords)).toBe(1);
  });

  it("ranks the title first, then a word of it, then any field", () => {
    const [value, keywords] = agent("Fix the login page", "ag_1", "web");
    expect(commandFilter(value, "fix the", keywords)).toBe(1);
    expect(commandFilter(value, "login", keywords)).toBe(0.8);
    expect(commandFilter(value, "ogin pag", keywords)).toBe(0.6);
    expect(commandFilter(value, "web", keywords)).toBe(0.3);
    expect(commandFilter(value, "ag_1", keywords)).toBe(0.3);
    expect(commandFilter(value, "", keywords)).toBe(1);
  });
});
