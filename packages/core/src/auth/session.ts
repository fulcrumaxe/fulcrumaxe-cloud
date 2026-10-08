import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';

/**
 * The Web Crypto global (`crypto.randomUUID()`), NOT `node:crypto`'s
 * `randomUUID` export: this file is imported (transitively, via
 * `verifySession`) by apps/web/middleware.ts, which Next.js bundles for
 * the Edge runtime. A `node:crypto` import broke that build outright
 * ("UnhandledSchemeError: Reading from 'node:crypto' is not handled by
 * plugins") -- confirmed by a real `next build` during this PR's Gate 2
 * verification (see the PR description). `crypto.randomUUID()` is the
 * same Web Crypto API both the Node.js runtime (global since Node 19)
 * and the Edge runtime implement natively, so this needs no import at
 * all.
 */

/**
 * H06 pass/fail item 1 (signed, httpOnly, secure, SameSite=Lax cookies)
 * plus D#2607 X3.3 (the `__Host-` prefix). `__Host-` requires the cookie
 * to also be Secure, Path=/, and to carry no Domain attribute -- the
 * browser silently refuses to set it otherwise, so getting any of those
 * three wrong fails closed rather than degrading to an unprefixed cookie.
 */
export const SESSION_COOKIE_NAME = '__Host-fx_session';

/**
 * D#37 WS-C criterion 8: "Sessions have an idle limit and an absolute
 * limit (env-configurable; defaults 24h idle, 30 days absolute)." The
 * idle limit is the deadline a session is good for since it was last
 * signed (sign-in or an explicit refresh); the absolute limit is a hard
 * ceiling from the *original* sign-in that no refresh can push out.
 */
export const SESSION_IDLE_SECONDS_DEFAULT = 60 * 60 * 24; // 24h
export const SESSION_ABSOLUTE_SECONDS_DEFAULT = 60 * 60 * 24 * 30; // 30 days

/** Retained for callers that referred to the old (pre-idle/absolute-split) name; equal to the absolute limit's default. */
export const SESSION_MAX_AGE_SECONDS = SESSION_ABSOLUTE_SECONDS_DEFAULT;

function positiveIntFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function idleLimitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv('FX_SESSION_IDLE_SECONDS', SESSION_IDLE_SECONDS_DEFAULT, env);
}

export function absoluteLimitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv('FX_SESSION_ABSOLUTE_SECONDS', SESSION_ABSOLUTE_SECONDS_DEFAULT, env);
}

export interface SessionCookieAttributes {
  name: string;
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * The attribute set a route handler must apply when setting the session
 * cookie. Deliberately returned as data (not "set the cookie for me")
 * so apps/web's route handlers stay the ones calling Next's cookie API --
 * packages/core has no dependency on next/headers. `maxAge` is the
 * absolute limit: the cookie itself never outlives it, no matter how the
 * JWT's own `exp` (the idle deadline) is refreshed.
 */
export function sessionCookieAttributes(env: NodeJS.ProcessEnv = process.env): SessionCookieAttributes {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: absoluteLimitSeconds(env),
  };
}

export interface SessionPayload {
  userId: string;
  accountId: string;
}

/**
 * Bookkeeping session.ts owns beyond the caller-supplied SessionPayload:
 * - `sid`: D#37 WS-C criterion 8's "a new session id ... at every
 *   sign-in" -- minted fresh by `signSession`, never reused.
 * - `epoch`: the D#37 WS-C criterion 8 "sign out everywhere" mechanism.
 *   The caller reads the user's current epoch from the DB at sign-in
 *   time and passes it in; a later re-check against the (possibly
 *   bumped) current epoch is the caller's job too, since session.ts has
 *   no DB access (see the file-level note above). A session signed with
 *   a stale epoch is not rejected by `verifySession` itself -- only a
 *   caller that fetches the live epoch can catch that.
 * - `sessionStart`: fixed at the original sign-in; the absolute-limit
 *   anchor. Never changes across a `refreshSession` call.
 * - `lastSeenAt`: the idle-limit anchor; advanced by `refreshSession`.
 */
interface SessionClaims extends SessionPayload {
  sid: string;
  epoch: number;
  sessionStart: number; // ms since epoch
  lastSeenAt: number; // ms since epoch
}

export type VerifiedSession = SessionClaims;

const SESSION_SECRET_MIN_CHARS = 32;

function sessionSecretText(env: NodeJS.ProcessEnv): string {
  const secret = env.FX_SESSION_SECRET;
  if (!secret || secret.length < SESSION_SECRET_MIN_CHARS) {
    throw new Error('FX_SESSION_SECRET must be set to a string of at least 32 characters');
  }
  return secret;
}

/**
 * H7b: the key id a session cookie's protected header carries. Derived from
 * the secret itself (a domain-separated SHA-256, 6 bytes of it as hex), so a
 * new secret is a new kid with no extra setting to forget, and the kid says
 * which secret signed a cookie without revealing it. Web Crypto, not
 * `node:crypto`, for the same Edge-bundling reason as the note at the top of
 * this file.
 */
async function keyIdOf(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`fx-session-kid-v1:${secret}`));
  return Array.from(new Uint8Array(digest).subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

function trimmedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw;
}

/** Strict ISO 8601 date-time with an explicit zone (`2026-11-01T00:00:00Z`, `...+02:00`). Epoch numbers and zoneless local times are refused: a window end that depends on the server's zone is a trap. Returns ms, or null. */
function parseUntil(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * H7b: the rotation window. `FX_SESSION_SECRET_PREVIOUS` verifies cookies
 * signed before a rotation, and only until `FX_SESSION_SECRET_PREVIOUS_UNTIL`.
 * The three settings (the secret, UNTIL and `FX_SESSION_SECRET_ROTATED_AT`,
 * the moment of the rotation) are set together. The bound: no session
 * outlives its absolute limit, so a previous secret is never needed longer
 * than the rotation time plus that limit. UNTIL is measured from the recorded
 * rotation time, not from now, so a later clock never makes a value valid
 * that was refused before: the window can only shorten. An UNTIL beyond the
 * bound is refused (ignored here, a health error in `sessionSecretProblems`),
 * and so is a rotation time later than now.
 */
function previousWindow(env: NodeJS.ProcessEnv, nowMs: number): { secret: string; untilMs: number } | null {
  const secret = trimmedEnv(env, 'FX_SESSION_SECRET_PREVIOUS');
  const untilRaw = trimmedEnv(env, 'FX_SESSION_SECRET_PREVIOUS_UNTIL');
  const rotatedRaw = trimmedEnv(env, 'FX_SESSION_SECRET_ROTATED_AT');
  if (secret === undefined || untilRaw === undefined || rotatedRaw === undefined) return null;
  if (secret.length < SESSION_SECRET_MIN_CHARS) return null;
  const untilMs = parseUntil(untilRaw);
  const rotatedAtMs = parseUntil(rotatedRaw);
  if (untilMs === null || rotatedAtMs === null) return null;
  if (rotatedAtMs > nowMs) return null; // a rotation that has not happened yet
  if (nowMs >= untilMs) return null; // after UNTIL the previous secret is ignored even though it is still set
  if (untilMs > rotatedAtMs + absoluteLimitSeconds(env) * 1000) return null;
  return { secret, untilMs };
}

export interface SessionSecretProblem {
  name: string;
  /** A fixed code. Never a value, never a fragment of one. */
  reason: string;
}

/**
 * H7b: the cross-setting faults /api/health reports for the rotation window.
 * Each single value's own shape (the 32-character minimum, the timestamp
 * format) is judged by the env manifest; this covers what only the pair can
 * show. Names and fixed codes only.
 */
export function sessionSecretProblems(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): SessionSecretProblem[] {
  const secret = trimmedEnv(env, 'FX_SESSION_SECRET_PREVIOUS');
  const untilRaw = trimmedEnv(env, 'FX_SESSION_SECRET_PREVIOUS_UNTIL');
  const rotatedRaw = trimmedEnv(env, 'FX_SESSION_SECRET_ROTATED_AT');
  const problems: SessionSecretProblem[] = [];
  if (secret !== undefined && untilRaw === undefined) {
    problems.push({ name: 'FX_SESSION_SECRET_PREVIOUS', reason: 'set_without_until' });
  }
  if (untilRaw !== undefined && secret === undefined) {
    problems.push({ name: 'FX_SESSION_SECRET_PREVIOUS_UNTIL', reason: 'set_without_previous_secret' });
  }
  if (rotatedRaw === undefined && (secret !== undefined || untilRaw !== undefined)) {
    problems.push({ name: 'FX_SESSION_SECRET_ROTATED_AT', reason: 'set_without_rotated_at' });
  }
  if (rotatedRaw !== undefined && secret === undefined && untilRaw === undefined) {
    problems.push({ name: 'FX_SESSION_SECRET_ROTATED_AT', reason: 'set_without_previous_pair' });
  }
  const rotatedAtMs = rotatedRaw === undefined ? null : parseUntil(rotatedRaw);
  if (rotatedAtMs !== null && rotatedAtMs > nowMs) {
    problems.push({ name: 'FX_SESSION_SECRET_ROTATED_AT', reason: 'in_the_future' });
  }
  if (untilRaw !== undefined) {
    const untilMs = parseUntil(untilRaw);
    if (untilMs !== null && rotatedAtMs !== null && untilMs > rotatedAtMs + absoluteLimitSeconds(env) * 1000) {
      problems.push({ name: 'FX_SESSION_SECRET_PREVIOUS_UNTIL', reason: 'beyond_session_lifetime' });
    } else if (untilMs !== null && secret !== undefined && nowMs >= untilMs) {
      problems.push({ name: 'FX_SESSION_SECRET_PREVIOUS', reason: 'expired_remove_it' });
    }
  }
  return problems;
}

/**
 * The secrets a cookie may be verified with. A cookie names its signing
 * secret by kid: the current one, or the previous one while its window is
 * open. A kid that matches neither verifies against nothing. A cookie with no
 * kid predates H7b, so it gets the current secret and then, while the window
 * is open, the previous one (a first rotation must not sign out every
 * pre-H7b cookie).
 */
async function verificationKeys(token: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<Uint8Array[]> {
  const kid = decodeProtectedHeader(token).kid;
  const current = sessionSecretText(env);
  const previous = previousWindow(env, nowMs);
  const encode = (s: string) => new TextEncoder().encode(s);
  if (kid === undefined) {
    return previous ? [encode(current), encode(previous.secret)] : [encode(current)];
  }
  if (kid === (await keyIdOf(current))) return [encode(current)];
  if (previous && kid === (await keyIdOf(previous.secret))) return [encode(previous.secret)];
  return [];
}

/**
 * The nearer of the idle/absolute deadlines, as an ABSOLUTE Unix-seconds
 * NumericDate -- never below `iat + 1` (jose requires exp strictly after
 * iat). Deliberately a number, not a jose duration string ("<n>s"): jose
 * resolves a string duration against the real wall clock at `.sign()`
 * time, not against the `setIssuedAt` value passed in, which would make
 * every exp anchor to real time regardless of an injected fake `now` and
 * silently defeat the fake-clock tests this criterion requires.
 */
function expirationAt(claims: SessionClaims, nowMs: number, env: NodeJS.ProcessEnv): number {
  const nowSec = Math.floor(nowMs / 1000);
  const idleDeadlineSec = Math.floor(claims.lastSeenAt / 1000) + idleLimitSeconds(env);
  const absoluteDeadlineSec = Math.floor(claims.sessionStart / 1000) + absoluteLimitSeconds(env);
  return Math.max(nowSec + 1, Math.min(idleDeadlineSec, absoluteDeadlineSec));
}

async function signClaims(claims: SessionClaims, nowMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', kid: await keyIdOf(sessionSecretText(env)) })
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(expirationAt(claims, nowMs, env))
    .sign(new TextEncoder().encode(sessionSecretText(env)));
}

export interface SignSessionOptions {
  /** The session epoch to embed, as read by the caller from the DB at sign-in time. Defaults to 0 for callers that don't track epochs. */
  epoch?: number;
  /** Injectable clock, for fake-clock tests. */
  now?: () => number;
}

/** Signs a brand-new session -- always a fresh `sid` (D#37 WS-C criterion 8), never a refresh of an existing one. */
export async function signSession(
  payload: SessionPayload,
  env: NodeJS.ProcessEnv = process.env,
  options: SignSessionOptions = {},
): Promise<string> {
  const now = (options.now ?? Date.now)();
  const claims: SessionClaims = {
    ...payload,
    sid: crypto.randomUUID(),
    epoch: options.epoch ?? 0,
    sessionStart: now,
    lastSeenAt: now,
  };
  return signClaims(claims, now, env);
}

/**
 * Verifies and decodes a session cookie value. Returns null on any
 * failure -- tampered, wrong secret, past the JWT's own `exp` (the idle
 * deadline), or past the absolute deadline even if `exp` somehow wasn't
 * (belt-and-braces against an env change between sign and verify) --
 * never throws for a bad cookie.
 */
export async function verifySession(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<VerifiedSession | null> {
  try {
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'] | null = null;
    for (const key of await verificationKeys(token, env, now())) {
      try {
        payload = (await jwtVerify(token, key, { currentDate: new Date(now()) })).payload;
        break;
      } catch {
        // fx-swallow-ok: this secret did not verify the cookie; the next candidate is tried, and none left is an unauthenticated request
      }
    }
    if (payload === null) return null;
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.accountId !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.epoch !== 'number' ||
      typeof payload.sessionStart !== 'number' ||
      typeof payload.lastSeenAt !== 'number'
    ) {
      return null;
    }
    const claims: SessionClaims = {
      userId: payload.userId,
      accountId: payload.accountId,
      sid: payload.sid,
      epoch: payload.epoch,
      sessionStart: payload.sessionStart,
      lastSeenAt: payload.lastSeenAt,
    };
    if (now() > claims.sessionStart + absoluteLimitSeconds(env) * 1000) {
      return null;
    }
    return claims;
  } catch {
    // fx-swallow-ok: a cookie that does not verify or parse is an unauthenticated request, not a server failure
    return null;
  }
}

/**
 * Slides the idle window forward: re-signs the SAME session (same
 * `sid`/`epoch`/`sessionStart` -- this is never a new sign-in) with
 * `lastSeenAt` advanced to `now`. Returns null if the session is already
 * past its absolute limit, since there is nothing left to refresh.
 * Exported for a future activity-triggered call site; nothing in WS-C1
 * calls this yet (see the PR description's "known gap" note) -- today a
 * session's idle and absolute deadlines both anchor to sign-in time.
 */
export async function refreshSession(
  verified: VerifiedSession,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<string | null> {
  const nowMs = now();
  if (nowMs > verified.sessionStart + absoluteLimitSeconds(env) * 1000) {
    return null;
  }
  const claims: SessionClaims = { ...verified, lastSeenAt: nowMs };
  return signClaims(claims, nowMs, env);
}
