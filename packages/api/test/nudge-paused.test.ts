import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AccountPoller } from '../src/sse/poller.js';
import { NudgeListener, defaultNudgeSource } from '../src/sse/nudge.js';
import { ManualClock } from './helpers/manual-clock.js';

/**
 * Staging pause switch: with FX_STAGING_PAUSED=1 the process opens no LISTEN connection and sends no probe, and the
 * poller keeps serving every stream by polling (the path a degraded listener already leaves it on). `pg` is replaced
 * by a counter so "no connection" is observed at the driver, not inferred from a return value.
 */
const clients = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('pg', () => ({
  Client: class {
    constructor() {
      clients.constructed++;
    }
    on(): this {
      return this;
    }
    removeAllListeners(): this {
      return this;
    }
    connect(): Promise<void> {
      return new Promise(() => {}); // never answers: the control only needs to see the attempt
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const DIRECT_URL = 'postgres://listener@db.example.test/neondb';

/** A platform_ops pool that records the watermark calls (the poll) and refuses everything else, probes included. */
function fakePools(): { pool: Pool; ops: Pool; watermarkCalls: string[][]; probes: number } {
  const state = { watermarkCalls: [] as string[][], probes: 0 };
  const ops = {
    query: async (sql: string, params: string[][]) => {
      if (/pg_notify/i.test(sql)) {
        state.probes++;
        return { rows: [] };
      }
      state.watermarkCalls.push(params[0]!);
      return { rows: params[0]!.map((id) => ({ account_id: id, max_seq: '0', run_active: false })) };
    },
  } as unknown as Pool;
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => {
      throw new Error('tenant read on the fake pool');
    },
  } as unknown as Pool;
  return { pool, ops, get watermarkCalls() { return state.watermarkCalls; }, get probes() { return state.probes; } };
}

const handlers = { onEvents: () => {}, onFail: () => {} };
const prodEnv = { NODE_ENV: 'production', DATABASE_URL_PLATFORM_OPS: DIRECT_URL };

beforeEach(() => {
  clients.constructed = 0;
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL_PLATFORM_OPS', DIRECT_URL);
  vi.stubEnv('DATABASE_URL_EVENTS_LISTEN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('defaultNudgeSource with the staging pause switch', () => {
  it('builds no listener while FX_STAGING_PAUSED is 1', () => {
    expect(defaultNudgeSource(fakePools().ops, { ...prodEnv, FX_STAGING_PAUSED: '1' })).toBeUndefined();
  });

  it('builds the listener when the flag is unset, 0, empty or anything else (the control)', () => {
    for (const flag of [undefined, '0', '', 'true', 'yes']) {
      expect(defaultNudgeSource(fakePools().ops, { ...prodEnv, FX_STAGING_PAUSED: flag })).toBeInstanceOf(NudgeListener);
    }
  });
});

describe('a poller built from the process environment', () => {
  it('paused: opens no LISTEN connection and sends no probe, and still serves a stream by polling', async () => {
    vi.stubEnv('FX_STAGING_PAUSED', '1');
    const fake = fakePools();
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: fake.pool, platformOpsPool: fake.ops, clock, settleMs: 1000 });
    poller.subscribe(randomUUID(), 0n, handlers);
    await clock.advance(0);
    const first = fake.watermarkCalls.length;
    expect(first).toBeGreaterThan(0); // the subscribe tick polled
    await clock.advance(30_000);
    expect(fake.watermarkCalls.length).toBeGreaterThan(first); // and the idle cadence keeps polling
    expect(clients.constructed).toBe(0);
    expect(fake.probes).toBe(0);
    expect(poller.stats()).toMatchObject({ feeds: 1, subscribers: 1, timerArmed: true });
  });

  it('not paused: the same poller does open the listener connection (so the counter above can see one)', async () => {
    const fake = fakePools();
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: fake.pool, platformOpsPool: fake.ops, clock, settleMs: 1000 });
    poller.subscribe(randomUUID(), 0n, handlers);
    await clock.advance(0);
    expect(clients.constructed).toBe(1);
  });
});
