import { Button } from "@/components/ui/button";
import { WifiOff } from "lucide-react";
import { connection } from "../lib/connection.ts";
import { duration } from "../lib/format.ts";
import { useConnection } from "../lib/store.ts";
import { useNow } from "../lib/use-now.ts";

/** Says so when the server is out of reach; everything shown is then as of that moment. */
export function ConnectionBanner() {
  const status = useConnection((s) => s.status);
  const now = useNow(1000);
  if (status.kind !== "offline") return null;
  const retryIn = Math.max(0, Math.round((status.retryAt - now) / 1000));
  return (
    <section
      data-titlebar
      data-traffic-lights
      aria-label="Connection"
      className="flex shrink-0 items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm"
    >
      <WifiOff className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">Can't reach the rowrow server</span>
        <span className="text-muted-foreground">
          {` · offline for ${duration(now - status.since)}; what you see may be out of date. Retrying ${retryIn > 0 ? `in ${retryIn}s` : "now"}.`}
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={() => connection.retryNow()}>
        Retry now
      </Button>
    </section>
  );
}
