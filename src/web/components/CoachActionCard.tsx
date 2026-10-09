// A Coach action's card (D-045), as roamgate's Ranger shows one (notes: ranger-spec.md 2.4):
// the operation and a status pill, its target and every parameter, the exact text it sends with
// its length, and what rowrow says about it: "Waiting for your confirmation. Nothing has been
// executed." until you Confirm or Cancel, then rowrow's receipt. Confirm waits until Coach has
// finished its answer, and one action runs at a time.
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import {
  ACTION_NAMES,
  statusWord,
  type CoachActionState,
  type CoachActionStatus,
} from "../../shared/coach-actions.ts";
import { useCoach } from "../lib/coach.ts";
import { useApp, useClient } from "../lib/store.ts";

const PILL: Record<CoachActionStatus, string> = {
  pending: "bg-primary/12 text-primary",
  executing: "bg-primary/12 text-primary",
  succeeded: "bg-success/15 text-success",
  failed: "bg-destructive/12 text-destructive",
  uncertain: "bg-warning/15 text-warning",
  cancelled: "bg-muted text-muted-foreground",
};

const WAIT = "Wait for Coach to finish before confirming or cancelling an action.";

const at = (time: number): string =>
  new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One action of Coach's current chat (the one its window shows). */
export function CoachActionCard({ action }: { action: CoachActionState }) {
  const client = useClient();
  const chatId = useApp((s) => s.state?.coach.chat?.id ?? null);
  const working = useApp((s) => s.state?.coach.chat?.summary.status.kind === "running");
  const executing = useApp(
    (s) => s.state?.coach.chat?.summary.coachActions.some((a) => a.status === "executing") ?? false,
  );
  const [deciding, setDeciding] = useState<"confirm" | "cancel" | null>(null);
  const card = useRef<HTMLElement>(null);
  const { proposal, status } = action;
  const name = ACTION_NAMES[proposal.kind];
  const pending = status === "pending";
  const agentAction = proposal.kind !== "create_worktree";

  const decide = async (how: "confirm" | "cancel"): Promise<void> => {
    if (client === null || chatId === null) return;
    setDeciding(how);
    card.current?.focus();
    useCoach.setState({ error: null });
    try {
      if (how === "confirm") await client.coach.confirm({ chatId, actionId: proposal.id });
      else await client.coach.cancel({ chatId, actionId: proposal.id });
    } catch (error) {
      useCoach.setState({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeciding(null);
    }
  };

  const rows: [string, ReactNode][] = [
    ["Workspace", <Ident key="ws" label={proposal.workspaceLabel} id={proposal.workspaceId} />],
    ...(proposal.agentId === undefined
      ? []
      : [
          [
            "Agent",
            <Ident key="agent" label={proposal.agentTitle ?? "Untitled"} id={proposal.agentId} />,
          ] as [string, ReactNode],
        ]),
    ["Proposed", at(action.proposedAt)],
    ...params(action),
  ];
  const details = (
    <dl className="grid max-h-80 grid-cols-[92px_minmax(0,1fr)] gap-x-2 gap-y-1 overflow-auto rounded-md bg-code px-2 py-1.5 text-[11px]">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <section
      ref={card}
      tabIndex={-1}
      aria-label={`${name} action`}
      className="grid min-w-0 gap-2 rounded-lg border bg-card px-2.5 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <strong className="font-semibold">{name}</strong>
        <span className={cn("shrink-0 rounded-full px-2 py-px text-[10px] font-medium", PILL[status])}>
          {statusWord(proposal.kind, status)}
        </span>
      </div>
      {agentAction ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <strong className="font-semibold [overflow-wrap:anywhere]">{proposal.workspaceLabel}</strong>
            {proposal.agentId !== undefined && (
              <>
                <Chip>{proposal.agentTitle ?? "Untitled"}</Chip>
                <Chip mono>{proposal.agentId}</Chip>
              </>
            )}
            {proposal.params.runtimeName !== undefined && <Chip>{proposal.params.runtimeName}</Chip>}
          </div>
          {proposal.kind === "start_agent" &&
            proposal.params.title !== null &&
            proposal.params.title !== undefined && (
              <span className="text-muted-foreground">
                Name <span className="text-foreground">{proposal.params.title}</span>
              </span>
            )}
          {pending && (
            <p className="text-muted-foreground">
              {proposal.kind === "send_prompt"
                ? "Review before sending. The agent may change files."
                : "Review before starting. The new agent may change files."}
            </p>
          )}
          <ExactText
            label={proposal.kind === "send_prompt" ? "Prompt" : "First message"}
            text={proposal.params.prompt ?? ""}
            open={pending || status === "executing"}
          />
          <Collapsible className="group/details min-w-0">
            <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <Caret group="details" />
              {`Details ${at(action.proposedAt)}`}
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-1.5 pt-1.5">
              <p className="text-muted-foreground">{proposal.summary}</p>
              {details}
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <>
          <p>{proposal.summary}</p>
          {details}
        </>
      )}
      <p
        role="status"
        className={cn(
          "[overflow-wrap:anywhere]",
          status === "failed"
            ? "text-destructive"
            : status === "uncertain"
              ? "text-warning"
              : "text-muted-foreground",
        )}
      >
        {action.detail}
      </p>
      {pending && (
        <div className="grid gap-1">
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="xs"
              className="min-h-11 text-[11px] md:min-h-7"
              disabled={client === null || working || executing || deciding !== null}
              onClick={() => void decide("confirm")}
            >
              {deciding === "confirm" && <LoaderCircle className="animate-spin" />}
              Confirm action
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="min-h-11 text-[11px] md:min-h-7"
              disabled={client === null || working || deciding !== null}
              onClick={() => void decide("cancel")}
            >
              Cancel
            </Button>
          </div>
          {working && <span className="text-[10px] text-muted-foreground">{WAIT}</span>}
        </div>
      )}
    </section>
  );
}

/** Each frozen parameter as its card lists it. */
function params(action: CoachActionState): [string, ReactNode][] {
  const { kind, params: p } = action.proposal;
  switch (kind) {
    case "create_worktree":
      return [
        ["Branch", <code key="branch">{p.branch}</code>],
        ["Base branch", p.base ?? ""],
        [
          "Setup hook",
          p.setupHook === null || p.setupHook === undefined ? (
            "(none configured)"
          ) : (
            <code key="hook">{p.setupHook}</code>
          ),
        ],
        ["Source repository", <code key="source">{p.sourcePath}</code>],
      ];
    case "start_agent":
      return [
        ["Runtime", `${p.runtimeName ?? p.runtime ?? ""} (${p.runtime ?? ""})`],
        ["Name", p.title ?? "(from its first message)"],
      ];
    case "send_prompt":
      return [];
  }
}

/** The exact text an action sends, with how long it is: open while it waits for you. */
function ExactText({ label, text, open: wanted }: { label: string; text: string; open: boolean }) {
  const [open, setOpen] = useState(wanted);
  const [was, setWas] = useState(wanted);
  if (was !== wanted) {
    setWas(wanted);
    setOpen(wanted);
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/text min-w-0">
      <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        <Caret group="text" />
        {`${label} — ${text.length.toLocaleString()} ${text.length === 1 ? "character" : "characters"}`}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        <pre
          tabIndex={0}
          aria-label={`Exact ${label.toLowerCase()}`}
          className="max-h-[280px] overflow-auto rounded-md bg-code px-2 py-1.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Caret({ group }: { group: "details" | "text" }) {
  return (
    <span aria-hidden className="text-[8px]">
      <span
        className={
          group === "text" ? "group-data-[state=open]/text:hidden" : "group-data-[state=open]/details:hidden"
        }
      >
        ▶
      </span>
      <span
        className={cn(
          "hidden",
          group === "text" ? "group-data-[state=open]/text:inline" : "group-data-[state=open]/details:inline",
        )}
      >
        ▼
      </span>
    </span>
  );
}

function Ident({ label, id }: { label: string; id: string }) {
  return (
    <>
      {label} <small className="font-mono text-[10px] text-muted-foreground">{id}</small>
    </>
  );
}

function Chip({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={cn(
        "max-w-full rounded border bg-muted/60 px-1.5 py-px text-[10px] text-muted-foreground [overflow-wrap:anywhere]",
        mono && "font-mono",
      )}
    >
      {children}
    </span>
  );
}
