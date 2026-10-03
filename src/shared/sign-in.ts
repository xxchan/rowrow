// What to do when a runtime's login ran out (a turn failed with oar's failure class "auth"):
// sign in again on the machine the server runs on, with the runtime's own CLI.

export interface SignIn {
  /** The command to run in a terminal. */
  readonly run: string;
  /** What to type in it next, for CLIs that sign in from inside a session. */
  readonly type?: string;
}

/** How to sign `runtime` in again, when we know; null: with its CLI's own sign-in. */
export function signInSteps(runtime: string): SignIn | null {
  switch (runtime) {
    case "claude":
      return { run: "claude", type: "/login" };
    case "codex":
      return { run: "codex login" };
    case "cursor":
      return { run: "cursor-agent login" };
    default:
      return null;
  }
}
