import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, revokeToken } from '@fx/core/src/tokens/service.js';
import { bumpSessionEpoch } from '@fx/core/src/auth/identity.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { AccountPoller, type AccountEventRow, type AccountSubscription } from '../src/sse/poller.js';
import { NudgeListener } from '../src/sse/nudge.js';
import { handleEventsRequest, type StreamDeps } from '../src/sse/stream.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { eventually, openSse, sleep, startServer, type SseConnection, type TestServer } from './helpers/sse.js';

/**
 * D#31 API-5d criteria 6 and 7, with real timers, the real stream handler and a real LISTEN connection:
 * the commit-to-`revoked`-frame latency of an idle account (settle window 1 s, no run in flight, so the
 * idle 10 s poll interval applies), and the C21 settle rule under a nudge.
 */
const SETTLE_MS = 1000;
const CURSOR_KEY = randomBytes(32).toString('base64');

describe('idle-account wake-up latency (API-5d)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;
  let ops: Pool;
  let listener: NudgeListener;
  let servers: { nudged: TestServer; control: TestServer };
  let anchor: AccountSubscription;
  let nudgedPoller: AccountPoller;
  const open: SseConnection[] = [];

  const build = (nudged: boolean): { deps: StreamDeps; poller: AccountPoller } => {
    const poller = new AccountPoller({ pool: app, platformOpsPool: ops, settleMs: SETTLE_MS, nudgeSource: nudged ? listener : null });
    return { deps: { pool: app, platformOpsPool: ops, poller }, poller };
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.API_DATABASE_URL_APP_USER!);
    ops = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = CURSOR_KEY;
    listener = new NudgeListener({ url: process.env.API_DATABASE_URL_PLATFORM_OPS!, probePool: ops, log: () => {} });
    const nudged = build(true);
    const control = build(false);
    nudgedPoller = nudged.poller;
    servers = {
      nudged: await startServer((req) => handleEventsRequest(req, { kind: 'account' }, nudged.deps)),
      control: await startServer((req) => handleEventsRequest(req, { kind: 'account' }, control.deps)),
    };
    // Holding one feed keeps the listener open for the whole suite; wait until its probe has passed.
    const seed = await seedAccountWithMember(admin);
    anchor = nudged.poller.subscribe(seed.accountId, 0n, { onEvents: () => {}, onFail: () => {} });
    await eventually(() => listener.status() === 'connected');
  });

  afterEach(() => {
    for (const c of open.splice(0)) c.abort();
  });

  afterAll(async () => {
    anchor.unsubscribe();
    listener.stop();
    await servers.nudged.close();
    await servers.control.close();
    for (const k of ['FX_SESSION_SECRET', 'FX_CURSOR_KEY_V1']) delete process.env[k];
    admin.release();
    await adminPool.end();
    await app.end();
    await ops.end();
  });

  async function connect(srv: TestServer, headers: Record<string, string>): Promise<SseConnection> {
    const c = await openSse(`${srv.url}/api/v1/events`, headers);
    open.push(c);
    await c.waitFor((f) => f.comment === 'ok');
    await sleep(300); // the subscribe-time read is done; the feed is now idle until its next 10 s tick
    return c;
  }

  const sessionHeaders = async (id: { userId: string; accountId: string }): Promise<Record<string, string>> => ({
    cookie: `${SESSION_COOKIE_NAME}=${await signSession(id, process.env, { epoch: 0 })}`,
  });

  async function signOutEverywhereMs(srv: TestServer): Promise<number> {
    const id = await seedAccountWithMember(admin, { role: 'owner' });
    const stream = await connect(srv, await sessionHeaders(id));
    await bumpSessionEpoch(ops, id.userId, { emitSessionRevoked: true });
    const committed = Date.now();
    await stream.waitFor((f) => f.event === 'revoked', 15_000);
    return Date.now() - committed;
  }

  it('sign-out-everywhere reaches an idle session stream: p95 <= 3 s and max <= 5 s over 20 runs', async () => {
    const timings: number[] = [];
    for (let i = 0; i < 20; i++) timings.push(await signOutEverywhereMs(servers.nudged));
    console.log(`API-5d session.revoked latency ms (20 runs): ${timings.join(', ')}`);
    const sorted = [...timings].sort((a, b) => a - b);
    expect(sorted[Math.ceil(0.95 * sorted.length) - 1]).toBeLessThanOrEqual(3_000);
    expect(sorted[sorted.length - 1]).toBeLessThanOrEqual(5_000);
  }, 120_000);

  it('a token stream whose own token is revoked hears it within 3 s (5 runs)', async () => {
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      const plaintext = generateToken();
      const token = await insertApiToken(app, {
        accountId: id.accountId,
        createdBy: id.userId,
        tokenHash: hashToken(plaintext),
        displayHint: 'fxat_...test',
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });
      const stream = await connect(servers.nudged, { authorization: `Bearer ${plaintext}` });
      expect(await revokeToken(app, id, token.id, 'user_requested')).toBe(true);
      const committed = Date.now();
      await stream.waitFor((f) => f.event === 'revoked', 15_000);
      timings.push(Date.now() - committed);
    }
    console.log(`API-5d api_token.revoked latency ms (5 runs): ${timings.join(', ')}`);
    for (const t of timings) expect(t).toBeLessThanOrEqual(3_000);
  }, 60_000);

  it('control: with the nudge source off, the same sign-out takes more than 5 s', async () => {
    const ms = await signOutEverywhereMs(servers.control);
    console.log(`API-5d control (nudge off) latency ms: ${ms}`);
    expect(ms).toBeGreaterThan(5_000);
  }, 60_000);

  it('a NOTIFY arriving while the newest row is inside the settle window does not deliver it early: it arrives once, after the window, in order', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    const poller = nudgedPoller;
    const got: AccountEventRow[] = [];
    const sub = poller.subscribe(accountId, 0n, { onEvents: (r) => got.push(...r), onFail: () => {} });
    try {
      await sleep(300);
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const { rows } = await admin.query<{ id: string }>(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, 'pr.opened', '{}') RETURNING id`, [accountId]);
        ids.push(rows[0]!.id);
      }
      const inserted = Date.now();
      await admin.query(`SELECT pg_notify('fx_account_nudge', $1)`, [accountId]); // no trigger for pr.opened: a manual, early notification
      await sleep(SETTLE_MS - 200);
      expect(got).toEqual([]); // still inside the window
      await eventually(() => got.length === 2, 5_000);
      expect(Date.now() - inserted).toBeGreaterThanOrEqual(SETTLE_MS);
      expect(got.map((r) => r.id)).toEqual(ids);
      await sleep(500);
      expect(got).toHaveLength(2); // once
    } finally {
      sub.unsubscribe();
    }
  }, 30_000);
});
