import { SignJWT, jwtVerify } from "jose";

/**
 * The staff session. Edge-safe (jose only), because middleware verifies it. It shares nothing with the tenant session:
 * its own cookie, its own secret and its own audience claim, so a tenant token fails here and an ops token fails the
 * tenant verifier on both the secret and the missing tenant claims.
 */
export const OPS_SESSION_COOKIE = "__Host-fx_ops_session";
export const OPS_SESSION_AUDIENCE = "fx-ops";
export const OPS_SESSION_IDLE_MS = 30 * 60 * 1000;
export const OPS_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const SECRET_MIN_CHARS = 32;

type Env = Readonly<Record<string, string | undefined>>;
type Clock = () => number;

export interface OpsSession {
  staffId: string;
  sid: string;
  /** ms since epoch of the passkey ceremony; the absolute limit counts from here and no refresh moves it. */
  authTime: number;
  /** ms since epoch of the last authenticated request; the idle limit counts from here. */
  lastSeen: number;
}

export interface OpsSessionCookieAttributes {
  name: string;
  httpOnly: true;
  secure: true;
  sameSite: "strict";
  path: "/";
  maxAge: number;
}

export function opsSessionCookieAttributes(): OpsSessionCookieAttributes {
  return { name: OPS_SESSION_COOKIE, httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: OPS_SESSION_ABSOLUTE_MS / 1000 };
}

function key(env: Env): Uint8Array | null {
  const secret = env.FX_OPS_SESSION_SECRET;
  return secret && secret.length >= SECRET_MIN_CHARS ? new TextEncoder().encode(secret) : null;
}

async function sign(s: OpsSession, env: Env): Promise<string> {
  const k = key(env);
  if (!k) throw new Error("the ops session secret must be set to a string of at least 32 characters");
  const exp = Math.min(s.lastSeen + OPS_SESSION_IDLE_MS, s.authTime + OPS_SESSION_ABSOLUTE_MS);
  return new SignJWT({ sid: s.sid, auth_time: Math.floor(s.authTime / 1000), last_seen: Math.floor(s.lastSeen / 1000) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.staffId)
    .setAudience(OPS_SESSION_AUDIENCE)
    .setIssuedAt(Math.floor(s.lastSeen / 1000))
    .setExpirationTime(Math.floor(exp / 1000))
    .sign(k);
}

/** A brand-new session, minted after a successful passkey ceremony. */
export async function signOpsSession(staffId: string, env: Env = process.env, now: Clock = Date.now): Promise<string> {
  const t = now();
  return sign({ staffId, sid: crypto.randomUUID(), authTime: t, lastSeen: t }, env);
}

/** The session in a cookie value, or null for any failure: bad signature, wrong audience, idle or absolute limit passed, missing claims. */
export async function verifyOpsSession(token: string, env: Env = process.env, now: Clock = Date.now): Promise<OpsSession | null> {
  const k = key(env);
  if (!k) return null;
  try {
    const { payload } = await jwtVerify(token, k, { audience: OPS_SESSION_AUDIENCE, algorithms: ["HS256"], currentDate: new Date(now()) });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || typeof payload.auth_time !== "number" || typeof payload.last_seen !== "number") return null;
    const session: OpsSession = { staffId: payload.sub, sid: payload.sid, authTime: payload.auth_time * 1000, lastSeen: payload.last_seen * 1000 };
    const t = now();
    if (t - session.lastSeen > OPS_SESSION_IDLE_MS) return null;
    if (t - session.authTime > OPS_SESSION_ABSOLUTE_MS) return null;
    return session;
  } catch {
    // fx-swallow-ok: a cookie that does not verify is an unauthenticated request, not a server failure
    return null;
  }
}

/** The same session with the idle clock restarted; null once the absolute limit has passed. */
export async function refreshOpsSession(session: OpsSession, env: Env = process.env, now: Clock = Date.now): Promise<string | null> {
  const t = now();
  if (t - session.authTime > OPS_SESSION_ABSOLUTE_MS) return null;
  return sign({ ...session, lastSeen: t }, env);
}
