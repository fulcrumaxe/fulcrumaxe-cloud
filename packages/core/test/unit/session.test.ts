import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  refreshSession,
  sessionCookieAttributes,
  signSession,
  verifySession,
} from '../../src/auth/session.js';

const env = { FX_SESSION_SECRET: 'a'.repeat(32) } as unknown as NodeJS.ProcessEnv;

describe('session cookie attributes', () => {
  it('carries the __Host- prefix, and the three attributes that prefix requires', () => {
    const attrs = sessionCookieAttributes();
    expect(attrs.name).toBe(SESSION_COOKIE_NAME);
    expect(attrs.name.startsWith('__Host-')).toBe(true);
    // __Host- requires Secure, Path=/, and no Domain -- the last of
    // those is "absence of a Domain field", which this type doesn't even
    // have a slot for (see SessionCookieAttributes), so there is nothing
    // to assert false on: the shape itself cannot express setting one.
    expect(attrs.secure).toBe(true);
    expect(attrs.path).toBe('/');
  });

  it('is httpOnly and SameSite=Lax', () => {
    const attrs = sessionCookieAttributes();
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe('lax');
  });

  it('maxAge is the absolute limit, and reads FX_SESSION_ABSOLUTE_SECONDS when set', () => {
    expect(sessionCookieAttributes(env).maxAge).toBe(60 * 60 * 24 * 30);
    const shortEnv = { ...env, FX_SESSION_ABSOLUTE_SECONDS: '3600' } as unknown as NodeJS.ProcessEnv;
    expect(sessionCookieAttributes(shortEnv).maxAge).toBe(3600);
  });
});

describe('signed session tokens', () => {
  it('round-trips userId/accountId through sign then verify, plus session.ts own bookkeeping', async () => {
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, env);
    const verified = await verifySession(token, env);
    expect(verified?.userId).toBe('u1');
    expect(verified?.accountId).toBe('a1');
    expect(verified?.epoch).toBe(0);
    expect(typeof verified?.sid).toBe('string');
    expect(verified?.sid.length).toBeGreaterThan(0);
  });

  it('mints a different sid on every sign-in, even for the same user', async () => {
    const first = await signSession({ userId: 'u1', accountId: 'a1' }, env);
    const second = await signSession({ userId: 'u1', accountId: 'a1' }, env);
    const v1 = await verifySession(first, env);
    const v2 = await verifySession(second, env);
    expect(v1?.sid).not.toBe(v2?.sid);
  });

  it('embeds the caller-supplied epoch', async () => {
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, env, { epoch: 7 });
    const verified = await verifySession(token, env);
    expect(verified?.epoch).toBe(7);
  });

  it('rejects a tampered token', async () => {
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, env);
    const tampered = token.slice(0, -2) + (token.at(-2) === 'A' ? 'B' : 'A') + token.at(-1);
    expect(await verifySession(tampered, env)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const otherEnv = { FX_SESSION_SECRET: 'b'.repeat(32) } as unknown as NodeJS.ProcessEnv;
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, otherEnv);
    expect(await verifySession(token, env)).toBeNull();
  });

  it('rejects garbage input rather than throwing', async () => {
    expect(await verifySession('not-a-jwt', env)).toBeNull();
  });
});

describe('idle and absolute limits (D#37 WS-C criterion 8, fake clock)', () => {
  const start = 1_700_000_000_000; // fixed ms epoch

  it('is valid just before the idle deadline, and rejected just after it', async () => {
    const idleEnv = {
      ...env,
      FX_SESSION_IDLE_SECONDS: '3600', // 1h
      FX_SESSION_ABSOLUTE_SECONDS: String(60 * 60 * 24 * 30),
    } as unknown as NodeJS.ProcessEnv;
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, idleEnv, {
      now: () => start,
    });

    const justBefore = await verifySession(token, idleEnv, () => start + 3599 * 1000);
    expect(justBefore).not.toBeNull();

    const justAfter = await verifySession(token, idleEnv, () => start + 3601 * 1000);
    expect(justAfter).toBeNull();
  });

  it('is rejected past the absolute deadline even when the idle window is longer', async () => {
    const absoluteEnv = {
      ...env,
      FX_SESSION_IDLE_SECONDS: String(60 * 60 * 24 * 30), // 30 days -- won't bind
      FX_SESSION_ABSOLUTE_SECONDS: '3600', // 1h -- the binding limit
    } as unknown as NodeJS.ProcessEnv;
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, absoluteEnv, {
      now: () => start,
    });

    const justBefore = await verifySession(token, absoluteEnv, () => start + 3599 * 1000);
    expect(justBefore).not.toBeNull();

    const justAfter = await verifySession(token, absoluteEnv, () => start + 3601 * 1000);
    expect(justAfter).toBeNull();
  });

  it('defaults to 24h idle / 30 days absolute when unset', async () => {
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, env, { now: () => start });

    const within24h = await verifySession(token, env, () => start + 23 * 60 * 60 * 1000);
    expect(within24h).not.toBeNull();

    const after24h = await verifySession(token, env, () => start + 25 * 60 * 60 * 1000);
    expect(after24h).toBeNull();
  });
});

describe('refreshSession (D#37 WS-C criterion 8, fake clock)', () => {
  const start = 1_700_000_000_000;

  it('slides the idle deadline forward without changing sid/epoch/sessionStart', async () => {
    const idleEnv = {
      ...env,
      FX_SESSION_IDLE_SECONDS: '3600',
      FX_SESSION_ABSOLUTE_SECONDS: String(60 * 60 * 24 * 30),
    } as unknown as NodeJS.ProcessEnv;
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, idleEnv, {
      epoch: 2,
      now: () => start,
    });
    const verified = await verifySession(token, idleEnv, () => start + 3000 * 1000);
    expect(verified).not.toBeNull();

    const refreshed = await refreshSession(verified!, idleEnv, () => start + 3000 * 1000);
    expect(refreshed).not.toBeNull();

    // Without the refresh, +3601s from `start` would be past the 1h idle
    // deadline; the refreshed token, signed at +3000s, is not.
    const reVerified = await verifySession(refreshed!, idleEnv, () => start + 3601 * 1000);
    expect(reVerified).not.toBeNull();
    expect(reVerified?.sid).toBe(verified!.sid);
    expect(reVerified?.epoch).toBe(2);
    expect(reVerified?.sessionStart).toBe(verified!.sessionStart);
  });

  it('refuses to refresh a session already past its absolute limit', async () => {
    const absoluteEnv = {
      ...env,
      FX_SESSION_IDLE_SECONDS: String(60 * 60 * 24 * 30),
      FX_SESSION_ABSOLUTE_SECONDS: '3600',
    } as unknown as NodeJS.ProcessEnv;
    const token = await signSession({ userId: 'u1', accountId: 'a1' }, absoluteEnv, {
      now: () => start,
    });
    const verified = await verifySession(token, absoluteEnv, () => start + 3599 * 1000);
    expect(verified).not.toBeNull();

    const refreshed = await refreshSession(verified!, absoluteEnv, () => start + 3601 * 1000);
    expect(refreshed).toBeNull();
  });
});
