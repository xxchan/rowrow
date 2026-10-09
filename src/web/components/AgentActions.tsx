// What you can do to an agent, in one list: the ⋯ menu on its page and the right-click (or
// long-press) menu on its rows in the side nav and on Home show the same actions. Rename and
// Model and effort open dialogs that live in the Shell, so any row can start them (Rename also
// opens when you double-click the agent's title in its header or its row in the side nav).
// Pinning (D-046) puts it first in every list and, like roamgate's pinned tabs, protects it:
// Archive waits until it's unpinned.
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Cpu,
  ExternalLink,
  FolderOpen,
  Link,
  LoaderCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Power,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import type { AgentState, ModelInfo, Workspace } from "../../shared/schemas.ts";
import { defaultNote, title } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { CONTEXT_PARTS, copyText, MenuActions, type MenuAction } from "./MenuActions.tsx";
import { useNewAgent } from "./NewAgentDialog.tsx";

/** Which agent's Rename or Model and effort dialog is open. */
export const useAgentDialog = create<{ kind: "rename" | "model" | null; agentId: string | null }>(() => ({
  kind: null,
  agentId: null,
}));

export function openAgentDialog(kind: "rename" | "model", agentId: string): void {
  useAgentDialog.setState({ kind, agentId });
}

/** Everything you can do to this agent. `here`: you're on its page, so opening it is moot. */
export function useAgentActions(agent: AgentState, { here = false } = {}): MenuAction[] {
  const client = useClient();
  const ws = useApp((s) => s.state?.workspaces[agent.summary.workspaceId]);
  const openNewAgent = useNewAgent((s) => s.open);
  const { summary } = agent;
  const pinned = agent.pinnedAt !== null;
  const href = `/a/${agent.id}`;
  const act = (label: string, run: (c: NonNullable<typeof client>) => Promise<unknown>) => () => {
    if (client === null) return;
    run(client).catch((error: unknown) => {
      toast.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      report("warn", "agent.action_failed", error, { action: label, agentId: agent.id });
    });
  };
  return [
    ...(here
      ? []
      : [{ label: "Open in a new tab", icon: <ExternalLink />, run: () => window.open(href, "_blank") }]),
    {
      label: "Copy link",
      icon: <Link />,
      run: () => void copyText(new URL(href, location.origin).href, "Link"),
    },
    "separator",
    { label: "Rename…", icon: <Pencil />, run: () => openAgentDialog("rename", agent.id) },
    ...(summary.archived
      ? []
      : [
          {
            label: pinned ? "Unpin agent" : "Pin agent",
            icon: pinned ? <PinOff /> : <Pin />,
            run: act(pinned ? "Unpin" : "Pin", (c) =>
              c.agents.update({ agentId: agent.id, pinned: !pinned }),
            ),
          },
        ]),
    ...(summary.archived
      ? []
      : [{ label: "Model and effort…", icon: <Cpu />, run: () => openAgentDialog("model", agent.id) }]),
    ...(summary.run === null
      ? []
      : [
          {
            label: "Stop the agent process",
            icon: <Power />,
            run: act("Stop", (c) => c.agents.stop({ agentId: agent.id })),
          },
        ]),
    "separator",
    ...workspaceItems(ws, openNewAgent),
    "separator",
    {
      label: summary.archived ? "Unarchive" : "Archive",
      icon: summary.archived ? <ArchiveRestore /> : <Archive />,
      run: act(summary.archived ? "Unarchive" : "Archive", (c) =>
        c.agents.update({ agentId: agent.id, archived: !summary.archived }),
      ),
      ...(pinned ? { disabled: "Unpin this agent before archiving it." } : {}),
    },
  ];
}

function workspaceItems(
  ws: Workspace | undefined,
  openNewAgent: (options: { workspaceId: string }) => void,
): MenuAction[] {
  if (ws === undefined) return [];
  return [
    { label: `New agent in ${ws.label}`, icon: <Plus />, run: () => openNewAgent({ workspaceId: ws.id }) },
    { label: `Open workspace ${ws.label}`, icon: <FolderOpen />, run: () => navigate(`/w/${ws.id}`) },
  ];
}

/**
 * A pinned agent's pin, as a button that unpins it: in place of roamgate's close button on a
 * pinned tab in its phone tab sheet, one tap instead of a long press and a menu.
 */
export function UnpinButton({ agent, className }: { agent: AgentState; className?: string }) {
  const client = useClient();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("text-muted-foreground", className)}
      aria-label={`Unpin ${title(agent)}`}
      title="Unpin agent"
      onClick={() => {
        client?.agents.update({ agentId: agent.id, pinned: false }).catch((error: unknown) => {
          toast.error(`Unpin failed: ${error instanceof Error ? error.message : String(error)}`);
          report("warn", "agent.action_failed", error, { action: "Unpin", agentId: agent.id });
        });
      }}
    >
      <Pin className="fill-current" />
    </Button>
  );
}

/** Right-click (or long-press) an agent's row for its actions. `children` is the row itself. */
export function AgentContextMenu({ agent, children }: { agent: AgentState; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <AgentContextMenuContent agent={agent} />
    </ContextMenu>
  );
}

// Its own component, so a row only computes its actions while its menu is open.
function AgentContextMenuContent({ agent }: { agent: AgentState }) {
  const actions = useAgentActions(agent);
  return (
    <ContextMenuContent className="w-60" aria-label={`Actions for ${title(agent)}`}>
      <ContextMenuLabel>{title(agent)}</ContextMenuLabel>
      <MenuActions actions={actions} parts={CONTEXT_PARTS} />
    </ContextMenuContent>
  );
}

/** Right-click (or long-press) a workspace's row: start an agent there, open it, copy its path. */
export function WorkspaceContextMenu({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  const openNewAgent = useNewAgent((s) => s.open);
  const href = `/w/${workspace.id}`;
  const actions: MenuAction[] = [
    { label: "New agent here", icon: <Plus />, run: () => openNewAgent({ workspaceId: workspace.id }) },
    { label: "Open in a new tab", icon: <ExternalLink />, run: () => window.open(href, "_blank") },
    "separator",
    { label: "Copy path", icon: <Copy />, run: () => void copyText(workspace.path, "Path") },
  ];
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56" aria-label={`Actions for ${workspace.label}`}>
        <ContextMenuLabel>{workspace.label}</ContextMenuLabel>
        <MenuActions actions={actions} parts={CONTEXT_PARTS} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The Rename and Model and effort dialogs, for whichever agent asked (mounted once, in the Shell). */
export function AgentDialogs() {
  const { kind, agentId } = useAgentDialog();
  const agent = useApp((s) => (agentId === null ? undefined : s.state?.agents[agentId]));
  const runtimeName = useApp((s) =>
    agent === undefined ? "" : (s.state?.runtimes[agent.summary.runtime]?.name ?? agent.summary.runtime),
  );
  const client = useClient();
  const close = (): void => useAgentDialog.setState({ kind: null });
  if (agent === undefined || client === null) return null;
  const act = (label: string, run: () => Promise<unknown>): void => {
    run().catch((error: unknown) => {
      toast.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      report("warn", "agent.action_failed", error, { action: label, agentId: agent.id });
    });
  };
  return (
    <>
      {kind === "rename" && (
        <RenameDialog
          key={`rename-${agent.id}`}
          current={agent.summary.title ?? ""}
          onClose={close}
          onRename={(next) =>
            act("Rename", () => client.agents.update({ agentId: agent.id, title: next === "" ? null : next }))
          }
        />
      )}
      {kind === "model" && (
        <ModelDialog
          key={`model-${agent.id}`}
          agent={agent}
          runtimeName={runtimeName}
          onClose={close}
          onApply={(model, effort) =>
            act("Switch model", () => client.agents.update({ agentId: agent.id, model, effort }))
          }
        />
      )}
    </>
  );
}

function RenameDialog({
  current,
  onClose,
  onRename,
}: {
  current: string;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const [value, setValue] = useState(current);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="sm:max-w-md"
        // The whole title selected: type to replace it, or an arrow key to edit it.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
          input.current?.select();
        }}
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(value.trim());
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename agent</DialogTitle>
            <DialogDescription>Leave it empty to name it after its first message.</DialogDescription>
          </DialogHeader>
          <Input
            ref={input}
            aria-label="Title"
            value={value}
            maxLength={200}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Radix Select items can't have an empty value; this one means "the runtime's default". */
const DEFAULT = "__default";

/** Switch the agent's model or effort: its run restarts with them and the conversation carries on. */
function ModelDialog({
  agent,
  runtimeName,
  onClose,
  onApply,
}: {
  agent: AgentState;
  runtimeName: string;
  onClose: () => void;
  onApply: (model: string | null, effort: string | null) => void;
}) {
  const client = useClient();
  const { summary } = agent;
  const [models, setModels] = useState<{ list: ModelInfo[]; error: string | null } | null>(null);
  const [model, setModel] = useState(summary.model ?? DEFAULT);
  const [effort, setEffort] = useState(summary.effort ?? DEFAULT);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.runtimes.models({ runtime: summary.runtime });
        if (!cancelled) setModels({ list: result.models, error: result.error });
      } catch (error) {
        if (!cancelled)
          setModels({ list: [], error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, summary.runtime]);

  const efforts = models?.list.find((m) => m.id === model)?.effortLevels ?? [];
  const current = summary.reportedModel ?? summary.model ?? "the default model";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Model and effort</DialogTitle>
          <DialogDescription>{`${runtimeName}, now on ${current}. The next message continues the conversation with what you pick.`}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="switch-model">Model</Label>
            <Select
              value={model}
              onValueChange={(value) => {
                setModel(value);
                setEffort(DEFAULT);
              }}
            >
              <SelectTrigger id="switch-model" className="w-full">
                {models === null ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <LoaderCircle className="animate-spin" /> Loading models
                  </span>
                ) : (
                  <SelectValue />
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>Default</SelectItem>
                {summary.model !== null && !(models?.list ?? []).some((m) => m.id === summary.model) && (
                  <SelectItem value={summary.model}>{summary.model}</SelectItem>
                )}
                {(models?.list ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {efforts.length > 0 && (
            <div className="flex w-36 flex-col gap-1.5">
              <Label htmlFor="switch-effort">Effort</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger id="switch-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Default</SelectItem>
                  {efforts.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {(model === DEFAULT || effort === DEFAULT) && (
          <p className="text-xs text-muted-foreground">Default: {defaultNote(runtimeName)}.</p>
        )}
        {models?.error !== null && models?.error !== undefined && (
          <p className="text-xs text-muted-foreground">Models: {models.error}</p>
        )}
        {agent.attention === "working" && (
          <p className="text-xs text-warning">It's in the middle of a turn: switching stops that turn.</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onApply(model === DEFAULT ? null : model, effort === DEFAULT ? null : effort);
              onClose();
            }}
          >
            Switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
