// Which agent is which, at a glance: each runtime's own mark (LobeHub's brand icons, MIT),
// inlined so single-color marks take the text color in either theme.
import { cn } from "@/lib/utils";
import claudeCode from "@lobehub/icons-static-svg/icons/claudecode-color.svg?raw";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import grok from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import pi from "@lobehub/icons-static-svg/icons/pi.svg?raw";
import { Bot, FlaskConical } from "lucide-react";
import type { Tone } from "../lib/format.ts";
import { StatusDot } from "./StatusDot.tsx";

const ICONS: Readonly<Record<string, string>> = { claude: claudeCode, codex, grok, kimi, pi };

/** A runtime's mark (`runtime` is its id: claude, codex, grok, kimi, pi…). */
export function AgentIcon({
  runtime,
  label,
  className,
}: {
  runtime: string;
  label?: string;
  className?: string;
}) {
  const svg = ICONS[runtime];
  const size = cn("size-4 shrink-0", className);
  if (svg === undefined) {
    const Fallback = runtime === "scripted" ? FlaskConical : Bot;
    return (
      <Fallback role="img" aria-label={label ?? runtime} className={cn(size, "text-muted-foreground")} />
    );
  }
  return (
    <span
      role="img"
      aria-label={label ?? runtime}
      className={cn("inline-flex [&>svg]:size-full", size)}
      // A build-time asset from the icon package, not user content.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** The runtime's mark with the agent's state as a dot on its corner, like an avatar's presence. */
export function AgentAvatar({
  runtime,
  runtimeName,
  tone,
  label,
  pulsing = false,
  size = "md",
  ring = "ring-background",
}: {
  runtime: string;
  runtimeName?: string;
  tone: Tone;
  label: string;
  pulsing?: boolean;
  size?: "sm" | "md" | "lg";
  /** The surface behind it, so the dot's ring cuts cleanly into the icon. */
  ring?: string;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <AgentIcon
        runtime={runtime}
        {...(runtimeName === undefined ? {} : { label: runtimeName })}
        className={size === "sm" ? "size-4" : size === "md" ? "size-5" : "size-6"}
      />
      <StatusDot
        tone={tone}
        label={label}
        pulsing={pulsing}
        className={cn("absolute -right-1 -bottom-0.5 rounded-full ring-2", ring)}
      />
    </span>
  );
}
