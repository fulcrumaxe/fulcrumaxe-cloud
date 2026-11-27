import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps } from "./http.js";
import { readRepoVisibility } from "./repoPrivacy.js";

/**
 * D#845 ON-27d4a (FU-311): a twin is only a twin while its private repository is private. Before a seed, a publish or a sync is issued, and before one is finished (its check, the sync pull request), the cloud reads the visibility of both
 * repositories live, through the same port the runner gates use, and records it (`twin_visibility_record`, migration 1116):
 *
 *   the private repository is public    the twin is refused with closed code `twin_not_private`, and nothing is issued or finished for it.
 *   the private repository is unknown   a read that failed or timed out. Nothing is written and nothing is issued: it fails closed, and the next tick asks again.
 *   the public repository is private    not a refusal. The twin keeps working and `repo_twins.note` carries `public_repo_private` (cleared when it is public again); an unread public side leaves the note as it is.
 *
 * Only a seeding, ready or conflicting twin is read; for any other state the guard says `ok` and the caller's own state check answers. No network call runs inside a transaction.
 */
export type TwinVisibilityGuard = "ok" | "refused" | "unavailable";

type Deps = Pick<RunnerCloudDeps, "appUserPool" | "repoVisibility" | "repoVisibilityTimeoutMs">;
const LIVE = ["seeding", "ready", "conflict"];

export async function guardTwinVisibility(deps: Deps, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinVisibilityGuard> {
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const repos = await tenant(async (client) => (await client.query<{ public_repo_id: string; private_repo_id: string }>("SELECT public_repo_id, private_repo_id FROM repo_twins WHERE account_id = $1 AND id = $2 AND state = ANY($3::text[]) AND private_repo_id IS NOT NULL", [principal.accountId, id, LIVE])).rows[0] ?? null);
  if (repos === null) return "ok";
  const [priv, pub] = await Promise.all([readRepoVisibility(deps, principal.accountId, repos.private_repo_id), readRepoVisibility(deps, principal.accountId, repos.public_repo_id)]);
  if (priv === "unknown") return "unavailable";
  const result = await tenant(async (client) => (await client.query<{ o_result: string }>("SELECT o_result FROM twin_visibility_record($1::uuid, $2, $3)", [id, priv, pub === "unknown" ? null : pub])).rows[0]?.o_result);
  return result === "refused" ? "refused" : "ok";
}

/** What an issue path throws for a guard that did not say `ok`. */
export function twinVisibilityError(guard: Exclude<TwinVisibilityGuard, "ok">): RunnerHttpError {
  return guard === "refused"
    ? new RunnerHttpError(409, "twin_not_private", "the private repository is no longer private")
    : new RunnerHttpError(409, "repo_visibility_unknown", "the repository's visibility could not be read");
}
