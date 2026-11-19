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
export const ENGINE_STOP_REASONS = ["person", "halt", "move", "remove"] as const;
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
    job("engine_session_start", strict({ at_sha: z.string().regex(SHA40_PATTERN), resume: z.boolean() })),
    job("engine_session_stop", strict({ reason: z.enum(ENGINE_STOP_REASONS) })),
    job("engine_session_delete", strict({})),
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

/**
 * The body of `POST /api/runner/setup/:setup_id/progress`. Closed. `state` takes the engine's coldstart states, `skipped` included. `sub_step` is a short lowercase name; the set of names is closed by
 * the row that owns the setup state machine, not here. `failure_code` is a coldstart code, with `missing_topic:<id>` for a missing topic.
 */
export const SETUP_SUB_STEP_PATTERN = /^[a-z][a-z_]{0,31}$/;
export const SetupProgressBody = strict({
  seq: safeInt.min(0),
  sub_step: z.string().regex(SETUP_SUB_STEP_PATTERN),
  state: ColdstartState,
  failure_code: ColdstartCode.optional(),
  bundle_bytes: z.number().int().min(0).max(2_147_483_647).optional(),
}).superRefine((body, ctx) => {
  // A failed step names its code; a skipped one may (`cloud_owned`); a started or ok one names none.
  if ((body.state === "failed" && body.failure_code === undefined) || ((body.state === "started" || body.state === "ok") && body.failure_code !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a failed step names its code and a started or ok one names none", path: ["failure_code"] });
});
export type SetupProgressBody = z.infer<typeof SetupProgressBody>;

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
