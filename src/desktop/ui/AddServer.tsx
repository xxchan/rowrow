// Adding a machine (D-059, D-060): one that runs rowrow, found on this Mac's network or tailnet
// (or at an address you type) and signed in with the pairing code `rowrow up` shows there; one
// over SSH (the app puts rowrow there); or one that runs rowrow, by a sign-in link from it.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { NearbyMachine, ShellState } from "../api.ts";
import { api, go, run } from "./state.ts";

/** #/add, #/add/ssh, #/add/link, #/add/code (an address you type), #/add/code?url=…&name=…&via=… (one found). */
export function AddServer({ state, route }: { state: ShellState; route: string }) {
  const [path = "", query = ""] = route.split("?");
  const kind =
    path === "/add/ssh" ? "ssh" : path === "/add/link" ? "link" : path === "/add/code" ? "code" : null;
  const params = new URLSearchParams(query);
  const found = params.get("url");
  const name = params.get("name");
  return (
    <section aria-labelledby="add" className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          onClick={() => go(kind === null || (state.servers.length === 0 && kind !== "code") ? "/" : "/add")}
        >
          <ChevronLeft />
        </Button>
        <h2 id="add" className="truncate text-lg font-semibold">
          {kind === "ssh"
            ? "Add an SSH host"
            : kind === "link"
              ? "Sign in to a machine"
              : kind === "code"
                ? found === null
                  ? "Add a machine by its address"
                  : `Add ${name ?? "a machine"}`
                : "Add a machine"}
        </h2>
      </div>
      {kind === "ssh" ? (
        <SshForm />
      ) : kind === "link" ? (
        <LinkForm />
      ) : kind === "code" ? (
        <CodeForm
          key={route}
          url={found}
          name={name}
          via={params.get("via") === "lan" ? "lan" : params.get("via") === "tailscale" ? "tailscale" : null}
        />
      ) : (
        <>
          <Nearby />
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-muted-foreground">Other ways</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Way title="A machine over SSH" onClick={() => go("/add/ssh")}>
                rowrow installs itself there and keeps it running.
              </Way>
              <Way title="By its address" onClick={() => go("/add/code")}>
                A machine that runs rowrow where this Mac can reach it, with its pairing code.
              </Way>
              <Way title="With a sign-in link" onClick={() => go("/add/link")}>
                From <code className="font-mono">rowrow pair</code> on that machine.
              </Way>
              {state.localSupported && !state.servers.some((s) => s.kind === "local") && (
                <Way
                  title="This Mac"
                  onClick={() =>
                    void run("Setting up this Mac", () => api().setUpLocal()).then((ok) => ok && go("/"))
                  }
                >
                  Run agents here too.
                </Way>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Way({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="rounded-xl border bg-card p-4 text-left hover:bg-accent"
      onClick={onClick}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-sm text-muted-foreground">{children}</span>
    </button>
  );
}

/** Machines running rowrow that the app finds by itself, looked for again every few seconds while this shows. */
function Nearby() {
  const [machines, setMachines] = useState<readonly NearbyMachine[] | null>(null);
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async (): Promise<void> => {
      setLooking(true);
      try {
        const found = await api().discover();
        if (live) setMachines(found);
      } catch {
        if (live) setMachines((current) => current ?? []);
      }
      if (!live) return;
      setLooking(false);
      // A machine where `rowrow up` just ran turns up by itself.
      timer = setTimeout(() => void look(), 5000);
    };
    void look();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="nearby" className="text-sm font-semibold text-muted-foreground">
            On your network and tailnet
          </h3>
          <p className="text-xs text-muted-foreground">
            Machines where <code className="font-mono">rowrow up</code> ran: pick one and type the code it
            shows.
          </p>
        </div>
        {looking && (
          <Loader2 aria-label="Looking" className="size-4 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>
      {machines === null ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          Looking on this Mac's network and your tailnet…
        </p>
      ) : machines.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          None found yet. On the machine, run <code className="font-mono text-foreground">npx rowrow up</code>
          : it shows up here when it's on this Mac's network, or on your tailnet with Tailscale on this Mac.
        </p>
      ) : (
        <ul aria-labelledby="nearby" className="divide-y overflow-hidden rounded-xl border bg-card">
          {machines.map((machine) => (
            <li key={`${machine.id}${machine.url}`}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent"
                onClick={() =>
                  machine.added === null
                    ? go(
                        `/add/code?${new URLSearchParams({ url: machine.url, name: machine.name, via: machine.via }).toString()}`,
                      )
                    : void run("Opening it", () => api().open(machine.added ?? ""))
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{machine.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {`${machine.via === "tailscale" ? "Tailscale" : "This network"} · rowrow ${machine.version} · ${new URL(machine.url).host}`}
                  </span>
                </span>
                {machine.added !== null ? (
                  <Badge variant="secondary">Added</Badge>
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The pairing code `rowrow up` shows on that machine, for one found (its address given) or at an address typed here. */
function CodeForm({
  url,
  name: foundName,
  via,
}: {
  url: string | null;
  name: string | null;
  via: "tailscale" | "lan" | null;
}) {
  const [address, setAddress] = useState(url ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState(foundName ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void run("Adding the machine", () => api().addByCode(address, code, name.trim() === "" ? null : name))
          .then((ok) => ok && go("/"))
          .finally(() => setBusy(false));
      }}
    >
      {url === null ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="address">Address</Label>
          <Input
            id="address"
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="devbox.your-tailnet.ts.net, or 192.168.1.20"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Its Tailscale name or address, or its address on your network:{" "}
            <code className="font-mono">rowrow up</code> there prints them. Port 7373 unless you give another.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {via === "lan"
            ? `At ${url}, on this network. rowrow is plain HTTP here: anyone on this network can read it (over Tailscale it's encrypted).`
            : via === "tailscale"
              ? `At ${url}, over Tailscale, encrypted.`
              : `At ${url}.`}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="pairing-code">Pairing code</Label>
        <Input
          id="pairing-code"
          autoFocus={url !== null}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={20}
          placeholder="ABCD-EFGH"
          className="font-mono tracking-wider uppercase"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {`rowrow up on ${foundName ?? "that machine"} shows it; it works once, for 10 minutes, and rowrow up again gives a new one. This Mac then shows up there as a signed-in device you can revoke.`}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="code-name">Name (optional)</Label>
        <Input
          id="code-name"
          placeholder="the machine's name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <Button type="submit" disabled={busy || address.trim() === "" || code.trim() === ""}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
    </form>
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
