import { describe, expect, test } from "vitest";
import type { Health, Tailnet, TailnetNode } from "../shared/reach.ts";
import { discover, parseAddress, pickAddress, tailnetCandidates, type DiscoverDeps } from "./discovery.ts";

const peer = (name: string, fields: Partial<TailnetNode> = {}): TailnetNode => ({
  name,
  dnsName: `${name}.tail1234.ts.net`,
  ips: ["100.80.1.2"],
  online: true,
  os: "linux",
  ...fields,
});

const txt = (fields: Record<string, string>) =>
  Object.entries(fields).map(([key, value]) => Buffer.from(`${key}=${value}`));

/** A response from a rowrow server on the LAN, as multicast-dns decodes it. */
function advertisement(id: string, name: string, addresses: string[], port = 7373) {
  const instance = `${name} (rowrow ${id.slice(-4)})._rowrow._tcp.local`;
  const host = `rowrow-${id.replace("_", "-")}.local`;
  return {
    answers: [{ name: "_rowrow._tcp.local", type: "PTR" as const, ttl: 4500, data: instance }],
    additionals: [
      { name: instance, type: "SRV" as const, ttl: 120, data: { port, target: host } },
      {
        name: instance,
        type: "TXT" as const,
        ttl: 4500,
        data: txt({ id, name, version: "0.3.81", port: String(port) }),
      },
      ...addresses.map((address) => ({ name: host, type: "A" as const, ttl: 120, data: address })),
    ],
  };
}

function deps(
  fields: Omit<Partial<DiscoverDeps>, "health"> & { health?: Record<string, Health> },
): DiscoverDeps {
  const health: Record<string, Health> = fields.health ?? {};
  return {
    browse: async () => [],
    tailnet: async () => null,
    local: [{ address: "192.168.1.5", netmask: "255.255.255.0" }],
    port: 7373,
    known: new Map(),
    ...fields,
    health: async (origin) => health[origin] ?? null,
  };
}

describe("finding machines", () => {
  test("uses the address of a machine on this Mac's own network", () => {
    const local = [{ address: "192.168.1.5", netmask: "255.255.255.0" }];
    expect(pickAddress(["172.17.0.1", "192.168.1.20", "100.80.1.2"], local)).toBe("192.168.1.20");
    expect(pickAddress(["10.0.0.9", "8.8.8.8"], local)).toBe("10.0.0.9");
    expect(pickAddress(["100.80.1.2", "8.8.8.8"], local)).toBeNull();
  });

  test("asks the tailnet's online computers, not its phones", () => {
    const tailnet: Tailnet = {
      self: peer("this-mac"),
      peers: [
        peer("devbox"),
        peer("phone", { os: "iOS" }),
        peer("away", { online: false }),
        peer("no-dns", { dnsName: null, ips: ["100.80.1.9"] }),
      ],
    };
    expect(tailnetCandidates(tailnet)).toEqual([
      { name: "devbox", host: "devbox.tail1234.ts.net" },
      { name: "no-dns", host: "100.80.1.9" },
    ]);
  });

  test("lists each server once, over Tailscale when it's there both ways, and says which the app has", async () => {
    const found = await discover(
      deps({
        browse: async () => [
          advertisement("srv_aaaaaaaaaaaa", "devbox", ["172.17.0.1", "192.168.1.20"]),
          advertisement("srv_bbbbbbbbbbbb", "mac-mini", ["192.168.1.30"], 7400),
          advertisement("srv_cccccccccccc", "this-mac", ["192.168.1.5"]),
        ],
        tailnet: async () => ({ self: peer("this-mac"), peers: [peer("devbox"), peer("printer")] }),
        health: {
          "http://devbox.tail1234.ts.net:7373": { ok: true, version: "0.3.81", id: "srv_aaaaaaaaaaaa" },
        },
        known: new Map([["http://192.168.1.30:7400", "srv_app1"]]),
      }),
    );
    expect(found).toEqual([
      {
        id: "srv_aaaaaaaaaaaa",
        name: "devbox",
        url: "http://devbox.tail1234.ts.net:7373",
        via: "tailscale",
        version: "0.3.81",
        added: null,
      },
      {
        id: "srv_bbbbbbbbbbbb",
        name: "mac-mini",
        url: "http://192.168.1.30:7400",
        via: "lan",
        version: "0.3.81",
        added: "srv_app1",
      },
    ]);
  });

  test("knows a machine the app added at its other address", async () => {
    const found = await discover(
      deps({
        browse: async () => [advertisement("srv_aaaaaaaaaaaa", "devbox", ["192.168.1.20"])],
        tailnet: async () => ({ self: peer("this-mac"), peers: [peer("devbox")] }),
        health: {
          "http://devbox.tail1234.ts.net:7373": { ok: true, version: "0.3.81", id: "srv_aaaaaaaaaaaa" },
        },
        known: new Map([["http://192.168.1.20:7373", "srv_app1"]]),
      }),
    );
    expect(found).toMatchObject([{ via: "tailscale", added: "srv_app1" }]);
  });

  test("finds nothing, without failing, when the network says nothing", async () => {
    const found = await discover(
      deps({
        browse: () => Promise.reject(new Error("EADDRINUSE")),
        tailnet: () => Promise.reject(new Error("no tailscale")),
      }),
    );
    expect(found).toEqual([]);
  });
});

describe("an address you type", () => {
  test("becomes an origin, on rowrow's port unless it says otherwise", () => {
    expect(parseAddress("devbox.tail1234.ts.net")).toBe("http://devbox.tail1234.ts.net:7373");
    expect(parseAddress(" 192.168.1.20:7400/ ")).toBe("http://192.168.1.20:7400");
    expect(parseAddress("http://devbox:7373")).toBe("http://devbox:7373");
    expect(parseAddress("https://devbox.tail1234.ts.net")).toBe("https://devbox.tail1234.ts.net");
    expect(parseAddress("devbox", 7500)).toBe("http://devbox:7500");
    for (const junk of ["", "two words", "ftp://devbox", "http://me:pw@devbox"])
      expect(parseAddress(junk), junk).toBeNull();
  });
});
