// What waits above the composer (D-035): messages steered into the running turn until the
// agent reads them, steers it never read, and the queue rowrow sends one per turn. A queued
// message can be taken back (Edit puts it into the composer, Delete drops it with an undo) or
// sent now; a steer can't be taken back, so it has no actions. On a phone each row has a ⋯
// menu, and a long press opens the same one.
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CircleAlert, CornerDownRight, Ellipsis, Paperclip } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Attachment, QueuePauseReason } from "../../shared/entries.ts";
import type { AgentState } from "../../shared/schemas.ts";
import { steerSupport, type QueuedInput } from "../../shared/summary.ts";
import type { Client } from "../lib/connection.ts";
import { useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";

const PAUSED: Record<QueuePauseReason, { title: string; action: string }> = {
  stopped: { title: "Queue paused · you stopped the turn", action: "Resume" },
  failed: { title: "Queue paused · the last turn failed", action: "Send next" },
  exited: { title: "Queue paused · the agent exited", action: "Send next" },
  restarted: { title: "Queue paused · rowrow restarted", action: "Send next" },
};

/** Rows shown before "+N more": the conversation stays in view. */
const SHOWN = 3;

type Row =
  | { kind: "steering" | "unread"; item: QueuedInput }
  | { kind: "queued"; item: QueuedInput; n: number };

interface Action {
  label: string;
  run: () => void;
  destructive?: boolean;
}

/** Take a held message back from the server; null (and a toast saying why) when it already went. */
export async function withdraw(
  client: Client,
  agentId: string,
  inputId: string,
): Promise<{ text: string; attachments: readonly Attachment[] } | null> {
  try {
    return await client.agents.withdraw({ agentId, inputId });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    report("warn", "queue.withdraw_failed", error, { agentId });
    return null;
  }
}

export function QueueTray({
  agent,
  onPutBack,
}: {
  agent: AgentState;
  /** Put a message into the composer, after whatever is there. */
  onPutBack: (text: string, attachments: readonly Attachment[]) => void;
}) {
  const client = useClient();
  const [expanded, setExpanded] = useState(false);
  const { queued, steering, unread, queuePaused, runtime } = agent.summary;
  const working = agent.attention === "working";
  const rows: Row[] = [
    ...steering.map((item): Row => ({ kind: "steering", item })),
    ...unread.map((item): Row => ({ kind: "unread", item })),
    ...queued.map((item, index): Row => ({ kind: "queued", item, n: index + 1 })),
  ];
  if (rows.length === 0 || client === null) return null;
  const visible = expanded ? rows : rows.slice(0, SHOWN);
  const hidden = rows.length - visible.length;

  const attempt = async (event: string, call: () => Promise<unknown>): Promise<void> => {
    try {
      await call();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      report("warn", event, error, { agentId: agent.id });
    }
  };
  const edit = async (item: QueuedInput): Promise<void> => {
    const taken = await withdraw(client, agent.id, item.inputId);
    if (taken !== null) onPutBack(taken.text, taken.attachments);
  };
  const remove = async (item: QueuedInput): Promise<void> => {
    const taken = await withdraw(client, agent.id, item.inputId);
    if (taken === null) return;
    toast("Deleted", {
      description: preview(taken.text),
      action: { label: "Undo", onClick: () => onPutBack(taken.text, taken.attachments) },
    });
  };
  // Idle there's no turn to steer into: it goes as the next turn, ahead of the paused queue.
  const now = working ? (steerSupport(runtime) === "no" ? null : "Steer now") : "Send now";
  const actionsOf = (row: Row): Action[] => {
    if (row.kind === "steering") return [];
    const { item } = row;
    return [
      { label: "Edit", run: () => void edit(item) },
      ...(row.kind === "queued" && now !== null
        ? [
            {
              label: now,
              run: () =>
                void attempt("queue.send_now_failed", () =>
                  client.agents.sendNow({ agentId: agent.id, inputId: item.inputId }),
                ),
            },
          ]
        : []),
      { label: "Delete", run: () => void remove(item), destructive: true },
    ];
  };

  return (
    <section
      aria-label="Up next"
      className="mb-2 overflow-hidden rounded-xl border bg-card/80 text-sm shadow-sm"
    >
      {queued.length > 0 && (
        <header className="flex min-h-9 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {queuePaused === null
              ? `Up next · ${queued.length} queued, sent one per turn`
              : PAUSED[queuePaused].title}
          </span>
          {queuePaused !== null && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0"
              onClick={() =>
                void attempt("queue.resume_failed", () => client.agents.resume({ agentId: agent.id }))
              }
            >
              {PAUSED[queuePaused].action}
            </Button>
          )}
        </header>
      )}
      <ul className="divide-y">
        {visible.map((row) => (
          <TrayRow
            key={row.item.inputId}
            row={row}
            note={noteOf(row, working, queuePaused)}
            actions={actionsOf(row)}
          />
        ))}
      </ul>
      {(hidden > 0 || expanded) && rows.length > SHOWN && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full border-t px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : `+${hidden} more`}
        </button>
      )}
    </section>
  );
}

function noteOf(row: Row, working: boolean, paused: QueuePauseReason | null): string {
  switch (row.kind) {
    case "steering":
      return working
        ? "Steering into this turn · the agent reads it at its next step · can't be taken back"
        : "Sent · waiting for the agent to read it · can't be taken back";
    case "unread":
      return "Not read · the agent dropped it when its turn was stopped or its process ended";
    case "queued":
      return paused !== null
        ? "Queued · waits until you send the queue on"
        : working
          ? "Queued · sends after this turn ends"
          : "Queued · sends next";
  }
}

function TrayRow({ row, note, actions }: { row: Row; note: string; actions: Action[] }) {
  const { item } = row;
  const body: ReactNode = (
    <li
      className={cn(
        "flex items-start gap-2.5 px-3 py-2",
        row.kind === "steering" && "m-1.5 rounded-lg border border-dashed border-primary/60 bg-primary/5",
      )}
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] text-muted-foreground tabular-nums">
        {row.kind === "queued" ? (
          row.n
        ) : row.kind === "steering" ? (
          <CornerDownRight className="size-3 text-primary" />
        ) : (
          <CircleAlert className="size-3" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {item.text !== "" && <p className="line-clamp-2 break-words whitespace-pre-wrap">{item.text}</p>}
        {item.attachments.length > 0 && (
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <Paperclip className="size-3 shrink-0" />
            {item.attachments.map((file) => file.name).join(", ")}
          </p>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      </div>
      {actions.length > 0 && (
        <>
          <div className="hidden shrink-0 items-center gap-0.5 md:flex">
            {actions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant="ghost"
                className={cn("h-7 px-2 text-xs", action.destructive === true && "text-destructive")}
                onClick={action.run}
              >
                {action.label}
              </Button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="-my-1 size-8 shrink-0 text-muted-foreground md:hidden"
                aria-label="Message actions"
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.map((action) => (
                <DropdownMenuItem
                  key={action.label}
                  variant={action.destructive === true ? "destructive" : "default"}
                  onSelect={action.run}
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </li>
  );
  if (actions.length === 0) return body;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((action) => (
          <ContextMenuItem
            key={action.label}
            variant={action.destructive === true ? "destructive" : "default"}
            onSelect={action.run}
          >
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A message's first line, short, for a toast. */
function preview(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
