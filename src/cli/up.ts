// `rowrow up` (docs/decisions.md, D-060): one command on a machine to make it one your other
// devices can add. It makes sure rowrow runs here as a service (`rowrow service install`'s, so
// it outlives the terminal), reachable from your private networks only (`--host private`: the
// LAN, Tailscale), then prints where it can be reached, a one-time pairing code to type on the
// other device, and a QR code of a sign-in link for a phone. Again: a fresh code.
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { renderUnicodeCompact } from "uqr";
import type { ServiceStatus } from "../shared/host.ts";
import { listensEverywhere, PRIVATE_HOST, type Address } from "../shared/reach.ts";
import { DEFAULT_PORT, isLoopback } from "../server/config.ts";
import { findAddresses, machineName } from "../server/reach.ts";
import { connect, resolveTarget } from "./client.ts";
import { BUSY_EXIT, getServiceStatus, inNpxCache, installService, startService } from "./service.ts";

/** A service's `serve` flags, from its command, and the ones `up` reads. */
export function serveFlags(command: readonly string[]): {
  readonly args: readonly string[];
  readonly host: string | null;
  readonly publicUrl: string | null;
} {
  const at = command.indexOf("serve");
  const args = at === -1 ? [] : command.slice(at + 1);
  const value = (flag: string): string | null => {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === `--${flag}`) return args[i + 1] ?? null;
      if (arg.startsWith(`--${flag}=`)) return arg.slice(flag.length + 3);
    }
    return null;
  };
  return { args, host: value("host"), publicUrl: value("public-url") };
}

/** The flags without one (and its value). */
function without(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === `--${flag}`) i++;
    else if (!arg.startsWith(`--${flag}=`)) out.push(arg);
  }
  return out;
}

const loopbackUrl = (url: string): boolean => {
  try {
    return isLoopback(new URL(url).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return true;
  }
};

export type UpPlan =
  /** Install the service with these serve flags: there's none, or it listens on loopback only. */
  | { readonly kind: "install"; readonly args: readonly string[]; readonly replacing: boolean }
  /** The service is set up to be reached: start it if it's stopped. */
  | { readonly kind: "service"; readonly running: boolean }
  /** A server in a terminal that other devices reach already: use it as it is. */
  | { readonly kind: "terminal" }
  /** A server in a terminal on loopback only: it has to stop first. */
  | { readonly kind: "stop-first"; readonly pid: number };

/**
 * What `up` does about this machine's rowrow. A service you set up to be reached (any --host
 * beyond loopback, or a --public-url, say behind tailscale serve) is left as it is.
 */
export function planUp(status: ServiceStatus, profile: string, port: string | null): UpPlan {
  if (status.installed) {
    const flags = serveFlags(status.command ?? []);
    const reached = (flags.host !== null && !isLoopback(flags.host)) || flags.publicUrl !== null;
    if (reached) return { kind: "service", running: status.server !== null };
    return {
      kind: "install",
      args: [...without(flags.args, "host"), "--host", PRIVATE_HOST],
      replacing: true,
    };
  }
  if (status.server !== null)
    return loopbackUrl(status.server.publicUrl)
      ? { kind: "stop-first", pid: status.server.pid }
      : { kind: "terminal" };
  return {
    kind: "install",
    args: [
      ...(profile === "default" ? [] : ["--profile", profile]),
      "--host",
      PRIVATE_HOST,
      ...(port === null ? [] : ["--port", port]),
    ],
    replacing: false,
  };
}

/** `npx rowrow up`: a service can't run from npx's cache (npm clears it), so install rowrow for good, then run its `up`. */
function upFromGlobalInstall(argv: readonly string[], version: string): never {
  console.log(
    `rowrow runs from npx's cache, which npm clears now and then; a service needs it installed for good:\n  npm install -g rowrow@${version}\n`,
  );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const installed = spawnSync(npm, ["install", "-g", `rowrow@${version}`], { stdio: "inherit" });
  if (installed.status !== 0)
    throw new Error(
      `npm install -g failed${installed.error === undefined ? "" : ` (${installed.error.message})`}. If it can't write to npm's global directory, see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally, then run: rowrow up`,
    );
  const prefix = execFileSync(npm, ["prefix", "-g"], { encoding: "utf8" }).trim();
  const rowrow = path.join(prefix, "bin", "rowrow");
  const again = spawnSync(rowrow, ["up", ...argv], { stdio: "inherit" });
  process.exit(again.status ?? 1);
}

/** On Linux a user service stops at logout unless lingering is on: turn it on, which your own user may. */
function keepAfterLogout(): string | null {
  if (process.platform !== "linux") return null;
  const user = os.userInfo().username;
  try {
    const shown = execFileSync("loginctl", ["show-user", user, "--property=Linger"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (shown.includes("Linger=yes")) return null;
  } catch {
    // Not logged in through logind (a container): nothing to keep.
    return null;
  }
  try {
    execFileSync("loginctl", ["enable-linger", user], { stdio: ["ignore", "ignore", "pipe"] });
    return "It keeps running after you log out (loginctl enable-linger).";
  } catch {
    return `On Linux a user service stops when you log out. To keep it running: sudo loginctl enable-linger ${user}`;
  }
}

const VIA: Record<Address["via"], string> = {
  tailscale: "Tailscale (encrypted)",
  lan: "this network",
  configured: "its --public-url",
};

/**
 * A QR code in half blocks, two rows a line. They draw its light modules (in the text's color),
 * so a terminal's own colors could invert it: white on black, whatever the theme.
 */
function qr(text: string): string {
  const art = renderUnicodeCompact(text, { border: 2 });
  if (!process.stdout.isTTY) return art;
  return art
    .split("\n")
    .map((line) => `\u001b[97;40m${line}\u001b[0m`)
    .join("\n");
}

export async function up(options: {
  readonly profile: string;
  readonly port: string | undefined;
  readonly json: boolean;
  /** This invocation's arguments but `up`, for running it again from a global install. */
  readonly argv: readonly string[];
  readonly version: string;
}): Promise<void> {
  if (inNpxCache(import.meta.filename)) upFromGlobalInstall(options.argv, options.version);
  const { profile, json } = options;
  if (profile !== "default" && options.port === undefined)
    throw new Error(`rowrow up for profile "${profile}" needs a fixed --port`);
  const say = (text: string): void => {
    if (!json) console.log(text);
  };
  const plan = planUp(getServiceStatus(profile), profile, options.port ?? null);
  const flag = profile === "default" ? "" : ` --profile ${profile}`;
  let how: string;
  switch (plan.kind) {
    case "stop-first":
      throw new Error(
        `rowrow already runs here in a terminal (pid ${plan.pid}), on this machine only. Stop it (Ctrl-C there), then run rowrow up${flag} again: it starts rowrow as a service other devices can reach`,
      );
    case "terminal":
      how = "in a terminal: it stops when that terminal does (stop it and run rowrow up again for a service)";
      break;
    case "service":
      if (!plan.running) await startService(profile);
      how = "as a service";
      break;
    case "install": {
      say(
        plan.replacing
          ? "rowrow's service listens on this machine only: restarting it for your other devices…"
          : "Starting rowrow as a service…",
      );
      const outcome = await installService(profile, plan.args, { ifIdle: plan.replacing, json: true });
      if (outcome.outcome === "busy") {
        say(
          `${outcome.working.length === 1 ? "An agent is" : `${outcome.working.length} agents are`} working (${outcome.working.map((a) => a.title ?? a.id).join(", ")}), and a restart would cut ${outcome.working.length === 1 ? "it" : "them"} off: run rowrow up${flag} again when ${outcome.working.length === 1 ? "it finishes" : "they finish"}.`,
        );
        process.exitCode = BUSY_EXIT;
        return;
      }
      how = "as a service (it starts when you log in and restarts if it crashes)";
      break;
    }
  }
  const linger = plan.kind === "terminal" ? null : keepAfterLogout();

  const target = resolveTarget({ profile });
  const { client } = connect(target);
  const info = await client.app.info();
  const [code, link] = await Promise.all([client.devices.pairingCode({}), client.devices.pair({})]).catch(
    (error: unknown) => {
      if (info.version === options.version) throw error;
      throw new Error(
        `rowrow ${info.version} runs here, and it has no pairing codes: update it (rowrow service install${flag} from this rowrow ${options.version}), then run rowrow up again`,
        { cause: error },
      );
    },
  );
  const local = new URL(target.url);
  const https = local.protocol === "https:";
  const found = listensEverywhere(info.listen)
    ? await findAddresses(Number(local.port || DEFAULT_PORT), https)
    : [];
  // A --public-url (behind tailscale serve, say) comes first: it's what you set up.
  const configured =
    loopbackUrl(info.url) || found.some((a) => a.url === info.url)
      ? []
      : [{ url: info.url, via: "configured" as const, encrypted: info.url.startsWith("https:") }];
  const addresses: Address[] = [...configured, ...found];
  const name = machineName();
  if (json) {
    console.log(
      JSON.stringify(
        {
          name,
          version: info.version,
          addresses,
          code: code.code,
          expiresAt: code.expiresAt,
          link: link.url,
        },
        null,
        2,
      ),
    );
    return;
  }
  const until = new Date(code.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const width = Math.max(...addresses.map((a) => a.url.length), 0);
  const plain = addresses.some((a) => !a.encrypted);
  say(`
rowrow ${info.version} runs on ${name}, ${how}.${linger === null ? "" : `\n${linger}`}
${
  addresses.length === 0
    ? `
Nothing else can reach it yet: ${info.exposed ? "this machine has no LAN or Tailscale address." : "it listens on this machine only (its --host)."}`
    : `
Your other devices reach it at:
${addresses.map((a) => `  ${a.url.padEnd(width)}   ${VIA[a.via]}`).join("\n")}${
        plain
          ? `

Over this network rowrow is plain HTTP: anyone on it can read what you send and see.
Tailscale (tailscale.com) encrypts it, and reaches this machine from anywhere.`
          : ""
      }`
}

Pairing code:  ${code.code}   (once, until ${until})
${
  addresses.length === 0
    ? ""
    : `
  rowrow for Mac   Add a machine, pick ${name}, type the code
  A browser        open an address above, type the code
  A phone          scan this sign-in link (also once, until ${until}):

${qr(link.url)}`
}
rowrow up${flag} again for a new code.`);
}
