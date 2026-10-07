// Signing a runtime in from Settings, without a terminal (D-038): the runtime's own login runs
// on the server's machine; the page to open, the code to type and the code to paste back come
// through the runtime's `login` in state, so any window can finish a sign-in another started.
// Sign out runs its own logout there, which signs it out for everything on that machine.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, ExternalLink, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type {
  AuthState,
  LoginEvent,
  LoginProgress,
  LoginResult,
  LogoutResult,
  RuntimeInfo,
} from "../../shared/schemas.ts";
import { useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";

export type RuntimeLogins = ReturnType<typeof useRuntimeLogins>;

/** Sign-ins and sign-outs this window started, and how each ended (until the next one). */
export function useRuntimeLogins() {
  const client = useClient();
  const [results, setResults] = useState<Record<string, LoginResult>>({});
  const [logouts, setLogouts] = useState<Record<string, LogoutResult>>({});
  const [signingOut, setSigningOut] = useState<Record<string, true>>({});

  const start = async (runtime: RuntimeInfo): Promise<void> => {
    if (client === null) return;
    setResults(({ [runtime.id]: _old, ...rest }) => rest);
    setLogouts(({ [runtime.id]: _old, ...rest }) => rest);
    try {
      const result = await client.runtimes.login({ runtime: runtime.id });
      setResults((now) => ({ ...now, [runtime.id]: result }));
      if (result.kind === "logged_in") {
        const email = result.account?.email;
        toast.success(`${runtime.name} is signed in${email === undefined ? "" : ` as ${email}`}`);
      }
    } catch (error) {
      toast.error(`Signing ${runtime.name} in: ${message(error)}`);
      report("warn", "settings.runtime_login_failed", error, { runtime: runtime.id });
    }
  };

  const answer = async (runtime: RuntimeInfo, promptId: string, text: string): Promise<void> => {
    if (client === null) return;
    try {
      await client.runtimes.loginAnswer({ runtime: runtime.id, promptId, answer: text });
    } catch (error) {
      toast.error(message(error));
      report("warn", "settings.runtime_login_answer_failed", error, { runtime: runtime.id });
    }
  };

  const cancel = async (runtime: RuntimeInfo): Promise<void> => {
    if (client === null) return;
    try {
      await client.runtimes.loginCancel({ runtime: runtime.id });
    } catch (error) {
      toast.error(message(error));
      report("warn", "settings.runtime_login_cancel_failed", error, { runtime: runtime.id });
    }
  };

  const logout = async (runtime: RuntimeInfo): Promise<void> => {
    if (client === null) return;
    setResults(({ [runtime.id]: _old, ...rest }) => rest);
    setLogouts(({ [runtime.id]: _old, ...rest }) => rest);
    setSigningOut((now) => ({ ...now, [runtime.id]: true }));
    try {
      const result = await client.runtimes.logout({ runtime: runtime.id });
      setLogouts((now) => ({ ...now, [runtime.id]: result }));
      if (result.kind === "logged_out") toast.success(`${runtime.name} is signed out`);
    } catch (error) {
      toast.error(`Signing ${runtime.name} out: ${message(error)}`);
      report("warn", "settings.runtime_logout_failed", error, { runtime: runtime.id });
    } finally {
      setSigningOut(({ [runtime.id]: _done, ...rest }) => rest);
    }
  };

  return { results, logouts, signingOut, start, answer, cancel, logout };
}

/** Who it is signed in as, or that it isn't; nothing when it can't say. */
export function authNote(auth: AuthState | null): string | null {
  if (auth?.kind === "logged_out") return "Not signed in";
  if (auth?.kind !== "logged_in") return null;
  const { email, plan } = auth.account ?? {};
  return ["Signed in", email === undefined ? null : `as ${email}`, plan === undefined ? null : `(${plan})`]
    .filter((part) => part !== null)
    .join(" ");
}

export function loginResultNote(result: LoginResult): string | null {
  switch (result.kind) {
    case "logged_in":
    case "cancelled":
      return null;
    case "failed":
      return `Sign-in failed: ${result.detail ?? FAILED[result.reason] ?? result.reason}`;
    case "unsupported":
      return result.detail ?? "rowrow can't sign this installation in: use its own CLI.";
  }
}

export function logoutResultNote(result: LogoutResult): string | null {
  switch (result.kind) {
    case "logged_out":
      return null;
    case "failed":
      return result.reason === "still_logged_in"
        ? "Still signed in: something besides its login signs it in, such as an API key in its environment, which rowrow leaves alone."
        : `Sign-out failed: ${result.detail ?? FAILED[result.reason] ?? result.reason}`;
    case "unsupported":
      return result.detail ?? "rowrow can't sign this installation out: use its own CLI.";
  }
}

/** What signing a runtime out means, for the question before it. */
export function logoutQuestion(runtime: RuntimeInfo): string {
  return [
    `This runs ${runtime.name}'s own sign-out on the machine rowrow runs on, so it is signed out there for everything, not just rowrow. Agents that use it can't work until it's signed in again.`,
    "An API key in its environment stays.",
    LOGOUT_NOTE[runtime.id],
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

/** What a runtime's sign-out leaves behind, past what it says itself. */
const LOGOUT_NOTE: Record<string, string> = {
  cursor: "Cursor keeps accepting its API key until you revoke it in your Cursor dashboard.",
};

const FAILED: Record<string, string> = {
  timed_out: "it took too long.",
  rejected: "the runtime didn't accept it.",
  process_failed: "the runtime's command didn't run.",
  not_logged_in: "it finished, but it still isn't signed in.",
};

/** A sign-in running now: what to open or type, the question it waits on, and Cancel. */
export function LoginPanel({
  runtime,
  login,
  logins,
}: {
  runtime: RuntimeInfo;
  login: LoginProgress;
  logins: RuntimeLogins;
}) {
  return (
    <div
      className="mt-2 space-y-2 rounded-md border bg-muted/40 p-2.5 text-xs"
      aria-label={`Signing ${runtime.name} in`}
    >
      {login.events.map((event, index) => (
        <LoginStep key={index} event={event} />
      ))}
      {login.prompt === null ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" />
          Waiting for the sign-in to finish…
        </p>
      ) : (
        <LoginQuestion
          key={login.prompt.id}
          prompt={login.prompt}
          onAnswer={(text) => logins.answer(runtime, login.prompt?.id ?? "", text)}
        />
      )}
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void logins.cancel(runtime)}>
        Cancel
      </Button>
    </div>
  );
}

function LoginStep({ event }: { event: LoginEvent }) {
  switch (event.kind) {
    case "auth_url":
      return (
        <div className="space-y-1">
          <Button size="sm" variant="outline" asChild>
            <a href={event.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open the sign-in page
            </a>
          </Button>
          {event.instructions !== undefined && <p className="text-muted-foreground">{event.instructions}</p>}
        </div>
      );
    case "device_code":
      return (
        <div className="space-y-1">
          <p className="text-muted-foreground">
            Enter this code at{" "}
            <a className="underline" href={event.verificationUri} target="_blank" rel="noreferrer">
              {event.verificationUri}
            </a>
            :
          </p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-background px-2 py-1 font-mono text-base tracking-widest">
              {event.userCode}
            </code>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Copy code"
              onClick={() => void copy(event.userCode)}
            >
              <Copy />
            </Button>
          </div>
        </div>
      );
    case "info":
      return <p className="whitespace-pre-wrap text-muted-foreground">{event.message}</p>;
  }
}

function LoginQuestion({
  prompt,
  onAnswer,
}: {
  prompt: NonNullable<LoginProgress["prompt"]>;
  onAnswer: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (value: string): Promise<void> => {
    setSending(true);
    try {
      await onAnswer(value);
    } finally {
      setSending(false);
    }
  };
  if (prompt.kind === "select") {
    return (
      <div className="space-y-1">
        <p>{prompt.message}</p>
        <div className="flex flex-wrap gap-1.5">
          {(prompt.options ?? []).map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant="outline"
              disabled={sending}
              title={option.description}
              onClick={() => void send(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <form
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() !== "") void send(text.trim());
      }}
    >
      <label className="block" htmlFor={`login-${prompt.id}`}>
        {prompt.message}
      </label>
      <div className="flex gap-1.5">
        <Input
          id={`login-${prompt.id}`}
          className="h-8 font-mono text-xs"
          type={prompt.kind === "secret" ? "password" : "text"}
          autoComplete="off"
          autoFocus
          placeholder={prompt.placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={sending || text.trim() === ""}>
          {sending && <LoaderCircle className="animate-spin" />}
          Continue
        </Button>
      </div>
    </form>
  );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Code copied");
  } catch (error) {
    toast.error(`Couldn't copy: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
