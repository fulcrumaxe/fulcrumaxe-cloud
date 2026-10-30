import { withTenant } from "@fx/spend";
import type { BuildPr, BuildState, BuildStatePort } from "../ports.js";

type TenantPool = Parameters<typeof withTenant>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The executor runs of an item, newest first, each with the pull request it recorded. The number is the one the cloud's `done` wrote for a runner
 * run (the `run.status_changed` event's `prNumber`), else the one the agent's envelope reports; the head is that event's `headOid`, else the
 * envelope's `publish.private_head`. The same sources the activity view and the branch sweep read, so the number a person sees is the number a
 * reversal acts on.
 */
const RUNS_SQL = `SELECT COALESCE(CASE WHEN ev.payload->>'prNumber' ~ '^[0-9]{1,9}$' THEN ev.payload->>'prNumber' END,
                        CASE WHEN r.envelope->>'pr_number' ~ '^[0-9]{1,9}$' THEN r.envelope->>'pr_number' END) AS pr_number,
                COALESCE(ev.payload->>'headOid', r.envelope->'publish'->>'private_head') AS head_sha
           FROM agent_runs r
           LEFT JOIN LATERAL (
             SELECT e.payload FROM run_events e
              WHERE e.account_id = r.account_id AND e.run_id = r.id AND e.kind = 'run.status_changed'
                AND e.payload->>'viaRunnerDone' = 'true' AND e.payload ? 'prNumber'
              ORDER BY e.seq DESC LIMIT 1) ev ON true
          WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.role = 'executor'
          ORDER BY r.created_at DESC, r.id DESC LIMIT 50`;

/**
 * The stage -> build stage map. `merged` is merged; `pr_opened`, `changes_requested` and `review_passed` are built; `in_progress` is building;
 * `triaged`, `discussing` and `spec_ready` have not started. `needs_human`, `closed_unmerged` and `closed` can be reached from either side of the
 * build, so they read the runs: a recorded pull request means built, an executor run without one means building, no run means not started.
 */
const FIXED: Record<string, BuildState["stage"]> = {
  triaged: "not_started",
  discussing: "not_started",
  spec_ready: "not_started",
  in_progress: "building",
  pr_opened: "built",
  changes_requested: "built",
  review_passed: "built",
  merged: "merged",
};

/** The real BuildStatePort (D#7 DP7-2c). It reads on every call: a reversal asks when it runs, not when it was requested. */
export function createBuildStatePort(pool: TenantPool): BuildStatePort {
  return {
    async stateOf(accountId, workItemId): Promise<BuildState> {
      if (!UUID.test(accountId)) throw new TypeError("accountId is not a UUID");
      if (!UUID.test(workItemId)) throw new TypeError("workItemId is not a UUID");
      return withTenant(pool, accountId, async (client) => {
        const item = await client.query<{ stage: string | null }>("SELECT stage FROM work_items WHERE account_id = $1 AND id = $2", [accountId, workItemId]);
        if (item.rows.length === 0) throw new Error("work item not found for this account");
        const stage = item.rows[0]!.stage ?? "triaged";
        const runs = await client.query<{ pr_number: string | null; head_sha: string | null }>(RUNS_SQL, [accountId, workItemId]);
        const hit = runs.rows.find((r) => r.pr_number !== null && Number(r.pr_number) > 0);
        let pr: BuildPr | null = null;
        if (hit) {
          if (!hit.head_sha || !SHA.test(hit.head_sha)) throw new Error("build state unreadable: the pull request has no recorded head");
          pr = { number: Number(hit.pr_number), headSha: hit.head_sha };
        }
        const fixed = FIXED[stage];
        if (fixed === "not_started") return { stage: "not_started", pr: null };
        if (fixed === "building") return { stage: "building", pr };
        if (fixed === "built" || fixed === "merged") {
          if (!pr) throw new Error("build state unreadable: the item is built but no pull request is recorded");
          return { stage: fixed, pr };
        }
        // needs_human, closed_unmerged, closed
        if (pr) return { stage: "built", pr };
        return runs.rows.length > 0 ? { stage: "building", pr: null } : { stage: "not_started", pr: null };
      });
    },
  };
}
