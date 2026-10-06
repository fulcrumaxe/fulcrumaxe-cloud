import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant } from "@fx/db/src/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { webhookEndpointLimitFor, type PlanId } from "@fx/spend";
import {
  validateWebhookUrlSyntax,
  envWebhookKekSource,
  sealWebhookSecret,
  generateWebhookSecret,
  sendTestEvent,
  WEBHOOK_EVENT_TYPES,
  type WebhookEndpointSecretMaterial,
} from "@fx/webhooks";
import type { RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import { EndpointLimitReachedError } from "../errors.js";

/**
 * D#31 API-4b: "The v1 contract" route table's webhook-endpoints rows.
 * `GET` entries are `S+T(read), owner/admin`; every mutation is session-
 * only, owner/admin (`principals` omitted -> session-only default,
 * registry.ts's `effectivePrincipals`). Secrets are never stored in this
 * file's own memory beyond the single response that reveals them --
 * `secrets.ts`/`dispatcher.ts` own encryption and delivery; this module
 * only orchestrates the CRUD rows and calls into those.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;
const EVENT_TYPE_ENUM = z.enum([...WEBHOOK_EVENT_TYPES]);

const webhookEndpointResponseSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  event_types: z.array(EVENT_TYPE_ENUM),
  status: z.enum(["active", "disabled"]),
  disabled_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** "The signing secret is revealed once" -- `secret` appears on no other schema in this file. */
const createWebhookEndpointResponseSchema = webhookEndpointResponseSchema.extend({
  secret: z.string(),
});

const createWebhookEndpointBodySchema = z.object({
  url: z.string(),
  event_types: z.array(EVENT_TYPE_ENUM).min(1),
});

const updateWebhookEndpointBodySchema = z
  .object({
    url: z.string().optional(),
    event_types: z.array(EVENT_TYPE_ENUM).min(1).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((body) => body.url !== undefined || body.event_types !== undefined || body.status !== undefined, {
    message: "at least one of url, event_types or status is required",
  });

const listWebhookEndpointsResponseSchema = z.object({
  data: z.array(webhookEndpointResponseSchema),
  next_cursor: z.string().nullable(),
});

const listQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

const idParamsSchema = z.object({ id: z.string() });
const deliveryIdParamsSchema = z.object({ delivery_id: z.string() });

const rotateSecretResponseSchema = z.object({
  secret: z.string(),
  rotated_at: z.string(),
  previous_secret_expires_at: z.string(),
});

const testEndpointResponseSchema = z.object({
  delivered: z.boolean(),
  status_code: z.number().nullable(),
  error_class: z.string().nullable(),
});

const deliveryResponseSchema = z.object({
  id: z.string().uuid(),
  event_type: z.string(),
  status: z.enum(["pending", "claimed", "succeeded", "dead"]),
  attempt_count: z.number(),
  last_status_code: z.number().nullable(),
  last_error_class: z.string().nullable(),
  next_attempt_at: z.string(),
  created_at: z.string(),
});

const listWebhookDeliveriesResponseSchema = z.object({
  data: z.array(deliveryResponseSchema),
  next_cursor: z.string().nullable(),
});

const redeliverResponseSchema = z.object({ status: z.literal("queued") });

interface EndpointRow {
  id: string;
  url: string;
  event_types: string[];
  status: "active" | "disabled";
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
  created_at_cursor: string;
}

const ENDPOINT_COLUMNS = `id, url, event_types, status, disabled_reason, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`;

function toEndpointDTO(row: EndpointRow): z.infer<typeof webhookEndpointResponseSchema> {
  return {
    id: row.id,
    url: row.url,
    event_types: row.event_types as z.infer<typeof EVENT_TYPE_ENUM>[],
    status: row.status,
    disabled_reason: row.disabled_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

interface DeliveryRow {
  id: string;
  event_type: string;
  status: "pending" | "claimed" | "succeeded" | "dead";
  attempt_count: number;
  last_status_code: number | null;
  last_error_class: string | null;
  next_attempt_at: Date;
  created_at: Date;
  created_at_cursor: string;
}

const DELIVERY_COLUMNS = `id, event_type, status, attempt_count, last_status_code, last_error_class, next_attempt_at, created_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`;

function toDeliveryDTO(row: DeliveryRow): z.infer<typeof deliveryResponseSchema> {
  return {
    id: row.id,
    event_type: row.event_type,
    status: row.status,
    attempt_count: row.attempt_count,
    last_status_code: row.last_status_code,
    last_error_class: row.last_error_class,
    next_attempt_at: row.next_attempt_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

async function auditWrite(client: { query: (sql: string, params: unknown[]) => Promise<unknown> }, action: string, payload: Record<string, unknown>): Promise<void> {
  // audit-log-guard.test.ts (D#76/D#97) forbids a raw `audit_log`
  // reference under packages/*/src/** -- this SECURITY DEFINER function
  // (0628_webhook_endpoints_hardening.sql) is the sanctioned way through.
  await client.query("SELECT audit_write_webhook_endpoints($1, $2::jsonb)", [action, JSON.stringify(payload)]);
}

export const webhookEndpointRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/webhook-endpoints",
    operationId: "listWebhookEndpoints",
    summary: "The account's webhook endpoints",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listQuerySchema,
    responseSchema: listWebhookEndpointsResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const { rows } = await client.query<EndpointRow>(
          `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints
            WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $3::int`,
          [cursor?.created_at ?? null, cursor?.id ?? null, limit + 1],
        );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = page[page.length - 1];
        return {
          data: page.map(toEndpointDTO),
          next_cursor: hasMore && lastRow ? encodeCursor(lastRow.created_at_cursor, lastRow.id) : null,
        };
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/webhook-endpoints/{id}",
    operationId: "getWebhookEndpoint",
    summary: "One webhook endpoint",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: webhookEndpointResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) {
        throw new NotFoundError(`webhook endpoint ${id} not found`);
      }
      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const { rows } = await client.query<EndpointRow>(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = $1`, [id]);
        const row = rows[0];
        if (!row) {
          throw new NotFoundError(`webhook endpoint ${id} not found`);
        }
        return toEndpointDTO(row);
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/webhook-endpoints/{id}/deliveries",
    operationId: "listWebhookDeliveries",
    summary: "The delivery log for one webhook endpoint",
    principals: ["session", "token"],
    minRole: "admin",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    querySchema: listQuerySchema,
    responseSchema: listWebhookDeliveriesResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) {
        throw new NotFoundError(`webhook endpoint ${id} not found`);
      }
      const query = (input.query ?? {}) as z.infer<typeof listQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const endpointExists = await client.query(`SELECT 1 FROM webhook_endpoints WHERE id = $1`, [id]);
        if (endpointExists.rows.length === 0) {
          throw new NotFoundError(`webhook endpoint ${id} not found`);
        }
        const { rows } = await client.query<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
            WHERE endpoint_id = $1
              AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $4::int`,
          [id, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1],
        );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = page[page.length - 1];
        return {
          data: page.map(toDeliveryDTO),
          next_cursor: hasMore && lastRow ? encodeCursor(lastRow.created_at_cursor, lastRow.id) : null,
        };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/webhook-endpoints",
    operationId: "createWebhookEndpoint",
    summary: "Register a new webhook endpoint",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never", // a route returning a secret rejects Idempotency-Key (API-1 criterion, same rule as createToken).
    rateClass: "write",
    bodySchema: createWebhookEndpointBodySchema,
    responseSchema: createWebhookEndpointResponseSchema,
    successStatus: 201,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof createWebhookEndpointBodySchema>;
      // Criterion 1: registration-time SSRF checks, before anything touches the database.
      validateWebhookUrlSyntax(body.url);

      const id = randomUUID();
      const plaintext = generateWebhookSecret();
      const kekSource = envWebhookKekSource();
      const sealed = sealWebhookSecret(kekSource, ctx.principal.accountId, id, plaintext);

      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const plan = await client.query<{ plan: PlanId }>(`SELECT plan FROM accounts WHERE id = $1`, [ctx.principal.accountId]);
        const planId = plan.rows[0]?.plan;
        if (!planId) {
          throw new NotFoundError(`account ${ctx.principal.accountId} not found`);
        }
        // Serialise the count-then-insert below per account. READ COMMITTED lets
        // two concurrent creates both read count = cap-1 and both insert, so the
        // plan cap needs a lock that CONFLICTS between creators. insertApiToken's
        // FOR SHARE (core/src/tokens/service.ts) is the wrong tool here: shared
        // locks never conflict with each other, and that hardening only had to
        // block a concurrent writer. A row lock on accounts (FOR UPDATE) would
        // also need an UPDATE policy match, which an admin on accounts may lack.
        // A transaction-scoped advisory lock has no RLS surface, is keyed on the
        // account alone (other accounts never wait), and is released at COMMIT or
        // ROLLBACK, so the count below sees every earlier creator's committed row.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `webhook_endpoints.create:${ctx.principal.accountId}`,
        ]);
        // Criterion 10: "the endpoint past the plan's limit -> 409 endpoint_limit_reached."
        const countRow = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM webhook_endpoints`);
        if (Number(countRow.rows[0]!.count) >= webhookEndpointLimitFor(planId)) {
          throw new EndpointLimitReachedError();
        }

        const { rows } = await client.query<{ created_at: Date }>(
          `INSERT INTO webhook_endpoints
             (id, account_id, url, event_types, secret_ciphertext, secret_nonce, wrapped_dek, kek_version, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING created_at`,
          [
            id,
            ctx.principal.accountId,
            body.url,
            body.event_types,
            sealed.ciphertext,
            sealed.nonce,
            sealed.wrappedDek,
            sealed.kekVersion,
            ctx.principal.userId,
          ],
        );
        await auditWrite(client, "webhook_endpoint.created", { endpoint_id: id });

        return {
          id,
          url: body.url,
          event_types: body.event_types,
          status: "active" as const,
          disabled_reason: null,
          secret: plaintext,
          created_at: rows[0]!.created_at.toISOString(),
          updated_at: rows[0]!.created_at.toISOString(),
        };
      });
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/webhook-endpoints/{id}",
    operationId: "updateWebhookEndpoint",
    summary: "Edit a webhook endpoint's URL, event types or status",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: updateWebhookEndpointBodySchema,
    responseSchema: webhookEndpointResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) {
        throw new NotFoundError(`webhook endpoint ${id} not found`);
      }
      const body = input.body as z.infer<typeof updateWebhookEndpointBodySchema>;
      if (body.url !== undefined) {
        validateWebhookUrlSyntax(body.url);
      }
      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const { rows } = await client.query<EndpointRow>(
          `UPDATE webhook_endpoints
              SET url = COALESCE($2, url),
                  event_types = COALESCE($3, event_types),
                  status = COALESCE($4, status),
                  disabled_reason = CASE WHEN $4::text = 'active' THEN NULL ELSE disabled_reason END,
                  updated_at = now()
            WHERE id = $1
          RETURNING ${ENDPOINT_COLUMNS}`,
          [id, body.url ?? null, body.event_types ?? null, body.status ?? null],
        );
        const row = rows[0];
        if (!row) {
          throw new NotFoundError(`webhook endpoint ${id} not found`);
        }
        await auditWrite(client, "webhook_endpoint.updated", { endpoint_id: id });
        return toEndpointDTO(row);
      });
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/webhook-endpoints/{id}",
    operationId: "deleteWebhookEndpoint",
    summary: "Remove a webhook endpoint",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) {
        throw new NotFoundError(`webhook endpoint ${id} not found`);
      }
      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const { rows } = await client.query(`DELETE FROM webhook_endpoints WHERE id = $1 RETURNING id`, [id]);
        if (rows.length === 0) {
          throw new NotFoundError(`webhook endpoint ${id} not found`);
        }
        await auditWrite(client, "webhook_endpoint.deleted", { endpoint_id: id });
        return null;
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/webhook-endpoints/{id}/rotate-secret",
    operationId: "rotateWebhookEndpointSecret",
    summary: "Rotate a webhook endpoint's signing secret (24h dual-secret overlap)",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: rotateSecretResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) {
        throw new NotFoundError(`webhook endpoint ${id} not found`);
      }
      const kekSource = envWebhookKekSource();
      const newPlaintext = generateWebhookSecret();

      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const existing = await client.query<{
          secret_ciphertext: Buffer;
          secret_nonce: Buffer;
          wrapped_dek: Buffer;
          kek_version: number;
        }>(
          `SELECT secret_ciphertext, secret_nonce, wrapped_dek, kek_version FROM webhook_endpoints WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = existing.rows[0];
        if (!current) {
          throw new NotFoundError(`webhook endpoint ${id} not found`);
        }

        const sealed = sealWebhookSecret(kekSource, ctx.principal.accountId, id, newPlaintext);
        const rotatedAt = new Date();
        const previousSecretExpiresAt = new Date(rotatedAt.getTime() + ROTATION_OVERLAP_MS);

        await client.query(
          `UPDATE webhook_endpoints
              SET secret_ciphertext = $2, secret_nonce = $3, wrapped_dek = $4, kek_version = $5,
                  previous_secret_ciphertext = $6, previous_secret_nonce = $7, previous_secret_wrapped_dek = $8,
                  previous_secret_kek_version = $9, previous_secret_expires_at = $10,
                  updated_at = $11
            WHERE id = $1`,
          [
            id,
            sealed.ciphertext,
            sealed.nonce,
            sealed.wrappedDek,
            sealed.kekVersion,
            current.secret_ciphertext,
            current.secret_nonce,
            current.wrapped_dek,
            current.kek_version,
            previousSecretExpiresAt,
            rotatedAt,
          ],
        );
        await auditWrite(client, "webhook_endpoint.secret_rotated", { endpoint_id: id });

        return {
          secret: newPlaintext,
          rotated_at: rotatedAt.toISOString(),
          previous_secret_expires_at: previousSecretExpiresAt.toISOString(),
        };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/webhook-endpoints/{id}/test",
    operationId: "testWebhookEndpoint",
    sessionLimit: SESSION_LIMITS.webhookTest,
    summary: "Send an endpoint.test event immediately",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: testEndpointResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) {
        throw new NotFoundError(`webhook endpoint ${id} not found`);
      }

      const material = await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const { rows } = await client.query<{
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
          `SELECT url, secret_ciphertext, secret_nonce, wrapped_dek, kek_version,
                  previous_secret_ciphertext, previous_secret_nonce, previous_secret_wrapped_dek,
                  previous_secret_kek_version, previous_secret_expires_at
             FROM webhook_endpoints WHERE id = $1`,
          [id],
        );
        const row = rows[0];
        if (!row) {
          throw new NotFoundError(`webhook endpoint ${id} not found`);
        }
        const result: WebhookEndpointSecretMaterial = {
          id,
          accountId: ctx.principal.accountId,
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
        return result;
      });

      // The live HTTP call runs OUTSIDE any open transaction/connection --
      // holding a pooled client for up to connector.ts's 10s timeout would
      // starve the pool under concurrent /test calls.
      const outcome = await sendTestEvent(material);

      await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, (client) =>
        auditWrite(client, "webhook_endpoint.test_sent", {
          endpoint_id: id,
          ok: outcome.ok,
          status_code: outcome.statusCode ?? null,
        }),
      );

      return {
        delivered: outcome.ok,
        status_code: outcome.statusCode ?? null,
        error_class: outcome.ok ? null : outcome.errorClass,
      };
    },
  },
  {
    method: "POST",
    path: "/api/v1/webhook-endpoints/deliveries/{delivery_id}/redeliver",
    operationId: "redeliverWebhookDelivery",
    summary: "Reset one delivery to pending so the next sweep resends it",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: deliveryIdParamsSchema,
    responseSchema: redeliverResponseSchema,
    successStatus: 202,
    async handler(ctx, input) {
      const deliveryId = input.params.delivery_id!;
      if (!UUID_RE.test(deliveryId)) {
        throw new NotFoundError(`webhook delivery ${deliveryId} not found`);
      }
      return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const { rows } = await client.query<{ ok: boolean }>(`SELECT redeliver_webhook_delivery($1) AS ok`, [deliveryId]);
        if (!rows[0]?.ok) {
          throw new NotFoundError(`webhook delivery ${deliveryId} not found`);
        }
        return { status: "queued" as const };
      });
    },
  },
];
