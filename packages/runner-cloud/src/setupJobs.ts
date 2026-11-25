import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { EMPTY_BASE_COMMIT, MAX_PLAN_BYTES, MACHINE_JOB_MAX_LIFE_S, PlanFile, canonicalJson, setupPlanPath, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, asRunner, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { blockError, blockFor, readRepoVisibility } from "./repoPrivacy.js";
import { RunPullRequestError } from "./runPullRequest.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

/**
 * D#845 ON-8b: the cloud issues a `project_setup` machine job, and serves the plan file the job points at.
 *
 * `issueProjectSetup` is for an owner or admin (the definer `machine_job_issue` checks that again). It reads, in the person's tenant transaction, the setup, the draft the setup approved, the machine the project is placed on and
 * the newest engine release that machine can run; asks GitHub (through the App's read-only port) for the default branch's head and the repo's visibility; builds the plan file and hashes its exact bytes; signs the job;
 * and then, in a second transaction that takes the setup's row lock and reads everything again, inserts the job and puts the setup in phase `install`. If anything the job was built from changed between the two, nothing is
 * written (409 `setup_changed`). The cloud facts the plan file carries are stored on the setup (`plan_setup`) so the plan route rebuilds the same bytes later.
 * A default branch with no commit yet is issued in direct mode (ON-8f): `base_sha` is `EMPTY_BASE_COMMIT` and the runner pushes one root commit to it. Any other default branch is a pull request job at its head.
 * Refusals (all 409 unless noted): `plan_not_approved`, `setup_not_placed`, `engine_release_unset`, `boss_login_missing`, `plan_invalid`, `public_repo`, `repo_visibility_unknown`, `setup_phase`;
 * 403 `forbidden`; 404 `not_found`; 503 `not_configured` and `github_unavailable`; 502 `github_refused`.
 */

/** The engine's own repository. A constant, never a column or an argument: the tarball URL is derived from it and the release's commit. */
export const ENGINE_SOURCE_REPO = "fulcrumaxe/fulcrumaxe";
export const engineTarballUrl = (commitSha: string): string => `https://codeload.github.com/${ENGINE_SOURCE_REPO}/tar.gz/${commitSha}`;
/** GitHub's login grammar, strictly: 1 to 39 letters, digits and single hyphens, none at either end. */
const LOGIN = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const VERSION_FORMAT = String.raw`^\d{1,6}\.\d{1,6}\.\d{1,6}$`;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

interface Draft { id: string; version: number; prd_md: string; roadmap: unknown }
interface Inputs {
  setup: { id: string; repoId: string; phase: string; state: string; kind: "existing" | "new"; retryable: boolean };
  repo: { ghRepoId: number; owner: string | null; name: string | null };
  runnerId: string;
  draft: Draft;
  login: string | null;
  release: { version: string; commit_sha: string; tarball_sha256: string };
}
type CloudFacts = { default_branch: string; visibility: "private" };

/**
 * Reads what a job is built from. Every query names the account itself on top of row security. Refuses with the codes above. `lock` (the second look) takes the setup's row lock in a statement of its own and only then
 * reads, so what is read sees whatever the lock's previous holder committed (a subquery in the locking statement would not: it keeps the snapshot the statement started with). With `retry`, the expiry rule of 1053 runs
 * first, inside a definer (the progress columns are not the caller's to read), so a job that is still reporting is never taken for a lapsed one.
 */
async function loadInputs(client: PoolClient, accountId: string, setupId: string, lock: boolean, retry = false): Promise<Inputs> {
  if (lock) {
    await client.query("SELECT 1 FROM project_setups WHERE account_id = $1 AND id = $2 FOR UPDATE", [accountId, setupId]);
    if (retry) await client.query("SELECT machine_job_lapse($1::uuid)", [setupId]);
  }
  const s = (
    await client.query<{ id: string; repo_id: string; phase: string; state: string; kind: "existing" | "new"; retryable: boolean }>(
      `SELECT s.id, s.repo_id, s.phase, s.state, s.kind,
              (s.phase = 'install' AND (s.state = 'failed' OR COALESCE((SELECT j.state IN ('expired', 'failed')
                  FROM machine_jobs j WHERE j.account_id = s.account_id AND j.setup_id = s.id ORDER BY j.attempt DESC LIMIT 1), false))) AS retryable
         FROM project_setups s WHERE s.account_id = $1 AND s.id = $2`,
      [accountId, setupId],
    )
  ).rows[0];
  if (!s) throw refuse(404, "not_found", "no such setup");
  if (s.phase !== "plan" && s.phase !== "install") throw refuse(409, "setup_phase", "the setup is not at the plan or install step");
  const draft = (await client.query<Draft & { approver: string | null }>(
    `SELECT d.id, d.version, d.prd_md, d.roadmap, (SELECT u.github_login FROM users u WHERE u.id = d.approved_by) AS approver
       FROM project_drafts d WHERE d.account_id = $1 AND d.repo_id = $2 AND d.setup_id = $3 AND d.status = 'approved' ORDER BY d.version DESC LIMIT 1`,
    [accountId, s.repo_id, s.id],
  )).rows[0];
  if (!draft) throw refuse(409, "plan_not_approved", "no approved plan for this setup");
  const placed = (await client.query<{ runner_id: string; protocol_version: number | null; gh_repo_id: string; gh_owner: string | null; gh_name: string | null }>(
    `SELECT pl.runner_id, rn.protocol_version, r.gh_repo_id, r.gh_owner, r.gh_name FROM project_placements pl
       JOIN runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
       JOIN repos r ON r.account_id = pl.account_id AND r.id = pl.repo_id
      WHERE pl.account_id = $1 AND pl.repo_id = $2`,
    [accountId, s.repo_id],
  )).rows[0];
  if (!placed) throw refuse(409, "setup_not_placed", "the project is not placed on a machine");
  const release = (await client.query<Inputs["release"]>(
    `SELECT version, commit_sha, tarball_sha256 FROM engine_releases
      WHERE withdrawn_at IS NULL AND min_runner_protocol <= $1 AND version ~ '${VERSION_FORMAT}' ORDER BY published_at DESC, id DESC LIMIT 1`,
    [placed.protocol_version ?? 0],
  )).rows[0];
  if (!release) throw refuse(409, "engine_release_unset", "no engine release is published for this machine");
  if (draft.approver === null || !LOGIN.test(draft.approver)) throw refuse(409, "boss_login_missing", "the approver has no usable GitHub login");
  return {
    setup: { id: s.id, repoId: s.repo_id, phase: s.phase, state: s.state, kind: s.kind, retryable: s.retryable },
    repo: { ghRepoId: Number(placed.gh_repo_id), owner: placed.gh_owner, name: placed.gh_name },
    runnerId: placed.runner_id,
    draft: { id: draft.id, version: draft.version, prd_md: draft.prd_md, roadmap: draft.roadmap },
    login: draft.approver,
    release,
  };
}

/** The plan file for a setup: the draft's kept rows and the cloud facts. Refuses `plan_invalid` for any file the schema, the size cap or the rows refuse. Pure. */
export function buildPlanFile(input: { kind: "existing" | "new"; owner: string | null; name: string | null; login: string | null; draft: Draft; facts: CloudFacts }): { plan: PlanFile; text: string; sha256: string } {
  const rows = Array.isArray(input.draft.roadmap) ? (input.draft.roadmap as Array<Record<string, unknown>>).filter((row) => row["keep"] === true) : [];
  const parsed = PlanFile.safeParse({
    v: 1, draft_id: input.draft.id, version: input.draft.version, prd_md: input.draft.prd_md,
    roadmap: rows.map((r) => ({ row_key: r["row_key"], title: r["title"], summary: r["summary"], size: r["size"], depends_on: r["depends_on"] })),
    setup: { kind: input.kind, repo_owner: input.owner, repo_name: input.name, default_branch: input.facts.default_branch, visibility: input.facts.visibility, boss_github_username: input.login },
  });
  if (!parsed.success || parsed.data.roadmap.length === 0 || (input.owner !== null && !LOGIN.test(input.owner))) throw refuse(409, "plan_invalid", "the approved plan cannot be sent");
  const text = canonicalJson(parsed.data);
  if (Buffer.byteLength(text, "utf8") > MAX_PLAN_BYTES) throw refuse(409, "plan_invalid", "the approved plan cannot be sent");
  return { plan: parsed.data, text, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

/** Maps a failed GitHub read to a status. The messages are fixed text: nothing of GitHub's answer reaches the caller. */
function githubFailure(error: unknown): never {
  if (error instanceof RunPullRequestError) throw error.retryable ? refuse(503, "github_unavailable", "GitHub could not be read now") : refuse(502, "github_refused", "GitHub refused the read");
  throw error;
}

/** A refusal by the definer (42501: not an owner or admin of an active account) is the person's 403, never a runner's 401. */
async function asPerson<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can start the install");
    throw error;
  }
}

export interface IssuedSetupJob { job_id: string; attempt: number }

/**
 * Issues the setup's `project_setup` job (attempt + 1; an older live job is superseded). `retry` is the retry route's: it also needs phase `install` and a failed or expired job, checked under the row lock,
 * so two clicks issue one job.
 */
export async function issueProjectSetup(deps: RunnerCloudDeps, principal: SessionPrincipal, setupId: string, options: { retry?: boolean; fromApprove?: boolean } = {}): Promise<IssuedSetupJob> {
  const signer = (await deps.engineCommandSigner?.()) ?? null;
  const github = deps.pullRequests ?? null;
  if (signer?.signMachineJob === undefined || github === null) throw refuse(503, "not_configured", "the cloud cannot issue a setup job now");
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => withTenant(deps.appUserPool, principal.accountId, principal.userId, fn);
  const first = await asPerson(() => tenant(async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can start the install");
    return loadInputs(client, principal.accountId, setupId, false);
  }));
  if (first.repo.owner === null || first.repo.name === null) throw refuse(409, "plan_invalid", "the repository has no name on record");
  const repo = { id: first.setup.repoId, owner: first.repo.owner, name: first.repo.name };
  const seen = await readRepoVisibility(deps, principal.accountId, first.setup.repoId);
  const block = blockFor(seen);
  if (block !== null) throw blockError(block);
  let facts: CloudFacts, head: string | null;
  try {
    const branch = await github.defaultBranch(repo);
    const state = await github.branchState({ repo, branch, base: branch });
    facts = { default_branch: branch, visibility: "private" };
    head = state.exists ? state.headOid : null;
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    return githubFailure(error);
  }
  const built = buildPlanFile({ kind: first.setup.kind, owner: first.repo.owner, name: first.repo.name, login: first.login, draft: first.draft, facts });
  const now = (deps.now ?? (() => new Date()))();
  const issued = new Date(now.getTime());
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const jobId = randomUUID();
  const signed = signer.signMachineJob({
    v: 1, job_id: jobId, runner_id: first.runnerId, repo_gh_id: first.repo.ghRepoId, setup_id: first.setup.id, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "project_setup",
    args: {
      mode: head === null ? "direct" : "pr", base_sha: head ?? EMPTY_BASE_COMMIT,
      engine: { version: first.release.version, commit_sha: first.release.commit_sha, tarball_url: engineTarballUrl(first.release.commit_sha), tarball_sha256: first.release.tarball_sha256 },
      plan_ref: { draft_id: first.draft.id, version: first.draft.version, sha256: built.sha256 },
      branch: `fx/engine-install-${first.release.version}`,
    },
  } as MachineJob);
  return asPerson(() => tenant(async (client) => {
    const again = await loadInputs(client, principal.accountId, setupId, true, options.retry === true);
    // Approve's caller only ever issues the first job: a second approve that raced the first finds the setup already at install.
    if (options.fromApprove === true && again.setup.phase !== "plan") throw refuse(409, "setup_phase", "the install was already issued");
    const same = buildPlanFile({ kind: again.setup.kind, owner: again.repo.owner, name: again.repo.name, login: again.login, draft: again.draft, facts });
    if (same.sha256 !== built.sha256 || again.runnerId !== first.runnerId || again.release.commit_sha !== first.release.commit_sha || again.release.tarball_sha256 !== first.release.tarball_sha256) throw refuse(409, "setup_changed", "the setup changed while the job was made; try again");
    if (options.retry === true && !again.setup.retryable) throw refuse(409, "not_retryable", "the install is not at a failed or expired step");
    const { rows } = await client.query<{ attempt: number }>("SELECT machine_job_issue($1, $2, $3, $4, 'project_setup', $5::jsonb, $6, $7) AS attempt", [jobId, first.runnerId, first.setup.repoId, first.setup.id, JSON.stringify(signed), issued, expires]);
    const attempt = rows[0]!.attempt;
    await client.query(
      `UPDATE project_setups SET phase = 'install', state = 'started', sub_step = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, install_head_sha = NULL, install_pr_claim_at = NULL, install_pr_claim_sha = NULL, engine_version = $3, attempt = $4, plan_setup = $5::jsonb, updated_at = now()
        WHERE account_id = $1 AND id = $2`,
      [principal.accountId, first.setup.id, first.release.version, attempt, JSON.stringify(built.plan.setup)],
    );
    return { job_id: jobId, attempt };
  }));
}

/** POST /api/v1/setups/:id/install/retry. An owner or admin, a session (the route takes no token): issues the next attempt of a failed or expired install. */
export async function retryInstall(deps: RunnerCloudDeps, principal: SessionPrincipal, setupId: string): Promise<RunnerHttpResponse> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupId)) throw refuse(404, "not_found", "no such setup");
  return { status: 200, body: await issueProjectSetup(deps, principal, setupId.toLowerCase(), { retry: true }), headers: { "cache-control": "no-store" } };
}

/**
 * GET /api/runner/setup/:setup_id/plan?version=N, signed. Answers only when the setup is placed on the calling machine, is in phase `install`, and N is the version of its approved draft; anything else, another
 * account's setup included, is the same 404. The body is `canonicalJson(PlanFile)` (the keys sorted, so the JSON the route sends is those bytes), at most 1 MiB, never cached.
 */
export async function setupPlanRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, search: string, setupId: string): Promise<RunnerHttpResponse> {
  if (req.method !== "GET") throw refuse(405, "method_not_allowed", "use GET");
  if (req.body.byteLength > 0) throw refuse(400, "invalid_message", "this request takes no body");
  const version = /^\?version=([1-9][0-9]{0,8})$/.exec(search)?.[1];
  if (version === undefined) throw refuse(400, "invalid_message", "the query is not ?version=N");
  const runner = await verifyRunnerRequest(deps, setupPlanPath(setupId, Number(version)), req, { replay: "once" });
  const notFound = () => refuse(404, "not_found", "no such plan");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupId)) throw notFound();
  const text = await asRunner(() => withRunnerSession(deps.appUserPool, runner, async (client) => {
    const row = (await client.query<{ kind: "existing" | "new"; plan_setup: Record<string, string>; id: string; version: number; prd_md: string; roadmap: unknown; login: string | null }>(
      `SELECT s.kind, s.plan_setup, d.id, d.version, d.prd_md, d.roadmap, NULL::text AS login
         FROM project_setups s
         JOIN project_placements pl ON pl.account_id = s.account_id AND pl.repo_id = s.repo_id AND pl.runner_id = $3
         JOIN project_drafts d ON d.account_id = s.account_id AND d.repo_id = s.repo_id AND d.setup_id = s.id AND d.status = 'approved' AND d.version = $4
        WHERE s.account_id = $1 AND s.id = $2 AND s.phase = 'install' AND s.plan_setup IS NOT NULL`,
      [runner.accountId, setupId.toLowerCase(), runner.runnerId, Number(version)],
    )).rows[0];
    if (!row) throw notFound();
    const parsed = PlanFile.safeParse({
      v: 1, draft_id: row.id, version: row.version, prd_md: row.prd_md,
      roadmap: (Array.isArray(row.roadmap) ? (row.roadmap as Array<Record<string, unknown>>) : []).filter((r) => r["keep"] === true).map((r) => ({ row_key: r["row_key"], title: r["title"], summary: r["summary"], size: r["size"], depends_on: r["depends_on"] })),
      setup: row.plan_setup,
    });
    if (!parsed.success) throw notFound();
    const out = canonicalJson(parsed.data);
    if (Buffer.byteLength(out, "utf8") > MAX_PLAN_BYTES) throw notFound();
    return out;
  }));
  return { status: 200, body: JSON.parse(text) as unknown, headers: { "cache-control": "no-store" } };
}
