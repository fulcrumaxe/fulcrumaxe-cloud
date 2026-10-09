import type { Pool, PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { RUNNER_USAGE_COLUMN, toRunnerUsage, type RunnerUsage } from './runnerUsage.js';

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
  /** D#6 R2b-5a: where the run ran (`sandbox` or `runner`). */
  runtime: string;
  usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /** D#6 R2b-5a: a runner run only (absent on any other): what it would have cost at API prices, never spend. Null until the runner reports usage. */
  runner_usage?: RunnerUsage | null;
  created_at: string;
  updated_at: string;
  /**
   * D#6 R2b-4a follow-up: the member whose Claude plan the run was approved to use, or null while nobody has approved it. Read from the
   * stored `approved_by`, never from the current dial.
   */
  approved_by: { id: string; name: string } | null;
  /**
   * How `approved_by` came to be, from stored facts: `auto` when the claim approved it for the registrant (its decision receipt for
   * `runner_run_on_member_plan` exists), `manual` when a member pressed Approve, null while no one has approved. A later dial or consent change does not
   * move it. A run approved before the receipt existed reads `manual`.
   */
  approval: 'auto' | 'manual' | null;
}

interface RunRow {
  id: string;
  work_item_id: string | null;
  parent_run_id: string | null;
  role: string;
  status: string;
  runtime: string;
  usd: string | null;
  tokens_in: string | null;
  tokens_out: string | null;
  runner_usage_json: unknown;
  created_at: Date;
  updated_at: Date;
  created_at_cursor: string; // fix round 1: full-precision text cursor, cursor-only, never in the DTO
  approved_by: string | null;
  approved_by_name: string | null;
}

/** Shown where a member has no name on record. Never an email, an id or the word null (the same text the runner read model uses). */
const UNNAMED_MEMBER = 'A team member';

const RUN_COLUMNS = `id, work_item_id, parent_run_id, role, status, runtime, usd, tokens_in, tokens_out, ${RUNNER_USAGE_COLUMN}, created_at, updated_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor, approved_by,
  (SELECT COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, ''), '${UNNAMED_MEMBER}') FROM users u WHERE u.id = agent_runs.approved_by) AS approved_by_name`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids, among the given approved runs, that the claim approved by itself: the ones with a `runner_run_on_member_plan` decision receipt.
 * Only the claim's auto-approve definer writes one (through the receipt writer, in the same transaction as `approved_by`), and a manual
 * approval writes none. `app_user` may read receipts under row security for its own account. One query.
 */
async function autoApprovedIds(client: PoolClient, accountId: string, rows: RunRow[]): Promise<Set<string>> {
  const ids = rows.filter((r) => r.approved_by !== null).map((r) => r.id);
  if (ids.length === 0) return new Set();
  const { rows: found } = await client.query<{ run_id: string }>(
    `SELECT DISTINCT run_id::text AS run_id FROM decision_receipts
      WHERE account_id = $1 AND decision_type = 'runner_run_on_member_plan' AND class = 'human_over_the_loop' AND run_id = ANY($2::uuid[])`,
    [accountId, ids],
  );
  return new Set(found.map((r) => r.run_id));
}

function toRunDTO(row: RunRow, auto: Set<string>): RunDTO {
  const runnerUsage = toRunnerUsage(row.runtime, row.runner_usage_json);
  return {
    id: row.id,
    work_item_id: row.work_item_id,
    parent_run_id: row.parent_run_id,
    role: row.role,
    status: row.status,
    runtime: row.runtime,
    // usd (numeric) and the two bigint token columns come back from pg as
    // strings; Number(...) is safe here since neither ever nears MAX_SAFE_INTEGER.
    usd: row.usd === null ? null : Number(row.usd),
    tokens_in: row.tokens_in === null ? null : Number(row.tokens_in),
    tokens_out: row.tokens_out === null ? null : Number(row.tokens_out),
    ...(runnerUsage === undefined ? {} : { runner_usage: runnerUsage }),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    approved_by: row.approved_by === null ? null : { id: row.approved_by, name: row.approved_by_name ?? UNNAMED_MEMBER },
    approval: row.approved_by === null ? null : auto.has(row.id) ? 'auto' : 'manual',
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
    return toRunDTO(row, await autoApprovedIds(client, accountId, [row]));
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
    const auto = await autoApprovedIds(client, accountId, page);
    return {
      data: page.map((r) => toRunDTO(r, auto)),
      nextCursor: hasMore && lastRow ? { createdAt: lastRow.created_at_cursor, id: lastRow.id } : null,
    };
  });
}
