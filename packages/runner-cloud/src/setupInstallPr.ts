import type { Pool } from "pg";
import { EMPTY_BASE_COMMIT } from "@fulcrumaxe/runner-protocol";
import { LocalOnlyGithubError } from "./localOnlyGithub.js";
import { RunPullRequestError, type PullRequestRepo, type SetupInstallPort } from "./runPullRequest.js";

/**
 * D#845 ON-8f2a (Ruling 83): the cloud's step after the runner reported `push ok`. It is a level-triggered job (the reconcile job `setup_install_pr`), not part of any request: every pass takes the setups whose
 * push is recorded and that have no pull request yet (`setup_install_pr_claim`, migration 1072, one at a time, under a ten minute lease), and does for each:
 *
 *   pull request mode  holds the pushed commit to the job (the branch head on GitHub is `install_head_sha`, and that commit's one parent is the job's `base_sha`; otherwise nothing is opened and the setup fails
 *                      `install_head_changed`), opens the pull request DRAFT-first through the run port (the open one is reused on a rerun), reads its changed files and holds them to the path policy (a workflow
 *                      path or an odd one closes it: `pr_scope_refused`), only then marks it ready, and records the number: phase `await_merge`, the job done.
 *   direct mode        there is no branch and no pull request: it holds the default branch's head to `install_head_sha` and that commit to be a root commit (else `install_head_changed`) and records phase `finish`.
 *
 * D#845 ON-8f2b adds to both modes the engine's 11 labels (`ensureLabels`, A26, before the pull request exists or the setup finishes; a label that exists counts as made), and in pull request mode a second hold
 * on the pull request's own head (it must be the pushed commit; else it is closed and `install_head_changed`). A call the fence refuses is recorded as `pr_open_failed` instead of thrown. The watch (a merge or
 * a close of the pull request, including one that lands before its number is recorded) is the webhook's, through `setup_install_pr_closed` (migration 1073).
 *
 * A GitHub that cannot be asked (a 5xx, a rate limit, a timeout) leaves the lease to lapse and the next pass tries again; a refusal that no retry fixes fails the setup `pr_open_failed` and the person's Retry issues the
 * next attempt. Every write is a definer that re-reads the setup under its lock and does nothing unless it still says what the claim saw.
 */

/** What `setup_install_pr_claim` hands over: ids from our own rows, the commit the runner pushed and the job's own mode, base and branch. */
export interface SetupInstallClaim {
  accountId: string;
  setupId: string;
  repoId: string;
  userId: string;
  attempt: number;
  mode: "pr" | "direct";
  baseSha: string;
  branch: string;
  headSha: string;
  version: string | null;
  owner: string;
  name: string;
}

export type SetupInstallOutcome = "opened" | "finished" | "failed" | "retry" | "skipped";
export type SetupInstallFailure = "install_head_changed" | "pr_scope_refused" | "pr_open_failed";

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^fx\/engine-install-[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Takes the oldest due setup, or null when none is due. A row that is not of the shape a job can have is released to lapse (null here, and left leased), never acted on. */
export async function claimSetupInstall(pool: Pick<Pool, "query">): Promise<SetupInstallClaim | null | "malformed"> {
  const { rows } = await pool.query<{ o_account: string; o_setup: string; o_repo: string; o_user: string; o_attempt: number; o_mode: string | null; o_base: string | null; o_branch: string | null; o_head: string; o_version: string | null; o_owner: string | null; o_name: string | null }>(
    "SELECT o_account, o_setup, o_repo, o_user, o_attempt, o_mode, o_base, o_branch, o_head, o_version, o_owner, o_name FROM setup_install_pr_claim()",
  );
  const r = rows[0];
  if (r === undefined) return null;
  const mode = r.o_mode;
  if ((mode !== "pr" && mode !== "direct") || r.o_base === null || !SHA.test(r.o_base) || r.o_branch === null || !BRANCH.test(r.o_branch) || !SHA.test(r.o_head) || r.o_owner === null || r.o_name === null || !NAME.test(r.o_owner) || !NAME.test(r.o_name)) return "malformed";
  return { accountId: r.o_account, setupId: r.o_setup, repoId: r.o_repo, userId: r.o_user, attempt: r.o_attempt, mode, baseSha: r.o_base, branch: r.o_branch, headSha: r.o_head, version: r.o_version, owner: r.o_owner, name: r.o_name };
}

/** True when the path cannot be part of an install pull request: a workflow file (the same rule the runner holds the bundle to, on lower-cased segments), or a path with an empty, dot or `.git` segment, a backslash or a control character. */
export function installPathRefused(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || path.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(path)) return true;
  const parts = path.toLowerCase().split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p === ".git")) return true;
  return parts[0] === ".github" && (parts.length === 1 || parts[1] === "workflows");
}

/** The pull request's title and body: fixed words and the engine version (digits and dots from our own row), nothing a runner or a guest wrote. */
export function installPullRequestText(version: string | null): { title: string; body: string } {
  const v = version !== null && /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(version) ? ` (v${version})` : "";
  return {
    title: `Add the engine${v}`,
    body: "Adds the engine's files and setup to this project, as prepared on your machine. Review the files and merge to finish the install.",
  };
}

export interface SetupInstallDeps {
  /** The platform_ops pool: the claim and the two recording definers are its alone. */
  pool: Pick<Pool, "query">;
  port: SetupInstallPort;
  /** Called with a code for a failure the step swallowed on purpose (a stop, not an error). Optional. */
  onNote?: (note: string) => void;
}

/** The step for one claimed setup. Never throws for a GitHub failure: those are `retry` or a recorded failure. A database failure throws. */
export async function completeSetupInstall(deps: SetupInstallDeps, claim: SetupInstallClaim): Promise<SetupInstallOutcome> {
  const repo: PullRequestRepo = { id: claim.repoId, owner: claim.owner, name: claim.name };
  const fail = async (code: SetupInstallFailure): Promise<SetupInstallOutcome> => {
    const { rows } = await deps.pool.query<{ ok: boolean }>("SELECT setup_install_pr_fail($1::uuid, $2::int, $3, $4) AS ok", [claim.setupId, claim.attempt, claim.headSha, code]);
    return rows[0]?.ok === true ? "failed" : "skipped";
  };
  try {
    if (claim.mode === "direct") return await direct(deps, claim, repo, fail);
    return await pullRequest(deps, claim, repo, fail);
  } catch (error) {
    if (error instanceof RunPullRequestError) return error.retryable ? "retry" : fail("pr_open_failed");
    // D#845 ON-8f2b (FU-235): a call the fence refused is a bug in this step, not a GitHub failure, and no retry fixes it. It is recorded as a failure, so the setup does not sit leased and unseen.
    if (error instanceof LocalOnlyGithubError) return fail("pr_open_failed");
    throw error;
  }
}

async function direct(deps: SetupInstallDeps, claim: SetupInstallClaim, repo: PullRequestRepo, fail: (c: SetupInstallFailure) => Promise<SetupInstallOutcome>): Promise<SetupInstallOutcome> {
  // A direct job starts from the fixed empty commit, never a real one.
  if (claim.baseSha !== EMPTY_BASE_COMMIT) return fail("install_head_changed");
  const base = await deps.port.defaultBranch(repo);
  const state = await deps.port.branchState({ repo, branch: base, base });
  if (!state.exists || state.headOid !== claim.headSha) return fail("install_head_changed");
  const parents = await deps.port.commitParents({ repo, sha: claim.headSha });
  if (parents === null || parents.length !== 0) return fail("install_head_changed");
  await deps.port.ensureLabels({ repo });
  const { rows } = await deps.pool.query<{ ok: boolean }>("SELECT setup_install_pr_record($1::uuid, $2::int, $3, NULL) AS ok", [claim.setupId, claim.attempt, claim.headSha]);
  return rows[0]?.ok === true ? "finished" : "skipped";
}

async function pullRequest(deps: SetupInstallDeps, claim: SetupInstallClaim, repo: PullRequestRepo, fail: (c: SetupInstallFailure) => Promise<SetupInstallOutcome>): Promise<SetupInstallOutcome> {
  const base = await deps.port.defaultBranch(repo);
  const state = await deps.port.branchState({ repo, branch: claim.branch, base });
  // The pull request's head is the commit the runner said it pushed, and that commit sits directly on the job's base: a branch someone moved since is not ours to open.
  if (!state.exists || state.headOid !== claim.headSha) return fail("install_head_changed");
  const parents = await deps.port.commitParents({ repo, sha: claim.headSha });
  if (parents === null || parents.length !== 1 || parents[0] !== claim.baseSha) return fail("install_head_changed");
  // The engine's labels exist before anybody can see the pull request (a second pass makes them again; one that exists counts as made).
  await deps.port.ensureLabels({ repo });
  const ref = await deps.port.openDraft({ repo, branch: claim.branch, base, text: installPullRequestText(claim.version) });
  // The pull request shows what its head is: the commit that was pushed. A head that moved between the branch read above and the pull request (a push to the branch, or a reused pull request on a moved branch) is not ours to publish.
  if (ref.headSha !== claim.headSha) {
    await deps.port.close({ repo, number: ref.number });
    return fail("install_head_changed");
  }
  const files = await deps.port.changedFiles({ repo, number: ref.number });
  if (!files.complete || files.files.length === 0 || files.files.some((f) => installPathRefused(f.path))) {
    // an open pull request that cannot be shown to a person is closed; a failure to close is a retry (the lease lapses and the next pass looks again)
    await deps.port.close({ repo, number: ref.number });
    return fail("pr_scope_refused");
  }
  await deps.port.markReady({ repo, pullRequest: ref });
  const { rows } = await deps.pool.query<{ ok: boolean }>("SELECT setup_install_pr_record($1::uuid, $2::int, $3, $4::int) AS ok", [claim.setupId, claim.attempt, claim.headSha, ref.number]);
  return rows[0]?.ok === true ? "opened" : "skipped";
}
