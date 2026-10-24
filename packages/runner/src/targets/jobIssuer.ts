import { randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";
import {
  CONTINUES_CROSS_SIDE_MIN_PROTOCOL,
  MEMORY_JOB_MIN_PROTOCOL,
  EXCLUDES_JOB_MIN_PROTOCOL,
  PINS_JOB_MIN_PROTOCOL,
  BASE_SHA_JOB_MIN_PROTOCOL,
  BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL,
  SPILL_JOB_MIN_PROTOCOL,
  CHECK_JOB_MIN_PROTOCOL,
  CONTEXT_WINDOW_JOB_MIN_PROTOCOL,
  ITEM_PR_BRANCH,
  REVIEW_JOB_ROLES,
  jobCarriesPinnedCommit,
  PROPOSAL_VERIFIER_ROLE,
  RUNNER_ELIGIBLE_ROLES,
  SESSION_ID_PATTERN,
  JobSchema,
  parseAllowanceSet,
  canonicalJson,
  sha256Text,
  signJob,
  type AllowanceSet,
  type Job,
  type SignedJob,
} from "@fulcrumaxe/runner-protocol";
import { effectiveContextBudget, readContextBudgetBytes } from "@fx/core/src/context/contextBudget.js";
import { readItemRules } from "@fx/core/src/context/contextRules.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { runnerToolsForRole } from "../agentConfig.js";
import { RUNNER_RUN_BRANCH, SPEC_PINNED_RUNNER_ROLES, readRecordedRunnerBranch, recordRunnerDispatchBase, writeRunnerJob } from "../runStatusWriter.js";
import type { ExecutionRun } from "../executionTarget.js";
import { RUNNER_QUEUE_TTL_MS, type JobIssuer, type JobMode, type RepoVisibilityPort, type RunContinues } from "./runnerTarget.js";

/**
 * D#6 R3b (correction C12 sections 2.3, 2.4, 2.8): the real `JobIssuer`. It builds the job for a runner run, has a
 * `JobSigner` sign it, and records the signed job through `agent_run_set_runner_job` (R3a's definer, the only writer of
 * `agent_runs.job_signed`).
 *
 *  - The private key is not here. `JobSigner` is a port; the Ed25519 key behind it is read from the process environment in
 *    the worker's composition root and nowhere else, so this package still reads no `process.env`.
 *  - `repo.private` is the literal `true` and is set only after the `RepoVisibilityPort` has said so again at issue time
 *    (admit asked earlier; the repo may have been made public since). A public repo and one the port cannot read both
 *    throw, and nothing is recorded, so a run is never queued with a job behind it that names a public repo.
 *  - `role_tools_sha256` is the digest of the tool table this package holds for the role (`toolsForRole`). A runner
 *    refuses a job whose value differs from its own table's entry (R4b).
 *  - The task prompt and the role card travel with a digest each. The text of both is whatever the run was started with;
 *    the issuer does not read or rewrite it.
 *  - Every refusal is a `JobIssueError` with a closed code, and nothing is recorded: the run stays `pending` without a
 *    job, and `RunnerTarget.dispatch` rejects, so `startAgentRun` fails the run.
 */

export type JobIssueErrorCode =
  | "public_repo"
  | "repo_visibility_unknown"
  | "role_not_runner_eligible"
  | "no_repository"
  | "repository_unreadable"
  | "spec_without_discussion"
  | "continues_without_parent"
  | "continues_session_invalid"
  | "continues_without_branch"
  | "continues_branch_mismatch"
  | "continues_base_unavailable"
  | "continues_base_invalid"
  | "continues_pr_not_open"
  | "continues_pr_mismatch"
  | "continues_branch_protected"
  | "continues_role_not_executor"
  | "review_without_head"
  | "review_sha_prompt_mismatch"
  | "sandbox_allowances_invalid"
  | "excludes_unreadable"
  | "job_invalid"
  | "job_not_recorded";

export class JobIssueError extends Error {
  readonly code: JobIssueErrorCode;
  /**
   * True only when the refusal came from a failure that may pass (GitHub could not be reached to read a continuation's branch head). The
   * follow-up dispatch leaves such a child pending for the sweeper's retry instead of failing it. Every other refusal is final.
   */
  readonly retryable: boolean;
  constructor(code: JobIssueErrorCode, options: { retryable?: boolean } = {}) {
    super(`job issuer: ${code}`);
    this.name = "JobIssueError";
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

/** Signs a job. The only holder of the private key; the implementation is built in the worker's composition root. */
export interface JobSigner {
  /** The `key_id` a runner uses to find the public key. */
  readonly keyId: string;
  sign(job: Job): SignedJob;
}

/** A signer over an Ed25519 key the caller already holds. The key never leaves this closure. */
export function createJobSigner(input: { keyId: string; privateKey: KeyObject }): JobSigner {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("createJobSigner: the key must be an Ed25519 private key");
  }
  const { keyId, privateKey } = input;
  return { keyId, sign: (job) => signJob({ ...job, key_id: keyId }, privateKey) };
}

/** The branch prefix of every run branch the executor works on. */
export const RUNNER_BRANCH_PREFIX = "fx/";

/** The SHA-256 of the role's tool allow list, as the runner must compute it from its own table: sorted, canonical JSON (`runnerToolsForRole`). */
export function roleToolsDigest(role: string): string {
  return sha256Text(canonicalJson([...runnerToolsForRole(role)].sort()));
}

/** What the job needs that the run itself does not carry. */
export interface JobContext {
  repo: { owner: string; name: string };
  spec: { discussion: number; version: number; sha256: string; text: string } | null;
  /**
   * The run branch that `done` recorded for the run named by `load`'s `parentRunId` (C25 section 1.2), or null when there is none. This is where a
   * fix round's branch comes from: it is never derived from the issue.
   */
  parentBranch: string | null;
  /** D#599 PL-2b: the work item's own issue number (`work_items.gh_number`), the only `n` an `fx/issue-<n>` continuation branch may carry; null/absent when the item has none. */
  issueNumber?: number | null;
  /**
   * D#6 R7a (C35): the repo's approved sandbox allowances as stored (the newest approval, unless it was set aside), or null/absent when there
   * are none. Read from the database only: nothing here comes from the repository's contents.
   */
  sandboxAllowances?: AllowanceSet | null;
}

export interface JobContextPort {
  /**
   * Throws `JobIssueError` when the repository is unknown. `parentRunId` names the run whose recorded branch to read into `parentBranch`;
   * without it, `parentBranch` is null.
   */
  load(run: ExecutionRun, options?: { parentRunId?: string | null }): Promise<JobContext>;
}

/** Reads the job context from the database, under the run's tenant. */
export function createPgJobContext(pool: Pool): JobContextPort {
  return {
    async load(run, options = {}) {
      if (!run.repoId) throw new JobIssueError("no_repository");
      return withTenant(pool, run.accountId, async (client) => {
        const { rows } = await client.query<{
          gh_owner: string | null;
          gh_name: string | null;
          version: number | null;
          body: string | null;
          body_sha256: string | null;
          discussion_number: string | null;
          gh_number: string | null;
        }>(
          `SELECT r.gh_owner, r.gh_name, sv.version, sv.body, sv.body_sha256, d.number AS discussion_number, w.gh_number
             FROM agent_runs ar
             LEFT JOIN repos r ON r.account_id = ar.account_id AND r.id = $3
             LEFT JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id
             LEFT JOIN discussions d ON d.account_id = ar.account_id AND d.id = w.discussion_id
             LEFT JOIN LATERAL (
               SELECT s.version, s.body, s.body_sha256 FROM spec_versions s
                WHERE s.account_id = ar.account_id AND s.work_item_id = ar.work_item_id AND s.erased_at IS NULL
                  AND (ar.spec_version_id IS NULL OR s.id = ar.spec_version_id)
                ORDER BY s.version DESC LIMIT 1
             ) sv ON true
            WHERE ar.account_id = $1 AND ar.id = $2`,
          [run.accountId, run.id, run.repoId],
        );
        const row = rows[0];
        if (!row || !row.gh_owner || !row.gh_name) throw new JobIssueError("repository_unreadable");
        let spec: JobContext["spec"] = null;
        if (row.version !== null && row.body !== null && row.body_sha256 !== null) {
          const discussion = row.discussion_number === null ? Number.NaN : Number(row.discussion_number);
          if (!Number.isSafeInteger(discussion) || discussion < 1) throw new JobIssueError("spec_without_discussion");
          spec = { discussion, version: Number(row.version), sha256: row.body_sha256, text: row.body };
        }
        const parentBranch = options.parentRunId ? await readRecordedRunnerBranch(client, { accountId: run.accountId, runId: options.parentRunId }) : null;
        // The newest approval wins; one that was set aside (the repo left runner_local) signs nothing until an admin approves again.
        const { rows: approved } = await client.query<{ entries: unknown; command_timeout_s: number | null; set_aside: boolean; check_argv: string[] | null; check_dev_shell: boolean | null; check_timeout_s: number | null }>(
          `SELECT entries, command_timeout_s, set_aside, check_argv, check_dev_shell, check_timeout_s FROM repo_runner_sandbox_allowances WHERE account_id = $1 AND repo_id = $2 ORDER BY version DESC LIMIT 1`,
          [run.accountId, run.repoId],
        );
        const latest = approved[0];
        // The approved check is part of the same row, so it is set aside with it (D#6 R-CHK-1). The three columns are all null or all set (a database CHECK).
        const check = latest?.check_argv ? { argv: latest.check_argv, dev_shell: latest.check_dev_shell, timeout_s: latest.check_timeout_s } : null;
        const sandboxAllowances = latest && !latest.set_aside ? ({ entries: latest.entries as AllowanceSet["entries"], ...(latest.command_timeout_s === null ? {} : { command_timeout_s: latest.command_timeout_s }), ...(check ? { check } : {}) } as AllowanceSet) : null;
        const issueNumber = row.gh_number === null ? null : Number(row.gh_number);
        return { repo: { owner: row.gh_owner, name: row.gh_name }, spec, parentBranch, issueNumber: issueNumber !== null && Number.isSafeInteger(issueNumber) && issueNumber >= 1 ? issueNumber : null, sandboxAllowances };
      });
    },
  };
}

/**
 * D#6 R2b-3f (C21 section 5.3, C22 section 2): reads the head of a continuation's branch from GitHub at the run's own dispatch, so `done` can
 * require that the run added a commit of its own. The live implementation is the runner-cloud GitHub port (a `RunBranchState` read, which
 * is allowlist entry A1); this package cannot import it, so it is a port here.
 */
export interface ContinuationBasePort {
  /** The branch's head object id, or null when the branch does not exist yet. A throw is a failure to find out; one carrying `retryable: true` (GitHub unreachable) may pass, any other is final. */
  headOid(input: { repo: { id: string; owner: string; name: string }; branch: string }): Promise<string | null>;
}

/** A pull request as GitHub lists it, reduced to the fields the binding reads: structured values only, never a title, body or comment. */
export interface BoundPullRequestView {
  number: number;
  state: "open" | "closed";
  /** `head.repo.id`; null when the head repository is gone (a deleted fork). */
  headRepoId: number | null;
  /** The id of THIS repository: the live adapter reports OUR stored GitHub repository id here, never what GitHub says about the base. The head must equal it. */
  baseRepoId: number | null;
  headRef: string;
}

/** The repository a binding read is about. `local` is true for a `runner_local` run, whose reads go through the local-only fence (the run's own mode, never the repository's). */
export interface BindingRepo {
  id: string;
  owner: string;
  name: string;
  local: boolean;
}

/**
 * D#599 PL-2b: the GitHub reads that bind a cross-side continuation to the item's own pull request. The live implementation goes through the same fenced
 * client the pipeline uses: the pulls-by-head list (allowlist A3, every state), the repository read (A2) and the branch-protection read (A8), so a
 * `runner_local` repo needs nothing the fence does not already allow. A port, because this package cannot import the GitHub clients.
 */
export interface ContinuationBindingPort {
  /** Pull requests whose head is `branch` in this repository's owner (state `all`), as listed. A non-200 answer is a `status` and no list. */
  pullRequestsByHead(input: { repo: BindingRepo; branch: string }): Promise<{ status: number; pulls?: readonly BoundPullRequestView[] }>;
  /** The repository's `default_branch`; null when it could not be read. */
  defaultBranch(input: { repo: BindingRepo }): Promise<string | null>;
  /** The HTTP status of the branch's protection read: 200 means protected, 404 means not. Any other status is "could not tell". */
  branchProtection(input: { repo: BindingRepo; branch: string }): Promise<{ status: number }>;
}

export interface JobIssuerDeps {
  /** The runner login's pool: it records the signed job through the definer. */
  pool: Pool;
  signer: JobSigner;
  visibility: RepoVisibilityPort;
  context: JobContextPort;
  /**
   * Required to issue a continuation (a fix round, or a follow-up of one): without it, or when it cannot answer, the continuation is
   * refused (`continues_base_unavailable`) and nothing is recorded, so no continuation is ever queued whose `done` could not be judged.
   */
  continuationBase?: ContinuationBasePort;
  /**
   * Required to issue a continuation on the item's pull request branch (`fx/issue-<n>`): without it that continuation is refused
   * (`continues_base_unavailable`). A continuation on a run branch does not use it.
   */
  continuationBinding?: ContinuationBindingPort;
  /**
   * D#600 CX-6b: the model's context window in tokens from the price table, or undefined when it has none. Wired where `@fx/spend` may be imported (this module may not). Absent:
   * no job carries a window.
   */
  contextWindowTokensFor?: (model: string) => number | undefined;
  /** Tests pass a fixed clock and id source. */
  now?: () => Date;
  newId?: () => string;
}

/** The same pattern as the review prompt's own check and the job schema's `review.head_sha`. */
const REVIEW_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const MODEL_HINT = /^[A-Za-z0-9._:-]{1,100}$/;

/** The prefix of an item pull request branch; `n` is appended. */
const ITEM_BRANCH_PREFIX = "fx/issue-";

/**
 * D#599 PL-2b security model 2 and 4: binds an item pull request branch to the item's open pull request in THIS repository, on GitHub, now, and
 * refuses the repository's default branch and any protected branch. Returns the pull request number to sign. Every refusal is a closed code and nothing is recorded.
 * `expected` is the number the caller recorded for the item, when it has one: GitHub must say the same.
 */
export async function bindItemPullRequest(
  binding: ContinuationBindingPort | undefined,
  repo: BindingRepo,
  branch: string,
  expected: number | undefined,
): Promise<number> {
  // The caller always names the pull request number it recorded (D#599 R-599-PL2b-1-c): a continuation with none is refused, not guessed from GitHub.
  if (expected === undefined) throw new JobIssueError("continues_pr_mismatch");
  if (!binding) throw new JobIssueError("continues_base_unavailable");
  const unavailable = (): JobIssueError => new JobIssueError("continues_base_unavailable", { retryable: true });
  let listed: Awaited<ReturnType<ContinuationBindingPort["pullRequestsByHead"]>>;
  try {
    listed = await binding.pullRequestsByHead({ repo, branch });
  } catch {
    // fx-swallow-ok: the cause can carry a name or a token; only the closed code survives
    throw unavailable();
  }
  if (listed.status !== 200 || !Array.isArray(listed.pulls)) throw unavailable();
  const pulls = listed.pulls;
  if (pulls.length === 0) throw new JobIssueError("continues_pr_not_open");
  // The head repository must be this repository (a fork's branch of the same name is not the item's branch).
  const mine = pulls.filter((p) => p.headRepoId !== null && p.headRepoId === p.baseRepoId);
  if (mine.length === 0) throw new JobIssueError("continues_pr_mismatch");
  const open = mine.filter((p) => p.state === "open");
  if (open.length === 0) throw new JobIssueError("continues_pr_not_open");
  const pr = open[0]!;
  if (open.length > 1 || pr.headRef !== branch || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.number !== expected) throw new JobIssueError("continues_pr_mismatch");

  let protection: { status: number };
  try {
    const defaultBranch = await binding.defaultBranch({ repo });
    if (defaultBranch === null) throw unavailable();
    // A default branch is never a continuation's branch; checked before the protection read so a protected default is named for what it is.
    if (defaultBranch === branch) throw new JobIssueError("continues_branch_protected");
    protection = await binding.branchProtection({ repo, branch });
  } catch (error) {
    if (error instanceof JobIssueError) throw error;
    // fx-swallow-ok: the cause can carry a name or a token; only the closed code survives
    throw unavailable();
  }
  if (protection.status === 200) throw new JobIssueError("continues_branch_protected");
  if (protection.status !== 404) throw unavailable();
  return pr.number;
}

function taskKind(role: string, continues: boolean): Job["task"]["kind"] {
  if (role === "executor") return continues ? "fix" : "implement";
  if ((REVIEW_JOB_ROLES as readonly string[]).includes(role)) return "review";
  return "advise";
}

/**
 * FIXROUND-BASE-SYNC (R2-b, R2-c0): the diff base is the base tip the cloud brought the branch up to date with, handed down by the code that did it. A value that is not a full commit id is refused, never
 * trimmed or guessed, and so is one that was synced on a different branch than the one this job continues (or that names no branch at all).
 */
function continuationBase(c: RunContinues, branch: string): string | undefined {
  if (c.baseSha === undefined) return undefined;
  if (!/^[0-9a-f]{40}$/.test(c.baseSha) || c.baseBranch !== branch) throw new JobIssueError("continues_base_invalid");
  return c.baseSha;
}

export function createJobIssuer(deps: JobIssuerDeps): JobIssuer {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  return {
    async issue(input: { run: ExecutionRun; continues?: RunContinues; jobMode?: JobMode }): Promise<void> {
      const { run } = input;
      const role = run.role;
      if (!(RUNNER_ELIGIBLE_ROLES as readonly string[]).includes(role)) throw new JobIssueError("role_not_runner_eligible");
      if (!run.repoId) throw new JobIssueError("no_repository");
      // Only the executor continues a run (C25 section 3.2): no other role has a branch of its own to continue, and none pushes to one.
      if (input.continues && role !== "executor") throw new JobIssueError("continues_role_not_executor");

      // Asked again here: admit read it earlier, and a repo can be made public in between. Anything but "private" stops.
      const seen = await deps.visibility.visibility({ accountId: run.accountId, repoId: run.repoId }).catch(() => "unknown" as const);
      if (seen === "public") throw new JobIssueError("public_repo");
      if (seen !== "private") throw new JobIssueError("repo_visibility_unknown");

      // D#6 R4d-4 (C33 section 1.2): a review job names the commit to review, from the run's stored head (`agent_runs.head_sha`), never parsed out
      // of the prompt. A review with no valid head, or whose prompt names a different commit, is refused and nothing is recorded.
      // D#483 S4-b2c: the claim verifier's job names its pinned commit the same way (the commit its cites are re-read at), under the same checks.
      let review: Job["review"];
      if (jobCarriesPinnedCommit(role)) {
        const head = run.headSha;
        if (typeof head !== "string" || !REVIEW_SHA.test(head)) throw new JobIssueError("review_without_head");
        if (!run.prompt.includes(head)) throw new JobIssueError("review_sha_prompt_mismatch");
        review = { head_sha: head };
      }

      // A fix round the pipeline started has no branch of its own to carry: it continues the branch recorded for the run it fixes (C25 section 1.2).
      const needsRecordedBranch = input.continues !== undefined && input.continues.branch === undefined;
      const context = await deps.context.load(run, { parentRunId: needsRecordedBranch ? (input.continues?.parentRunId ?? null) : null });

      let continues: Job["continues"] = null;
      let continuationHead: { oid: string | null } | null = null;
      let boundPullRequest: { prNumber: number; branch: string } | null = null;
      if (input.continues) {
        if (!deps.continuationBase) throw new JobIssueError("continues_base_unavailable");
        if (!input.continues.parentRunId) throw new JobIssueError("continues_without_parent");
        const sessionId = input.continues.sessionId;
        if (sessionId !== null && !SESSION_ID_PATTERN.test(sessionId)) throw new JobIssueError("continues_session_invalid");
        // A follow-up of a fix round carries the branch the lost round was on, unchanged; a fix round the pipeline started continues the branch
        // recorded at `done` for the run it fixes. Never derived from the issue. Either way it is ONE of two shapes, never a third: a run branch
        // (as always), or the item's own pull request branch `fx/issue-<n>` for the item's own issue number (D#599 PL-2b), bound below.
        const branch = input.continues.branch ?? context.parentBranch;
        if (branch === null) throw new JobIssueError("continues_without_branch");
        // A foreign session is never claimed on the item's pull request branch: with a session id that name is not a continuation branch at all.
        const itemBranch = sessionId === null && ITEM_PR_BRANCH.test(branch);
        if (!itemBranch && !RUNNER_RUN_BRANCH.test(branch)) throw new JobIssueError("continues_branch_mismatch");
        if (itemBranch) {
          // `n` must be this item's own issue number.
          if (context.issueNumber === undefined || context.issueNumber === null || branch !== `${ITEM_BRANCH_PREFIX}${context.issueNumber}`) throw new JobIssueError("continues_pr_mismatch");
          const repoRef: BindingRepo = { id: run.repoId, owner: context.repo.owner, name: context.repo.name, local: input.jobMode !== "verified" };
          const prNumber = await bindItemPullRequest(deps.continuationBinding, repoRef, branch, input.continues.prNumber);
          boundPullRequest = { prNumber, branch };
          const baseSha = continuationBase(input.continues, branch);
          continues = { parent_run_id: input.continues.parentRunId, session_id: null, branch, pr_number: prNumber, ...(baseSha === undefined ? {} : { base_sha: baseSha }) };
        } else {
          if (input.continues.prNumber !== undefined) throw new JobIssueError("continues_pr_mismatch");
          const baseSha = continuationBase(input.continues, branch);
          continues = { parent_run_id: input.continues.parentRunId, session_id: sessionId, branch, ...(baseSha === undefined ? {} : { base_sha: baseSha }) };
        }
        // The branch head NOW, at this run's own dispatch: never the parent's recorded value (a lost parent may have pushed since).
        try {
          continuationHead = { oid: await deps.continuationBase.headOid({ repo: { id: run.repoId, owner: context.repo.owner, name: context.repo.name }, branch }) };
        } catch (error) {
          // fx-swallow-ok: a failure to read the branch is a refusal to issue; the cause can carry a name or a token, so only the code survives.
          // Only an error that says it may pass (`retryable: true`, as the GitHub port's "unreachable" does) is marked so.
          throw new JobIssueError("continues_base_unavailable", { retryable: typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true });
        }
      }

      // D#6 R7a (C35): the approved allowances ride in the job only when the set has entries, and only after they clear the floor again here (the
      // constant may have tightened since the approval). A set that does not is refused and nothing is recorded: never signed without it.
      // The approved check (R-CHK-1) rides in its own key, read from the same stored row and held to the same schema; a check that no longer parses refuses the job too.
      // D#483 S4-b2c: the claim verifier runs no command, so its job carries neither (it holds no Bash, and nothing runs after it).
      let sandboxAllowances: Job["sandbox_allowances"];
      let check: Job["check"];
      if (context.sandboxAllowances && role !== PROPOSAL_VERIFIER_ROLE) {
        const set = parseAllowanceSet(context.sandboxAllowances);
        if (!set.ok) throw new JobIssueError("sandbox_allowances_invalid");
        if (set.set.entries.length > 0) sandboxAllowances = { entries: set.set.entries, command_timeout_s: set.set.command_timeout_s as number };
        // The check runs after the agent ends, on whatever it left in the work tree. A role that cannot push (classify, spec and panel seats, reviewers, advisers) leaves nothing to check, so its job
        // carries none and the runner does not spend a full suite after a turn that changes no code. The pushing roles are the ones the git policy lets push (`SPEC_PINNED_RUNNER_ROLES`).
        if (SPEC_PINNED_RUNNER_ROLES.has(role)) check = set.set.check;
      }

      // D#600 CX-5c: the item's excludes as they stand now (its own rules over the repository's), read when the job is issued, so a fix round gets the rules of its own issue and not those of the
      // first start. Paths and globs only. A read that fails refuses the job (nothing is recorded): a job never goes out without the list it should have carried (fail closed).
      let excludes: string[] = [];
      let pinPaths: string[] = [];
      if (run.workItemId !== undefined && run.workItemId !== null) {
        const workItemId = run.workItemId;
        try {
          const rules = await withTenant(deps.pool, run.accountId, (client) => readItemRules(client, run.accountId, workItemId));
          excludes = [...new Set(rules.filter((r) => r.kind === "exclude").map((r) => r.path))].sort();
          // D#600 CX-5c2: the pins of an executor's first run (as on the sandbox path, a fix round or a review gets none). Paths only, all of them: the runner applies the exclude-wins rule itself, so it can count the
          // pins an exclude covers (`pin_excluded`) and never opens them.
          if (role === "executor" && input.continues === undefined) pinPaths = [...new Set(rules.filter((r) => r.kind === "pin").map((r) => r.path))].sort();
        } catch {
          // fx-swallow-ok: the cause can carry a name or a path; only the closed code survives
          throw new JobIssueError("excludes_unreadable");
        }
      }

      let pinBudget: number | undefined;
      // The repository's prompt budget now (its stored size, else the executor default), which the runner compares the pins with to record `pins_over_budget`. A read that fails leaves it out; a pin is never refused for it.
      if (pinPaths.length > 0) {
        try {
          pinBudget = effectiveContextBudget("executor", await readContextBudgetBytes(deps.pool, run.accountId, run.repoId));
        } catch {
          // fx-swallow-ok: the budget only drives the overage note in the ledger; without it the job carries none
        }
      }

      // D#600 CX-6b: the model's window from the price table, for the local runner's context note. A model with no figure, a name that is not a model hint, or a price table that cannot be read
      // carries none, and that run gets no note (no default window): advisory only, so it never fails the job.
      let contextWindowTokens: number | undefined;
      if (deps.contextWindowTokensFor !== undefined && MODEL_HINT.test(run.model)) {
        try {
          contextWindowTokens = deps.contextWindowTokensFor(run.model);
        } catch {
          // fx-swallow-ok: the window only drives an advisory note; without it the job simply carries none
        }
      }

      const issuedAt = now();
      const candidate: Job = {
        schema_version: 1,
        job_id: newId(),
        run_id: run.id,
        repo: { id: run.repoId, owner: context.repo.owner, name: context.repo.name, private: true },
        role: role as Job["role"],
        mode: input.jobMode === "verified" ? "verified" : "local",
        spec: context.spec,
        task: { kind: taskKind(role, continues !== null), prompt: run.prompt, prompt_sha256: sha256Text(run.prompt) },
        role_card: { text: run.roleCard, sha256: sha256Text(run.roleCard) },
        role_tools_sha256: roleToolsDigest(role),
        continues,
        ...(review ? { review } : {}),
        ...(sandboxAllowances ? { sandbox_allowances: sandboxAllowances } : {}),
        ...(check ? { check } : {}),
        // D#601 MEM-3b: the memory the pipeline recalled, as it split it. Omitted when the run has none (never null, never an empty pair), so such a job's signed bytes are unchanged.
        ...(run.jobMemory && (run.jobMemory.person !== "" || run.jobMemory.fenced !== "") ? { memory: { person: run.jobMemory.person, fenced: run.jobMemory.fenced } } : {}),
        // D#600 CX-5c: omitted when the item has none (never null, never empty), so such a job's signed bytes are unchanged.
        ...(excludes.length > 0 ? { excludes } : {}),
        // D#600 CX-5c2: omitted when the run has no pins (never null, never empty). Paths and one figure, never file text.
        ...(pinPaths.length > 0 ? { pins: { paths: pinPaths, ...(pinBudget !== undefined ? { budget_bytes: pinBudget } : {}) } } : {}),
        // D#600 CX-4b: the full text the prompt cut, in the run's own spill files (closed codes and text, nothing else). Omitted when the prompt cut nothing. The prompt already carries the marker.
        ...(run.contextSpill && run.contextSpill.files.length > 0 ? { spill: run.contextSpill.files.map((f) => ({ code: f.code, text: f.text })) } : {}),
        // D#600 CX-6b: omitted when the model has no window figure (never null), so such a job's signed bytes are unchanged.
        ...(contextWindowTokens !== undefined ? { context_window: contextWindowTokens } : {}),
        branch_prefix: RUNNER_BRANCH_PREFIX,
        model_hint: MODEL_HINT.test(run.model) ? run.model : null,
        issued_at: issuedAt.toISOString(),
        expires_at: new Date(issuedAt.getTime() + RUNNER_QUEUE_TTL_MS).toISOString(),
        key_id: deps.signer.keyId,
      };
      if (!JobSchema.safeParse(candidate).success) throw new JobIssueError("job_invalid");

      let signed: SignedJob;
      try {
        signed = deps.signer.sign(candidate);
      } catch {
        throw new JobIssueError("job_invalid");
      }

      // Recorded before the job, so a continuation's job never exists without its base; a base recorded for a job that then fails to write is harmless.
      if (continuationHead) await recordRunnerDispatchBase(deps.pool, { accountId: run.accountId, runId: run.id, headOid: continuationHead.oid });

      // The definer writes once, to a pending runner run (either runner mode); `false` means nothing was written.
      // The job's lowest runner protocol and the binding event go in the same transaction as the job (D#599 PL-2b): a job in the cross-side shape (a null
      // session id or a pull request number) is never offered to a runner whose parse predates it, and the event is the only thing that lets the branch be pushed.
      const crossSide = continues !== null && (continues.session_id === null || continues.pr_number !== undefined);
      const recorded = await writeRunnerJob(deps.pool, {
        accountId: run.accountId,
        runId: run.id,
        job: signed as unknown as Record<string, unknown>,
        // A job that carries memory is also gated: an older runner's strict parse would refuse the `memory` key, so it waits for an updated runner instead. The same holds for excludes (CX-5c): a runner that ignored them would run the agent with nothing denied. And for pins (CX-5c2): the strict parse again. And for a spill (CX-4b): a cut prompt is never sent uncut to an older runner, it waits for an updated one. And for a window figure (CX-6b): the same strict-parse reason. And for a continuation's `base_sha` (R2-b): the strict parse again, and a runner that ignored it would pick its own diff base.
        minProtocolVersion: Math.max(crossSide ? CONTINUES_CROSS_SIDE_MIN_PROTOCOL : 0, candidate.memory ? MEMORY_JOB_MIN_PROTOCOL : 0, candidate.excludes ? EXCLUDES_JOB_MIN_PROTOCOL : 0, candidate.pins ? PINS_JOB_MIN_PROTOCOL : 0, candidate.spill ? SPILL_JOB_MIN_PROTOCOL : 0, candidate.context_window !== undefined ? CONTEXT_WINDOW_JOB_MIN_PROTOCOL : 0, candidate.check ? CHECK_JOB_MIN_PROTOCOL : 0, continues?.base_sha === undefined ? 0 : continues.pr_number === undefined ? BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL : BASE_SHA_JOB_MIN_PROTOCOL) || null,
        ...(boundPullRequest ? { continuesBound: boundPullRequest } : {}),
      });
      if (!recorded) throw new JobIssueError("job_not_recorded");
    },
  };
}
