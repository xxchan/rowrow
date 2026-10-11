// Pairing codes (D-060): short enough to type, so limited hard. The clock is the test's.
import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  CODE_TTL_MS,
  newPairingCode,
  normalizeCode,
  PairingCodes,
  THROTTLE_TRIES,
  THROTTLE_WINDOW_MS,
  TRIES_PER_CODE,
} from "../src/server/auth/pairing.ts";

function codes(start = 1_000_000): { codes: PairingCodes; advance(ms: number): void } {
  let now = start;
  return { codes: new PairingCodes(() => now), advance: (ms) => (now += ms) };
}

/** A well-formed code that isn't `code`. */
function other(code: string): string {
  const plain = normalizeCode(code) ?? "";
  return `${plain.slice(0, 7)}${plain[7] === "A" ? "B" : "A"}`;
}

describe("pairing codes", () => {
  it("are 8 characters without look-alikes, shown in two groups", () => {
    expect(CODE_ALPHABET).not.toMatch(/[01ILO]/);
    for (let i = 0; i < 200; i++) {
      const code = newPairingCode();
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    }
  });

  it("are read in any case, with or without the dash and spaces", () => {
    expect(normalizeCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    expect(normalizeCode("ABCDEFGH")).toBe("ABCDEFGH");
    expect(normalizeCode("ABCD-EFG")).toBeNull();
    expect(normalizeCode("ABCD-EFG0")).toBeNull();
  });

  it("sign one device in, once, with the name given when it was made", () => {
    const { codes: pairing } = codes();
    const { code } = pairing.create("Ada's phone");
    expect(pairing.redeem(code.toLowerCase())).toEqual({ ok: true, name: "Ada's phone" });
    expect(pairing.redeem(code)).toEqual({ ok: false, reason: "none" });
  });

  it("expire after 10 minutes", () => {
    const { codes: pairing, advance } = codes();
    const first = pairing.create();
    advance(CODE_TTL_MS - 1);
    expect(pairing.redeem(first.code)).toEqual({ ok: true, name: null });
    const second = pairing.create();
    advance(CODE_TTL_MS);
    expect(pairing.redeem(second.code)).toEqual({ ok: false, reason: "expired" });
  });

  it("are replaced by a newer one", () => {
    const { codes: pairing } = codes();
    const first = pairing.create();
    const second = pairing.create();
    expect(pairing.redeem(first.code)).toEqual({ ok: false, reason: "wrong" });
    expect(pairing.redeem(second.code)).toEqual({ ok: true, name: null });
  });

  it(`end after ${TRIES_PER_CODE} wrong tries, even if the right one comes next`, () => {
    const { codes: pairing } = codes();
    const { code } = pairing.create();
    for (let i = 0; i < TRIES_PER_CODE; i++)
      expect(pairing.redeem(other(code))).toEqual({ ok: false, reason: "wrong" });
    expect(pairing.redeem(code)).toEqual({ ok: false, reason: "none" });
    // A typo costs a try, not the code: four wrong ones and the right one still work.
    const next = pairing.create();
    for (let i = 0; i < TRIES_PER_CODE - 1; i++) pairing.redeem(other(next.code));
    expect(pairing.redeem(next.code)).toEqual({ ok: true, name: null });
  });

  it(`take none at all past ${THROTTLE_TRIES} wrong tries in 10 minutes, until they age out`, () => {
    const { codes: pairing, advance } = codes();
    for (let i = 0; i < THROTTLE_TRIES; i++) {
      pairing.redeem("ZZZZ-ZZZZ");
      advance(1000);
    }
    const { code } = pairing.create();
    const refused = pairing.redeem(code);
    expect(refused).toMatchObject({ ok: false, reason: "throttled" });
    expect(!refused.ok && refused.reason === "throttled" ? refused.retryAfterMs : 0).toBeGreaterThan(0);
    // Tries while it refuses count too: someone who keeps guessing (faster than that) gets nothing checked.
    for (let i = 0; i < 40; i++) {
      advance(THROTTLE_WINDOW_MS / (2 * THROTTLE_TRIES));
      expect(pairing.redeem(code)).toMatchObject({ reason: "throttled" });
    }
    advance(THROTTLE_WINDOW_MS);
    const fresh = pairing.create();
    expect(pairing.redeem(fresh.code)).toEqual({ ok: true, name: null });
  });

  it("count a malformed code as a wrong try", () => {
    const { codes: pairing } = codes();
    const { code } = pairing.create();
    for (let i = 0; i < TRIES_PER_CODE; i++)
      expect(pairing.redeem("nope")).toEqual({ ok: false, reason: "malformed" });
    expect(pairing.redeem(code)).toEqual({ ok: false, reason: "none" });
  });
});
