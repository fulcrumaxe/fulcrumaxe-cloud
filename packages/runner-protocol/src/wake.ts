/**
 * D#6 RUNNER-WAKE R3a: the wake credential. A runner that advertises `wake_v1` on its hello gets a `wake` grant on its hello and claim replies.
 * A later row adds the endpoint that takes the token and answers "is there work for my account" from a cache, so an idle runner can ask often
 * without a database read, and keeps a slow ordinary claim as its safety net. This file fixes the shapes both sides share; nothing here opens
 * a connection or holds a key.
 *
 * The token is `b64url(payload) "." b64url(HMAC-SHA256(key, b64url(payload)))`. The key lives only in the cloud. The payload names the runner,
 * its account and the key it signs requests with, so the endpoint can check, with no database row, that the bearer is the runner the cloud
 * issued it to (the request must also be signed by that key). The payload is versioned and carries nothing about how the runner is woken: the
 * transport is a field of the grant, so a later push transport reuses the same token.
 *
 * Old runners are unaffected: every reply schema is strict, so the cloud sends the grant only to a runner whose latest hello listed `wake_v1`.
 */
import { z } from "zod";

/** The capability a runner lists on hello when it can use a wake grant. */
export const WAKE_CAPABILITY = "wake_v1" as const;

/** The token's payload version. A new version is a new number here, never a reuse. */
export const WAKE_TOKEN_VERSION = 1;
/** How long a token is good for from the moment it is minted. Each hello and claim mints a fresh one. */
export const WAKE_TOKEN_LIFETIME_SECONDS = 86_400;
/** How often the cloud asks a runner to check for work, unless it chooses otherwise. Server-chosen and sent with the grant. */
export const WAKE_POLL_SECONDS_DEFAULT = 20;
/** The bounds of `poll_s`, inclusive. */
export const WAKE_POLL_SECONDS = { min: 5, max: 3600 } as const;
/** The longest token the grant may carry. */
export const WAKE_TOKEN_MAX_LENGTH = 1024;

/**
 * The transports the cloud sends today. Only `poll` exists. The grant's `transport` field accepts any short lowercase code, so that a cloud
 * that later offers another transport does not break a runner built before it: a runner treats a value it does not know as `poll`
 * (`effectiveWakeTransport`). The cloud itself only ever sends a value from this list.
 */
export const WAKE_TRANSPORTS = ["poll"] as const;
export type WakeTransport = (typeof WAKE_TRANSPORTS)[number];

const safeInt = z.number().int().safe();
const uuid = z.string().uuid();
/** A base64url SHA-256 thumbprint or Ed25519 public key: 32 bytes, 43 characters, no padding. */
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** What the token says, once its MAC has been checked. Strict: a payload with anything else is not a token this cloud minted. */
export const WakeTokenPayload = z
  .object({
    v: z.literal(WAKE_TOKEN_VERSION),
    /** The runner the token was issued to. */
    rid: uuid,
    /** That runner's account: the only account whose work the token can ask about. */
    acct: uuid,
    /** The thumbprint of the runner's request-signing key when the token was minted. */
    jkt: b64url32,
    /** That key's public `x`, so a signature can be checked without looking the key up. It is a public key. */
    jwk_x: b64url32,
    /** Expiry, in whole seconds since the epoch. */
    exp: safeInt.min(1),
  })
  .strict();
export type WakeTokenPayload = z.infer<typeof WakeTokenPayload>;

/** The token's wire form: two base64url parts, the second a 32-byte MAC. */
export const WAKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,960}\.[A-Za-z0-9_-]{43}$/;

/**
 * The wake grant on a hello or claim reply. `poll_s` is how often the runner should check, chosen by the cloud. `transport` is how; a runner
 * treats an unknown value as `poll` (see `WAKE_TRANSPORTS`). The token is opaque to the runner: it sends it back and never relies on reading it.
 */
export const WakeGrant = z
  .object({
    token: z.string().max(WAKE_TOKEN_MAX_LENGTH).regex(WAKE_TOKEN_PATTERN),
    poll_s: safeInt.min(WAKE_POLL_SECONDS.min).max(WAKE_POLL_SECONDS.max),
    transport: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  })
  .strict();
export type WakeGrant = z.infer<typeof WakeGrant>;

/** The transport a runner acts on for a grant: the one named when it knows it, else `poll`. */
export function effectiveWakeTransport(transport: string): WakeTransport {
  return (WAKE_TRANSPORTS as readonly string[]).includes(transport) ? (transport as WakeTransport) : "poll";
}
