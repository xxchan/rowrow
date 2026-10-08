// Settings → Subscription usage (D-040): for each signed-in runtime that reports it, how much
// of each window is left, how that compares with an even burn, and the last two days of it.
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useState, type PointerEvent } from "react";
import { toast } from "sonner";
import type { RuntimeInfo, RuntimeUsage, UsagePoint, UsageWindow } from "../../shared/schemas.ts";
import {
  chartSegments,
  cycleStarts,
  evenBurn,
  paceOf,
  paceWords,
  untilWords,
  usageProblemWords,
} from "../../shared/usage.ts";
import { ago } from "../lib/format.ts";
import { useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { AgentIcon } from "./AgentIcon.tsx";

/** The server reads every 5 minutes; the page asks as often. */
const POLL_MS = 5 * 60_000;
const RANGE_MS = 2 * 24 * 3_600_000;
/** Categorical, in this order (validated for color blindness, light and dark). */
const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"];

export type Usage = ReturnType<typeof useUsage>;

export function useUsage() {
  const client = useClient();
  // When it was fetched, too: what's shown is relative to then (resets in…, read … ago).
  const [read, setRead] = useState<{ list: RuntimeUsage[]; at: number } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const fetchList = async (): Promise<void> => {
      try {
        const list = await client.runtimes.usage({});
        if (!cancelled) setRead({ list, at: Date.now() });
      } catch (error) {
        report("warn", "settings.usage_failed", error);
      }
    };
    void fetchList();
    const timer = setInterval(() => void fetchList(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);

  const recheck = useCallback(async () => {
    if (client === null) return;
    setChecking(true);
    try {
      setRead({ list: await client.runtimes.usage({ refresh: true }), at: Date.now() });
    } catch (error) {
      toast.error(`Reading usage: ${error instanceof Error ? error.message : String(error)}`);
      report("warn", "settings.usage_failed", error);
    } finally {
      setChecking(false);
    }
  }, [client]);
  return { read, checking, recheck: () => void recheck() };
}

export function UsageList({ usage, runtimes }: { usage: Usage; runtimes: Record<string, RuntimeInfo> }) {
  if (usage.read === null) return <p className="text-sm text-muted-foreground">Reading…</p>;
  const { list, at: now } = usage.read;
  if (list.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No signed-in runtime here reports its usage. Claude Code, Codex, Grok and Kimi can.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {list.map((item) => (
        <RuntimeCard
          key={item.runtime}
          item={item}
          name={runtimes[item.runtime]?.name ?? item.runtime}
          now={now}
        />
      ))}
    </div>
  );
}

function RuntimeCard({ item, name, now }: { item: RuntimeUsage; name: string; now: number }) {
  const who = item.account?.email ?? item.account?.name;
  const read = item.windows[0]?.history.at(-1)?.at;
  return (
    <section aria-label={`${name} usage`} className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <AgentIcon runtime={item.runtime} />
        <span className="shrink-0 text-sm font-medium whitespace-nowrap">{name}</span>
        {item.account?.plan && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {item.account.plan}
          </span>
        )}
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {[
            who,
            read === undefined
              ? null
              : `read ${ago(read, now) === "now" ? "just now" : `${ago(read, now)} ago`}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {item.rateLimited && <p className="text-xs text-warning">Rate limited now.</p>}
      {item.problem !== null && (
        <p
          className={cn(
            "text-xs",
            item.problem.kind === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {usageProblemWords(item.problem)}
        </p>
      )}
      {item.windows.length > 0 && (
        <>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {item.windows.map((window, index) => (
              <WindowMeter key={window.id} window={window} color={SERIES[index % SERIES.length]} now={now} />
            ))}
          </div>
          <UsageChart windows={item.windows.slice(0, SERIES.length)} now={now} />
        </>
      )}
    </section>
  );
}

function WindowMeter({
  window,
  color,
  now,
}: {
  window: UsageWindow;
  color: string | undefined;
  now: number;
}) {
  const last = window.history.at(-1);
  if (last === undefined) return null;
  const pace = paceOf(window.history, window.durationMs, now);
  const expected =
    pace.kind === "known" && last.resetsAt !== null ? evenBurn(last.resetsAt, pace.spanMs, last.at) : null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-sm">
        <span
          aria-hidden
          className="h-0.5 w-3 shrink-0 self-center rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="min-w-0 truncate font-medium">{window.label}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {Math.round(last.left)}% left
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${window.label} left`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(last.left)}
        className="relative h-1.5 rounded-full bg-muted"
      >
        <div className="h-full rounded-full" style={{ width: `${last.left}%`, backgroundColor: color }} />
        {expected !== null && (
          <div
            title={`An even burn leaves ${Math.round(expected)}%`}
            className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-foreground"
            style={{ left: `calc(${expected}% - 1px)` }}
          />
        )}
      </div>
      <div className="flex gap-2 text-xs text-muted-foreground">
        <span
          className={cn(pace.kind === "known" && Math.round(pace.reserve) < 0 && "text-destructive")}
          title="Compared with using it evenly until it resets"
        >
          {paceWords(pace)}
        </span>
        {last.resetsAt !== null && <span>Resets in {untilWords(last.resetsAt, now)}</span>}
      </div>
    </div>
  );
}

/** Percent left over the last two days: a line per window, an even burn dashed for its cycle. */
function UsageChart({ windows, now }: { windows: readonly UsageWindow[]; now: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const from = now - RANGE_MS;
  const x = (at: number): number => ((at - from) / RANGE_MS) * 100;
  const y = (left: number): number => 100 - left;
  const shown = (points: readonly UsagePoint[]) => points.filter((point) => point.at >= from);
  // The crosshair snaps to the nearest reading of any window.
  const times = windows.flatMap((window) => shown(window.history).map((point) => point.at));
  const onMove = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = from + ((event.clientX - box.left) / box.width) * RANGE_MS;
    setHover(
      times.reduce((best, time) => (Math.abs(time - at) < Math.abs(best - at) ? time : best), times[0] ?? at),
    );
  };
  const readout =
    hover === null
      ? []
      : windows.map((window, index) => ({
          window,
          color: SERIES[index],
          point: valueAt(window.history, hover),
        }));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="flex w-8 shrink-0 flex-col justify-between text-right text-[10px] text-muted-foreground tabular-nums">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <div
          role="img"
          aria-label={`Percent left over the last two days: ${windows.map((window) => window.label).join(", ")}`}
          className="relative h-28 min-w-0 flex-1 touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            {[0, 50, 100].map((line) => (
              <line
                key={line}
                x1={0}
                x2={100}
                y1={y(line)}
                y2={y(line)}
                className="stroke-border"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {windows.map((window, index) => {
              const burn = evenBurnLine(window, now);
              return (
                <g key={window.id} stroke={SERIES[index]} fill="none">
                  {burn !== null && burn.end > from && (
                    <line
                      x1={x(Math.max(burn.start, from))}
                      y1={y(evenBurn(burn.end, burn.end - burn.start, Math.max(burn.start, from)))}
                      x2={x(Math.min(burn.end, now))}
                      y2={y(evenBurn(burn.end, burn.end - burn.start, Math.min(burn.end, now)))}
                      strokeWidth={1}
                      strokeDasharray="4 3"
                      opacity={0.7}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {chartSegments(shown(window.history)).map((segment) => (
                    <polyline
                      key={segment[0]?.at}
                      points={segment.map((point) => `${x(point.at)},${y(point.left)}`).join(" ")}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              );
            })}
          </svg>
          {/* Dots in HTML, round however the plot stretches: a reading with no line through it, and the latest. */}
          {windows.flatMap((window, index) => {
            const lone = chartSegments(shown(window.history)).flatMap((segment) =>
              segment.length === 1 ? segment : [],
            );
            const last = shown(window.history).at(-1);
            return [
              ...lone.filter((point) => point !== last).map((point) => ({ point, latest: false })),
              ...(last === undefined ? [] : [{ point: last, latest: true }]),
            ].map(({ point, latest }) => (
              <span
                key={`${window.id}-${point.at}`}
                aria-hidden
                className={cn(
                  "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full",
                  latest ? "size-2 ring-2 ring-card" : "size-1",
                )}
                style={{ left: `${x(point.at)}%`, top: `${y(point.left)}%`, backgroundColor: SERIES[index] }}
              />
            ));
          })}
          {hover !== null && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
                style={{ left: `${x(hover)}%` }}
              />
              <div
                className={cn(
                  "pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-md",
                  x(hover) > 60 ? "-translate-x-full -ml-2" : "ml-2",
                )}
                style={{ left: `${x(hover)}%` }}
              >
                <div className="mb-1 text-muted-foreground">{timeWords(hover)}</div>
                {readout.map(({ window, color, point }) => (
                  <div key={window.id} className="flex items-center gap-2 whitespace-nowrap">
                    <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: color }} />
                    <span className="font-medium tabular-nums">
                      {point === null ? "—" : `${Math.round(point.left)}%`}
                    </span>
                    <span className="text-muted-foreground">{window.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="ml-10 flex justify-between text-[10px] text-muted-foreground">
        <span>{timeWords(from)}</span>
        <span>Now</span>
      </div>
    </div>
  );
}

/** The current cycle's start and reset, when its length is known (as for its pace). */
function evenBurnLine(window: UsageWindow, now: number): { start: number; end: number } | null {
  const last = window.history.at(-1);
  const pace = paceOf(window.history, window.durationMs, now);
  if (last?.resetsAt === null || last === undefined || pace.kind === "unknown") return null;
  return { start: last.resetsAt - pace.spanMs, end: last.resetsAt };
}

/** The reading in effect at `at`: the last one at or before it, in the same cycle as the next. */
function valueAt(points: readonly UsagePoint[], at: number): UsagePoint | null {
  let found: UsagePoint | null = null;
  for (const point of points) {
    if (point.at > at) break;
    found = point;
  }
  if (found === null) return null;
  const next = points[points.indexOf(found) + 1];
  // Past the cycle's reset, or across a break in the line, it isn't known.
  if (found.resetsAt !== null && at >= found.resetsAt) return null;
  if (next !== undefined && cycleStarts([found, next]).length > 1 && at > found.at + 15 * 60_000) return null;
  return found;
}

function timeWords(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
