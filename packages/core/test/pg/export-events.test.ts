import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { redactEventPayload } from '../../src/events/redact.js';
import { NotFoundError } from '../../src/tenancy/errors.js';
import { EXPORT_PAGE_SIZE, exportRunEvents } from '../../src/runs/exportEvents.js';

/** D#45 S8a criteria 2, 5 and 6 at the service level, against a real cluster under RLS. */
describe('runs/exportEvents: exportRunEvents (D#45 S8a)', () => {
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

  async function collect(refs: SeedRefs, runId: string) {
    const out = [];
    for await (const event of await exportRunEvents({ pool: appUserPool, principal: refs }, runId)) out.push(event);
    return out;
  }

  it('streams every event of the run in seq order across several pages, each exactly {seq, kind, at, payload}', async () => {
    const total = EXPORT_PAGE_SIZE * 2 + 37; // seedAccount already wrote seq 1
    await admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload)
       SELECT $1, $2, s, 'agent.output', jsonb_build_object('n', s) FROM generate_series(2, $3::int) AS s`,
      [refsA.accountId, refsA.runId, total],
    );
    const events = await collect(refsA, refsA.runId);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(Object.keys(events[5]!).sort()).toEqual(['at', 'kind', 'payload', 'seq']);
    expect(events[5]).toEqual({ seq: 6, kind: 'agent.output', at: expect.any(String), payload: { n: 6 } });
  });

  it("tenancy: B's run id, a random uuid and a malformed id all throw NotFoundError before any event is yielded", async () => {
    for (const id of [refsB.runId, randomUUID(), 'not-a-uuid']) {
      await expect(exportRunEvents({ pool: appUserPool, principal: refsA }, id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('sentinel: a payload that held a secret before redaction is exported without it', async () => {
    const sentinel = 'sk-ant-api03-FAKE';
    // The insert path (runner's insertRunEvent) redacts before it writes; do the same here.
    const payload = redactEventPayload({ text: `key ${sentinel}`, [sentinel]: 'as a key' });
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 9000, 'agent.output', $3)`, [
      refsA.accountId,
      refsA.runId,
      JSON.stringify(payload),
    ]);
    const events = await collect(refsA, refsA.runId);
    const sentinelEvent = events.find((e) => e.seq === 9000)!;
    expect(sentinelEvent.payload).toEqual({ text: 'key [redacted]', '[redacted]': 'as a key' });
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });
});
