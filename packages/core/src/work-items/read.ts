import type { Pool } from 'pg';
import { parseProvenance } from '@fx/trust';
import { toQueueRank } from './priority.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import type { WorkItemStage } from './stages.js';

/** D#31 comment 18494573 (C7): this module's own local copy of the ctx principal shape. */
export interface Principal {
  accountId: string;
  userId: string;
}

/** D#31 API-3a: `(ctx:{pool, principal}, input)`. */
export interface WorkItemsReadCtx {
  pool: Pool;
  principal: Principal;
}

/** `work_items.priority` 0..3 as the word clients see; the number never leaves the core. */
export const WORK_ITEM_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const OWN_PLAN_USAGE_STATES = ['recorded', 'not_priced', 'not_recorded'] as const;
export type OwnPlanUsageState = (typeof OWN_PLAN_USAGE_STATES)[number];

/** "The v1 contract" > work item DTO (API-3a criterion 3), corrected by C10: `stage` is D#45's `work_items.stage`, not `work_items.state`. `issue_number` is `work_items.gh_number`. */
export interface WorkItemDTO {
  id: string;
  repo_id: string | null;
  kind: string | null;
  issue_number: number | null;
  stage: WorkItemStage;
  provenance: 'internal' | 'external';
  priority: WorkItemPriority;
  queue_rank: number | null;
  cost_usd: number;
  /**
   * D#6 R2b-5a: what this item's runner runs would have cost at API prices. Information; NEVER part of `cost_usd` or any spend.
   * C42-5: a number only when `own_plan_usage_state` is `recorded` (every finished runner run has a priced row, or the item has none).
   * `null` otherwise, so "not recorded" and "not priced" are never read as $0.
   */
  own_plan_api_equivalent_usd: number | null;
  /** C42-5: `not_recorded` when a finished runner run has no usage row, else `not_priced` when one has tokens and no price, else `recorded`. */
  own_plan_usage_state: OwnPlanUsageState;
  /** C42-5: the tokens the item's runner runs reported (all zero when none did). */
  own_plan_tokens: { input: number; output: number; cache_read: number; cache_write: number };
  created_at: string;
  updated_at: string;
}

interface WorkItemRow {
  id: string;
  repo_id: string | null;
  kind: string | null;
  gh_number: string | null;
  stage: string;
  provenance: string;
  priority: number;
  queue_rank: string | null; // bigint arrives as text
  cost_usd: string;
  own_plan_api_equivalent_usd: string;
  own_plan_unrecorded: string;
  own_plan_unpriced: string;
  own_plan_input: string;
  own_plan_output: string;
  own_plan_cache_read: string;
  own_plan_cache_write: string;
  created_at: Date;
  updated_at: Date;
  created_at_cursor: string; // fix round 1: see runs/read.ts's RunRow.created_at_cursor
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `cost_usd` is not a stored column -- it's the sum of every run's own
 * `usd` under this work item, the same "derive a cost from agent_runs
 * rather than add a column to keep in sync" shape
 * `role-settings/list.ts`'s median-cost query already uses. `GROUP BY
 * wi.id` alone lets the other `wi.*` columns through ungrouped: `id` is
 * `work_items`' PRIMARY KEY, so every other column is functionally
 * dependent on it.
 */
const WORK_ITEM_SELECT = `
  SELECT wi.id, wi.repo_id, wi.kind, wi.gh_number, wi.stage, wi.provenance, wi.priority, wi.queue_rank,
         wi.created_at, wi.updated_at,
         to_char(wi.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
         COALESCE(SUM(ar.usd), 0) AS cost_usd,
         -- D#6 R2b-5a: its own subquery over its own table, so the join above (and cost_usd) is untouched by runner runs.
         COALESCE((SELECT SUM(u.api_equivalent_usd) FROM runner_run_usage u JOIN agent_runs rr ON rr.account_id = u.account_id AND rr.id = u.run_id
                    WHERE rr.work_item_id = wi.id AND rr.account_id = wi.account_id), 0) AS own_plan_api_equivalent_usd,
         -- C42-5: a claimed runner run that has finished is "recorded" only if it has a usage row, and "priced" only if that row has a figure.
         (SELECT COUNT(*) FROM agent_runs rr WHERE rr.work_item_id = wi.id AND rr.account_id = wi.account_id AND rr.runtime = 'runner' AND rr.runner_id IS NOT NULL
             AND rr.status NOT IN ('pending', 'running')
             AND NOT EXISTS (SELECT 1 FROM runner_run_usage u WHERE u.account_id = rr.account_id AND u.run_id = rr.id)) AS own_plan_unrecorded,
         (SELECT COUNT(*) FROM runner_run_usage u JOIN agent_runs rr ON rr.account_id = u.account_id AND rr.id = u.run_id
           WHERE rr.work_item_id = wi.id AND rr.account_id = wi.account_id AND rr.status NOT IN ('pending', 'running') AND u.api_equivalent_usd IS NULL) AS own_plan_unpriced,
         COALESCE((SELECT SUM(u.input_tokens) FROM runner_run_usage u JOIN agent_runs rr ON rr.account_id = u.account_id AND rr.id = u.run_id WHERE rr.work_item_id = wi.id AND rr.account_id = wi.account_id), 0) AS own_plan_input,
         COALESCE((SELECT SUM(u.output_tokens) FROM runner_run_usage u JOIN agent_runs rr ON rr.account_id = u.account_id AND rr.id = u.run_id WHERE rr.work_item_id = wi.id AND rr.account_id = wi.account_id), 0) AS own_plan_output,
         COALESCE((SELECT SUM(u.cache_read_tokens) FROM runner_run_usage u JOIN agent_runs rr ON rr.account_id = u.account_id AND rr.id = u.run_id WHERE rr.work_item_id = wi.id AND rr.account_id = wi.account_id), 0) AS own_plan_cache_read,
         COALESCE((SELECT SUM(u.cache_write_tokens) FROM runner_run_usage u JOIN agent_runs rr ON rr.account_id = u.account_id AND rr.id = u.run_id WHERE rr.work_item_id = wi.id AND rr.account_id = wi.account_id), 0) AS own_plan_cache_write
    FROM work_items wi
    LEFT JOIN agent_runs ar ON ar.work_item_id = wi.id AND ar.account_id = wi.account_id
`;

function failPriority(value: number): never {
  throw new Error(`work item priority ${value} is out of range`);
}

/** C42-5: the item's runner usage state, derived from current rows on every read. A missing record outranks a missing price. */
function ownPlanState(row: WorkItemRow): OwnPlanUsageState {
  if (Number(row.own_plan_unrecorded) > 0) return 'not_recorded';
  return Number(row.own_plan_unpriced) > 0 ? 'not_priced' : 'recorded';
}

function toDTO(row: WorkItemRow): WorkItemDTO {
  const ownState = ownPlanState(row);
  return {
    id: row.id,
    repo_id: row.repo_id,
    kind: row.kind,
    issue_number: row.gh_number === null ? null : Number(row.gh_number),
    // The stage CHECK constraint (0610) already restricts this column to
    // WORK_ITEM_STAGES; this cast documents that invariant.
    stage: row.stage as WorkItemStage,
    // D#103 / correction C10: read through parseProvenance, never trusted
    // as a bare string -- throws on anything but 'internal'/'external'.
    provenance: parseProvenance(row.provenance),
    // The priority CHECK (0670) keeps this in 0..3; a stray value fails loudly rather than reading as 'undefined'.
    priority: WORK_ITEM_PRIORITIES[row.priority] ?? failPriority(row.priority),
    queue_rank: toQueueRank(row.queue_rank),
    cost_usd: Number(row.cost_usd),
    own_plan_api_equivalent_usd: ownState === 'recorded' ? Number(row.own_plan_api_equivalent_usd) : null,
    own_plan_usage_state: ownState,
    own_plan_tokens: { input: Number(row.own_plan_input), output: Number(row.own_plan_output), cache_read: Number(row.own_plan_cache_read), cache_write: Number(row.own_plan_cache_write) },
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** D#31 API-3a criterion 2 (CWE-639): see `runs/read.ts`'s `getRun` -- identical reasoning (malformed id -> NotFoundError before any query; RLS handles cross-tenant). */
export async function getWorkItem(ctx: WorkItemsReadCtx, id: string): Promise<WorkItemDTO> {
  if (!UUID_RE.test(id)) {
    throw new NotFoundError(`work item ${id} not found`);
  }
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} WHERE wi.id = $1::uuid GROUP BY wi.id`, [
      id,
    ]);
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`work item ${id} not found`);
    }
    return toDTO(row);
  });
}

export interface ListWorkItemsInput {
  repoId?: string;
  stage?: WorkItemStage;
  /** Already validated (1..MAX_LIMIT) by packages/api/src/pagination.ts's parseLimit. */
  limit: number;
  /** `queue`: the pick order (priority, rank with unranked last, created_at, id), ascending. Omitted: newest first. */
  sort?: 'queue';
  /**
   * Already decoded by packages/api/src/pagination.ts. `createdAt` is full-precision text (fix round 1) -- never a JS `Date`.
   * Under `sort: 'queue'` it also carries `priority` and `queueRank` (text, null = unranked).
   */
  cursor?: ListWorkItemsCursor;
}

export interface ListWorkItemsCursor {
  createdAt: string;
  id: string;
  priority?: number;
  queueRank?: string | null;
}

export interface ListWorkItemsResult {
  data: WorkItemDTO[];
  nextCursor: ListWorkItemsCursor | null;
}

/** Keyset predicate for `sort: 'queue'` ($6 priority, $7 rank, with $3/$4 the created_at/id): NULL ranks sort last inside a priority. */
const QUEUE_AFTER = `
          AND ($3::timestamptz IS NULL OR wi.priority > $6::int OR (wi.priority = $6::int AND (
                 ($7::bigint IS NOT NULL AND (wi.queue_rank > $7::bigint OR wi.queue_rank IS NULL))
              OR (wi.queue_rank IS NOT DISTINCT FROM $7::bigint AND (wi.created_at, wi.id) > ($3::timestamptz, $4::uuid)))))`;
const DEFAULT_AFTER = `
          AND ($3::timestamptz IS NULL OR (wi.created_at, wi.id) < ($3::timestamptz, $4::uuid))`;

/** D#31 API-3a criterion 1: keyset pagination on `(created_at, id)`, mirroring `runs/read.ts`'s `listRuns` exactly; `sort: 'queue'` pages on the pick order instead. */
export async function listWorkItems(ctx: WorkItemsReadCtx, input: ListWorkItemsInput): Promise<ListWorkItemsResult> {
  const { accountId, userId } = ctx.principal;
  const { repoId, stage, limit, cursor, sort } = input;
  const queue = sort === 'queue';
  if (queue && cursor && cursor.priority === undefined) throw new Error('a queue cursor must carry priority and queueRank');
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<WorkItemRow>(
      `${WORK_ITEM_SELECT}
        WHERE ($1::uuid IS NULL OR wi.repo_id = $1::uuid)
          AND ($2::text IS NULL OR wi.stage = $2::text)
          -- D#483: the webhook's row for an issue, retired by triage in favour of the pipeline's root (a closed transition
          -- sourced "superseded:<root>"), is bookkeeping, not work: the list hides it. getWorkItem still returns it. Only a
          -- closed row can be one, so the lookup (served by the unique (account_id, work_item_id, to_stage, source_ref)
          -- index) runs for closed rows alone.
          AND (wi.stage <> 'closed' OR NOT EXISTS (
                SELECT 1 FROM work_item_transitions st
                 WHERE st.account_id = wi.account_id AND st.work_item_id = wi.id AND st.to_stage = 'closed' AND starts_with(st.source_ref, 'superseded:')))${queue ? QUEUE_AFTER : DEFAULT_AFTER}
        GROUP BY wi.id
        ORDER BY ${queue ? 'wi.priority, wi.queue_rank NULLS LAST, wi.created_at, wi.id' : 'wi.created_at DESC, wi.id DESC'}
        LIMIT $5::int`,
      [
        repoId ?? null,
        stage ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
        ...(queue ? [cursor?.priority ?? null, cursor?.queueRank ?? null] : []),
      ],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    return {
      data: page.map(toDTO),
      nextCursor:
        hasMore && lastRow
          ? {
              createdAt: lastRow.created_at_cursor,
              id: lastRow.id,
              ...(queue ? { priority: lastRow.priority, queueRank: lastRow.queue_rank } : {}),
            }
          : null,
    };
  });
}
