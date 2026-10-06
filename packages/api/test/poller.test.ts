import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { AccountPoller, headSeq, readEventsAfter, type AccountEventRow } from '../src/sse/poller.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ManualClock } from './helpers/manual-clock.js';
import { countingPool, eventually } from './helpers/sse.js';

/**
 * D#31 API-5 criterion 7, at the poller itself (no HTTP): ordered
 * delivery from an arbitrary position, one shared watermark query per
 * tick, tenant reads only on movement, and hard per-account separation.
 * `sse.test.ts` drives the same poller through 20 real streams.
 */
describe('AccountPoller (D#31 API-5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function insertEvents(accountId: string, n: number, type = 'pr.opened'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await admin.query<{ id: string }>(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, $2, '{}') RETURNING id`, [accountId, type]);
      ids.push(rows[0]!.id);
    }
    return ids;
  }

  function collect(): { rows: AccountEventRow[]; handlers: { onEvents(r: AccountEventRow[]): void; onFail(e: unknown): void }; failed: unknown[] } {
    const rows: AccountEventRow[] = [];
    const failed: unknown[] = [];
    return { rows, failed, handlers: { onEvents: (r) => rows.push(...r), onFail: (e) => failed.push(e) } };
  }

  it('delivers only rows after the subscriber\'s position, oldest first, and catches up across batch boundaries (450 rows > 2 batches of 200)', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    const ids = await insertEvents(accountId, 450);
    // Numeric order across digit boundaries (9 < 10 < 100): a text sort would put '10' before '9'.
    const visible = await readEventsAfter(appUserPool, accountId, 0n, 1000);
    expect(visible.map((r) => r.id)).toEqual(ids);
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: appUserPool, platformOpsPool, clock });
    clock.track(poller);
    const all = collect();
    const tail = collect();
    const midpoint = (await readEventsAfter(appUserPool, accountId, 0n, 500))[99]!.seq;
    poller.subscribe(accountId, 0n, all.handlers);
    poller.subscribe(accountId, midpoint, tail.handlers);
    await clock.advance(0);
    await eventually(() => all.rows.length === 450);
    expect(all.failed).toEqual([]);
    expect(all.rows.map((r) => r.id)).toEqual(ids);
    expect(tail.rows.map((r) => r.id)).toEqual(ids.slice(100));
    const seqs = all.rows.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => (x < y ? -1 : 1)));
  });

  it('a subscriber starting at head sees nothing old and everything new, once', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    await insertEvents(accountId, 3);
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: appUserPool, platformOpsPool, clock });
    clock.track(poller);
    const sub = collect();
    poller.subscribe(accountId, await headSeq(appUserPool, accountId), sub.handlers);
    await clock.advance(0);
    expect(sub.rows).toHaveLength(0);
    const fresh = await insertEvents(accountId, 2);
    await clock.advance(10_000);
    await clock.advance(10_000);
    expect(sub.rows.map((r) => r.id)).toEqual(fresh);
  });

  it('never hands one account\'s rows to another account\'s subscriber, even when both watermarks move in the same tick', async () => {
    const a = await seedAccountWithMember(admin);
    const b = await seedAccountWithMember(admin);
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: appUserPool, platformOpsPool, clock });
    clock.track(poller);
    const subA = collect();
    const subB = collect();
    poller.subscribe(a.accountId, 0n, subA.handlers);
    poller.subscribe(b.accountId, 0n, subB.handlers);
    const idsA: string[] = [];
    const idsB: string[] = [];
    for (let i = 0; i < 6; i++) {
      idsA.push(...(await insertEvents(a.accountId, 1)));
      idsB.push(...(await insertEvents(b.accountId, 1)));
    }
    await clock.advance(10_000);
    expect(subA.rows.map((r) => r.id)).toEqual(idsA);
    expect(subB.rows.map((r) => r.id)).toEqual(idsB);
    // The rows themselves carry no other account's data.
    expect(await readEventsAfter(appUserPool, a.accountId, 0n, 100)).toHaveLength(6);
  });

  it('one watermark call serves every due account in the tick, and the read runs only for the account whose watermark moved', async () => {
    const a = await seedAccountWithMember(admin);
    const b = await seedAccountWithMember(admin);
    const c = await seedAccountWithMember(admin);
    const clock = new ManualClock(Date.now());
    const app = countingPool(appUserPool);
    const ops = countingPool(platformOpsPool);
    const poller = new AccountPoller({ pool: app.pool, platformOpsPool: ops.pool, clock });
    clock.track(poller);
    const subs = [a, b, c].map((acct) => {
      const s = collect();
      poller.subscribe(acct.accountId, 0n, s.handlers);
      return s;
    });
    await clock.advance(0);
    expect(ops.count(/domain_event_watermarks/)).toBe(1);
    expect((ops.log[0]!.params as string[][])[0]!.sort()).toEqual([a.accountId, b.accountId, c.accountId].sort());
    expect(app.count(/FROM domain_events/)).toBe(0);

    await insertEvents(b.accountId, 1);
    app.reset();
    await clock.advance(10_000);
    expect(app.count(/FROM domain_events/)).toBe(1);
    expect(subs.map((s) => s.rows.length)).toEqual([0, 1, 0]);
  });

  it('unsubscribing the last subscriber removes the feed and disarms the timer; an unrelated subscriber is unaffected', async () => {
    const a = await seedAccountWithMember(admin);
    const b = await seedAccountWithMember(admin);
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: appUserPool, platformOpsPool, clock });
    clock.track(poller);
    const subA = poller.subscribe(a.accountId, 0n, collect().handlers);
    const keep = collect();
    const subB = poller.subscribe(b.accountId, 0n, keep.handlers);
    expect(poller.stats()).toMatchObject({ feeds: 2, subscribers: 2 });
    subA.unsubscribe();
    expect(poller.stats()).toMatchObject({ feeds: 1, subscribers: 1 });
    const [id] = await insertEvents(b.accountId, 1);
    await clock.advance(10_000);
    expect(keep.rows.map((r) => r.id)).toEqual([id]);
    subB.unsubscribe();
    subB.unsubscribe(); // idempotent
    expect(poller.stats()).toEqual({ feeds: 0, subscribers: 0, timerArmed: false });
    expect(clock.pendingTimers()).toBe(0);
  });

  it('an unknown account id gets a zero watermark, not a failure (the definer neither errors nor leaks)', async () => {
    const { rows } = await platformOpsPool.query(`SELECT * FROM domain_event_watermarks($1::uuid[])`, [[randomUUID()]]);
    expect(rows).toEqual([{ account_id: expect.any(String), max_seq: '0', run_active: false }]);
  });

  it('domain_event_watermarks caps its input at 1,000 ids and refuses NULL', async () => {
    const many = Array.from({ length: 1001 }, () => randomUUID());
    await expect(platformOpsPool.query(`SELECT * FROM domain_event_watermarks($1::uuid[])`, [many])).rejects.toThrow(/at most 1000/);
    await expect(platformOpsPool.query(`SELECT * FROM domain_event_watermarks(NULL)`)).rejects.toThrow(/must not be null/);
  });

  it('run_active is true only while a run is non-terminal', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    const runId = randomUUID();
    const flag = async () => (await platformOpsPool.query(`SELECT run_active FROM domain_event_watermarks($1::uuid[])`, [[accountId]])).rows[0].run_active as boolean;
    expect(await flag()).toBe(false);
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', 'pending')`, [runId, accountId]);
    expect(await flag()).toBe(true);
    for (const terminal of ['succeeded', 'failed', 'cancelled', 'timed_out', 'killed_spend', 'refused_spend']) {
      await admin.query(`UPDATE agent_runs SET status = $2 WHERE id = $1`, [runId, terminal]);
      expect(await flag(), terminal).toBe(false);
    }
    await admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [runId]);
    expect(await flag()).toBe(true);
  });
});
