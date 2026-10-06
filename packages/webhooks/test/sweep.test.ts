import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import {
  autoDisableStaleEndpoints,
  claimDueDeliveries,
  fanOutPendingEvents,
  purgeOldRows,
  RETRY_SCHEDULE_SECONDS,
  sendDueDeliveries,
  type DeliverySender,
} from '../src/sweep.js';
import { seedDelivery, seedDomainEvent, seedWebhookEndpoint } from './helpers/seed.js';

/**
 * D#31 API-4a criteria 6 (fan-out half), 7, 8 and 12, against real
 * Postgres. The dispatcher's own HTTP send (SSRF, signing) is API-4b --
 * every test here uses a fake `DeliverySender`.
 */
describe('sweep (D#31 API-4a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let otherRefs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    otherRefs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  describe('RLS: account isolation on webhook_endpoints and webhook_deliveries', () => {
    it("an owner can't see another account's rows, and a plain member can't see their own account's", async () => {
      const otherEndpointId = await seedWebhookEndpoint(admin, otherRefs.accountId, otherRefs.userId);
      await seedDelivery(admin, otherRefs.accountId, otherEndpointId);
      const ownEndpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const memberId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
        refs.accountId,
        memberId,
      ]);

      await withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
        const endpoints = await client.query('SELECT id FROM webhook_endpoints WHERE id = $1', [otherEndpointId]);
        const deliveries = await client.query('SELECT id FROM webhook_deliveries WHERE endpoint_id = $1', [otherEndpointId]);
        expect(endpoints.rows).toHaveLength(0);
        expect(deliveries.rows).toHaveLength(0);
      });
      await withTenant(appUserPool, refs.accountId, memberId, async (client) => {
        const endpoints = await client.query('SELECT id FROM webhook_endpoints WHERE id = $1', [ownEndpointId]);
        expect(endpoints.rows).toHaveLength(0);
      });
    });

    it("an owner's UPDATE or DELETE aimed at another account's endpoint affects 0 rows (no permission error) and leaves it untouched", async () => {
      const otherEndpointId = await seedWebhookEndpoint(admin, otherRefs.accountId, otherRefs.userId);

      await withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
        const updated = await client.query(`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = $1`, [
          otherEndpointId,
        ]);
        expect(updated.rowCount).toBe(0);
        const deleted = await client.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [otherEndpointId]);
        expect(deleted.rowCount).toBe(0);
      });

      const { rows } = await admin.query(`SELECT status FROM webhook_endpoints WHERE id = $1`, [otherEndpointId]);
      expect(rows).toEqual([{ status: 'active' }]);
    });

    // The two tests above filter on `id`, so Postgres also applies the SELECT
    // policy and they pass whatever the UPDATE/DELETE policies say. These
    // statements name no column in the WHERE, so only the UPDATE/DELETE USING
    // clauses stand between tenant A and tenant B's rows. Each runs in a
    // transaction that is rolled back, so A's own seeded rows survive.
    const ROLLBACK = new Error('rollback');
    async function unfilteredAsOwner(sql: string): Promise<{ rowCount: number | null; visible: number }> {
      let out: { rowCount: number | null; visible: number } | undefined;
      await withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
        const visible = Number((await client.query('SELECT count(*) FROM webhook_endpoints')).rows[0].count);
        const res = await client.query(sql);
        out = { rowCount: res.rowCount, visible };
        throw ROLLBACK;
      }).catch((err) => {
        if (err !== ROLLBACK) throw err;
      });
      return out!;
    }

    it("an owner's unfiltered UPDATE touches only their own account's endpoints, never another account's", async () => {
      await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const otherEndpointId = await seedWebhookEndpoint(admin, otherRefs.accountId, otherRefs.userId);

      const { rowCount, visible } = await unfilteredAsOwner(`UPDATE webhook_endpoints SET status = 'active'`);
      expect(visible).toBeGreaterThan(0);
      expect(rowCount).toBe(visible);

      const { rows } = await admin.query(`SELECT status FROM webhook_endpoints WHERE id = $1`, [otherEndpointId]);
      expect(rows).toEqual([{ status: 'active' }]);
    });

    it("an owner's unfiltered DELETE removes only their own account's endpoints, never another account's", async () => {
      await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const otherEndpointId = await seedWebhookEndpoint(admin, otherRefs.accountId, otherRefs.userId);

      const { rowCount, visible } = await unfilteredAsOwner(`DELETE FROM webhook_endpoints`);
      expect(visible).toBeGreaterThan(0);
      expect(rowCount).toBe(visible);

      const { rows } = await admin.query(`SELECT id FROM webhook_endpoints WHERE id = $1`, [otherEndpointId]);
      expect(rows).toHaveLength(1);
    });

    it('webhook_deliveries is read-only for app_user: an unfiltered UPDATE or DELETE is refused outright', async () => {
      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const deliveryId = await seedDelivery(admin, refs.accountId, endpointId);

      for (const sql of [`UPDATE webhook_deliveries SET status = status`, `DELETE FROM webhook_deliveries`]) {
        await expect(
          withTenant(appUserPool, refs.accountId, refs.userId, (client) => client.query(sql)),
        ).rejects.toMatchObject({ code: '42501' });
      }

      const { rows } = await admin.query(`SELECT id FROM webhook_deliveries WHERE id = $1`, [deliveryId]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('fanOutPendingEvents (criterion 6, fan-out half)', () => {
    it('one event with 2 subscribed active endpoints fans out into exactly 2 deliveries', async () => {
      const type = `test.fanout.${randomUUID()}`;
      const endpointA = await seedWebhookEndpoint(admin, refs.accountId, refs.userId, { eventTypes: [type] });
      const endpointB = await seedWebhookEndpoint(admin, refs.accountId, refs.userId, { eventTypes: [type, 'other.type'] });
      // A subscribed-to-a-different-type endpoint gets no delivery.
      await seedWebhookEndpoint(admin, refs.accountId, refs.userId, { eventTypes: ['other.type'] });
      // A disabled endpoint, even if subscribed, gets no delivery.
      await seedWebhookEndpoint(admin, refs.accountId, refs.userId, { eventTypes: [type], status: 'disabled' });

      const eventId = await seedDomainEvent(admin, refs.accountId, type);

      const result = await fanOutPendingEvents(platformOpsPool);
      expect(result.eventsProcessed).toBeGreaterThanOrEqual(1);

      const { rows } = await admin.query<{ endpoint_id: string }>(
        `SELECT endpoint_id FROM webhook_deliveries WHERE event_id = $1`,
        [eventId],
      );
      expect(rows.map((r) => r.endpoint_id).sort()).toEqual([endpointA, endpointB].sort());

      const { rows: eventRows } = await admin.query(`SELECT fanned_out_at FROM domain_events WHERE id = $1`, [eventId]);
      expect(eventRows[0].fanned_out_at).not.toBeNull();

      // A second sweep does not double-fan-out the same event.
      await fanOutPendingEvents(platformOpsPool);
      const { rows: afterSecond } = await admin.query(
        `SELECT count(*)::int AS n FROM webhook_deliveries WHERE event_id = $1`,
        [eventId],
      );
      expect(afterSecond[0].n).toBe(2);
    });

    it('an event with no subscribed endpoints is still marked fanned-out, with zero deliveries', async () => {
      const type = `test.nosubs.${randomUUID()}`;
      const eventId = await seedDomainEvent(admin, refs.accountId, type);
      await fanOutPendingEvents(platformOpsPool);
      const { rows } = await admin.query(`SELECT fanned_out_at FROM domain_events WHERE id = $1`, [eventId]);
      expect(rows[0].fanned_out_at).not.toBeNull();
      const { rows: deliveries } = await admin.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE event_id = $1`, [eventId]);
      expect(deliveries[0].n).toBe(0);
    });
  });

  describe('claimDueDeliveries: SKIP LOCKED (criterion 7)', () => {
    it('two concurrent claims never return the same delivery id', async () => {
      // Drain any due 'pending' row an earlier test in this file left
      // behind (e.g. fanOutPendingEvents's own deliveries) -- this test
      // asserts on the EXACT set of ids two concurrent claims return, so
      // it needs a clean slate. Production sweeps have no such per-test
      // boundary; this is test-only hygiene.
      await admin.query(`DELETE FROM webhook_deliveries WHERE status = 'pending'`);

      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const ids = new Set<string>();
      for (let i = 0; i < 40; i++) {
        ids.add(await seedDelivery(admin, refs.accountId, endpointId));
      }

      const [batchA, batchB] = await Promise.all([
        claimDueDeliveries(platformOpsPool, 20),
        claimDueDeliveries(platformOpsPool, 20),
      ]);

      const claimedIds = [...batchA, ...batchB].map((d) => d.id);
      expect(new Set(claimedIds).size).toBe(claimedIds.length); // no overlap
      expect(claimedIds.length).toBeGreaterThan(0);
      for (const id of claimedIds) {
        expect(ids.has(id)).toBe(true);
      }
    });
  });

  describe('sendDueDeliveries: retry schedule and dead-lettering (criterion 6)', () => {
    it('a failing send is rescheduled at the next backoff delay; a 2xx marks it succeeded', async () => {
      // See the SKIP LOCKED test's own comment: drain any due row left
      // behind, so this test's own `sendDueDeliveries(..., {limit: 10})`
      // call claims ONLY the two rows this test seeds.
      await admin.query(`DELETE FROM webhook_deliveries WHERE status = 'pending'`);
      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const now = new Date('2026-01-01T00:00:00.000Z');
      // `nextAttemptAt` must be at or before this test's own fake `now`
      // (seedDelivery's default is real wall-clock "now", which is AFTER
      // any fixed-past-date fake clock, and so would never be "due").
      const failingId = await seedDelivery(admin, refs.accountId, endpointId, { attemptCount: 0, nextAttemptAt: now });
      const succeedingId = await seedDelivery(admin, refs.accountId, endpointId, { attemptCount: 0, nextAttemptAt: now });

      const sender: DeliverySender = {
        send: async (d) => (d.id === succeedingId ? { ok: true, statusCode: 200 } : { ok: false, statusCode: 500, errorClass: 'http_status' }),
      };

      await sendDueDeliveries(platformOpsPool, sender, { now, limit: 10 });

      const { rows: failed } = await admin.query(
        `SELECT status, attempt_count, next_attempt_at FROM webhook_deliveries WHERE id = $1`,
        [failingId],
      );
      expect(failed[0].status).toBe('pending');
      expect(failed[0].attempt_count).toBe(1);
      const deltaSeconds = (new Date(failed[0].next_attempt_at).getTime() - now.getTime()) / 1000;
      expect(deltaSeconds).toBeCloseTo(RETRY_SCHEDULE_SECONDS[0]!, 0);

      const { rows: succeeded } = await admin.query(`SELECT status FROM webhook_deliveries WHERE id = $1`, [succeedingId]);
      expect(succeeded[0].status).toBe('succeeded');
    });

    it('after exhausting the retry schedule, a delivery is marked dead', async () => {
      await admin.query(`DELETE FROM webhook_deliveries WHERE status = 'pending'`);
      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const deliveryId = await seedDelivery(admin, refs.accountId, endpointId, {
        attemptCount: RETRY_SCHEDULE_SECONDS.length,
        status: 'pending',
        nextAttemptAt: new Date('2020-01-01T00:00:00.000Z'),
      });

      const sender: DeliverySender = { send: async () => ({ ok: false, statusCode: 500, errorClass: 'http_status' }) };
      await sendDueDeliveries(platformOpsPool, sender, { now: new Date(), limit: 10 });

      const { rows } = await admin.query(`SELECT status, dead_at FROM webhook_deliveries WHERE id = $1`, [deliveryId]);
      expect(rows[0].status).toBe('dead');
      expect(rows[0].dead_at).not.toBeNull();
    });

    it(
      'throughput: 100 due deliveries to a 2s sender complete in <=10s wall time, with >=25 concurrent in flight',
      async () => {
        await admin.query(`DELETE FROM webhook_deliveries WHERE status = 'pending'`);
        const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
        for (let i = 0; i < 100; i++) {
          await seedDelivery(admin, refs.accountId, endpointId);
        }

        let inFlight = 0;
        let maxInFlight = 0;
        const sender: DeliverySender = {
          send: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            inFlight -= 1;
            return { ok: true, statusCode: 200 };
          },
        };

        const start = Date.now();
        const result = await sendDueDeliveries(platformOpsPool, sender, { limit: 100, concurrency: 25 });
        const wallMs = Date.now() - start;

        expect(result.claimed).toBe(100);
        expect(result.succeeded).toBe(100);
        expect(wallMs).toBeLessThanOrEqual(10000);
        expect(maxInFlight).toBeGreaterThanOrEqual(25);
      },
      15000,
    );
  });

  describe('autoDisableStaleEndpoints (criterion 8)', () => {
    it('disables an endpoint whose only deliveries have all been dead for >=72h, with an audit row and a domain event', async () => {
      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const now = new Date('2026-02-01T00:00:00.000Z');
      const longDead = new Date(now.getTime() - 73 * 60 * 60 * 1000);
      await seedDelivery(admin, refs.accountId, endpointId, { status: 'dead', deadAt: longDead });
      await seedDelivery(admin, refs.accountId, endpointId, { status: 'dead', deadAt: longDead });

      const disabled = await autoDisableStaleEndpoints(platformOpsPool, now);
      expect(disabled).toContain(endpointId);

      const { rows } = await admin.query(`SELECT status, disabled_reason FROM webhook_endpoints WHERE id = $1`, [endpointId]);
      expect(rows[0]).toEqual({ status: 'disabled', disabled_reason: 'failing' });

      const { rows: auditRows } = await admin.query(
        `SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action = 'webhook_endpoint.disabled' AND payload ->> 'endpoint_id' = $2`,
        [refs.accountId, endpointId],
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].actor).toBe('platform_ops');

      const { rows: eventRows } = await admin.query(
        `SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'webhook_endpoint.disabled' AND subject_id = $2`,
        [refs.accountId, endpointId],
      );
      expect(eventRows).toHaveLength(1);
    });

    it('does not disable an endpoint with a still-pending delivery', async () => {
      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const now = new Date('2026-02-01T00:00:00.000Z');
      await seedDelivery(admin, refs.accountId, endpointId, {
        status: 'dead',
        deadAt: new Date(now.getTime() - 100 * 60 * 60 * 1000),
      });
      await seedDelivery(admin, refs.accountId, endpointId, { status: 'pending' });

      const disabled = await autoDisableStaleEndpoints(platformOpsPool, now);
      expect(disabled).not.toContain(endpointId);
    });

    it('does not disable an endpoint whose most recent dead delivery died less than 72h ago', async () => {
      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);
      const now = new Date('2026-02-01T00:00:00.000Z');
      await seedDelivery(admin, refs.accountId, endpointId, {
        status: 'dead',
        deadAt: new Date(now.getTime() - 71 * 60 * 60 * 1000),
      });

      const disabled = await autoDisableStaleEndpoints(platformOpsPool, now);
      expect(disabled).not.toContain(endpointId);
    });
  });

  describe('purgeOldRows (criterion 12)', () => {
    it('purges domain_events >7d, webhook_deliveries >30d, idempotency_keys >24h and rate_limit_windows >1h; keeps fresher rows', async () => {
      const now = new Date('2026-03-01T00:00:00.000Z');
      const endpointId = await seedWebhookEndpoint(admin, refs.accountId, refs.userId);

      const oldEventId = await seedDomainEvent(admin, refs.accountId, 'test.purge.old', {
        createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      });
      const freshEventId = await seedDomainEvent(admin, refs.accountId, 'test.purge.fresh', {
        createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      });

      const oldDeliveryId = randomUUID();
      await admin.query(
        `INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event_id, event_type, created_at) VALUES ($1, $2, $3, $4, 'x', $5)`,
        [oldDeliveryId, refs.accountId, endpointId, `evt_${randomUUID()}`, new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000)],
      );
      const freshDeliveryId = randomUUID();
      await admin.query(
        `INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event_id, event_type, created_at) VALUES ($1, $2, $3, $4, 'x', $5)`,
        [freshDeliveryId, refs.accountId, endpointId, `evt_${randomUUID()}`, new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)],
      );

      await admin.query(
        `INSERT INTO idempotency_keys (account_id, key, principal_id, method, path, request_sha256, expires_at)
         VALUES ($1, 'old-key', 'session:x', 'POST', '/v1/x', 'sha', $2)`,
        [refs.accountId, new Date(now.getTime() - 1000)],
      );
      await admin.query(
        `INSERT INTO idempotency_keys (account_id, key, principal_id, method, path, request_sha256, expires_at)
         VALUES ($1, 'fresh-key', 'session:x', 'POST', '/v1/x', 'sha', $2)`,
        [refs.accountId, new Date(now.getTime() + 1000 * 60 * 60)],
      );

      await admin.query(
        `INSERT INTO rate_limit_windows (bucket_key, window_start, request_count) VALUES ($1, $2, 1)`,
        [`tenant:${randomUUID()}`, new Date(now.getTime() - 2 * 60 * 60 * 1000)],
      );
      const freshBucketKey = `tenant:${randomUUID()}`;
      await admin.query(
        `INSERT INTO rate_limit_windows (bucket_key, window_start, request_count) VALUES ($1, $2, 1)`,
        [freshBucketKey, new Date(now.getTime() - 30 * 1000)],
      );

      await purgeOldRows(platformOpsPool, now);

      const eventIds = (await admin.query(`SELECT id FROM domain_events WHERE id = ANY($1)`, [[oldEventId, freshEventId]])).rows.map(
        (r) => r.id,
      );
      expect(eventIds).toEqual([freshEventId]);

      const deliveryIds = (
        await admin.query(`SELECT id FROM webhook_deliveries WHERE id = ANY($1)`, [[oldDeliveryId, freshDeliveryId]])
      ).rows.map((r) => r.id);
      expect(deliveryIds).toEqual([freshDeliveryId]);

      const keyRows = (
        await admin.query(`SELECT key FROM idempotency_keys WHERE account_id = $1 AND key IN ('old-key', 'fresh-key')`, [refs.accountId])
      ).rows.map((r) => r.key);
      expect(keyRows).toEqual(['fresh-key']);

      const bucketRows = (
        await admin.query(`SELECT bucket_key FROM rate_limit_windows WHERE bucket_key = $1`, [freshBucketKey])
      ).rows;
      expect(bucketRows).toHaveLength(1);
    });
  });
});
