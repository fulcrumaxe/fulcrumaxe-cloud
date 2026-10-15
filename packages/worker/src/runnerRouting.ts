import type { PoolClient } from "pg";
import { LIGHT_JOB_ROLES, MAX_HEAVY_CAPACITY, MAX_LIGHT_CAPACITY, MAX_TOTAL_CAPACITY, RUNNER_ELIGIBLE_ROLES } from "@fulcrumaxe/runner-protocol";
import { RUNNER_HANDOFF_MIN_PROTOCOL_VERSION, RUNNER_ONLINE_SECONDS, PREFER_HOLD_MAX_SECONDS } from "@fx/runner";

/**
 * D#605 FL-4: routing rules in the claim. A rule only NARROWS or REORDERS what the claim's existing filters (repo scope, roles, visibility, the subscription
 * filter, approval, the limits) already allow: everything here is one more AND in the same candidate SELECT, never an OR and never a way to widen it. Nothing
 * read here (a fact a runner reported, a label, a rank, a preference) is an authorization input; the runner's own row, its registrant and the run's
 * initiator and approver decide who may take a run, exactly as before.
 *
 * What a poll loads, once: the polling runner's own facts and labels, and the other runners of the account that are AVAILABLE as preferred runners. The
 * rest is arithmetic over those in the SELECT, with no table read per candidate row.
 *
 * Requirements (`require`, per key the item's value replaces the repo's):
 *   - os, arch, engine: equal to the polling runner's reported fact. A runner that reported no facts meets none of them.
 *   - labels: every label is among the runner's labels (cloud-set, `runner_settings.labels`).
 *   - heavy_labels: the same, but only for a run of the heavy class.
 *   - the job's own `requires_engine` (signed by the cloud): same test as `engine`. No person can set or clear it.
 * Prefer (`prefer`, runner ids in order): a run whose list ranks other runners above the polling one is held (skipped, not failed) until every higher-ranked
 * runner is unavailable, or has polled since the run became claimable, or PREFER_HOLD_MAX_SECONDS have passed since then. A runner is unavailable when it is
 * offline (RUNNER_ONLINE_SECONDS), paused, draining, revoked, below the handoff protocol version, does not cover the run's repo or role, or has no free slot
 * in the run's class; such a runner is simply left out of the loaded set, and so can never hold anything. A removed runner's stored id is ignored for the same reason.
 */

/** The facts and labels of the polling runner, and the preferred-runner set, as the candidate query takes them (parameters 14 to 19). */
export interface PollRouting {
  os: string | null;
  arch: string | null;
  engine: string | null;
  /** JSON array of the runner's labels. */
  labels: string;
  /** JSON array of the available peers: { id, repos, roles, light_free, heavy_free, stamp }. */
  peers: string;
}

interface PeerRow {
  id: string;
  allowed_repo_ids: string[];
  allowed_roles: string[];
  stamp: string | null;
  declared: boolean | null;
  light_limit: number | null;
  heavy_limit: number | null;
  light: string;
  heavy: string;
}

/** The free slots one peer has per class, from its declared limits (else one job in total, as the claim treats an older runner) less what the cloud counts. */
function freeSlots(row: PeerRow): { light: boolean; heavy: boolean } {
  const light = Number(row.light);
  const heavy = Number(row.heavy);
  if (row.declared === true && row.light_limit !== null && row.heavy_limit !== null) {
    const headroom = Math.max(0, MAX_TOTAL_CAPACITY - light - heavy);
    return {
      light: Math.min(Math.max(0, Math.min(row.light_limit, MAX_LIGHT_CAPACITY) - light), headroom) > 0,
      heavy: Math.min(Math.max(0, Math.min(row.heavy_limit, MAX_HEAVY_CAPACITY) - heavy), headroom) > 0,
    };
  }
  const free = Math.max(0, 1 - light - heavy) > 0;
  return { light: free, heavy: free };
}

/** Reads, in the caller's tenant transaction, what the candidate query needs about the polling runner and its available peers. */
export async function loadPollRouting(client: PoolClient, input: { accountId: string; runnerId: string; nowMs: number }): Promise<PollRouting> {
  const own = await client.query<{ os: string | null; arch: string | null; sandbox_engine: string | null; labels: string[] | null }>(
    `SELECT f.os, f.arch, f.sandbox_engine, s.labels
       FROM runners r
       LEFT JOIN runner_facts f ON f.runner_id = r.id AND f.account_id = r.account_id
       LEFT JOIN runner_settings s ON s.runner_id = r.id AND s.account_id = r.account_id
      WHERE r.id = $1 AND r.account_id = $2`,
    [input.runnerId, input.accountId],
  );
  const eligible: readonly string[] = RUNNER_ELIGIBLE_ROLES;
  const { rows } = await client.query<PeerRow>(
    `SELECT r.id, r.allowed_repo_ids, r.allowed_roles, c.declared, c.light_limit, c.heavy_limit, run.light, run.heavy,
            to_char(st.last_claim_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp
       FROM runners r
       LEFT JOIN runner_settings s ON s.runner_id = r.id AND s.account_id = r.account_id
       LEFT JOIN runner_capacity c ON c.runner_id = r.id AND c.account_id = r.account_id
       LEFT JOIN runner_claim_stamps st ON st.runner_id = r.id AND st.account_id = r.account_id
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE a.role = ANY($5::text[])) AS light, count(*) FILTER (WHERE NOT a.role = ANY($5::text[])) AS heavy
           FROM agent_runs a WHERE a.account_id = r.account_id AND a.runner_id = r.id AND a.runtime = 'runner' AND a.status = 'running'
       ) run ON true
      WHERE r.account_id = $1 AND r.id <> $2 AND r.revoked_at IS NULL
        AND r.last_seen_at > $3::timestamptz - make_interval(secs => $4::int)
        AND r.protocol_version >= $6::int
        AND s.paused_at IS NULL AND COALESCE(s.draining, false) = false`,
    [input.accountId, input.runnerId, new Date(input.nowMs), RUNNER_ONLINE_SECONDS, LIGHT_JOB_ROLES, RUNNER_HANDOFF_MIN_PROTOCOL_VERSION],
  );
  const peers = [];
  for (const row of rows) {
    const roles = row.allowed_roles.length === 0 ? [...eligible] : row.allowed_roles.filter((role) => eligible.includes(role));
    if (row.allowed_repo_ids.length === 0 || roles.length === 0) continue;
    const free = freeSlots(row);
    peers.push({ id: row.id, repos: row.allowed_repo_ids, roles, light_free: free.light, heavy_free: free.heavy, stamp: row.stamp });
  }
  const facts = own.rows[0];
  return { os: facts?.os ?? null, arch: facts?.arch ?? null, engine: facts?.sandbox_engine ?? null, labels: JSON.stringify(facts?.labels ?? []), peers: JSON.stringify(peers) };
}

/** The values of parameters 14 to 19 of the candidate query, in order. */
export const routingParams = (routing: PollRouting): unknown[] => [routing.os, routing.arch, routing.engine, routing.labels, routing.peers, PREFER_HOLD_MAX_SECONDS];

/**
 * Joined after `agent_runs a`, `repos r` and the candidate query's own `work_items w` (the placement join, same repo only; this shares it and adds no second
 * join or alias): the run's effective rules, worked out once per row from columns already read.
 */
export const ROUTING_JOIN_SQL = `CROSS JOIN LATERAL (SELECT
                   COALESCE(w.runner_routing #>> '{require,os}', r.runner_routing #>> '{require,os}') AS req_os,
                   COALESCE(w.runner_routing #>> '{require,arch}', r.runner_routing #>> '{require,arch}') AS req_arch,
                   COALESCE(w.runner_routing #>> '{require,engine}', r.runner_routing #>> '{require,engine}') AS req_engine,
                   COALESCE(w.runner_routing #> '{require,labels}', r.runner_routing #> '{require,labels}', '[]'::jsonb) AS req_labels,
                   COALESCE(w.runner_routing #> '{require,heavy_labels}', r.runner_routing #> '{require,heavy_labels}', '[]'::jsonb) AS req_heavy,
                   a.job_signed #>> '{job,requires_engine}' AS job_engine,
                   COALESCE(w.runner_routing -> 'prefer', r.runner_routing -> 'prefer', '[]'::jsonb) AS prefer,
                   GREATEST(a.claimable_since, a.claimable_after) AS anchor) rt`;

/**
 * ANDed into the candidate WHERE. Parameter 7 is the polling runner, 8 the clock, 10 the light roles; 14 to 19 are `routingParams`. The hold reads only the
 * parameters (the loaded peers), so it adds no table access per candidate, and a held run is skipped here and so never uses up one of the poll's attempts.
 */
export const ROUTING_WHERE_SQL = `AND (rt.req_os IS NULL OR rt.req_os = $14::text)
                  AND (rt.req_arch IS NULL OR rt.req_arch = $15::text)
                  AND (rt.req_engine IS NULL OR rt.req_engine = $16::text)
                  AND (rt.job_engine IS NULL OR rt.job_engine = $16::text)
                  AND $17::jsonb @> rt.req_labels
                  AND (a.role = ANY($10::text[]) OR $17::jsonb @> rt.req_heavy)
                  AND (jsonb_array_length(rt.prefer) = 0 OR $8::timestamptz >= rt.anchor + make_interval(secs => $19::int) OR NOT EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(rt.prefer) WITH ORDINALITY AS pf(rid, ord)
                      JOIN jsonb_to_recordset($18::jsonb) AS u(id text, repos jsonb, roles jsonb, light_free boolean, heavy_free boolean, stamp timestamptz) ON u.id = pf.rid
                     WHERE pf.ord < COALESCE((SELECT q.ord FROM jsonb_array_elements_text(rt.prefer) WITH ORDINALITY AS q(rid, ord) WHERE q.rid = ($7::uuid)::text), jsonb_array_length(rt.prefer) + 1)
                       AND u.repos ? (a.dispatch_repo_id)::text AND u.roles ? a.role
                       AND CASE WHEN a.role = ANY($10::text[]) THEN u.light_free ELSE u.heavy_free END
                       AND (u.stamp IS NULL OR u.stamp < rt.anchor)))`;
