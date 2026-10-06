import type { Pool } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#31 comment 18494573 (C7): every domain module in this codebase keeps
 * its own local copy of this shape rather than sharing one exported type
 * -- this is this module's copy (matches
 * packages/core/src/role-settings/types.ts's `Principal`).
 */
export interface Principal {
  accountId: string;
  userId: string;
}

/** D#31 API-3a: `(ctx:{pool, principal}, input)` -- packages/api's route handlers wrap this directly. */
export interface RunsReadCtx {
  /** app_user pool -- every read here goes through withTenant/RLS. */
  pool: Pool;
  principal: Principal;
}

/** "The v1 contract" > run DTO (API-3a criterion 3). Field order matches the Spec's own list. */
export interface RunDTO {
  id: string;
  work_item_id: string | null;
  parent_run_id: string | null;
  role: string;
  status: string;
  usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  work_item_id: string | null;
  parent_run_id: string | null;
  role: string;
  status: string;
  usd: string | null;
  tokens_in: string | null;
  tokens_out: string | null;
  created_at: Date;
  updated_at: Date;
  created_at_cursor: string; // fix round 1: full-precision text cursor, cursor-only, never in the DTO
}

const RUN_COLUMNS = `id, work_item_id, parent_run_id, role, status, usd, tokens_in, tokens_out, created_at, updated_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRunDTO(row: RunRow): RunDTO {
  return {
    id: row.id,
    work_item_id: row.work_item_id,
    parent_run_id: row.parent_run_id,
    role: row.role,
    status: row.status,
    // usd (numeric) and the two bigint token columns come back from pg as
    // strings; Number(...) is safe here since neither ever nears MAX_SAFE_INTEGER.
    usd: row.usd === null ? null : Number(row.usd),
    tokens_in: row.tokens_in === null ? null : Number(row.tokens_in),
    tokens_out: row.tokens_out === null ? null : Number(row.tokens_out),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * D#31 API-3a criterion 2 (CWE-639): B's run id, a random uuid, or a
 * malformed id from A's principal all -> 404 not_found with identical
 * bodies. A malformed id must never reach Postgres (a non-uuid bound to
 * agent_runs.id throws 22P02, which mapError has no case for -> 500,
 * same CWE-755 shape pagination.ts's decodeCursor already guards for
 * cursor ids) -- checked here, before any query, so it takes the same
 * NotFoundError path as a nonexistent id. A cross-tenant id needs no
 * separate check: RLS (via withTenant) already returns zero rows for it.
 */
export async function getRun(ctx: RunsReadCtx, id: string): Promise<RunDTO> {
  if (!UUID_RE.test(id)) {
    throw new NotFoundError(`run ${id} not found`);
  }
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`run ${id} not found`);
    }
    return toRunDTO(row);
  });
}

export interface ListRunsInput {
  workItemId?: string;
  status?: string;
  /** Already validated (1..MAX_LIMIT) by `packages/api/src/pagination.ts`'s `parseLimit`. */
  limit: number;
  /** Already decoded by `packages/api/src/pagination.ts`'s `decodeCursor`. `createdAt` is the raw full-precision text (fix round 1) -- never a JS `Date`. */
  cursor?: { createdAt: string; id: string };
}

export interface ListRunsResult {
  data: RunDTO[];
  /** Raw (createdAt, id) of the row just past the returned page, or null on the last page. The route layer opaquely encodes this with `encodeCursor`. */
  nextCursor: { createdAt: string; id: string } | null;
}

/**
 * D#31 API-3a criterion 1: keyset pagination on `(created_at, id)`,
 * descending -- ties on `created_at` are broken by `id`, so no row is
 * ever duplicated or skipped across pages. Fetches `limit + 1` rows to
 * learn whether a next page exists without a separate COUNT query.
 */
export async function listRuns(ctx: RunsReadCtx, input: ListRunsInput): Promise<ListRunsResult> {
  const { accountId, userId } = ctx.principal;
  const { workItemId, status, limit, cursor } = input;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs
        WHERE ($1::uuid IS NULL OR work_item_id = $1::uuid)
          AND ($2::text IS NULL OR status = $2::text)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $5::int`,
      [workItemId ?? null, status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    return {
      data: page.map(toRunDTO),
      nextCursor: hasMore && lastRow ? { createdAt: lastRow.created_at_cursor, id: lastRow.id } : null,
    };
  });
}
