import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BACKSTOP_MS } from "@fx/core/src/pendingWork.js";
import {
  WAKE_CAPABILITY,
  WAKE_POLL_SECONDS_DEFAULT,
  WAKE_TOKEN_LIFETIME_SECONDS,
  WAKE_TOKEN_PATTERN,
  WAKE_TOKEN_VERSION,
  WakeGrant,
  WakeTokenPayload,
} from "@fulcrumaxe/runner-protocol";

/** What a token is minted from: the fields of a verified runner request it names. Callers pass the verified runner itself. */
export interface WakeRunner {
  readonly runnerId: string;
  readonly accountId: string;
  readonly jkt: string;
  readonly publicKeyX: string;
}

/**
 * D#6 RUNNER-WAKE R3a: the cloud's half of the wake credential. The token (runner-protocol `wake.ts`) is minted here on every hello and claim
 * of a runner that listed `wake_v1`, with an HMAC-SHA256 key that never leaves the cloud (FX_RUNNER_WAKE_KEY). `verifyWakeToken` is what the
 * wake endpoint (a later row) checks a token with: it needs no database.
 *
 * Fail closed: with no usable key, nothing is minted and replies carry no grant. The ordinary claim path does not depend on this at all.
 */

/** The shortest key accepted, in bytes. A shorter or missing one means the wake path is off. */
export const WAKE_KEY_MIN_BYTES = 32;

/** The key as bytes, or null when it is missing or too short. Read on each call, so a changed setting applies to the next request. */
export function readWakeKey(env: Readonly<Record<string, string | undefined>>): Buffer | null {
  const raw = env.FX_RUNNER_WAKE_KEY;
  if (typeof raw !== "string") return null;
  const key = Buffer.from(raw, "utf8");
  return key.byteLength >= WAKE_KEY_MIN_BYTES ? key : null;
}

/** The deps' key, or null when none is configured, it is too short, or reading it throws. Never fails the request it is read for. */
export function configuredWakeKey(read: (() => Buffer | null) | null | undefined): Buffer | null {
  if (!read) return null;
  try {
    const key = read();
    return key !== null && key.byteLength >= WAKE_KEY_MIN_BYTES ? key : null;
  } catch (error) {
    // fx-swallow-ok: an unreadable key turns the wake path off (fail closed) and the request goes on; it is logged to stdout below.
    // stdout only: the wake path must not open a database connection to report itself (no reportError, which writes error_events).
    console.warn(JSON.stringify({ event: "runner_wake.key_unreadable", error_name: error instanceof Error ? error.name : "unknown" }));
    return null;
  }
}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");
const mac = (key: Buffer, body: string): Buffer => createHmac("sha256", key).update(body, "utf8").digest();

/** Mints the token for `runner`, valid for `WAKE_TOKEN_LIFETIME_SECONDS` from `now`. Throws only on a key the caller should not have passed. */
export function mintWakeToken(key: Buffer, runner: WakeRunner, now: Date): string {
  if (key.byteLength < WAKE_KEY_MIN_BYTES) throw new Error("wake key too short");
  const payload = WakeTokenPayload.parse({
    v: WAKE_TOKEN_VERSION,
    rid: runner.runnerId,
    acct: runner.accountId,
    jkt: runner.jkt,
    jwk_x: runner.publicKeyX,
    exp: Math.floor(now.getTime() / 1000) + WAKE_TOKEN_LIFETIME_SECONDS,
  });
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64url(mac(key, body))}`;
}

/**
 * The payload of a token this cloud minted with `key`, or null: a malformed token, a MAC that does not match, a payload that is not the strict
 * shape, or one whose `exp` is at or before `now`. The MAC is checked before the payload is read, in constant time.
 */
export function verifyWakeToken(key: Buffer, token: string, now: Date): WakeTokenPayload | null {
  if (key.byteLength < WAKE_KEY_MIN_BYTES || typeof token !== "string" || !WAKE_TOKEN_PATTERN.test(token)) return null;
  const [body, sent] = token.split(".") as [string, string];
  const expected = mac(key, body);
  const given = Buffer.from(sent, "base64url");
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    // fx-swallow-ok: a body that is not JSON is a refused token, answered as null like every other refusal; nothing went wrong on our side.
    return null;
  }
  const parsed = WakeTokenPayload.safeParse(decoded);
  if (!parsed.success) return null;
  return parsed.data.exp > Math.floor(now.getTime() / 1000) ? parsed.data : null;
}

/** The spread, in seconds, added after a slot boundary so a fleet's safety claims do not all land in the same second. */
export const WAKE_SAFETY_JITTER_SECONDS = 300;

/**
 * D#6 RUNNER-WAKE R3b: the `retry_after` of an idle claim answered to a runner that holds a wake grant. Such a runner learns of new work from the
 * wake check, so its database claim is only a safety net: it is told to come back just after the next wall-clock slot boundary (the same 30-minute
 * slots the cron backstops connect in, so the database wakes once per slot for all of them), plus a per-runner offset in [0, 300] s taken from a hash
 * of its id (stable for a runner, spread across a fleet). At most 1800 + 300 s, inside the protocol's 3600 bound; at least 1.
 */
export function wakeSafetyRetryAfterSeconds(runnerId: string, now: Date, slotMs: number = BACKSTOP_MS): number {
  const nowMs = now.getTime();
  const untilBoundary = Math.ceil(((Math.floor(nowMs / slotMs) + 1) * slotMs - nowMs) / 1000);
  const jitter = createHash("sha256").update(runnerId, "utf8").digest().readUInt32BE(0) % (WAKE_SAFETY_JITTER_SECONDS + 1);
  return Math.max(1, untilBoundary + jitter);
}

/**
 * The grant for a reply, or undefined when there is none to send: the runner did not list `wake_v1`, or no key is configured. Parsed against the
 * protocol's schema, so a grant the runner would refuse is never sent.
 */
export function wakeGrantFor(key: Buffer | null, runner: WakeRunner, capabilities: readonly string[] | null | undefined, now: Date, pollSeconds: number = WAKE_POLL_SECONDS_DEFAULT): WakeGrant | undefined {
  if (key === null || !(capabilities ?? []).includes(WAKE_CAPABILITY)) return undefined;
  return WakeGrant.parse({ token: mintWakeToken(key, runner, now), poll_s: pollSeconds, transport: "poll" });
}
