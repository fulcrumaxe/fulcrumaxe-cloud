import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, TWIN_SYNC_MAX_PATHS, isTwinSyncPath, twinSyncBranch, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { RunPullRequestError, type RunPullRequestPort } from "./runPullRequest.js";

/**
 * D#845 ON-27d2: the cloud's halves of a private twin's sync, the public repository's changes coming into the twin (the runner's half is fx-runner's `twinSync.ts`). The sync pull request through the App, the merge handling, the
 * conflict state and the reconcile tick that calls these come with ON-27d3 and ON-27d4; until then nothing does, and `TWIN_ENABLED` is off.
 *
 *   issueTwinSync   The tick's session (no person) or an owner or admin, given the paths the parity found pending (at most 200; the caller's, never the runner's). Reads the twin's default-branch tip and the public `main` tip through
 *                   the App (metadata only: two refs) and signs a `twin_sync` job: the twin's tip as its base, the public tip, the branch named from the public tip, the paths and the live private set. It writes it through
 *                   `twin_sync_issue` (migration 1111), which re-checks every fact against the rows. The job carries no token and no text: the runner reads the public repository anonymously and asks for the twin's one credential at the token route.
 *   checkTwinSync   The cloud's check of what the runner says it pushed. Once a sync job is `done` it reads the twin's branch through the App (its head, and that the head has exactly one parent, the signed base) and hands the answer
 *                   to `twin_sync_check`, which marks the head verified or refuses the twin. A GitHub that cannot be asked leaves the twin where it is.
 */
const SHA40 = /^[0-9a-f]{40}$/;
const MAX_SET_BYTES = 200 * 1024;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

interface TwinFacts {
  state: string;
  synced: string | null;
  syncPr: number | null;
  public: { id: string; ghId: number; owner: string | null; name: string | null };
  private: { id: string; ghId: number; owner: string | null; name: string | null };
  runnerId: string | null;
  setupId: string | null;
  set: { overlay_globs: string[]; install_paths: string[]; blob_globs: string[]; identifier_rules_path: string | null; plan_data_rules_path: string | null };
}

async function readFacts(client: PoolClient, accountId: string, twinId: string): Promise<TwinFacts | null> {
  const t = (
    await client.query<{ public_repo_id: string; private_repo_id: string | null; state: string; synced_public_sha: string | null; sync_pr: number | null; binary_globs: string[] } & Omit<TwinFacts["set"], "blob_globs">>(
      `SELECT public_repo_id, private_repo_id, state, synced_public_sha, sync_pr, overlay_globs, install_paths, binary_globs, identifier_rules_path, plan_data_rules_path
         FROM repo_twins WHERE account_id = $1 AND id = $2 AND state <> 'removed'`,
      [accountId, twinId],
    )
  ).rows[0];
  if (!t || t.private_repo_id === null) return null;
  const repo = async (id: string) => {
    const r = (await client.query<{ gh_repo_id: string; gh_owner: string | null; gh_name: string | null }>("SELECT gh_repo_id, gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2", [accountId, id])).rows[0];
    return r ? { id, ghId: Number(r.gh_repo_id), owner: r.gh_owner, name: r.gh_name } : null;
  };
  const [pub, prv] = [await repo(t.public_repo_id), await repo(t.private_repo_id)];
  if (!pub || !prv) return null;
  const placed = (await client.query<{ runner_id: string }>("SELECT pl.runner_id FROM project_placements pl JOIN runners r ON r.account_id = pl.account_id AND r.id = pl.runner_id AND r.revoked_at IS NULL WHERE pl.account_id = $1 AND pl.repo_id = $2", [accountId, t.private_repo_id])).rows[0];
  const setup = (await client.query<{ id: string }>("SELECT id FROM project_setups WHERE account_id = $1 AND repo_id = $2 ORDER BY created_at DESC, id LIMIT 1", [accountId, t.private_repo_id])).rows[0];
  return {
    state: t.state, synced: t.synced_public_sha, syncPr: t.sync_pr, public: pub, private: prv, runnerId: placed?.runner_id ?? null, setupId: setup?.id ?? null,
    set: { overlay_globs: t.overlay_globs, install_paths: t.install_paths, blob_globs: t.binary_globs, identifier_rules_path: t.identifier_rules_path, plan_data_rules_path: t.plan_data_rules_path },
  };
}

/** The tip of a branch of a repository, or null when it has none. */
async function tipOf(port: RunPullRequestPort, repo: { id: string; owner: string; name: string }, branch: string): Promise<string | null> {
  const state = await port.branchState({ repo, branch, base: branch });
  return state.exists && state.headOid !== null && SHA40.test(state.headOid) ? state.headOid : null;
}

export type IssuedTwinSync = { outcome: "issued"; job_id: string; attempt: number } | { outcome: "in_sync" };

/** `userId` is null for the tick's own session (no person); a person must be an owner or admin (the definer re-checks). `paths` are the ones the parity found pending, at most 200, each a plain repository path. */
export async function issueTwinSync(deps: RunnerCloudDeps, principal: { accountId: string; userId: string | null }, twinId: string, paths: readonly string[]): Promise<IssuedTwinSync> {
  if (paths.length < 1 || paths.length > TWIN_SYNC_MAX_PATHS || new Set(paths).size !== paths.length || !paths.every(isTwinSyncPath)) throw refuse(400, "bad_paths", "the paths to bring in are not a list of 1 to 200 distinct repository paths");
  const signer = (await deps.engineCommandSigner?.()) ?? null;
  const port = deps.pullRequests ?? null;
  if (signer?.signMachineJob === undefined || port === null) throw refuse(503, "not_configured", "the cloud cannot issue a twin sync now");
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const facts = await tenant(async (client) => {
    if (principal.userId !== null) {
      const role = await requireMemberRole(client);
      if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can start a sync");
    }
    return readFacts(client, principal.accountId, id);
  });
  if (facts === null) throw refuse(404, "not_found", "no such private twin");
  if (facts.state !== "ready") throw refuse(409, "twin_state", "the private twin is not ready to sync");
  if (facts.syncPr !== null) throw refuse(409, "sync_open", "a sync pull request is open; merge or close it first");
  if (facts.public.owner === null || facts.public.name === null || facts.private.owner === null || facts.private.name === null) throw refuse(409, "repo_unnamed", "a repository has no name on record");
  if (facts.setupId === null) throw refuse(409, "setup_not_found", "the private twin has no setup");
  if (facts.runnerId === null) throw refuse(409, "setup_not_placed", "the private twin is not placed on a machine");
  const pub = { id: facts.public.id, owner: facts.public.owner, name: facts.public.name };
  const prv = { id: facts.private.id, owner: facts.private.owner, name: facts.private.name };
  let base: string | null;
  let tip: string | null;
  let publicBranch: string;
  try {
    base = await tipOf(port, prv, await port.defaultBranch(prv));
    publicBranch = await port.defaultBranch(pub);
    tip = publicBranch === "main" ? await tipOf(port, pub, "main") : null;
  } catch (error) {
    if (error instanceof RunPullRequestError) throw refuse(503, "github_unavailable", "GitHub could not be asked");
    throw error;
  }
  // The sync reads the public repo's main, as the publish writes to it: any other default would never be in step with what the twin publishes.
  if (publicBranch !== "main") throw refuse(409, "public_default_branch_not_main", "only a public repository whose default branch is main can be synced");
  if (base === null) throw refuse(409, "default_branch_empty", "the private repository has no commit on its default branch");
  if (tip === null) throw refuse(409, "default_branch_empty", "the public repository has no commit on main");
  if (tip === facts.synced) return { outcome: "in_sync" };
  if (Buffer.byteLength(JSON.stringify(facts.set), "utf8") > MAX_SET_BYTES) throw refuse(409, "private_set_too_large", "the private paths are too many to sync");
  const jobId = randomUUID();
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const signed = signer.signMachineJob({
    v: 1, job_id: jobId, runner_id: facts.runnerId, repo_gh_id: facts.private.ghId, setup_id: facts.setupId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "twin_sync",
    args: {
      twin_id: id,
      public: { owner: pub.owner, name: pub.name, gh_id: facts.public.ghId, tip },
      private: { owner: prv.owner, name: prv.name, gh_id: facts.private.ghId, base },
      branch: twinSyncBranch(tip),
      paths: [...paths],
      private_set: facts.set,
    },
  } as MachineJob);
  let row: { o_result: string; o_attempt: number | null };
  try {
    row = await tenant(async (client) => (await client.query<{ o_result: string; o_attempt: number | null }>("SELECT o_result, o_attempt FROM twin_sync_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [id, jobId, JSON.stringify(signed), issued, expires])).rows[0]!);
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can start a sync");
    throw error;
  }
  if (row.o_result === "in_sync") return { outcome: "in_sync" };
  const refusals: Record<string, [number, string, string]> = {
    not_found: [404, "not_found", "no such private twin"],
    bad_state: [409, "twin_state", "the private twin is not ready to sync"],
    sync_open: [409, "sync_open", "a sync pull request is open; merge or close it first"],
    repo_unnamed: [409, "repo_unnamed", "a repository has no name on record"],
    no_setup: [409, "setup_not_found", "the private twin has no setup"],
    not_placed: [409, "setup_not_placed", "the private twin is not placed on a machine"],
    job_live: [409, "sync_live", "a job of this twin is already under way, or a sync is waiting to be checked"],
  };
  if (row.o_result !== "ok" || row.o_attempt === null) {
    const [status, code, message] = refusals[row.o_result] ?? [409, "twin_state", "the private twin cannot be synced now"];
    throw refuse(status, code, message);
  }
  return { outcome: "issued", job_id: jobId, attempt: row.o_attempt };
}

export type TwinSyncCheck = "verified" | "refused" | "not_ready" | "not_found" | "github_unavailable";

/** `userId` is null for the tick's own session (no person); a person must be an owner or admin (the definer re-checks). */
export async function checkTwinSync(deps: Pick<RunnerCloudDeps, "appUserPool" | "setupInstall">, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinSyncCheck> {
  const port = deps.setupInstall ?? null;
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const target = await tenant(async (client) => (await client.query<{ o_repo_id: string; o_owner: string; o_name: string; o_branch: string; o_head: string; o_base: string }>("SELECT o_repo_id, o_owner, o_name, o_branch, o_head, o_base FROM twin_sync_to_verify($1::uuid)", [id])).rows[0] ?? null);
  if (target === null) return "not_ready";
  if (port === null) return "github_unavailable";
  const repo = { id: target.o_repo_id, owner: target.o_owner, name: target.o_name };
  let ok = false;
  try {
    // The branch is the signed one and its head the commit the runner reported; the commit has exactly one parent, the twin tip the job was issued against.
    if ((await tipOf(port, repo, target.o_branch)) === target.o_head) {
      const parents = await port.commitParents({ repo, sha: target.o_head });
      ok = parents !== null && parents.length === 1 && parents[0] === target.o_base;
    }
  } catch (error) {
    if (error instanceof RunPullRequestError) return "github_unavailable";
    throw error;
  }
  return tenant(async (client) => (await client.query<{ o_result: TwinSyncCheck }>("SELECT o_result FROM twin_sync_check($1::uuid, $2::boolean)", [id, ok])).rows[0]!.o_result);
}
