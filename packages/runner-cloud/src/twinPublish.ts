import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type PlanePushHostedPort } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { RunPullRequestError, type RunPullRequestPort } from "./runPullRequest.js";

/**
 * D#845 ON-27c2: the cloud's halves of a private twin's publish (the runner's half is fx-runner's `twinPublish.ts`). The reconcile tick and the card that call them come with ON-27d and ON-27e; until then nothing does, and
 * `TWIN_ENABLED` is off.
 *
 *   issueTwinPublish   The tick's session (no person) or an owner or admin. Reads the private default branch's tip and the public `main` tip through the App (metadata only: two refs), and when the private tip is not the last
 *                      published commit signs a `twin_publish` job: private base and head, the public tip, the branch named from the head, and the private set. It writes it through `twin_publish_issue` (migration 1110),
 *                      which re-checks every fact against the rows. The job carries no token and no text: the runner builds the pull request text from a fixed template and asks for its one credential at the token route.
 *   checkTwinPublish   The cloud's check of what the runner says it pushed. Once a publish job is `done` it reads GitHub itself (the branch's head, its one parent, that parent in public main's history, the one open pull request for exactly
 *                      that head) through D#598's hosted reads and records `publish_pr`; anything it cannot confirm refuses the twin. A GitHub that cannot be asked leaves the twin where it is.
 */
const SHA40 = /^[0-9a-f]{40}$/;
/** The most the signed private set may take (the table's own CHECK allows 256 KiB for the whole job). */
const MAX_SET_BYTES = 200 * 1024;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

interface TwinFacts {
  state: string;
  base: string | null;
  publishPr: number | null;
  public: { id: string; ghId: number; owner: string | null; name: string | null };
  private: { id: string; ghId: number; owner: string | null; name: string | null };
  runnerId: string | null;
  setupId: string | null;
  set: { overlay_globs: string[]; install_paths: string[]; blob_globs: string[]; identifier_rules_path: string | null; plan_data_rules_path: string | null };
}

async function readFacts(client: PoolClient, accountId: string, twinId: string): Promise<TwinFacts | null> {
  const t = (
    await client.query<{ public_repo_id: string; private_repo_id: string | null; state: string; published_private_sha: string | null; publish_pr: number | null; binary_globs: string[] } & Omit<TwinFacts["set"], "blob_globs">>(
      `SELECT public_repo_id, private_repo_id, state, published_private_sha, publish_pr, overlay_globs, install_paths, binary_globs, identifier_rules_path, plan_data_rules_path
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
    state: t.state, base: t.published_private_sha, publishPr: t.publish_pr, public: pub, private: prv, runnerId: placed?.runner_id ?? null, setupId: setup?.id ?? null,
    set: { overlay_globs: t.overlay_globs, install_paths: t.install_paths, blob_globs: t.binary_globs, identifier_rules_path: t.identifier_rules_path, plan_data_rules_path: t.plan_data_rules_path },
  };
}

/** The tip of a branch of a repository, or null when it has none. */
async function tipOf(port: RunPullRequestPort, repo: { id: string; owner: string; name: string }, branch: string): Promise<string | null> {
  const state = await port.branchState({ repo, branch, base: branch });
  return state.exists && state.headOid !== null && SHA40.test(state.headOid) ? state.headOid : null;
}

export type IssuedTwinPublish = { outcome: "issued"; job_id: string; attempt: number } | { outcome: "in_sync" };

/** `userId` is null for the tick's own session (no person); a person must be an owner or admin (the definer re-checks). */
export async function issueTwinPublish(deps: RunnerCloudDeps, principal: { accountId: string; userId: string | null }, twinId: string): Promise<IssuedTwinPublish> {
  const signer = (await deps.engineCommandSigner?.()) ?? null;
  const port = deps.pullRequests ?? null;
  if (signer?.signMachineJob === undefined || port === null) throw refuse(503, "not_configured", "the cloud cannot issue a twin publish now");
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const facts = await tenant(async (client) => {
    if (principal.userId !== null) {
      const role = await requireMemberRole(client);
      if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can start a publish");
    }
    return readFacts(client, principal.accountId, id);
  });
  if (facts === null) throw refuse(404, "not_found", "no such private twin");
  if (facts.state !== "ready" || facts.base === null) throw refuse(409, "twin_state", "the private twin is not ready to publish");
  if (facts.publishPr !== null) throw refuse(409, "publish_open", "a publish pull request is open; merge or close it first");
  if (facts.public.owner === null || facts.public.name === null || facts.private.owner === null || facts.private.name === null) throw refuse(409, "repo_unnamed", "a repository has no name on record");
  if (facts.setupId === null) throw refuse(409, "setup_not_found", "the private twin has no setup");
  if (facts.runnerId === null) throw refuse(409, "setup_not_placed", "the private twin is not placed on a machine");
  const pub = { id: facts.public.id, owner: facts.public.owner, name: facts.public.name };
  const prv = { id: facts.private.id, owner: facts.private.owner, name: facts.private.name };
  let head: string | null;
  let tip: string | null;
  let publicBranch: string;
  try {
    head = await tipOf(port, prv, await port.defaultBranch(prv));
    publicBranch = await port.defaultBranch(pub);
    tip = publicBranch === "main" ? await tipOf(port, pub, "main") : null;
  } catch (error) {
    if (error instanceof RunPullRequestError) throw refuse(503, "github_unavailable", "GitHub could not be asked");
    throw error;
  }
  // The publish branch is built on, and its pull request opened into, the public repo's main; the merge watch only handles a PR into the default branch. Any other default would strand the twin, so refuse before anything is issued.
  if (publicBranch !== "main") throw refuse(409, "public_default_branch_not_main", "only a public repository whose default branch is main can be published to");
  if (head === null) throw refuse(409, "default_branch_empty", "the private repository has no commit on its default branch");
  if (head === facts.base) return { outcome: "in_sync" };
  if (tip === null) throw refuse(409, "default_branch_empty", "the public repository has no commit on main");
  if (Buffer.byteLength(JSON.stringify(facts.set), "utf8") > MAX_SET_BYTES) throw refuse(409, "private_set_too_large", "the private paths are too many to publish");
  const jobId = randomUUID();
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const signed = signer.signMachineJob({
    v: 1, job_id: jobId, runner_id: facts.runnerId, repo_gh_id: facts.private.ghId, setup_id: facts.setupId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "twin_publish",
    args: {
      twin_id: id,
      public: { owner: pub.owner, name: pub.name, gh_id: facts.public.ghId, tip },
      private: { owner: prv.owner, name: prv.name, gh_id: facts.private.ghId, base: facts.base, head },
      branch: `fx/publish-${head.slice(0, 12)}`,
      private_set: facts.set,
    },
  } as MachineJob);
  let row: { o_result: string; o_attempt: number | null };
  try {
    row = await tenant(async (client) => (await client.query<{ o_result: string; o_attempt: number | null }>("SELECT o_result, o_attempt FROM twin_publish_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [id, jobId, JSON.stringify(signed), issued, expires])).rows[0]!);
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can start a publish");
    throw error;
  }
  const refusals: Record<string, [number, string, string]> = {
    not_found: [404, "not_found", "no such private twin"],
    bad_state: [409, "twin_state", "the private twin is not ready to publish"],
    publish_open: [409, "publish_open", "a publish pull request is open; merge or close it first"],
    repo_unnamed: [409, "repo_unnamed", "a repository has no name on record"],
    no_setup: [409, "setup_not_found", "the private twin has no setup"],
    not_placed: [409, "setup_not_placed", "the private twin is not placed on a machine"],
    job_live: [409, "publish_live", "a publish of this twin is already under way or waiting to be checked"],
  };
  if (row.o_result !== "ok" || row.o_attempt === null) {
    const [status, code, message] = refusals[row.o_result] ?? [409, "twin_state", "the private twin cannot be published now"];
    throw refuse(status, code, message);
  }
  return { outcome: "issued", job_id: jobId, attempt: row.o_attempt };
}

export type TwinPublishCheck = "recorded" | "refused" | "not_ready" | "not_found" | "github_unavailable";

/** A failure of the hosted GitHub reads that means "could not be asked" (they throw an object with one of these codes). Anything else is a bug and is thrown on. */
const unavailable = (error: unknown): boolean => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "public_unavailable" || code === "app_not_installed" || code === "code_repo_installation_not_owned" || code === "token_scope_mismatch" || code === "not_configured";
};

/** `userId` is null for the tick's own session (no person); a person must be an owner or admin (the definer re-checks). */
export async function checkTwinPublish(deps: Pick<RunnerCloudDeps, "appUserPool" | "planePush">, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinPublishCheck> {
  const port: PlanePushHostedPort | null = deps.planePush ?? null;
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const target = await tenant(async (client) => (await client.query<{ o_owner: string; o_name: string; o_branch: string; o_head: string; o_tip: string }>("SELECT o_owner, o_name, o_branch, o_head, o_tip FROM twin_publish_to_verify($1::uuid)", [id])).rows[0] ?? null);
  if (target === null) return "not_ready";
  if (port === null || port.findOpenPullRequest === undefined) return "github_unavailable";
  const input = { accountId: principal.accountId, codeRepo: `${target.o_owner}/${target.o_name}`, branch: target.o_branch, headSha: target.o_head };
  let pr: { number: number } | null = null;
  try {
    if (await port.verifyPushed({ ...input, tipSha: target.o_tip })) pr = await port.findOpenPullRequest(input);
  } catch (error) {
    if (unavailable(error)) return "github_unavailable";
    throw error;
  }
  return tenant(async (client) => (await client.query<{ o_result: TwinPublishCheck }>("SELECT o_result FROM twin_publish_check($1::uuid, $2)", [id, pr?.number ?? null])).rows[0]!.o_result);
}

/** The one comment a closed publish pull request gets. Fixed text: no name, number or title of the private side. */
export const TWIN_PUBLISH_CLOSE_COMMENT = "Closed: publishing from the private working copy was stopped, so this pull request will not be updated. Nothing else was published.";
export type TwinPublishClose = "closed" | "none" | "not_open" | "github_unavailable";

/**
 * Closes the publish pull request a twin still has open (Remove everything, Stop publishing). The twin is read after its removal: the pull request, its branch and the public repository are the twin's own rows'.
 * The close is a fixed comment and a close through D#598's hosted port, which checks the branch is ours (`not_ours` is "none"). A GitHub that cannot be asked leaves the pull request open; the removed twin ignores its merge.
 */
export async function closeTwinPublishPr(deps: Pick<RunnerCloudDeps, "appUserPool" | "planePush">, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinPublishClose> {
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const open = await tenant(async (client) => (await client.query<{ o_owner: string; o_name: string; o_branch: string; o_pr: number }>("SELECT o_owner, o_name, o_branch, o_pr FROM twin_publish_open_pr($1::uuid)", [twinId.toLowerCase()])).rows[0] ?? null);
  if (open === null) return "none";
  const port: PlanePushHostedPort | null = deps.planePush ?? null;
  if (port === null || port.closeRefusedPullRequest === undefined) return "github_unavailable";
  try {
    const done = await port.closeRefusedPullRequest({ accountId: principal.accountId, codeRepo: `${open.o_owner}/${open.o_name}`, number: open.o_pr, branch: open.o_branch, comment: TWIN_PUBLISH_CLOSE_COMMENT });
    return done.result === "closed" ? "closed" : done.result === "not_open" ? "not_open" : "none";
  } catch (error) {
    if (unavailable(error)) return "github_unavailable";
    throw error;
  }
}
