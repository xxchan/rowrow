# Principles

These settle arguments. When a change conflicts with one of them, either change the
change or change the principle. To change a principle, add an entry to
[docs/decisions.md](docs/decisions.md) that says why.

## Product

1. **Attention is the scarce resource.** rowrow exists to send you to the agent that needs
   you, when it needs you, on whatever device you have with you. Every screen answers
   "who needs me, and why?" before anything else. A notification fires only when there is
   something new to look at, and never for something you are already looking at.

2. **Agents outlive every client.** The server owns the agents. Browsers, phones and the
   CLI are windows into it. Closing a tab, losing Wi-Fi or switching devices never
   interrupts work, and any window can pick up where another left off.

3. **Structured, not scraped.** Agents are driven through their programmatic interfaces
   (via [oar](https://github.com/botiverse/oar)), not through terminals. Status and
   transcripts come from what the runtime reported. A state nobody reported is unknown,
   never guessed. A turn is done when the runtime says so.

4. **The human stays in the loop where it matters.** rowrow never sends input on your
   behalf. Review feedback and command pickers fill the composer; you press send.
   Destructive actions are narrow, confirmed, and re-checked so they never destroy newer
   work.

5. **Anywhere, and safe to expose.** Remote control is a core feature and a real attack
   surface: an agent can run anything on the host. rowrow listens on loopback until you
   say otherwise, every request needs a revocable device credential (even from loopback,
   because tunnels and proxies arrive there), and secrets never appear in logs or URLs
   that outlive their use.

6. **Phone-grade by default.** Every feature works at 375 px wide, with touch, IME and
   dictation, over a flaky network. The desktop adds density and keyboard speed; it
   doesn't get features the phone can't reach.

7. **Local first: the machine is the only server.** Clients connect straight to the
   machine that runs the agents, over a network the user already trusts (loopback, a LAN,
   Tailscale). rowrow never dials out to a relay, needs no account, and runs no service of
   its own; nothing rowrow stores leaves the machine. This is who rowrow is for: people,
   often at companies, who can't use remote-control apps that route through a vendor's
   server. A feature that needs a third party in the path is optional, off by default, and
   says so where you turn it on.

## Engineering

1. **The agent log is the truth; everything else is a fold.** Each agent has one
   append-only, totally ordered log: rowrow's own facts (a run started, you sent this,
   the process died) and oar's records verbatim. Status, attention, transcripts and
   summaries are pure functions of it that can be deleted and rebuilt. We never store a
   derived value as if it were a fact, and never rewrite history.

2. **Every stream resumes from a cursor.** Disconnection is the normal case. Every live
   stream can be resumed from a cursor with no loss and no duplication, and every
   mutation a client might retry carries an idempotency key.

3. **One contract, every client.** Every capability is a typed procedure in
   `src/shared/contract`, validated at runtime. The web app, the `rowrow` CLI and agents
   all use it. If the UI can show or do something, an agent can query or do it from the
   CLI.

4. **Observable by construction.** Every boundary crossing is a structured log event with
   a trace id that follows the action from the browser through the server to oar. Browser
   errors land in the server log. Every piece of live state can be dumped, and every UI
   state can be reproduced by replaying a log. If an agent can't answer "what happened?"
   with our tools, the tools have a bug, and fixing it is part of the task.

5. **Deterministic tests, zero tokens.** Every layer can run against a scripted runtime.
   A change is done when `pnpm check` passes and a test at the cheapest layer that can
   catch its regression proves it. Real agent runtimes cost the user's quota and are used
   on purpose, never by default.

6. **Fix it upstream.** oar is ours. When it lacks something rowrow needs, we change oar
   (with its tests and docs) instead of working around it here.

7. **Move fast, decide explicitly.** Before 1.0 there is no compatibility promise for
   internal APIs, data or wire formats: migrate or reset, and delete freely. Any decision
   that constrains later work gets a decision-log entry with what would make us revisit
   it.

8. **Small, boring, legible.** Few dependencies, plain modules named after the domain,
   comments that explain why. Node runs the server's TypeScript directly, so a stack trace
   points at the line you wrote.
