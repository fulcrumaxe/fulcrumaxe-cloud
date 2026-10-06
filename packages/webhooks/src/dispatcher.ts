import { reportError } from '@fx/telemetry';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { HostLookup } from '@fx/net-guard';
import type { ClaimedDelivery, DeliverySender, SendOutcome } from './sweep.js';
import { deliver } from './connector.js';
import { signWebhookPayload } from './sign.js';
import { envWebhookKekSource, openWebhookSecret, type KekSource } from './secrets.js';
import { sanitizeWebhookPayload } from './payload.js';

/**
 * D#31 API-4b: the real, SSRF-guarded HTTP dispatcher `../sweep.js`'s own
 * header names as the seam API-4a left for this task -- implements
 * `DeliverySender` over `connector.ts` (pinned-socket HTTP), `sign.ts`
 * (Standard Webhooks signatures) and `secrets.ts` (the webhook-KEK
 * envelope). Also exports `sendTestEvent`, a one-off send with no
 * `webhook_deliveries` row at all, for the `POST .../test` route
 * (criterion 11: "calling POST .../test -> the receiver gets endpoint.test
 * with a valid signature").
 */

/** The subset of a `webhook_endpoints` row a send needs -- shared by the
 * sweep's per-delivery lookup (`send`, below) and the route-driven
 * `sendTestEvent`, so both paths decrypt/sign the exact same way. */
export interface WebhookEndpointSecretMaterial {
  id: string;
  accountId: string;
  url: string;
  secretCiphertext: Buffer;
  secretNonce: Buffer;
  secretWrappedDek: Buffer;
  kekVersion: number;
  /** Criterion 3's 24h rotation overlap -- all four null together means
   * "no rotation in effect". */
  previousSecretCiphertext: Buffer | null;
  previousSecretNonce: Buffer | null;
  previousSecretWrappedDek: Buffer | null;
  previousSecretKekVersion: number | null;
  previousSecretExpiresAt: Date | null;
}

export interface DispatcherOpts {
  kekSource?: KekSource;
  /** Test-only DNS override, threaded through to `connector.ts`'s
   * `deliver` (refused there outright when `NODE_ENV === "production"`). */
  lookup?: HostLookup;
  /** Injectable clock, for the rotation-overlap and signing-timestamp
   * tests (fake clock). */
  now?: () => Date;
}

/**
 * Decrypts the current secret, plus the previous one ONLY while
 * `previousSecretExpiresAt` is still in the future (criterion 3: "for 24h,
 * then only the new one"). Order is current-first; `sign.ts` signs with
 * every entry regardless of order.
 */
function activeSecrets(endpoint: WebhookEndpointSecretMaterial, kekSource: KekSource, now: Date): string[] {
  const secrets = [
    openWebhookSecret(kekSource, endpoint.accountId, endpoint.id, {
      ciphertext: endpoint.secretCiphertext,
      nonce: endpoint.secretNonce,
      wrappedDek: endpoint.secretWrappedDek,
      kekVersion: endpoint.kekVersion,
    }),
  ];
  if (
    endpoint.previousSecretCiphertext &&
    endpoint.previousSecretNonce &&
    endpoint.previousSecretWrappedDek &&
    endpoint.previousSecretKekVersion !== null &&
    endpoint.previousSecretExpiresAt &&
    endpoint.previousSecretExpiresAt.getTime() > now.getTime()
  ) {
    secrets.push(
      openWebhookSecret(kekSource, endpoint.accountId, endpoint.id, {
        ciphertext: endpoint.previousSecretCiphertext,
        nonce: endpoint.previousSecretNonce,
        wrappedDek: endpoint.previousSecretWrappedDek,
        kekVersion: endpoint.previousSecretKekVersion,
      }),
    );
  }
  return secrets;
}

async function buildAndSend(
  endpoint: WebhookEndpointSecretMaterial,
  eventId: string,
  eventType: string,
  payload: Record<string, unknown>,
  opts: DispatcherOpts,
): Promise<SendOutcome> {
  const kekSource = opts.kekSource ?? envWebhookKekSource();
  const now = opts.now?.() ?? new Date();

  let secrets: string[];
  try {
    secrets = activeSecrets(endpoint, kekSource, now);
  } catch (err) {
    reportError(err, { stage: "webhooks.kek" });
    // Criterion 4: "with FX_WEBHOOK_KEK_V1 unset, it fails closed" -- a
    // missing/invalid KEK never reaches connector.ts at all.
    return { ok: false, errorClass: 'kek_unavailable' };
  }

  const body = JSON.stringify({
    id: eventId,
    type: eventType,
    created_at: now.toISOString(),
    data: sanitizeWebhookPayload(payload),
  });
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  const headers = signWebhookPayload(secrets, eventId, timestampSeconds, body);

  return deliver({
    url: endpoint.url,
    headers: { ...headers, 'content-type': 'application/json' },
    body,
    lookup: opts.lookup,
  });
}

async function loadEndpointSecretMaterial(client: PoolClient, endpointId: string): Promise<WebhookEndpointSecretMaterial | null> {
  const { rows } = await client.query<{
    id: string;
    account_id: string;
    url: string;
    secret_ciphertext: Buffer;
    secret_nonce: Buffer;
    wrapped_dek: Buffer;
    kek_version: number;
    previous_secret_ciphertext: Buffer | null;
    previous_secret_nonce: Buffer | null;
    previous_secret_wrapped_dek: Buffer | null;
    previous_secret_kek_version: number | null;
    previous_secret_expires_at: Date | null;
  }>(
    `SELECT id, account_id, url, secret_ciphertext, secret_nonce, wrapped_dek, kek_version,
            previous_secret_ciphertext, previous_secret_nonce, previous_secret_wrapped_dek,
            previous_secret_kek_version, previous_secret_expires_at
     FROM webhook_endpoints WHERE id = $1 AND status = 'active'`,
    [endpointId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    url: row.url,
    secretCiphertext: row.secret_ciphertext,
    secretNonce: row.secret_nonce,
    secretWrappedDek: row.wrapped_dek,
    kekVersion: row.kek_version,
    previousSecretCiphertext: row.previous_secret_ciphertext,
    previousSecretNonce: row.previous_secret_nonce,
    previousSecretWrappedDek: row.previous_secret_wrapped_dek,
    previousSecretKekVersion: row.previous_secret_kek_version,
    previousSecretExpiresAt: row.previous_secret_expires_at,
  };
}

async function loadEventPayload(client: PoolClient, eventId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM domain_events WHERE id = $1`,
    [eventId],
  );
  return rows[0]?.payload ?? null;
}

/**
 * The real `DeliverySender` the sweep cron wires in (one assignment in
 * `apps/web/app/api/cron/api-sweep/handler.ts`, replacing API-4a's
 * `notYetImplementedSender`). Reads run on a plain pooled connection, NOT
 * inside a transaction -- both reads are single-statement and
 * platform_ops's policies on these tables are unconditional
 * (`USING (true)`), so there is nothing a transaction would protect here,
 * and holding one open across the HTTP call below would tie up a pool
 * connection for the whole `deliver()` timeout. Never throws: every
 * failure resolves to `{ok: false, errorClass}`, because `../sweep.js`'s
 * `sendDueDeliveries` calls `sender.send` with no try/catch of its own.
 */
export function createDeliverySender(pool: Pool, opts: DispatcherOpts = {}): DeliverySender {
  return {
    async send(delivery: ClaimedDelivery): Promise<SendOutcome> {
      try {
        const client = await pool.connect();
        let endpoint: WebhookEndpointSecretMaterial | null;
        let payload: Record<string, unknown> | null;
        try {
          endpoint = await loadEndpointSecretMaterial(client, delivery.endpointId);
          // An endpoint the sweep already fanned this event out to may
          // since have been deleted or disabled -- not found here is a
          // legitimate, non-retryable outcome, not a bug.
          payload = endpoint ? await loadEventPayload(client, delivery.eventId) : null;
        } finally {
          client.release();
        }
        if (!endpoint) {
          return { ok: false, errorClass: 'endpoint_not_found' };
        }
        if (payload === null) {
          // domain_events is purged after 7 days (0627_webhooks.sql);
          // webhook_deliveries keeps its own 30-day retention, so a very
          // late retry or an old manual redeliver can outlive its source
          // event. There is nothing left to send.
          return { ok: false, errorClass: 'event_expired' };
        }
        return await buildAndSend(endpoint, delivery.eventId, delivery.eventType, payload, opts);
      } catch (err) {
        reportError(err, { stage: "webhooks.send" });
        return { ok: false, errorClass: 'internal_error' };
      }
    },
  };
}

/**
 * Criterion 11's `POST .../test`: builds and sends a fresh, ad-hoc
 * `endpoint.test` event with no `domain_events`/`webhook_deliveries` row
 * at all (it is not part of the durable outbox -- a synchronous
 * customer-triggered action, not something the sweep retries). Returns
 * the outcome directly to the caller so the route can report success or
 * failure without waiting for a sweep tick.
 */
export async function sendTestEvent(endpoint: WebhookEndpointSecretMaterial, opts: DispatcherOpts = {}): Promise<SendOutcome> {
  const eventId = `evt_${randomUUID()}`;
  return buildAndSend(endpoint, eventId, 'endpoint.test', {}, opts);
}
