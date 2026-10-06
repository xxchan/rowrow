// A runtime whose "model" is a small script (oar's scriptedRuntime): real sessions, real
// records, zero tokens. Tests drive it with commands; in dev it lets you try the UI. It is
// registered only when the server runs with a test runtime (never in the default profile).
//
// Commands (the first line of the input):
//   /echo <text>            say exactly <text>
//   /write <path>           write the following lines to <path> (relative to the cwd), as a Write tool call
//   /sleep <ms>             work for <ms> (abortable), then say so
//   /stream <n>             say n chunks, 40 ms apart
//   /fail <reason>          end the turn failed with <reason>
//   /run <ms> <command>     run <command> as a Bash tool call that takes <ms>
//   /background <ms> <text> start <text> as a background command, end the turn, and finish
//                           the command <ms> later (a task that outlives its turn)
// Anything else gets a short demo answer with a thought, a tool call and some Markdown. With
// attachments, commands are read from the request after the list of files, and the answer
// says which files and images arrived.
//
// It starts signed out. Its sign-in shows a page to open and asks for the code on it, which
// is always "rowrow".
import type { Runtime, SkillEntry } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Its commands, listed the way a real runtime lists its skills, so the / menu has something to show. */
const COMMANDS: readonly SkillEntry[] = [
  { name: "echo", description: "Say exactly the rest of the line" },
  { name: "write", description: "Write the lines that follow to a file, as a Write tool call" },
  { name: "sleep", description: "Work for that many milliseconds (stoppable), then say so" },
  { name: "stream", description: "Say that many chunks, 40 ms apart" },
  { name: "fail", description: "End the turn failed, with the rest of the line as the reason" },
  { name: "background", description: "Run a command in the background for that many milliseconds" },
  { name: "run", description: "Run a command as a tool call that takes that many milliseconds" },
];

export function scriptedDemoRuntime(): Runtime {
  let signedIn = false;
  const runtime = scriptedRuntime({
    id: "scripted",
    brand: { name: "Scripted demo", icon: null },
    model: "script-1",
    turn: async (turn) => {
      const [first = "", ...rest] = requestOf(turn.input).split("\n");
      const [command = "", ...args] = first.trim().split(/\s+/);
      const arg = args.join(" ");
      switch (command) {
        case "/echo":
          turn.say([arg, ...rest].join("\n"));
          return;
        case "/write": {
          const content = rest.join("\n");
          await turn.tool("Write", JSON.stringify({ file_path: arg, content }), async () => {
            const target = path.resolve(turn.options.cwd, arg);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, content.endsWith("\n") || content === "" ? content : `${content}\n`);
            return `wrote ${content.length} characters to ${arg}`;
          });
          turn.say(`Wrote \`${arg}\`.`);
          return;
        }
        case "/sleep": {
          const ms = Number(arg) || 1000;
          turn.think(`Sleeping ${ms} ms.`);
          await sleep(ms, undefined, { signal: turn.signal });
          turn.say(`Slept ${ms} ms.`);
          return;
        }
        case "/stream": {
          const n = Number(arg) || 20;
          for (let i = 1; i <= n; i++) {
            turn.say(`chunk ${i} `);
            await sleep(40, undefined, { signal: turn.signal });
          }
          return;
        }
        case "/fail":
          throw new Error(arg || "scripted failure");
        case "/run": {
          const ms = Number(args[0]) || 1000;
          const line = args.slice(1).join(" ") || "true";
          await turn.tool("Bash", JSON.stringify({ command: line }), async () => {
            await sleep(ms, undefined, { signal: turn.signal });
            return `ran ${line}`;
          });
          turn.say(`Ran \`${line}\`.`);
          return;
        }
        case "/background": {
          const ms = Number(args[0]) || 1000;
          const description = args.slice(1).join(" ") || "background work";
          const task = turn.task({ taskType: "shell", description, background: true });
          turn.say(`Started \`${description}\` in the background.`);
          setTimeout(() => task.end("completed", { summary: `${description}: done` }), ms).unref();
          return;
        }
        default:
          await demo(turn);
      }
    },
  });
  return {
    ...runtime,
    skills: async (_installation, options) => ({
      kind: "ok",
      scope: { kind: "workspace", cwd: options?.cwd ?? process.cwd() },
      observedAt: new Date().toISOString(),
      view: "discovered",
      items: COMMANDS.map((command) => ({ ...command, source: "scripted" })),
      partial: false,
    }),
    authStatus: async () =>
      signedIn
        ? { kind: "logged_in", account: ACCOUNT, source: "script" }
        : { kind: "logged_out", source: "script" },
    login: async (_installation, interaction) => {
      interaction.onEvent({
        kind: "auth_url",
        url: "https://example.com/scripted-sign-in",
        instructions: "Sign in there, then paste the code it shows.",
      });
      let code: string;
      try {
        code = await interaction.prompt({
          kind: "manual_code",
          message: "Code from the sign-in page",
        });
      } catch (error) {
        if (interaction.signal?.aborted === true) return { kind: "cancelled" };
        return { kind: "failed", reason: "interaction_failed", detail: String(error) };
      }
      if (code.trim() !== "rowrow")
        return { kind: "failed", reason: "rejected", detail: "That code didn't work." };
      signedIn = true;
      return { kind: "logged_in", account: ACCOUNT };
    },
  };
}

const ACCOUNT = { email: "demo@example.com", plan: "demo", method: "script" };

/** The person's own text: with attachments the runtime reads a list of files first (agents/input.ts). */
function requestOf(input: string): string {
  if (!input.startsWith("# Files mentioned by the user:")) return input;
  const marker = "## My request:\n\n";
  const at = input.indexOf(marker);
  return at === -1 ? "" : input.slice(at + marker.length);
}

async function demo(turn: ScriptedTurn): Promise<void> {
  turn.think("Reading the request and looking around the workspace.");
  await sleep(150, undefined, { signal: turn.signal });
  await turn.tool("Bash", JSON.stringify({ command: "ls" }), async () => {
    const names = await fs.readdir(turn.options.cwd).catch(() => []);
    return names.slice(0, 20).join("\n");
  });
  const files = [...turn.input.matchAll(/^## (.+): (\/.+)$/gm)].map((match) => match[1]);
  const answer = [
    `You said: **${requestOf(turn.input).slice(0, 200)}**`,
    ...(files.length === 0 ? [] : ["", `Files: ${files.join(", ")}`]),
    ...(turn.images.length === 0
      ? []
      : ["", `Images (as image input): ${turn.images.map((image) => path.basename(image.path)).join(", ")}`]),
    "",
    "This is the scripted demo runtime: it runs no model and costs no tokens. Try:",
    "",
    "- `/write notes.md` followed by some lines, to see the change in the diff view",
    "- `/sleep 5000`, then stop it or steer it",
    "- `/fail oops`, to see a failed turn",
  ];
  if (turn.steered.length > 0) answer.push("", `Steered while working: ${turn.steered.join(" / ")}`);
  for (const line of answer) {
    turn.say(`${line}\n`);
    await sleep(30, undefined, { signal: turn.signal });
  }
}
