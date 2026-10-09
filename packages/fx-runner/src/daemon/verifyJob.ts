/**
 * The daemon's one gate for a claimed job. A job is run only if all of these hold, and a refusal leaves no trace on the
 * machine (no workspace, no process, no `runJob` call):
 *  - the repository is private: the literal `true`. The protocol's job schema already refuses anything else; the check here
 *    is a second, independent one that reads the raw object first;
 *  - the Ed25519 signature verifies against a key this runner pins, the job has not expired, and it matches the job schema;
 *  - the task prompt, the role card and the role's tool list hash to the digests the signature covers;
 *  - only an executor job continues an earlier run (C25 section 3.2): a `continues` on any other role is refused;
 *  - a review role's job names the commit to review (`review.head_sha`), and no other role's job carries one (D#6 R4d-4, C33 section 1.1);
 *  - a `continues.branch` must have the shape of a run branch (`fx/<uuid>-g<n>`, C25 section 1.3), checked again here before anything is made.
 */
import { isReviewJobRole, JobSignatureError, verifyJob as verifyJobSignature, type Job, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import { jobHashRefusals, type HashRefusal } from "../job/verifyHashes.js";
import { CONTINUES_BRANCH } from "./push.js";

/** Why a job was refused. Closed codes: the reason never carries job content. */
export type JobRefusal = "job_signature_invalid" | "repo_not_private" | "run_id_mismatch" | "continues_wrong_role" | "continues_branch_invalid" | "review_sha_missing" | "review_wrong_role" | HashRefusal;

export type VerifiedJob = { ok: true; job: Job } | { ok: false; reason: JobRefusal };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks a signed job taken from a claim reply. `keyring` holds the pinned public keys by `key_id`. */
export function verifyJob(signed: unknown, keyring: JobKeyring, now: Date): VerifiedJob {
  const repo = isObject(signed) && isObject(signed["job"]) ? signed["job"]["repo"] : undefined;
  if (isObject(repo) && repo["private"] !== true) return { ok: false, reason: "repo_not_private" };
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
  if (job.continues !== null && !CONTINUES_BRANCH.test(job.continues.branch)) return { ok: false, reason: "continues_branch_invalid" };
  if (isReviewJobRole(job.role) && job.review === undefined) return { ok: false, reason: "review_sha_missing" };
  if (!isReviewJobRole(job.role) && job.review !== undefined) return { ok: false, reason: "review_wrong_role" };
  return { ok: true, job };
}
