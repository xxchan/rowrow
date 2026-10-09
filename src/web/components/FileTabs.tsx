// The open files above the Files view's preview (roamgate #309): the temporary tab in italics,
// a name's folder beside it when two open files share the name, a close button on each.
// Click shows a tab, double-click (or Enter) keeps the temporary one, middle-click or Delete
// closes; ←/→, Home and End move between tabs. They scroll sideways when they don't fit.
import { cn } from "@/lib/utils";
import { File, X } from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { FileTabs } from "../lib/file-tabs.ts";

export function FileTabStrip({
  tabs,
  panelId,
  onSelect,
  onKeep,
  onClose,
  onEmpty,
}: {
  tabs: FileTabs;
  /** The tab panel the tabs show. */
  panelId: string;
  onSelect: (path: string) => void;
  onKeep: (path: string) => void;
  onClose: (path: string) => void;
  /** The last tab closed from the keyboard: where focus goes instead. */
  onEmpty: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // The tab showing stays in sight.
  const showing = tabs.active === null ? -1 : tabs.paths.indexOf(tabs.active);
  useLayoutEffect(() => {
    const all = list.current?.querySelectorAll('[role="tab"]');
    all?.[showing]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [showing]);
  if (tabs.paths.length === 0) return null;

  const focus = (path: string): void =>
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[tabs.paths.indexOf(path)]?.focus();
  const close = (path: string, keepFocus: boolean): void => {
    const at = tabs.paths.indexOf(path);
    const next = path === tabs.active ? (tabs.paths[at + 1] ?? tabs.paths[at - 1]) : tabs.active;
    onClose(path);
    if (!keepFocus) return;
    // Before React removes this tab: its neighbor stays.
    if (next !== undefined && next !== null) focus(next);
    else requestAnimationFrame(onEmpty);
  };
  const onKeyDown = (event: KeyboardEvent, path: string, index: number): void => {
    const count = tabs.paths.length;
    const to =
      event.key === "ArrowRight"
        ? (index + 1) % count
        : event.key === "ArrowLeft"
          ? (index - 1 + count) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (to !== null) {
      const next = tabs.paths[to];
      if (next !== undefined) {
        onSelect(next);
        focus(next);
      }
    } else if (event.key === "Delete") close(path, true);
    else if (event.key === "Enter" && path === tabs.preview) onKeep(path);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Open files"
      className="flex shrink-0 items-stretch gap-[3px] overflow-x-auto overscroll-x-contain border-b px-1.5 pt-1.5"
    >
      {tabs.paths.map((path, index) => {
        const name = basename(path);
        const twin = tabs.paths.some((other) => other !== path && basename(other) === name);
        const parent = path.slice(0, -(name.length + 1));
        const active = path === tabs.active;
        const preview = path === tabs.preview;
        return (
          <div
            key={path}
            role="presentation"
            className={cn(
              "flex max-w-[260px] shrink-0 items-center rounded-t-md border border-b-2 border-transparent text-muted-foreground hover:bg-accent/60",
              active && "border-border border-b-primary bg-background text-foreground hover:bg-background",
            )}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              close(path, event.currentTarget.contains(document.activeElement));
            }}
            // No autoscroll on a middle click.
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
          >
            <button
              type="button"
              role="tab"
              id={`${panelId}-tab-${index}`}
              aria-controls={panelId}
              aria-selected={active}
              aria-label={path}
              aria-description={preview ? "Temporary preview. Press Enter to keep open." : undefined}
              title={preview ? `${path} · Double-click to keep open` : path}
              tabIndex={active ? 0 : -1}
              className="flex min-h-[34px] min-w-0 items-center gap-1.5 py-1 pr-1.5 pl-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11"
              onClick={() => onSelect(path)}
              onDoubleClick={() => onKeep(path)}
              onKeyDown={(event) => onKeyDown(event, path, index)}
            >
              <File className="size-3.5 shrink-0" aria-hidden="true" />
              <span className={cn("max-w-[150px] shrink-0 truncate", preview && "italic")}>{name}</span>
              {twin && parent !== "" && (
                <span className="truncate text-[10px] text-muted-foreground">{parent}</span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${path}`}
              title="Close file (Delete on tab)"
              tabIndex={active ? 0 : -1}
              className="flex min-h-[34px] shrink-0 items-center justify-center rounded px-2 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              onClick={(event) => close(path, event.currentTarget === document.activeElement)}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
