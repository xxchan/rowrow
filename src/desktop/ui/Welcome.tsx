// The first page: where do your agents run? On this Mac (the app runs rowrow's server here),
// or on another machine (a dev box over SSH, where the app puts the server, or a server you can
// already reach). Both can come later too.
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
          rowrow runs coding agents in a server that keeps working while this app is closed. This app is a
          window onto it, and your phone can be another.
        </p>
      </div>

      <Choice
        icon={<Laptop />}
        title="On this Mac"
        body={
          found === null
            ? "rowrow installs its server here and macOS keeps it running (it starts when you log in), so this Mac is also where your agents work."
            : `rowrow ${found.version ?? ""} already runs here (${found.owner === "cli" ? "a service you installed with the rowrow command" : found.owner === "app" ? "a service this app installed" : "started in a terminal"}). Connect to it; nothing changes about how it runs.`
        }
      >
        <Button onClick={setUp} disabled={busy || !state.localSupported}>
          {busy ? "Setting up…" : found === null ? "Set up this Mac" : "Connect to it"}
        </Button>
        {!state.localSupported && (
          <span className="text-xs text-muted-foreground">This build has no server for this Mac.</span>
        )}
      </Choice>

      <Choice
        icon={<Server />}
        title="On a machine you reach over SSH"
        body="A dev box, a cloud VM, a Mac mini in the closet: rowrow puts its server there and keeps it running, the way VS Code's Remote-SSH does. Agents work there; this Mac connects through SSH."
      >
        <Button variant="outline" onClick={() => go("/add/ssh")}>
          Add an SSH host
        </Button>
      </Choice>

      <Choice
        icon={<Link2 />}
        title="On a server you can already reach"
        body={
          <>
            rowrow running on another machine, reachable over Tailscale or your network: sign in with a link
            from <code className="font-mono text-foreground">rowrow pair</code>, or from Pair a device in its
            settings.
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
