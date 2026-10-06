import type { Pool, PoolClient } from 'pg';
import { withPlatformOps } from '@fx/core/src/tenancy/withPlatformOps.js';

/**
 * D#31 API-4a: the sweep. Runs entirely as `platform_ops` and does four
 * things, in order, every time it runs:
 *   1. fan-out: not-yet-fanned-out `domain_events` -> `webhook_deliveries`
 *      rows, one per subscribed active endpoint (criterion 6, fan-out half).
 *   2. send: claim due deliveries with `SKIP LOCKED` (criterion 7) and hand
 *      each to an injectable `DeliverySender` -- API-4b's real,
 *      SSRF-guarded HTTP dispatcher plugs in here; this package never
 *      makes an HTTP call itself.
 *   3. auto-disable: endpoints with nothing but old dead deliveries (criterion 8).
 *   4. purge: old rows across four tables (criterion 12).
 */

/** Seconds to wait before each successive retry, indexed by (attemptCount - 1)
 * -- criterion 6: "retried at 1m, 5m, 30m, 2h, 6h, 12h and 24h, then marked
 * dead". A delivery whose attemptCount has just reached this array's length
 * and still failed is marked dead rather than scheduled again. */
export const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400] as const;

/** How long an endpoint's deliveries must have been continuously dead
 * (nothing pending/claimed/succeeded, and the most recent dead delivery
 * died at least this long ago) before the endpoint is auto-disabled
 * (criterion 8). */
export const AUTO_DISABLE_AFTER_MS = 72 * 60 * 60 * 1000;

/** Retention windows for the cron's own purge (criterion 12). */
export const DOMAIN_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const WEBHOOK_DELIVERIES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEYS_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RATE_LIMIT_WINDOWS_RETENTION_MS = 60 * 60 * 1000;

/** A row claimed for sending, with just what a sender needs. The real
 * payload/event body is looked up separately (API-4b, from `event_id`) --
 * this package only claims and records outcomes. */
export interface ClaimedDelivery {
  id: string;
  accountId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  attemptCount: number;
}

export type SendOutcome =
  | { ok: true; statusCode: number }
  | { ok: false; statusCode?: number; errorClass: string };

/** Injected by the caller. API-4a's own tests use a fake; API-4b's real
 * dispatcher (ssrf.ts + connector.ts + sign.ts) implements this for
 * production. */
export interface DeliverySender {
  send(delivery: ClaimedDelivery): Promise<SendOutcome>;
}

function retryDelaySeconds(attemptCount: number): number | undefined {
  return RETRY_SCHEDULE_SECONDS[attemptCount - 1];
}

/**
 * Fan-out (criterion 6's fan-out half): claims up to `limit` not-yet-
 * fanned-out `domain_events` rows with `SKIP LOCKED`, and for each,
 * inserts one `webhook_deliveries` row per active endpoint on that
 * account whose `event_types` contains the event's type. Marks each
 * event's `fanned_out_at` in the SAME transaction as its deliveries, so a
 * crash mid-fan-out never double-delivers on the next sweep (the claim
 * and the inserts commit or roll back together).
 */
export async function fanOutPendingEvents(pool: Pool, limit = 100): Promise<{ eventsProcessed: number; deliveriesCreated: number }> {
  return withPlatformOps(pool, async (client) => {
    const { rows: events } = await client.query<{ id: string; account_id: string; type: string }>(
      `SELECT id, account_id, type FROM domain_events
       WHERE fanned_out_at IS NULL
       ORDER BY seq
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    let deliveriesCreated = 0;
    for (const event of events) {
      const { rows: endpoints } = await client.query<{ id: string }>(
        `SELECT id FROM webhook_endpoints
         WHERE account_id = $1 AND status = 'active' AND $2 = ANY(event_types)`,
        [event.account_id, event.type],
      );
      for (const endpoint of endpoints) {
        await client.query(
          `INSERT INTO webhook_deliveries (account_id, endpoint_id, event_id, event_type)
           VALUES ($1, $2, $3, $4)`,
          [event.account_id, endpoint.id, event.id, event.type],
        );
        deliveriesCreated += 1;
      }
      await client.query(`UPDATE domain_events SET fanned_out_at = now() WHERE id = $1`, [event.id]);
    }

    return { eventsProcessed: events.length, deliveriesCreated };
  });
}

/**
 * Criterion 7: claims up to `limit` due deliveries with SKIP LOCKED,
 * marking each `'claimed'` in a short transaction that commits
 * immediately -- no row lock held across a sender's network call. Two
 * concurrent sweeps never claim the same row. Also reclaims deliveries
 * stuck `'claimed'` for over `staleClaimMs` (default 2 min), so a crashed
 * sweep doesn't strand a delivery forever.
 */
export async function claimDueDeliveries(
  pool: Pool,
  limit = 100,
  now: Date = new Date(),
  staleClaimMs = 2 * 60 * 1000,
): Promise<ClaimedDelivery[]> {
  return withPlatformOps(pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      account_id: string;
      endpoint_id: string;
      event_id: string;
      event_type: string;
      attempt_count: number;
    }>(
      `UPDATE webhook_deliveries
       SET status = 'claimed', claimed_at = $2
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE (status = 'pending' AND next_attempt_at <= $2)
            OR (status = 'claimed' AND claimed_at <= $2 - make_interval(secs => $3::double precision / 1000))
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, account_id, endpoint_id, event_id, event_type, attempt_count`,
      [limit, now, staleClaimMs],
    );
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      endpointId: r.endpoint_id,
      eventId: r.event_id,
      eventType: r.event_type,
      attemptCount: r.attempt_count,
    }));
  });
}

/** Applies one delivery's send outcome: success marks it `succeeded`;
 * failure either reschedules it (`pending`, with the next backoff delay)
 * or marks it `dead` once the retry schedule is exhausted. */
async function recordOutcome(
  client: PoolClient,
  delivery: ClaimedDelivery,
  outcome: SendOutcome,
  now: Date,
): Promise<void> {
  if (outcome.ok) {
    await client.query(
      `UPDATE webhook_deliveries
       SET status = 'succeeded', attempt_count = attempt_count + 1, last_attempted_at = $2,
           last_status_code = $3, last_error_class = NULL
       WHERE id = $1`,
      [delivery.id, now, outcome.statusCode],
    );
    return;
  }

  const nextAttemptCount = delivery.attemptCount + 1;
  const delaySeconds = retryDelaySeconds(nextAttemptCount);
  if (delaySeconds === undefined) {
    await client.query(
      `UPDATE webhook_deliveries
       SET status = 'dead', attempt_count = $2, last_attempted_at = $3,
           last_status_code = $4, last_error_class = $5, dead_at = $3
       WHERE id = $1`,
      [delivery.id, nextAttemptCount, now, outcome.statusCode ?? null, outcome.errorClass],
    );
    return;
  }

  await client.query(
    `UPDATE webhook_deliveries
     SET status = 'pending', attempt_count = $2, last_attempted_at = $3::timestamptz,
         last_status_code = $4, last_error_class = $5,
         next_attempt_at = $3::timestamptz + make_interval(secs => $6::double precision)
     WHERE id = $1`,
    [delivery.id, nextAttemptCount, now, outcome.statusCode ?? null, outcome.errorClass, delaySeconds],
  );
}

/**
 * Claims up to `limit` due deliveries and sends them through `sender`,
 * with up to `concurrency` in flight at once (criterion 7's throughput:
 * "100 due deliveries to a receiver that takes 2s in <=10s wall time
 * (>=25 concurrent)"). Each outcome is recorded in its own short
 * transaction -- a slow or hung sender never holds a Postgres row lock.
 */
export async function sendDueDeliveries(
  pool: Pool,
  sender: DeliverySender,
  opts: { limit?: number; concurrency?: number; now?: Date } = {},
): Promise<{ claimed: number; succeeded: number; failed: number; dead: number }> {
  const limit = opts.limit ?? 100;
  const concurrency = opts.concurrency ?? 25;
  const now = opts.now ?? new Date();

  const claimed = await claimDueDeliveries(pool, limit, now);
  let succeeded = 0;
  let failed = 0;
  let dead = 0;

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const delivery = claimed[index];
      if (!delivery) return;
      const outcome = await sender.send(delivery);
      if (outcome.ok) {
        succeeded += 1;
      } else if (retryDelaySeconds(delivery.attemptCount + 1) === undefined) {
        dead += 1;
      } else {
        failed += 1;
      }
      await withPlatformOps(pool, (client) => recordOutcome(client, delivery, outcome, now));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) || 0 }, worker));

  return { claimed: claimed.length, succeeded, failed, dead };
}

/**
 * Criterion 8: an endpoint is disabled once every delivery ever made to it
 * is `dead`, and the most recent one has been dead for at least 72h (no
 * pending/claimed/succeeded delivery exists at all -- a single success or
 * a still-pending retry keeps the endpoint alive). Writes an `audit_log`
 * row and emits `webhook_endpoint.disabled` in the SAME transaction as the
 * `status` update.
 */
export async function autoDisableStaleEndpoints(pool: Pool, now: Date = new Date()): Promise<string[]> {
  const { emitDomainEvent } = await import('@fx/core/src/domain-events/emit.js');
  return withPlatformOps(pool, async (client) => {
    const { rows } = await client.query<{ id: string; account_id: string }>(
      `SELECT e.id, e.account_id
       FROM webhook_endpoints e
       WHERE e.status = 'active'
         AND EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status <> 'dead')
         AND (SELECT MAX(d.dead_at) FROM webhook_deliveries d WHERE d.endpoint_id = e.id) <= $1
       FOR UPDATE OF e SKIP LOCKED`,
      [new Date(now.getTime() - AUTO_DISABLE_AFTER_MS)],
    );

    const disabled: string[] = [];
    for (const endpoint of rows) {
      await client.query(
        `UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = 'failing', updated_at = $2 WHERE id = $1`,
        [endpoint.id, now],
      );
      // Not audit_write(): that requires a verified member, which a
      // background sweep never has. The migration's own definer keeps
      // this raw `audit_log` write out of TypeScript (audit-log-guard.test.ts).
      await client.query(`SELECT audit_write_webhook_endpoint_disabled($1, $2)`, [endpoint.account_id, endpoint.id]);
      await emitDomainEvent(client, {
        type: 'webhook_endpoint.disabled',
        accountId: endpoint.account_id,
        subjectId: endpoint.id,
        payload: { endpointId: endpoint.id, reason: 'failing' },
        createdAt: now,
      });
      disabled.push(endpoint.id);
    }
    return disabled;
  });
}

/** Criterion 12's purge: old domain_events, webhook_deliveries,
 * idempotency_keys and rate_limit_windows rows. Every table here is
 * platform_ops-granted for exactly this (0627_webhooks.sql). */
export async function purgeOldRows(pool: Pool, now: Date = new Date()): Promise<Record<string, number>> {
  return withPlatformOps(pool, async (client) => {
    const domainEvents = await client.query(
      `DELETE FROM domain_events WHERE created_at < $1`,
      [new Date(now.getTime() - DOMAIN_EVENTS_RETENTION_MS)],
    );
    const deliveries = await client.query(
      `DELETE FROM webhook_deliveries WHERE created_at < $1`,
      [new Date(now.getTime() - WEBHOOK_DELIVERIES_RETENTION_MS)],
    );
    const idempotencyKeys = await client.query(
      `DELETE FROM idempotency_keys WHERE expires_at < $1`,
      [now],
    );
    void IDEMPOTENCY_KEYS_RETENTION_MS; // expires_at already encodes the 24h window at write time (packages/api/src/idempotency.ts).
    const rateLimitWindows = await client.query(
      `DELETE FROM rate_limit_windows WHERE window_start < $1`,
      [new Date(now.getTime() - RATE_LIMIT_WINDOWS_RETENTION_MS)],
    );
    return {
      domainEvents: domainEvents.rowCount ?? 0,
      webhookDeliveries: deliveries.rowCount ?? 0,
      idempotencyKeys: idempotencyKeys.rowCount ?? 0,
      rateLimitWindows: rateLimitWindows.rowCount ?? 0,
    };
  });
}

export interface SweepSummary {
  fanOut: { eventsProcessed: number; deliveriesCreated: number };
  sent: { claimed: number; succeeded: number; failed: number; dead: number };
  disabledEndpoints: string[];
  purged: Record<string, number>;
}

/** The whole sweep, in order: fan-out, send, auto-disable, purge. This is
 * what the cron route (apps/web/app/api/cron/api-sweep/route.ts) calls. */
export async function runSweep(pool: Pool, sender: DeliverySender, now: Date = new Date()): Promise<SweepSummary> {
  const fanOut = await fanOutPendingEvents(pool);
  const sent = await sendDueDeliveries(pool, sender, { now });
  const disabledEndpoints = await autoDisableStaleEndpoints(pool, now);
  const purged = await purgeOldRows(pool, now);
  return { fanOut, sent, disabledEndpoints, purged };
}

/**
 * D#454 H3c: when the next api-sweep tick has work, so the cron can leave a marker for it (and clear it when there is
 * none). Run on the connection the tick already opened, after `runSweep`. Returns the current time when events still
 * wait to be fanned out (the batch was full), else the earliest time a pending delivery becomes due (a retry) or a
 * claimed one's lease goes stale; null when nothing is waiting. Housekeeping (auto-disable, purge) is not work here:
 * the 30-minute backstop tick covers it.
 */
export async function nextApiSweepDueAt(pool: Pool, now: Date = new Date(), staleClaimMs = 2 * 60 * 1000): Promise<number | null> {
  return withPlatformOps(pool, async (client) => {
    const { rows } = await client.query<{ unfanned: boolean; due: Date | null }>(
      `SELECT EXISTS (SELECT 1 FROM domain_events WHERE fanned_out_at IS NULL) AS unfanned,
              (SELECT min(CASE WHEN status = 'pending' THEN next_attempt_at
                               ELSE claimed_at + make_interval(secs => $1::double precision / 1000) END)
                 FROM webhook_deliveries WHERE status IN ('pending', 'claimed')) AS due`,
      [staleClaimMs],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.unfanned) return now.getTime();
    return row.due ? row.due.getTime() : null;
  });
}
