import type { PoolClient } from "pg";

/**
 * Which definers a runner's report on a setup's job goes through: an `engine_update` job has its own (the update, never the installed setup, takes its steps and its pushed commit), so has a `twin_seed` job (the twin, never
 * its setup, takes its failure; migration 1108); every other kind keeps 1053's and 1071's.
 * The statements are the two fixed sets below, never the caller's text. The kind is read in the runner's own session, for this runner's job of this setup only.
 */
const DEFINERS = {
  engine_update: { grant: "SELECT o_result, o_repo_id FROM engine_update_push_grant($1::uuid, $2::uuid)", head: "SELECT engine_update_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM engine_update_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" },
  twin_seed: { grant: "SELECT o_result, o_repo_id FROM twin_seed_push_grant($1::uuid, $2::uuid)", head: "SELECT twin_seed_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM twin_seed_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" },
  other: { grant: "SELECT o_result, o_repo_id FROM setup_push_grant($1::uuid, $2::uuid)", head: "SELECT setup_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM setup_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" },
} as const;
export async function definersForJob(client: PoolClient, accountId: string, setupId: string, jobId: string): Promise<(typeof DEFINERS)[keyof typeof DEFINERS]> {
  const kind = (await client.query<{ kind: string }>("SELECT kind FROM machine_jobs WHERE account_id = $1 AND setup_id = $2 AND id = $3", [accountId, setupId, jobId])).rows[0]?.kind;
  return kind === "engine_update" ? DEFINERS.engine_update : kind === "twin_seed" ? DEFINERS.twin_seed : DEFINERS.other;
}
