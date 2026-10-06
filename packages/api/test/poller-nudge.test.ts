import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { AccountPoller, NUDGE_MIN_TICK_GAP_MS, type AccountEventRow } from '../src/sse/poller.js';
import { LISTENER_IDLE_CLOSE_MS, NudgeListener, PROBE_TIMEOUT_MS, type NudgeHandlers, type NudgeSource } from '../src/sse/nudge.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ManualClock } from './helpers/manual-clock.js';
import { countingPool, eventually } from './helpers/sse.js';

/** D#31 API-5d criteria 2-5: the listener, the poller's nudge(), bounded load and tenant isolation. */

class FakeSource implements NudgeSource {
  handlers: NudgeHandlers | undefined;
  starts = 0;
  stops = 0;
  start(h: NudgeHandlers): void {
    this.handlers = h;
    this.starts++;
  }
  stop(): void {
    this.stops++;
  }
}

/** Pools that answer the watermark call with "nothing has moved" and refuse any tenant read. */
function fakePools(): { pool: Pool; ops: Pool; watermarkCalls: string[][] } {
  const watermarkCalls: string[][] = [];
  const ops = {
    query: async (_sql: string, params: string[][]) => {
      watermarkCalls.push(params[0]!);
      return { rows: params[0]!.map((id) => ({ account_id: id, max_seq: '0', run_active: false })) };
    },
  } as unknown as Pool;
  const pool = {
    query: async () => {
      throw new Error('tenant read on the fake pool');
    },
    connect: async () => {
      throw new Error('tenant read on the fake pool');
    },
  } as unknown as Pool;
  return { pool, ops, watermarkCalls };
}

/**
 * `clock.advance` only waits a fixed slice of REAL time for the database round trips a fired timer started, which
 * a loaded machine outruns. A poller holds no timer while a tick is in flight and re-arms one as its last act, so
 * "a timer is pending again" is the tick's real completion signal: wait for that instead of guessing a duration.
 */
const tickFinished = (clock: ManualClock): Promise<boolean> => eventually(() => clock.pendingTimers() > 0);

const handlers = { onEvents: () => {}, onFail: () => {} };

describe('AccountPoller.nudge (D#31 API-5d)', () => {
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

  const event = (accountId: string, type = 'api_token.revoked') =>
    admin.query<{ id: string }>(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, $2, '{}') RETURNING id`, [accountId, type]);

  function build(source: NudgeSource | null, clock: ManualClock, pools = { pool: appUserPool, ops: platformOpsPool }, settleMs = 1000): AccountPoller {
    return new AccountPoller({ pool: pools.pool, platformOpsPool: pools.ops, clock, settleMs, nudgeSource: source });
  }

  it('drops a payload that is not an account id, and an account with no feed here, without a query', async () => {
    const fake = fakePools();
    const source = new FakeSource();
    const clock = new ManualClock(Date.now());
    const poller = build(source, clock, { pool: fake.pool, ops: fake.ops });
    poller.subscribe(randomUUID(), 0n, handlers);
    await clock.advance(0);
    fake.watermarkCalls.length = 0;
    for (const junk of ['', 'probe:abc', 'not-a-uuid', "x'; DROP TABLE domain_events;--", randomUUID()]) source.handlers!.onNudge(junk);
    await clock.advance(5_000);
    expect(fake.watermarkCalls).toEqual([]);
  });

  it('schedules the next read no earlier than one settle window + 100 ms after the notification', async () => {
    const fake = fakePools();
    const source = new FakeSource();
    const clock = new ManualClock(Date.now());
    const poller = build(source, clock, { pool: fake.pool, ops: fake.ops });
    const id = randomUUID();
    poller.subscribe(id, 0n, handlers);
    await clock.advance(0);
    fake.watermarkCalls.length = 0;
    source.handlers!.onNudge(id);
    await clock.advance(1_099);
    expect(fake.watermarkCalls).toHaveLength(0);
    await clock.advance(1 + NUDGE_MIN_TICK_GAP_MS);
    expect(fake.watermarkCalls).toEqual([[id]]);
  });

  it('nudges that arrive while one is pending are absorbed: one nudged read, not one per nudge', async () => {
    const fake = fakePools();
    const source = new FakeSource();
    const clock = new ManualClock(Date.now());
    const poller = build(source, clock, { pool: fake.pool, ops: fake.ops });
    const id = randomUUID();
    poller.subscribe(id, 0n, handlers);
    await clock.advance(0);
    fake.watermarkCalls.length = 0;
    for (let i = 0; i < 10; i++) {
      source.handlers!.onNudge(id);
      await clock.advance(100);
    }
    await clock.advance(4_000);
    expect(fake.watermarkCalls).toHaveLength(1);
  });

  it('500 nudges for one account inside a second cost at most 2 watermark calls and 2 tenant reads', async () => {
    const { accountId } = await seedAccountWithMember(admin);
    const app = countingPool(appUserPool);
    const ops = countingPool(platformOpsPool);
    const source = new FakeSource();
    const clock = new ManualClock(Date.now(), 10);
    const poller = build(source, clock, { pool: app.pool, ops: ops.pool });
    poller.subscribe(accountId, 0n, handlers);
    await clock.advance(0);
    await tickFinished(clock); // the subscribe tick's round trips finish before the counters reset
    await event(accountId);
    app.reset();
    ops.reset();
    for (let i = 0; i < 500; i++) {
      source.handlers!.onNudge(accountId);
      if (i % 5 === 4) await clock.advance(10);
    }
    await clock.advance(1_500);
    await tickFinished(clock); // read the counters only once no tick is still in flight
    expect(ops.count(/domain_event_watermarks/)).toBeLessThanOrEqual(2);
    expect(app.count(/FROM domain_events/)).toBeLessThanOrEqual(2);
  });

  it('a storm of 100 accounts nudged every 10 ms for 10 s makes at most 42 watermark calls and then settles to one armed timer', async () => {
    const fake = fakePools();
    const source = new FakeSource();
    const clock = new ManualClock(Date.now());
    const poller = build(source, clock, { pool: fake.pool, ops: fake.ops });
    const ids = Array.from({ length: 100 }, () => randomUUID());
    for (const id of ids) poller.subscribe(id, 0n, handlers);
    await clock.advance(0);
    fake.watermarkCalls.length = 0;
    for (let step = 0; step < 1_000; step++) {
      for (const id of ids) source.handlers!.onNudge(id);
      await clock.advance(10);
    }
    expect(fake.watermarkCalls.length).toBeLessThanOrEqual(42);
    expect(fake.watermarkCalls.length).toBeGreaterThan(0);
    await clock.advance(3_000);
    expect(poller.stats()).toMatchObject({ feeds: 100, timerArmed: true });
    expect(clock.pendingTimers()).toBe(1);
  });

  it('a nudge for account X delivers nothing to Y and reads nothing under Y; a forged nudge on a quiet account costs one watermark call', async () => {
    const x = await seedAccountWithMember(admin);
    const y = await seedAccountWithMember(admin);
    const app = countingPool(appUserPool);
    const ops = countingPool(platformOpsPool);
    const source = new FakeSource();
    const clock = new ManualClock(Date.now(), 10);
    const poller = build(source, clock, { pool: app.pool, ops: ops.pool }, 0);
    const gotX: AccountEventRow[] = [];
    const gotY: AccountEventRow[] = [];
    poller.subscribe(x.accountId, 0n, { onEvents: (r) => gotX.push(...r), onFail: () => {} });
    poller.subscribe(y.accountId, 0n, { onEvents: (r) => gotY.push(...r), onFail: () => {} });
    await clock.advance(0);
    await tickFinished(clock);

    // Forged: nothing has moved for X.
    app.reset();
    ops.reset();
    source.handlers!.onNudge(x.accountId);
    await clock.advance(1_000);
    await tickFinished(clock);
    expect(ops.count(/domain_event_watermarks/)).toBe(1);
    expect((ops.log[0]!.params as string[][])[0]).toEqual([x.accountId]);
    expect(app.count(/FROM domain_events/)).toBe(0);
    expect(gotX).toEqual([]);

    // Real: X gets its event, Y is untouched.
    const id = (await event(x.accountId)).rows[0]!.id;
    app.reset();
    source.handlers!.onNudge(x.accountId);
    await clock.advance(1_000);
    await tickFinished(clock);
    expect(gotX.map((r) => r.id)).toEqual([id]);
    expect(gotY).toEqual([]);
    expect(app.log.filter((l) => l.params?.[0] === y.accountId)).toEqual([]);
  });

  it('a nudge that lands during a tick is picked up by that tick\'s re-arm', async () => {
    const fake = fakePools();
    const source = new FakeSource();
    const clock = new ManualClock(Date.now());
    const poller = build(source, clock, { pool: fake.pool, ops: fake.ops });
    const id = randomUUID();
    poller.subscribe(id, 0n, handlers);
    const ticking = poller.tick();
    source.handlers!.onNudge(id); // mid-tick
    await ticking;
    fake.watermarkCalls.length = 0;
    await clock.advance(2_000);
    expect(fake.watermarkCalls).toEqual([[id]]);
  });

  it('starts the listener with the first feed and closes it 60 s after the last one leaves', async () => {
    const fake = fakePools();
    const source = new FakeSource();
    const clock = new ManualClock(Date.now());
    const poller = build(source, clock, { pool: fake.pool, ops: fake.ops });
    const a = poller.subscribe(randomUUID(), 0n, handlers);
    expect(source.starts).toBe(1);
    a.unsubscribe();
    await clock.advance(LISTENER_IDLE_CLOSE_MS - 1_000);
    expect(source.stops).toBe(0);
    const b = poller.subscribe(randomUUID(), 0n, handlers); // back inside the window: keeps the listener
    await clock.advance(LISTENER_IDLE_CLOSE_MS * 2);
    expect(source.stops).toBe(0);
    b.unsubscribe();
    await clock.advance(LISTENER_IDLE_CLOSE_MS + 1);
    expect(source.stops).toBe(1);
  });

  it('after the listener recovers, every feed reads once', async () => {
    const acct = await seedAccountWithMember(admin);
    const source = new FakeSource();
    const clock = new ManualClock(Date.now(), 20);
    const poller = build(source, clock, undefined, 0);
    const got: AccountEventRow[] = [];
    poller.subscribe(acct.accountId, 0n, { onEvents: (r) => got.push(...r), onFail: () => {} });
    await clock.advance(0);
    await tickFinished(clock);
    await event(acct.accountId); // missed while "down"
    source.handlers!.onRecovered();
    await clock.advance(1_000);
    await eventually(() => got.length >= 1);
    await tickFinished(clock);
    expect(got).toHaveLength(1);
  });
});

describe('NudgeListener (D#31 API-5d)', () => {
  let adminPool: Pool;
  let platformOpsPool: Pool;
  const url = (): string => process.env.API_DATABASE_URL_PLATFORM_OPS!;

  beforeAll(() => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    await adminPool.end();
    await platformOpsPool.end();
  });

  function recorder(): { nudges: string[]; recovered: number; h: NudgeHandlers } {
    const r = { nudges: [] as string[], recovered: 0, h: undefined as unknown as NudgeHandlers };
    r.h = { onNudge: (id) => r.nudges.push(id), onRecovered: () => void r.recovered++ };
    return r;
  }

  it('connects, passes the probe, delivers an account id, and never lets a probe payload wake a feed', async () => {
    const logs: string[] = [];
    const listener = new NudgeListener({ url: url(), probePool: platformOpsPool, log: (l) => logs.push(l) });
    const rec = recorder();
    try {
      listener.start(rec.h);
      await eventually(() => listener.status() === 'connected');
      const id = randomUUID();
      await platformOpsPool.query(`SELECT pg_notify('fx_account_nudge', 'probe:forged')`);
      await platformOpsPool.query(`SELECT pg_notify('fx_account_nudge', $1)`, [id]);
      await eventually(() => rec.nudges.length > 0);
      expect(rec.nudges).toEqual([id]);
      expect(rec.recovered).toBe(0);
      expect(logs).toEqual(['nudge listener: connected']);
    } finally {
      listener.stop();
    }
  });

  it('a listener whose probe never arrives goes degraded after 5 s instead of trusting the connection', async () => {
    const clock = new ManualClock(Date.now());
    const silent = { query: async () => ({ rows: [] }) } as unknown as Pool; // never sends the probe
    const logs: string[] = [];
    const listener = new NudgeListener({ url: url(), probePool: silent, clock, log: (l) => logs.push(l) });
    try {
      listener.start(recorder().h);
      await eventually(() => clock.pendingTimers() > 0);
      await clock.advance(PROBE_TIMEOUT_MS);
      await eventually(() => listener.status() === 'degraded');
      expect(logs).toEqual(['nudge listener: degraded (error)']);
    } finally {
      listener.stop();
    }
  });

  it('refuses a -pooler host and an unreachable one, logs only fixed strings (no URL, password or payload), and retries', async () => {
    for (const bad of ['postgres://u:s3cretpw@ep-x-pooler.eu.neon.tech/db', 'postgres://u:s3cretpw@127.0.0.1:1/db']) {
      const clock = new ManualClock(Date.now());
      const logs: string[] = [];
      const listener = new NudgeListener({ url: bad, probePool: platformOpsPool, clock, log: (l) => logs.push(l), random: () => 1 });
      try {
        listener.start(recorder().h);
        await eventually(() => listener.status() === 'degraded');
        await clock.advance(60_000); // several retries
        await eventually(() => listener.status() === 'degraded');
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatch(/^nudge listener: degraded \([A-Za-z0-9_-]+\)$/);
        expect(logs.join('\n')).not.toMatch(/s3cretpw|neon\.tech|127\.0\.0\.1/);
      } finally {
        listener.stop();
      }
    }
  });

  it('reconnects after its connection is killed, and reports the recovery so every feed can read once', async () => {
    const listener = new NudgeListener({ url: `${url()}${url().includes('?') ? '&' : '?'}application_name=fx_nudge_kill`, probePool: platformOpsPool, log: () => {}, random: () => 0 });
    const rec = recorder();
    try {
      listener.start(rec.h);
      await eventually(() => listener.status() === 'connected');
      await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'fx_nudge_kill'`);
      await eventually(() => listener.status() === 'degraded');
      await eventually(() => listener.status() === 'connected', 8_000);
      expect(rec.recovered).toBe(1);
      const id = randomUUID();
      await platformOpsPool.query(`SELECT pg_notify('fx_account_nudge', $1)`, [id]);
      await eventually(() => rec.nudges.includes(id));
    } finally {
      listener.stop();
    }
  });

  it('with the listener unable to connect, a subscriber still gets its event at the next idle tick', async () => {
    const c = await adminPool.connect();
    const acct = await seedAccountWithMember(c).finally(() => c.release());
    const dead = new NudgeListener({ url: 'postgres://u:p@127.0.0.1:1/db', probePool: platformOpsPool, log: () => {} });
    const clock = new ManualClock(Date.now(), 20);
    const appPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    const poller = new AccountPoller({ pool: appPool, platformOpsPool, clock, settleMs: 0, nudgeSource: dead });
    const got: AccountEventRow[] = [];
    try {
      poller.subscribe(acct.accountId, 0n, { onEvents: (r) => got.push(...r), onFail: () => {} });
      await clock.advance(0);
      await adminPool.query(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, 'session.revoked', '{}')`, [acct.accountId]);
      await tickFinished(clock); // the subscribe tick must have re-armed, or advance() finds no timer to fire
      await clock.advance(10_000);
      await eventually(() => got.length === 1);
    } finally {
      dead.stop();
      await appPool.end();
    }
  });
});
