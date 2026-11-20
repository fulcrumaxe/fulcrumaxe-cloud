import { MACHINE_ONBOARDING_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { RunnerCloudDeps } from "./http.js";

/**
 * D#845 ON-1b: the read model of what each of the account's machines last said about itself, for placement and onboarding steps. DISPLAY AND ROUTING ONLY: both facts are claims by a
 * semi-trusted machine, and nothing here gates a request. Integers, booleans and a time; no path, host name or free text exists to read.
 *
 * Fail closed: a missing fact is `null`, never a default. A runner that never reported its load (or whose hello declared a protocol below 22, or that has no facts row) has `host_load: null`; a runner that
 * never said whether it holds model credentials has `model_auth_present: null`. `host_load.seen_at` is when the cloud stored it, so a caller can show its age and decide how old is too old.
 * Revoked runners are not listed. The query carries its own account predicate on top of row security.
 */
export interface MachineFacts {
  runner_id: string;
  host_load: { mem_avail_mb: number; disk_free_mb: number; setups_running: number; seen_at: string } | null;
  model_auth_present: boolean | null;
}

interface FactsRow {
  runner_id: string;
  protocol_version: number | null;
  model_auth_present: boolean | null;
  host_mem_avail_mb: number | null;
  host_disk_free_mb: number | null;
  host_setups_running: number | null;
  host_load_at: Date | null;
}

/** The machine facts of every live runner of the account, by runner id. Read in the caller's tenant context. */
export async function readMachineFacts(deps: Pick<RunnerCloudDeps, "appUserPool">, accountId: string, userId: string): Promise<Map<string, MachineFacts>> {
  return withTenant(deps.appUserPool, accountId, userId, async (client) => {
    const { rows } = await client.query<FactsRow>(
      `SELECT rn.id AS runner_id, rn.protocol_version, rn.model_auth_present, f.host_mem_avail_mb, f.host_disk_free_mb, f.host_setups_running, f.host_load_at
         FROM runners rn LEFT JOIN runner_facts f ON f.account_id = rn.account_id AND f.runner_id = rn.id
        WHERE rn.account_id = $1 AND rn.revoked_at IS NULL ORDER BY rn.id`,
      [accountId],
    );
    const facts = new Map<string, MachineFacts>();
    for (const r of rows) {
      const loaded = r.host_mem_avail_mb !== null && r.host_disk_free_mb !== null && r.host_setups_running !== null && r.host_load_at !== null && (r.protocol_version ?? 0) >= MACHINE_ONBOARDING_MIN_PROTOCOL;
      facts.set(r.runner_id, {
        runner_id: r.runner_id,
        host_load: loaded ? { mem_avail_mb: r.host_mem_avail_mb!, disk_free_mb: r.host_disk_free_mb!, setups_running: r.host_setups_running!, seen_at: r.host_load_at!.toISOString() } : null,
        model_auth_present: r.model_auth_present,
      });
    }
    return facts;
  });
}
