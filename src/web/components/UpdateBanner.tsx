import { Button } from "@/components/ui/button";
import { ArrowUpCircle, Copy, X } from "lucide-react";
import { usePref, writePref } from "../lib/device-prefs.ts";
import { useApp } from "../lib/store.ts";
import { copyText } from "./MenuActions.tsx";

// Dismissed per version, on this device (in every tab): the next release asks again.
const KEY = "rowrow.update.dismissed";

/** Says so when the server found a newer rowrow on npm, with the command that updates it. */
export function UpdateBanner() {
  const update = useApp((s) => s.state?.host.update ?? null);
  const version = useApp((s) => s.state?.host.version ?? null);
  const hidden = usePref(KEY, (stored) => stored);
  if (update === null || hidden === update.version) return null;
  const dismiss = (): void => writePref(KEY, update.version);
  return (
    <section
      aria-label="Update"
      data-hides-while-typing
      className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
    >
      <ArrowUpCircle className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{`rowrow ${update.version} is out`}</span>
        {version !== null && (
          <span className="text-muted-foreground max-md:block">
            <span className="max-md:hidden"> · </span>
            {`you run ${version}. `}
          </span>
        )}
        <span className="text-muted-foreground max-md:hidden">On the server's machine, run </span>
        <code className="rounded bg-muted px-1 font-mono text-xs break-all max-md:hidden">
          {update.command}
        </code>
        {update.after !== null && (
          <span className="text-muted-foreground max-md:hidden">{` ${update.after}`}</span>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={() => void copyText(update.command, "Update command")}>
        <Copy /> Copy command
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label="Dismiss update notice"
        onClick={dismiss}
      >
        <X />
      </Button>
    </section>
  );
}
