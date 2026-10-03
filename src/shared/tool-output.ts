// A tool call's output, for screens that show text: what it streams while it runs, then the text
// of its result (oar 0.14: `content`, ordered parts; images and unknown blocks have no text).
import type { ToolOutputPart } from "@botiverse/oar";
import { toolResultText, type ViewPart } from "@botiverse/oar/observe";

export type ToolPart = Extract<ViewPart, { kind: "tool" }>;

export function toolText(part: ToolPart): string | undefined {
  return part.result === "running" ? part.output : (toolResultText(part.content) ?? part.output);
}

/** The images in a tool's result (a screenshot, a rendered page), in order. */
export function toolImages(part: ToolPart): Extract<ToolOutputPart, { type: "image" }>[] {
  return (part.content ?? []).filter((item) => item.type === "image");
}
