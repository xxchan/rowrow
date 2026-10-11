import { expect, test } from "vitest";
import type { ServerView, ShellState } from "./api.ts";
import { fromServerPage, machinesFor, parseServerPageCall, upgradeWaiting } from "./machines.ts";

const thisMac: ServerView = {
  id: "local",
  name: "This Mac",
  kind: "local",
  where: "This Mac",
  status: { kind: "online" },
  badge: 2,
  version: "0.3.77",
  host: null,
  notifications: true,
};

const devbox: ServerView = {
  id: "srv_devbox",
  name: "devbox",
  kind: "ssh",
  where: "me@devbox.internal",
  status: { kind: "offline", reason: "ssh: connect to host devbox.internal: Connection refused", since: 1 },
  badge: 5,
  version: "0.3.76",
  host: {
    owner: "app",
    installKind: "bundle",
    runningVersion: "0.3.76",
    service: "running",
    upgrade: {
      version: "0.3.77",
      state: "waiting",
      waitingFor: ["Fix the build", "Write docs"],
      error: null,
    },
    logFile: "/home/me/.rowrow/default/logs/rowrow.jsonl",
  },
  notifications: true,
};

function state(servers: ServerView[]): ShellState {
  return {
    version: "0.3.77",
    servers,
    update: {
      current: "0.3.77",
      state: "idle",
      version: null,
      progress: null,
      error: null,
      checkedAt: null,
    },
    localFound: null,
    localSupported: true,
    commandInstalled: false,
    openAtLogin: true,
  };
}

test("a machine's page sees the others' names, status and who needs you, not where they are or their agents", () => {
  const seen = machinesFor(state([thisMac, devbox]), "local");
  expect(seen).toEqual({
    current: "local",
    machines: [
      {
        id: "local",
        name: "This Mac",
        kind: "local",
        status: "online",
        statusText: "Connected",
        needsYou: 2,
        version: "0.3.77",
        upgrade: null,
      },
      {
        id: "srv_devbox",
        name: "devbox",
        kind: "ssh",
        status: "offline",
        statusText: "ssh: connect to host devbox.internal: Connection refused",
        // Not connected: the count it had is no longer known.
        needsYou: null,
        version: "0.3.76",
        upgrade: { version: "0.3.77", state: "waiting", waitingFor: 2, error: null },
      },
    ],
  });
  const text = JSON.stringify(seen);
  for (const hidden of ["me@devbox.internal", "Fix the build", "/home/me"])
    expect(text).not.toContain(hidden);
  // A window that isn't a machine's (or a machine since removed) has no current one.
  expect(machinesFor(state([thisMac]), "srv_gone").current).toBeNull();
  expect(machinesFor(state([thisMac]), null).current).toBeNull();
});

test("a page's calls are the bridge's methods with checked arguments, and nothing else", () => {
  expect(parseServerPageCall("machines", [])).toEqual({ method: "machines" });
  expect(parseServerPageCall("openMachine", ["srv_devbox"])).toEqual({
    method: "openMachine",
    id: "srv_devbox",
  });
  expect(parseServerPageCall("showMachines", ["add"])).toEqual({ method: "showMachines", page: "add" });
  expect(() => parseServerPageCall("showMachines", ["/add/ssh"])).toThrow();
  expect(() => parseServerPageCall("openMachine", [""])).toThrow();
  expect(() => parseServerPageCall("removeMachine", [{ id: "local" }])).toThrow();
  // The app's own pages' API (window.rowrow) isn't reachable from here.
  for (const method of ["hostAction", "addSsh", "addLink", "rename", "installCommand", "getState"])
    expect(() => parseServerPageCall(method, ["local", "stop"])).toThrow(`no method ${method}`);
});

test("only the top frame of a machine's own page may call", () => {
  const origin = "http://127.0.0.1:7373";
  const isServerPage = (url: string): boolean => url.startsWith(`${origin}/`);
  const top = { url: `${origin}/settings` };
  expect(fromServerPage(top, top, isServerPage)).toBe(true);
  // A frame inside the page, even one of the same machine.
  expect(fromServerPage({ url: `${origin}/frame` }, top, isServerPage)).toBe(false);
  // A page from elsewhere in the top frame.
  const elsewhere = { url: "https://example.com/" };
  expect(fromServerPage(elsewhere, elsewhere, isServerPage)).toBe(false);
  // A frame that's gone.
  expect(fromServerPage(null, top, isServerPage)).toBe(false);
});

test("a page can restart a machine only into an upgrade the app put there", () => {
  expect(upgradeWaiting(state([thisMac, devbox]), "srv_devbox")).toBe(true);
  expect(upgradeWaiting(state([thisMac, devbox]), "local")).toBe(false);
  expect(upgradeWaiting(state([thisMac, devbox]), "srv_gone")).toBe(false);
  const upgrade = { version: "0.3.77", state: "installing", waitingFor: [], error: null } as const;
  const installing: ServerView = { ...devbox, host: devbox.host && { ...devbox.host, upgrade } };
  expect(upgradeWaiting(state([installing]), "srv_devbox")).toBe(false);
});
