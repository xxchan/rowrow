// Commands run in a workspace (D-052): a box to type one, the runs the server keeps (newest
// first; one click runs one again), and a run's output as it prints, with Stop while it runs.
// "Send to agent" puts the command, how it ended and the end of its output in an agent's
// composer, for you to edit and send (PRINCIPLES.md, product 4).
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  CircleCheck,
  CircleSlash,
  CircleX,
  Copy,
  LoaderCircle,
  RotateCw,
  Send,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  appendOutput,
  commandReport,
  NO_OUTPUT,
  outputString,
  RUNS_KEPT,
  runDuration,
  runOutcome,
  terminalText,
  type CommandRun,
  type OutputText,
} from "../../shared/commands.ts";
import { byPin } from "../../shared/schemas.ts";
import { agentListed, workspaceArchived } from "../../shared/workspaces.ts";
import { ago, title } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { setDraft, useApp, useClient, useDrafts } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { useNow } from "../lib/use-now.ts";
import { ErrorText } from "./ErrorText.tsx";

/**
 * `agentId`: the agent beside it, the one "Send to agent" fills (otherwise it offers the
 * workspace's agents and opens the one you pick). `onDelivered` runs once it has.
 */
export function CommandsTab({
  workspaceId,
  agentId,
  onDelivered,
}: {
  workspaceId: string;
  agentId?: string;
  onDelivered?: () => void;
}) {
  const client = useClient();
  const runs = useCommandRuns(workspaceId);
  const archived = useApp((s) => s.state !== null && workspaceArchived(s.state.workspaces, workspaceId));
  const path = useApp((s) => s.state?.workspaces[workspaceId]?.path ?? "");
  const [command, setCommand] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // The run just started, until the list the server sends has it.
  const [started, setStarted] = useState<CommandRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (text: string): Promise<void> => {
    if (client === null || text.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const run = await client.commands.run({ workspaceId, command: text });
      setStarted(run);
      setSelected(run.id);
      setCommand("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const current =
    selected === null
      ? undefined
      : (runs?.find((run) => run.id === selected) ?? (started?.id === selected ? started : undefined));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex shrink-0 items-center gap-2 border-b px-2 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void start(command);
        }}
      >
        <Input
          aria-label="Command"
          value={command}
          onChange={(event) => setCommand(event.currentTarget.value)}
          placeholder={archived ? "Archived: unarchive it to run commands" : "A command, e.g. pnpm test"}
          disabled={archived}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          className="h-8 font-mono"
        />
        <Button
          type="submit"
          size="sm"
          disabled={archived || busy || client === null || command.trim() === ""}
        >
          {busy && <LoaderCircle className="animate-spin" />} Run
        </Button>
      </form>
      {error !== null && <ErrorText className="shrink-0 px-3 pt-2 text-xs">{error}</ErrorText>}
      {current !== undefined ? (
        <RunView
          key={current.id}
          run={current}
          workspaceId={workspaceId}
          {...(agentId === undefined ? {} : { agentId })}
          {...(onDelivered === undefined ? {} : { onDelivered })}
          canRun={!archived}
          onBack={() => setSelected(null)}
          onRerun={() => void start(current.command)}
        />
      ) : runs === null ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Loading commands
        </div>
      ) : runs.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">
          {`Runs in ${path} on the server, without a terminal or input: tests, git status, a dev server. The newest ${RUNS_KEPT} runs stay here until the server restarts.`}
        </p>
      ) : (
        <ul aria-label="Commands run here" className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center gap-1 rounded-md hover:bg-accent/60">
              <button
                type="button"
                onClick={() => setSelected(run.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              >
                <RunIcon run={run} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[12px]">{run.command}</span>
                  <RunFacts run={run} className="text-[11px]" />
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Run again: ${run.command}`}
                title="Run again"
                disabled={archived || busy}
                onClick={() => void start(run.command)}
              >
                <RotateCw />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A workspace's runs as the server keeps them, live (null until the first list arrives). */
function useCommandRuns(workspaceId: string): readonly CommandRun[] | null {
  const client = useClient();
  const [runs, setRuns] = useState<{ workspaceId: string; runs: readonly CommandRun[] } | null>(null);
  useEffect(() => {
    if (client === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const stream = await client.commands.watch({ workspaceId }, { signal: controller.signal });
        for await (const message of stream) setRuns({ workspaceId, runs: message.runs });
      } catch (error) {
        if (!controller.signal.aborted) report("warn", "commands.watch_failed", error, { workspaceId });
      }
    })();
    return () => controller.abort();
  }, [client, workspaceId]);
  return runs?.workspaceId === workspaceId ? runs.runs : null;
}

/** A run's output, live; after a reconnect it resumes where it was. */
function useCommandOutput(runId: string): { output: OutputText; error: string | null } {
  const client = useClient();
  const [state, setState] = useState<{ output: OutputText; error: string | null }>({
    output: NO_OUTPUT,
    error: null,
  });
  const cursor = useRef(0);
  useEffect(() => {
    if (client === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const stream = await client.commands.output(
          { runId, after: cursor.current },
          { signal: controller.signal },
        );
        for await (const event of stream) {
          if (event.kind !== "output") continue;
          cursor.current = event.at + event.text.length;
          setState((s) => ({ output: appendOutput(s.output, event.at, event.text), error: null }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        report("warn", "commands.output_failed", error, { runId });
        setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    return () => controller.abort();
  }, [client, runId]);
  return state;
}

function RunView({
  run,
  workspaceId,
  agentId,
  onDelivered,
  canRun,
  onBack,
  onRerun,
}: {
  run: CommandRun;
  workspaceId: string;
  agentId?: string;
  onDelivered?: () => void;
  canRun: boolean;
  onBack: () => void;
  onRerun: () => void;
}) {
  const client = useClient();
  const { output, error } = useCommandOutput(run.id);
  const text = useMemo(() => terminalText(outputString(output)), [output]);
  const { scrollRef, contentRef } = useStickToBottom({ initial: "instant", resize: "instant" });
  const running = run.status === "running";

  const stop = async (): Promise<void> => {
    if (client === null) return;
    try {
      await client.commands.stop({ runId: run.id });
    } catch (err) {
      toast.error(`Couldn't stop it: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Back to commands"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <RunIcon run={run} />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium" title={run.command}>
            {run.command}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-1">
          <RunFacts run={run} className="mr-auto text-xs" />
          {running ? (
            <Button size="xs" variant="destructive" disabled={run.stopping} onClick={() => void stop()}>
              {run.stopping ? <LoaderCircle className="animate-spin" /> : <Square />} Stop
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={!canRun} onClick={onRerun}>
              <RotateCw /> <span className="max-sm:sr-only">Run again</span>
            </Button>
          )}
          <SendToAgent
            run={run}
            output={output}
            workspaceId={workspaceId}
            {...(agentId === undefined ? {} : { agentId })}
            {...(onDelivered === undefined ? {} : { onDelivered })}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Copy output"
            title="Copy output"
            disabled={text === ""}
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => toast.success("Copied the output"));
            }}
          >
            <Copy />
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-code">
        <div ref={contentRef}>
          {error !== null && <ErrorText className="px-3 pt-2 text-xs">{error}</ErrorText>}
          {run.status === "failed" ? (
            <ErrorText className="px-3 py-2 text-xs">{`It couldn't start: ${run.error ?? "unknown error"}`}</ErrorText>
          ) : text === "" ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {running ? "No output yet." : "It printed nothing."}
            </p>
          ) : (
            <pre
              aria-label="Output"
              tabIndex={0}
              className="px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
            >
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Fill an agent's composer with the run: the agent beside it, or one of the workspace's agents
 * (pinned first, then the most recently active), whose page it opens.
 */
function SendToAgent({
  run,
  output,
  workspaceId,
  agentId,
  onDelivered,
}: {
  run: CommandRun;
  output: OutputText;
  workspaceId: string;
  agentId?: string;
  onDelivered?: () => void;
}) {
  const state = useApp((s) => s.state);
  const drafts = useDrafts((s) => s.byAgent);
  const deliver = (target: string): void => {
    const message = commandReport(run, outputString(output));
    const draft = drafts[target] ?? "";
    setDraft(target, draft.trim() === "" ? message : `${draft.trimEnd()}\n\n${message}`);
    if (target !== agentId) navigate(`/a/${target}`);
    onDelivered?.();
  };
  if (agentId !== undefined)
    return (
      <Button size="xs" variant="outline" onClick={() => deliver(agentId)}>
        <Send /> Send to agent
      </Button>
    );
  const agents =
    state === null
      ? []
      : Object.values(state.agents)
          .filter((a) => a.summary.workspaceId === workspaceId && agentListed(state.workspaces, a))
          .sort((a, b) => byPin(a, b) || b.summary.lastActivityAt - a.summary.lastActivityAt);
  if (agents.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="outline">
          <Send /> Send to agent
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Into its message box, to edit and send
        </DropdownMenuLabel>
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => deliver(agent.id)}>
            <span className="truncate">{title(agent)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How it ended, at a glance; RunFacts beside it says it in words. */
function RunIcon({ run }: { run: CommandRun }) {
  const icon = "size-3.5 shrink-0";
  switch (run.status) {
    case "running":
      return <LoaderCircle aria-hidden className={cn(icon, "animate-spin text-muted-foreground")} />;
    case "stopped":
      return <CircleSlash aria-hidden className={cn(icon, "text-muted-foreground")} />;
    case "failed":
      return <TriangleAlert aria-hidden className={cn(icon, "text-destructive")} />;
    case "exited":
      return run.exitCode === 0 ? (
        <CircleCheck aria-hidden className={cn(icon, "text-success")} />
      ) : (
        <CircleX aria-hidden className={cn(icon, "text-destructive")} />
      );
  }
}

/** "exit 1 · 2.3s · 5m ago", or "running · 12s". */
function RunFacts({ run, className }: { run: CommandRun; className?: string }) {
  const now = useNow(run.status === "running" ? 1000 : 30_000);
  const took = runDuration((run.endedAt ?? now) - run.startedAt);
  const when = ago(run.startedAt, now);
  return (
    <span className={cn("truncate text-muted-foreground tabular-nums", className)}>
      {[runOutcome(run), took, run.status === "running" ? null : when === "now" ? "just now" : `${when} ago`]
        .filter((part) => part !== null)
        .join(" · ")}
    </span>
  );
}
