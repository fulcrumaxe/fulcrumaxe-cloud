import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type SessionPrincipal } from "./http.js";

/** What a repo's visibility read can say. Anything that is not a clear "private" is not enough to put a repo on a runner. */
export type RepoVisibilityAnswer = "private" | "public" | "unknown";

/** Why a repo may not be on a runner right now, or null when it may. The same two codes every runner gate refuses with. */
export type RunnerRepoBlock = "public_repo" | "repo_visibility_unknown";

/** The repo's visibility, read live through the app's port. A missing port or a failed read is "unknown", which refuses. */
export async function readRepoVisibility(deps: Pick<RunnerCloudDeps, "repoVisibility">, accountId: string, repoId: string): Promise<RepoVisibilityAnswer> {
  try {
    return (await deps.repoVisibility?.(accountId, repoId)) ?? "unknown";
  } catch {
    // fx-swallow-ok: a failed read is "unknown", which refuses (409 repo_visibility_unknown)
    return "unknown";
  }
}

export function blockFor(seen: RepoVisibilityAnswer): RunnerRepoBlock | null {
  if (seen === "private") return null;
  return seen === "public" ? "public_repo" : "repo_visibility_unknown";
}

/** The refusal for a repo that may not be on a runner. 409, like every other runner gate's refusal of the same two codes. */
export function blockError(block: RunnerRepoBlock): RunnerHttpError {
  return block === "public_repo"
    ? new RunnerHttpError(409, "public_repo", "a public repository cannot run on a runner")
    : new RunnerHttpError(409, "repo_visibility_unknown", "the repository's visibility could not be read");
}

/**
 * D#6 (runner public guard): a runner is never bound to a repository that is not private. Called before the definer that binds
 * (a registration code, a provisioning token, a runner's repo set), it reads each repo the request ADDS and refuses with 409
 * `public_repo` or `repo_visibility_unknown` before anything is written.
 *
 * Only an owner or admin can add repos, so for anyone else nothing is read here and the definer gives its own refusal (403). A repo id
 * that is not the account's is left to the definer too (its 400 `unknown_repo`). `currentOf` names the runner whose existing set is
 * subtracted first: narrowing a runner's repos never needs GitHub, and a repo already bound that turned public later is refused by
 * the job gates (issue and claim), not here.
 */
export async function refuseNonPrivateRepos(deps: RunnerCloudDeps, principal: SessionPrincipal, repoIds: readonly string[], currentOf?: string): Promise<void> {
  if (repoIds.length === 0) return;
  const toRead = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => reposToRead(client, repoIds, currentOf));
  await refuseUnlessPrivate(deps, principal.accountId, toRead);
}

/**
 * The same refusal on the caller's own tenant connection, so it can sit inside the transaction that binds (CWE-367: a check made in one
 * transaction and a write in another leaves a gap in which a concurrent remove + re-add skips the visibility read). The caller takes a
 * lock that serialises writers of the runner's repo set first, so the "already held" set read here is the committed, current one.
 */
export async function refuseNonPrivateReposIn(client: PoolClient, deps: RunnerCloudDeps, principal: SessionPrincipal, repoIds: readonly string[], currentOf?: string): Promise<void> {
  if (repoIds.length === 0) return;
  await refuseUnlessPrivate(deps, principal.accountId, await reposToRead(client, repoIds, currentOf));
}

async function refuseUnlessPrivate(deps: RunnerCloudDeps, accountId: string, repoIds: readonly string[]): Promise<void> {
  for (const repoId of repoIds) {
    const block = blockFor(await readRepoVisibility(deps, accountId, repoId));
    if (block !== null) throw blockError(block);
  }
}

async function reposToRead(client: PoolClient, repoIds: readonly string[], currentOf?: string): Promise<string[]> {
  const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
  if (role !== "owner" && role !== "admin") return [];
  let wanted = [...new Set(repoIds.map((id) => id.toLowerCase()))];
  if (currentOf !== undefined) {
    const runner = (await client.query<{ allowed_repo_ids: string[] }>("SELECT allowed_repo_ids FROM runners WHERE id = $1", [currentOf])).rows[0];
    // A runner this caller cannot see is the definer's refusal (404), not a reason to ask GitHub anything.
    if (!runner) return [];
    const held = new Set(runner.allowed_repo_ids.map((id) => id.toLowerCase()));
    wanted = wanted.filter((id) => !held.has(id));
  }
  if (wanted.length === 0) return [];
  const { rows } = await client.query<{ id: string }>("SELECT id FROM repos WHERE id = ANY ($1::uuid[]) ORDER BY id", [wanted]);
  return rows.map((r) => r.id);
}
