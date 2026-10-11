import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { RowrowMark } from "../components/Shell.tsx";

/** Shown when this browser has no device credential (docs/decisions.md, D-009). */
export function SignIn() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <RowrowMark className="size-5" />
        </span>
        <h1 className="text-lg font-semibold">Sign in to rowrow</h1>
        <p className="text-sm text-muted-foreground">
          This browser isn't signed in. rowrow uses one-time codes and links instead of passwords.
        </p>
        <CodeForm />
        <p className="text-sm text-muted-foreground">
          Or, on the machine running rowrow, run <Code>rowrow open</Code> (this browser) or{" "}
          <Code>rowrow pair</Code> (another device) for a link, or open{" "}
          <b className="text-foreground">Settings → Sign in another device</b> in a browser that is already
          signed in and scan the code.
        </p>
      </div>
    </div>
  );
}

/** A pairing code from `rowrow up` (D-060), traded for this browser's session cookie. */
function CodeForm() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void (async () => {
          try {
            const response = await fetch("/auth/pair", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code, kind: "browser" }),
            });
            if (response.ok) {
              window.location.reload();
              return;
            }
            const body = (await response.json().catch(() => ({}))) as { message?: string };
            setError(body.message ?? `Signing in failed (HTTP ${response.status}).`);
          } catch {
            setError("Couldn't reach rowrow. Check the connection and try again.");
          }
          setBusy(false);
        })();
      }}
    >
      <Label htmlFor="pairing-code">Pairing code</Label>
      <div className="flex gap-2">
        <Input
          id="pairing-code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={20}
          placeholder="ABCD-EFGH"
          className="font-mono tracking-wider uppercase"
          aria-invalid={error !== null}
          aria-describedby={error === null ? "pairing-code-help" : "pairing-code-error"}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button type="submit" disabled={busy || code.trim() === ""}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </div>
      {error === null ? (
        <p id="pairing-code-help" className="text-xs text-muted-foreground">
          <Code>rowrow up</Code> on the machine prints one.
        </p>
      ) : (
        <p id="pairing-code-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">{children}</code>
  );
}
