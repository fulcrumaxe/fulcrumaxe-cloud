import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { RunPullRequestError, type RunPullRequestPort } from "./runPullRequest.js";

/**
 * D#845 ON-27b: the cloud's two halves of a private twin's seed (the runner's half is fx-runner's `twinSeed.ts`). The route, the card and the reconcile tick that call them come with ON-27d and ON-27e; until then nothing does,
 * and `TWIN_ENABLED` is off.
 *
 *   issueTwinSeed   An owner or admin on a session. Reads the public repository's default branch and its tip through the App, signs a `twin_seed` job bound to the twin's private repository and setup, and writes it through
 *                   `twin_seed_issue` (migration 1108), which re-checks every fact against the rows: the twin's own repository is the one target, the machine is the twin's own, nothing else is live. A twin that stopped at
 *                   `failed` is issued again the same way (a new tip, a new job).
 *   checkTwinSeed   The cloud's check. Once a seed job is `done` it reads the twin's default-branch tip through the App and hands it to `twin_seed_check`, which makes the twin `ready` (both anchors at the signed head)
 *                   only when the tip equals that head, and fails it otherwise. A GitHub that cannot be asked leaves the twin where it is.
 * The job carries no token and no path: the runner reads the public repository anonymously and the push credential comes from the push-token route, once.
 */
const SHA40 = /^[0-9a-f]{40}$/;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

interface TwinFacts {
  publicRepoId: string;
  privateRepoId: string;
  state: string;
  public: { id: string; ghId: number; owner: string | null; name: string | null };
  private: { id: string; ghId: number; owner: string | null; name: string | null };
  runnerId: string | null;
  setupId: string | null;
}

async function readFacts(client: PoolClient, accountId: string, twinId: string): Promise<TwinFacts | null> {
  const t = (await client.query<{ public_repo_id: string; private_repo_id: string | null; state: string }>("SELECT public_repo_id, private_repo_id, state FROM repo_twins WHERE account_id = $1 AND id = $2 AND state <> 'removed'", [accountId, twinId])).rows[0];
  if (!t || t.private_repo_id === null) return null;
  const repo = async (id: string) => {
    const r = (await client.query<{ gh_repo_id: string; gh_owner: string | null; gh_name: string | null }>("SELECT gh_repo_id, gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2", [accountId, id])).rows[0];
    return r ? { id, ghId: Number(r.gh_repo_id), owner: r.gh_owner, name: r.gh_name } : null;
  };
  const [pub, prv] = [await repo(t.public_repo_id), await repo(t.private_repo_id)];
  if (!pub || !prv) return null;
  const placed = (await client.query<{ runner_id: string }>("SELECT pl.runner_id FROM project_placements pl JOIN runners r ON r.account_id = pl.account_id AND r.id = pl.runner_id AND r.revoked_at IS NULL WHERE pl.account_id = $1 AND pl.repo_id = $2", [accountId, t.private_repo_id])).rows[0];
  const setup = (await client.query<{ id: string }>("SELECT id FROM project_setups WHERE account_id = $1 AND repo_id = $2 AND phase = 'survey'", [accountId, t.private_repo_id])).rows[0];
  return { publicRepoId: t.public_repo_id, privateRepoId: t.private_repo_id, state: t.state, public: pub, private: prv, runnerId: placed?.runner_id ?? null, setupId: setup?.id ?? null };
}

/** The tip of a repository's default branch (and the branch's name), or why it could not be read. */
async function readTip(port: RunPullRequestPort, repo: { id: string; owner: string; name: string }): Promise<{ branch: string; tip: string | null }> {
  const branch = await port.defaultBranch(repo);
  const state = await port.branchState({ repo, branch, base: branch });
  return { branch, tip: state.exists && state.headOid !== null && SHA40.test(state.headOid) ? state.headOid : null };
}

export interface IssuedTwinSeed { job_id: string; attempt: number }

export async function issueTwinSeed(deps: RunnerCloudDeps, principal: SessionPrincipal, twinId: string): Promise<IssuedTwinSeed> {
  const signer = (await deps.engineCommandSigner?.()) ?? null;
  const port = deps.pullRequests ?? null;
  if (signer?.signMachineJob === undefined || port === null) throw refuse(503, "not_configured", "the cloud cannot issue a twin seed now");
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => withTenant(deps.appUserPool, principal.accountId, principal.userId, fn);
  const facts = await tenant(async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can start the copy");
    return readFacts(client, principal.accountId, twinId.toLowerCase());
  });
  if (facts === null) throw refuse(404, "not_found", "no such private twin");
  if (facts.public.owner === null || facts.public.name === null || facts.private.owner === null || facts.private.name === null) throw refuse(409, "repo_unnamed", "a repository has no name on record");
  if (facts.setupId === null) throw refuse(409, "setup_not_found", "the private twin has no setup waiting");
  if (facts.runnerId === null) throw refuse(409, "setup_not_placed", "the private twin is not placed on a machine");
  let seen: { branch: string; tip: string | null };
  try {
    seen = await readTip(port, { id: facts.public.id, owner: facts.public.owner, name: facts.public.name });
  } catch (error) {
    if (error instanceof RunPullRequestError) throw refuse(503, "github_unavailable", "GitHub could not be asked");
    throw error;
  }
  if (seen.tip === null) throw refuse(409, "default_branch_empty", "the public repository has no commit on its default branch");
  const jobId = randomUUID();
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const signed = signer.signMachineJob({
    v: 1, job_id: jobId, runner_id: facts.runnerId, repo_gh_id: facts.private.ghId, setup_id: facts.setupId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "twin_seed",
    args: {
      twin_id: twinId.toLowerCase(),
      public: { owner: facts.public.owner, name: facts.public.name, gh_id: facts.public.ghId, default_branch: seen.branch, head_sha: seen.tip },
      private: { owner: facts.private.owner, name: facts.private.name, gh_id: facts.private.ghId },
    },
  } as MachineJob);
  let row: { o_result: string; o_attempt: number | null };
  try {
    row = await tenant(async (client) => (await client.query<{ o_result: string; o_attempt: number | null }>("SELECT o_result, o_attempt FROM twin_seed_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [twinId.toLowerCase(), jobId, JSON.stringify(signed), issued, expires])).rows[0]!);
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can start the copy");
    throw error;
  }
  const refusals: Record<string, [number, string, string]> = {
    not_found: [404, "not_found", "no such private twin"],
    bad_state: [409, "twin_state", "the private twin is not waiting for its first copy"],
    repo_unnamed: [409, "repo_unnamed", "a repository has no name on record"],
    no_setup: [409, "setup_not_found", "the private twin has no setup waiting"],
    not_placed: [409, "setup_not_placed", "the private twin is not placed on a machine"],
    job_live: [409, "seed_live", "a copy of this twin is already under way"],
  };
  if (row.o_result !== "ok" || row.o_attempt === null) {
    const [status, code, message] = refusals[row.o_result] ?? [409, "twin_state", "the private twin cannot be copied now"];
    throw refuse(status, code, message);
  }
  return { job_id: jobId, attempt: row.o_attempt };
}

export type TwinSeedCheck = "ready" | "failed" | "not_ready" | "not_found" | "github_unavailable";

/** `userId` is null for the tick's own session (no person); a person must be an owner or admin (the definer re-checks). */
export async function checkTwinSeed(deps: Pick<RunnerCloudDeps, "appUserPool" | "pullRequests">, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinSeedCheck> {
  const port = deps.pullRequests ?? null;
  if (port === null) return "github_unavailable";
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const target = await tenant(async (client) => {
    // Only a twin that is seeding and whose newest seed job finished is looked at; GitHub is not asked for any other.
    const { rows } = await client.query<{ gh_owner: string | null; gh_name: string | null; repo_id: string }>(
      `SELECT r.gh_owner, r.gh_name, r.id AS repo_id FROM repo_twins t JOIN repos r ON r.account_id = t.account_id AND r.id = t.private_repo_id
        WHERE t.account_id = $1 AND t.id = $2 AND t.state = 'seeding'
          AND (SELECT j.state FROM machine_jobs j WHERE j.account_id = t.account_id AND j.kind = 'twin_seed' AND j.repo_id = t.private_repo_id ORDER BY j.attempt DESC LIMIT 1) = 'done'`,
      [principal.accountId, twinId.toLowerCase()],
    );
    return rows[0] ?? null;
  });
  if (target === null) return "not_ready";
  if (target.gh_owner === null || target.gh_name === null) return "not_ready";
  let tip: string | null;
  try {
    tip = (await readTip(port, { id: target.repo_id, owner: target.gh_owner, name: target.gh_name })).tip;
  } catch (error) {
    if (error instanceof RunPullRequestError) return "github_unavailable";
    throw error;
  }
  const result = await tenant(async (client) => (await client.query<{ o_result: TwinSeedCheck }>("SELECT o_result FROM twin_seed_check($1::uuid, $2)", [twinId.toLowerCase(), tip])).rows[0]!.o_result);
  return result;
}
