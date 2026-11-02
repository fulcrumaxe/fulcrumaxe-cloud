import type { PoolClient } from "pg";
import { CONFLICT_ATTEST_JOB_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";

/**
 * D#519 MQ4-e2-c3 (C18-3): whether any runner of the account could ever take a conflict round's run for a repository. True when one is registered (not revoked; a deleted runner has no row),
 * lists the repository, and has said a protocol at or above the one a conflict round's job needs (`CONFLICT_ATTEST_JOB_MIN_PROTOCOL`). Liveness, a pause, a drain and a full slot are
 * deliberately NOT read: an offline or busy runner makes the round wait, only a runner that can never take it makes the round stop. Run on a client already inside the caller's tenant.
 */
export async function anyRunnerCanTakeConflictRound(client: PoolClient, accountId: string, repoId: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM runners WHERE account_id = $1 AND revoked_at IS NULL AND $2::uuid = ANY(allowed_repo_ids) AND COALESCE(protocol_version, 0) >= $3) AS ok",
    [accountId, repoId, CONFLICT_ATTEST_JOB_MIN_PROTOCOL],
  );
  return rows[0]?.ok === true;
}
