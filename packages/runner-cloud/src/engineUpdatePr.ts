import type { Pool } from "pg";
import { LocalOnlyGithubError } from "./localOnlyGithub.js";
import { RunPullRequestError, type PullRequestRepo, type SetupInstallPort } from "./runPullRequest.js";
import { defaultSetupPrLog, installPathRefused, logSetupPrFailure } from "./setupInstallPr.js";

/**
 * D#845 ON-15c (Ruling 98): the cloud's step after an engine update's runner pushed its branch (`engine_update_head_record`, migration 1093). It rides the reconcile job of the install step: every pass takes the oldest update whose pushed
 * commit is recorded and that has no pull request yet (`engine_update_pr_claim`, migration 1109, under a ten minute lease), and
 *   holds the branch head on GitHub to the recorded commit and that commit to one parent (else nothing is opened and the update fails `update_head_changed`), opens the pull request DRAFT-first through the run port (the open one is
 *   reused on a rerun), reads its changed files and holds them to the install path policy (a workflow path or an odd one closes it: `pr_scope_refused`), only then marks it ready, and records the number: phase `await_merge`.
 * Nothing merges it: a person does, on GitHub. The watch of that merge or close is the webhook's (`engine_update_pr_closed`), and the restart that follows the merge is the system start with the cause `engine_update`.
 * A GitHub that cannot be asked (a 5xx, a rate limit, a timeout) leaves the lease to lapse and the next pass tries again; a refusal that no retry fixes fails the update `pr_open_failed`, which frees the repo for the next one.
 */

/** What `engine_update_pr_claim` hands over: ids from our own rows and the commit the runner pushed. */
export interface EngineUpdateClaim {
  accountId: string;
  updateId: string;
  repoId: string;
  attempt: number;
  headSha: string;
  from: string;
  to: string;
  owner: string;
  name: string;
}

export type EngineUpdateOutcome = "opened" | "failed" | "retry" | "skipped";
export type EngineUpdateFailure = "update_head_changed" | "pr_scope_refused" | "pr_open_failed";

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** The update's branch: the name the signed job carried (1093 holds it to `fx/engine-update-<to_version>`). */
export const engineUpdateBranch = (to: string): string => `fx/engine-update-${to}`;

/** Takes the oldest due update, or null when none is due. A row that is not of the shape a job can have is left leased (`malformed`), never acted on. */
export async function claimEngineUpdate(pool: Pick<Pool, "query">): Promise<EngineUpdateClaim | null | "malformed"> {
  const { rows } = await pool.query<{ o_account: string; o_update: string; o_repo: string; o_attempt: number; o_head: string; o_from: string; o_to: string; o_owner: string | null; o_name: string | null }>(
    "SELECT o_account, o_update, o_repo, o_attempt, o_head, o_from, o_to, o_owner, o_name FROM engine_update_pr_claim()",
  );
  const r = rows[0];
  if (r === undefined) return null;
  if (!SHA.test(r.o_head) || !VERSION.test(r.o_from) || !VERSION.test(r.o_to) || r.o_owner === null || r.o_name === null || !NAME.test(r.o_owner) || !NAME.test(r.o_name)) return "malformed";
  return { accountId: r.o_account, updateId: r.o_update, repoId: r.o_repo, attempt: r.o_attempt, headSha: r.o_head, from: r.o_from, to: r.o_to, owner: r.o_owner, name: r.o_name };
}

/** The pull request's title and body: fixed words and the two versions (digits and dots from our own row), nothing a runner or a guest wrote. */
export function engineUpdatePullRequestText(from: string, to: string): { title: string; body: string } {
  const ok = VERSION.test(from) && VERSION.test(to);
  return {
    title: ok ? `Update the engine (v${from} to v${to})` : "Update the engine",
    body: "Updates this project's engine files, as prepared on your machine. Review the files and merge to finish the update; the engine restarts on the new version after the merge.",
  };
}

export interface EngineUpdatePrDeps {
  /** The platform_ops pool: the claim and the recording definers are its alone. */
  pool: Pick<Pool, "query">;
  port: SetupInstallPort;
  /** Where the one-line JSON diagnostics go (default: `console.log`). Never the database. */
  log?: (line: string) => void;
}

/** The step for one claimed update. Never throws for a GitHub failure: those are `retry` or a recorded failure. A database failure throws. */
export async function completeEngineUpdatePr(deps: EngineUpdatePrDeps, claim: EngineUpdateClaim): Promise<EngineUpdateOutcome> {
  const repo: PullRequestRepo = { id: claim.repoId, owner: claim.owner, name: claim.name };
  const branch = engineUpdateBranch(claim.to);
  const fail = async (code: EngineUpdateFailure): Promise<EngineUpdateOutcome> => {
    const { rows } = await deps.pool.query<{ ok: boolean }>("SELECT engine_update_pr_fail($1::uuid, $2::int, $3, $4) AS ok", [claim.updateId, claim.attempt, claim.headSha, code]);
    return rows[0]?.ok === true ? "failed" : "skipped";
  };
  try {
    const base = await deps.port.defaultBranch(repo);
    const state = await deps.port.branchState({ repo, branch, base });
    if (!state.exists || state.headOid !== claim.headSha) return await fail("update_head_changed");
    const parents = await deps.port.commitParents({ repo, sha: claim.headSha });
    if (parents === null || parents.length !== 1) return await fail("update_head_changed");
    const ref = await deps.port.openDraft({ repo, branch, base, text: engineUpdatePullRequestText(claim.from, claim.to) });
    // The pull request shows what its head is: the commit that was pushed. A head that moved since (a push to the branch, or a reused pull request on a moved branch) is not ours to publish.
    if (ref.headSha !== claim.headSha) {
      await deps.port.close({ repo, number: ref.number });
      return await fail("update_head_changed");
    }
    const files = await deps.port.changedFiles({ repo, number: ref.number });
    if (!files.complete || files.files.length === 0 || files.files.some((f) => installPathRefused(f.path))) {
      // an open pull request that cannot be shown to a person is closed; a failure to close is a retry (the lease lapses and the next pass looks again)
      await deps.port.close({ repo, number: ref.number });
      return await fail("pr_scope_refused");
    }
    await deps.port.markReady({ repo, pullRequest: ref });
    const { rows } = await deps.pool.query<{ ok: boolean }>("SELECT engine_update_pr_record($1::uuid, $2::int, $3, $4::int) AS ok", [claim.updateId, claim.attempt, claim.headSha, ref.number]);
    return rows[0]?.ok === true ? "opened" : "skipped";
  } catch (error) {
    const write = deps.log ?? defaultSetupPrLog;
    if (error instanceof RunPullRequestError) {
      if (error.retryable) return "retry";
      logSetupPrFailure(write, { step: "engine_update_pr", id: claim.updateId, error });
      return fail("pr_open_failed");
    }
    // a call the fence refused is a bug in this step, not a GitHub failure, and no retry fixes it: recorded, so the update does not sit leased and unseen
    if (error instanceof LocalOnlyGithubError) {
      logSetupPrFailure(write, { step: "engine_update_pr", id: claim.updateId, error });
      return fail("pr_open_failed");
    }
    throw error;
  }
}
