import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEVICE_POLL_PATH,
  DEVICE_START_PATH,
  DEVICE_USER_CODE_ALPHABET,
  DeviceApproveBody,
  DeviceCode,
  DeviceFacts,
  DeviceLookupBody,
  DevicePollMessage,
  DevicePollResponse,
  DeviceStartMessage,
  DeviceStartResponse,
  DeviceUserCode,
  signDevicePop,
  verifyDevicePop,
} from "../src/index.js";

const origin = "https://cloud.example.test";
const now = 1_900_000_000;
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, jwk: publicKey.export({ format: "jwk" }) as { x: string } };
};
const facts = { hostname: "box-1", os: "linux", arch: "x64", kvm: true };
const start = (k = pair()) => ({ public_key_jwk: { kty: "OKP", crv: "Ed25519", x: k.jwk.x }, pop: signDevicePop(k.privateKey, { origin, path: DEVICE_START_PATH, iat: now }), facts });

/** Every shape refuses a key it does not name, at any depth. */
describe("device-flow shapes (strict at every depth)", () => {
  it("parses a start message, and refuses an extra key at the top, in the key and in the facts", () => {
    const ok = start();
    expect(DeviceStartMessage.safeParse(ok).success).toBe(true);
    expect(DeviceStartMessage.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(DeviceStartMessage.safeParse({ ...ok, public_key_jwk: { ...ok.public_key_jwk, d: "x" } }).success).toBe(false);
    expect(DeviceStartMessage.safeParse({ ...ok, facts: { ...facts, ip_country: "DE" } }).success).toBe(false);
    expect(DeviceStartMessage.safeParse({ ...ok, pop: "x".repeat(601) }).success).toBe(false);
    expect(DeviceFacts.safeParse({ ...facts, kvm: "true" }).success).toBe(false);
    expect(DeviceFacts.safeParse({ os: "linux", arch: "x64" }).success).toBe(false);
  });

  it("the user code is eight consonants from the twenty, with one hyphen: no vowel, no digit, no lower case", () => {
    expect(DeviceUserCode.safeParse("BCDF-GHJK").success).toBe(true);
    expect(DEVICE_USER_CODE_ALPHABET).toHaveLength(20);
    for (const vowel of "AEIOU") expect(DEVICE_USER_CODE_ALPHABET).not.toContain(vowel);
    for (const bad of ["ABCD-FGHJ", "BCDF-GHJ1", "BCDF-GHJ0", "bcdf-ghjk", "BCDFGHJK", "BCDF-GHJ", "BCDF-GHJKL", "BCDF GHJK", "BCDF-GHJK "]) {
      expect(DeviceUserCode.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("the device code is fxrd_ and 43 letters or digits", () => {
    expect(DeviceCode.safeParse(`fxrd_${"aZ09".repeat(10)}abc`).success).toBe(true);
    for (const bad of [`fxrd_${"a".repeat(42)}`, `fxrd_${"a".repeat(44)}`, `fxrr_${"a".repeat(43)}`, `fxrd_${"a".repeat(42)}-`]) expect(DeviceCode.safeParse(bad).success, bad).toBe(false);
  });

  it("the start reply, the poll message and the poll reply are closed", () => {
    const reply = { device_code: `fxrd_${"a".repeat(43)}`, user_code: "BCDF-GHJK", verification_uri: `${origin}/link`, expires_at: new Date(now * 1000).toISOString(), interval_s: 5 };
    expect(DeviceStartResponse.safeParse(reply).success).toBe(true);
    expect(DeviceStartResponse.safeParse({ ...reply, interval_s: 6 }).success).toBe(false);
    expect(DeviceStartResponse.safeParse({ ...reply, extra: 1 }).success).toBe(false);
    expect(DevicePollMessage.safeParse({ device_code: reply.device_code }).success).toBe(true);
    expect(DevicePollMessage.safeParse({ device_code: reply.device_code, extra: 1 }).success).toBe(false);
    const registration = { runner_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", account_id: "1f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", credential_mode: "subscription" };
    expect(DevicePollResponse.safeParse({ status: "pending" }).success).toBe(true);
    expect(DevicePollResponse.safeParse({ status: "approved", registration }).success).toBe(true);
    expect(DevicePollResponse.safeParse({ status: "approved", registration: { ...registration, extra: 1 } }).success).toBe(false);
    expect(DevicePollResponse.safeParse({ status: "pending", registration }).success).toBe(false);
  });

  it("the person's bodies are closed, and approval needs the literal true", () => {
    expect(DeviceLookupBody.safeParse({ user_code: "BCDF-GHJK" }).success).toBe(true);
    expect(DeviceLookupBody.safeParse({ user_code: "BCDF-GHJK", extra: 1 }).success).toBe(false);
    expect(DeviceApproveBody.safeParse({ user_code: "BCDF-GHJK", confirm: true, name: "Build box" }).success).toBe(true);
    for (const bad of [{ user_code: "BCDF-GHJK" }, { user_code: "BCDF-GHJK", confirm: false }, { user_code: "BCDF-GHJK", confirm: "true" }, { user_code: "BCDF-GHJK", confirm: true, name: "" }]) {
      expect(DeviceApproveBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the proof of the key", () => {
  const where = { origin, path: DEVICE_START_PATH };
  it("verifies for the key, the origin, the path and a time inside the skew, and for nothing else", () => {
    const k = pair();
    const pop = signDevicePop(k.privateKey, { ...where, iat: now });
    expect(verifyDevicePop(pop, k.jwk, where, now)).toBe(true);
    expect(verifyDevicePop(pop, k.jwk, where, now + 59)).toBe(true);
    expect(verifyDevicePop(pop, k.jwk, where, now + 61)).toBe(false);
    expect(verifyDevicePop(pop, k.jwk, where, now - 61)).toBe(false);
    expect(verifyDevicePop(pop, pair().jwk, where, now)).toBe(false);
    expect(verifyDevicePop(pop, k.jwk, { ...where, path: DEVICE_POLL_PATH }, now)).toBe(false);
    expect(verifyDevicePop(pop, k.jwk, { ...where, origin: "https://other.example.test" }, now)).toBe(false);
  });

  it("refuses a changed byte, another header, an extra claim, a non-integer time and anything that is not a compact JWS, and never throws", () => {
    const k = pair();
    const pop = signDevicePop(k.privateKey, { ...where, iat: now });
    const [h, p, s] = pop.split(".") as [string, string, string];
    const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
    const flipped = `${h}.${p}.${s.slice(0, -2)}${s.endsWith("AA") ? "BB" : "AA"}`;
    for (const bad of [flipped, `${b64({ alg: "none" })}.${p}.${s}`, `${b64('{"alg":"EdDSA" }')}.${p}.${s}`, `${h}.${b64({ ...where, iat: now, extra: 1 })}.${s}`, `${h}.${b64({ ...where, iat: now + 0.5 })}.${s}`, `${h}.${p}`, "", "a.b.c", `${h}.${p}.${s}.x`]) {
      expect(verifyDevicePop(bad, k.jwk, where, now), bad.slice(0, 40)).toBe(false);
    }
    expect(verifyDevicePop(pop, { x: "not a key" }, where, now)).toBe(false);
  });
});
