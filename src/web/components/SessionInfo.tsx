// What the next message runs on, next to where you write it. At a glance: the model, the
// effort, and how full the context is (the one value that moves, and the one that asks you
// to act: quiet until it fills up). One tap: the same three in full, a way to change the
// model, and the fine print. Who and where (runtime, workspace, status) are the header's.
// Each value is what the runtime reported, else what you asked for; nobody's guess.
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AgentState } from "../../shared/schemas.ts";
import { formatTokens } from "../lib/format.ts";
import { report } from "../lib/telemetry.ts";

export function SessionInfo({ agent, onSwitchModel }: { agent: AgentState; onSwitchModel: () => void }) {
  const { summary } = agent;
  const [open, setOpen] = useState(false);
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
      <PopoverContent side="top" align="start" collisionPadding={12} className="w-72 p-0">
        <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-all">{model ?? "Default model"}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {provenance(summary.model, model, effort)}
              </p>
            </div>
            {!summary.archived && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-xs"
                aria-label="Change model and effort"
                onClick={() => {
                  setOpen(false);
                  onSwitchModel();
                }}
              >
                Change
              </Button>
            )}
          </div>
          <div className="text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Context</span>
              {context === null || context.tokens === null ? (
                <span className="text-muted-foreground">
                  {context === null ? "not reported yet" : "unknown until the next answer"}
                </span>
              ) : (
                <span className="tabular-nums">
                  {context.contextWindow === null
                    ? `${formatTokens(context.tokens)} tokens`
                    : `${formatTokens(context.tokens)} of ${formatTokens(context.contextWindow)}`}
                  {percent !== null && (
                    <span className={fullness(percent)}>{` · ${formatPercent(percent)}`}</span>
                  )}
                </span>
              )}
            </div>
            {percent !== null && (
              <div
                role="meter"
                aria-label="Context used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted-foreground/15"
              >
                <div
                  className={cn("h-full rounded-full bg-current", fullness(percent, "text-primary"))}
                  style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
              </div>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t px-4 py-2.5 text-xs text-muted-foreground">
          <dt>Tokens</dt>
          <dd className="tabular-nums">
            {summary.usage === null
              ? "not reported yet"
              : `${formatTokens(summary.usage.input)} in · ${formatTokens(summary.usage.output)} out`}
          </dd>
          <dt>Session</dt>
          <dd className="flex min-w-0 items-center gap-1">
            {summary.sessionId === null ? (
              "starts with the first message"
            ) : (
              <>
                <span className="truncate font-mono">{summary.sessionId}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="-my-1 size-6 shrink-0 text-muted-foreground [&_svg]:size-3.5"
                  aria-label="Copy session id"
                  onClick={() => void copy(summary.sessionId ?? "")}
                >
                  <Copy />
                </Button>
              </>
            )}
          </dd>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Session id copied");
  } catch (error) {
    toast.error(
      window.isSecureContext
        ? `Couldn't copy: ${error instanceof Error ? error.message : String(error)}`
        : "Couldn't copy: browsers allow it only over https or on localhost",
    );
    report("warn", "session_info.copy_failed", error);
  }
}

/** Where the model and effort come from, in one short line under the model's name. */
function provenance(asked: string | null, model: string | null, effort: string | null): string {
  const effortNote = effort === null ? "default effort" : `${effort} effort`;
  if (asked === null) {
    // With nothing reported, the name above already says "Default model".
    if (model === null) return capitalize(effortNote);
    return effort === null ? "Default model and effort" : `Default model · ${effortNote}`;
  }
  if (asked !== model) return `Asked for ${asked} · ${effortNote}`;
  return capitalize(effortNote);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Warn as the context fills up: that's when an agent starts compacting or forgetting. */
function fullness(percent: number, otherwise = ""): string {
  return percent >= 90 ? "text-destructive" : percent >= 75 ? "text-warning" : otherwise;
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
