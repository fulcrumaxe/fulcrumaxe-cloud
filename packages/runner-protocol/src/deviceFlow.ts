/**
 * The device flow: how a machine with no credential asks to be linked to an account.
 *
 * The machine starts (`POST /api/runner/device/start`, no signature, but a proof that it holds the key), shows the person a short code, and polls
 * (`POST /api/runner/device/poll`, signed by that key). The person types the code into the browser while signed in; an owner or admin approves it.
 * The code goes from the machine to the person, never the other way: nothing in a link fills it in.
 *
 * Every shape here is strict. A key the shape does not name is refused at any depth.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { MAX_CREATED_SKEW_SECONDS } from "./httpSignature.js";
import { Ed25519PublicJwk, RegisterResponse } from "./messages.js";

export const DEVICE_START_PATH = "/api/runner/device/start";
export const DEVICE_POLL_PATH = "/api/runner/device/poll";
/** Seconds between polls the cloud asks for. A faster poll is answered 429 `slow_down`. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** A code lives this long. */
export const DEVICE_CODE_TTL_SECONDS = 600;

/** Twenty consonants: no vowel (so no word), no digit (so no 0/O or 1/I) and no lower case. */
export const DEVICE_USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
export const DEVICE_CODE_PATTERN = /^fxrd_[A-Za-z0-9]{43}$/;

export const DeviceUserCode = z.string().regex(DEVICE_USER_CODE_PATTERN);
export const DeviceCode = z.string().regex(DEVICE_CODE_PATTERN);

/** What a machine says about itself. The person is shown these values, so each is a short plain value. */
export const DeviceFacts = z
  .object({
    hostname: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/).optional(),
    os: z.string().regex(/^[a-z0-9._-]{1,32}$/),
    arch: z.string().regex(/^[a-z0-9._-]{1,32}$/),
    kvm: z.boolean(),
  })
  .strict();
export type DeviceFacts = z.infer<typeof DeviceFacts>;

/** A compact JWS: three base64url parts, at most 600 characters in all. */
const COMPACT_JWS = /^[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{86}$/;

export const DeviceStartMessage = z.object({ public_key_jwk: Ed25519PublicJwk, pop: z.string().max(600).regex(COMPACT_JWS), facts: DeviceFacts }).strict();
export type DeviceStartMessage = z.infer<typeof DeviceStartMessage>;

export const DeviceStartResponse = z
  .object({
    device_code: DeviceCode,
    user_code: DeviceUserCode,
    verification_uri: z.string().url().max(300),
    expires_at: z.string().datetime(),
    interval_s: z.literal(DEVICE_POLL_INTERVAL_SECONDS),
  })
  .strict();
export type DeviceStartResponse = z.infer<typeof DeviceStartResponse>;

export const DevicePollMessage = z.object({ device_code: DeviceCode }).strict();
export type DevicePollMessage = z.infer<typeof DevicePollMessage>;

/** 200 while the person has not decided, or with the registration once they approve (once only). */
export const DevicePollResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("approved"), registration: RegisterResponse }).strict(),
]);
export type DevicePollResponse = z.infer<typeof DevicePollResponse>;

/** The 410 codes of a poll: the code ran out, a person turned it down, or its registration was already handed out. */
export const DEVICE_GONE_CODES = ["expired", "denied", "consumed"] as const;

/** The person's side, in the browser: the code they typed, and (to approve) a name and an explicit confirmation. */
export const DeviceLookupBody = z.object({ user_code: DeviceUserCode }).strict();
export const DeviceApproveBody = z.object({ user_code: DeviceUserCode, name: z.string().min(1).max(64).optional(), confirm: z.literal(true) }).strict();
export const DeviceDenyBody = DeviceLookupBody;
export const DeviceLookupResponse = z
  .object({
    facts: z.object({ hostname: z.string().optional(), os: z.string(), arch: z.string(), kvm: z.boolean(), ip_country: z.string().optional() }).strict(),
    expires_at: z.string().datetime(),
    warning: z.string(),
  })
  .strict();
export const DeviceApproveResponse = z.object({ runner_id: z.string().uuid() }).strict();
export const DeviceDenyResponse = z.object({ denied: z.literal(true) }).strict();

/** The fixed warning the approval page shows beside the machine's facts. The words are the cloud's, not the machine's. */
export const DEVICE_LINK_WARNING = "Only link a machine you started this code on yourself. A machine you link can run work for your account once you place a project on it.";

// ---- the proof of the key ---------------------------------------------------------------------------------------------------------------------

export interface DevicePopClaims {
  origin: string;
  path: string;
  iat: number;
}

const b64u = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url");
const POP_HEADER = '{"alg":"EdDSA"}';

/** A compact JWS over `{origin, path, iat}` signed with the runner's key: proof that the sender holds the key it presents. */
export function signDevicePop(privateKey: KeyObject, claims: DevicePopClaims): string {
  const signingInput = `${b64u(POP_HEADER)}.${b64u(JSON.stringify({ origin: claims.origin, path: claims.path, iat: claims.iat }))}`;
  return `${signingInput}.${b64u(sign(null, Buffer.from(signingInput), privateKey))}`;
}

/** True only when `pop` is signed by `jwk` over exactly these claims, with an `iat` within the signature skew of `nowSeconds`. Never throws. */
export function verifyDevicePop(pop: string, jwk: { x: string }, expected: { origin: string; path: string }, nowSeconds: number): boolean {
  try {
    const parts = pop.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    if (Buffer.from(h, "base64url").toString("utf8") !== POP_HEADER) return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(claims).sort().join() !== "iat,origin,path") return false;
    if (claims.origin !== expected.origin || claims.path !== expected.path) return false;
    if (typeof claims.iat !== "number" || !Number.isInteger(claims.iat) || Math.abs(nowSeconds - claims.iat) > MAX_CREATED_SKEW_SECONDS) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    return verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  } catch {
    // fx-swallow-ok: a proof that cannot be parsed or checked is simply not a proof; the caller's 400 is the report, and a message from here could echo the input
    return false;
  }
}
