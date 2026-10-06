import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * D#31 API-4a's own test helpers -- API-4b's routes are what will
 * eventually create these rows through `/v1`; until then, tests insert
 * them directly (as `admin`, bypassing RLS) exactly the way
 * packages/core/test/runs-read.test.ts seeds `agent_runs` rows directly
 * for a read-service under test.
 */

export interface SeedEndpointOpts {
  eventTypes?: string[];
  status?: 'active' | 'disabled';
}

/** A webhook_endpoints row with placeholder envelope-encryption columns
 * (API-4b's ssrf.ts/sign.ts own the real seal()/open() calls -- not this
 * task). */
export async function seedWebhookEndpoint(
  admin: PoolClient,
  accountId: string,
  createdBy: string,
  opts: SeedEndpointOpts = {},
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO webhook_endpoints
       (id, account_id, url, event_types, secret_ciphertext, secret_nonce, wrapped_dek, kek_version, status, created_by)
     VALUES ($1, $2, 'https://example.test/hook', $3, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 1, $4, $5)`,
    [id, accountId, opts.eventTypes ?? ['pr.opened'], opts.status ?? 'active', createdBy],
  );
  return id;
}

export interface SeedDeliveryOpts {
  status?: 'pending' | 'claimed' | 'succeeded' | 'dead';
  nextAttemptAt?: Date;
  attemptCount?: number;
  claimedAt?: Date;
  deadAt?: Date;
  eventType?: string;
  eventId?: string;
}

export async function seedDelivery(
  admin: PoolClient,
  accountId: string,
  endpointId: string,
  opts: SeedDeliveryOpts = {},
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO webhook_deliveries
       (id, account_id, endpoint_id, event_id, event_type, status, attempt_count, next_attempt_at, claimed_at, dead_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      accountId,
      endpointId,
      opts.eventId ?? `evt_${randomUUID()}`,
      opts.eventType ?? 'pr.opened',
      opts.status ?? 'pending',
      opts.attemptCount ?? 0,
      opts.nextAttemptAt ?? new Date(),
      opts.claimedAt ?? null,
      opts.deadAt ?? null,
    ],
  );
  return id;
}

export async function seedDomainEvent(
  admin: PoolClient,
  accountId: string,
  type: string,
  // D#31 API-4b: `payload` added (default `{}`, matching every existing
  // API-4a caller that never passed one) so dispatcher.test.ts/e2e.test.ts
  // can seed a real, shaped payload for `sanitizeWebhookPayload` to sanitize.
  opts: { createdAt?: Date; fannedOutAt?: Date | null; payload?: Record<string, unknown> } = {},
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO domain_events (account_id, type, payload, created_at, fanned_out_at)
     VALUES ($1, $2, $5::jsonb, $3, $4)
     RETURNING id`,
    [accountId, type, opts.createdAt ?? new Date(), opts.fannedOutAt ?? null, JSON.stringify(opts.payload ?? {})],
  );
  return rows[0]!.id;
}
