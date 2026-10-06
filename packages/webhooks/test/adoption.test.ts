import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { computeAdoptionStats } from '../src/adoption.js';
import { seedWebhookEndpoint } from './helpers/seed.js';

/** D#31 API-4a criterion 13: `pnpm --filter @fx/webhooks adoption` prints
 * `{accounts_with_active_token_30d, webhook_success_rate_7d}` from a
 * platform_ops read, on seeded data. */
describe('adoption (D#31 API-4a criterion 13)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  it('counts accounts with a token used in the last 30 days, and computes the 7-day success rate over terminal deliveries', async () => {
    const now = new Date('2026-04-15T00:00:00.000Z');

    // An active token: unrevoked, unexpired, used 5 days ago.
    await admin.query(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, last_used_at)
       VALUES ($1, $2, $3, 'fxat_...used', ARRAY['read'], $4, $5)`,
      [refs.accountId, refs.userId, `hash-${randomUUID()}`, new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000), new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)],
    );
    // A stale token: unrevoked, unexpired, but last used 60 days ago -- does not count.
    await admin.query(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, last_used_at)
       VALUES ($1, $2, $3, 'fxat_...stale', ARRAY['read'], $4, $5)`,
      [refs.accountId, refs.userId, `hash-${randomUUID()}`, new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000), new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)],
    );

    const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
    const within7d = (offsetHours: number) => new Date(now.getTime() - offsetHours * 60 * 60 * 1000);
    async function insertDelivery(status: string, createdAt: Date): Promise<void> {
      await admin.query(
        `INSERT INTO webhook_deliveries (account_id, endpoint_id, event_id, event_type, status, created_at) VALUES ($1, $2, $3, 'pr.opened', $4, $5)`,
        [refs.accountId, endpointId, `evt_${randomUUID()}`, status, createdAt],
      );
    }
    // 3 succeeded, 1 dead within the last 7 days -> 3/4 = 0.75. A pending
    // one (not terminal) and an old dead one (outside the window) don't count.
    await insertDelivery('succeeded', within7d(1));
    await insertDelivery('succeeded', within7d(2));
    await insertDelivery('succeeded', within7d(3));
    await insertDelivery('dead', within7d(4));
    await insertDelivery('pending', within7d(1));
    await insertDelivery('dead', within7d(24 * 10));

    const stats = await computeAdoptionStats(platformOpsPool, now);
    expect(stats.accounts_with_active_token_30d).toBeGreaterThanOrEqual(1);
    expect(stats.webhook_success_rate_7d).toBeCloseTo(0.75, 5);
  });

  it('returns null success rate when there are no terminal deliveries in the window', async () => {
    // computeAdoptionStats reads across every account (it's an operator
    // CLI, not a tenant-scoped route) -- picking a `now` far outside every
    // other test's seeded date range (all in 2026) is enough to prove the
    // "no terminal deliveries in window" branch without needing to delete
    // other tests' rows first.
    const farPast = new Date('2020-01-01T00:00:00.000Z');
    const stats = await computeAdoptionStats(platformOpsPool, farPast);
    expect(stats.webhook_success_rate_7d).toBeNull();
  });
});
