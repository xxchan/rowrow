import { cn } from "@/lib/utils";
import type { Tone } from "../lib/format.ts";

const TONE: Record<Tone, string> = {
  error: "bg-destructive",
  success: "bg-success",
  accent: "bg-primary",
  warning: "bg-warning",
  neutral: "bg-muted-foreground/45",
};

/** An agent's state as a colored dot; the label is what screen readers and tooltips say. */
export function StatusDot({
  tone,
  label,
  pulsing = false,
  className,
}: {
  tone: Tone;
  label: string;
  pulsing?: boolean;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("relative inline-flex size-2 shrink-0", className)}
    >
      {pulsing && (
        <span
          className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-50", TONE[tone])}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", TONE[tone])} />
    </span>
  );
}
