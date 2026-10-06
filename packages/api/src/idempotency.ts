import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { IdempotencyMode } from "./registry.js";
import {
  ApiError,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IdempotencyKeyRequiredError,
  IdempotencyNotSupportedError,
} from "./errors.js";

/** "The v1 contract" > Idempotency: sha256 over the exact request body TEXT as sent, never a re-serialized/canonicalized form -- avoids any ambiguity about key order or whitespace mattering. */
export function sha256Hex(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * Fix round item 5 (CWE-400, security review of this PR): the Spec names
 * no explicit limit for the `Idempotency-Key` header, so this uses the
 * brief's own fallback -- 255 printable ASCII characters -- stated here
 * once rather than left implicit. An oversized or non-ASCII key is
 * rejected before it is ever used as DB key material.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const PRINTABLE_ASCII_KEY_RE = /^[\x20-\x7e]+$/;

function assertValidIdempotencyKeyHeader(key: string): void {
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !PRINTABLE_ASCII_KEY_RE.test(key)) {
    throw new ApiError(
      400,
      "invalid_request",
      `Idempotency-Key must be ${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters or fewer`,
    );
  }
}

interface StoredResponse {
  status: number;
  body: unknown;
}

type Claim =
  | { state: "fresh" }
  | { state: "in_progress" }
  | {
      state: "completed";
      principalId: string;
      method: string;
      path: string;
      requestSha256: string;
      response: StoredResponse;
    };

/**
 * Claims `key` for `accountId`: inserts a fresh `in_progress` row, or
 * reports the existing row's state if one is already there. Runs on a
 * client already `withTenant`-scoped to `accountId`, so RLS is what
 * makes "the same key used in account B runs fresh" (criterion 7's
 * last bullet) true -- there is no account-id comparison in this file at
 * all.
 *
 * Fix round item 2 (CWE-324, security review of this PR): `expires_at`
 * is written on every insert but was never read back, so a completed
 * key replayed forever and a crashed worker's `in_progress` row (whose
 * `catch`-path release never ran) blocked that key permanently. The
 * insert's `ON CONFLICT` clause now upserts over an existing row when
 * (and only when) that row has already expired -- reclaiming it exactly
 * like a fresh key, regardless of whether it was `completed` or stuck
 * `in_progress` -- and the fallback lookup below only ever returns an
 * unexpired row, so an expired one is never treated as "in progress"
 * either. A single query is what makes both claiming and looking up
 * honor `expires_at`: the upsert path IS the reclaim, and the SELECT
 * path only sees what's left after it.
 */
async function claimIdempotencyKey(
  client: PoolClient,
  params: {
    key: string;
    principalId: string;
    method: string;
    path: string;
    requestSha256: string;
  },
): Promise<Claim> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (account_id, key, principal_id, method, path, request_sha256, status, expires_at)
     VALUES (current_setting('app.account_id', true)::uuid, $1, $2, $3, $4, $5, 'in_progress', now() + interval '24 hours')
     ON CONFLICT (account_id, key) DO UPDATE
       SET principal_id = EXCLUDED.principal_id,
           method = EXCLUDED.method,
           path = EXCLUDED.path,
           request_sha256 = EXCLUDED.request_sha256,
           status = 'in_progress',
           response = NULL,
           resource_id = NULL,
           created_at = now(),
           expires_at = EXCLUDED.expires_at
       WHERE idempotency_keys.expires_at <= now()
     RETURNING key`,
    [params.key, params.principalId, params.method, params.path, params.requestSha256],
  );
  if (inserted.rowCount === 1) {
    return { state: "fresh" };
  }

  const { rows } = await client.query<{
    principal_id: string;
    method: string;
    path: string;
    request_sha256: string;
    status: string;
    response: StoredResponse | null;
  }>(
    `SELECT principal_id, method, path, request_sha256, status, response
     FROM idempotency_keys
     WHERE key = $1 AND expires_at > now()`,
    [params.key],
  );
  const row = rows[0];
  if (!row || row.status === "in_progress") {
    return { state: "in_progress" };
  }
  return {
    state: "completed",
    principalId: row.principal_id,
    method: row.method,
    path: row.path,
    requestSha256: row.request_sha256,
    response: row.response!,
  };
}

async function completeIdempotencyKey(
  client: PoolClient,
  key: string,
  response: StoredResponse,
  resourceId: string | null,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys SET status = 'completed', response = $2, resource_id = $3 WHERE key = $1`,
    [key, JSON.stringify(response), resourceId],
  );
}

/** Frees a key this request claimed but failed to complete, so a legitimate retry isn't stuck behind a dead `in_progress` row until the 24h expiry sweeps it (API-4). Only releases a row still `in_progress` -- never clobbers a completed row a concurrent request finished in the meantime. */
async function releaseIdempotencyKey(client: PoolClient, key: string): Promise<void> {
  await client.query(`DELETE FROM idempotency_keys WHERE key = $1 AND status = 'in_progress'`, [key]);
}

export interface IdempotencyRequest {
  accountId: string;
  principalId: string;
  method: string;
  path: string;
  mode: IdempotencyMode;
  /** The raw `Idempotency-Key` header value, or null if absent. */
  headerKey: string | null;
  /** The exact request body text (may be empty). */
  rawBody: string;
}

export interface IdempotencyResult<T> {
  status: number;
  body: T;
  /** True when this is a stored response from an earlier identical request, not a fresh call to `run`. */
  replayed: boolean;
}

/**
 * D#31 API-1 criterion 7. Wraps a route's real work (`run`) with the
 * idempotency-key protocol: a `never` route rejects the header outright;
 * a `required` route demands one; when a key is present and previously
 * seen with the same principal, method, concrete path and body, the
 * stored response replays instead of `run` executing again; a
 * same-key-different-body, same-key-different-principal or
 * same-key-different-request-target request is rejected without ever
 * exposing the earlier response; a key another request is still
 * processing gets 409.
 *
 * Fix round item 1 (CWE-706 / OWASP A04, security review of this PR):
 * the replay comparison used to check only `principalId` and the body
 * hash -- `method`/`path` were written on claim and never read back, so
 * the same key reused against a different route (or the same route
 * template with a different path parameter) replayed the first route's
 * response and the second route's handler never ran. `req.path` MUST be
 * the concrete, normalized request path (`new URL(req.url).pathname`),
 * never a route template -- `handler.ts` is responsible for that.
 */
export async function withIdempotency<T>(
  pool: Pool,
  req: IdempotencyRequest,
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdempotencyResult<T>> {
  if (req.headerKey !== null) {
    assertValidIdempotencyKeyHeader(req.headerKey);
  }

  if (req.mode === "never") {
    if (req.headerKey) {
      throw new IdempotencyNotSupportedError();
    }
    const result = await run();
    return { ...result, replayed: false };
  }

  if (!req.headerKey) {
    if (req.mode === "required") {
      throw new IdempotencyKeyRequiredError();
    }
    const result = await run();
    return { ...result, replayed: false };
  }

  const requestSha256 = sha256Hex(req.rawBody);
  const claim = await withTenant(pool, req.accountId, (client) =>
    claimIdempotencyKey(client, {
      key: req.headerKey!,
      principalId: req.principalId,
      method: req.method,
      path: req.path,
      requestSha256,
    }),
  );

  if (claim.state === "in_progress") {
    throw new IdempotencyInProgressError();
  }
  if (claim.state === "completed") {
    if (
      claim.principalId !== req.principalId ||
      claim.method !== req.method ||
      claim.path !== req.path ||
      claim.requestSha256 !== requestSha256
    ) {
      throw new IdempotencyKeyReusedError();
    }
    return { status: claim.response.status, body: claim.response.body as T, replayed: true };
  }

  // Fix round item 6 (security review of this PR): only release the key
  // when `run` itself throws -- before this fix, ANY error here,
  // including one from `completeIdempotencyKey` AFTER `run` already
  // succeeded, released the row, letting a retry re-execute the side
  // effect. The Spec's contract doesn't name a required behavior for a
  // post-success completion-write failure, so this keeps the row
  // `in_progress` until its 24h expiry: a retry gets 409
  // `idempotency_in_progress` instead of a second run, per this PR's
  // body.
  let result: { status: number; body: T };
  try {
    result = await run();
  } catch (err) {
    await withTenant(pool, req.accountId, (client) => releaseIdempotencyKey(client, req.headerKey!)).catch(
      () => {
        // Best-effort: the original error below is what the caller needs.
      },
    );
    throw err;
  }

  await withTenant(pool, req.accountId, (client) =>
    completeIdempotencyKey(client, req.headerKey!, result, null),
  );
  return { ...result, replayed: false };
}
