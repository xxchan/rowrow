// `rowrow runtimes login <runtime>`: sign a runtime in through the server (runtimes.login),
// printing what to open or type to stderr and reading the code it asks for from stdin.
// Ctrl-C cancels it; the previous login stays as it was.
import readline from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { LoginEvent, LoginResult } from "../shared/schemas.ts";
import type { Client } from "./client.ts";

const POLL_MS = 500;

export async function login(client: Client, runtime: string): Promise<LoginResult> {
  const settled = new AbortController();
  const done = client.runtimes.login({ runtime }).finally(() => settled.abort());
  // Awaited after the loop; until then a failure must not count as unhandled.
  done.catch(() => undefined);
  const cancel = (): void => {
    client.runtimes.loginCancel({ runtime }).catch((error: unknown) => {
      process.stderr.write(`couldn't cancel: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  rl.on("SIGINT", cancel);
  process.on("SIGINT", cancel);
  let shown = 0;
  let asked: string | null = null;
  try {
    while (!settled.signal.aborted) {
      const progress = (await client.runtimes.list({})).find((info) => info.id === runtime)?.login ?? null;
      if (progress !== null) {
        for (const event of progress.events.slice(shown)) process.stderr.write(`${eventText(event)}\n`);
        shown = progress.events.length;
        const prompt = progress.prompt;
        if (prompt !== null && prompt.id !== asked) {
          asked = prompt.id;
          const choices =
            prompt.options === undefined
              ? ""
              : ` (${prompt.options.map((option) => `${option.id}: ${option.label}`).join(", ")})`;
          const answer = await rl
            .question(`${prompt.message}${choices}: `, { signal: settled.signal })
            .catch(() => null);
          if (answer !== null) {
            await client.runtimes
              .loginAnswer({ runtime, promptId: prompt.id, answer: answer.trim() })
              .catch((error: unknown) =>
                process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`),
              );
          }
          continue;
        }
      }
      await sleep(POLL_MS, undefined, { signal: settled.signal }).catch(() => undefined);
    }
    return await done;
  } finally {
    rl.close();
    process.off("SIGINT", cancel);
  }
}

function eventText(event: LoginEvent): string {
  switch (event.kind) {
    case "auth_url":
      return `Open ${event.url}${event.instructions === undefined ? "" : `\n${event.instructions}`}`;
    case "device_code":
      return `Enter the code ${event.userCode} at ${event.verificationUri}`;
    case "info":
      return event.message;
  }
}

export function formatLogin(result: LoginResult): string {
  switch (result.kind) {
    case "logged_in": {
      const { email, plan } = result.account ?? {};
      return `signed in${email === undefined ? "" : ` as ${email}`}${plan === undefined ? "" : ` (${plan})`}`;
    }
    case "failed":
      return `sign-in failed (${result.reason})${result.detail === undefined ? "" : `: ${result.detail}`}`;
    case "cancelled":
      return "cancelled: the previous login is unchanged";
    case "unsupported":
      return `can't sign it in here: ${result.detail ?? result.reason}`;
  }
}
