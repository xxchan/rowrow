// Implements the contract once (docs/decisions.md, D-003). Served to browsers over
// WebSocket and to the CLI and agents over HTTP by ./server.ts. Every call passes the same
// middleware: a trace id (the caller's, or a new one), the device and connection in the
// log context, an `api.call` or `api.error` log line, and errors turned into typed oRPC
// errors whose message says what went wrong.
import { implement, ORPCError } from "@orpc/server";
import { contract } from "../../shared/contract.ts";
import { slimEntry, type Actor, type Attachment, type Entry } from "../../shared/entries.ts";
import { renderText } from "../../shared/render-text.ts";
import type {
  BulkAction,
  Changes,
  CommitChanges,
  CommitPage,
  DiffScope,
  FileAction,
  FileList,
  FileText,
  HostInfo,
  LogEntry,
  Notice,
  PullRequestStatus,
  SearchKind,
  SearchResult,
  SeenFile,
  StateMessage,
  Workspace,
} from "../../shared/schemas.ts";
import type { Attention } from "../../shared/summary.ts";
import { timelineOf } from "../../shared/timeline.ts";
import type { AgentLog } from "../agents/log.ts";
import type { Runtimes } from "../agents/runtimes.ts";
import type { AgentService } from "../agents/service.ts";
import type { DeviceRecord, Devices } from "../auth/devices.ts";
import { UserError } from "../errors.ts";
import type { Apns } from "../notify/apns.ts";
import type { LiveNotices } from "../notify/live.ts";
import type { Presence } from "../notify/presence.ts";
import type { Push } from "../notify/push.ts";
import type { SettingsService } from "../settings.ts";
import type { StateStore } from "../state/store.ts";
import { log, matches, newTraceId, onLog, queryLog, serializeError, withContext } from "../telemetry/log.ts";
import type { Workspaces } from "../workspaces/service.ts";
import { channel } from "./channel.ts";
import { checkAttachments, readUpload, saveUpload } from "./uploads.ts";

export interface ApiContext {
  readonly device: DeviceRecord;
  /** Who acts: the device, or an agent using the agents' token. Stamped on log entries. */
  readonly actor: Actor;
  /** The WebSocket connection, for presence. */
  readonly connectionId?: string;
  /** A trace id the caller brought (header `x-rowrow-trace`). */
  readonly trace?: string;
}

export interface GitOps {
  createWorktree(
    workspaceId: string,
    options: { branch?: string; base?: string },
  ): Promise<{
    workspace: Workspace;
    hook: { ran: boolean; ok: boolean; output: string } | null;
  }>;
  removeWorktree(workspaceId: string, force: boolean): Promise<void>;
  changes(workspaceId: string, scope: DiffScope, agentId?: string): Promise<Changes>;
  diff(
    workspaceId: string,
    scope: DiffScope,
    path: string,
    agentId?: string,
  ): Promise<{ patch: string; truncated: boolean }>;
  fileAction(
    workspaceId: string,
    action: FileAction,
    file: SeenFile,
  ): Promise<{ paths: string[]; changes: Changes }>;
  bulkAction(
    workspaceId: string,
    action: BulkAction,
    files: readonly SeenFile[],
  ): Promise<{ paths: string[]; changes: Changes }>;
  log(workspaceId: string, options: { cursor?: string; limit?: number }): Promise<CommitPage>;
  commit(workspaceId: string, sha: string): Promise<CommitChanges>;
  commitDiff(workspaceId: string, sha: string, path: string): Promise<{ patch: string; truncated: boolean }>;
  pullRequest(workspaceId: string, refresh: boolean): Promise<PullRequestStatus>;
  search(workspaceId: string, query: string, kind: SearchKind): Promise<SearchResult>;
  listFiles(workspaceId: string): Promise<FileList>;
  readFile(workspaceId: string, path: string): Promise<FileText>;
}

export interface Services {
  host(): HostInfo;
  readonly state: StateStore;
  readonly workspaces: Workspaces;
  readonly agents: AgentService;
  readonly agentLog: AgentLog;
  readonly runtimes: Runtimes;
  readonly devices: Devices;
  readonly push: Push;
  readonly apns: Apns;
  /** notify.watch streams (the Mac app). */
  readonly live: LiveNotices;
  /** How many agents need you. */
  badge(): number;
  readonly presence: Presence;
  readonly git: GitOps;
  readonly settings: SettingsService;
  /** Where uploaded files go. */
  readonly uploadsDir: string;
  loginUrl(code: string): string;
  refreshRuntimes(): Promise<void>;
}

/** Called so often, or so plainly, that an api.call line each would drown the log. */
const QUIET = new Set(["presence.update", "telemetry.report", "agents.markSeen", "logs.query"]);
const DEFAULT_WAIT: Attention[] = ["blocked", "done", "idle"];

/** Presence of an HTTP client's state.watch stream: its own name, scoped to the device that chose it. */
function httpConnection(deviceId: string, name: string): string {
  return `http:${deviceId}:${name}`;
}

export function createRouter(s: Services) {
  const pushDevices = (): Set<string> =>
    new Set([...s.push.subscribedDevices(), ...s.apns.registeredDevices(), ...s.live.devices()]);
  const os = implement(contract)
    .$context<ApiContext>()
    .use(async ({ context, next, path }) => {
      const name = path.join(".");
      const trace = context.trace ?? newTraceId();
      return withContext(
        {
          trace,
          device: context.device.id,
          ...(context.connectionId === undefined ? {} : { conn: context.connectionId }),
          ...(context.actor.kind === "agent" ? { agent: context.actor.agentId } : {}),
        },
        async () => {
          const started = Date.now();
          try {
            const result = await next();
            if (!QUIET.has(name)) log.info("api.call", { proc: name, ms: Date.now() - started });
            return result;
          } catch (error) {
            throw toORPCError(error, name, Date.now() - started);
          }
        },
      );
    });

  /** An input's attachments, checked to be uploads: `{ attachments }` for the send, or nothing. */
  const attachmentsOf = (
    attachments: readonly Attachment[] | undefined,
  ): { attachments?: readonly Attachment[] } => {
    if (attachments === undefined || attachments.length === 0) return {};
    checkAttachments(s.uploadsDir, attachments);
    return { attachments };
  };

  return os.router({
    app: {
      info: os.app.info.handler(() => s.host()),
      status: os.app.status.handler(() => ({
        host: s.host(),
        runs: s.agents.liveRuns(),
        clients: s.presence.list().map((c) => ({
          id: c.id,
          device: c.deviceName,
          route: c.route,
          visible: c.visible,
          focused: c.focused,
          since: c.since,
        })),
        counts: {
          workspaces: s.workspaces.list().length,
          agents: s.agents.list().length,
          entries: s.agentLog.count(),
        },
        problems: queryLog({ level: "warn", limit: 30 }),
      })),
    },

    state: {
      get: os.state.get.handler(() => s.state.get()),
      watch: os.state.watch.handler(({ input, context, signal }) => {
        // Over HTTP there is no socket to hang presence on: the stream itself is the connection.
        const name = input?.connection;
        const id =
          name === undefined || context.connectionId !== undefined
            ? null
            : httpConnection(context.device.id, name);
        const presence = id === null ? null : s.presence.open(id, context.device.id, context.device.name);
        let unsubscribe = (): void => undefined;
        const ch = channel<StateMessage>(() => {
          unsubscribe();
          if (id !== null && presence !== null) s.presence.close(id, presence);
        }, signal);
        unsubscribe = s.state.watch((message) => ch.push(message));
        return ch.iterator;
      }),
    },

    workspaces: {
      add: os.workspaces.add.handler(async ({ input }) => s.workspaces.add(input.path, input.label)),
      update: os.workspaces.update.handler(({ input }) =>
        s.workspaces.update(input.id, {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
        }),
      ),
      refresh: os.workspaces.refresh.handler(async ({ input }) => s.workspaces.refresh(input.id)),
      browse: os.workspaces.browse.handler(({ input }) => {
        try {
          return s.workspaces.browse(input.path);
        } catch (error) {
          throw new UserError(error instanceof Error ? error.message : String(error));
        }
      }),
      createWorktree: os.workspaces.createWorktree.handler(async ({ input }) =>
        s.git.createWorktree(input.id, {
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.base === undefined ? {} : { base: input.base }),
        }),
      ),
      removeWorktree: os.workspaces.removeWorktree.handler(async ({ input }) => {
        await s.git.removeWorktree(input.id, input.force ?? false);
        return { ok: true as const };
      }),
    },

    agents: {
      create: os.agents.create.handler(async ({ input, context }) => {
        const agent = s.agents.create({
          workspaceId: input.workspaceId,
          runtime: input.runtime,
          by: context.actor,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.title === undefined ? {} : { title: input.title }),
        });
        const sent =
          input.input === undefined
            ? null
            : await s.agents.send(agent.id, {
                inputId: input.input.inputId,
                text: input.input.text,
                ...attachmentsOf(input.input.attachments),
                mode: "auto",
                by: context.actor,
                ...(context.trace === undefined ? {} : { trace: context.trace }),
              });
        return { agent: s.agents.get(agent.id) ?? agent, sent };
      }),
      send: os.agents.send.handler(async ({ input, context }) =>
        s.agents.send(input.agentId, {
          inputId: input.inputId,
          text: input.text,
          ...attachmentsOf(input.attachments),
          mode: input.mode,
          by: context.actor,
          ...(context.trace === undefined ? {} : { trace: context.trace }),
        }),
      ),
      withdraw: os.agents.withdraw.handler(async ({ input, context }) => {
        const taken = await s.agents.withdraw(input.agentId, input.inputId, context.actor);
        return { text: taken.text, attachments: [...taken.attachments] };
      }),
      sendNow: os.agents.sendNow.handler(async ({ input }) => s.agents.sendNow(input.agentId, input.inputId)),
      resume: os.agents.resume.handler(async ({ input, context }) => {
        await s.agents.resume(input.agentId, context.actor);
        return { ok: true as const };
      }),
      abort: os.agents.abort.handler(async ({ input }) => s.agents.abort(input.agentId)),
      stop: os.agents.stop.handler(async ({ input }) => {
        await s.agents.stop(input.agentId);
        return { ok: true as const };
      }),
      update: os.agents.update.handler(async ({ input, context }) =>
        s.agents.update(
          input.agentId,
          {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            ...(input.archived === undefined ? {} : { archived: input.archived }),
          },
          context.actor,
        ),
      ),
      markSeen: os.agents.markSeen.handler(({ input }) => {
        s.agents.markSeen(input.agentId, input.seq);
        return { ok: true as const };
      }),
      entries: os.agents.entries.handler(({ input }) => {
        requireAgent(s, input.agentId);
        const page = s.agentLog.read(input.agentId, {
          ...(input.after === undefined ? {} : { after: input.after }),
          ...(input.before === undefined ? {} : { before: input.before }),
          ...(input.turns === undefined ? {} : { turns: input.turns }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        return input.full === true ? page : { ...page, entries: page.entries.map(slimEntry) };
      }),
      watch: os.agents.watch.handler(({ input, signal }) => {
        requireAgent(s, input.agentId);
        let unsubscribe = (): void => undefined;
        const ch = channel<{ entries: Entry[] }>(() => unsubscribe(), signal);
        // Entries arrive one at a time (text streams as many small ones); send them in batches per tick.
        let batch: Entry[] = [];
        let scheduled = false;
        const flush = (): void => {
          scheduled = false;
          if (batch.length === 0) return;
          ch.push({ entries: batch });
          batch = [];
        };
        unsubscribe = s.agentLog.follow(input.agentId, input.after, (entry) => {
          batch.push(slimEntry(entry));
          if (!scheduled) {
            scheduled = true;
            setImmediate(flush);
          }
        });
        return ch.iterator;
      }),
      wait: os.agents.wait.handler(async ({ input }) =>
        s.agents.wait(
          input.agentId,
          input.until ?? DEFAULT_WAIT,
          input.afterSeq ?? -1,
          input.timeoutMs ?? 10 * 60_000,
        ),
      ),
      view: os.agents.view.handler(({ input }) => {
        requireAgent(s, input.agentId);
        const page = s.agentLog.read(input.agentId, { turns: input.turns ?? 1_000_000 });
        return {
          text: renderText(
            timelineOf(page.entries),
            input.toolChars === undefined ? {} : { toolChars: input.toolChars },
          ),
          headSeq: page.headSeq,
        };
      }),
    },

    runtimes: {
      list: os.runtimes.list.handler(async ({ input }) => {
        if (input.refresh === true) await s.refreshRuntimes();
        return s.runtimes.list();
      }),
      models: os.runtimes.models.handler(async ({ input }) =>
        s.runtimes.listModels(input.runtime, input.refresh ?? false),
      ),
      skills: os.runtimes.skills.handler(async ({ input }) => {
        const ws = s.workspaces.get(input.workspaceId);
        if (ws === undefined)
          throw new ORPCError("NOT_FOUND", { message: `no workspace ${input.workspaceId}` });
        return s.runtimes.skills(input.runtime, ws.path);
      }),
      updates: os.runtimes.updates.handler(async ({ input }) => s.runtimes.updates(input.refresh ?? false)),
      upgrade: os.runtimes.upgrade.handler(async ({ input }) => {
        const result = await s.runtimes.upgrade(input.runtime);
        // The new version, in every client's state.
        if (result.kind === "upgraded" || result.kind === "unchanged") await s.refreshRuntimes();
        return result;
      }),
    },

    git: {
      changes: os.git.changes.handler(async ({ input }) =>
        s.git.changes(input.workspaceId, input.scope, input.agentId),
      ),
      diff: os.git.diff.handler(async ({ input }) =>
        s.git.diff(input.workspaceId, input.scope, input.path, input.agentId),
      ),
      fileAction: os.git.fileAction.handler(async ({ input }) =>
        s.git.fileAction(input.workspaceId, input.action, {
          path: input.path,
          stamp: input.stamp,
          ...(input.oldPath === undefined ? {} : { oldPath: input.oldPath }),
        }),
      ),
      bulkAction: os.git.bulkAction.handler(async ({ input }) =>
        s.git.bulkAction(input.workspaceId, input.action, input.files),
      ),
      log: os.git.log.handler(async ({ input }) =>
        s.git.log(input.workspaceId, {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      ),
      commit: os.git.commit.handler(async ({ input }) => s.git.commit(input.workspaceId, input.sha)),
      commitDiff: os.git.commitDiff.handler(async ({ input }) =>
        s.git.commitDiff(input.workspaceId, input.sha, input.path),
      ),
      pullRequest: os.git.pullRequest.handler(async ({ input }) =>
        s.git.pullRequest(input.workspaceId, input.refresh ?? false),
      ),
    },

    files: {
      upload: os.files.upload.handler(async ({ input }) => saveUpload(s.uploadsDir, input.file)),
      get: os.files.get.handler(({ input }) => readUpload(s.uploadsDir, input.path)),
      search: os.files.search.handler(async ({ input }) =>
        s.git.search(input.workspaceId, input.query, input.kind),
      ),
      list: os.files.list.handler(async ({ input }) => s.git.listFiles(input.workspaceId)),
      read: os.files.read.handler(async ({ input }) => s.git.readFile(input.workspaceId, input.path)),
    },

    devices: {
      whoami: os.devices.whoami.handler(({ context }) => {
        const found = s.devices.list(context.device.id, pushDevices()).find((d) => d.current);
        return (
          found ?? {
            id: context.device.id,
            name: context.device.name,
            kind: context.device.kind,
            createdAt: 0,
            lastSeenAt: null,
            current: true,
            push: false,
          }
        );
      }),
      list: os.devices.list.handler(({ context }) => s.devices.list(context.device.id, pushDevices())),
      pair: os.devices.pair.handler(({ input }) => {
        const { code, expiresAt } = s.devices.createLoginCode(input.name);
        return { url: s.loginUrl(code), expiresAt };
      }),
      rename: os.devices.rename.handler(({ input }) => {
        s.devices.rename(input.id, input.name);
        return { ok: true as const };
      }),
      revoke: os.devices.revoke.handler(({ input }) => {
        s.devices.revoke(input.id);
        return { ok: true as const };
      }),
    },

    notify: {
      subscribe: os.notify.subscribe.handler(({ input, context }) => {
        s.push.subscribe(context.device.id, input);
        return { ok: true as const };
      }),
      subscribeApns: os.notify.subscribeApns.handler(({ input, context }) => {
        s.apns.register(context.device.id, input);
        return { ok: true as const };
      }),
      unsubscribe: os.notify.unsubscribe.handler(({ context }) => {
        s.push.unsubscribe(context.device.id);
        s.apns.unregister(context.device.id);
        return { ok: true as const };
      }),
      watch: os.notify.watch.handler(({ context, signal }) => {
        let unsubscribe = (): void => undefined;
        const ch = channel<Notice>(() => unsubscribe(), signal);
        ch.push({ kind: "badge", badge: s.badge() });
        unsubscribe = s.live.watch(context.device.id, (notice) => ch.push(notice));
        return ch.iterator;
      }),
      test: os.notify.test.handler(async ({ context }) => {
        // An alert about no agent: agentId "" (the Mac app opens the url and marks nothing seen).
        const live = s.live.alert(
          {
            kind: "alert",
            agentId: "",
            attention: "done",
            title: "rowrow",
            subtitle: null,
            body: "Notifications work on this device.",
            url: "/",
            seq: -1,
            badge: s.badge(),
          },
          () => false,
          context.device.id,
        );
        const [web, app] = await Promise.all([
          s.push.send(
            { title: "rowrow", body: "Notifications work on this device.", url: "/", tag: "test" },
            () => false,
            context.device.id,
          ),
          s.apns.alert(
            {
              title: "rowrow",
              body: "Notifications work on this device.",
              generic: "A test notification.",
              thread: "test",
            },
            () => false,
            context.device.id,
          ),
        ]);
        return { sent: web + app + live };
      }),
      configureApns: os.notify.configureApns.handler(({ input }) => {
        s.apns.configure(input);
        return { keyId: input.keyId.trim(), teamId: input.teamId.trim() };
      }),
      removeApns: os.notify.removeApns.handler(() => {
        s.apns.remove();
        return { ok: true as const };
      }),
    },

    presence: {
      update: os.presence.update.handler(({ input, context }) => {
        const { connection, ...what } = input;
        const id =
          context.connectionId ??
          (connection === undefined ? undefined : httpConnection(context.device.id, connection));
        if (id !== undefined) s.presence.update(id, what);
        return { ok: true as const };
      }),
    },

    settings: {
      update: os.settings.update.handler(({ input }) => s.settings.update(input)),
    },

    telemetry: {
      report: os.telemetry.report.handler(({ input, context }) => {
        for (const event of input.events) {
          log.entry(event.level, `client.${event.evt}`, {
            ...event.data,
            ...(event.msg === undefined ? {} : { msg: event.msg }),
            ...(event.route === undefined ? {} : { route: event.route }),
            ...(event.trace === undefined ? {} : { trace: event.trace }),
            clientAt: event.at,
            deviceName: context.device.name,
          });
        }
        return { ok: true as const };
      }),
    },

    logs: {
      query: os.logs.query.handler(({ input }) => queryLog(input)),
      watch: os.logs.watch.handler(({ input, signal }) => {
        let unsubscribe = (): void => undefined;
        const ch = channel<LogEntry>(() => unsubscribe(), signal);
        unsubscribe = onLog((entry) => {
          if (matches(entry, input)) ch.push(entry);
        });
        return ch.iterator;
      }),
    },
  });
}

export type Router = ReturnType<typeof createRouter>;

function requireAgent(s: Services, agentId: string): void {
  if (!s.agents.has(agentId)) throw new ORPCError("NOT_FOUND", { message: `agent ${agentId} not found` });
}

function toORPCError(error: unknown, proc: string, ms: number): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    log.warn("api.error", { proc, ms, code: error.code, msg: error.message });
    return error;
  }
  if (error instanceof UserError) {
    log.warn("api.error", { proc, ms, code: error.code, msg: error.message });
    return new ORPCError(error.code, { message: error.message });
  }
  log.error("api.error", { proc, ms, code: "INTERNAL_SERVER_ERROR", err: serializeError(error) });
  const message = error instanceof Error ? error.message : String(error);
  return new ORPCError("INTERNAL_SERVER_ERROR", {
    message: `${message} (a bug: see the server log for the stack)`,
    cause: error,
  });
}
