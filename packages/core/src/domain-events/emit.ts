import type { PoolClient } from 'pg';
import { markWorkPending } from '../pendingWork.js';
import { utcMonthStart } from '../time.js';

/**
 * D#31 API-4a: the outbox writer. Every producer (H13a's pr.opened hook,
 * H21's markBroken, packages/spend's reserveWith deny paths, and later
 * H09/H14/D#29) calls this with the SAME `client` it already uses for its
 * own state change, so the event and the change it describes commit or
 * roll back together (0627_webhooks.sql's domain_events table).
 *
 * `type`/`accountId`/`payload` matches eventMapper.ts's own local
 * `DomainEvent` shape (that file keeps its own copy rather than depending
 * on this package).
 *
 * Resolved disagreement 8: `payload` carries ids, state enums and
 * platform-derived identifiers only -- never free text. Enforced by each
 * producer shaping its own payload, not by this function.
 */
export interface DomainEvent {
  type: string;
  accountId: string;
  /** Optional correlation id (a work_item id, run id, endpoint id, ...) --
   * never used for tenant scoping. */
  subjectId?: string | null;
  payload: Record<string, string | number | boolean | null>;
  /** Injectable clock, for fake-clock tests (e.g. emitBudgetExhaustedOnce's
   * month-boundary test). Defaults to the database's own `now()` -- never
   * the caller's wall clock -- when omitted, matching every other
   * `created_at` column in this schema. */
  createdAt?: Date;
}

export interface EmittedDomainEvent {
  /** The public "evt_"+uuid id -- what appears in the webhook envelope and
   * (later) the SSE stream. Never the private `seq`. */
  id: string;
}

/**
 * Inserts one `domain_events` row on `client`. Does not open, commit or
 * roll back a transaction -- that is entirely the caller's job, which is
 * the whole point: a caller inside a transaction that later throws leaves
 * no row (criterion 5's rollback test).
 */
export async function emitDomainEvent(client: PoolClient, event: DomainEvent): Promise<EmittedDomainEvent> {
  const { rows } = await client.query<{ id: string }>(
    event.createdAt
      ? `INSERT INTO domain_events (account_id, type, subject_id, payload, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id`
      : `INSERT INTO domain_events (account_id, type, subject_id, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
    event.createdAt
      ? [event.accountId, event.type, event.subjectId ?? null, JSON.stringify(event.payload), event.createdAt]
      : [event.accountId, event.type, event.subjectId ?? null, JSON.stringify(event.payload)],
  );
  // D#454 H3c: leave a marker (and ask for an early sweep) so the api-sweep cron does not skip this event. Fire and
  // forget; the caller's transaction is not held up, and the sweep's marker grace covers a not-yet-committed row.
  void markWorkPending('api-sweep', { kick: true });
  // RETURNING id on a single-row INSERT always yields exactly one row.
  return { id: rows[0]!.id };
}

/** The three `packages/spend` budgets `budget.exhausted`'s payload names. */
export type ExhaustedBudget = 'model' | 'foreground_compute' | 'background_compute';

/**
 * Criterion 5: "reserveWith emits budget.exhausted on model_budget_exceeded
 * or compute_cap_exceeded, at most once per budget per account per
 * calendar month (3 denials -> 1 event)."
 *
 * Race-safety: every caller of this (packages/spend/src/reserve.ts's
 * `reserveWith`) has already taken `pg_advisory_xact_lock(accountId,
 * budget)` before it can reach a deny path, so two concurrent denials for
 * the SAME (account, budget) are already serialized by the time either one
 * gets here -- the plain "check, then insert if absent" below needs no
 * additional locking of its own.
 */
export async function emitBudgetExhaustedOnce(
  client: PoolClient,
  accountId: string,
  budget: ExhaustedBudget,
  now: Date = new Date(),
): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM domain_events
     WHERE account_id = $1 AND type = 'budget.exhausted' AND payload ->> 'budget' = $2 AND created_at >= $3
     LIMIT 1`,
    [accountId, budget, utcMonthStart(now)],
  );
  if (rows.length > 0) {
    return;
  }
  await emitDomainEvent(client, {
    type: 'budget.exhausted',
    accountId,
    payload: { budget },
    createdAt: now,
  });
}
