import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useNow } from "../lib/use-now.ts";
import { connection } from "../lib/connection.ts";
import { duration } from "../lib/format.ts";
import { useConnection } from "../lib/store.ts";

/** Says so when the server is out of reach; everything shown is then as of that moment. */
export function ConnectionBanner() {
  const status = useConnection((s) => s.status);
  const now = useNow(1000);
  if (status.kind !== "offline") return null;
  const retryIn = Math.max(0, Math.round((status.retryAt - now) / 1000));
  return (
    <Banner
      status="warning"
      container="section"
      title="Can't reach the rowrow server"
      description={`Offline for ${duration(now - status.since)}; what you see may be out of date. Retrying ${retryIn > 0 ? `in ${retryIn}s` : "now"}.`}
      endContent={
        <Button label="Retry now" size="sm" variant="secondary" onClick={() => connection.retryNow()} />
      }
    />
  );
}
