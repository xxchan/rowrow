// The server, advertised on the LAN while it listens beyond loopback (docs/decisions.md, D-060):
// DNS-SD over multicast DNS ("Bonjour"), service type _rowrow._tcp, so rowrow for Mac's Add a
// machine lists it without anyone typing an address. It says what a device needs to offer it
// (the machine's name, rowrow's version, the port, the server's id) and nothing else: finding a
// server signs nobody in, and every request still needs a device credential (D-009).
//
// A small responder of our own on multicast-dns rather than the system's (avahi isn't on every
// Linux, and a failure here must never take the server down): it answers queries for the
// service, its instance and its host name, announces itself when it starts, and says goodbye
// when it stops. The host name is the server's own (rowrow-srv-….local), so it never answers for
// the machine's.
import multicastDns from "multicast-dns";
import os from "node:os";
import { advertisedTxt, isPrivateAddress, MDNS_TYPE, type Advertised } from "../shared/reach.ts";
import { log, serializeError } from "./telemetry/log.ts";

type DnsRecord = NonNullable<multicastDns.ResponsePacket["answers"]>[number];
type Question = NonNullable<multicastDns.QueryPacket["questions"]>[number];

const SERVICES = "_services._dns-sd._udp.local";

export interface Names {
  /** devbox (rowrow abcd)._rowrow._tcp.local */
  readonly instance: string;
  /** rowrow-srv-….local */
  readonly host: string;
}

export function namesFor(advertised: Advertised): Names {
  // One DNS label each: no dots, at most 63 bytes.
  const label = `${advertised.name.replaceAll(".", "-").slice(0, 40)} (rowrow ${advertised.id.slice(-4)})`;
  return {
    instance: `${label}.${MDNS_TYPE}`,
    host: `rowrow-${advertised.id.replaceAll("_", "-")}.local`,
  };
}

/** Every record of the advertisement; `ttl` 0 says goodbye. */
export function serviceRecords(
  advertised: Advertised,
  addresses: readonly string[],
  ttl: { readonly long: number; readonly short: number } = { long: 4500, short: 120 },
): DnsRecord[] {
  const { instance, host } = namesFor(advertised);
  return [
    { name: MDNS_TYPE, type: "PTR", ttl: ttl.long, data: instance },
    {
      name: instance,
      type: "SRV",
      ttl: ttl.short,
      flush: true,
      data: { port: advertised.port, target: host },
    },
    { name: instance, type: "TXT", ttl: ttl.long, flush: true, data: advertisedTxt(advertised) },
    ...addresses.map((address): DnsRecord => ({
      name: host,
      type: "A",
      ttl: ttl.short,
      flush: true,
      data: address,
    })),
    { name: SERVICES, type: "PTR", ttl: ttl.long, data: MDNS_TYPE },
  ];
}

/** What to send back for one question: the records it asks for, and the ones a browser needs next. */
export function answer(
  question: Question,
  records: readonly DnsRecord[],
): { answers: DnsRecord[]; additionals: DnsRecord[] } {
  const name = question.name.toLowerCase();
  // dns-packet decodes type 255 as "ANY", which its types leave out.
  const type: string = question.type;
  const asked = (record: DnsRecord): boolean =>
    record.name.toLowerCase() === name && (type === "ANY" || record.type === type);
  const answers = records.filter(asked);
  if (answers.length === 0) return { answers, additionals: [] };
  const service = answers.some((record) => record.type === "PTR" && record.name === MDNS_TYPE);
  const additionals = records.filter(
    (record) =>
      !answers.includes(record) &&
      record.name !== SERVICES &&
      (service || (record.type === "A" && answers.some((a) => a.type === "SRV"))),
  );
  return { answers, additionals };
}

/** This machine's addresses a device on its LANs could use (IPv4: what browsers here are given). */
function localAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4")
    .map((entry) => entry?.address ?? "")
    .filter(isPrivateAddress);
}

export interface Advertisement {
  stop(): Promise<void>;
}

/** Start answering for this server on every interface's multicast group; it never throws. */
export function advertise(advertised: Advertised): Advertisement {
  let mdns: ReturnType<typeof multicastDns>;
  try {
    mdns = multicastDns();
  } catch (error) {
    log.warn("advertise.failed", { err: serializeError(error) });
    return { stop: async () => undefined };
  }
  let stopped = false;
  // Port 5353 taken by a responder that doesn't share it, or no multicast route: no advertisement.
  mdns.on("error", (error: Error) => {
    log.warn("advertise.failed", { err: serializeError(error) });
    stopped = true;
    mdns.destroy();
  });
  mdns.on("warning", () => undefined);
  const records = (): DnsRecord[] => serviceRecords(advertised, localAddresses());
  mdns.on("query", (query: multicastDns.QueryPacket) => {
    if (stopped) return;
    const all = records();
    for (const question of query.questions ?? []) {
      const reply = answer(question, all);
      if (reply.answers.length > 0) mdns.respond(reply);
    }
  });
  // Announced twice, a second apart (RFC 6762, 8.3), so browsers already looking see it at once.
  const announce = (): void => {
    if (!stopped) mdns.respond({ answers: records() });
  };
  announce();
  const again = setTimeout(announce, 1000);
  again.unref();
  log.info("advertise.started", { type: MDNS_TYPE, port: advertised.port, ...namesFor(advertised) });
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        clearTimeout(again);
        if (stopped) return resolve();
        // Shutting down never waits on the network for long.
        setTimeout(resolve, 1000).unref();
        stopped = true;
        const goodbye = serviceRecords(advertised, localAddresses(), { long: 0, short: 0 });
        mdns.respond({ answers: goodbye }, () => mdns.destroy(() => resolve()));
      }),
  };
}
