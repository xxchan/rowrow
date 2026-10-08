#!/usr/bin/env node
// The rowrow CLI. `serve` runs the server; every other command is a client of the same API
// the web app uses (PRINCIPLES.md, engineering 3), so anything you can see or do in the UI
// you can script, and agents can use it to observe and drive rowrow.
import { ORPCError } from "@orpc/client";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { contract } from "../shared/contract.ts";
import type { Attachment, Entry } from "../shared/entries.ts";
import { newInputId } from "../shared/ids.ts";
import { renderText } from "../shared/render-text.ts";
import type { AgentState, AppState, LogEntry, UpgradeResult } from "../shared/schemas.ts";
import { ATTENTION_RANK, type Attention } from "../shared/summary.ts";
import { reduceTimeline, initialTimeline } from "../shared/timeline.ts";
import { DEFAULT_PORT, isLoopback, rowrowHome } from "../server/config.ts";
import { connect, resolveTarget, type Client } from "./client.ts";
import { formatLogin, formatLogout, login } from "./login.ts";
import { formatUsage } from "./usage.ts";

const HELP = `rowrow: run a crew of coding agents and steer them from any browser.

Server
  rowrow serve [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--profile default] [--public-url URL]
               [--tls-cert FILE --tls-key FILE] [--test-runtime] [--idle-timeout 30m] [--open]
  rowrow open                      sign this machine's browser in and open rowrow
  rowrow pair [name]               a one-time sign-in link for another device (show it as a QR code)
  rowrow status                    server, live runs, connected clients, recent problems
  rowrow version                   this rowrow's version, and how it was installed

Push notifications
  rowrow push                      which devices get notifications; whether the iOS app can
  rowrow push apns <AuthKey_ID.p8> --key-id ID --team-id ID
                                   let the server push to the iOS app you built (your APNs key)
  rowrow push apns --off           forget the APNs key

Runtimes
  rowrow runtimes [--check]        what's installed and signed in; --check: whether a newer
                                   version is out
  rowrow runtimes upgrade <runtime>   run that runtime's own updater (agents running now keep
                                   the old version until their next run)
  rowrow runtimes login <runtime>  sign it in with its own login, without its CLI: prints what
                                   to open, reads the code it asks for (Ctrl-C cancels)
  rowrow runtimes logout <runtime> sign it out with its own logout (its CLI on that machine too;
                                   an API key in its environment stays)
  rowrow runtimes usage [--refresh]   how much of each subscription window is left, and
                                   whether you're using it faster than an even burn

Service (keeps the server running: starts at login, restarts after a crash)
  rowrow service install [serve flags…] [--if-idle]   launchd on macOS, systemd --user on Linux;
                                   --if-idle: not while an agent is mid-turn (exit code 75)
  rowrow service status|start|stop|restart|uninstall

Agents
  rowrow agents [--all]            list agents, the ones that need you first
  rowrow agent new <workspace> [--runtime claude] [--model M] [--title T] [prompt…] [--attach FILE]… [--wait]
  rowrow agent send <agent> <text…> [--attach FILE]… [--steer | --interrupt] [--wait]
                                   while it works: queued for after the turn; --steer: into it now
  rowrow agent wait <agent> [--until done,blocked,idle] [--timeout 10m]
  rowrow agent view <agent> [--turns N] [--follow]      the transcript, as the UI shows it
  rowrow agent entries <agent> [--after N] [--full] [--follow]   the raw log (JSON lines)
  rowrow agent abort|stop|archive|seen <agent>
  (an <agent> is its id, a unique id prefix, or a unique part of its title)

Workspaces
  rowrow ws                        list workspaces
  rowrow ws add <path> [--label L]
  rowrow ws browse [path]
  rowrow ws log <workspace> [--limit 20]                 the branch's commits, newest first
  rowrow ws show <workspace> <commit> [--path FILE]      a commit and its files, or one file's diff
  rowrow ws search <workspace> <text…> [--names | --content]
  rowrow ws read <workspace> <path>                      a file of the checkout
  rowrow ws pr <workspace> [--refresh]                   the branch's GitHub pull request (via gh)
  (a <workspace> is its id, its label, or its path; file actions: rowrow call git.fileAction)

Debugging
  rowrow logs [--since 30m] [--level warn] [--evt agent.] [--trace ID] [--agent ID] [--text S] [-f] [--json]
  rowrow errors [--since 2h]       warnings and errors (browser ones too)
  rowrow state [path.to.value]     the AppState every client renders
  rowrow call <group.name> [json]  call any procedure (rowrow procedures lists them)
  rowrow procedures                every procedure with its summary

Global flags: --profile NAME, --url URL --token T (another server), --json
Environment: ROWROW_HOME (default ~/.rowrow). Agents run by rowrow get ROWROW_URL and ROWROW_TOKEN.`;

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

function duration(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const match = DURATION.exec(value.trim());
  if (match === null) throw new Error(`bad duration "${value}" (use 500ms, 30s, 10m, 2h, 1d)`);
  const n = Number(match[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "ms" | "s" | "m" | "h" | "d"
  ];
  return n * unit;
}

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      profile: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      host: { type: "string" },
      "public-url": { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      "test-runtime": { type: "boolean" },
      "if-idle": { type: "boolean" },
      version: { type: "boolean", short: "v" },
      "idle-timeout": { type: "string" },
      open: { type: "boolean" },
      runtime: { type: "string" },
      model: { type: "string" },
      title: { type: "string" },
      label: { type: "string" },
      wait: { type: "boolean" },
      queue: { type: "boolean" },
      steer: { type: "boolean" },
      interrupt: { type: "boolean" },
      until: { type: "string" },
      timeout: { type: "string" },
      turns: { type: "string" },
      follow: { type: "boolean", short: "f" },
      after: { type: "string" },
      full: { type: "boolean" },
      all: { type: "boolean" },
      since: { type: "string" },
      level: { type: "string" },
      evt: { type: "string" },
      trace: { type: "string" },
      agent: { type: "string" },
      text: { type: "string" },
      limit: { type: "string" },
      path: { type: "string" },
      names: { type: "boolean" },
      content: { type: "boolean" },
      refresh: { type: "boolean" },
      check: { type: "boolean" },
      attach: { type: "string", multiple: true },
      "key-id": { type: "string" },
      "team-id": { type: "string" },
      off: { type: "boolean" },
    },
  });
  const str = (name: string): string | undefined => {
    const value = flags[name];
    return typeof value === "string" ? value : undefined;
  };
  const bool = (name: string): boolean => flags[name] === true;
  const strings = (name: string): string[] => {
    const value = flags[name];
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  };
  const json = bool("json");
  const [command = "help", ...rest] = positionals;

  if (bool("help") || command === "help") {
    console.log(HELP);
    return;
  }

  if (bool("version") || command === "version") {
    const { installKind, packageVersion } = await import("../server/install.ts");
    const root = path.resolve(import.meta.dirname, "../..");
    const info = {
      version: packageVersion(root),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      install: { kind: installKind(root, rowrowHome()), root },
    };
    console.log(
      json
        ? JSON.stringify(info, null, 2)
        : `rowrow ${info.version ?? "?"} (${info.install.kind}, node ${info.node}, ${info.platform})`,
    );
    return;
  }

  if (command === "serve") {
    await serve({
      profile: str("profile") ?? process.env["ROWROW_PROFILE"] ?? "default",
      host: str("host") ?? "127.0.0.1",
      port: Number(str("port") ?? (str("profile") === undefined ? DEFAULT_PORT : 0)),
      publicUrl: str("public-url"),
      tlsCert: str("tls-cert"),
      tlsKey: str("tls-key"),
      testRuntime: bool("test-runtime") || process.env["ROWROW_TEST_RUNTIME"] === "1",
      idleTimeoutMs: duration(str("idle-timeout"), 30 * 60_000),
      open: bool("open"),
    });
    return;
  }

  if (command === "service") {
    const profile = str("profile") ?? process.env["ROWROW_PROFILE"] ?? "default";
    const service = await import("./service.ts");
    const [action = "status"] = rest;
    if (action === "install") {
      if (profile !== "default" && str("port") === undefined)
        throw new Error(`a service for profile "${profile}" needs a fixed --port`);
      if ((str("tls-cert") === undefined) !== (str("tls-key") === undefined))
        throw new Error("--tls-cert and --tls-key go together");
      duration(str("idle-timeout"), 0);
      const pass = (flag: string, value: string | undefined): string[] =>
        value === undefined ? [] : [`--${flag}`, value];
      const file = (value: string | undefined): string | undefined =>
        value === undefined ? undefined : path.resolve(value);
      const outcome = await service.installService(
        profile,
        [
          ...(profile === "default" ? [] : ["--profile", profile]),
          ...pass("host", str("host")),
          ...pass("port", str("port")),
          ...pass("public-url", str("public-url")),
          ...pass("tls-cert", file(str("tls-cert"))),
          ...pass("tls-key", file(str("tls-key"))),
          ...pass("idle-timeout", str("idle-timeout")),
          ...(bool("test-runtime") ? ["--test-runtime"] : []),
        ],
        { ifIdle: bool("if-idle"), json },
      );
      if (json) console.log(JSON.stringify(outcome, null, 2));
      if (outcome.outcome === "busy") process.exitCode = service.BUSY_EXIT;
    } else if (action === "uninstall") service.uninstallService(profile);
    else if (action === "start") await service.startService(profile);
    else if (action === "stop") await service.stopService(profile);
    else if (action === "restart") await service.restartService(profile);
    else if (action === "status") service.serviceStatus(profile, json);
    else
      throw new Error(
        `unknown service command "${action}" (install, status, start, stop, restart, uninstall)`,
      );
    return;
  }

  if (command === "procedures") {
    for (const [group, procedures] of Object.entries(contract)) {
      for (const [name, procedure] of Object.entries(
        procedures as Record<string, { "~orpc": { route: { summary?: string } } }>,
      )) {
        console.log(`${group}.${name}\n    ${procedure["~orpc"].route.summary ?? ""}`);
      }
    }
    return;
  }

  const target = resolveTarget({ url: str("url"), token: str("token"), profile: str("profile") });
  const { client, trace } = connect(target);
  const out = (value: unknown, human: () => string): void => {
    console.log(json ? JSON.stringify(value, null, 2) : human());
  };

  try {
    switch (command) {
      case "open": {
        const link = await client.devices.pair({ name: undefined });
        openBrowser(link.url);
        console.log(`Opening ${link.url.replace(/code=.*/, "code=…")} (the link works once, for 10 minutes)`);
        return;
      }
      case "pair": {
        const link = await client.devices.pair(rest[0] === undefined ? {} : { name: rest.join(" ") });
        out(
          link,
          () =>
            `${link.url}\n\nOpen it on the device you want to sign in (it works once, until ${new Date(link.expiresAt).toLocaleTimeString()}).`,
        );
        return;
      }
      case "push": {
        const [sub] = rest;
        if (sub === "apns") {
          if (bool("off")) {
            await client.notify.removeApns();
            console.log("The APNs key is gone: the server no longer pushes to the iOS app.");
            return;
          }
          const file = rest[1];
          const keyId = str("key-id");
          const teamId = str("team-id");
          if (file === undefined || keyId === undefined || teamId === undefined)
            throw new Error(
              "usage: rowrow push apns <AuthKey_ID.p8> --key-id ID --team-id ID (from developer.apple.com → Keys)",
            );
          const saved = await client.notify.configureApns({
            key: fs.readFileSync(file, "utf8"),
            keyId,
            teamId,
          });
          out(
            saved,
            () =>
              `APNs key ${saved.keyId} (team ${saved.teamId}) saved: the iOS app gets notifications once you allow them in it.\nThey go through Apple's push service, which sees only that an agent finished or needs you; what they say is encrypted for each phone.`,
          );
          return;
        }
        if (sub !== undefined) throw new Error(`unknown push command "${sub}" (apns)`);
        const [{ state }, devices] = await Promise.all([client.state.get(), client.devices.list()]);
        out({ apns: state.host.apns, webPush: state.host.pushKey !== null, devices }, () =>
          [
            state.host.apns
              ? "iOS app: the server has an APNs key."
              : "iOS app: no APNs key yet (rowrow push apns <AuthKey_ID.p8> --key-id ID --team-id ID).",
            ...devices.map((d) => `  ${d.push ? "●" : "○"} ${d.name} (${d.kind})`),
          ].join("\n"),
        );
        return;
      }
      case "status": {
        const status = await client.app.status();
        out(status, () => formatStatus(status));
        return;
      }
      case "state": {
        const { state, version } = await client.state.get();
        const value = rest[0] === undefined ? state : pick(state, rest[0]);
        console.log(JSON.stringify(rest[0] === undefined ? { version, state } : value, null, 2));
        return;
      }
      case "agents": {
        const { state } = await client.state.get();
        const agents = Object.values(state.agents)
          .filter((a) => bool("all") || !a.summary.archived)
          .sort(byAttention);
        out(agents, () =>
          agents.length === 0
            ? "No agents yet. Create one: rowrow agent new <workspace> [prompt…]"
            : agents.map((a) => formatAgent(a, state)).join("\n"),
        );
        return;
      }
      case "runtimes": {
        if (rest[0] === "upgrade") {
          if (rest[1] === undefined) throw new Error("usage: rowrow runtimes upgrade <runtime>");
          const result = await client.runtimes.upgrade({ runtime: rest[1] });
          out(result, () => formatUpgrade(result));
          return;
        }
        if (rest[0] === "login") {
          if (rest[1] === undefined) throw new Error("usage: rowrow runtimes login <runtime>");
          const result = await login(client, rest[1]);
          out(result, () => formatLogin(result));
          return;
        }
        if (rest[0] === "logout") {
          if (rest[1] === undefined) throw new Error("usage: rowrow runtimes logout <runtime>");
          const result = await client.runtimes.logout({ runtime: rest[1] });
          out(result, () => formatLogout(result));
          return;
        }
        if (rest[0] === "usage") {
          const usage = await client.runtimes.usage({ refresh: bool("refresh") });
          out(usage, () => formatUsage(usage));
          return;
        }
        if (rest[0] !== undefined)
          throw new Error(`unknown runtimes command "${rest[0]}" (upgrade, login, logout, usage)`);
        const list = await client.runtimes.list({ refresh: true });
        const updates = bool("check") ? await client.runtimes.updates({ refresh: true }) : [];
        out({ runtimes: list, updates }, () =>
          list
            .map((runtime) => {
              const check = updates.find((update) => update.runtime === runtime.id)?.check;
              const version = runtime.installed
                ? (runtime.version ?? "installed")
                : (runtime.reason ?? "not installed");
              const news =
                check === undefined
                  ? ""
                  : check.kind === "ok"
                    ? check.updateAvailable
                      ? `  → ${check.latest} is out (rowrow runtimes upgrade ${runtime.id})`
                      : "  (latest)"
                    : check.reason === "not_installed"
                      ? ""
                      : check.reason === "no_updater"
                        ? `  (${check.detail ?? "updates with rowrow"})`
                        : `  (can't check: ${check.detail ?? check.reason})`;
              const auth =
                runtime.auth?.kind === "logged_in"
                  ? `  · signed in${runtime.auth.account?.email === undefined ? "" : ` as ${runtime.auth.account.email}`}${runtime.auth.account?.expiresAt === undefined ? "" : ` (key expires ${runtime.auth.account.expiresAt.slice(0, 10)})`}`
                  : runtime.auth?.kind === "logged_out"
                    ? `  · not signed in${runtime.canLogin ? ` (rowrow runtimes login ${runtime.id})` : ""}`
                    : "";
              const shadowed =
                runtime.shadowed.length === 0
                  ? ""
                  : `\n  runs ${runtime.command ?? runtime.id}; also on PATH, never run: ${runtime.shadowed.join(", ")}`;
              return `${runtime.installed ? "●" : "○"} ${runtime.id.padEnd(12)} ${version}${auth}${news}${shadowed}`;
            })
            .join("\n"),
        );
        return;
      }
      case "agent":
        await agentCommand(client, rest, { str, bool, strings, json, out, trace });
        return;
      case "ws":
      case "workspaces": {
        const [sub, ...args] = rest;
        if (sub === "add") {
          const ws = await client.workspaces.add({
            path: args[0] ?? ".",
            ...(str("label") === undefined ? {} : { label: str("label") }),
          });
          out(ws, () => `${ws.id}  ${ws.label}  ${ws.path}`);
        } else if (sub === "browse") {
          const listing = await client.workspaces.browse(args[0] === undefined ? {} : { path: args[0] });
          out(listing, () =>
            [listing.path, ...listing.entries.map((e) => `  ${e.repo ? "●" : " "} ${e.name}`)].join("\n"),
          );
        } else if (sub === "log" || sub === "show" || sub === "search" || sub === "read" || sub === "pr") {
          await inspectCommand(client, sub, args, { str, bool, strings, json, out, trace });
        } else {
          const { state } = await client.state.get();
          const list = Object.values(state.workspaces);
          out(list, () =>
            list.length === 0
              ? "No workspaces yet. Add one: rowrow ws add <path>"
              : list
                  .map(
                    (w) =>
                      `${w.id}  ${w.label.padEnd(24)} ${w.git?.branch ?? "-"}${w.git !== null && w.git.changed > 0 ? ` (${w.git.changed} changed)` : ""}  ${w.path}${w.missing ? "  [missing]" : ""}`,
                  )
                  .join("\n"),
          );
        }
        return;
      }
      case "logs":
      case "errors": {
        const filter = {
          since: Date.now() - duration(str("since"), command === "errors" ? 2 * 3_600_000 : 30 * 60_000),
          ...(command === "errors"
            ? { level: "warn" as const }
            : str("level") === undefined
              ? {}
              : { level: str("level") as "debug" | "info" | "warn" | "error" }),
          ...(str("evt") === undefined ? {} : { evt: str("evt") }),
          ...(str("trace") === undefined ? {} : { trace: str("trace") }),
          ...(str("agent") === undefined ? {} : { agent: str("agent") }),
          ...(str("text") === undefined ? {} : { text: str("text") }),
          limit: Number(str("limit") ?? 500),
        };
        const print = (entry: LogEntry): void => console.log(json ? JSON.stringify(entry) : formatLog(entry));
        for (const entry of await client.logs.query(filter)) print(entry);
        if (bool("follow"))
          for await (const entry of await client.logs.watch({ ...filter, since: Date.now() })) print(entry);
        return;
      }
      case "call": {
        const [name = "", input] = rest;
        const [group = "", proc = ""] = name.split(".");
        const fn = (
          client as unknown as Record<
            string,
            Record<string, ((input: unknown) => Promise<unknown>) | undefined> | undefined
          >
        )[group]?.[proc];
        if (fn === undefined) throw new Error(`no procedure "${name}" (rowrow procedures lists them)`);
        const result = await fn(input === undefined ? undefined : JSON.parse(input));
        if (result !== null && typeof result === "object" && Symbol.asyncIterator in result) {
          for await (const item of result as AsyncIterable<unknown>) console.log(JSON.stringify(item));
        } else console.log(JSON.stringify(result, null, 2));
        return;
      }
      default:
        throw new Error(`unknown command "${command}"; rowrow help lists them`);
    }
  } catch (error) {
    if (error instanceof ORPCError) {
      throw new Error(`${error.message} [${error.code}, trace ${trace}]`, { cause: error });
    }
    throw error;
  }
}

interface Helpers {
  str(name: string): string | undefined;
  bool(name: string): boolean;
  strings(name: string): string[];
  json: boolean;
  out(value: unknown, human: () => string): void;
  trace: string;
}

/** Upload local files (--attach) for a message; the server keeps them 7 days. */
async function upload(client: Client, files: readonly string[]): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const file of files) {
    const bytes = await fs.promises.readFile(file);
    attachments.push(await client.files.upload({ file: new File([bytes], path.basename(file)) }));
  }
  return attachments;
}

async function agentCommand(client: Client, args: string[], h: Helpers): Promise<void> {
  const [sub = "", ref = "", ...rest] = args;
  if (sub === "new") {
    const { state } = await client.state.get();
    // A workspace by id or label, or any directory path (registered on the fly).
    const ws = findWorkspace(state, ref) ?? (await client.workspaces.add({ path: path.resolve(ref) }));
    const text = rest.join(" ");
    const attachments = await upload(client, h.strings("attach"));
    const { agent, sent } = await client.agents.create({
      workspaceId: ws.id,
      runtime: h.str("runtime") ?? "claude",
      ...(h.str("model") === undefined ? {} : { model: h.str("model") }),
      ...(h.str("title") === undefined ? {} : { title: h.str("title") }),
      ...(text === "" && attachments.length === 0
        ? {}
        : { input: { inputId: newInputId(), text, ...(attachments.length === 0 ? {} : { attachments }) } }),
    });
    if (h.bool("wait") && sent !== null) {
      const waited = await client.agents.wait({
        agentId: agent.id,
        afterSeq: sent.seq,
        timeoutMs: duration(h.str("timeout"), 3_600_000),
      });
      h.out(
        waited,
        () =>
          `${agent.id}  ${waited.agent.attention}${waited.timedOut ? " (timed out)" : ""}\n${waited.agent.summary.preview ?? ""}`,
      );
      return;
    }
    h.out({ agent, sent }, () => `${agent.id}${sent === null ? "" : `  input ${sent.landed}`}`);
    return;
  }
  const { state } = await client.state.get();
  const agent = resolveAgent(state, ref);
  const agentId = agent.id;
  switch (sub) {
    case "send": {
      const mode = h.bool("steer")
        ? "steer"
        : h.bool("queue")
          ? "queue"
          : h.bool("interrupt")
            ? "interrupt"
            : "auto";
      const attachments = await upload(client, h.strings("attach"));
      const result = await client.agents.send({
        agentId,
        inputId: newInputId(),
        text: rest.join(" "),
        ...(attachments.length === 0 ? {} : { attachments }),
        mode,
      });
      if (
        h.bool("wait") &&
        (result.landed === "prompted" || result.landed === "steered" || result.landed === "queued")
      ) {
        const waited = await client.agents.wait({
          agentId,
          afterSeq: result.seq,
          timeoutMs: duration(h.str("timeout"), 3_600_000),
        });
        h.out(
          waited,
          () =>
            `${waited.agent.attention}${waited.timedOut ? " (timed out)" : ""}\n${waited.agent.summary.preview ?? ""}`,
        );
        return;
      }
      h.out(result, () => `${result.landed}${result.reason === undefined ? "" : `: ${result.reason}`}`);
      return;
    }
    case "wait": {
      const until = (h.str("until") ?? "blocked,done,idle").split(",").map((s) => s.trim()) as Attention[];
      const waited = await client.agents.wait({
        agentId,
        until,
        timeoutMs: duration(h.str("timeout"), 600_000),
      });
      h.out(waited, () => `${waited.agent.attention}${waited.timedOut ? " (timed out)" : ""}`);
      if (waited.timedOut) process.exitCode = 2;
      return;
    }
    case "view": {
      const turns = h.str("turns") === undefined ? undefined : Number(h.str("turns"));
      const view = await client.agents.view({ agentId, ...(turns === undefined ? {} : { turns }) });
      process.stdout.write(view.text);
      if (h.bool("follow")) {
        // Re-render the latest turns as entries arrive: simple, and exactly the UI's fold.
        const page = await client.agents.entries({ agentId, turns: turns ?? 3 });
        let timeline = page.entries.reduce(reduceTimeline, initialTimeline());
        for await (const batch of await client.agents.watch({ agentId, after: page.headSeq })) {
          timeline = batch.entries.reduce(reduceTimeline, timeline);
          process.stdout.write(`\x1b[2J\x1b[H${renderText(timeline)}`);
        }
      }
      return;
    }
    case "entries": {
      const print = (entry: Entry): void => console.log(JSON.stringify(entry));
      const after = h.str("after") === undefined ? -1 : Number(h.str("after"));
      const page = await client.agents.entries({ agentId, after, ...(h.bool("full") ? { full: true } : {}) });
      for (const entry of page.entries) print(entry);
      if (h.bool("follow"))
        for await (const batch of await client.agents.watch({ agentId, after: page.headSeq }))
          batch.entries.forEach(print);
      return;
    }
    case "abort": {
      const result = await client.agents.abort({ agentId });
      h.out(result, () => (result.accepted ? "abort delivered" : `not aborted: ${result.reason ?? ""}`));
      return;
    }
    case "stop":
      await client.agents.stop({ agentId });
      h.out({ ok: true }, () => "stopped");
      return;
    case "archive":
      await client.agents.update({ agentId, archived: true });
      h.out({ ok: true }, () => "archived");
      return;
    case "seen":
      await client.agents.markSeen({ agentId, seq: agent.summary.headSeq });
      h.out({ ok: true }, () => "marked seen");
      return;
    default:
      throw new Error(`unknown agent command "${sub}"; rowrow help lists them`);
  }
}

/** The workspace inspector, read-only: history, search, files, the pull request. */
async function inspectCommand(client: Client, sub: string, args: string[], h: Helpers): Promise<void> {
  const [ref = "", ...rest] = args;
  const { state } = await client.state.get();
  const found = findWorkspace(state, ref);
  if (found === null) throw new Error(`no workspace matches "${ref}" (rowrow ws lists them)`);
  const workspaceId = found.id;
  const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
  switch (sub) {
    case "log": {
      const page = await client.git.log({ workspaceId, limit: Number(h.str("limit") ?? 20) });
      h.out(page, () =>
        [
          ...page.commits.map(
            (c) =>
              `${c.sha.slice(0, 9)}  ${day(c.authorDate)}  ${c.authorName.slice(0, 18).padEnd(18)}  ${c.parents.length > 1 ? "(merge) " : ""}${c.subject}`,
          ),
          ...(page.nextCursor === null ? [] : ["…"]),
          ...(page.note === null ? [] : [page.note]),
        ].join("\n"),
      );
      return;
    }
    case "show": {
      const sha = rest[0] ?? "";
      const file = h.str("path");
      if (file !== undefined) {
        const diff = await client.git.commitDiff({ workspaceId, sha, path: file });
        if (h.json) console.log(JSON.stringify(diff, null, 2));
        else process.stdout.write(`${diff.patch}${diff.truncated ? "\n(cut at 512 KB)\n" : ""}`);
        return;
      }
      const shown = await client.git.commit({ workspaceId, sha });
      const { commit } = shown;
      h.out(shown, () =>
        [
          `commit ${commit.sha}`,
          ...(commit.parents.length > 1
            ? [`Merge: ${commit.parents.map((p) => p.slice(0, 9)).join(" ")}`]
            : []),
          `Author: ${commit.authorName} <${commit.authorEmail}>  ${new Date(commit.authorDate).toISOString()}`,
          `Commit: ${commit.committerName} <${commit.committerEmail}>  ${new Date(commit.committerDate).toISOString()}`,
          "",
          ...commit.message.split("\n").map((line) => `    ${line}`),
          "",
          `${shown.baseLabel}:`,
          ...shown.files.map(
            (f) =>
              `  ${f.status.padEnd(10)} ${f.oldPath === null ? f.path : `${f.oldPath} → ${f.path}`}  ${f.additions === null ? "binary" : `+${f.additions} −${f.deletions ?? 0}`}`,
          ),
          ...(shown.note === null ? [] : [shown.note]),
        ].join("\n"),
      );
      return;
    }
    case "search": {
      const kind = h.bool("names") ? "names" : h.bool("content") ? "content" : "all";
      const result = await client.files.search({ workspaceId, query: rest.join(" "), kind });
      h.out(result, () =>
        [
          ...result.names.map((n) => n.path),
          ...(result.namesTruncated ? ["(more file names: only the first 200 are shown)"] : []),
          ...result.lines.map((l) => `${l.path}:${l.line}: ${l.text}`),
          ...(result.linesTruncated ? ["(more matching lines: only the first 200 are shown)"] : []),
          ...(result.note === null ? [] : [result.note]),
        ].join("\n"),
      );
      return;
    }
    case "read": {
      const file = await client.files.read({ workspaceId, path: rest[0] ?? "" });
      if (h.json) console.log(JSON.stringify(file, null, 2));
      else process.stdout.write(`${file.text}${file.truncated ? "\n(cut at 1 MiB)\n" : ""}`);
      return;
    }
    default: {
      const status = await client.git.pullRequest({ workspaceId, refresh: h.bool("refresh") });
      const { pr } = status;
      h.out(status, () =>
        pr === null
          ? `${status.state}: ${status.message ?? ""}`
          : [
              `#${pr.number} ${pr.title} (${pr.state})`,
              `${pr.head} → ${pr.base}${pr.author === null ? "" : ` by ${pr.author}`}`,
              `checks: ${pr.checks.state} (${pr.checks.passed} passed, ${pr.checks.failed} failed, ${pr.checks.pending} pending, ${pr.checks.skipped} skipped, ${pr.checks.cancelled} cancelled)`,
              `review: ${pr.review.replace("_", " ")}`,
              pr.url,
              `checked ${new Date(status.checkedAt).toLocaleTimeString()}`,
            ].join("\n"),
      );
    }
  }
}

function resolveAgent(state: AppState, ref: string): AgentState {
  if (ref === "") throw new Error("which agent? (an id, id prefix, or part of its title)");
  const agents = Object.values(state.agents);
  const exact = state.agents[ref];
  if (exact !== undefined) return exact;
  const byId = agents.filter((a) => a.id.startsWith(ref) || a.id.startsWith(`ag_${ref}`));
  if (byId.length === 1 && byId[0] !== undefined) return byId[0];
  const byTitle = agents.filter((a) => (a.summary.title ?? "").toLowerCase().includes(ref.toLowerCase()));
  if (byTitle.length === 1 && byTitle[0] !== undefined) return byTitle[0];
  const candidates = [...byId, ...byTitle];
  throw new Error(
    candidates.length === 0
      ? `no agent matches "${ref}"`
      : `"${ref}" matches ${candidates.length} agents: ${candidates.map((a) => a.id).join(", ")}`,
  );
}

function findWorkspace(state: AppState, ref: string): { id: string } | null {
  if (ref === "") throw new Error("which workspace? (an id, a label, or a path)");
  const exact = state.workspaces[ref];
  if (exact !== undefined) return exact;
  const full = path.resolve(ref);
  const matches = Object.values(state.workspaces).filter(
    (w) => w.path === full || w.label === ref || w.id.startsWith(ref),
  );
  if (matches.length > 1)
    throw new Error(`"${ref}" matches several workspaces: ${matches.map((w) => w.id).join(", ")}`);
  return matches[0] ?? null;
}

function byAttention(a: AgentState, b: AgentState): number {
  return (
    ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
    b.summary.lastActivityAt - a.summary.lastActivityAt
  );
}

const MARK: Record<Attention, string> = { blocked: "✋", done: "✓", working: "◐", idle: "○" };

function formatAgent(a: AgentState, state: AppState): string {
  const s = a.summary;
  const ws = state.workspaces[s.workspaceId]?.label ?? "?";
  const phase =
    s.status.kind === "running"
      ? ` ${typeof s.status.phase === "string" ? s.status.phase : s.status.phase.tool}`
      : "";
  const preview = (s.lastError ?? s.preview ?? "").replaceAll(/\s+/g, " ").slice(0, 80);
  return `${MARK[a.attention]} ${a.id}  ${(s.title ?? "(untitled)").padEnd(30).slice(0, 30)} ${a.attention}${phase}  ${s.runtime}@${ws}\n     ${preview}`;
}

function formatStatus(status: Awaited<ReturnType<Client["app"]["status"]>>): string {
  const { host } = status;
  const lines = [
    `rowrow ${host.version} (${host.profile}) pid ${host.pid}, up ${ago(host.startedAt)}, oar ${host.oar}, node ${host.node}`,
    `url ${host.url}${host.exposed ? " (exposed beyond loopback)" : ""}   data ${host.dataDir}`,
    `${status.counts.workspaces} workspaces, ${status.counts.agents} agents, ${status.counts.entries} log entries`,
    ...(host.update === null
      ? []
      : [
          `update: rowrow ${host.update.version} is out: ${host.update.command}${host.update.after === null ? "" : `  (${host.update.after})`}`,
        ]),
    "",
    `live runs (${status.runs.length}):`,
    ...status.runs.map((r) => `  ${r.agentId} ${r.runId} ${r.runtime} ${r.status} since ${ago(r.since)}`),
    `clients (${status.clients.length}):`,
    ...status.clients.map(
      (c) =>
        `  ${c.device} ${c.route ?? "-"}${c.focused ? " (focused)" : c.visible ? " (visible)" : ""} since ${ago(c.since)}`,
    ),
    `recent problems (${status.problems.length}):`,
    ...status.problems.slice(-15).map((p) => `  ${formatLog(p)}`),
  ];
  return lines.join("\n");
}

function formatLog(entry: LogEntry): string {
  const { time, level, evt, msg, ...rest } = entry;
  const fields = Object.entries(rest)
    .filter(([key]) => key !== "err")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  const err = rest["err"] as { message?: string; stack?: string } | undefined;
  return `${new Date(time).toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${evt}${msg === undefined ? "" : ` ${msg}`} ${fields}${err === undefined ? "" : `\n    ${err.stack ?? err.message ?? ""}`}`;
}

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function pick(value: unknown, dotted: string): unknown {
  let current = value;
  for (const key of dotted.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(command, [url], (error) => {
    if (error !== null)
      console.error(`could not open a browser (${error.message}); open this link yourself: ${url}`);
  });
}

async function serve(options: {
  profile: string;
  host: string;
  port: number;
  publicUrl: string | undefined;
  tlsCert: string | undefined;
  tlsKey: string | undefined;
  testRuntime: boolean;
  idleTimeoutMs: number;
  open: boolean;
}): Promise<void> {
  const { startServer } = await import("../server/main.ts");
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined))
    throw new Error("--tls-cert and --tls-key go together");
  const webDir = path.resolve(import.meta.dirname, "../../dist/web");
  const server = await startServer({
    home: rowrowHome(),
    profile: options.profile,
    host: options.host,
    port: options.port,
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.tlsCert === undefined || options.tlsKey === undefined
      ? {}
      : { tls: { cert: options.tlsCert, key: options.tlsKey } }),
    ...(fs.existsSync(path.join(webDir, "index.html")) ? { webDir } : {}),
    testRuntime: options.testRuntime,
    idleTimeoutMs: options.idleTimeoutMs,
    probeRuntimes: true,
  });
  const link = server.loginLink();
  console.log(`\nrowrow is running at ${server.publicUrl}  (data: ${server.dataDir})`);
  if (!isLoopback(options.host))
    console.log(
      "It listens beyond this machine: every request needs a device credential. Prefer HTTPS (--tls-cert/--tls-key, or tailscale serve).",
    );
  console.log(`Sign this browser in (link works once, 10 minutes):\n  ${link}\n`);
  if (options.open) openBrowser(link);
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: stopping agents and the server…`);
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`rowrow: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

function formatUpgrade(result: UpgradeResult): string {
  switch (result.kind) {
    case "upgraded":
      return `upgraded ${result.from} → ${result.to}`;
    case "current":
      return `already the latest (${result.version})`;
    case "unchanged":
      return `the updater finished, but it's still ${result.version}: it may have installed the new version somewhere else\n${result.output}`;
    case "failed":
      return `the update failed (exit code ${result.exitCode ?? "none: it took too long"})\n${result.output}`;
    case "unsupported":
      return `can't update it here: ${result.detail ?? result.reason}`;
  }
}
