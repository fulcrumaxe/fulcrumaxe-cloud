import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import {
  fanOutPendingEvents,
  sendDueDeliveries,
  autoDisableStaleEndpoints,
  RETRY_SCHEDULE_SECONDS,
  AUTO_DISABLE_AFTER_MS,
} from '../src/sweep.js';
import { createDeliverySender } from '../src/dispatcher.js';
import { deliver } from '../src/connector.js';
import { envWebhookKekSource, sealWebhookSecret, generateWebhookSecret, type KekSource } from '../src/secrets.js';
import { seedDelivery, seedDomainEvent } from './helpers/seed.js';
import { startTestReceiver, type TestReceiver } from './helpers/receiver.js';

const TEST_KEK = Buffer.alloc(32, 9).toString('base64');
function testKekSource(): KekSource {
  return envWebhookKekSource({ FX_WEBHOOK_KEK_V1: TEST_KEK, FX_WEBHOOK_KEK_CURRENT_VERSION: '1' });
}

/**
 * D#31 API-4b, "VERIFY ON REAL INPUT": real Postgres, real handlers, a
 * real local HTTPS receiver, and the full outbox pipeline
 * (`fanOutPendingEvents` -> `sendDueDeliveries` -> `autoDisableStaleEndpoints`,
 * all API-4a) driven by API-4b's real dispatcher. Also proves SSRF
 * refusals live through the real `connector.ts`/`ssrf.ts` code path (no
 * blocked-address check is ever mocked) against 127.0.0.1, [::1] and the
 * cloud metadata address -- the DNS-name-resolving-to-a-private-address
 * case is `ssrf.test.ts`'s (it needs an injectable DNS answer, which is
 * the one thing this file's real receiver/real DNS setup can't fake
 * safely without also faking the address check itself).
 */
describe('e2e (D#31 API-4b): the real dispatcher through the full outbox pipeline', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let refs: SeedRefs;
  let receiver: TestReceiver;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
    receiver = await startTestReceiver();
  });

  afterAll(async () => {
    await receiver.close();
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  async function seedRealEndpoint(url: string): Promise<{ id: string; secret: string }> {
    const id = randomUUID();
    const secret = generateWebhookSecret();
    const sealed = sealWebhookSecret(testKekSource(), refs.accountId, id, secret);
    await admin.query(
      `INSERT INTO webhook_endpoints (id, account_id, url, event_types, secret_ciphertext, secret_nonce, wrapped_dek, kek_version, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, refs.accountId, url, ['pr.opened'], sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, refs.userId],
    );
    return { id, secret };
  }

  it('fan-out, then a successful send, produces one succeeded delivery the receiver actually verified', async () => {
    receiver.setResponseStatus(200);
    const endpoint = await seedRealEndpoint(receiver.url);
    const eventId = await seedDomainEvent(admin, refs.accountId, 'pr.opened', {
      payload: { repoFullName: 'fulcrumaxe/cloud', prNumber: 1 },
    });

    const fanOut = await fanOutPendingEvents(platformOpsPool);
    expect(fanOut.deliveriesCreated).toBeGreaterThanOrEqual(1);

    const sender = createDeliverySender(platformOpsPool, { kekSource: testKekSource(), lookup: receiver.lookup });
    const now = new Date();
    const result = await sendDueDeliveries(platformOpsPool, sender, { now });
    expect(result.succeeded).toBeGreaterThanOrEqual(1);

    const { rows } = await admin.query(
      `SELECT status, attempt_count, last_status_code, last_error_class FROM webhook_deliveries WHERE endpoint_id = $1 AND event_id = $2`,
      [endpoint.id, eventId],
    );
    expect(rows[0]).toEqual({ status: 'succeeded', attempt_count: 1, last_status_code: 200, last_error_class: null });

    const received = receiver.requests.at(-1)!;
    const verified = new Webhook(endpoint.secret).verify(received.body, received.headers as Record<string, string>);
    expect(verified).toEqual({ id: eventId, type: 'pr.opened', created_at: expect.any(String), data: { repoFullName: 'fulcrumaxe/cloud', prNumber: 1 } });
  });

  it('criterion 6/7: a failing delivery is retried at the first backoff step (1m), with the delivery log recording only a status code and error class (never a body)', async () => {
    receiver.setResponseStatus(503);
    const endpoint = await seedRealEndpoint(receiver.url);
    const eventId = await seedDomainEvent(admin, refs.accountId, 'pr.opened', { payload: {} });
    // Explicit past `nextAttemptAt` -- "due" regardless of how `now`
    // below compares to real wall-clock time.
    const deliveryId = await seedDelivery(admin, refs.accountId, endpoint.id, { eventId, eventType: 'pr.opened', nextAttemptAt: new Date(0) });

    const sender = createDeliverySender(platformOpsPool, { kekSource: testKekSource(), lookup: receiver.lookup });
    const now = new Date('2026-01-01T00:00:00.000Z');
    await sendDueDeliveries(platformOpsPool, sender, { now });

    const { rows } = await admin.query<{
      status: string;
      attempt_count: number;
      last_status_code: number;
      last_error_class: string | null;
      next_attempt_at: Date;
    }>(`SELECT status, attempt_count, last_status_code, last_error_class, next_attempt_at FROM webhook_deliveries WHERE id = $1`, [deliveryId]);
    const row = rows[0]!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);
    expect(row.last_status_code).toBe(503);
    expect(row.last_error_class).toBe('http_status');
    expect(row.next_attempt_at.getTime() - now.getTime()).toBe(RETRY_SCHEDULE_SECONDS[0]! * 1000);

    // No column exists for a response body at all (0627_webhooks.sql) --
    // this is a schema-level guarantee, not just an unused field.
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_deliveries'`,
    );
    expect(columns.rows.map((r) => r.column_name)).not.toContain('response_body');

    receiver.setResponseStatus(200);
  });

  it('criterion 6: exhausting the retry schedule marks a delivery dead', async () => {
    receiver.setResponseStatus(500);
    const endpoint = await seedRealEndpoint(receiver.url);
    const eventId = await seedDomainEvent(admin, refs.accountId, 'pr.opened', { payload: {} });
    const deliveryId = await seedDelivery(admin, refs.accountId, endpoint.id, {
      eventId,
      eventType: 'pr.opened',
      // The Nth already-failed attempt schedules retry N+1's delay;
      // exhausting the schedule (length attempts already made) is what
      // makes the NEXT one go dead (sweep.ts's retryDelaySeconds).
      attemptCount: RETRY_SCHEDULE_SECONDS.length,
      nextAttemptAt: new Date(0),
    });

    const sender = createDeliverySender(platformOpsPool, { kekSource: testKekSource(), lookup: receiver.lookup });
    await sendDueDeliveries(platformOpsPool, sender, { now: new Date() });

    const { rows } = await admin.query<{ status: string; attempt_count: number; dead_at: Date | null }>(
      `SELECT status, attempt_count, dead_at FROM webhook_deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(rows[0]!.status).toBe('dead');
    expect(rows[0]!.attempt_count).toBe(RETRY_SCHEDULE_SECONDS.length + 1);
    expect(rows[0]!.dead_at).not.toBeNull();

    receiver.setResponseStatus(200);
  });

  it('criterion 8: an endpoint with only dead deliveries older than 72h is auto-disabled and emits webhook_endpoint.disabled', async () => {
    const endpoint = await seedRealEndpoint(receiver.url);
    const longDead = new Date(Date.now() - AUTO_DISABLE_AFTER_MS - 60_000);
    await seedDelivery(admin, refs.accountId, endpoint.id, { status: 'dead', deadAt: longDead });

    const disabled = await autoDisableStaleEndpoints(platformOpsPool, new Date());
    expect(disabled).toContain(endpoint.id);

    const { rows } = await admin.query<{ status: string; disabled_reason: string | null }>(
      `SELECT status, disabled_reason FROM webhook_endpoints WHERE id = $1`,
      [endpoint.id],
    );
    expect(rows[0]).toEqual({ status: 'disabled', disabled_reason: 'failing' });

    const events = await admin.query(
      `SELECT type FROM domain_events WHERE account_id = $1 AND subject_id = $2 AND type = 'webhook_endpoint.disabled'`,
      [refs.accountId, endpoint.id],
    );
    expect(events.rows).toHaveLength(1);
  });

  describe('live SSRF refusals through the real connector (no blocked-address check is mocked)', () => {
    const cases: Array<{ name: string; url: string }> = [
      { name: '127.0.0.1 (loopback)', url: 'https://127.0.0.1/hook' },
      { name: '[::1] (IPv6 loopback)', url: 'https://[::1]/hook' },
      { name: '169.254.169.254 (cloud metadata)', url: 'https://169.254.169.254/hook' },
    ];
    for (const { name, url } of cases) {
      it(`refuses ${name}, live, with no request ever reaching a socket`, async () => {
        const outcome = await deliver({ url, headers: {}, body: '{}' });
        expect(outcome).toEqual({ ok: false, errorClass: 'blocked_address' });
      });
    }

    it('a defense-in-depth re-check at delivery time refuses a row whose URL is a blocked literal, even if it somehow bypassed registration', async () => {
      // Inserted directly (bypassing packages/api's route-level
      // validateWebhookUrlSyntax call entirely) to prove the DISPATCHER
      // itself refuses it too, not only the create route.
      const id = randomUUID();
      const secret = generateWebhookSecret();
      const sealed = sealWebhookSecret(testKekSource(), refs.accountId, id, secret);
      await admin.query(
        `INSERT INTO webhook_endpoints (id, account_id, url, event_types, secret_ciphertext, secret_nonce, wrapped_dek, kek_version, created_by)
         VALUES ($1, $2, 'https://127.0.0.1/hook', $3, $4, $5, $6, $7, $8)`,
        [id, refs.accountId, ['pr.opened'], sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, refs.userId],
      );
      const eventId = await seedDomainEvent(admin, refs.accountId, 'pr.opened', { payload: {} });

      // Deliberately NO `lookup` override -- this exercises the REAL,
      // non-test-bypass code path.
      const sender = createDeliverySender(platformOpsPool, { kekSource: testKekSource() });
      const outcome = await sender.send({ id: randomUUID(), accountId: refs.accountId, endpointId: id, eventId, eventType: 'pr.opened', attemptCount: 0 });
      expect(outcome).toEqual({ ok: false, errorClass: 'blocked_address' });
    });
  });
});
