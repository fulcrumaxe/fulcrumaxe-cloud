import { sha256Text, type Job } from "@fulcrumaxe/runner-protocol";
import { UnknownRoleError, roleToolsDigest } from "./roleTools.js";

/** Why a job was refused on its hashes. Each is a closed reason code the runner can report. */
export type HashRefusal = "unknown_role" | "task_prompt_hash_mismatch" | "role_card_hash_mismatch" | "role_tools_mismatch";

/** The fields of a job these checks read. */
export type HashCheckedJob = Pick<Job, "role" | "task" | "role_card" | "role_tools_sha256">;

/**
 * Every reason a job's text or tool list does not match what the cloud signed. Empty means consistent.
 *
 * Pure: it reads the job and its own role table and nothing else. A caller checks this before it creates a workspace
 * or starts a process, so a refused job leaves no trace on the machine. The role is checked first and fails closed.
 */
export function jobHashRefusals(job: HashCheckedJob): HashRefusal[] {
  let ownDigest: string;
  try {
    ownDigest = roleToolsDigest(job.role);
  } catch (error) {
    if (error instanceof UnknownRoleError) return ["unknown_role"];
    throw error;
  }
  const refusals: HashRefusal[] = [];
  if (sha256Text(job.task.prompt) !== job.task.prompt_sha256) refusals.push("task_prompt_hash_mismatch");
  if (sha256Text(job.role_card.text) !== job.role_card.sha256) refusals.push("role_card_hash_mismatch");
  if (ownDigest !== job.role_tools_sha256) refusals.push("role_tools_mismatch");
  return refusals;
}

/** Thrown by `assertJobHashes`; `reasons` is never empty. */
export class JobHashRefused extends Error {
  constructor(readonly reasons: readonly HashRefusal[]) {
    super(`job refused: ${reasons.join(", ")}`);
    this.name = "JobHashRefused";
  }
}

/** Throws `JobHashRefused` unless the job is consistent. */
export function assertJobHashes(job: HashCheckedJob): void {
  const reasons = jobHashRefusals(job);
  if (reasons.length > 0) throw new JobHashRefused(reasons);
}
