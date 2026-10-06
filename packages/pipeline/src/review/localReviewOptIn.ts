import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { LocalReviewOptInPort } from "./mergeGateRun.js";

/**
 * D#6 R2b (C12 section 1, safeguard (a)): the real `LocalReviewOptInPort`, reading the stored per-repo opt-in
 * (`repo_local_review_optins`, migration 0733). It is on only while a row exists for the repo AND the repo is still on a
 * runner: the join to `repos` repeats the condition the table's own foreign key already enforces, so a row can never make
 * a sandbox repo count runner verdicts even if that constraint were ever loosened.
 *
 * Read under the account's own tenant context. The gate wraps every call in a catch that reads a failure as "off", and
 * this port adds no catch of its own: a read that fails throws, and the gate fails closed.
 */
export function createPgLocalReviewOptIn(pool: Pool): LocalReviewOptInPort {
  return {
    enabled: ({ accountId, repoId }) =>
      withTenant(pool, accountId, async (client) => {
        const { rows } = await client.query<{ on: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM repo_local_review_optins o
               JOIN repos r ON r.account_id = o.account_id AND r.id = o.repo_id AND r.execution_mode = 'runner_local'
              WHERE o.account_id = $1 AND o.repo_id = $2
           ) AS "on"`,
          [accountId, repoId],
        );
        return rows[0]?.on === true;
      }),
  };
}
