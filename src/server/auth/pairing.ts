// Pairing codes (docs/decisions.md, D-060): a short code you read on one machine and type on
// the device you sign in (rowrow for Mac's Add a machine, a browser's sign-in page), instead of
// a link you'd have to carry over. `rowrow up` prints one; `POST /auth/pair` trades it for a
// device credential, exactly as a one-time link would (D-009).
//
// A code is 8 characters from 31 without look-alikes (no 0 and O, no 1, I and L), shown as
// ABCD-EFGH: about 8.5 × 10^11 codes. A link's code can't be guessed (144 bits); this one could
// be, at network speed, so it's limited hard:
//
// - one code at a time: a new one replaces the last; it works once, for 10 minutes;
// - 5 wrong tries end it (a typo costs a try; a guesser gets 5 per code);
// - past 20 wrong tries in 10 minutes the server takes no code at all, right or wrong, until
//   they age out. Tries while it refuses count too, so someone who keeps guessing gets no more
//   checked. That caps guessing at about 3,000 tries a day, under one chance in 10^8 a day.
//
// The price: someone on your network can keep codes from working while they keep trying. Links
// (`rowrow pair`, Sign in another device) still work then, and so does SSH.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { log } from "../telemetry/log.ts";

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60_000;
export const TRIES_PER_CODE = 5;
export const THROTTLE_TRIES = 20;
export const THROTTLE_WINDOW_MS = 10 * 60_000;

/** A fresh code, as people read it: ABCD-EFGH. */
export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What someone typed, as the code it means (any case, with or without the dash and spaces), or null. */
export function normalizeCode(input: string): string | null {
  const code = input.replace(/[\s-]+/g, "").toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const char of code) if (!CODE_ALPHABET.includes(char)) return null;
  return code;
}

export type PairingOutcome =
  | { readonly ok: true; readonly name: string | null }
  /** Too many wrong tries lately: no code is checked until `retryAfterMs` passes. */
  | { readonly ok: false; readonly reason: "throttled"; readonly retryAfterMs: number }
  /** Mistyped, used, expired, ended by wrong tries, or none made: the person is told the same. */
  | { readonly ok: false; readonly reason: "wrong" | "expired" | "none" | "malformed" };

interface Live {
  readonly hash: Buffer;
  readonly name: string | null;
  readonly expiresAt: number;
  wrong: number;
}

export class PairingCodes {
  private readonly now: () => number;
  private live: Live | null = null;
  /** When the last THROTTLE_TRIES wrong tries came, oldest first. */
  private failures: number[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** A new code, replacing any other; `name` names the device it signs in (else the device's own). */
  create(name?: string): { code: string; expiresAt: number } {
    const code = newPairingCode();
    const expiresAt = this.now() + CODE_TTL_MS;
    this.live = { hash: hash(normalizeCode(code) ?? ""), name: name ?? null, expiresAt, wrong: 0 };
    log.info("auth.pairing.created", { expiresAt });
    return { code, expiresAt };
  }

  redeem(input: string): PairingOutcome {
    const now = this.now();
    const oldest = this.failures[0];
    if (this.failures.length >= THROTTLE_TRIES && oldest !== undefined && now - oldest < THROTTLE_WINDOW_MS) {
      this.fail(now);
      const retryAfterMs = (this.failures[0] ?? now) + THROTTLE_WINDOW_MS - now;
      log.warn("auth.pairing.throttled", { retryAfterMs });
      return { ok: false, reason: "throttled", retryAfterMs };
    }
    const code = normalizeCode(input);
    const live = this.live;
    const reason =
      code === null
        ? "malformed"
        : live === null
          ? "none"
          : live.expiresAt <= now
            ? "expired"
            : timingSafeEqual(live.hash, hash(code))
              ? null
              : "wrong";
    if (reason === null && live !== null) {
      this.live = null;
      log.info("auth.pairing.redeemed", {});
      return { ok: true, name: live.name };
    }
    this.fail(now);
    if (live !== null && reason === "expired") this.live = null;
    if (live !== null && reason !== "expired" && reason !== "none") {
      live.wrong += 1;
      if (live.wrong >= TRIES_PER_CODE) {
        this.live = null;
        log.warn("auth.pairing.ended", { wrong: live.wrong });
      }
    }
    log.warn("auth.pairing.rejected", { reason, wrong: live?.wrong ?? null });
    return { ok: false, reason: reason ?? "wrong" };
  }

  private fail(now: number): void {
    this.failures.push(now);
    if (this.failures.length > THROTTLE_TRIES) this.failures = this.failures.slice(-THROTTLE_TRIES);
  }
}

function hash(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}
