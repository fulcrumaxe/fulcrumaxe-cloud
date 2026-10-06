import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { openCursor, sealCursor, CURSOR_RETENTION_MS } from '../src/sse/cursor.js';
import { accountEventsPage } from '../src/sse/json.js';
import { AccountPoller, WATERMARK_CHUNK, readSettledEventsAfter, settleMsFromEnv, DEFAULT_SETTLE_MS, type AccountEventRow } from '../src/sse/poller.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ManualClock } from './helpers/manual-clock.js';
import { countingPool, eventually, sleep } from './helpers/sse.js';

/**
 * Fix round 1 for D#31 API-5a:
 *   M1 (CWE-362)  a lower serial whose transaction commits after a higher one has been read must still
 *                 be delivered, in order, by BOTH the poller and the JSON pages;
 *   S2 (CWE-672)  a cursor's staleness is the age of its POSITIONED EVENT, not of the string;
 *   S3            the watermark call is chunked to the definer's 1,000-id limit.
 * The suite runs with FX_EVENTS_SETTLE_MS=0 (vitest.config.ts); every test here that cares passes an
 * explicit settle window.
 */
const KEY = randomBytes(32).toString('base64');
const ENV = { FX_CURSOR_KEY_V1: KEY };
const SETTLE_MS = 400;

describe('D#31 API-5a fix round 1: settled reads, event-time staleness, chunked watermarks', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;
  let ops: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.API_DATABASE_URL_APP_USER!);
    ops = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await app.end();
    await ops.end();
  });

  async function ev(accountId: string, createdAt?: Date): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO domain_events (account_id, type, payload, created_at) VALUES ($1, 'pr.opened', '{}', COALESCE($2, now())) RETURNING id`,
      [accountId, createdAt ?? null],
    );
    return rows[0]!.id;
  }

  /** Opens a transaction on its own connection and inserts one event WITHOUT committing. */
  async function openWriter(accountId: string, type: string): Promise<{ client: PoolClient; id: string }> {
    const client = await app.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO domain_events (account_id, type, payload) VALUES ($1, $2, '{}') RETURNING id`,
      [accountId, type],
    );
    return { client, id: rows[0]!.id };
  }

  async function commitAndRelease(w: { client: PoolClient }): Promise<void> {
    await w.client.query('COMMIT');
    w.client.release();
  }

  describe('M1: commit-order event loss', () => {
    it('JSON paging: the slow lower serial that commits after the fast higher one is delivered, in order, and nothing is lost', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const start = await accountEventsPage(app, accountId, { limit: 50, settleMs: SETTLE_MS }, Date.now(), ENV);

      const slow = await openWriter(accountId, 'run.started'); // takes the LOWER serial, commits last
      const fast = await openWriter(accountId, 'run.succeeded');
      await commitAndRelease(fast);

      // The fast row is visible but younger than the settle window: it is held back, not skipped past.
      const p1 = await accountEventsPage(app, accountId, { cursor: start.next_cursor, limit: 50, settleMs: SETTLE_MS }, Date.now(), ENV);
      expect(p1.data).toEqual([]);

      await commitAndRelease(slow);
      await sleep(SETTLE_MS + 150);

      const p2 = await accountEventsPage(app, accountId, { cursor: p1.next_cursor, limit: 50, settleMs: SETTLE_MS }, Date.now(), ENV);
      expect(p2.data.map((d) => d.id)).toEqual([slow.id, fast.id]);
      const p3 = await accountEventsPage(app, accountId, { cursor: p2.next_cursor, limit: 50, settleMs: SETTLE_MS }, Date.now(), ENV);
      expect(p3.data).toEqual([]);
    });

    it('poller: the same interleaving delivers both events, lower serial first, exactly once', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const clock = new ManualClock(Date.now(), 30);
      const poller = new AccountPoller({ pool: app, platformOpsPool: ops, clock, settleMs: SETTLE_MS });
      const got: AccountEventRow[] = [];
      poller.subscribe(accountId, await poller.headSeq(accountId), { onEvents: (r) => got.push(...r), onFail: () => {} });
      await clock.advance(0);

      const slow = await openWriter(accountId, 'run.started');
      const fast = await openWriter(accountId, 'run.succeeded');
      await commitAndRelease(fast);

      await clock.advance(10_000); // the watermark has moved past the fast row, which is still inside the window
      expect(got).toEqual([]);

      await commitAndRelease(slow);
      await sleep(SETTLE_MS + 150);
      await clock.advance(10_000);
      await eventually(() => got.length >= 2);
      await clock.advance(10_000);
      expect(got.map((r) => r.id)).toEqual([slow.id, fast.id]);
      expect(got[0]!.seq < got[1]!.seq).toBe(true);
    });

    it('a held row costs at most one read per tick (no spinning on the same held rows within a tick)', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const clock = new ManualClock(Date.now(), 30);
      const counted = countingPool(app);
      const opsCounted = countingPool(ops);
      const poller = new AccountPoller({ pool: counted.pool, platformOpsPool: opsCounted.pool, clock, settleMs: 60_000, idleIntervalMs: 500, activeIntervalMs: 500 });
      poller.subscribe(accountId, 0n, { onEvents: () => {}, onFail: () => {} });
      await ev(accountId);
      await clock.advance(0);
      expect(counted.count(/FROM domain_events/)).toBe(1); // one read, one held row, not MAX_READS_PER_TICK of them
      await clock.advance(1_500);
      const ticks = opsCounted.count(/domain_event_watermarks/);
      expect(ticks).toBeGreaterThan(1);
      expect(counted.count(/FROM domain_events/)).toBe(ticks);
    });

    it('readSettledEventsAfter stops at the first young row even when older rows follow it', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      // The settle clock is inserted_at, which a caller cannot set (fix round 2): age the first row for real.
      const a = await ev(accountId);
      await sleep(SETTLE_MS + 150);
      const young = await ev(accountId); // inserted just now: inside the window
      const old = await ev(accountId, new Date(Date.now() - 60_000)); // higher serial; a backdated created_at does not settle it
      const read = await readSettledEventsAfter(app, accountId, 0n, 50, SETTLE_MS);
      expect(read.rows.map((r) => r.id)).toEqual([a]);
      expect(read.held).toBe(true);
      expect(read.rows.map((r) => r.id)).not.toContain(young);
      expect(read.rows.map((r) => r.id)).not.toContain(old);
      const open = await readSettledEventsAfter(app, accountId, 0n, 50, 0);
      expect(open.rows.map((r) => r.id)).toEqual([a, young, old]);
      expect(open.held).toBe(false);
    });

    it('FX_EVENTS_SETTLE_MS: unset means the default (full parsing table: event-settle-r2.test.ts)', () => {
      expect(settleMsFromEnv({})).toBe(DEFAULT_SETTLE_MS);
      expect(settleMsFromEnv({ NODE_ENV: 'test', FX_EVENTS_SETTLE_MS: '0' })).toBe(0);
      expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: '1500' })).toBe(1500);
    });
  });

  describe('S2: staleness follows the positioned event, not the cursor string', () => {
    it('a full page is anchored to its last event\'s created_at; a lagging client is told to resync even though every cursor it holds was minted just now', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const eightDays = 8 * 24 * 60 * 60 * 1000;
      const old = await ev(accountId, new Date(Date.now() - eightDays));
      await ev(accountId); // a second event, so the limit-1 page is full
      const zero = sealCursor({ accountId, serial: 0n, issuedAtMs: Date.now() }, ENV);

      const page = await accountEventsPage(app, accountId, { cursor: zero, limit: 1, settleMs: 0 }, Date.now(), ENV);
      expect(page.data.map((d) => d.id)).toEqual([old]);
      const claims = openCursor(page.next_cursor, accountId, ENV);
      expect(Date.now() - claims.issuedAtMs).toBeGreaterThan(CURSOR_RETENTION_MS); // sealed with the EVENT's time

      const next = await accountEventsPage(app, accountId, { cursor: page.next_cursor, limit: 1, settleMs: 0 }, Date.now(), ENV);
      expect(next.resync).toBe(true);
      expect(next.data).toEqual([]);
      // ...and the resync cursor is positioned at now, so the client can carry on after refetching state.
      const after = await accountEventsPage(app, accountId, { cursor: next.next_cursor, limit: 50, settleMs: 0 }, Date.now(), ENV);
      expect(after.resync).toBeUndefined();
    });

    it('a short page that reached the end moves the position time to now, so an idle account\'s cursor does not go stale while polled', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      await ev(accountId, new Date(Date.now() - 60_000));
      const zero = sealCursor({ accountId, serial: 0n, issuedAtMs: Date.now() }, ENV);
      const now = Date.now();
      const page = await accountEventsPage(app, accountId, { cursor: zero, limit: 50, settleMs: 0 }, now, ENV);
      expect(openCursor(page.next_cursor, accountId, ENV).issuedAtMs).toBe(now);
      const echo = await accountEventsPage(app, accountId, { cursor: page.next_cursor, limit: 50, settleMs: 0 }, now + 1000, ENV);
      expect(echo.data).toEqual([]);
      expect(openCursor(echo.next_cursor, accountId, ENV).issuedAtMs).toBe(now + 1000);
    });
  });

  describe('S3: the watermark call is chunked', () => {
    it('1,500 due accounts are polled in calls of at most 1,000 ids, every chunk is answered, and an account in the second chunk still receives its event', async () => {
      const real = await seedAccountWithMember(admin);
      const ops2 = countingPool(ops);
      const clock = new ManualClock(Date.now(), 30);
      const poller = new AccountPoller({ pool: app, platformOpsPool: ops2.pool, clock, settleMs: 0 });
      const failures: unknown[] = [];
      for (let i = 0; i < 1500 - 1; i++) {
        poller.subscribe(randomUUID(), 0n, { onEvents: () => {}, onFail: (e) => failures.push(e) });
      }
      const got: AccountEventRow[] = [];
      poller.subscribe(real.accountId, 0n, { onEvents: (r) => got.push(...r), onFail: (e) => failures.push(e) });
      const id = await ev(real.accountId);

      await clock.advance(0);
      await eventually(() => got.length === 1);
      expect(got[0]!.id).toBe(id);
      expect(failures).toEqual([]);

      const calls = ops2.log.filter((l) => /domain_event_watermarks/.test(l.sql));
      expect(calls.length).toBe(2);
      const sizes = calls.map((c) => (c.params![0] as string[]).length);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(WATERMARK_CHUNK);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(1500);
      expect(poller.stats().subscribers).toBe(1500);
    });
  });
});
