// What to do when a runtime's login ran out (a turn failed with oar's failure class "auth"):
// sign in again on the machine the server runs on, with the runtime's own CLI.

export type SignIn =
  | {
      /** The command to run in a terminal. */
      readonly run: string;
      /** What to type in it next, for CLIs that sign in from inside a session. */
      readonly type?: string;
    }
  /** It signs in with an API key in the server's environment (Cursor's SDK runs inside rowrow). */
  | { readonly env: string };

/** How to sign `runtime` in again, when we know; null: with its CLI's own sign-in. */
export function signInSteps(runtime: string): SignIn | null {
  switch (runtime) {
    case "claude":
      return { run: "claude", type: "/login" };
    case "codex":
      return { run: "codex login" };
    case "opencode":
      return { run: "opencode auth login" };
    case "cursor":
      return { env: "CURSOR_API_KEY" };
    default:
      return null;
  }
}

/**
 * What a runtime's sign-out leaves behind, past what it says itself: Cursor's only deletes its
 * login on this machine, and the API key it minted stays good (oar's cursor logout).
 */
export function logoutLeaves(runtime: string): string | null {
  return runtime === "cursor"
    ? "Cursor keeps accepting its API key until you revoke it in your Cursor dashboard."
    : null;
}
