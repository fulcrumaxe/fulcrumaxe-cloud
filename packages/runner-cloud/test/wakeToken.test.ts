import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WAKE_POLL_SECONDS_DEFAULT, WAKE_TOKEN_LIFETIME_SECONDS, WakeGrant } from "@fulcrumaxe/runner-protocol";
import { WAKE_KEY_MIN_BYTES, configuredWakeKey, mintWakeToken, readWakeKey, verifyWakeToken, wakeGrantFor } from "../src/index.js";
import type { WakeRunner } from "../src/index.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-10-23T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const b43 = (): string => randomBytes(32).toString("base64url");

/** What `verifyRunnerRequest` returns, with random ids. Only its fields are read here. */
const runner = (over: Partial<WakeRunner> = {}): WakeRunner => ({ runnerId: randomUUID(), accountId: randomUUID(), jkt: b43(), publicKeyX: b43(), ...over });

const decode = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
/** Re-signs a changed payload with a key: what someone holding that key could build. */
const forge = (key: Buffer, payload: unknown): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
};

/** D#6 RUNNER-WAKE R3a: minting and checking the wake token, with no database. */
describe("the wake key", () => {
  it("is read from FX_RUNNER_WAKE_KEY; missing or under 32 bytes is no key", () => {
    expect(readWakeKey({})).toBeNull();
    expect(readWakeKey({ FX_RUNNER_WAKE_KEY: "" })).toBeNull();
    expect(readWakeKey({ FX_RUNNER_WAKE_KEY: "k".repeat(WAKE_KEY_MIN_BYTES - 1) })).toBeNull();
    expect(readWakeKey({ FX_RUNNER_WAKE_KEY: "k".repeat(WAKE_KEY_MIN_BYTES) })?.byteLength).toBe(32);
  });

  it("a key reader that is absent, returns null or a short key, or throws, gives no key and does not throw", () => {
    expect(configuredWakeKey(undefined)).toBeNull();
    expect(configuredWakeKey(null)).toBeNull();
    expect(configuredWakeKey(() => null)).toBeNull();
    expect(configuredWakeKey(() => Buffer.alloc(8))).toBeNull();
    expect(configuredWakeKey(() => {
      throw new Error("boom");
    })).toBeNull();
    expect(configuredWakeKey(() => KEY)).toBe(KEY);
  });
});

describe("the token", () => {
  it("carries the runner, its account, its key and an expiry 24 hours on, and verifies back to the same payload", () => {
    const r = runner();
    const token = mintWakeToken(KEY, r, NOW);
    const payload = { v: 1, rid: r.runnerId, acct: r.accountId, jkt: r.jkt, jwk_x: r.publicKeyX, exp: NOW_S + WAKE_TOKEN_LIFETIME_SECONDS };
    expect(decode(token)).toEqual(payload);
    expect(verifyWakeToken(KEY, token, NOW)).toEqual(payload);
  });

  it("expires: valid one second before exp, refused at exp and after", () => {
    const token = mintWakeToken(KEY, runner(), NOW);
    const at = (s: number) => new Date((NOW_S + s) * 1000);
    expect(verifyWakeToken(KEY, token, at(WAKE_TOKEN_LIFETIME_SECONDS - 1))).not.toBeNull();
    expect(verifyWakeToken(KEY, token, at(WAKE_TOKEN_LIFETIME_SECONDS))).toBeNull();
    expect(verifyWakeToken(KEY, token, at(WAKE_TOKEN_LIFETIME_SECONDS + 3600))).toBeNull();
  });

  it("is bound to its runner and account: moving it to another runner or account, or stretching exp, breaks the MAC (random ids)", () => {
    for (let i = 0; i < 200; i++) {
      const r = runner();
      const token = mintWakeToken(KEY, r, NOW);
      const [, mac] = token.split(".");
      const payload = decode(token);
      for (const changed of [{ ...payload, acct: randomUUID() }, { ...payload, rid: randomUUID() }, { ...payload, jkt: b43() }, { ...payload, jwk_x: b43() }, { ...payload, exp: (payload.exp as number) + 1 }]) {
        const body = Buffer.from(JSON.stringify(changed)).toString("base64url");
        expect(verifyWakeToken(KEY, `${body}.${mac}`, NOW)).toBeNull();
      }
      const ok = verifyWakeToken(KEY, token, NOW)!;
      expect(ok.rid).toBe(r.runnerId);
      expect(ok.acct).toBe(r.accountId);
      // Two runners never share a token.
      expect(mintWakeToken(KEY, runner({ accountId: r.accountId }), NOW)).not.toBe(token);
    }
  });

  it("is refused under another key, when tampered, truncated or malformed, and when a payload the key did sign is not the strict shape", () => {
    const r = runner();
    const token = mintWakeToken(KEY, r, NOW);
    const [body, mac] = token.split(".") as [string, string];
    expect(verifyWakeToken(randomBytes(32), token, NOW)).toBeNull();
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [`${flip(body)}.${mac}`, `${body}.${flip(mac)}`, `${body}.${mac.slice(0, 42)}`, body, `${body}.${mac}.x`, "", "..", `${body}.${mac}=`]) {
      expect(verifyWakeToken(KEY, bad, NOW), bad.slice(0, 20)).toBeNull();
    }
    const good = decode(token);
    for (const payload of [{ ...good, v: 2 }, { ...good, extra: 1 }, { ...good, poll_s: 20 }, { ...good, rid: "x" }, "not an object", [1]]) {
      expect(verifyWakeToken(KEY, forge(KEY, payload), NOW), JSON.stringify(payload)).toBeNull();
    }
    expect(verifyWakeToken(KEY, forge(KEY, good), NOW)).toEqual(good);
  });

  it("is never minted or checked with a short key", () => {
    expect(() => mintWakeToken(Buffer.alloc(16), runner(), NOW)).toThrow();
    expect(verifyWakeToken(Buffer.alloc(16), mintWakeToken(KEY, runner(), NOW), NOW)).toBeNull();
  });
});

describe("the grant", () => {
  it("is minted only when the runner listed wake_v1 AND a key is configured", () => {
    const r = runner();
    expect(wakeGrantFor(KEY, r, undefined, NOW)).toBeUndefined();
    expect(wakeGrantFor(KEY, r, null, NOW)).toBeUndefined();
    expect(wakeGrantFor(KEY, r, [], NOW)).toBeUndefined();
    expect(wakeGrantFor(KEY, r, ["proposal_verifier"], NOW)).toBeUndefined();
    expect(wakeGrantFor(null, r, ["wake_v1"], NOW)).toBeUndefined();
    const grant = wakeGrantFor(KEY, r, ["proposal_verifier", "wake_v1"], NOW)!;
    expect(WakeGrant.parse(grant)).toEqual(grant);
    expect(grant).toMatchObject({ poll_s: WAKE_POLL_SECONDS_DEFAULT, transport: "poll" });
    expect(verifyWakeToken(KEY, grant.token, NOW)).toMatchObject({ rid: r.runnerId, acct: r.accountId });
  });

  it("carries the poll interval the cloud chose", () => {
    expect(wakeGrantFor(KEY, runner(), ["wake_v1"], NOW, 45)?.poll_s).toBe(45);
    expect(() => wakeGrantFor(KEY, runner(), ["wake_v1"], NOW, 1)).toThrow();
  });
});
