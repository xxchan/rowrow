// Adding a server: a host over SSH (the app puts rowrow's server there), or a server you can
// reach, by its sign-in link.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import type { ShellState } from "../api.ts";
import { api, go, run } from "./state.ts";

export function AddServer({ state, kind }: { state: ShellState; kind: "ssh" | "link" | null }) {
  return (
    <section aria-labelledby="add" className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          onClick={() => go(kind === null || state.servers.length === 0 ? "/" : "/add")}
        >
          <ChevronLeft />
        </Button>
        <h2 id="add" className="text-lg font-semibold">
          {kind === "ssh" ? "Add an SSH host" : kind === "link" ? "Sign in to a server" : "Add a server"}
        </h2>
      </div>
      {kind === "ssh" ? (
        <SshForm />
      ) : kind === "link" ? (
        <LinkForm />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            className="rounded-xl border bg-card p-4 text-left hover:bg-accent"
            onClick={() => go("/add/ssh")}
          >
            <span className="block text-sm font-semibold">A machine over SSH</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              rowrow puts its server there and runs it.
            </span>
          </button>
          <button
            type="button"
            className="rounded-xl border bg-card p-4 text-left hover:bg-accent"
            onClick={() => go("/add/link")}
          >
            <span className="block text-sm font-semibold">A server you can reach</span>
            <span className="mt-1 block text-sm text-muted-foreground">Sign in with its link.</span>
          </button>
          {state.localSupported && !state.servers.some((s) => s.kind === "local") && (
            <button
              type="button"
              className="rounded-xl border bg-card p-4 text-left hover:bg-accent sm:col-span-2"
              onClick={() =>
                void run("Setting up this Mac", () => api().setUpLocal()).then((ok) => ok && go("/"))
              }
            >
              <span className="block text-sm font-semibold">This Mac</span>
              <span className="mt-1 block text-sm text-muted-foreground">Run agents here too.</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function SshForm() {
  const [destination, setDestination] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void run("Adding the host", () => api().addSsh(destination, name === "" ? null : name))
          .then((ok) => ok && go("/"))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="destination">Host</Label>
        <Input
          id="destination"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="devbox, or you@devbox.example.com"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          rowrow uses your ssh: <code className="font-mono">~/.ssh/config</code>, your keys and agent,
          ProxyJump. The host must let <code className="font-mono">ssh &lt;host&gt;</code> in without a
          password prompt (run it once in a terminal to trust its key). rowrow installs its server in{" "}
          <code className="font-mono">~/.rowrow</code> there (Linux x64 or arm64, or an Apple silicon Mac) and
          keeps it running with systemd or launchd.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ssh-name">Name (optional)</Label>
        <Input
          id="ssh-name"
          placeholder="devbox"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <Button type="submit" disabled={busy || destination.trim() === ""}>
          {busy ? "Adding…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function LinkForm() {
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void run("Signing in", () => api().addLink(link, name === "" ? null : name))
          .then((ok) => ok && go("/"))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="link">Sign-in link</Label>
        <Textarea
          id="link"
          autoFocus
          rows={3}
          spellCheck={false}
          placeholder="https://devbox.your-tailnet.ts.net/auth/redeem?code=…"
          value={link}
          onChange={(event) => setLink(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          On the machine running rowrow, <code className="font-mono">rowrow pair</code> prints one; in rowrow
          on a device that's signed in, it's under Settings → Pair a device. A link works once, for 10
          minutes. This Mac then shows up there as a device you can revoke.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="link-name">Name (optional)</Label>
        <Input
          id="link-name"
          placeholder="the server's name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <Button type="submit" disabled={busy || link.trim() === ""}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}
