import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { listRunEvents } from '../src/events/read.js';

/**
 * D#2 H11 criteria 1 (as corrected by D#31 comment 18494573 C5: "as a
 * service-level NotFoundError test") against a real Postgres cluster
 * under withTenant/RLS. Mirrors `test/runs-read.test.ts` (D#31 API-3a)
 * exactly -- same seeding, same CWE-639/755 cases.
 */
describe('events/read: listRunEvents (D#2 H11, corrected by D#31 C5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  /** `seedAccount` already writes one run_events row (seq 1, kind
   * 'start') for `refs.runId` -- these helpers add more with known
   * kinds/payloads for pagination and content assertions. */
  async function insertEvent(refs: SeedRefs, seq: number, kind: string, payload: unknown): Promise<void> {
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5)`, [
      refs.accountId,
      refs.runId,
      seq,
      kind,
      JSON.stringify(payload),
    ]);
  }

  it('returns events for the caller\'s own run, in seq order, with the frozen {seq, kind, at, payload} shape', async () => {
    await insertEvent(refsA, 2, 'agent.output', { text: 'hello' });
    await insertEvent(refsA, 3, 'run.status_changed', { from: 'pending', to: 'running' });

    const page = await listRunEvents({ pool: appUserPool, principal: refsA }, refsA.runId, { limit: 50 });
    expect(page.data.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page.data[1]).toEqual({ seq: 2, kind: 'agent.output', at: expect.any(String), payload: { text: 'hello' } });
    expect(page.next_after_seq).toBeNull();
  });

  it('afterSeq excludes events at or before that seq', async () => {
    const page = await listRunEvents({ pool: appUserPool, principal: refsA }, refsA.runId, { afterSeq: 1, limit: 50 });
    expect(page.data.every((e) => e.seq > 1)).toBe(true);
  });

  it('paginates with next_after_seq and no gap or duplicate across pages', async () => {
    const seen: number[] = [];
    let afterSeq: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listRunEvents({ pool: appUserPool, principal: refsA }, refsA.runId, {
        afterSeq,
        limit: 1,
      });
      seen.push(...page.data.map((e) => e.seq));
      if (page.next_after_seq === null) break;
      afterSeq = page.next_after_seq;
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("(CWE-639) B's own run id, from A's principal -> NotFoundError, never a raw pg error", async () => {
    await expect(
      listRunEvents({ pool: appUserPool, principal: refsA }, refsB.runId, { limit: 50 }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('a random, well-formed uuid that does not exist -> NotFoundError', async () => {
    await expect(
      listRunEvents({ pool: appUserPool, principal: refsA }, randomUUID(), { limit: 50 }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('(CWE-755) a malformed id -> NotFoundError before ever reaching Postgres, not a 22P02 crash', async () => {
    await expect(
      listRunEvents({ pool: appUserPool, principal: refsA }, "not-a-uuid' OR '1'='1", { limit: 50 }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('a run with zero non-seed events beyond afterSeq returns an empty page, not NotFoundError', async () => {
    const page = await listRunEvents({ pool: appUserPool, principal: refsB }, refsB.runId, {
      afterSeq: 999,
      limit: 50,
    });
    expect(page).toEqual({ data: [], next_after_seq: null });
  });

  // H14c-3-2c (Q-3-2c-1): run.metering is platform data, in both read shapes.
  it('never returns a run.metering row, with or without byte bounds', async () => {
    const refs = await seedAccount(admin, randomUUID());
    await insertEvent(refs, 2, 'run.metering', { metered_usd: 1, reported_usd: null, flags: [] });
    await insertEvent(refs, 3, 'agent.output', { text: 'after' });
    const ctx = { pool: appUserPool, principal: refs };
    for (const byteBounds of [undefined, { payloadCapBytes: 65536, pageBudgetBytes: 1 << 20 }]) {
      const page = await listRunEvents(ctx, refs.runId, { limit: 50, byteBounds });
      expect(page.data.map((e) => e.seq)).toEqual([1, 3]);
    }
    expect((await listRunEvents(ctx, refs.runId, { afterSeq: 1, limit: 1 })).data.map((e) => e.seq)).toEqual([3]);
  });
});
