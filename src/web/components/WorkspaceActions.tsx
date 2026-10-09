// What you can do to a workspace (D-047), in one list: its right-click (or long-press) menu in
// the side nav and the ⋯ menu on its page show the same actions, and ⌘K offers them for the
// workspace you're in. New workspace, Rename, Archive and Remove open dialogs that live in the
// Shell, so any of those places (and a double-click on a workspace's name) can start them.
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
import { Input } from "@/components/ui/input";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import type { AppState, Workspace } from "../../shared/schemas.ts";
import { workspaceArchived, workspaceGroup } from "../../shared/workspaces.ts";
import { navigate } from "../lib/router.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { AddWorkspace } from "./AddWorkspace.tsx";
import { copyText, type MenuAction } from "./MenuActions.tsx";
import { useNewAgent } from "./NewAgentDialog.tsx";

type DialogKind = "add" | "rename" | "archive" | "remove";

/** Which workspace dialog is open, and for which workspace (none for "add"). */
export const useWorkspaceDialog = create<{ kind: DialogKind | null; workspaceId: string | null }>(() => ({
  kind: null,
  workspaceId: null,
}));

export function openWorkspaceDialog(kind: DialogKind, workspaceId: string | null = null): void {
  useWorkspaceDialog.setState({ kind, workspaceId });
}

/** Bring an archived workspace back, with its worktrees and agents as they were. */
export function useUnarchive(): (ws: Workspace) => void {
  const client = useClient();
  return (ws) => {
    if (client === null) return;
    client.workspaces
      .update({ id: ws.id, archived: false })
      .then(() => toast.success(`Unarchived ${ws.label}`))
      .catch((error: unknown) => failed("Unarchive", ws.id, error));
  };
}

/**
 * Everything you can do to this workspace. On its page (`here`) opening it is moot and New agent
 * is a button, and the page adds its worktree actions: `top` first, `danger` beside Remove.
 */
export function useWorkspaceActions(
  ws: Workspace,
  { here = false, top = [], danger = [] }: { here?: boolean; top?: MenuAction[]; danger?: MenuAction[] } = {},
): MenuAction[] {
  const openNewAgent = useNewAgent((s) => s.open);
  const archived = useApp((s) =>
    s.state === null ? ws.archived : workspaceArchived(s.state.workspaces, ws.id),
  );
  const unarchive = useUnarchive();
  const href = `/w/${ws.id}`;
  return [
    ...(archived || here
      ? []
      : [{ label: "New agent here", icon: <Plus />, run: () => openNewAgent({ workspaceId: ws.id }) }]),
    ...(here
      ? []
      : [{ label: "Open in a new tab", icon: <ExternalLink />, run: () => window.open(href, "_blank") }]),
    ...top,
    "separator",
    { label: "Copy path", icon: <Copy />, run: () => void copyText(ws.path, "Path") },
    "separator",
    { label: "Rename…", icon: <Pencil />, run: () => openWorkspaceDialog("rename", ws.id) },
    ws.archived
      ? { label: "Unarchive", icon: <ArchiveRestore />, run: () => unarchive(ws) }
      : { label: "Archive…", icon: <Archive />, run: () => openWorkspaceDialog("archive", ws.id) },
    "separator",
    ...danger,
    {
      label: "Remove from rowrow…",
      icon: <Trash2 />,
      destructive: true,
      run: () => openWorkspaceDialog("remove", ws.id),
    },
  ];
}

function failed(action: string, workspaceId: string, error: unknown): void {
  toast.error(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  report("warn", "workspace.action_failed", error, { action, workspaceId });
}

/** New workspace, Rename, Archive and Remove, for whichever workspace asked (mounted once, in the Shell). */
export function WorkspaceDialogs() {
  const { kind, workspaceId } = useWorkspaceDialog();
  const state = useApp((s) => s.state);
  const close = (): void => useWorkspaceDialog.setState({ kind: null });
  if (kind === "add") return <AddWorkspaceDialog onClose={close} />;
  const ws = workspaceId === null ? undefined : state?.workspaces[workspaceId];
  if (ws === undefined || state === null || kind === null) return null;
  switch (kind) {
    case "rename":
      return <RenameWorkspaceDialog key={ws.id} ws={ws} onClose={close} />;
    case "archive":
      return <ArchiveWorkspaceDialog key={ws.id} ws={ws} state={state} onClose={close} />;
    case "remove":
      return <RemoveWorkspaceDialog key={ws.id} ws={ws} state={state} onClose={close} />;
  }
}

function AddWorkspaceDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        className="top-[16%] max-h-[80dvh] translate-y-0 gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        <AddWorkspace
          named
          onCancel={onClose}
          onAdded={(id) => {
            onClose();
            navigate(`/w/${id}`);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function RenameWorkspaceDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const client = useClient();
  const [value, setValue] = useState(ws.customLabel ?? ws.label);
  const input = useRef<HTMLInputElement>(null);
  const rename = (): void => {
    if (client === null) return;
    const label = value.trim();
    client.workspaces
      .update({ id: ws.id, label: label === "" ? null : label })
      .catch((error: unknown) => failed("Rename", ws.id, error));
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="sm:max-w-md"
        // The whole name selected: type to replace it, or an arrow key to edit it.
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
            rename();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              {`Leave it empty to name it after its ${ws.git?.linked === true ? "branch" : "folder"}.`}
            </DialogDescription>
          </DialogHeader>
          <Input
            ref={input}
            aria-label="Name"
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

/** What a workspace holds: its worktrees, and the agents in it and in them (not archived themselves). */
function contents(state: AppState, ws: Workspace) {
  const group = workspaceGroup(state.workspaces, ws.id);
  const ids = new Set(group.map((w) => w.id));
  const agents = Object.values(state.agents).filter(
    (a) => ids.has(a.summary.workspaceId) && !a.summary.archived,
  );
  return {
    worktrees: group.slice(1),
    agents,
    working: agents.filter((a) => a.summary.status.kind === "running"),
  };
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ArchiveWorkspaceDialog({
  ws,
  state,
  onClose,
}: {
  ws: Workspace;
  state: AppState;
  onClose: () => void;
}) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const { worktrees, agents, working } = contents(state, ws);
  const archive = async (): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      await client.workspaces.update({ id: ws.id, archived: true });
      toast.success(`Archived ${ws.label}`, {
        description: "It's under Archived at the bottom of the side bar.",
      });
      onClose();
    } catch (error) {
      failed("Archive", ws.id, error);
    } finally {
      setBusy(false);
    }
  };
  const holds = [
    worktrees.length > 0 ? count(worktrees.length, "worktree") : null,
    agents.length > 0 ? count(agents.length, "agent") : null,
  ].filter((part) => part !== null);
  return (
    <Confirm
      title={`Archive ${ws.label}?`}
      action="Archive"
      busy={busy}
      danger={false}
      onCancel={onClose}
      onAction={() => void archive()}
    >
      <p>
        {`It's hidden${holds.length > 0 ? ` with its ${holds.join(" and ")}` : ""} until you unarchive it, and no agent can start or be messaged there meanwhile. Nothing is deleted.`}
      </p>
      {working.length > 0 && (
        <p className="text-warning">
          {`${count(working.length, "agent is", "agents are")} working there: archiving stops ${working.length === 1 ? "it" : "them"}.`}
        </p>
      )}
    </Confirm>
  );
}

function RemoveWorkspaceDialog({
  ws,
  state,
  onClose,
}: {
  ws: Workspace;
  state: AppState;
  onClose: () => void;
}) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const { worktrees, agents, working } = contents(state, ws);
  const remove = async (): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      const result = await client.workspaces.remove({ id: ws.id });
      onClose();
      if (result.removed.some((id) => location.pathname === `/w/${id}`)) navigate("/");
      toast.success(`Removed ${ws.label} from rowrow`, {
        description:
          result.archived.length === 0 ? undefined : `${count(result.archived.length, "agent")} archived.`,
      });
    } catch (error) {
      failed("Remove", ws.id, error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Confirm
      title={`Remove ${ws.label} from rowrow?`}
      action="Remove from rowrow"
      busy={busy}
      disabled={working.length > 0}
      onCancel={onClose}
      onAction={() => void remove()}
    >
      <p>
        rowrow forgets <span className="font-mono break-all text-foreground">{ws.path}</span>. The folder and
        its files stay.
      </p>
      {worktrees.length > 0 && (
        <div className="flex flex-col gap-1">
          <p>{`Its ${count(worktrees.length, "worktree")} ${worktrees.length === 1 ? "goes" : "go"} too (the checkouts and branches stay):`}</p>
          <ul aria-label="Worktrees removed with it" className="flex flex-col gap-0.5">
            {worktrees.map((w) => (
              <li key={w.id} className="break-all">
                <span className="text-foreground">{w.label}</span>{" "}
                <span className="font-mono text-xs">{w.path}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>
        {agents.length === 0
          ? "No agents work there."
          : `${count(agents.length, "agent")} will be archived; ${agents.length === 1 ? "its conversation is" : "their conversations are"} kept.`}
      </p>
      {working.length > 0 && (
        <p className="text-destructive">
          {`${count(working.length, "agent is", "agents are")} working there. Stop ${working.length === 1 ? "it" : "them"} or let ${working.length === 1 ? "it" : "them"} finish first.`}
        </p>
      )}
    </Confirm>
  );
}

function Confirm({
  title,
  action,
  busy,
  disabled = false,
  danger = true,
  onCancel,
  onAction,
  children,
}: {
  title: string;
  action: string;
  busy: boolean;
  disabled?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex w-full min-w-0 flex-col gap-2">{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={danger ? "destructive" : "default"}
            disabled={busy || disabled}
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
