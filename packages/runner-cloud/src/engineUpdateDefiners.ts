import type { PoolClient } from "pg";

/**
 * Which definers a runner's report on a setup's job goes through: an `engine_update` job has its own (the update, never the installed setup, takes its steps and its pushed commit), so has a `twin_seed` job (the twin, never
 * its setup, takes its failure; migration 1108) and a `twin_publish` job (migration 1110; its grant answers the PUBLIC repository, see `publicTarget`) and a `twin_sync` job (migration 1111; its grant answers the twin); every other kind keeps 1053's and 1071's.
 * The statements are the two fixed sets below, never the caller's text. The kind is read in the runner's own session, for this runner's job of this setup only.
 */
const DEFINERS = {
  engine_update: { grant: "SELECT o_result, o_repo_id FROM engine_update_push_grant($1::uuid, $2::uuid)", head: "SELECT engine_update_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM engine_update_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" , publicTarget: false },
  twin_seed: { grant: "SELECT o_result, o_repo_id FROM twin_seed_push_grant($1::uuid, $2::uuid)", head: "SELECT twin_seed_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM twin_seed_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" , publicTarget: false },
  twin_publish: { grant: "SELECT o_result, o_repo_id FROM twin_publish_push_grant($1::uuid, $2::uuid)", head: "SELECT twin_publish_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM twin_publish_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" , publicTarget: true },
  twin_sync: { grant: "SELECT o_result, o_repo_id FROM twin_sync_push_grant($1::uuid, $2::uuid)", head: "SELECT twin_sync_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM twin_sync_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" , publicTarget: false },
  other: { grant: "SELECT o_result, o_repo_id FROM setup_push_grant($1::uuid, $2::uuid)", head: "SELECT setup_head_record($1::uuid, $2::uuid, $3) AS ok", progress: "SELECT o_result, o_repo_id FROM setup_progress_record($1::uuid, $2::uuid, $3, $4, $5, $6, $7)" , publicTarget: false },
} as const;
export async function definersForJob(client: PoolClient, accountId: string, setupId: string, jobId: string): Promise<(typeof DEFINERS)[keyof typeof DEFINERS]> {
  const kind = (await client.query<{ kind: string }>("SELECT kind FROM machine_jobs WHERE account_id = $1 AND setup_id = $2 AND id = $3", [accountId, setupId, jobId])).rows[0]?.kind;
  return kind === "engine_update" ? DEFINERS.engine_update : kind === "twin_seed" ? DEFINERS.twin_seed : kind === "twin_publish" ? DEFINERS.twin_publish : kind === "twin_sync" ? DEFINERS.twin_sync : DEFINERS.other;
}
