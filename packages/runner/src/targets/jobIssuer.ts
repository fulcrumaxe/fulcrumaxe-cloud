import { randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";
import {
  RUNNER_ELIGIBLE_ROLES,
  SESSION_ID_PATTERN,
  JobSchema,
  canonicalJson,
  sha256Text,
  signJob,
  type Job,
  type SignedJob,
} from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { toolsForRole } from "../agentConfig.js";
import { writeRunnerJob } from "../runStatusWriter.js";
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
  | "job_invalid"
  | "job_not_recorded";

export class JobIssueError extends Error {
  readonly code: JobIssueErrorCode;
  constructor(code: JobIssueErrorCode) {
    super(`job issuer: ${code}`);
    this.name = "JobIssueError";
    this.code = code;
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
/** The branch the executor's work for an issue lives on. The pipeline's `branchFor` names the same string (a pipeline test pins that). */
export const runnerBranchFor = (issueNumber: number): string => `${RUNNER_BRANCH_PREFIX}issue-${issueNumber}`;

/** The SHA-256 of the role's tool allow list, as the runner must compute it from its own table: sorted, canonical JSON. */
export function roleToolsDigest(role: string): string {
  return sha256Text(canonicalJson([...toolsForRole(role)].sort()));
}

/** What the job needs that the run itself does not carry. */
export interface JobContext {
  repo: { owner: string; name: string };
  spec: { discussion: number; version: number; sha256: string; text: string } | null;
  /** The issue number of the run's work item, which names the branch a fix round continues. */
  issueNumber: number | null;
}

export interface JobContextPort {
  /** Throws `JobIssueError` when the repository is unknown. */
  load(run: ExecutionRun): Promise<JobContext>;
}

/** Reads the job context from the database, under the run's tenant. */
export function createPgJobContext(pool: Pool): JobContextPort {
  return {
    async load(run) {
      if (!run.repoId) throw new JobIssueError("no_repository");
      return withTenant(pool, run.accountId, async (client) => {
        const { rows } = await client.query<{
          gh_owner: string | null;
          gh_name: string | null;
          gh_number: string | null;
          version: number | null;
          body: string | null;
          body_sha256: string | null;
          discussion_number: string | null;
        }>(
          `SELECT r.gh_owner, r.gh_name, w.gh_number, sv.version, sv.body, sv.body_sha256, d.number AS discussion_number
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
        const issue = row.gh_number === null ? Number.NaN : Number(row.gh_number);
        return { repo: { owner: row.gh_owner, name: row.gh_name }, spec, issueNumber: Number.isSafeInteger(issue) && issue >= 1 ? issue : null };
      });
    },
  };
}

export interface JobIssuerDeps {
  /** The runner login's pool: it records the signed job through the definer. */
  pool: Pool;
  signer: JobSigner;
  visibility: RepoVisibilityPort;
  context: JobContextPort;
  /** Tests pass a fixed clock and id source. */
  now?: () => Date;
  newId?: () => string;
}

const MODEL_HINT = /^[A-Za-z0-9._:-]{1,100}$/;

function taskKind(role: string, continues: boolean): Job["task"]["kind"] {
  if (role === "executor") return continues ? "fix" : "implement";
  if (role === "code-reviewer" || role === "security-reviewer" || role === "acceptance-tester" || role === "debater") return "review";
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

      // Asked again here: admit read it earlier, and a repo can be made public in between. Anything but "private" stops.
      const seen = await deps.visibility.visibility({ accountId: run.accountId, repoId: run.repoId }).catch(() => "unknown" as const);
      if (seen === "public") throw new JobIssueError("public_repo");
      if (seen !== "private") throw new JobIssueError("repo_visibility_unknown");

      const context = await deps.context.load(run);

      let continues: Job["continues"] = null;
      if (input.continues) {
        if (!input.continues.parentRunId) throw new JobIssueError("continues_without_parent");
        if (!SESSION_ID_PATTERN.test(input.continues.sessionId)) throw new JobIssueError("continues_session_invalid");
        if (context.issueNumber === null) throw new JobIssueError("continues_without_branch");
        const branch = runnerBranchFor(context.issueNumber);
        // A follow-up of a fix round must push to the branch the lost round was on, so its pull request is updated and not replaced.
        if (input.continues.branch !== undefined && input.continues.branch !== branch) throw new JobIssueError("continues_branch_mismatch");
        continues = { parent_run_id: input.continues.parentRunId, session_id: input.continues.sessionId, branch };
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

      // The definer writes once, to a pending runner_local runner run; `false` means nothing was written.
      const recorded = await writeRunnerJob(deps.pool, { accountId: run.accountId, runId: run.id, job: signed as unknown as Record<string, unknown> });
      if (!recorded) throw new JobIssueError("job_not_recorded");
    },
  };
}
