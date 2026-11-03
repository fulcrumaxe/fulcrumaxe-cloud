import type { PoolClient } from "pg";
import { ORDERED_FACTS_CAPABILITY } from "@fulcrumaxe/runner-protocol";

/**
 * D#483 S5-j2c1 (R-C34-F1): whether a runner of the account that covers the repository has a latest hello listing `ordered_facts_v1`. The capability, not a release, is the signal, so a runner built from
 * source counts. The order phase uses it to let an item through to the go; the repository's build limit follows it.
 *
 * Its own small module, so the build-slot code can use it without importing the merge gate (which reaches the build step, which imports the slot code). Re-exported by `mergeOrderCheck.ts`.
 *
 * `usableOnly` (the build limit sets it; the merge gate does not, because the go phase re-checks): leave out a runner a person paused or set to drain. A repository whose only capable runner is
 * paused would otherwise lift its limit with nothing to merge what it builds.
 */
export async function repoRunnerCanAttestOrder(client: Pick<PoolClient, "query">, accountId: string, repoId: string, usableOnly = false): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM runners rn JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id
       LEFT JOIN runner_settings s ON s.account_id = rn.account_id AND s.runner_id = rn.id
      WHERE rn.account_id = $1 AND rn.revoked_at IS NULL AND $2::uuid = ANY(rn.allowed_repo_ids) AND $3::text = ANY(cap.capabilities)
        AND ($4::boolean IS NOT TRUE OR (s.paused_at IS NULL AND s.draining IS NOT TRUE)) LIMIT 1`,
    [accountId, repoId, ORDERED_FACTS_CAPABILITY, usableOnly],
  );
  return rows.length > 0;
}
