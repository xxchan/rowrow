// Records written by older oar, read the way the oar we run expects them. The log keeps what was
// recorded (it is the truth); the folds read it through here.
import type { RawEvent } from "@botiverse/oar";

/**
 * Before oar 0.14 a tool's result was `tool_call_ended.output`, a string; now it is `content`,
 * ordered parts. An old result becomes one text part, so old transcripts keep their output.
 */
export function upgradeRecord(record: RawEvent): RawEvent {
  if (record.kind !== "frame") return record;
  let changed = false;
  const events = record.body.events.map((event) => {
    if (event.kind !== "tool_call_ended" || event.content !== undefined) return event;
    const { output, ...rest } = event as typeof event & { output?: unknown };
    if (typeof output !== "string") return event;
    changed = true;
    return { ...rest, content: [{ type: "text" as const, text: output }] };
  });
  return changed ? { ...record, body: { ...record.body, events } } : record;
}
