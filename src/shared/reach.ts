// Where a machine's rowrow can be reached from your other devices, and how they find it
// (docs/decisions.md, D-060). Pure, so the server (`--host private`, its sign-in links), the
// CLI (`rowrow up`) and the Mac app's discovery read the same rules, and tests cover them.

/**
 * `--host private`: listen on every interface, but take connections only from private networks
 * (isPrivateAddress): your LAN, Tailscale, loopback. Never from the public internet, even on a
 * machine with a public address and no firewall.
 */
export const PRIVATE_HOST = "private";

/** Whether a server listening on `host` (--host) is on every interface, so every address of the machine reaches it. */
export function listensEverywhere(host: string): boolean {
  return host === PRIVATE_HOST || host === "0.0.0.0" || host === "::";
}

/** The server's own port unless you give another (src/server/config.ts says the same). */
export const DEFAULT_PORT = 7373;

function ipv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

function inV4(address: number, network: string, bits: number): boolean {
  const base = ipv4(network) ?? 0;
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(base / size);
}

/** 10/8, 172.16/12, 192.168/16: a home or office network. */
function isLanV4(address: number): boolean {
  return inV4(address, "10.0.0.0", 8) || inV4(address, "172.16.0.0", 12) || inV4(address, "192.168.0.0", 16);
}

/** An IPv4 address of a home or office network (not loopback, link-local or Tailscale's). */
export function isLanAddress(address: string): boolean {
  const v4 = ipv4(address);
  return v4 !== null && isLanV4(v4);
}

/** Whether two IPv4 addresses are on one network, by `netmask` (255.255.255.0). */
export function sameSubnet(a: string, b: string, netmask: string): boolean {
  const [x, y, mask] = [ipv4(a), ipv4(b), ipv4(netmask)];
  if (x === null || y === null || mask === null || mask === 0) return false;
  // Bitwise operators work on 32-bit signed integers: compare each octet instead.
  for (let shift = 24; shift >= 0; shift -= 8) {
    const m = Math.floor(mask / 2 ** shift) % 256;
    if (((Math.floor(x / 2 ** shift) % 256) & m) !== ((Math.floor(y / 2 ** shift) % 256) & m)) return false;
  }
  return true;
}

/** 100.64/10: Tailscale's addresses (and carrier-grade NAT's). */
function isTailscaleV4(address: number): boolean {
  return inV4(address, "100.64.0.0", 10);
}

/**
 * Whether a connection from this address comes from a network of yours: loopback, a LAN
 * (RFC 1918, IPv6 unique-local), link-local, or 100.64.0.0/10, which is Tailscale's (and
 * carrier-grade NAT's: other customers of the same carrier, which we accept as "the network
 * you're on"). Tailscale's IPv6 addresses are unique-local.
 */
export function isPrivateAddress(address: string): boolean {
  let ip = address.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice("::ffff:".length);
  const v4 = ipv4(ip);
  if (v4 !== null)
    return inV4(v4, "127.0.0.0", 8) || isLanV4(v4) || inV4(v4, "169.254.0.0", 16) || isTailscaleV4(v4);
  ip = ip.replace(/%.*$/, "");
  if (ip === "::1") return true;
  if (!/^[0-9a-f:]+$/.test(ip) || ip.startsWith(":")) return false;
  const first = Number.parseInt(ip.split(":")[0] ?? "", 16);
  if (Number.isNaN(first)) return false;
  // fc00::/7 (unique-local, Tailscale's fd7a:115c:a1e0::/48 among them) and fe80::/10 (link-local).
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

// ─── Tailscale ───────────────────────────────────────────────────────────────

/**
 * Where the Tailscale CLI is: on the PATH, inside Tailscale's Mac app (both of its variants), or
 * Homebrew's (an app's PATH has neither).
 */
export const TAILSCALE_COMMANDS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

export interface TailnetNode {
  /** The machine's name in the tailnet. */
  readonly name: string;
  /** Its MagicDNS name (devbox.tail1234.ts.net), when MagicDNS is on. */
  readonly dnsName: string | null;
  /** Its Tailscale addresses, IPv4 first. */
  readonly ips: readonly string[];
  readonly online: boolean;
  /** linux, macOS, windows, iOS, android… */
  readonly os: string;
}

export interface Tailnet {
  readonly self: TailnetNode;
  readonly peers: readonly TailnetNode[];
}

/** `tailscale status --json`, when Tailscale is up; null when it isn't (stopped, logged out) or the JSON isn't its. */
export function parseTailscaleStatus(json: unknown): Tailnet | null {
  if (typeof json !== "object" || json === null) return null;
  const status = json as Record<string, unknown>;
  if (status["BackendState"] !== "Running") return null;
  const tailnet = status["CurrentTailnet"] as Record<string, unknown> | null | undefined;
  // Without MagicDNS the names don't resolve: addresses only.
  const magicDns = tailnet?.["MagicDNSEnabled"] !== false;
  const node = (value: unknown): TailnetNode | null => {
    if (typeof value !== "object" || value === null) return null;
    const fields = value as Record<string, unknown>;
    const ips = Array.isArray(fields["TailscaleIPs"])
      ? fields["TailscaleIPs"].filter((ip): ip is string => typeof ip === "string")
      : [];
    if (ips.length === 0) return null;
    const dns = typeof fields["DNSName"] === "string" ? fields["DNSName"].replace(/\.$/, "") : "";
    const hostName = typeof fields["HostName"] === "string" ? fields["HostName"] : "";
    return {
      name: hostName || dns.split(".")[0] || (ips[0] ?? ""),
      dnsName: magicDns && dns !== "" ? dns : null,
      ips: [...ips].sort((a, b) => Number(ipv4(b) !== null) - Number(ipv4(a) !== null)),
      online: fields["Online"] !== false,
      os: typeof fields["OS"] === "string" ? fields["OS"] : "",
    };
  };
  const self = node(status["Self"]);
  if (self === null) return null;
  const peers = Object.values(
    typeof status["Peer"] === "object" && status["Peer"] !== null ? status["Peer"] : {},
  )
    .map(node)
    .filter((peer): peer is TailnetNode => peer !== null);
  return { self, peers };
}

// ─── Addresses ───────────────────────────────────────────────────────────────

export interface Address {
  readonly url: string;
  /** tailscale: over your tailnet; lan: over the network this machine is on; configured: --public-url. */
  readonly via: "tailscale" | "lan" | "configured";
  /** Nobody between the two devices can read it: HTTPS, or Tailscale (WireGuard). */
  readonly encrypted: boolean;
}

/** One address of a network interface, as os.networkInterfaces() lists it. */
export interface InterfaceAddress {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}

/** Interfaces of containers and virtual machines on this machine, and VPN tunnels (Tailscale's among them). */
const VIRTUAL =
  /^(docker|br-|veth|virbr|vboxnet|vmnet|cni|flannel|cali|podman|lxc|lxd|kube|bridge|utun|tailscale)/;

/**
 * Where your other devices can reach a server on this machine listening on `port`: its
 * Tailscale name and address first (encrypted end to end), then its LAN addresses (plain HTTP
 * unless the server has TLS: the network can read it). Container bridges and the like are left
 * out, as are public addresses (`--host private` refuses them anyway).
 */
export function reachableAddresses(input: {
  readonly port: number;
  readonly https: boolean;
  readonly interfaces: Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;
  readonly tailnet: Tailnet | null;
}): Address[] {
  const scheme = input.https ? "https" : "http";
  const url = (host: string): string =>
    `${scheme}://${host.includes(":") ? `[${host}]` : host}:${input.port}`;
  const found: Address[] = [];
  if (input.tailnet !== null) {
    const { self } = input.tailnet;
    for (const host of [self.dnsName, ...self.ips.filter((ip) => ipv4(ip) !== null)])
      if (host !== null) found.push({ url: url(host), via: "tailscale", encrypted: true });
  }
  for (const [name, addresses] of Object.entries(input.interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const entry of addresses ?? []) {
      const v4 = ipv4(entry.address);
      if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4) || v4 === null) continue;
      if (!isLanV4(v4)) continue;
      found.push({ url: url(entry.address), via: "lan", encrypted: input.https });
    }
  }
  return found.filter((address, index) => found.findIndex((other) => other.url === address.url) === index);
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/** The DNS-SD service type a server advertises on the LAN (mDNS, "Bonjour") while it listens beyond loopback. */
export const MDNS_TYPE = "_rowrow._tcp.local";

/** What a server says about itself in its advertisement's TXT record, and at /healthz (`id`, `version`). */
export interface Advertised {
  /** The server's own id (srv_…), so a machine found both on the LAN and over Tailscale is listed once. */
  readonly id: string;
  /** The machine's name. */
  readonly name: string;
  readonly version: string;
  readonly port: number;
}

export function advertisedTxt(advertised: Advertised): string[] {
  return [
    `id=${advertised.id}`,
    `name=${advertised.name}`,
    `version=${advertised.version}`,
    `port=${advertised.port}`,
  ];
}

/** A TXT record's key=value strings back; null unless it's a rowrow server's (id, name, version). */
export function readAdvertisedTxt(entries: readonly string[]): Advertised | null {
  const fields = new Map<string, string>();
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at > 0) fields.set(entry.slice(0, at).toLowerCase(), entry.slice(at + 1));
  }
  const id = fields.get("id") ?? "";
  const name = fields.get("name") ?? "";
  const version = fields.get("version") ?? "";
  const port = Number(fields.get("port"));
  if (!/^srv_[0-9a-z]{4,40}$/.test(id) || name === "" || version === "") return null;
  return {
    id,
    name: name.slice(0, 100),
    version: version.slice(0, 40),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
  };
}

/** GET /healthz: no credential needed, so it says only that this is rowrow, which one, and its version. */
export interface Health {
  readonly ok: true;
  readonly version: string;
  readonly id: string;
}

export function readHealth(body: unknown): Health | null {
  if (typeof body !== "object" || body === null) return null;
  const fields = body as Record<string, unknown>;
  if (fields["ok"] !== true || typeof fields["version"] !== "string") return null;
  // A server from before D-060 has no id: still rowrow, found once per address.
  return { ok: true, version: fields["version"], id: typeof fields["id"] === "string" ? fields["id"] : "" };
}
