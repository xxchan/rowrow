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
          This browser isn't signed in. rowrow uses one-time sign-in links instead of passwords.
        </p>
        <p className="text-sm text-muted-foreground">
          On the computer running rowrow, run <Code>rowrow open</Code> (this browser) or{" "}
          <Code>rowrow pair</Code> (another device), or open{" "}
          <b className="text-foreground">Settings → Pair a device</b> in a browser that is already signed in
          and scan the code.
        </p>
      </div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">{children}</code>
  );
}
