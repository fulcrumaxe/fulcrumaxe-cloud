/**
 * The job the cloud hands a runner. Every field is a bounded identifier, an enum, a digest, a number or a timestamp,
 * apart from three pieces of prose for the agent: `spec.text`, `task.prompt` and `role_card.text` (and, since D#601 MEM-3b, the two bounded `memory` strings). No field can carry a
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
import { CONTEXT_WINDOW_MAX_TOKENS } from "./contextLevers.js";
import { CONTEXT_SPILL_CODES, CONTEXT_SPILL_MAX_TOTAL_BYTES } from "./contextSpill.js";
import { MAX_EXCLUDE_RULES, isRuleablePath } from "./excludeRules.js";
import { JobAllowancesSchema } from "./sandboxAllowances.js";

/** Largest `spec.text`, in characters. It matches the cap on a request body. */
export const MAX_SPEC_TEXT_CHARS = 256 * 1024;
/** Largest `task.prompt` and `role_card.text`, in characters. */
export const MAX_TASK_PROMPT_CHARS = 128 * 1024;
export const MAX_ROLE_CARD_CHARS = 64 * 1024;
/**
 * D#601 MEM-3b: the most bytes either memory string of a job may hold. It is the largest memory slot a repository may choose (the pipeline's
 * `MEMORY_SLOT_MAX_BYTES`, checked equal by a test), and the person and fenced parts together are one slot, so each is within it.
 */
export const MAX_JOB_MEMORY_BYTES = 8192;

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

/**
 * D#6 C43-2a: the slot class of a job. The class comes from the job's signed role, so no new signed field exists. The runner and
 * the cloud both read this one table. Heavy jobs build and run full test suites; every other runner-eligible role is light.
 */
export const JOB_CLASSES = ["light", "heavy"] as const;
export type JobClass = (typeof JOB_CLASSES)[number];
export const JOB_CLASS_BY_ROLE: Readonly<Record<(typeof RUNNER_ELIGIBLE_ROLES)[number], JobClass>> = {
  executor: "heavy",
  "acceptance-tester": "heavy",
  "project-manager": "light",
  "technical-architect": "light",
  "product-owner": "light",
  "cost-analyst": "light",
  "performance-expert": "light",
  "security-expert": "light",
  "docs-writer": "light",
  "accessibility-reviewer": "light",
  "code-reviewer": "light",
  "security-reviewer": "light",
  debater: "light",
};
/** The runner-eligible roles of the light class; any other role (an unknown one included) is heavy, so the cloud's SQL can say `role = ANY(...)` for light and `NOT` for heavy. */
export const LIGHT_JOB_ROLES: readonly string[] = RUNNER_ELIGIBLE_ROLES.filter((role) => JOB_CLASS_BY_ROLE[role] === "light");
/** A role missing from the table counts as heavy, the scarcer slot (fail closed). */
export const jobClassOfRole = (role: string): JobClass => (Object.hasOwn(JOB_CLASS_BY_ROLE, role) ? JOB_CLASS_BY_ROLE[role as keyof typeof JOB_CLASS_BY_ROLE] : "heavy");

export const JOB_MODES =["local", "verified"] as const;

/** What the run is for. Closed. The runner picks its tools from the role, never from this. */
export const TASK_KINDS = ["implement", "fix", "review", "advise"] as const;
export const TaskKind = z.enum(TASK_KINDS);

const uuid = z.string().uuid();
const memoryText = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_JOB_MEMORY_BYTES, { message: `a memory string is at most ${MAX_JOB_MEMORY_BYTES} bytes` });
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A Claude Code session id: a bounded identifier. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** A branch name: bounded segments, no "..". */
const branchName = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .max(200)
  .refine((value) => !value.includes(".."));

/**
 * D#599 PL-2b: the one extra branch a continuation may push to besides a run branch: the item's own pull request head, `fx/issue-<n>`. `n` is
 * the item's issue number (1 to 10 digits, no leading zero). The pattern is exported once and every check that widens a branch rule imports
 * it: no copy, no prefix, no wildcard.
 */
export const ITEM_PR_BRANCH = /^fx\/issue-[1-9][0-9]{0,9}$/;

/**
 * The shape of every branch a runner run pushes, and so of every branch a continuation may continue: `fx/<run id>-g<lease generation>`, the
 * generation a positive integer of at most nine places. The one copy: the schema below, the job issuer, `done` and the verdict writer all import it.
 */
export const RUNNER_RUN_BRANCH = /^fx\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-g[1-9][0-9]{0,8}$/;

/** The largest value of a Postgres `integer`; a pull request number in a job stays inside it. */
const PR_NUMBER_MAX = 2_147_483_647;

/**
 * `continues`: the earlier run a fix round carries on from, and the one branch it works on.
 *  - `session_id` is null when no session is claimed: a round on the other side of a hand-over never claims to continue a session it did not run.
 *  - `pr_number` is present if and only if `branch` is an item pull request branch (`ITEM_PR_BRANCH`); the cloud binds it to the item's open pull
 *    request at issue time. An item pull request branch with a session id is refused.
 */
const ContinuesSchema = z
  .object({
    parent_run_id: uuid,
    session_id: z.string().regex(SESSION_ID_PATTERN).nullable(),
    branch: branchName,
    pr_number: z.number().int().min(1).max(PR_NUMBER_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The branch is one of exactly two shapes, whether or not a pull request number is present: a run branch or the item's pull request branch.
    if (!RUNNER_RUN_BRANCH.test(value.branch) && !ITEM_PR_BRANCH.test(value.branch)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a continuation branch is a run branch or an item pull request branch", path: ["branch"] });
    const itemBranch = ITEM_PR_BRANCH.test(value.branch);
    if (itemBranch !== (value.pr_number !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pr_number is present exactly when the branch is an item pull request branch", path: ["pr_number"] });
    if (itemBranch && value.session_id !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a foreign session is never claimed on an item pull request branch", path: ["session_id"] });
  });

/** SHA-256 of a string's UTF-8 bytes, lowercase hex: the digest `task.prompt_sha256` and `role_card.sha256` hold. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** D#601 MEM-3b: the memory a job carries, both strings within `MAX_JOB_MEMORY_BYTES`, no other key. */
export const JobMemorySchema = z.object({ person: memoryText, fenced: memoryText }).strict();
export type JobMemory = z.infer<typeof JobMemorySchema>;

/**
 * D#600 CX-5c: the repository paths and globs kept out of the run's context. Only the paths and globs as the person saved them: never file text and never pin content.
 * At least one (an empty list is omitted, not sent), at most `MAX_EXCLUDE_RULES`, each a path `isRuleablePath` accepts, none twice. The runner turns each into the
 * same deny entries the cloud's sandbox writes (`excludeDenyRules`).
 */
export const JobExcludesSchema = z
  .array(z.string().refine(isRuleablePath, { message: "an excluded path must be repository-relative and free of control characters, backslashes and . or .. segments" }))
  .min(1)
  .max(MAX_EXCLUDE_RULES)
  .refine((paths) => new Set(paths).size === paths.length, { message: "an excluded path appears once" });
export type JobExcludes = z.infer<typeof JobExcludesSchema>;

/**
 * D#600 CX-4b: the full text a cut prompt points at, one entry per closed section code (`CONTEXT_SPILL_CODES`), so no key and no code can name a path. At least one (an empty list is omitted),
 * each text non-empty and the texts together within `CONTEXT_SPILL_MAX_TOTAL_BYTES`. This is cloud-assembled text going down to the runner; nothing of it comes back up.
 */
export const JobSpillSchema = z
  .array(z.object({ code: z.enum(CONTEXT_SPILL_CODES), text: z.string().min(1).max(CONTEXT_SPILL_MAX_TOTAL_BYTES) }).strict())
  .min(1)
  .max(CONTEXT_SPILL_CODES.length)
  .superRefine((files, ctx) => {
    if (new Set(files.map((f) => f.code)).size !== files.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a spill code appears once" });
    if (files.reduce((n, f) => n + Buffer.byteLength(f.text, "utf8"), 0) > CONTEXT_SPILL_MAX_TOTAL_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the spill texts are at most ${CONTEXT_SPILL_MAX_TOTAL_BYTES} bytes together` });
  });
export type JobSpill = z.infer<typeof JobSpillSchema>;

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
    continues: ContinuesSchema.nullable(),
    // D#6 R4d-4 (C33): present exactly on a review-role job (REVIEW_JOB_ROLES), omitted (never null) on every other job so their canonical JSON
    // and signature are unchanged. The signature covers it. 40 or 64 lowercase hex, the commit under review.
    review: z.object({ head_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict().optional(),
    // D#6 R7a (C35): the repo's admin-approved sandbox allowances, present only when the approved set has entries and omitted (never null or empty)
    // on every other job, so their canonical JSON and signature are unchanged. The signature covers it. The runner floor-checks it (R7b).
    sandbox_allowances: JobAllowancesSchema.optional(),
    // D#605 FL-4: the sandbox engine this job cannot run without, present only on a job that needs a microVM and omitted (never null) on every
    // other job, so their canonical JSON and signature are unchanged. The cloud's claim hands such a job only to a runner whose reported engine
    // is `microvm`, whatever the person's routing says. Set by the cloud when it signs the job; no person-set rule can write or clear it.
    requires_engine: z.literal("microvm").optional(),
    // D#601 MEM-3b: the memory the cloud recalled for this run, split by who wrote it. `person` holds approved entries a person wrote (the runner places them after the
    // role card, sanitised and labelled); `fenced` holds the ones an agent, an import or a runner wrote (the runner puts them in their own untrusted block). Present only on a
    // job that recalled something and omitted (never null) on every other job, so their canonical JSON and signature are unchanged; the signature covers it. The cloud signs it
    // only for a runner of `MEMORY_JOB_MIN_PROTOCOL` or later (an older runner's strict parse would refuse it). The runner writes none of it to disk.
    memory: JobMemorySchema.optional(),
    // D#600 CX-5c: the paths and globs kept out of this run's context, read from the item's rules when the job is issued. Present only on a job that has excludes and omitted (never null,
    // never empty) on every other job, so their canonical JSON and signature are unchanged; the signature covers it. The cloud signs it only for a runner of `EXCLUDES_JOB_MIN_PROTOCOL` or
    // later: an older runner's strict parse would refuse the key, and a runner that started without the list would run the agent with nothing denied. Pin content is never here.
    excludes: JobExcludesSchema.optional(),
    // D#600 CX-4b: the full text of what this run's prompt cut, written by the runner under its own spill root before the agent starts. Present only on a job whose prompt carries a trimmed marker and omitted
    // (never null, never empty) on every other job, so their canonical JSON and signature are unchanged; the signature covers it. The cloud signs it only for a runner of `SPILL_JOB_MIN_PROTOCOL` or later. It is
    // text for the agent to read, never a path: the runner builds every path itself from the closed code.
    spill: JobSpillSchema.optional(),
    // D#600 CX-6b: the model's context window in tokens, from the price table, so the local runner can tell how full the agent's context is (the figure is private plan data, so it comes down from
    // the cloud). Omitted (never null) when the model has no figure: the runner then says nothing about context. The signature covers it. The cloud signs it only for a runner of
    // `CONTEXT_WINDOW_JOB_MIN_PROTOCOL` or later: an older runner's strict parse would refuse the key.
    context_window: z.number().int().min(1).max(CONTEXT_WINDOW_MAX_TOKENS).optional(),
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
