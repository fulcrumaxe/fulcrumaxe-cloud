/**
 * The daemon's one gate for a claimed job. A job is run only if all of these hold, and a refusal leaves no trace on the
 * machine (no workspace, no process, no `runJob` call):
 *  - the repository is private: the literal `true`. The protocol's job schema already refuses anything else; the check here
 *    is a second, independent one that reads the raw object first;
 *  - the Ed25519 signature verifies against a key this runner pins, the job has not expired, and it matches the job schema;
 *  - the task prompt, the role card and the role's tool list hash to the digests the signature covers.
 */
import { JobSignatureError, verifyJob as verifyJobSignature, type Job, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import { jobHashRefusals, type HashRefusal } from "../job/verifyHashes.js";

/** Why a job was refused. Closed codes: the reason never carries job content. */
export type JobRefusal = "job_signature_invalid" | "repo_not_private" | "run_id_mismatch" | HashRefusal;

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
  return refusals.length > 0 ? { ok: false, reason: refusals[0]! } : { ok: true, job };
}
