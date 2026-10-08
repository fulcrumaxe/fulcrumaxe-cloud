import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { refreshSession, sessionSecretProblems, signSession, verifySession } from '../../src/auth/session.js';

/**
 * H7b: session secret rotation. A cookie carries a key id; the current secret
 * verifies its own kid, the previous secret verifies its kid only while
 * FX_SESSION_SECRET_PREVIOUS_UNTIL has not passed (and UNTIL is no later than FX_SESSION_SECRET_ROTATED_AT plus the absolute lifetime); a refresh re-signs with the
 * current secret. Fake clock throughout.
 */
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const OLD = 'o'.repeat(32);
const NEW = 'n'.repeat(32);
const iso = (ms: number) => new Date(ms).toISOString();
// A long idle limit, so only the rotation window (never the idle deadline) can end a session in these tests.
const longIdle = { FX_SESSION_IDLE_SECONDS: String(60 * 60 * 24 * 30) };
const mk = (extra: Record<string, string>) => ({ ...longIdle, ...extra }) as unknown as NodeJS.ProcessEnv;
const oldEnv = mk({ FX_SESSION_SECRET: OLD });
const newOnly = mk({ FX_SESSION_SECRET: NEW });
const rotated = (untilMs: number, rotatedAtMs: number = T0) =>
  mk({ FX_SESSION_SECRET: NEW, FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(untilMs), FX_SESSION_SECRET_ROTATED_AT: iso(rotatedAtMs) });
const kidOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid as string | undefined;
const signOld = () => signSession({ userId: 'u1', accountId: 'a1' }, oldEnv, { now: () => T0 });

describe('session secret rotation (H7b, fake clock)', () => {
  it('puts a kid in the header: stable for one secret, different for another, and not the secret', async () => {
    const a1 = await signSession({ userId: 'u1', accountId: 'a1' }, oldEnv, { now: () => T0 });
    const a2 = await signSession({ userId: 'u2', accountId: 'a1' }, oldEnv, { now: () => T0 });
    const b = await signSession({ userId: 'u1', accountId: 'a1' }, newOnly, { now: () => T0 });
    expect(kidOf(a1)).toMatch(/^[0-9a-f]{12}$/);
    expect(kidOf(a1)).toBe(kidOf(a2));
    expect(kidOf(b)).not.toBe(kidOf(a1));
  });

  it('new kid: a cookie signed under the new secret verifies during and after the window', async () => {
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, newOnly, { now: () => T0 });
    expect(await verifySession(token, rotated(T0 + 10 * DAY), () => T0 + DAY)).not.toBeNull();
    expect(await verifySession(token, newOnly, () => T0 + DAY)).not.toBeNull();
  });

  it('verifies an old-kid cookie with the previous secret before UNTIL, and not at or after UNTIL even though the previous secret is still set', async () => {
    const token = await signOld();
    const until = T0 + 10 * DAY;
    const env2 = rotated(until);
    const before = await verifySession(token, env2, () => until - 1000);
    expect(before?.userId).toBe('u1');
    expect(await verifySession(token, env2, () => until)).toBeNull();
    expect(await verifySession(token, env2, () => until + DAY)).toBeNull();
  });

  it('an old-kid cookie is rejected once the previous secret is gone', async () => {
    expect(await verifySession(await signOld(), newOnly, () => T0 + DAY)).toBeNull();
  });

  it('re-signs with the current secret on refresh, so the refreshed cookie outlives the previous secret', async () => {
    const until = T0 + 10 * DAY;
    const verified = await verifySession(await signOld(), rotated(until), () => T0 + DAY);
    expect(verified).not.toBeNull();
    const refreshed = await refreshSession(verified!, rotated(until), () => T0 + DAY);
    const currentKid = kidOf(await signSession({ userId: 'x', accountId: 'y' }, newOnly));
    expect(kidOf(refreshed!)).toBe(currentKid);
    expect(kidOf(refreshed!)).not.toBe(kidOf(await signOld()));
    const after = await verifySession(refreshed!, newOnly, () => until + DAY);
    expect(after?.sid).toBe(verified!.sid);
    expect(after?.sessionStart).toBe(verified!.sessionStart);
  });

  it('wrong value: a previous secret that did not sign the cookie verifies nothing', async () => {
    const wrongPrevious = mk({ FX_SESSION_SECRET: NEW, FX_SESSION_SECRET_PREVIOUS: 'w'.repeat(32), FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + 10 * DAY), FX_SESSION_SECRET_ROTATED_AT: iso(T0) });
    expect(await verifySession(await signOld(), wrongPrevious, () => T0 + DAY)).toBeNull();
  });

  it('a cookie naming the previous kid but signed with another key is rejected, as is an unknown kid', async () => {
    const real = await signOld();
    const [header, body, sig] = real.split('.');
    const forged = `${header}.${body}.${'A'.repeat(sig!.length)}`;
    expect(await verifySession(forged, rotated(T0 + 10 * DAY), () => T0 + DAY)).toBeNull();
    const otherKid = await signSession({ userId: 'u1', accountId: 'a1' }, mk({ FX_SESSION_SECRET: 'z'.repeat(32) }), { now: () => T0 });
    expect(await verifySession(otherKid, rotated(T0 + 10 * DAY), () => T0 + DAY)).toBeNull();
  });

  it('selects the secret by kid: a validly signed cookie whose kid names neither secret, or names the wrong one, is rejected', async () => {
    const withKid = (secret: string, kid: string) =>
      new SignJWT({ userId: 'u1', accountId: 'a1', sid: 's', epoch: 0, sessionStart: T0, lastSeenAt: T0 })
        .setProtectedHeader({ alg: 'HS256', kid })
        .setIssuedAt(Math.floor(T0 / 1000))
        .setExpirationTime(Math.floor(T0 / 1000) + 20 * 24 * 3600)
        .sign(new TextEncoder().encode(secret));
    const newKid = kidOf(await signSession({ userId: 'x', accountId: 'y' }, newOnly))!;
    const oldKid = kidOf(await signOld())!;
    const env2 = rotated(T0 + 10 * DAY);
    expect(await verifySession(await withKid(NEW, newKid), env2, () => T0 + DAY)).not.toBeNull();
    expect(await verifySession(await withKid(NEW, 'deadbeef0000'), env2, () => T0 + DAY)).toBeNull();
    expect(await verifySession(await withKid(OLD, newKid), env2, () => T0 + DAY)).toBeNull();
    expect(await verifySession(await withKid(NEW, oldKid), env2, () => T0 + DAY)).toBeNull();
  });

  it('a cookie with no kid (signed before H7b) verifies with the current secret, and with the previous one only inside the window', async () => {
    const legacy = async (secret: string) =>
      new SignJWT({ userId: 'u1', accountId: 'a1', sid: 's', epoch: 0, sessionStart: T0, lastSeenAt: T0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(T0 / 1000))
        .setExpirationTime(Math.floor(T0 / 1000) + 20 * 24 * 3600)
        .sign(new TextEncoder().encode(secret));
    const until = T0 + 10 * DAY;
    expect(await verifySession(await legacy(NEW), rotated(until), () => T0 + DAY)).not.toBeNull();
    expect(await verifySession(await legacy(OLD), rotated(until), () => T0 + DAY)).not.toBeNull();
    expect(await verifySession(await legacy(OLD), rotated(until), () => until + 1)).toBeNull();
    expect(await verifySession(await legacy(OLD), newOnly, () => T0 + DAY)).toBeNull();
  });

  it('refuses an UNTIL beyond ROTATED_AT plus the absolute lifetime: the previous secret is not used', async () => {
    const token = await signOld();
    const limit = 30 * DAY;
    expect(await verifySession(token, rotated(T0 + limit + 1000), () => T0)).toBeNull();
    // exactly on the bound is accepted; one second past it is refused
    expect(await verifySession(token, rotated(T0 + limit), () => T0)).not.toBeNull();
    expect(await verifySession(token, rotated(T0 + limit + 1000), () => T0 + DAY)).toBeNull();
  });

  it('an UNTIL of ROTATED_AT + 2L stays refused after the clock passes ROTATED_AT + L (the window never stretches)', async () => {
    const limit = 30 * DAY;
    // A cookie signed with the old secret at T0+L: its own session limit is not yet reached, so only the
    // rotation bound can refuse it (a forger holding the old secret chooses such a timestamp).
    const forged = await signSession({ userId: 'u1', accountId: 'a1' }, oldEnv, { now: () => T0 + limit });
    const env2 = rotated(T0 + 2 * limit);
    expect(await verifySession(forged, env2, () => T0)).toBeNull();
    expect(await verifySession(forged, env2, () => T0 + limit + 1000)).toBeNull();
    expect(await verifySession(forged, env2, () => T0 + limit + DAY)).toBeNull();
    // the same UNTIL measured from a later rotation time is inside the bound, which is why the time is recorded
    expect(await verifySession(forged, rotated(T0 + 2 * limit, T0 + limit), () => T0 + limit + DAY)).not.toBeNull();
  });

  it('a ROTATED_AT later than now is ignored together with the previous secret', async () => {
    const token = await signOld();
    expect(await verifySession(token, rotated(T0 + 10 * DAY, T0 + DAY), () => T0)).toBeNull();
    expect(await verifySession(token, rotated(T0 + 10 * DAY, T0 + DAY), () => T0 + DAY)).not.toBeNull();
  });

  it('the previous secret, UNTIL and ROTATED_AT are used only as a trio', async () => {
    const token = await signOld();
    const base = { FX_SESSION_SECRET: NEW, FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + 10 * DAY), FX_SESSION_SECRET_ROTATED_AT: iso(T0) };
    expect(await verifySession(token, mk(base), () => T0 + DAY)).not.toBeNull();
    for (const missing of ['FX_SESSION_SECRET_PREVIOUS', 'FX_SESSION_SECRET_PREVIOUS_UNTIL', 'FX_SESSION_SECRET_ROTATED_AT']) {
      const rest = Object.fromEntries(Object.entries(base).filter(([name]) => name !== missing));
      expect(await verifySession(token, mk(rest), () => T0 + DAY), missing).toBeNull();
    }
  });

  it('the previous secret and UNTIL are used only as a pair', async () => {
    const token = await signOld();
    const onlySecret = mk({ FX_SESSION_SECRET: NEW, FX_SESSION_SECRET_PREVIOUS: OLD });
    const onlyUntil = mk({ FX_SESSION_SECRET: NEW, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + 10 * DAY) });
    expect(await verifySession(token, onlySecret, () => T0 + DAY)).toBeNull();
    expect(await verifySession(token, onlyUntil, () => T0 + DAY)).toBeNull();
  });

  it('ignores a previous secret shorter than 32 characters and an UNTIL that is not an ISO timestamp with a zone', async () => {
    const short = 's'.repeat(31);
    const shortToken = await signSession({ userId: 'u1', accountId: 'a1' }, mk({ FX_SESSION_SECRET: 'x'.repeat(32) }), { now: () => T0 });
    const withShort = mk({ FX_SESSION_SECRET: NEW, FX_SESSION_SECRET_PREVIOUS: short, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + DAY), FX_SESSION_SECRET_ROTATED_AT: iso(T0) });
    expect(await verifySession(shortToken, withShort, () => T0)).toBeNull();
    for (const bad of [String(Math.floor((T0 + DAY) / 1000)), '2026-10-11T12:00:00', 'soon']) {
      const e = mk({ FX_SESSION_SECRET: NEW, FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: bad, FX_SESSION_SECRET_ROTATED_AT: iso(T0) });
      expect(await verifySession(await signOld(), e, () => T0 + 1000), bad).toBeNull();
    }
  });
});

describe('sessionSecretProblems (what /api/health reports)', () => {
  const problems = (extra: Record<string, string>, now = T0) => sessionSecretProblems(mk({ FX_SESSION_SECRET: NEW, ...extra }), now);
  const AT = { FX_SESSION_SECRET_ROTATED_AT: iso(T0) };

  it('is empty with none set, and with a trio inside the window', () => {
    expect(problems({})).toEqual([]);
    expect(problems({ ...AT, FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + 10 * DAY) })).toEqual([]);
  });

  it('flags a member set without the others, by name and fixed code', () => {
    expect(problems({ ...AT, FX_SESSION_SECRET_PREVIOUS: OLD })).toEqual([{ name: 'FX_SESSION_SECRET_PREVIOUS', reason: 'set_without_until' }]);
    expect(problems({ ...AT, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + DAY) })).toEqual([{ name: 'FX_SESSION_SECRET_PREVIOUS_UNTIL', reason: 'set_without_previous_secret' }]);
  });

  it('flags a missing ROTATED_AT, and a ROTATED_AT set alone', () => {
    const rotatedMissing = { name: 'FX_SESSION_SECRET_ROTATED_AT', reason: 'set_without_rotated_at' };
    expect(problems({ FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + DAY) })).toEqual([rotatedMissing]);
    expect(problems({ FX_SESSION_SECRET_PREVIOUS: OLD })).toContainEqual(rotatedMissing);
    expect(problems({ FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + DAY) })).toContainEqual(rotatedMissing);
    expect(problems({ ...AT })).toEqual([{ name: 'FX_SESSION_SECRET_ROTATED_AT', reason: 'set_without_previous_pair' }]);
  });

  it('flags a ROTATED_AT later than now', () => {
    const trio = { FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + 10 * DAY) };
    expect(problems({ ...trio, FX_SESSION_SECRET_ROTATED_AT: iso(T0 + 1000) })).toEqual([{ name: 'FX_SESSION_SECRET_ROTATED_AT', reason: 'in_the_future' }]);
    expect(problems({ ...trio, FX_SESSION_SECRET_ROTATED_AT: iso(T0) })).toEqual([]);
  });

  it('flags an UNTIL beyond ROTATED_AT plus the lifetime, accepts one exactly on it, and does not forgive it as the clock moves', () => {
    const pair = (untilMs: number) => ({ ...AT, FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(untilMs) });
    const beyond = [{ name: 'FX_SESSION_SECRET_PREVIOUS_UNTIL', reason: 'beyond_session_lifetime' }];
    expect(problems(pair(T0 + 30 * DAY + 1000))).toEqual(beyond);
    expect(problems(pair(T0 + 30 * DAY))).toEqual([]);
    expect(problems(pair(T0 + 60 * DAY), T0 + 30 * DAY + 1000)).toEqual(beyond);
    expect(problems(pair(T0 + 60 * DAY), T0 + 45 * DAY)).toEqual(beyond);
  });

  it('asks for removal once UNTIL has passed and the previous secret is still set', () => {
    const pair = { ...AT, FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + DAY) };
    expect(problems(pair, T0 + DAY - 1)).toEqual([]);
    expect(problems(pair, T0 + DAY)).toEqual([{ name: 'FX_SESSION_SECRET_PREVIOUS', reason: 'expired_remove_it' }]);
  });

  it('carries no value in any result', () => {
    const all = JSON.stringify(problems({ ...AT, FX_SESSION_SECRET_PREVIOUS: OLD, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(T0 + 90 * DAY) }));
    expect(all).not.toContain(OLD);
    expect(all).not.toContain(NEW);
  });
});
