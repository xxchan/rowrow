// Review comments waiting to be sent, shown on top of the composer: on diff lines (Changes) or
// on passages the agent wrote (select text in the transcript). "Add to message" compiles
// them into one "Review feedback" message in this agent's draft; you still press send.
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight, MessageSquareText, X } from "lucide-react";
import {
  annotationsFor,
  compileFeedback,
  removeAnnotations,
  useAnnotations,
  type Annotation,
} from "../lib/annotations.ts";
import { setDraft, useDrafts } from "../lib/store.ts";

export function ReviewDrawer({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const items = useAnnotations((s) => s.items);
  const annotations = annotationsFor(items, workspaceId);
  const draft = useDrafts((s) => s.byAgent[agentId] ?? "");
  if (annotations.length === 0) return null;
  const ids = new Set(annotations.map((a) => a.id));
  const label = `${annotations.length} review ${annotations.length === 1 ? "comment" : "comments"}`;
  return (
    <Collapsible className="group/review border-b bg-muted/40">
      <CollapsibleTrigger
        aria-label={`Show ${label}`}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <MessageSquareText className="size-3.5 text-primary" />
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/review:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-56 space-y-1 overflow-y-auto px-2">
          {annotations.map((a) => (
            <li key={a.id} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] text-muted-foreground">{where(a)}</div>
                <div className="line-clamp-2 text-sm">{a.comment}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                aria-label="Remove"
                onClick={() => removeAnnotations(new Set([a.id]))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-1.5 px-3 py-2">
          <Button variant="ghost" size="sm" onClick={() => removeAnnotations(ids)}>
            Clear all
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const feedback = compileFeedback(annotations);
              setDraft(agentId, draft.trim() === "" ? feedback : `${draft.trimEnd()}\n\n${feedback}`);
              removeAnnotations(ids);
            }}
          >
            Add to message
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function where(a: Annotation): string {
  if (a.source.kind === "diff") return `${a.source.path}:${a.source.line}`;
  const quote = a.source.quote.replaceAll(/\s+/g, " ").trim();
  return `“${quote.length > 80 ? `${quote.slice(0, 79)}…` : quote}”`;
}
