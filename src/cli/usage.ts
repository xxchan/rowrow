// `rowrow runtimes usage`: each runtime's subscription windows, as Settings shows them (D-040).
import type { RuntimeUsage } from "../shared/schemas.ts";
import { paceOf, paceWords, untilWords, usageProblemWords } from "../shared/usage.ts";

export function formatUsage(list: readonly RuntimeUsage[], now = Date.now()): string {
  if (list.length === 0)
    return "No signed-in runtime here reports its usage (Claude Code, Codex, Grok and Kimi can).";
  return list
    .map((usage) => {
      const who = [usage.account?.plan, usage.account?.email ?? usage.account?.name].filter(Boolean);
      const read = usage.windows[0]?.history.at(-1)?.at;
      const head = [
        usage.runtime,
        ...who,
        ...(read === undefined
          ? []
          : [now - read < 60_000 ? "read just now" : `read ${untilWords(now, read)} ago`]),
      ];
      const lines = [head.join(" · ")];
      if (usage.rateLimited) lines.push("  rate limited now");
      if (usage.problem !== null) lines.push(`  ${usageProblemWords(usage.problem)}`);
      const width = Math.max(0, ...usage.windows.map((window) => window.label.length));
      for (const window of usage.windows) {
        const last = window.history.at(-1);
        if (last === undefined) continue;
        const parts = [`${Math.round(last.left)}% left`];
        if (last.resetsAt !== null) parts.push(`resets in ${untilWords(last.resetsAt, now)}`);
        parts.push(paceWords(paceOf(window.history, window.durationMs, now)).toLowerCase());
        lines.push(`  ${window.label.padEnd(width)}  ${parts.join(" · ")}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}
