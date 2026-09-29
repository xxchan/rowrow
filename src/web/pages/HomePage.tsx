// Home: every agent, the ones that need you first (PRINCIPLES.md, product 1). On a phone
// this is the screen you open from the home screen icon. Above the list, a composer starts
// the next agent (D-023); on a phone that's the New agent button at the bottom.
import { Button } from "@/components/ui/button";
import { Bot, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentState, AppState } from "../../shared/schemas.ts";
import { ATTENTION_RANK } from "../../shared/summary.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { NewAgentForm, useNewAgent } from "../components/NewAgentDialog.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { AgentAvatar } from "../components/AgentIcon.tsx";
import { ago, statusDot, title } from "../lib/format.ts";
import { RouterLink, type Route } from "../lib/router.ts";
import { AgentContextMenu } from "../components/AgentActions.tsx";
import { useApp } from "../lib/store.ts";
import { useNarrow } from "../lib/use-narrow.ts";
import { useNow } from "../lib/use-now.ts";

export function HomePage({ route }: { route: Route }) {
  const state = useApp((s) => s.state) as AppState;
  const open = useNewAgent((s) => s.open);
  const now = useNow(15_000);
  const narrow = useNarrow();
  const [draft, setDraft] = useState("");
  const hasWorkspace = Object.values(state.workspaces).some((w) => !w.archived);
  const agents = useMemo(
    () =>
      Object.values(state.agents)
        .filter((a) => !a.summary.archived)
        .sort(
          (a, b) =>
            ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
            b.summary.lastActivityAt - a.summary.lastActivityAt,
        ),
    [state.agents],
  );
  const groups: [string, AgentState[]][] = [
    ["Needs you", agents.filter((a) => a.attention === "blocked" || a.attention === "done")],
    ["Working", agents.filter((a) => a.attention === "working")],
    ["Idle", agents.filter((a) => a.attention === "idle")],
  ];

  return (
    <>
      <PageHeader
        title="Agents"
        route={route}
        actions={
          <Button size="sm" className="hidden md:inline-flex" onClick={() => open({})}>
            <Plus /> New agent
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!hasWorkspace ? (
          <EmptyState
            icon={<Bot />}
            title="Add a workspace to start"
            description="An agent is a conversation with Claude Code, Codex, Grok, Kimi or Pi, working in a folder on this machine. Start a few; rowrow tells you which one needs you."
            actions={<Button onClick={() => open({})}>New agent</Button>}
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-3 pt-4 pb-24 md:px-6 md:py-6">
            {!narrow && (
              <NewAgentForm
                variant="inline"
                context={{ kind: "anywhere" }}
                draft={draft}
                onDraft={setDraft}
                onDone={() => setDraft("")}
              />
            )}
            {agents.length === 0 ? (
              <EmptyState
                icon={<Bot />}
                title="No agents yet"
                description="An agent is a conversation with Claude Code, Codex, Grok, Kimi or Pi, working in a folder on this machine. Start a few; rowrow tells you which one needs you."
              />
            ) : (
              groups
                .filter(([, list]) => list.length > 0)
                .map(([name, list]) => (
                  <section key={name}>
                    <h2 className="px-2 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                      {`${name} · ${list.length}`}
                    </h2>
                    <ul className="divide-y overflow-hidden rounded-lg border bg-card">
                      {list.map((agent) => (
                        <AgentRow key={agent.id} agent={agent} state={state} now={now} />
                      ))}
                    </ul>
                  </section>
                ))
            )}
          </div>
        )}
      </div>
      {narrow && hasWorkspace && (
        <Button
          className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-20 h-12 rounded-full px-5 text-[15px] shadow-lg"
          onClick={() => open({})}
        >
          <Plus /> New agent
        </Button>
      )}
    </>
  );
}

function AgentRow({ agent, state, now }: { agent: AgentState; state: AppState; now: number }) {
  const dot = statusDot(agent, now);
  const ws = state.workspaces[agent.summary.workspaceId];
  const runtime = state.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime;
  const branch = ws?.git?.branch;
  const detail =
    agent.attention === "done" && agent.summary.lastError !== null
      ? agent.summary.lastError
      : (agent.summary.preview ?? "");
  return (
    <li>
      <AgentContextMenu agent={agent}>
        <RouterLink
          href={`/a/${agent.id}`}
          className="flex items-start gap-3 px-3 py-2.5 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
        >
          <span className="mt-0.5">
            <AgentAvatar
              runtime={agent.summary.runtime}
              runtimeName={runtime}
              tone={dot.tone}
              label={dot.label}
              pulsing={dot.pulsing}
              ring="ring-card"
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{title(agent)}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {ago(agent.summary.lastActivityAt, now)}
              </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              <span className={dot.tone === "error" ? "text-destructive" : undefined}>{dot.label}</span>
              {` · ${ws?.label ?? "?"}`}
              {branch !== undefined && branch !== null && branch !== ws?.label && ` (${branch})`}
              {` · ${runtime}`}
            </div>
            {detail !== "" && (
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/80">{oneLine(detail)}</div>
            )}
          </div>
        </RouterLink>
      </AgentContextMenu>
    </li>
  );
}

function oneLine(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}
