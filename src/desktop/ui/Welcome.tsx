// The first page: where do your agents run? On this Mac (the app runs rowrow here), or on
// another machine (a dev box over SSH, where the app puts rowrow, or one that runs rowrow already
// and signs this app in with a link). Every machine is added here or later in the same way
// (D-059), never from a machine's "Sign in another device", which signs a device in instead.
import { Button } from "@/components/ui/button";
import { Laptop, Link2, Server } from "lucide-react";
import { useState } from "react";
import type { ShellState } from "../api.ts";
import { api, go, run } from "./state.ts";

export function Welcome({ state }: { state: ShellState }) {
  const [busy, setBusy] = useState(false);
  const found = state.localFound;
  const setUp = (): void => {
    setBusy(true);
    void run("Setting up this Mac", () => api().setUpLocal()).finally(() => setBusy(false));
  };
  return (
    <section aria-labelledby="welcome" className="flex flex-col gap-4">
      <div>
        <h2 id="welcome" className="text-xl font-semibold">
          Where do your agents run?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Agents run on a machine: this Mac, or one you reach from it. They keep working while this app is
          closed. This app is a window onto each machine, and your phone can be another.
        </p>
      </div>

      <Choice
        icon={<Laptop />}
        title="On this Mac"
        body={
          found === null
            ? "rowrow installs itself here and macOS keeps it running (it starts when you log in), so this Mac is also where your agents work."
            : `rowrow ${found.version ?? ""} already runs here (${found.owner === "cli" ? "a service you installed with the rowrow command" : found.owner === "app" ? "a service this app installed" : "started in a terminal"}). Connect to it; nothing changes about how it runs.`
        }
      >
        <Button onClick={setUp} disabled={busy || !state.localSupported}>
          {busy ? "Setting up…" : found === null ? "Set up this Mac" : "Connect to it"}
        </Button>
        {!state.localSupported && (
          <span className="text-xs text-muted-foreground">This build can't run agents on this Mac.</span>
        )}
      </Choice>

      <Choice
        icon={<Server />}
        title="On a machine you reach over SSH"
        body="A dev box, a cloud VM, a Mac mini in the closet: rowrow installs itself there and keeps it running, the way VS Code's Remote-SSH does. Agents work there; this Mac connects through SSH."
      >
        <Button variant="outline" onClick={() => go("/add/ssh")}>
          Add an SSH host
        </Button>
      </Choice>

      <Choice
        icon={<Link2 />}
        title="On a machine that already runs rowrow"
        body={
          <>
            Reachable over Tailscale or your network: run{" "}
            <code className="font-mono text-foreground">rowrow pair</code> on that machine and paste the link
            it prints, which signs this app in there.
          </>
        }
      >
        <Button variant="outline" onClick={() => go("/add/link")}>
          Paste a sign-in link
        </Button>
      </Choice>
    </section>
  );
}

function Choice({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 rounded-xl border bg-card p-4 sm:p-5">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4.5">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">{children}</div>
      </div>
    </div>
  );
}
