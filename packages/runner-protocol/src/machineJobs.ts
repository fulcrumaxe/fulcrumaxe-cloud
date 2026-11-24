/**
 * D#845 ON-1: signed machine jobs, the work the cloud asks of a person's own machine to set a project up, update it, run an engine session and remove it. A machine job is not a run job:
 * it has no lease, no model call of its own and no run row, so the run-job schema (job.ts) is not widened. It is signed with the job signer's key and `key_id` scheme over `canonicalJson`,
 * and a signed job binds to one runner (`runner_id`), one repo (`repo_gh_id`) and a life of at most 30 minutes. A runner checks the signature, the runner, the expiry and the closed `args`
 * of its kind before it touches anything. Every shape is strict at every depth.
 * Which runner is offered which job is decided by `machineJobOffered` (and the other `*Offered` functions below), which the claim path reads: the capability on the runner's latest hello, the
 * protocol version and, for a microVM job, the machine's sandbox engine. None of them widens a permission; each only narrows what a runner is offered.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { SHA40_PATTERN, ENGINE_VERSION_PATTERN } from "./engineEvents.js";
import { canonicalJson, JobSignatureError, type JobKeyring } from "./jobSignature.js";
import { DEVICE_REGISTER_CAPABILITY, ENGINE_SESSION_CAPABILITY, MACHINE_LOGIN_CAPABILITY, PROJECT_SETUP_CAPABILITY, TASK_KIND_CAPABILITY, type RunnerCapability, type TASK_KINDS } from "./job.js";
import { MACHINE_ONBOARDING_MIN_PROTOCOL } from "./messages.js";
import { ColdstartCode, ColdstartState } from "./coldstartStatus.js";

const safeInt = z.number().int().safe();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const MACHINE_JOB_KINDS = ["project_setup", "engine_update", "engine_session_start", "engine_session_stop", "engine_session_delete", "project_remove"] as const;
export type MachineJobKind = (typeof MACHINE_JOB_KINDS)[number];
/** The longest a machine job lives after it was issued, in seconds. */
export const MACHINE_JOB_MAX_LIFE_S = 1800;
/** How far ahead of the verifier's clock `issued_at` may be, in seconds. */
export const MACHINE_JOB_MAX_CLOCK_SKEW_S = 60;
/** The only hosts an engine tarball may be fetched from. */
export const ENGINE_TARBALL_HOSTS = ["codeload.github.com", "github.com"] as const;
export const ENGINE_STOP_REASONS = ["person", "halt", "move", "remove", "operate_off", "plan"] as const; // MC-6a1 still adds "park"
export const MACHINE_ENGINE_REQUIREMENTS = ["microvm", "any"] as const;
export const SETUP_MODES = ["pr", "direct"] as const;
/** The install and update branches: `fx/engine-install-<version>` and `fx/engine-update-<version>`, the version digits and dots only. */
export const ENGINE_INSTALL_BRANCH = /^fx\/engine-install-[0-9.]{5,20}$/;
export const ENGINE_UPDATE_BRANCH = /^fx\/engine-update-[0-9.]{5,20}$/;

/** An https URL on an allowed host: no credentials, no port, no query, no fragment, and a plain path with no `..`. */
export function isEngineTarballUrl(value: string): boolean {
  if (value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch { // fx-swallow-ok: a string that is not a URL is simply not a tarball URL
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") return false;
  if (!(ENGINE_TARBALL_HOSTS as readonly string[]).includes(url.hostname)) return false;
  return /^\/[A-Za-z0-9._/-]{1,250}$/.test(url.pathname) && !url.pathname.includes("..") && url.href === value;
}

const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
export const EngineReleaseRef = strict({
  version: z.string().regex(ENGINE_VERSION_PATTERN),
  commit_sha: z.string().regex(SHA40_PATTERN),
  tarball_url: z.string().refine(isEngineTarballUrl, { message: "the tarball is not on an allowed host" }),
  tarball_sha256: sha256Hex,
});
export const PlanRef = strict({ draft_id: z.string().uuid(), version: safeInt.min(1), sha256: sha256Hex });

const BASE = {
  v: z.literal(1),
  job_id: z.string().uuid(),
  runner_id: z.string().uuid(),
  repo_gh_id: safeInt.min(1),
  setup_id: z.string().uuid().optional(),
  requires_engine: z.enum(MACHINE_ENGINE_REQUIREMENTS),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
};
const job = <K extends MachineJobKind, A extends z.ZodTypeAny>(kind: K, args: A) => strict({ ...BASE, kind: z.literal(kind), args });

/** One machine job. `args` belongs to its `kind` and nothing else's. */
export const MachineJob = z
  .discriminatedUnion("kind", [
    job("project_setup", strict({ mode: z.enum(SETUP_MODES), base_sha: z.string().regex(SHA40_PATTERN), engine: EngineReleaseRef, plan_ref: PlanRef, branch: z.string().regex(ENGINE_INSTALL_BRANCH) })),
    job("engine_update", strict({ engine: EngineReleaseRef, branch: z.string().regex(ENGINE_UPDATE_BRANCH) })),
    // Every session kind carries the operate epoch the cloud read when it issued the job (a start is never signed at 0: the first on-switch makes 1).
    job("engine_session_start", strict({ at_sha: z.string().regex(SHA40_PATTERN), resume: z.boolean(), operate_epoch: safeInt.min(1) })),
    job("engine_session_stop", strict({ reason: z.enum(ENGINE_STOP_REASONS), operate_epoch: safeInt.min(0) })),
    job("engine_session_delete", strict({ operate_epoch: safeInt.min(0) })),
    job("project_remove", strict({ delete_sandbox: z.boolean(), removal_pr: z.boolean() })),
  ])
  .superRefine((j, ctx) => {
    const life = Date.parse(j.expires_at) - Date.parse(j.issued_at);
    if (!(life > 0 && life <= MACHINE_JOB_MAX_LIFE_S * 1000)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a machine job lives 1 ms to 30 min", path: ["expires_at"] });
  });
export type MachineJob = z.infer<typeof MachineJob>;
export type MachineJobOf<K extends MachineJobKind> = Extract<MachineJob, { kind: K }>;

/** A job with its signature over `canonicalJson(job)`; `key_id` only picks which trusted key to check it with. */
export const SignedMachineJob = strict({ job: MachineJob, key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type SignedMachineJob = z.infer<typeof SignedMachineJob>;

/** Signs `jobToSign` with the cloud's signing key. `key_id` must name that key. */
export function signMachineJob(jobToSign: MachineJob, keyId: string, privateKey: KeyObject): SignedMachineJob {
  const parsed = MachineJob.parse(jobToSign);
  return SignedMachineJob.parse({ job: parsed, key_id: keyId, signature: sign(null, Buffer.from(canonicalJson(parsed), "utf8"), privateKey).toString("base64url") });
}

/**
 * Verifies a signed machine job for the runner `runnerId` and returns it. Throws `JobSignatureError` and nothing else: `bad_signature` for any change to the signed bytes or a job signed for
 * another runner, `malformed` for a shape outside the closed schema (an extra key, a bad branch or host, a life over 30 minutes), `expired` once `expires_at` has passed or when `issued_at` is
 * too far ahead of `now`.
 */
export function verifyMachineJob(signed: unknown, keyring: JobKeyring, runnerId: string, now: Date = new Date()): MachineJob {
  try {
    if (typeof signed !== "object" || signed === null || Array.isArray(signed)) throw new JobSignatureError("malformed", "the signed job is not an object");
    const record = signed as Record<string, unknown>;
    if (record["signature"] === undefined || record["signature"] === null || record["signature"] === "") throw new JobSignatureError("missing_signature", "the job carries no signature");
    const parsed = SignedMachineJob.safeParse(signed);
    if (!parsed.success) throw new JobSignatureError("malformed", "the job does not match the machine job schema");
    const { job: machineJob, key_id, signature } = parsed.data;
    const entry = Object.hasOwn(keyring, key_id) ? keyring[key_id] : undefined;
    if (entry === undefined) throw new JobSignatureError("unknown_key_id", "the job names a key this runner does not trust");
    const publicKey = typeof (entry as KeyObject).export === "function" ? (entry as KeyObject) : createPublicKey({ key: entry as { kty: "OKP"; crv: "Ed25519"; x: string }, format: "jwk" });
    if (!verify(null, Buffer.from(canonicalJson(machineJob), "utf8"), publicKey, Buffer.from(signature, "base64url"))) throw new JobSignatureError("bad_signature", "the signature does not match the job");
    if (machineJob.runner_id.toLowerCase() !== runnerId.toLowerCase()) throw new JobSignatureError("bad_signature", "the job was signed for another runner");
    if (Date.parse(machineJob.expires_at) <= now.getTime()) throw new JobSignatureError("expired", "the job has expired");
    if (Date.parse(machineJob.issued_at) > now.getTime() + MACHINE_JOB_MAX_CLOCK_SKEW_S * 1000) throw new JobSignatureError("expired", "the job was issued in the future");
    return machineJob;
  } catch (error) {
    if (error instanceof JobSignatureError) throw error;
    throw new JobSignatureError("malformed", "the signed job could not be checked");
  }
}

/** The runner's own VM job codes (fx-runner's `VM_JOB_CODES`, pinned equal by a test there): a setup fails with one when its sandbox could not be made. */
export const SETUP_VM_JOB_CODES = ["vm_admission_refused", "vm_boot_failed", "vm_egress_unavailable", "vm_token_delivery_failed", "vm_workspace_failed", "vm_teardown_incomplete"] as const;
/** What a setup may fail with besides the engine's own coldstart codes: a closed list of the runner's and the cloud's steps. */
export const SETUP_FAILURE_CODES = [
  "engine_fetch_failed", "engine_checksum", "engine_archive_refused", "plan_fetch_failed", "plan_checksum", "plan_invalid", "setup_status_refused", "bootstrap_failed", "finalize_failed",
  "bundle_refused", "push_failed", "direct_raced", "pr_open_failed", "install_head_changed", "pr_scope_refused", "labels_failed", "kind_unsupported", "job_expired", "job_silent", "job_overran", "engine_unsupported", ...SETUP_VM_JOB_CODES,
] as const;
/** The runner's own steps. None reuses a coldstart name (`bundle_out` is not `bundle`, `gh_labels` is not `labels`). */
export const SETUP_RUNNER_STEPS = ["engine_fetch", "plan_fetch", "sandbox_boot", "workspace_in", "bootstrap", "finalize", "bundle_out", "push", "pr_open", "gh_labels"] as const;
export type SetupRunnerStep = (typeof SETUP_RUNNER_STEPS)[number];
/** The step whose `ok` report ends a job of that kind `done` (and frees the runner's slot). A kind with no entry is never ended by a step report. */
export const MACHINE_JOB_FINAL_STEP: Partial<Record<MachineJobKind, SetupRunnerStep>> = { project_setup: "gh_labels" };
/** Every sub-step a progress report may name: the runner's steps and the engine's eight coldstart steps. Closed. */
export const SETUP_SUB_STEPS = ["engine_fetch", "plan_fetch", "sandbox_boot", "workspace_in", "bootstrap", "preflight", "interview", "wiring", "deps", "labels", "sandbox_hook", "bundle", "done", "finalize", "bundle_out", "push", "pr_open", "gh_labels"] as const;
export const SETUP_FAILURE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The body of `POST /api/runner/setup/:setup_id/progress`. Closed. `job_id` names the machine job the report belongs to, so a late report from an earlier attempt is told from the current one. `state` takes
 * the engine's coldstart states, `skipped` included. `failure_code` is a coldstart code (`missing_topic:<id>` carries its topic) or one of `SETUP_FAILURE_CODES`; `failure_reason` is one closed word that
 * refines a code (`bundle_refused` with `workflow`), never free text.
 */
export const SetupProgressBody = strict({
  job_id: z.string().uuid(),
  seq: safeInt.min(0),
  sub_step: z.enum(SETUP_SUB_STEPS),
  state: ColdstartState,
  failure_code: z.union([ColdstartCode, z.enum(SETUP_FAILURE_CODES)]).optional(),
  failure_reason: z.string().regex(SETUP_FAILURE_REASON_PATTERN).optional(),
  bundle_bytes: z.number().int().min(0).max(2_147_483_647).optional(),
  /** D#845 Ruling 73: the commit the runner pushed. Only on the `push` step reported `ok`; the cloud keeps it as `install_head_sha`. */
  head_sha: z.string().regex(SHA40_PATTERN).optional(),
}).superRefine((body, ctx) => {
  if (body.head_sha !== undefined && !(body.sub_step === "push" && body.state === "ok")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a head is reported with the push step ok and nowhere else", path: ["head_sha"] });
  // A failed step names its code; a skipped one may (`cloud_owned`); a started or ok one names none. A reason needs a code, and a code that already carries its topic takes none.
  if ((body.state === "failed" && body.failure_code === undefined) || ((body.state === "started" || body.state === "ok") && body.failure_code !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a failed step names its code and a started or ok one names none", path: ["failure_code"] });
  if (body.failure_reason !== undefined && (body.failure_code === undefined || body.failure_code.includes(":"))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a reason needs a code that has no topic", path: ["failure_reason"] });
});
export type SetupProgressBody = z.infer<typeof SetupProgressBody>;
export const SetupProgressReply = strict({ recorded: z.literal(true) });

/**
 * D#845 ON-13a0: the report of a session job (`engine_session_start`, `_stop`, `_delete`), keyed by the signed `job_id` in the path and not by a setup. A session job has no setup row, so the setup route's fence does not
 * apply; the definer `machine_job_progress_record` (migration 1066) holds its own. The runner reports a kind's steps in `SESSION_JOB_STEP_ORDER` (it may skip one, never go back); the definer refuses a step outside the kind's list.
 */
export const SESSION_JOB_KINDS = ["engine_session_start", "engine_session_stop", "engine_session_delete"] as const;
export type SessionJobKind = (typeof SESSION_JOB_KINDS)[number];
export const SESSION_JOB_STEPS = ["admission", "session_create", "seed", "session_boot", "credentials", "supervisor", "session_stop", "snapshot", "session_delete", "done"] as const;
export type SessionJobStep = (typeof SESSION_JOB_STEPS)[number];
export const SESSION_JOB_STEP_ORDER = {
  engine_session_start: ["admission", "session_create", "seed", "session_boot", "credentials", "supervisor", "done"],
  engine_session_stop: ["admission", "session_stop", "snapshot", "done"],
  engine_session_delete: ["admission", "session_delete", "done"],
} as const satisfies Record<SessionJobKind, readonly SessionJobStep[]>;
/** How a start came up: `created` (no resume asked), `resumed` (the kept disk) or `fresh` (a resume was asked, but the sandbox or its disk was gone, so the runner seeded again). */
export const SESSION_START_MODES = ["created", "resumed", "fresh"] as const;
export const SESSION_FAILURE_CODES = ["machine_single_project", "vm_memory_low", "operate_stale", "snapshot_failed", "kind_unsupported", "engine_unsupported", ...SETUP_VM_JOB_CODES] as const;
/** The three codes the cloud alone writes onto a job that went quiet; the runner never reports them. */
export const SESSION_CLOUD_FAILURE_CODES = ["job_expired", "job_silent", "job_overran"] as const;
export const SessionJobProgressBody = strict({
  seq: safeInt.min(0),
  step: z.enum(SESSION_JOB_STEPS),
  state: z.enum(["started", "ok", "failed", "skipped"]),
  failure_code: z.enum(SESSION_FAILURE_CODES).optional(),
  failure_reason: z.string().regex(SETUP_FAILURE_REASON_PATTERN).optional(),
  start_mode: z.enum(SESSION_START_MODES).optional(),
}).superRefine((body, ctx) => {
  // A failed step names its code and no other does; a reason needs a code. A start's mode rides on its `done` `ok` and nowhere else (the definer, which knows the kind, requires it there and refuses it on a stop or a delete).
  if ((body.state === "failed") !== (body.failure_code !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a failed step names its code and no other step does", path: ["failure_code"] });
  if (body.failure_reason !== undefined && body.failure_code === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a reason needs a code", path: ["failure_reason"] });
  if (body.start_mode !== undefined && !(body.step === "done" && body.state === "ok")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a start mode rides on the done step's ok report only", path: ["start_mode"] });
});
export type SessionJobProgressBody = z.infer<typeof SessionJobProgressBody>;
export const machineJobProgressPath = (jobId: string): string => `/api/runner/machine-job/${jobId}/progress`;

/**
 * D#845 ON-8f: the empty-tree commit a direct-mode setup starts from (the default branch has no commit yet). Its bytes are fixed (an empty tree, one fixed identity, epoch date), so every runner makes the same id.
 * The runner writes it into its own scratch repository with `hash-object -t commit -w` and never pushes it.
 */
export const EMPTY_BASE_COMMIT_TEXT = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor fulcrumaxe <runner@localhost> 0 +0000\ncommitter fulcrumaxe <runner@localhost> 0 +0000\n\nEmpty base\n";
export const EMPTY_BASE_COMMIT = "39800c809d73fe8ac54ad2ae55ad4dac1c8d98cb";

/** D#845 ON-8f: where the runner asks for its one push credential for a setup's job. Once per attempt, only after it reported the `push` step started. */
export const setupPushTokenPath = (setupId: string): string => `/api/runner/setup/${setupId}/push-token`;
export const SetupPushTokenMessage = strict({ job_id: z.string().uuid() });
/** One installation token for the one repository, `contents: write` and `metadata: read` only. It never enters a guest and is revoked by the runner after the push. */
export const SetupPushTokenReply = strict({ token: z.string().min(1).max(512), expires_at: z.string().datetime() });
export type SetupPushTokenReply = z.infer<typeof SetupPushTokenReply>;

/** D#845 ON-8a: where a runner told `machine_job: true` on a claim reply takes its one job, and where it reports on a setup. */
export const MACHINE_JOB_CLAIM_PATH = "/api/runner/machine-job/claim";
export const setupProgressPath = (setupId: string): string => `/api/runner/setup/${setupId}/progress`;
export const MachineJobClaimMessage = strict({});
/** One signed job, handed over once, or nothing for this runner now. */
export const MachineJobClaimReply = z.union([strict({ signed_job: SignedMachineJob }), strict({ retry_after: safeInt.min(1).max(3600) })]);
export type MachineJobClaimReply = z.infer<typeof MachineJobClaimReply>;

/** The capability each machine job kind needs on the runner's latest hello. */
export const MACHINE_JOB_CAPABILITY: Readonly<Record<MachineJobKind, RunnerCapability>> = Object.freeze({
  project_setup: PROJECT_SETUP_CAPABILITY,
  engine_update: PROJECT_SETUP_CAPABILITY,
  project_remove: PROJECT_SETUP_CAPABILITY,
  engine_session_start: ENGINE_SESSION_CAPABILITY,
  engine_session_stop: ENGINE_SESSION_CAPABILITY,
  engine_session_delete: ENGINE_SESSION_CAPABILITY,
});

/** What the claim knows about a runner when it decides what to offer: its stored protocol version, the capabilities of its latest hello and the sandbox engine of its facts (absent when it sent none). */
export interface RunnerOffer {
  protocol_version: number;
  capabilities: readonly string[];
  sandbox_engine?: "os_sandbox" | "microvm" | undefined;
}
const hasCapability = (runner: RunnerOffer, capability: RunnerCapability): boolean => runner.protocol_version >= MACHINE_ONBOARDING_MIN_PROTOCOL && runner.capabilities.includes(capability);

/**
 * True when a runner may be offered a machine job of this kind: it is at protocol 22 or later, listed the kind's capability, and, for a job that requires a microVM, reported a microVM engine
 * (D#605's claim gate: a runner with no facts, or with `os_sandbox`, is never given one). Fails closed.
 */
export function machineJobOffered(kind: MachineJobKind, requiresEngine: (typeof MACHINE_ENGINE_REQUIREMENTS)[number], runner: RunnerOffer): boolean {
  if (!hasCapability(runner, MACHINE_JOB_CAPABILITY[kind])) return false;
  return requiresEngine === "any" || runner.sandbox_engine === "microvm";
}
/** True when a runner may be offered a task of this kind: kinds that need no capability are always offered; `survey` needs protocol 22 and `survey_v1`. */
export function taskKindOffered(kind: (typeof TASK_KINDS)[number], runner: RunnerOffer): boolean {
  const capability = TASK_KIND_CAPABILITY[kind];
  return capability === undefined || hasCapability(runner, capability);
}
/** True when a runner may be sent a Claude sign-in command (machineCommands.ts). */
export function loginCommandOffered(runner: RunnerOffer): boolean {
  return hasCapability(runner, MACHINE_LOGIN_CAPABILITY);
}
/** True when a runner may use the device flow (its shapes arrive with the rows that build it). */
export function deviceFlowOffered(runner: RunnerOffer): boolean {
  return hasCapability(runner, DEVICE_REGISTER_CAPABILITY);
}
