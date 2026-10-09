// Fast mode (D-049): which tier is each runtime's Fast with which model, what the summary says
// is in effect (the runtime's report over what you asked for), and how a switch reads.
import type { RawEvent } from "@botiverse/oar";
import { describe, expect, it } from "vitest";
import type { Entry, EntryBody } from "../src/shared/entries.ts";
import { renderText } from "../src/shared/render-text.ts";
import type { ModelInfo } from "../src/shared/schemas.ts";
import { fastOn, fastTier, fastTierOf, tierWords } from "../src/shared/service-tier.ts";
import { summaryOf } from "../src/shared/summary.ts";
import { switches, timelineOf } from "../src/shared/timeline.ts";

const ME = { kind: "device", deviceId: "d1", name: "phone" } as const;
let seq = 0;
const entry = (body: EntryBody): Entry => ({ ...body, seq: seq++, at: 1000 + seq });
const frame = (events: unknown[], agentPath: string[] = []): Entry =>
  entry({
    kind: "oar",
    runId: "r1",
    record: {
      kind: "frame",
      sessionId: "s1",
      agentPath,
      seq,
      receivedAt: 2000 + seq,
      body: { type: "thread/started", native: null, events },
    } as unknown as RawEvent,
  });
const model = (id: string, serviceTiers: string[] = []): ModelInfo => ({
  id,
  name: id,
  effortLevels: [],
  defaultEffort: null,
  serviceTiers,
});

describe("the Fast tier", () => {
  it("is codex's priority and claude's fast, and only with a model that lists it", () => {
    expect(fastTierOf("codex")).toBe("priority");
    expect(fastTierOf("claude")).toBe("fast");
    const codex = [model("gpt-5.5", ["priority", "flex"]), model("gpt-5-mini", ["flex"]), model("o3")];
    expect(fastTier("codex", codex, "gpt-5.5")).toBe("priority");
    expect(fastTier("codex", codex, "gpt-5-mini")).toBeNull();
    expect(fastTier("codex", codex, "o3")).toBeNull();
    // A model it doesn't list (or a list that didn't load): nothing to switch.
    expect(fastTier("codex", codex, "gpt-6")).toBeNull();
    expect(fastTier("codex", [], "gpt-5.5")).toBeNull();
    // claude's catalog never says priority, nor codex's fast.
    expect(fastTier("claude", [model("opus", ["fast"]), model("sonnet")], "opus")).toBe("fast");
    expect(fastTier("claude", [model("opus", ["priority"])], "opus")).toBeNull();
    expect(fastTier("codex", [model("gpt-5.5", ["fast"])], "gpt-5.5")).toBeNull();
  });

  it("with the default model: the one the runtime reported running, else the first listed", () => {
    const codex = [model("gpt-5.5", ["priority"]), model("gpt-5-mini", ["flex"])];
    expect(fastTier("codex", codex, null)).toBe("priority");
    expect(fastTier("codex", codex, null, "gpt-5-mini")).toBeNull();
    expect(fastTier("codex", codex, null, "gpt-unlisted")).toBe("priority");
  });

  it("reads as on, off, the runtime's own setting, or another tier", () => {
    expect(tierWords("priority")).toBe("Fast mode on");
    expect(tierWords("fast")).toBe("Fast mode on");
    expect(tierWords("default")).toBe("Fast mode off");
    expect(tierWords(null)).toBe("Fast mode as the runtime is set");
    expect(tierWords("flex")).toBe("service tier flex");
  });
});

describe("the summary's service tier", () => {
  const created = (serviceTier?: string): Entry =>
    entry({
      kind: "agent.created",
      workspaceId: "w",
      runtime: "codex",
      by: ME,
      ...(serviceTier === undefined ? {} : { serviceTier }),
    });
  const started = (): Entry =>
    entry({ kind: "run.started", runId: "r1", runtime: "codex", cwd: "/w", sessionId: "s1" });

  it("is what the runtime reported over what you asked for, and nothing before either", () => {
    seq = 0;
    const fresh = summaryOf([created()]);
    expect([fresh.serviceTier, fresh.reportedServiceTier, fastOn(fresh)]).toEqual([null, null, false]);

    // Its own settings turned Fast on: the report says so though you never asked.
    const configured = summaryOf([
      created(),
      started(),
      frame([{ kind: "service_tier", serviceTier: "priority" }]),
    ]);
    expect([configured.serviceTier, configured.reportedServiceTier, fastOn(configured)]).toEqual([
      null,
      "priority",
      true,
    ]);

    seq = 0;
    const asked = summaryOf([created("priority")]);
    expect([asked.serviceTier, fastOn(asked)]).toEqual(["priority", true]);
    // A sub-agent's report isn't the agent's.
    const sub = summaryOf([
      created("priority"),
      started(),
      frame([{ kind: "service_tier", serviceTier: "default" }], ["a"]),
    ]);
    expect(sub.reportedServiceTier).toBeNull();
  });

  it("forgets the old run's report when you switch, until the next run reports its own", () => {
    seq = 0;
    const before = [created(), started(), frame([{ kind: "service_tier", serviceTier: "priority" }])];
    const switched = [
      ...before,
      entry({ kind: "agent.updated", changes: { serviceTier: "default" }, by: ME }),
    ];
    const off = summaryOf(switched);
    expect([off.serviceTier, off.reportedServiceTier, fastOn(off)]).toEqual(["default", null, false]);
    // A rename leaves the report alone.
    const renamed = summaryOf([...before, entry({ kind: "agent.updated", changes: { title: "x" }, by: ME })]);
    expect(renamed.reportedServiceTier).toBe("priority");
    const reported = summaryOf([...switched, frame([{ kind: "service_tier", serviceTier: "default" }])]);
    expect(reported.reportedServiceTier).toBe("default");
  });

  it("doesn't end a run of text, like the model and effort reports", () => {
    seq = 0;
    const s = summaryOf([
      created(),
      started(),
      frame([{ kind: "text_delta", text: "Hel" }]),
      frame([{ kind: "service_tier", serviceTier: "priority" }]),
      frame([{ kind: "text_delta", text: "lo" }]),
    ]);
    expect(s.preview).toBe("Hello");
  });
});

describe("a switch in the transcript", () => {
  it("says what changed that the next message runs on", () => {
    expect(switches({ serviceTier: "priority" })).toBe("Fast mode on");
    expect(switches({ model: "gpt-5.5", effort: null, serviceTier: "default" })).toBe(
      "model: gpt-5.5, effort: default, Fast mode off",
    );
    expect(switches({ title: "renamed" })).toBeNull();
  });

  it("shows in `rowrow agent view`, and the run says what it opened with", () => {
    seq = 0;
    const text = renderText(
      timelineOf([
        entry({ kind: "agent.created", workspaceId: "w", runtime: "codex", by: ME }),
        entry({ kind: "agent.updated", changes: { serviceTier: "priority" }, by: ME }),
        entry({
          kind: "run.started",
          runId: "r1",
          runtime: "codex",
          model: "gpt-5.5",
          effort: "high",
          serviceTier: "priority",
          cwd: "/w",
          sessionId: "s1",
        }),
      ]),
    );
    expect(text).toContain("· switched Fast mode on (phone)");
    expect(text).toContain("── run r1 · codex · gpt-5.5 · high · Fast mode on ──");
  });
});
