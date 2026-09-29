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
import type { Entry } from "../shared/entries.ts";
import { newInputId } from "../shared/ids.ts";
import { renderText } from "../shared/render-text.ts";
import type { AgentState, AppState, LogEntry } from "../shared/schemas.ts";
import { ATTENTION_RANK, type Attention } from "../shared/summary.ts";
import { reduceTimeline, initialTimeline } from "../shared/timeline.ts";
import { DEFAULT_PORT, isLoopback, rowrowHome } from "../server/config.ts";
import { connect, resolveTarget, type Client } from "./client.ts";

const HELP = `rowrow: run a crew of coding agents and steer them from any browser.

Server
  rowrow serve [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--profile default] [--public-url URL]
               [--tls-cert FILE --tls-key FILE] [--test-runtime] [--idle-timeout 30m] [--open]
  rowrow open                      sign this machine's browser in and open rowrow
  rowrow pair [name]               a one-time sign-in link for another device (show it as a QR code)
  rowrow status                    server, live runs, connected clients, recent problems

Service (keeps the server running: starts at login, restarts after a crash)
  rowrow service install [serve flags…]   launchd on macOS, systemd --user on Linux
  rowrow service status|restart|uninstall

Agents
  rowrow agents [--all]            list agents, the ones that need you first
  rowrow agent new <workspace> [--runtime claude] [--model M] [--title T] [prompt…] [--wait]
  rowrow agent send <agent> <text…> [--queue | --interrupt] [--wait]
  rowrow agent wait <agent> [--until done,blocked,idle] [--timeout 10m]
  rowrow agent view <agent> [--turns N] [--follow]      the transcript, as the UI shows it
  rowrow agent entries <agent> [--after N] [--full] [--follow]   the raw log (JSON lines)
  rowrow agent abort|stop|archive|seen <agent>
  (an <agent> is its id, a unique id prefix, or a unique part of its title)

Workspaces
  rowrow ws                        list workspaces
  rowrow ws add <path> [--label L]
  rowrow ws browse [path]

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
      "idle-timeout": { type: "string" },
      open: { type: "boolean" },
      runtime: { type: "string" },
      model: { type: "string" },
      title: { type: "string" },
      label: { type: "string" },
      wait: { type: "boolean" },
      queue: { type: "boolean" },
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
    },
  });
  const str = (name: string): string | undefined => {
    const value = flags[name];
    return typeof value === "string" ? value : undefined;
  };
  const bool = (name: string): boolean => flags[name] === true;
  const json = bool("json");
  const [command = "help", ...rest] = positionals;

  if (bool("help") || command === "help") {
    console.log(HELP);
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
      await service.installService(profile, [
        ...(profile === "default" ? [] : ["--profile", profile]),
        ...pass("host", str("host")),
        ...pass("port", str("port")),
        ...pass("public-url", str("public-url")),
        ...pass("tls-cert", file(str("tls-cert"))),
        ...pass("tls-key", file(str("tls-key"))),
        ...pass("idle-timeout", str("idle-timeout")),
        ...(bool("test-runtime") ? ["--test-runtime"] : []),
      ]);
    } else if (action === "uninstall") service.uninstallService(profile);
    else if (action === "restart") await service.restartService(profile);
    else if (action === "status") service.serviceStatus(profile);
    else throw new Error(`unknown service command "${action}" (install, status, restart, uninstall)`);
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
      case "agent":
        await agentCommand(client, rest, { str, bool, json, out, trace });
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
  json: boolean;
  out(value: unknown, human: () => string): void;
  trace: string;
}

async function agentCommand(client: Client, args: string[], h: Helpers): Promise<void> {
  const [sub = "", ref = "", ...rest] = args;
  if (sub === "new") {
    const { state } = await client.state.get();
    // A workspace by id or label, or any directory path (registered on the fly).
    const ws = findWorkspace(state, ref) ?? (await client.workspaces.add({ path: path.resolve(ref) }));
    const text = rest.join(" ");
    const { agent, sent } = await client.agents.create({
      workspaceId: ws.id,
      runtime: h.str("runtime") ?? "claude",
      ...(h.str("model") === undefined ? {} : { model: h.str("model") }),
      ...(h.str("title") === undefined ? {} : { title: h.str("title") }),
      ...(text === "" ? {} : { input: { inputId: newInputId(), text } }),
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
      const mode = h.bool("queue") ? "queue" : h.bool("interrupt") ? "interrupt" : "auto";
      const result = await client.agents.send({ agentId, inputId: newInputId(), text: rest.join(" "), mode });
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
