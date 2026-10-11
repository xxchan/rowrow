// Where a machine can be reached, what `rowrow up` does about its service, and what a server
// says about itself on the LAN (D-060).
import { describe, expect, it } from "vitest";
import { planUp, serveFlags } from "../src/cli/up.ts";
import { answer, namesFor, serviceRecords } from "../src/server/advertise.ts";
import { advertisementsIn } from "../src/desktop/discovery.ts";
import type { ServiceStatus } from "../src/shared/host.ts";
import {
  advertisedTxt,
  isPrivateAddress,
  parseTailscaleStatus,
  reachableAddresses,
  readAdvertisedTxt,
  readHealth,
  sameSubnet,
} from "../src/shared/reach.ts";

/** What `tailscale status --json` says, cut to what rowrow reads. */
const TAILSCALE_STATUS = {
  BackendState: "Running",
  CurrentTailnet: { Name: "you@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  Self: {
    HostName: "devbox",
    DNSName: "devbox.tail1234.ts.net.",
    TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"],
    OS: "linux",
    Online: true,
  },
  Peer: {
    "nodekey:1": {
      HostName: "mac-mini",
      DNSName: "mac-mini.tail1234.ts.net.",
      TailscaleIPs: ["100.80.1.2", "fd7a:115c:a1e0::2"],
      OS: "macOS",
      Online: true,
    },
    "nodekey:2": {
      HostName: "phone",
      DNSName: "phone.tail1234.ts.net.",
      TailscaleIPs: ["100.80.1.3"],
      OS: "iOS",
      Online: true,
    },
    "nodekey:3": {
      HostName: "old",
      DNSName: "old.tail1234.ts.net.",
      TailscaleIPs: ["100.80.1.4"],
      OS: "linux",
      Online: false,
    },
  },
};

describe("private networks (--host private)", () => {
  it("are loopback, the LAN, link-local and Tailscale, in IPv4 and IPv6", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
      "169.254.10.1",
      "100.64.0.1",
      "100.127.255.254",
      "::ffff:192.168.1.20",
      "fd7a:115c:a1e0::1",
      "fe80::1%en0",
    ])
      expect(isPrivateAddress(address), address).toBe(true);
  });

  it("are not the internet", () => {
    for (const address of [
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "192.169.0.1",
      "::ffff:1.1.1.1",
      "2606:4700:4700::1111",
      "::",
      "",
      "not an address",
    ])
      expect(isPrivateAddress(address), address).toBe(false);
  });

  it("know a subnet by its mask", () => {
    expect(sameSubnet("192.168.1.20", "192.168.1.5", "255.255.255.0")).toBe(true);
    expect(sameSubnet("192.168.2.20", "192.168.1.5", "255.255.255.0")).toBe(false);
    expect(sameSubnet("10.0.200.1", "10.0.1.1", "255.255.0.0")).toBe(true);
  });
});

describe("addresses other devices reach", () => {
  it("come from Tailscale first (its name, then its IPv4), then the LAN, without containers or public addresses", () => {
    const tailnet = parseTailscaleStatus(TAILSCALE_STATUS);
    const addresses = reachableAddresses({
      port: 7373,
      https: false,
      tailnet,
      interfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [
          { address: "192.168.1.20", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
        eth1: [{ address: "203.0.113.7", family: "IPv4", internal: false }],
        docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
        tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
      },
    });
    expect(addresses).toEqual([
      { url: "http://devbox.tail1234.ts.net:7373", via: "tailscale", encrypted: true },
      { url: "http://100.101.102.103:7373", via: "tailscale", encrypted: true },
      { url: "http://192.168.1.20:7373", via: "lan", encrypted: false },
    ]);
  });

  it("are the LAN's alone without Tailscale, or with it stopped", () => {
    const interfaces = { en0: [{ address: "10.0.0.5", family: 4, internal: false }] };
    const lan = [{ url: "https://10.0.0.5:7373", via: "lan", encrypted: true }];
    expect(reachableAddresses({ port: 7373, https: true, tailnet: null, interfaces })).toEqual(lan);
    const stopped = parseTailscaleStatus({ ...TAILSCALE_STATUS, BackendState: "Stopped" });
    expect(stopped).toBeNull();
  });

  it("read Tailscale's status: names without MagicDNS's dot, IPv4 first, peers as they are", () => {
    const tailnet = parseTailscaleStatus(TAILSCALE_STATUS);
    expect(tailnet?.self).toEqual({
      name: "devbox",
      dnsName: "devbox.tail1234.ts.net",
      ips: ["100.101.102.103", "fd7a:115c:a1e0::1"],
      online: true,
      os: "linux",
    });
    expect(tailnet?.peers.map((peer) => [peer.name, peer.online])).toEqual([
      ["mac-mini", true],
      ["phone", true],
      ["old", false],
    ]);
    const noMagic = parseTailscaleStatus({
      ...TAILSCALE_STATUS,
      CurrentTailnet: { ...TAILSCALE_STATUS.CurrentTailnet, MagicDNSEnabled: false },
    });
    expect(noMagic?.self.dnsName).toBeNull();
    expect(parseTailscaleStatus("nope")).toBeNull();
  });
});

const status = (fields: Partial<ServiceStatus>): ServiceStatus => ({
  profile: "default",
  manager: "systemd",
  installed: false,
  file: "/home/me/.config/systemd/user/rowrow-default.service",
  state: null,
  command: null,
  install: null,
  server: null,
  ...fields,
});
const server = (publicUrl: string): ServiceStatus["server"] => ({
  url: "http://127.0.0.1:7373",
  publicUrl,
  pid: 42,
  version: "0.3.81",
  startedAt: 1,
});
const node = ["/usr/bin/node", "/usr/lib/node_modules/rowrow/lib/cli/main.js", "serve"];

describe("rowrow up", () => {
  it("reads a service's serve flags", () => {
    expect(
      serveFlags([...node, "--host", "private", "--public-url=https://x.ts.net", "--port", "7373"]),
    ).toEqual({
      args: ["--host", "private", "--public-url=https://x.ts.net", "--port", "7373"],
      host: "private",
      publicUrl: "https://x.ts.net",
    });
  });

  it("installs the service for private networks when there's none", () => {
    expect(planUp(status({}), "default", null)).toEqual({
      kind: "install",
      args: ["--host", "private"],
      replacing: false,
    });
    expect(planUp(status({}), "work", "7400")).toMatchObject({
      args: ["--profile", "work", "--host", "private", "--port", "7400"],
    });
  });

  it("moves a service on loopback to private networks, keeping its other flags", () => {
    const loopback = status({
      installed: true,
      command: [...node, "--host", "127.0.0.1", "--idle-timeout", "1h"],
      server: server("http://127.0.0.1:7373"),
    });
    expect(planUp(loopback, "default", null)).toEqual({
      kind: "install",
      args: ["--idle-timeout", "1h", "--host", "private"],
      replacing: true,
    });
  });

  it("leaves a service you set up to be reached as it is, and starts it if it's stopped", () => {
    const served = status({
      installed: true,
      command: [...node, "--public-url", "https://devbox.tail1234.ts.net"],
    });
    expect(planUp(served, "default", null)).toEqual({ kind: "service", running: false });
    const everywhere = status({
      installed: true,
      command: [...node, "--host", "0.0.0.0"],
      server: server("x"),
    });
    expect(planUp(everywhere, "default", null)).toEqual({ kind: "service", running: true });
  });

  it("uses a server in a terminal that others reach, and asks to stop one on loopback", () => {
    expect(planUp(status({ server: server("http://192.168.1.20:7373") }), "default", null)).toEqual({
      kind: "terminal",
    });
    expect(planUp(status({ server: server("http://127.0.0.1:7373") }), "default", null)).toEqual({
      kind: "stop-first",
      pid: 42,
    });
  });
});

describe("the LAN advertisement", () => {
  const advertised = { id: "srv_0123456789abcdef", name: "devbox", version: "0.3.81", port: 7373 };

  it("says the machine's name, version, port and id, and nothing it can't read back", () => {
    expect(readAdvertisedTxt(advertisedTxt(advertised))).toEqual(advertised);
    expect(readAdvertisedTxt(["name=devbox", "version=1"])).toBeNull();
    expect(readAdvertisedTxt(["id=srv_x y", "name=devbox", "version=1"])).toBeNull();
    expect(readHealth({ ok: true, version: "0.3.81", id: advertised.id })).toEqual({
      ok: true,
      version: "0.3.81",
      id: advertised.id,
    });
    expect(readHealth({ ok: true, version: "0.3.70" })?.id).toBe("");
    expect(readHealth({ hello: "world" })).toBeNull();
  });

  it("answers a browser's question for _rowrow._tcp with everything needed to connect", () => {
    const records = serviceRecords(advertised, ["192.168.1.20", "100.101.102.103"]);
    const { instance, host } = namesFor(advertised);
    const reply = answer({ name: "_rowrow._tcp.local", type: "PTR" }, records);
    expect(reply.answers.map((r) => r.type)).toEqual(["PTR"]);
    expect(reply.additionals.map((r) => r.type).sort()).toEqual(["A", "A", "SRV", "TXT"]);
    expect(
      answer({ name: instance.toUpperCase(), type: "SRV" }, records).additionals.map((r) => r.type),
    ).toEqual(["A", "A"]);
    expect(answer({ name: host, type: "A" }, records).answers).toHaveLength(2);
    expect(answer({ name: "_http._tcp.local", type: "PTR" }, records).answers).toEqual([]);
    expect(host).toBe("rowrow-srv-0123456789abcdef.local");
  });

  it("is read back by the Mac app from what it hears, and gone after a goodbye", () => {
    // As dns-packet decodes them: TXT entries as bytes.
    const heard = (records: ReturnType<typeof serviceRecords>) =>
      records.map((record) =>
        record.type === "TXT" && Array.isArray(record.data)
          ? { ...record, data: record.data.map((entry) => Buffer.from(String(entry))) }
          : record,
      );
    const hello = { answers: heard(serviceRecords(advertised, ["192.168.1.20"])), additionals: [] };
    expect(advertisementsIn([hello])).toEqual([{ advertised, port: 7373, addresses: ["192.168.1.20"] }]);
    const goodbye = { answers: heard(serviceRecords(advertised, ["192.168.1.20"], { long: 0, short: 0 })) };
    expect(advertisementsIn([hello, { ...goodbye, additionals: [] }])).toEqual([]);
  });
});
