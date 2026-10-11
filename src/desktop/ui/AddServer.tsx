// Adding a machine (D-059): one over SSH (the app puts rowrow there), or one that runs rowrow
// already, by a sign-in link from it.
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
          {kind === "ssh" ? "Add an SSH host" : kind === "link" ? "Sign in to a machine" : "Add a machine"}
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
              rowrow installs itself there and keeps it running.
            </span>
          </button>
          <button
            type="button"
            className="rounded-xl border bg-card p-4 text-left hover:bg-accent"
            onClick={() => go("/add/link")}
          >
            <span className="block text-sm font-semibold">A machine that runs rowrow</span>
            <span className="mt-1 block text-sm text-muted-foreground">Sign in with a link from it.</span>
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
          password prompt (run it once in a terminal to trust its key). rowrow installs itself in{" "}
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
          On that machine, <code className="font-mono">rowrow pair</code> prints one; so does Settings → Sign
          in another device in its rowrow, on a device signed in to it. A link works once, for 10 minutes.
          This Mac then shows up there as a signed-in device you can revoke.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="link-name">Name (optional)</Label>
        <Input
          id="link-name"
          placeholder="the machine's name"
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
