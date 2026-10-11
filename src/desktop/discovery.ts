// Machines the app can add without anyone typing an address (docs/decisions.md, D-060): rowrow
// servers advertising themselves on this Mac's networks (multicast DNS, _rowrow._tcp, while they
// listen beyond loopback), and, when Tailscale runs on this Mac, the tailnet's machines that answer
// rowrow's /healthz. Looked for when the Add a machine page asks, for a few seconds, from the main
// process. Finding a machine signs nothing in: adding it takes the code `rowrow up` shows there.
//
// The rules (which packets say what, which address to use, which peers to ask, one entry per
// server) are pure functions here, tested without a network; `discover` takes the network as
// arguments.
import multicastDns from "multicast-dns";
import { execFile } from "node:child_process";
import {
  DEFAULT_PORT,
  isLanAddress,
  MDNS_TYPE,
  parseTailscaleStatus,
  readAdvertisedTxt,
  readHealth,
  sameSubnet,
  type Advertised,
  type Health,
  type Tailnet,
} from "../shared/reach.ts";
import type { NearbyMachine } from "./api.ts";

type Packet = Pick<multicastDns.ResponsePacket, "answers" | "additionals">;
/** A record as heard: what every type has (an OPT record has no data or TTL). */
interface Heard {
  readonly name: string;
  readonly type: string;
  readonly ttl?: number | undefined;
  readonly data?: unknown;
}

/** A server's advertisement, put together from the records of every response heard. */
export interface Advertisement {
  readonly advertised: Advertised;
  /** The port its SRV record gives (where it listens). */
  readonly port: number;
  readonly addresses: readonly string[];
}

const text = (value: unknown): string =>
  value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);

/** rowrow servers' advertisements in the responses to a query for _rowrow._tcp; goodbyes (TTL 0) take one back. */
export function advertisementsIn(packets: readonly Packet[]): Advertisement[] {
  const records: Heard[] = packets.flatMap((packet) => [
    ...(packet.answers ?? []),
    ...(packet.additionals ?? []),
  ]);
  const named = (name: string, type: string): Heard[] =>
    records.filter((record) => record.type === type && record.name.toLowerCase() === name.toLowerCase());
  const instances = new Set<string>();
  for (const record of named(MDNS_TYPE, "PTR")) {
    const instance = text(record.data);
    if (record.ttl === 0) instances.delete(instance);
    else instances.add(instance);
  }
  const found: Advertisement[] = [];
  for (const instance of instances) {
    const srv = named(instance, "SRV").at(-1);
    const txt = named(instance, "TXT").at(-1);
    if (srv === undefined || txt === undefined || srv.ttl === 0) continue;
    const { port, target } = srv.data as { port: number; target: string };
    const entries = (Array.isArray(txt.data) ? txt.data : [txt.data]).map(text);
    const advertised = readAdvertisedTxt(entries);
    if (advertised === null) continue;
    const addresses = [...new Set(named(target, "A").map((record) => text(record.data)))];
    found.push({ advertised, port, addresses });
  }
  return found;
}

/** One of this Mac's own IPv4 addresses, with its netmask. */
export interface LocalAddress {
  readonly address: string;
  readonly netmask: string;
}

/** Which of a server's addresses to use: one on a network this Mac is on, else its first LAN address. */
export function pickAddress(addresses: readonly string[], local: readonly LocalAddress[]): string | null {
  const lan = addresses.filter(isLanAddress);
  return (
    lan.find((address) => local.some((own) => sameSubnet(address, own.address, own.netmask))) ??
    lan[0] ??
    null
  );
}

/** The tailnet's machines worth asking: online, not this Mac, not a phone or a TV (rowrow doesn't run there). */
export function tailnetCandidates(tailnet: Tailnet): { name: string; host: string }[] {
  return tailnet.peers
    .filter((peer) => peer.online && !/^(ios|android|tvos)$/i.test(peer.os))
    .map((peer) => ({ name: peer.name, host: peer.dnsName ?? peer.ips[0] ?? "" }))
    .filter((peer) => peer.host !== "")
    .slice(0, 100);
}

/** An origin from what someone typed: devbox, 192.168.1.5:7373, http://devbox:7373, https://devbox.ts.net. */
export function parseAddress(input: string, port = DEFAULT_PORT): string | null {
  const value = input.trim().replace(/\/+$/, "");
  if (value === "" || /\s/.test(value)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
    // No scheme and no port: rowrow's own port. A scheme without one: that scheme's (tailscale serve's 443).
    if (url.port === "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) url.port = String(port);
    return url.origin;
  } catch {
    return null;
  }
}

const hostUrl = (host: string, port: number): string =>
  `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

/** What `discover` needs of the world. */
export interface DiscoverDeps {
  /** Responses to a query for _rowrow._tcp, heard for a few seconds. */
  browse(): Promise<readonly Packet[]>;
  /** `tailscale status --json` on this Mac, or null. */
  tailnet(): Promise<Tailnet | null>;
  /** GET /healthz at an origin, or null when nothing (or nothing like rowrow) answers soon. */
  health(origin: string): Promise<Health | null>;
  readonly local: readonly LocalAddress[];
  /** The port rowrow listens on, to ask tailnet machines at. */
  readonly port: number;
  /** The origins of the machines the app has, and its ids for them. */
  readonly known: ReadonlyMap<string, string>;
}

/** Everything found, one entry per server (over Tailscale when it's found both ways: it's encrypted), by name. */
export async function discover(deps: DiscoverDeps): Promise<NearbyMachine[]> {
  const [packets, tailnet] = await Promise.all([
    deps.browse().catch(() => []),
    deps.tailnet().catch(() => null),
  ]);
  const lan: NearbyMachine[] = [];
  for (const { advertised, port, addresses } of advertisementsIn(packets)) {
    // This Mac's own rowrow answers too: it's This Mac, not a machine to add.
    if (addresses.some((address) => deps.local.some((own) => own.address === address))) continue;
    const address = pickAddress(addresses, deps.local);
    if (address === null) continue;
    const url = hostUrl(address, port);
    const { id, name, version } = advertised;
    lan.push({ id, name, url, via: "lan", version, added: deps.known.get(url) ?? null });
  }
  const peers = tailnet === null ? [] : tailnetCandidates(tailnet);
  const tailscale = (
    await Promise.all(
      peers.map(async ({ name, host }): Promise<NearbyMachine | null> => {
        const url = hostUrl(host, deps.port);
        const health = await deps.health(url).catch(() => null);
        if (health === null) return null;
        return {
          id: health.id,
          name,
          url,
          via: "tailscale",
          version: health.version,
          added: deps.known.get(url) ?? null,
        };
      }),
    )
  ).filter((machine): machine is NearbyMachine => machine !== null);
  const all = [...tailscale, ...lan];
  return all
    .filter((machine, index) => {
      const first = all.findIndex((other) =>
        machine.id === "" ? other.url === machine.url : other.id === machine.id,
      );
      return first === index;
    })
    .map((machine) => {
      // Added at another of its addresses: the app has it all the same.
      if (machine.added !== null || machine.id === "") return machine;
      const twin = all.find((other) => other.id === machine.id && other.added !== null);
      return twin === undefined ? machine : { ...machine, added: twin.added };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── The network ─────────────────────────────────────────────────────────────

/** Ask for _rowrow._tcp on every interface and listen for `ms`; nothing (never an error) if multicast isn't possible. */
export function browseLan(ms = 2500): Promise<Packet[]> {
  return new Promise((resolve) => {
    const packets: Packet[] = [];
    let mdns: ReturnType<typeof multicastDns>;
    try {
      mdns = multicastDns();
    } catch {
      resolve([]);
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(again);
      clearTimeout(timer);
      mdns.destroy();
      resolve(packets);
    };
    mdns.on("error", finish);
    mdns.on("warning", () => undefined);
    mdns.on("response", (packet: multicastDns.ResponsePacket) => packets.push(packet));
    const ask = (): void => mdns.query({ questions: [{ name: MDNS_TYPE, type: "PTR" }] });
    ask();
    // Asked twice: one packet lost on Wi-Fi shouldn't hide a machine.
    const again = setTimeout(ask, 1000);
    const timer = setTimeout(finish, ms);
  });
}

/** `tailscale status --json` from the first of `commands` that answers. */
export async function tailnetStatus(commands: readonly string[], timeoutMs = 3000): Promise<Tailnet | null> {
  for (const command of commands) {
    const stdout = await new Promise<string | null>((resolve) =>
      execFile(
        command,
        ["status", "--json"],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, out) => resolve(error === null || out !== "" ? out : null),
      ),
    );
    if (stdout === null) continue;
    try {
      return parseTailscaleStatus(JSON.parse(stdout));
    } catch {
      return null;
    }
  }
  return null;
}

/** /healthz, with a short timeout: a tailnet machine without rowrow just doesn't answer on its port. */
export async function fetchHealth(
  origin: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<Health | null> {
  try {
    const response = await fetcher(`${origin}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? readHealth(await response.json()) : null;
  } catch {
    return null;
  }
}
