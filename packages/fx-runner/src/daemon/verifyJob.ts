/**
 * The daemon's one gate for a claimed job. A job is run only if all of these hold, and a refusal leaves no trace on the
 * machine (no workspace, no process, no `runJob` call):
 *  - the repository is private: the literal `true`. The protocol's job schema already refuses anything else; the check here
 *    is a second, independent one that reads the raw object first;
 *  - the Ed25519 signature verifies against a key this runner pins, the job has not expired, and it matches the job schema;
 *  - the task prompt, the role card and the role's tool list hash to the digests the signature covers;
 *  - only an executor job continues an earlier run (C25 section 3.2): a `continues` on any other role is refused;
 *  - a review role's job names the commit to review (`review.head_sha`), and no other role's job carries one (D#6 R4d-4, C33 section 1.1); the claim
 *    verifier's job names its pinned commit the same way (D#483 S4-b2c, `jobCarriesPinnedCommit`), and must;
 *  - a job's sandbox allowances (D#6 R7b) must clear the protocol's floor, checked here by the runner itself even though the cloud signed them and
 *    checked them too: a job that crosses it is refused as `sandbox_allowance_forbidden`, before any process or directory exists;
 *  - a `continues.branch` must have the shape of a run branch (`fx/<uuid>-g<n>`, C25 section 1.3) or of the item's pull request branch (`fx/issue-<n>`,
 *    D#599 PL-2b), checked again here before anything is made. The item branch needs a `pr_number` and a null `session_id`; a run branch has no `pr_number`.
 */
import { jobCarriesPinnedCommit, ITEM_PR_BRANCH, JobSignatureError, verifyJob as verifyJobSignature, type Job, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import { allowanceRefusal } from "../sandbox/allowances.js";
import { jobHashRefusals, type HashRefusal } from "../job/verifyHashes.js";
import { CONTINUES_BRANCH } from "./push.js";

/** Why a job was refused. Closed codes: the reason never carries job content. */
export type JobRefusal = "job_signature_invalid" | "repo_not_private" | "run_id_mismatch" | "continues_wrong_role" | "continues_branch_invalid" | "review_sha_missing" | "review_wrong_role" | "sandbox_allowance_forbidden" | HashRefusal;

export type VerifiedJob = { ok: true; job: Job } | { ok: false; reason: JobRefusal };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The two shapes the runner accepts, checked here independently of the schema: a run branch alone, or an item branch with its pull request number and no session. */
function continuesShapeValid(continues: Record<string, unknown>): boolean {
  if (typeof continues.branch !== "string") return false;
  if (CONTINUES_BRANCH.test(continues.branch)) return continues.pr_number === undefined;
  if (ITEM_PR_BRANCH.test(continues.branch)) return continues.pr_number !== undefined && continues.session_id === null;
  return false;
}

/** Checks a signed job taken from a claim reply. `keyring` holds the pinned public keys by `key_id`. */
export function verifyJob(signed: unknown, keyring: JobKeyring, now: Date): VerifiedJob {
  const repo = isObject(signed) && isObject(signed["job"]) ? signed["job"]["repo"] : undefined;
  if (isObject(repo) && repo["private"] !== true) return { ok: false, reason: "repo_not_private" };
  // The continuation's shape is read from the raw object first, like the privacy flag: a branch that is neither shape, or an item branch without its
  // pull request number or with a session, gets its own closed reason even though the job schema would also refuse it (as a malformed job).
  const rawContinues = isObject(signed) && isObject(signed["job"]) ? signed["job"]["continues"] : undefined;
  if (isObject(rawContinues) && !continuesShapeValid(rawContinues)) return { ok: false, reason: "continues_branch_invalid" };
  let job: Job;
  try {
    job = verifyJobSignature(signed, keyring, { now });
  } catch (error) {
    if (error instanceof JobSignatureError) return { ok: false, reason: "job_signature_invalid" };
    throw error;
  }
  const refusals = jobHashRefusals(job);
  if (refusals.length > 0) return { ok: false, reason: refusals[0]! };
  if (job.continues !== null && job.role !== "executor") return { ok: false, reason: "continues_wrong_role" };
  if (job.continues !== null && !continuesShapeValid(job.continues)) return { ok: false, reason: "continues_branch_invalid" };
  if (jobCarriesPinnedCommit(job.role) && job.review === undefined) return { ok: false, reason: "review_sha_missing" };
  if (!jobCarriesPinnedCommit(job.role) && job.review !== undefined) return { ok: false, reason: "review_wrong_role" };
  if (job.sandbox_allowances !== undefined && allowanceRefusal({ entries: job.sandbox_allowances.entries, commandTimeoutS: job.sandbox_allowances.command_timeout_s }) !== null) return { ok: false, reason: "sandbox_allowance_forbidden" };
  return { ok: true, job };
}
