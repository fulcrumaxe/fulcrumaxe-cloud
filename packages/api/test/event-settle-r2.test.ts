import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { emitDomainEvent } from '@fx/core/src/domain-events/emit.js';
import { accountEventsPage } from '../src/sse/json.js';
import {
  AccountPoller,
  DEFAULT_SETTLE_MS,
  MAX_SETTLE_MS,
  MIN_SETTLE_MS,
  settleMsFromEnv,
  type AccountEventRow,
} from '../src/sse/poller.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ManualClock } from './helpers/manual-clock.js';
import { eventually, sleep } from './helpers/sse.js';

/**
 * Fix round 2 for D#31 API-5a:
 *   MUST 1 (CWE-362)  the settle clock is domain_events.inserted_at -- the database clock at the INSERT that
 *                     drew `seq`, not settable by a caller -- so neither a long-running writer whose
 *                     transaction started early (case B) nor a producer-supplied backdated createdAt
 *                     (case C) can make a fresh row look settled;
 *   MUST 2 (CWE-1188) FX_EVENTS_SETTLE_MS is digits only, within [1000, 60000] outside NODE_ENV=test.
 * A transaction held open LONGER than the window after its INSERT is the documented residual and has no
 * test that expects it to work.
 */
const KEY = randomBytes(32).toString('base64');
const ENV = { FX_CURSOR_KEY_V1: KEY };
const W = 400;

describe('D#31 API-5a fix round 2: caller-proof settle clock', () => {
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

  async function begin(accountId: string): Promise<PoolClient> {
    const c = await app.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
    await c.query('SELECT now()'); // pins now() (the transaction start) here
    return c;
  }
  async function ins(c: PoolClient, accountId: string, type: string): Promise<{ id: string; seq: string }> {
    const { rows } = await c.query<{ id: string; seq: string }>(
      `INSERT INTO domain_events (account_id, type, payload) VALUES ($1, $2, '{}') RETURNING id, seq::text`,
      [accountId, type],
    );
    return rows[0]!;
  }
  async function commit(c: PoolClient): Promise<void> {
    await c.query('COMMIT');
    c.release();
  }
  async function drainJson(accountId: string, cursor: string): Promise<{ ids: string[]; cursor: string }> {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await accountEventsPage(app, accountId, { cursor, limit: 50, settleMs: W }, Date.now(), ENV);
      ids.push(...p.data.map((d) => d.id));
      cursor = p.next_cursor;
    }
    return { ids, cursor };
  }
  async function startPoller(accountId: string): Promise<{ clock: ManualClock; got: AccountEventRow[] }> {
    const clock = new ManualClock(Date.now(), 30);
    const poller = new AccountPoller({ pool: app, platformOpsPool: ops, clock, settleMs: W });
    const got: AccountEventRow[] = [];
    poller.subscribe(accountId, await poller.headSeq(accountId), { onEvents: (r) => got.push(...r), onFail: () => {} });
    await clock.advance(0);
    return { clock, got };
  }

  it('B (JSON + poller): a higher serial whose transaction STARTED more than a window ago does not hide a lower serial', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    const start = await accountEventsPage(app, accountId, { limit: 50, settleMs: W }, Date.now(), ENV);
    const { clock, got } = await startPoller(accountId);

    const f = await begin(accountId); // long-running writer: its now() is its start
    await sleep(W + 300);
    const s = await begin(accountId); // ordinary short writer
    const short = await ins(s, accountId, 'pr.opened');
    const late = await ins(f, accountId, 'run.succeeded');
    expect(BigInt(short.seq) < BigInt(late.seq)).toBe(true);
    await commit(f);

    const p1 = await drainJson(accountId, start.next_cursor);
    expect(p1.ids).toEqual([]); // `late` is held (fresh insert), `short` is not visible yet
    await clock.advance(10_000);
    expect(got).toEqual([]);

    await commit(s);
    await sleep(W + 300);
    const p2 = await drainJson(accountId, p1.cursor);
    expect(p2.ids).toEqual([short.id, late.id]);
    await clock.advance(10_000);
    await eventually(() => got.length >= 2);
    await clock.advance(10_000);
    expect(got.map((r) => r.id)).toEqual([short.id, late.id]);
  });

  it('C (JSON + poller): emitDomainEvent with a createdAt 40 s in the past is still held until its insert has aged', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    const start = await accountEventsPage(app, accountId, { limit: 50, settleMs: W }, Date.now(), ENV);
    const { clock, got } = await startPoller(accountId);

    const s = await begin(accountId);
    const short = await ins(s, accountId, 'pr.opened');
    const f = await begin(accountId);
    const backdated = await emitDomainEvent(f, {
      type: 'webhook_endpoint.disabled',
      accountId,
      subjectId: 'ep',
      payload: { endpointId: 'ep', reason: 'failing' },
      createdAt: new Date(Date.now() - 40_000),
    });
    await commit(f);

    const p1 = await drainJson(accountId, start.next_cursor);
    expect(p1.ids).toEqual([]);
    await clock.advance(10_000);
    expect(got).toEqual([]);

    await commit(s);
    await sleep(W + 300);
    const p2 = await drainJson(accountId, p1.cursor);
    expect(p2.ids).toEqual([short.id, backdated.id]);
    await clock.advance(10_000);
    await eventually(() => got.length >= 2);
    await clock.advance(10_000);
    expect(got.map((r) => r.id)).toEqual([short.id, backdated.id]);
  });

  it('D (control): both writers short -- nothing lost, in order', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    const start = await accountEventsPage(app, accountId, { limit: 50, settleMs: W }, Date.now(), ENV);
    const s = await begin(accountId);
    const slow = await ins(s, accountId, 'run.started');
    const f = await begin(accountId);
    const fast = await ins(f, accountId, 'run.succeeded');
    await commit(f);
    const p1 = await drainJson(accountId, start.next_cursor);
    await sleep(100);
    await commit(s);
    await sleep(W + 300);
    const p2 = await drainJson(accountId, p1.cursor);
    expect([...p1.ids, ...p2.ids]).toEqual([slow.id, fast.id]);
  });
});

describe('FX_EVENTS_SETTLE_MS parsing (CWE-1188)', () => {
  const bad = ['0', '00', '0e0', '0.5', '0x10', '1e12', '-1', 'NaN', 'abc', 'Infinity', '', ' 7 ', '999', '60001', '99999999999999999999'];
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it.each(bad)('production: %j falls back to the default', (v) => {
    expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: v })).toBe(DEFAULT_SETTLE_MS);
  });

  it('production: only plain digits inside [floor, ceiling] are accepted', () => {
    expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: String(MIN_SETTLE_MS) })).toBe(MIN_SETTLE_MS);
    expect(settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: String(MAX_SETTLE_MS) })).toBe(MAX_SETTLE_MS);
    expect(settleMsFromEnv({ FX_EVENTS_SETTLE_MS: '5000' })).toBe(5000); // NODE_ENV unset behaves as production
    expect(settleMsFromEnv({ FX_EVENTS_SETTLE_MS: '0' })).toBe(DEFAULT_SETTLE_MS);
  });

  it('test: the floor is waived (0 disables the hold-back) but the syntax and ceiling still hold', () => {
    const t = (v: string) => settleMsFromEnv({ NODE_ENV: 'test', FX_EVENTS_SETTLE_MS: v });
    expect(t('0')).toBe(0);
    expect(t('00')).toBe(0);
    expect(t('250')).toBe(250);
    for (const v of ['0e0', '0.5', '0x10', '1e12', '-1', 'NaN', 'abc', 'Infinity', '', '60001']) {
      expect(t(v), v).toBe(DEFAULT_SETTLE_MS);
    }
  });

  it('logs a rejected value once, not on every call', () => {
    const before = warn.mock.calls.length;
    for (let i = 0; i < 5; i++) settleMsFromEnv({ NODE_ENV: 'production', FX_EVENTS_SETTLE_MS: 'once-only-value' });
    expect(warn.mock.calls.length - before).toBe(1);
  });
});
