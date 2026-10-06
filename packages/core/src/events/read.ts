import type { Pool } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { getTenantRowOrNotFound } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#2 H11, corrected by D#31 comment 18494573 (C5): "The route file
 * `apps/web/app/api/runs/[runId]/stream/route.ts` and the `(team)/runs/**`
 * page are never built. The streams are D#31 API-5, and the UI is D#37
 * WS-F2." What ships here is the one service both the SSE replay (API-5)
 * and the JSON page mode use:
 *
 *   listRunEvents(ctx:{pool, principal}, runId, {afterSeq, limit})
 *     -> {data, next_after_seq}
 *
 * D#31 API-5 owns Last-Event-ID resume, the idle/heartbeat/revoked
 * lifecycle and the per-browser stream cap (H11's own criteria 3 and 4b
 * moved there per the same correction) -- this module only has to answer
 * "the events for run X after seq N", scoped to the caller's tenant.
 *
 * Matches `packages/core/src/runs/read.ts`'s own shape (D#31 API-3a)
 * deliberately -- same ctx, same NotFoundError-before-Postgres guard for
 * a malformed id, same keyset-with-lookahead pagination trick -- since
 * that module is this Spec's own precedent for "a service module under
 * packages/core that a v1 route wraps directly".
 */

/** D#31 comment 18494573 (C7): every domain module in this codebase keeps
 * its own local copy of this shape rather than sharing one exported type
 * (matches `packages/core/src/runs/read.ts`'s own `Principal`). */
export interface Principal {
  accountId: string;
  userId: string;
}

export interface EventsReadCtx {
  /** app_user pool -- every read here goes through withTenant/RLS. */
  pool: Pool;
  principal: Principal;
}

/** S8's own wire shape (D#45 C2): "Each line has exactly seq, kind, at
 * and payload, exactly as the Runs app's event API returns them." */
export interface RunEventDTO {
  seq: number;
  kind: string;
  at: string;
  payload: unknown;
}

export interface ListRunEventsInput {
  /** Events with `seq` greater than this are returned. Omitted (or 0)
   * means "from the start of the run". */
  afterSeq?: number;
  /** Already validated by the caller (a route's own query-schema
   * validation, exactly like `packages/core/src/runs/read.ts`'s
   * `ListRunsInput.limit`) -- this module trusts it as a positive
   * integer. */
  limit: number;
  /**
   * Bounds what one page holds in memory (the SSE replay, CWE-770). A
   * payload over `payloadCapBytes` is not fetched: the row comes back with
   * `{"truncated":true,"original_bytes":N}` in its place. The page also
   * stops once the rows so far, each counted at most `payloadCapBytes`,
   * reach `pageBudgetBytes` (the first row is always returned, so a page
   * is never empty while events remain); `next_after_seq` then points at
   * the last row returned. Both are applied in SQL, so the excess never
   * leaves Postgres. Omitted, the page is bounded by `limit` alone.
   */
  byteBounds?: { payloadCapBytes: number; pageBudgetBytes: number };
}

export interface ListRunEventsResult {
  data: RunEventDTO[];
  /** The last returned row's `seq`, or null on the last page. */
  next_after_seq: number | null;
}

interface RunEventRow {
  seq: string; // bigint comes back from pg as a string
  kind: string;
  created_at: Date;
  payload: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDTO(row: RunEventRow): RunEventDTO {
  return {
    seq: Number(row.seq),
    kind: row.kind,
    at: row.created_at.toISOString(),
    payload: row.payload,
  };
}

/**
 * Criterion 1 (CWE-639/755): another tenant's run id, a genuinely
 * nonexistent id, or a malformed id all throw `NotFoundError` -- never a
 * raw pg error and never a permission error that would confirm the run
 * exists on someone else's account.
 *
 * The malformed-id guard runs before any query reaches Postgres (mirrors
 * `runs/read.ts`'s `getRun`); the existence-plus-tenant-plus-active-
 * membership check reuses `getTenantRowOrNotFound` (H06's own sanctioned
 * "fetch my account's own row or 404" chokepoint -- its doc comment
 * names `agent_runs` as belonging to "H09/H11's routes").
 */
export async function listRunEvents(
  ctx: EventsReadCtx,
  runId: string,
  input: ListRunEventsInput,
): Promise<ListRunEventsResult> {
  if (!UUID_RE.test(runId)) {
    throw new NotFoundError(`run ${runId} not found`);
  }
  const { accountId, userId } = ctx.principal;

  // Confirms the run exists, belongs to this account, and that the
  // caller is still an active member -- before any run_events row is
  // ever returned for it.
  await getTenantRowOrNotFound(ctx.pool, accountId, userId, 'agent_runs', runId);

  const afterSeq = input.afterSeq ?? 0;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const bounds = input.byteBounds;
    if (bounds) {
      // `before` is the bytes of the rows ahead of this one; the first row (before = 0) always passes.
      const { rows: sized } = await client.query<RunEventRow & { fetched: string }>(
        `WITH sized AS (
           SELECT seq, kind, created_at, payload, octet_length(payload::text) AS n
             FROM run_events
            WHERE run_id = $1 AND seq > $2 AND kind NOT IN ('run.metering', 'run.input')
            ORDER BY seq ASC
            LIMIT $3
         ), cum AS (
           SELECT *, count(*) OVER () AS fetched,
                  coalesce(sum(least(n, $4::int)) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
             FROM sized
         )
         SELECT seq, kind, created_at, fetched,
                CASE WHEN n > $4::int THEN jsonb_build_object('truncated', true, 'original_bytes', n) ELSE payload END AS payload
           FROM cum
          WHERE before < $5::int
          ORDER BY seq ASC`,
        [runId, afterSeq, input.limit + 1, bounds.payloadCapBytes, bounds.pageBudgetBytes],
      );
      const fetched = sized[0] ? Number(sized[0].fetched) : 0;
      const page = sized.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        data: page.map(toDTO),
        next_after_seq: fetched > page.length && last ? Number(last.seq) : null,
      };
    }
    const { rows } = await client.query<RunEventRow>(
      `SELECT seq, kind, created_at, payload FROM run_events
        WHERE run_id = $1 AND seq > $2 AND kind NOT IN ('run.metering', 'run.input')
        ORDER BY seq ASC
        LIMIT $3`,
      [runId, afterSeq, input.limit + 1],
    );
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map(toDTO),
      next_after_seq: hasMore && last ? Number(last.seq) : null,
    };
  });
}
