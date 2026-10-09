// A menu as data: the same actions render in a ⋯ dropdown and in a right-click context menu.
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import type { ComponentType, ReactNode } from "react";
import { toast } from "sonner";
import { report } from "../lib/telemetry.ts";

/** One entry of a menu, or a divider. `disabled`: why it can't be done now, shown under it. */
export type MenuAction =
  | { label: string; icon: ReactNode; run: () => void; destructive?: boolean; disabled?: string }
  | "separator";

/** A menu's item and separator components: DropdownMenu's or ContextMenu's. */
export interface MenuParts {
  Item: ComponentType<{
    onSelect: () => void;
    variant?: "default" | "destructive";
    disabled?: boolean;
    children: ReactNode;
  }>;
  Separator: ComponentType;
}

export function MenuActions({ actions, parts }: { actions: MenuAction[]; parts: MenuParts }) {
  const { Item, Separator } = parts;
  // No divider first, last, or twice in a row (an action that doesn't apply leaves a gap).
  const shown = actions.filter(
    (action, i) =>
      action !== "separator" || (i > 0 && i < actions.length - 1 && actions[i - 1] !== "separator"),
  );
  return shown.map((action, i) =>
    action === "separator" ? (
      <Separator key={`separator-${i}`} />
    ) : (
      <Item
        key={action.label}
        onSelect={action.run}
        variant={action.destructive ? "destructive" : "default"}
        disabled={action.disabled !== undefined}
      >
        {action.icon}
        {action.disabled === undefined ? (
          action.label
        ) : (
          <span className="flex flex-col">
            {action.label}
            <span className="text-xs text-muted-foreground">{action.disabled}</span>
          </span>
        )}
      </Item>
    ),
  );
}

export const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

/** Copy to the clipboard and say so; clipboard access needs https or localhost. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch (error) {
    toast.error(`Couldn't copy: ${error instanceof Error ? error.message : String(error)}`);
    report("warn", "clipboard.write_failed", error);
  }
}
