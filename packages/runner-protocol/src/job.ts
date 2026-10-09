/**
 * The job the cloud hands a runner. Every field is a bounded identifier, an enum, a digest, a number or a timestamp,
 * apart from three pieces of prose for the agent: `spec.text`, `task.prompt` and `role_card.text`. No field can carry a
 * command, a URL, an image or binary reference, an environment map or a settings object, and strict parsing refuses any
 * unlisted key. The one list of values is `sandbox_allowances` (D#6 R7a): entries of a closed kind, each a path, a plain host or the
 * loopback address, which the cloud signs only after an admin approved them and the runner refuses if they cross the floor. The job travels signed (jobSignature.ts); the runner trusts nothing in it unsigned.
 *
 * D#6 R3b (correction C12 section 2.3): the job was reshaped before any runner shipped. `spec` may be null (a run with
 * no Spec), `task` and `role_card` carry the prompt and the role card with a digest each, the repository is always
 * private, `role_tools_sha256` pins the tool table the runner must hold for the role, `continues` names the earlier run
 * and session a fix round resumes, and `credential_mode` is gone (the runner knows its own mode from its registration).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { JobAllowancesSchema } from "./sandboxAllowances.js";

/** Largest `spec.text`, in characters. It matches the cap on a request body. */
export const MAX_SPEC_TEXT_CHARS = 256 * 1024;
/** Largest `task.prompt` and `role_card.text`, in characters. */
export const MAX_TASK_PROMPT_CHARS = 128 * 1024;
export const MAX_ROLE_CARD_CHARS = 64 * 1024;

/**
 * The roles a runner may run: the executor and its fix loop, spec drafting, the panel seats, docs, the advisory
 * accessibility pass and, by the owner ruling of C12 section 1 (which supersedes R1b's exclusion of them), the four
 * reviewers whose verdict can gate a merge on a `runner_local` repo: code, security, acceptance and the debater.
 */
export const RUNNER_ELIGIBLE_ROLES = [
  "executor", "project-manager", "technical-architect", "product-owner", "cost-analyst",
  "performance-expert", "security-expert", "docs-writer", "accessibility-reviewer",
  "code-reviewer", "security-reviewer", "acceptance-tester", "debater",
] as const;
export const RunnerRole = z.enum(RUNNER_ELIGIBLE_ROLES);

/**
 * D#6 R4d-4 (C33): the roles whose job carries `review: { head_sha }`, the commit the runner checks out for the review. These four
 * are the runner-eligible roles whose verdict gates a merge. The cloud's job issuer and the runner both read this list, so there
 * is no second copy of it.
 */
export const REVIEW_JOB_ROLES = ["code-reviewer", "security-reviewer", "acceptance-tester", "debater"] as const;
export type ReviewJobRole = (typeof REVIEW_JOB_ROLES)[number];
export const isReviewJobRole = (role: string): role is ReviewJobRole => (REVIEW_JOB_ROLES as readonly string[]).includes(role);

export const JOB_MODES =["local", "verified"] as const;

/** What the run is for. Closed. The runner picks its tools from the role, never from this. */
export const TASK_KINDS = ["implement", "fix", "review", "advise"] as const;
export const TaskKind = z.enum(TASK_KINDS);

const uuid = z.string().uuid();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A Claude Code session id: a bounded identifier. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** A branch name: bounded segments, no "..". */
const branchName = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .max(200)
  .refine((value) => !value.includes(".."));

/** SHA-256 of a string's UTF-8 bytes, lowercase hex: the digest `task.prompt_sha256` and `role_card.sha256` hold. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const JobSchema = z
  .object({
    schema_version: z.literal(1),
    job_id: uuid,
    run_id: uuid,
    // Always private: a job for a public repo does not parse. The cloud's visibility port sets this at dispatch and the claim re-checks it.
    repo: z.object({ id: uuid, owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/), name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), private: z.literal(true) }).strict(),
    role: RunnerRole,
    mode: z.enum(JOB_MODES),
    spec: z
      .object({
        discussion: z.number().int().min(1),
        version: z.number().int().min(1),
        sha256: sha256Hex,
        text: z.string().max(MAX_SPEC_TEXT_CHARS),
      })
      .strict()
      .nullable(),
    task: z.object({ kind: TaskKind, prompt: z.string().max(MAX_TASK_PROMPT_CHARS), prompt_sha256: sha256Hex }).strict(),
    role_card: z.object({ text: z.string().min(1).max(MAX_ROLE_CARD_CHARS), sha256: sha256Hex }).strict(),
    // SHA-256 of the canonical JSON of the role's tool allow list. A runner refuses a job whose value differs from its own table's entry for the role.
    role_tools_sha256: sha256Hex,
    continues: z.object({ parent_run_id: uuid, session_id: z.string().regex(SESSION_ID_PATTERN), branch: branchName }).strict().nullable(),
    // D#6 R4d-4 (C33): present exactly on a review-role job (REVIEW_JOB_ROLES), omitted (never null) on every other job so their canonical JSON
    // and signature are unchanged. The signature covers it. 40 or 64 lowercase hex, the commit under review.
    review: z.object({ head_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict().optional(),
    // D#6 R7a (C35): the repo's admin-approved sandbox allowances, present only when the approved set has entries and omitted (never null or empty)
    // on every other job, so their canonical JSON and signature are unchanged. The signature covers it. The runner floor-checks it (R7b).
    sandbox_allowances: JobAllowancesSchema.optional(),
    // A branch-name prefix such as "fx/". No URL, no "..".
    branch_prefix: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/).max(100).refine((value) => !value.includes("..")),
    model_hint: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).nullable(),
    issued_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

/** A job and its Ed25519 signature (base64url) over the canonical JSON of the job. */
export const SignedJobSchema = z.object({ job: JobSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type SignedJob = z.infer<typeof SignedJobSchema>;

/**
 * The digests in a job that do not match the text they name. Empty means consistent. The cloud signs only a consistent
 * job, and a runner refuses an inconsistent one before it uses either text.
 */
export function jobDigestMismatches(job: Pick<Job, "task" | "role_card">): Array<"task.prompt_sha256" | "role_card.sha256"> {
  const bad: Array<"task.prompt_sha256" | "role_card.sha256"> = [];
  if (sha256Text(job.task.prompt) !== job.task.prompt_sha256) bad.push("task.prompt_sha256");
  if (sha256Text(job.role_card.text) !== job.role_card.sha256) bad.push("role_card.sha256");
  return bad;
}
