import type { Pool } from 'pg';
import { withTenant } from './withTenant.js';

/**
 * D#483 S4-c: the discovery queue, over migrations/0859_discovery_runs.sql.
 *
 * Three triggers queue a discovery for each product repository (a `team` repo that is attached to an installation): the app
 * installation was created, repositories were added to an installation, and the account's subscription became active. Queuing is
 * idempotent per repository and trigger: the row's key is (repo, trigger, trigger_ref), where the ref is `installation:<id>` (installation_created: the webhook and the install callback share it), the GitHub delivery id
 * (the two GitHub triggers) or the Stripe subscription id (activation), so a replayed delivery or event inserts nothing and
 * returns nothing. `ON CONFLICT DO NOTHING` is the whole idempotency rule; no caller checks first.
 *
 * Queuing writes only the queue. Whether a run is allowed to read anything (free preview, repo disconnected, discovery switched off)
 * is decided when the run starts, from the current rows, and recorded as the run's skip reason.
 */
export const DISCOVERY_TRIGGERS = ['installation_created', 'repos_added', 'activation', 'sweep'] as const;
export type DiscoveryTrigger = (typeof DISCOVERY_TRIGGERS)[number];

export interface QueuedDiscovery {
  id: string;
  repoId: string;
}

const REF_RE = /^[\x21-\x7e]{1,200}$/;

export type DiscoveryScope =
  | { kind: 'installation'; installationId: string; ghRepoIds?: readonly number[] }
  | { kind: 'account' };

/**
 * Queues one discovery per product repository in `scope` and answers the rows it actually created (none for a replay).
 * `ref` is the installation ref, delivery id or subscription id; it is printable ASCII and at most 200 characters or this throws before any write.
 */
export async function queueDiscoveries(pool: Pool, accountId: string, scope: DiscoveryScope, trigger: DiscoveryTrigger, ref: string): Promise<QueuedDiscovery[]> {
  if (trigger === 'sweep' || !DISCOVERY_TRIGGERS.includes(trigger)) throw new Error('discovery: unknown trigger');
  if (!REF_RE.test(ref)) throw new Error('discovery: invalid trigger reference');
  return withTenant(pool, accountId, async (client) => {
    const ids = scope.kind === 'installation' ? (scope.ghRepoIds ?? null) : null;
    const { rows } = await client.query<{ id: string; repo_id: string }>(
      `INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref)
       SELECT r.account_id, r.id, $3, $4
         FROM repos r
        WHERE r.account_id = $1 AND r.product = 'team' AND r.installation_id IS NOT NULL
          AND ($2::uuid IS NULL OR r.installation_id = $2::uuid)
          AND ($5::bigint[] IS NULL OR r.gh_repo_id = ANY($5::bigint[]))
        ORDER BY r.id
       ON CONFLICT (repo_id, trigger, trigger_ref) DO NOTHING
       RETURNING id, repo_id`,
      [accountId, scope.kind === 'installation' ? scope.installationId : null, trigger, ref, ids === null ? null : [...ids]],
    );
    return rows.map((r) => ({ id: r.id, repoId: r.repo_id }));
  });
}

/** D#483 S5-g2: queues the sweep's discovery of one repository for one period (`ref` is the UTC day or ISO week the list names). Answers the new row's id, or null when that period was already queued. */
export async function queueSweepDiscovery(pool: Pool, accountId: string, repoId: string, ref: string): Promise<string | null> {
  if (!REF_RE.test(ref)) throw new Error('discovery: invalid trigger reference');
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref) VALUES ($1, $2, 'sweep', $3)
       ON CONFLICT (repo_id, trigger, trigger_ref) DO NOTHING RETURNING id`,
      [accountId, repoId, ref],
    );
    return rows[0]?.id ?? null;
  });
}
