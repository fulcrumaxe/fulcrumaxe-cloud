import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { OPS_SESSION_ABSOLUTE_MS } from "./session";
import { WebAuthnRefusal } from "./webauthn";

/**
 * Limits on /api/auth/*, kept in the database (ops_auth_rate_take) because the console runs as many short-lived instances. The key
 * is the SHA-256 of the client address Vercel sets, so no address is stored. Two budgets per address:
 *   - every request to /api/auth/*: 30 per 5 minutes;
 *   - failed verifies: 10 per 15 minutes. Checked before a verify runs, recorded after one is refused.
 * Beyond either, the answer is 429 with no detail. The same function holds the sign-out deny-list: a revoked session id is a bucket
 * of one that stays full for as long as the session itself could live.
 */
export const AUTH_REQUESTS = { bucket: "auth_req", max: 30, window: "5 minutes" } as const;
export const AUTH_FAILED_VERIFIES = { bucket: "auth_fail", max: 10, window: "15 minutes" } as const;
const REVOKED_BUCKET = "sid_revoked";
const REVOKED = { bucket: REVOKED_BUCKET, max: 1, window: `${OPS_SESSION_ABSOLUTE_MS / 1000} seconds` } as const;

/** A budget is spent. Carries nothing: the response says nothing either. */
export class RateLimited extends Error {
  static readonly fixedMessage = "too many requests";
  constructor() {
    super(RateLimited.fixedMessage);
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Hash of the client address. On Vercel (VERCEL is set) only x-vercel-forwarded-for counts: the platform overwrites it, whereas a
 * caller can send any x-real-ip or x-forwarded-for and pick its own key. The conventional headers are read only without VERCEL
 * (local development). Requests with no address share one key.
 */
export function clientKey(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for");
  const raw = process.env.VERCEL ? (vercel ?? "") : (vercel ?? headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0] ?? "");
  return sha256(raw.trim() || "unknown");
}

async function take(pool: Pool, key: string, b: { bucket: string; max: number; window: string }, record: boolean): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>("SELECT ops_auth_rate_take($1, $2, $3, $4::interval, $5) AS ok", [key, b.bucket, b.max, b.window, record]);
  return rows[0]?.ok === true;
}

/** Counts one request to /api/auth/* and returns the caller's key. Throws RateLimited when the budget is spent. */
export async function limitAuthRequest(headers: Headers, pool: Pool): Promise<string> {
  const key = clientKey(headers);
  if (!(await take(pool, key, AUTH_REQUESTS, true))) throw new RateLimited();
  return key;
}

/**
 * Runs a verify: refused up front once the caller has used up its failed-verify budget, and a refused ceremony is recorded as
 * one more failure. Anything but a refusal (a database error, say) is not the caller's failure and is not counted.
 */
export async function guardVerify<T>(headers: Headers, pool: Pool, verify: () => Promise<T>): Promise<T> {
  const key = await limitAuthRequest(headers, pool);
  if (!(await take(pool, key, AUTH_FAILED_VERIFIES, false))) throw new RateLimited();
  try {
    return await verify();
  } catch (err) {
    if (err instanceof WebAuthnRefusal) await take(pool, key, AUTH_FAILED_VERIFIES, true);
    throw err;
  }
}

const sidKey = (sid: string): string => sha256(`sid:${sid}`);

/** Sign-out: the session id is refused by requireStaff from now until the session could no longer be valid anyway. */
export async function revokeSession(sid: string, pool: Pool): Promise<void> {
  await take(pool, sidKey(sid), REVOKED, true);
}

export async function sessionRevoked(sid: string, pool: Pool): Promise<boolean> {
  // A full bucket (no room left) is a revoked session.
  return !(await take(pool, sidKey(sid), REVOKED, false));
}
