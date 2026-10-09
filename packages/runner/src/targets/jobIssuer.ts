import { randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";
import {
  REVIEW_JOB_ROLES,
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
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { toolsForRole } from "../agentConfig.js";
import { RUNNER_RUN_BRANCH, readRecordedRunnerBranch, recordRunnerDispatchBase, writeRunnerJob } from "../runStatusWriter.js";
import type { ExecutionRun } from "../executionTarget.js";
import { RUNNER_QUEUE_TTL_MS, type JobIssuer, type RepoVisibilityPort, type RunContinues } from "./runnerTarget.js";

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
  | "continues_role_not_executor"
  | "review_without_head"
  | "review_sha_prompt_mismatch"
  | "sandbox_allowances_invalid"
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

/** The SHA-256 of the role's tool allow list, as the runner must compute it from its own table: sorted, canonical JSON. */
export function roleToolsDigest(role: string): string {
  return sha256Text(canonicalJson([...toolsForRole(role)].sort()));
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
        }>(
          `SELECT r.gh_owner, r.gh_name, sv.version, sv.body, sv.body_sha256, d.number AS discussion_number
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
        const { rows: approved } = await client.query<{ entries: unknown; command_timeout_s: number | null; set_aside: boolean }>(
          `SELECT entries, command_timeout_s, set_aside FROM repo_runner_sandbox_allowances WHERE account_id = $1 AND repo_id = $2 ORDER BY version DESC LIMIT 1`,
          [run.accountId, run.repoId],
        );
        const latest = approved[0];
        const sandboxAllowances = latest && !latest.set_aside ? { entries: latest.entries as AllowanceSet["entries"], ...(latest.command_timeout_s === null ? {} : { command_timeout_s: latest.command_timeout_s }) } : null;
        return { repo: { owner: row.gh_owner, name: row.gh_name }, spec, parentBranch, sandboxAllowances };
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
  /** Tests pass a fixed clock and id source. */
  now?: () => Date;
  newId?: () => string;
}

/** The same pattern as the review prompt's own check and the job schema's `review.head_sha`. */
const REVIEW_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const MODEL_HINT = /^[A-Za-z0-9._:-]{1,100}$/;

function taskKind(role: string, continues: boolean): Job["task"]["kind"] {
  if (role === "executor") return continues ? "fix" : "implement";
  if ((REVIEW_JOB_ROLES as readonly string[]).includes(role)) return "review";
  return "advise";
}

export function createJobIssuer(deps: JobIssuerDeps): JobIssuer {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  return {
    async issue(input: { run: ExecutionRun; continues?: RunContinues }): Promise<void> {
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
      let review: Job["review"];
      if ((REVIEW_JOB_ROLES as readonly string[]).includes(role)) {
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
      if (input.continues) {
        if (!deps.continuationBase) throw new JobIssueError("continues_base_unavailable");
        if (!input.continues.parentRunId) throw new JobIssueError("continues_without_parent");
        if (!SESSION_ID_PATTERN.test(input.continues.sessionId)) throw new JobIssueError("continues_session_invalid");
        // A follow-up of a fix round carries the branch the lost round was on, unchanged; a fix round the pipeline started continues the branch
        // recorded at `done` for the run it fixes. Never derived from the issue. Either way it must be a run branch, so a continuation can only
        // ever push to a branch some runner run's lease named.
        const branch = input.continues.branch ?? context.parentBranch;
        if (branch === null) throw new JobIssueError("continues_without_branch");
        if (!RUNNER_RUN_BRANCH.test(branch)) throw new JobIssueError("continues_branch_mismatch");
        continues = { parent_run_id: input.continues.parentRunId, session_id: input.continues.sessionId, branch };
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
      let sandboxAllowances: Job["sandbox_allowances"];
      if (context.sandboxAllowances) {
        const set = parseAllowanceSet(context.sandboxAllowances);
        if (!set.ok) throw new JobIssueError("sandbox_allowances_invalid");
        if (set.set.entries.length > 0) sandboxAllowances = { entries: set.set.entries, command_timeout_s: set.set.command_timeout_s as number };
      }

      const issuedAt = now();
      const candidate: Job = {
        schema_version: 1,
        job_id: newId(),
        run_id: run.id,
        repo: { id: run.repoId, owner: context.repo.owner, name: context.repo.name, private: true },
        role: role as Job["role"],
        mode: "local",
        spec: context.spec,
        task: { kind: taskKind(role, continues !== null), prompt: run.prompt, prompt_sha256: sha256Text(run.prompt) },
        role_card: { text: run.roleCard, sha256: sha256Text(run.roleCard) },
        role_tools_sha256: roleToolsDigest(role),
        continues,
        ...(review ? { review } : {}),
        ...(sandboxAllowances ? { sandbox_allowances: sandboxAllowances } : {}),
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

      // The definer writes once, to a pending runner_local runner run; `false` means nothing was written.
      const recorded = await writeRunnerJob(deps.pool, { accountId: run.accountId, runId: run.id, job: signed as unknown as Record<string, unknown> });
      if (!recorded) throw new JobIssueError("job_not_recorded");
    },
  };
}
