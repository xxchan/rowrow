// One workspace: its git state, its agents, and its worktrees.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ORPCError } from "@orpc/client";
import { Ellipsis, GitBranch, LoaderCircle, Pin, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { byPin, type AppState, type Workspace } from "../../shared/schemas.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { ErrorText } from "../components/ErrorText.tsx";
import {
  Inspector,
  saveInspectorTab,
  savedInspectorTab,
  type InspectorTab,
} from "../components/Inspector.tsx";
import { useNewAgent } from "../components/NewAgentDialog.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { AgentAvatar } from "../components/AgentIcon.tsx";
import { ago, statusDot, title } from "../lib/format.ts";
import { navigate, RouterLink, type Route } from "../lib/router.ts";
import { useApp, useClient } from "../lib/store.ts";
import { useNow } from "../lib/use-now.ts";

export function WorkspacePage({ workspaceId, route }: { workspaceId: string; route: Route }) {
  const state = useApp((s) => s.state) as AppState;
  const ws = state.workspaces[workspaceId];
  if (ws === undefined)
    return (
      <>
        <PageHeader title="No such workspace" route={route} />
        <EmptyState title="No such workspace" description={`There is no workspace ${workspaceId}.`} />
      </>
    );
  return <WorkspaceView ws={ws} state={state} route={route} />;
}

function WorkspaceView({ ws, state, route }: { ws: Workspace; state: AppState; route: Route }) {
  const client = useClient();
  const open = useNewAgent((s) => s.open);
  const now = useNow(15_000);
  const agents = Object.values(state.agents)
    .filter((a) => a.summary.workspaceId === ws.id && !a.summary.archived)
    .sort((a, b) => byPin(a, b) || b.summary.lastActivityAt - a.summary.lastActivityAt);
  const worktrees = Object.values(state.workspaces).filter((w) => w.parentId === ws.id);
  const git = ws.git;

  const [tab, setTab] = useState<InspectorTab>(savedInspectorTab);
  const [newWorktree, setNewWorktree] = useState(false);
  const [removing, setRemoving] = useState<"ask" | "dirty" | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (force: boolean): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      await client.workspaces.removeWorktree({ id: ws.id, force });
      setRemoving(null);
      toast.success(`Removed the worktree; branch ${git?.branch ?? ""} is kept.`);
      navigate(ws.parentId === null ? "/" : `/w/${ws.parentId}`);
    } catch (error) {
      if (!force && error instanceof ORPCError && error.code === "CONFLICT") setRemoving("dirty");
      else {
        setRemoving(null);
        toast.error(`Couldn't remove it: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    if (client === null) return;
    try {
      await client.workspaces.refresh({ id: ws.id });
    } catch (error) {
      toast.error(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const facts =
    git === null
      ? null
      : [
          git.branch === null ? `detached at ${git.head ?? "?"}` : `on ${git.branch}`,
          git.upstream === null ? "no upstream" : `${git.ahead} ahead, ${git.behind} behind ${git.upstream}`,
          git.changed === 0 ? "clean" : `${git.changed} changed file${git.changed === 1 ? "" : "s"}`,
          git.linked ? "linked worktree" : null,
        ]
          .filter((part) => part !== null)
          .join(" · ");

  return (
    <>
      <PageHeader
        route={route}
        title={ws.label}
        subtitle={
          <span className="font-mono">
            {ws.path}
            {ws.missing ? " — this folder no longer exists" : ""}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void refresh()}>
              <RefreshCw />
            </Button>
            {git !== null && !ws.missing && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Workspace actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setNewWorktree(true)}>
                    <GitBranch /> New worktree…
                  </DropdownMenuItem>
                  {git.linked && (
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving("ask")}>
                      <Trash2 /> Remove this worktree…
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button size="sm" onClick={() => open({ workspaceId: ws.id })}>
              <Plus /> <span className="hidden sm:inline">New agent here</span>
              <span className="sm:hidden">New agent</span>
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-3 py-4 md:px-6 md:py-6">
          {facts !== null && (
            <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <GitBranch className="size-3.5" /> {facts}
            </p>
          )}
          <Section label={`Agents · ${agents.length}`}>
            {agents.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No agents here yet.</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => open({ workspaceId: ws.id })}
                >
                  New agent here
                </Button>
              </div>
            ) : (
              <ul className="divide-y overflow-hidden rounded-lg border bg-card">
                {agents.map((agent) => {
                  const dot = statusDot(agent, now);
                  return (
                    <li key={agent.id}>
                      <RouterLink
                        href={`/a/${agent.id}`}
                        className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/60"
                      >
                        <AgentAvatar
                          runtime={agent.summary.runtime}
                          runtimeName={state.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime}
                          tone={dot.tone}
                          label={dot.label}
                          pulsing={dot.pulsing}
                          ring="ring-card"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-sm font-medium">
                            <span className="truncate">{title(agent)}</span>
                            {agent.pinnedAt !== null && (
                              <Pin
                                aria-label="Pinned"
                                className="size-3 shrink-0 fill-current text-muted-foreground"
                              />
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {`${dot.label} · ${state.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime}`}
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {ago(agent.summary.lastActivityAt, now)}
                        </span>
                      </RouterLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
          {git !== null && !ws.missing && (
            <section
              aria-label="Inspector"
              className="h-[min(75dvh,720px)] overflow-hidden rounded-lg border bg-card"
            >
              <Inspector
                workspaceId={ws.id}
                tab={tab}
                onTabChange={(next) => {
                  setTab(next);
                  saveInspectorTab(next);
                }}
              />
            </section>
          )}
          {worktrees.length > 0 && (
            <Section label={`Worktrees · ${worktrees.length}`}>
              <ul className="divide-y overflow-hidden rounded-lg border bg-card">
                {worktrees.map((w) => (
                  <li key={w.id}>
                    <RouterLink href={`/w/${w.id}`} className="flex flex-col px-3 py-2.5 hover:bg-accent/60">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <GitBranch className="size-3.5 text-muted-foreground" /> {w.label}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{w.path}</span>
                    </RouterLink>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
      <NewWorktreeDialog open={newWorktree} onClose={() => setNewWorktree(false)} workspaceId={ws.id} />
      <Confirm
        open={removing === "ask"}
        onCancel={() => setRemoving(null)}
        title="Remove this worktree?"
        description={`Deletes the checkout at ${ws.path}. The branch ${git?.branch ?? ""} is kept, so nothing committed is lost. Agents here stop.`}
        action="Remove"
        busy={busy}
        onAction={() => void remove(false)}
      />
      <Confirm
        open={removing === "dirty"}
        onCancel={() => setRemoving(null)}
        title="It has uncommitted changes"
        description="Removing it now throws away the uncommitted changes in this checkout. Commit them first if you want to keep them."
        action="Discard changes and remove"
        busy={busy}
        onAction={() => void remove(true)}
      />
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="px-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</h2>
      {children}
    </section>
  );
}

function Confirm({
  open,
  onCancel,
  title: heading,
  description,
  action,
  busy,
  onAction,
}: {
  open: boolean;
  onCancel: () => void;
  title: string;
  description: string;
  action: string;
  busy: boolean;
  onAction: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{heading}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              onAction();
            }}
          >
            {busy && <LoaderCircle className="animate-spin" />} {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NewWorktreeDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const client = useClient();
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    try {
      const { workspace, hook } = await client.workspaces.createWorktree({
        id: workspaceId,
        ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
      });
      if (hook !== null && !hook.ok) toast.error(`The setup hook failed: ${hook.output.slice(-300)}`);
      onClose();
      setBranch("");
      navigate(`/w/${workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle>New worktree</DialogTitle>
            <DialogDescription>
              A new branch in its own checkout, from origin's default branch.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Branch"
            value={branch}
            autoFocus
            onChange={(event) => setBranch(event.currentTarget.value)}
            placeholder="rowrow/… (a random name when empty)"
            className="font-mono"
          />
          {error !== null && <ErrorText>{error}</ErrorText>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <LoaderCircle className="animate-spin" />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
