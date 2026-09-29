// What the agent runs on, next to where you write to it: its model, effort and how full its
// context is at a glance, the rest of the session one tap away. Each value is what the
// runtime reported, or else what you asked for; a value nobody reported says so.
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Cpu } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AgentState } from "../../shared/schemas.ts";
import { ago, formatTokens } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";
import { useNow } from "../lib/use-now.ts";

export function SessionInfo({ agent, onSwitchModel }: { agent: AgentState; onSwitchModel: () => void }) {
  const { summary } = agent;
  const runtimeName = useApp((s) => s.state?.runtimes[summary.runtime]?.name) ?? summary.runtime;
  const [open, setOpen] = useState(false);
  const now = useNow(open ? 5000 : 60_000);
  const model = summary.reportedModel ?? summary.model;
  const effort = summary.reportedEffort ?? summary.effort;
  const context = summary.context;
  const percent = context?.percent ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Session details"
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <span className="truncate">{model ?? "Default model"}</span>
          {effort !== null && (
            <span className="shrink-0">
              <span aria-hidden className="pr-1.5">
                ·
              </span>
              {effort}
            </span>
          )}
          {percent !== null && (
            <span className={cn("flex shrink-0 items-center gap-1", fullness(percent))}>
              <ContextRing percent={percent} />
              {formatPercent(percent)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        className="w-[min(20rem,calc(100vw-1.5rem))] p-0"
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-xs">
          <Row label="Runtime">{runtimeName}</Row>
          <Row label="Model">
            {model ?? "The runtime's default"}
            {summary.model === null
              ? model !== null && <Note>the runtime's default</Note>
              : summary.model !== model && <Note>{`you asked for ${summary.model}`}</Note>}
          </Row>
          <Row label="Effort">{effort ?? <span className="text-muted-foreground">Default</span>}</Row>
          <Row label="Context">
            {context === null || context.tokens === null ? (
              <span className="text-muted-foreground">
                {context === null ? "Not reported yet" : "Unknown until the next answer"}
              </span>
            ) : (
              <>
                {context.contextWindow === null
                  ? `${formatTokens(context.tokens)} tokens`
                  : `${formatTokens(context.tokens)} of ${formatTokens(context.contextWindow)}`}
                {percent !== null && (
                  <>
                    <span className={cn("pl-1.5", fullness(percent))}>{formatPercent(percent)}</span>
                    <div
                      role="meter"
                      aria-label="Context used"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(percent)}
                      className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted-foreground/20"
                    >
                      <div
                        className={cn("h-full rounded-full bg-current", fullness(percent, "text-primary"))}
                        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </Row>
          <Row label="Tokens">
            {summary.usage === null ? (
              <span className="text-muted-foreground">Not reported yet</span>
            ) : (
              `${formatTokens(summary.usage.input)} in · ${formatTokens(summary.usage.output)} out`
            )}
          </Row>
          <Row label="Session">
            {summary.sessionId === null ? (
              <span className="text-muted-foreground">Starts with the first message</span>
            ) : (
              <span className="font-mono break-all select-all">{summary.sessionId}</span>
            )}
          </Row>
          <Row label="Process">
            {summary.run === null ? (
              <span className="text-muted-foreground">Not running; the next message starts it</span>
            ) : (
              `Running, started ${startedAgo(summary.run.since, now)}`
            )}
          </Row>
        </dl>
        {!summary.archived && (
          <div className="border-t p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                setOpen(false);
                onSwitchModel();
              }}
            >
              <Cpu /> Model and effort…
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 tabular-nums">{children}</dd>
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <span className="block text-muted-foreground">{children}</span>;
}

/** Warn as the context fills up: that's when an agent starts compacting or forgetting. */
function fullness(percent: number, otherwise = ""): string {
  return percent >= 90 ? "text-destructive" : percent >= 75 ? "text-warning" : otherwise;
}

function startedAgo(at: number, now: number): string {
  const since = ago(at, now);
  return since === "now" ? "just now" : `${since} ago`;
}

function formatPercent(percent: number): string {
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function ContextRing({ percent }: { percent: number }) {
  const r = 5.5;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * circumference;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={`${filled} ${circumference}`}
      />
    </svg>
  );
}
