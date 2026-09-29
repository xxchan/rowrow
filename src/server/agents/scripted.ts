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
// Anything else gets a short demo answer with a thought, a tool call and some Markdown.
import type { Runtime } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export function scriptedDemoRuntime(): Runtime {
  return scriptedRuntime({
    id: "scripted",
    brand: { name: "Scripted demo", icon: null },
    model: "script-1",
    turn: async (turn) => {
      const [first = "", ...rest] = turn.input.split("\n");
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
          // Not a tool call: oar 0.8.0's scriptedRuntime still emits a tool's end after the
          // turn was aborted, which reads as a new turn (docs/upstream.md).
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
        default:
          await demo(turn);
      }
    },
  });
}

async function demo(turn: ScriptedTurn): Promise<void> {
  turn.think("Reading the request and looking around the workspace.");
  await sleep(150, undefined, { signal: turn.signal });
  await turn.tool("Bash", JSON.stringify({ command: "ls" }), async () => {
    const names = await fs.readdir(turn.options.cwd).catch(() => []);
    return names.slice(0, 20).join("\n");
  });
  const answer = [
    `You said: **${turn.input.slice(0, 200)}**`,
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
