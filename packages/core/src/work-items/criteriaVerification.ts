/**
 * Issue #757 "record": a person's confirmation that they checked the criteria a reviewer could not verify in its own
 * environment (`UNVERIFIABLE_ESCALATION_CODE`, reviewHold.ts), stored as its own fact (migration 1010) rather than a
 * synthesized pass row in `agent_runs` -- no reviewer is asked again, and nothing claims the reviewer itself passed.
 *
 * `readUnverifiableStop` derives the confirm list a card would show, from the reviewer's own stored envelope, never
 * from anything a request sent. `writeCriteriaVerifications` records it, and `readVerifiedRoles` answers which roles a
 * head already has a record for. `matchesUnverifiableStop` is the pure all-or-nothing check a caller (the operator
 * move that performs the confirmation) runs before writing anything: a partial, extra or repeated pair fails it.
 */
import type { PoolClient } from 'pg';
import { MAX_UNVERIFIABLE_CHARS, readUnverifiable } from './unverifiable.js';
import { UNVERIFIABLE_ESCALATION_CODE } from './reviewHold.js';
import { VERDICT_ROLES } from './verdictRoles.js';

/** One criterion a reviewer could not verify, identified by its index into that run's own stored, ordered list. */
export interface UnverifiableCriterionItem {
  index: number;
  criterion: string;
  reason: string;
}

/** One gated role's unverifiable items on the stop's head, and the run they were read from. */
export interface UnverifiableStopRole {
  role: string;
  runId: string;
  items: UnverifiableCriterionItem[];
}

/** The confirm list for an item parked at Needs a person by a `reviewer_unverifiable` escalation. */
export interface UnverifiableStop {
  headSha: string;
  roles: UnverifiableStopRole[];
}

/** One criterion a person has confirmed, as the request names it: a run and the index into that run's stored list. */
export interface ConfirmedCriterion {
  runId: string;
  index: number;
}

/**
 * One run's confirm-list items, in stored order, via `readUnverifiable`'s own bounds (at most `MAX_UNVERIFIABLE`, each
 * text cut to `MAX_UNVERIFIABLE_CHARS`; a missing or malformed list, or one with no usable item, gives none). Pure:
 * every bound and malformed-input case is `readUnverifiable`'s own, tested here only as this module's own entry point.
 */
export function criteriaItemsFromEnvelope(raw: unknown): UnverifiableCriterionItem[] {
  return readUnverifiable(raw).map((item, index) => ({ index, criterion: item.criterion, reason: item.reason }));
}

/**
 * Null unless the newest escalation since the item last reached Needs a person has code `reviewer_unverifiable` AND at
 * least one gated role (`VERDICT_ROLES`) still has something to confirm on that EXACT head (same rule and window as
 * `readEscalationCode`, reviewHold.ts). When it is not null: the head it stopped on and, for EVERY such role --
 * whose latest run on that head succeeded with envelope verdict `unverifiable` and at least one usable item -- that
 * role's run id and its items in stored order; not only the role the escalation's own `run_id` column names (that
 * column holds a single run; the escalation's `reasons` can name several roles).
 *
 * A stale escalation (every role's latest run since superseded by a real verdict, or still in flight) derives no
 * roles at all, and this answers null rather than `{ headSha, roles: [] }`: an empty confirm list is nothing to
 * confirm, and a caller must not treat it as a live stop (`matchesUnverifiableStop` matches an empty derived set
 * trivially, so a non-null-but-empty stop would let a press move the stage with nothing actually verified).
 */
export async function readUnverifiableStop(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<UnverifiableStop | null> {
  const { rows: escalations } = await client.query<{ code: string | null; head_sha: string | null }>(
    `SELECT e.code, e.head_sha FROM work_item_driver_events e
      WHERE e.work_item_id = $1::uuid AND e.kind = 'escalated'
        AND e.created_at >= COALESCE((SELECT max(t.created_at) FROM work_item_transitions t WHERE t.work_item_id = $1::uuid AND t.to_stage = 'needs_human'), '-infinity'::timestamptz)
      ORDER BY e.seq DESC LIMIT 1`,
    [workItemId],
  );
  const escalation = escalations[0];
  if (escalation === undefined || escalation.code !== UNVERIFIABLE_ESCALATION_CODE || escalation.head_sha === null) return null;
  const headSha = escalation.head_sha;

  const { rows } = await client.query<{ role: string; run_id: string; unverifiable: unknown; verdict: string | null; status: string }>(
    `SELECT role, id AS run_id, envelope -> 'unverifiable' AS unverifiable, envelope ->> 'verdict' AS verdict, status
       FROM agent_runs
      WHERE work_item_id = $1::uuid AND head_sha = $2 AND role = ANY($3::text[])
      ORDER BY role, created_at DESC, id DESC`,
    [workItemId, headSha, [...VERDICT_ROLES]],
  );

  const roles: UnverifiableStopRole[] = [];
  const latestSeen = new Set<string>();
  for (const row of rows) {
    // Rows are ordered newest-first per role: the first one seen for a role is its latest, exactly as the merge gate's own `is_latest` picks it.
    if (latestSeen.has(row.role)) continue;
    latestSeen.add(row.role);
    if (row.status !== 'succeeded' || row.verdict !== 'unverifiable') continue;
    const items = criteriaItemsFromEnvelope(row.unverifiable);
    if (items.length === 0) continue;
    roles.push({ role: row.role, runId: row.run_id, items });
  }
  if (roles.length === 0) return null;
  return { headSha, roles };
}

/**
 * Records one row per role, all on the caller's own client (the caller's transaction). The `criteria` text stored is
 * exactly what `role.items` carries -- derived server-side by `readUnverifiableStop` from the run's own envelope -- cut
 * to `MAX_UNVERIFIABLE_CHARS` again here as a second bound, so nothing a caller assembled by hand can ever exceed what
 * a reviewer could have written in the first place. A role already recorded for that head writes nothing for it (the
 * table's unique index, `ON CONFLICT DO NOTHING`): one set of rows survives a concurrent double press.
 *
 * The INSERT itself re-checks `role.runId` against `agent_runs`, in the account the row is written for: the run must
 * belong to this exact work item and head, be that exact role, have succeeded, and carry envelope verdict
 * `unverifiable` -- the same four facts `readUnverifiableStop` itself derived the row from. A caller that passes a run
 * id, role or head that do not actually hold those facts together (a stale caller, a bug in a later caller) writes
 * nothing for that role rather than a row whose `head_sha`/`role` is not actually backed by the run it names: the
 * binding this table's shape promises does not rest on caller discipline alone.
 */
export async function writeCriteriaVerifications(
  client: Pick<PoolClient, 'query'>,
  input: { workItemId: string; headSha: string; roles: readonly UnverifiableStopRole[]; verifiedBy: string },
): Promise<Array<{ id: string; role: string }>> {
  const written: Array<{ id: string; role: string }> = [];
  for (const role of input.roles) {
    const criteria = role.items.map((item) => ({ index: item.index, criterion: item.criterion.slice(0, MAX_UNVERIFIABLE_CHARS) }));
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO work_item_criteria_verifications (account_id, work_item_id, head_sha, role, run_id, criteria, verified_by)
       SELECT w.account_id, w.id, $2, $3, r.id, $5::jsonb, $6::uuid
         FROM work_items w
         JOIN agent_runs r
           ON r.account_id = w.account_id
          AND r.id = $4::uuid
          AND r.work_item_id = w.id
          AND r.head_sha = $2
          AND r.role = $3
          AND r.status = 'succeeded'
          AND r.envelope ->> 'verdict' = 'unverifiable'
        WHERE w.id = $1::uuid
       ON CONFLICT (account_id, work_item_id, head_sha, role) DO NOTHING
       RETURNING id`,
      [input.workItemId, input.headSha, role.role, role.runId, JSON.stringify(criteria), input.verifiedBy],
    );
    const id = rows[0]?.id;
    if (id !== undefined) written.push({ id, role: role.role });
  }
  return written;
}

/** The roles with a verification record on this exact head (one indexed read, `idx_work_item_criteria_verifications_item`). */
export async function readVerifiedRoles(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string, headSha: string): Promise<string[]> {
  const { rows } = await client.query<{ role: string }>(
    `SELECT role FROM work_item_criteria_verifications WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND head_sha = $3`,
    [accountId, workItemId, headSha],
  );
  return rows.map((r) => r.role);
}

/**
 * The all-or-nothing check: `confirmed` must name EXACTLY the `(runId, index)` pairs `stop.roles` derives, across every
 * role, no more, no fewer, and none repeated. A caller that confirms every pair but one, names a pair outside the
 * derived list, or sends the same pair twice gets `false` here and writes nothing.
 */
export function matchesUnverifiableStop(stop: Pick<UnverifiableStop, 'roles'>, confirmed: readonly ConfirmedCriterion[]): boolean {
  const derived = new Set<string>();
  for (const role of stop.roles) {
    for (const item of role.items) derived.add(`${role.runId}:${item.index}`);
  }
  if (confirmed.length !== derived.size) return false;
  const seen = new Set<string>();
  for (const c of confirmed) {
    const key = `${c.runId}:${c.index}`;
    if (seen.has(key) || !derived.has(key)) return false;
    seen.add(key);
  }
  return true;
}
