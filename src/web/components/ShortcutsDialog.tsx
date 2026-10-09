// Every keyboard shortcut on one sheet: ? anywhere (bound in CommandMenu), or the keyboard
// button beside Settings. The list is written by hand, so keep it in step with the handlers
// it describes (CommandMenu, AgentPage and TranscriptSearch, Composer, NewAgentDialog, DiffView,
// SelectionComment and Coach).
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { create } from "zustand";

export const useShortcuts = create<{
  isOpen: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({
  isOpen: false,
  setOpen: (isOpen) => set({ isOpen }),
}));

const GROUPS: readonly {
  heading: string;
  items: readonly (readonly [keys: string[], what: string])[];
}[] = [
  {
    heading: "Anywhere",
    items: [
      [["⌘", "K"], "Go to an agent or workspace"],
      [["⌘", "J"], "Next agent that needs you"],
      [["C"], "New agent"],
      [["⌘", "⌥", "⇧", "A"], "Coach"],
      [["⌘", ","], "Settings"],
      [["?"], "Keyboard shortcuts"],
    ],
  },
  {
    heading: "Go to… (⌘K)",
    items: [
      [["↵"], "Open it, or start an agent if nothing matches"],
      [["⌘", "↵"], "Start an agent with what you typed"],
      [["⌥", "↵"], "Edit it before starting"],
    ],
  },
  {
    heading: "An agent's conversation",
    items: [
      [["⌘", "F"], "Search it; again in the search field, the browser's own find"],
      [["↵"], "Older match"],
      [["⇧", "↵"], "Newer match"],
      [["Esc"], "Close the search"],
    ],
  },
  {
    heading: "Composer",
    items: [
      [["↵"], "Send; while it works, queue for after this turn"],
      [["⌘", "↵"], "Steer into the running turn"],
      [["⌘", "⇧", "↵"], "Stop the turn and send"],
      [["⇧", "↵"], "New line"],
      [["↑"], "Take back your last queued message, or your last message (empty composer)"],
      [["Esc"], "Stop the turn (empty composer)"],
      [["/"], "The agent's commands and skills"],
    ],
  },
  {
    heading: "New agent",
    items: [
      [["⌘", "↵"], "Start"],
      [["⌘", "⇧", "↵"], "Start in a new worktree"],
      [["⌥", "W"], "Workspace"],
      [["⌥", "A"], "Agent"],
      [["⌥", "M"], "Model (← → for effort)"],
      [["⌥", "T"], "New worktree on or off"],
    ],
  },
  {
    heading: "Coach",
    items: [
      [["↵"], "Send"],
      [["⇧", "↵"], "New line"],
      [["Esc"], "Restore the window, or close Coach"],
    ],
  },
  {
    heading: "Comments",
    items: [
      [["⌘", "↵"], "Add the comment"],
      [["Esc"], "Cancel"],
    ],
  },
];

export function ShortcutsDialog() {
  const { isOpen, setOpen } = useShortcuts();

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] gap-3 overflow-y-auto p-5 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="text-xs">
            ⌘ is Ctrl and ⌥ is Alt on Windows and Linux.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.heading} aria-label={group.heading}>
              <h2 className="pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                {group.heading}
              </h2>
              <dl className="flex flex-col gap-1.5">
                {group.items.map(([keys, what]) => (
                  <div key={what} className="flex items-start justify-between gap-3 text-[13px]">
                    <dt className="min-w-0">{what}</dt>
                    <dd className="shrink-0">
                      <KbdGroup>
                        {keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </KbdGroup>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
