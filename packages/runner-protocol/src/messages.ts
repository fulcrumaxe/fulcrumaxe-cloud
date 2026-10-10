/**
 * The messages a runner sends to the cloud. Every schema is strict, and none has a field that could carry a
 * credential (test/messages.test.ts walks every schema). The fields are the smallest set the protocol needs; a later
 * change may add a field but never remove or rename one.
 */
import { z } from "zod";
import { MAX_ENVELOPE_INPUT_BYTES } from "./envelope.js";
import { SESSION_ID_PATTERN } from "./job.js";

/** The isolation tiers a runner can report. Display only. There is no "none". */
export const ISOLATION_TIERS = ["microvm", "vm_container", "container", "host_sandbox"] as const;
export const IsolationTier = z.enum(ISOLATION_TIERS);
export type IsolationTier = z.infer<typeof IsolationTier>;

/** Where the model credential lives. A mode, never a secret. */
export const CREDENTIAL_MODES = ["subscription", "api_key"] as const;
export const CredentialMode = z.enum(CREDENTIAL_MODES);
export type CredentialMode = z.infer<typeof CredentialMode>;

const uuid = z.string().uuid();
/** Every integer on the wire is a safe integer, so arithmetic on it is exact. */
const safeInt = z.number().int().safe();
/** The most tokens one `usage` event may carry; the database function that adds them refuses more (migration 0768). */
export const USAGE_TOKENS_MAX = 1_000_000_000_000;
const leaseGeneration = safeInt.min(0);

/** An Ed25519 public key as a JWK (RFC 8037). Strict parsing refuses the private member `d`. */
export const Ed25519PublicJwk = z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type Ed25519PublicJwk = z.infer<typeof Ed25519PublicJwk>;

/** At most this many events travel in one `events` message. */
export const MAX_EVENTS_PER_BATCH = 100;

/** What a runner may say about its progress: metadata only, with no field for model text, tool output or file content. */
export const LOCAL_ONLY_EVENT_TYPES = ["tool_use", "file_changed", "command_exit", "usage", "usage_limit_reached", "credential_mismatch", "engine_version", "run_ended", "taken_over", "stage"] as const;

/**
 * D#6 C42-1 (additive under C8 section 6; the cloud first): what a `tool_use` may say about itself beyond the tool's name, the same coarse
 * record a sandbox run keeps. `path` is repo-relative, `pattern` a short search term, `command` a shell command's first line. The runner
 * sends a command only when it holds nothing that looks like a credential, and the cloud checks it again before it stores anything.
 */
export const ACTIVITY_TOOLS = ["read", "list", "search", "test", "command"] as const;
export const ACTIVITY_LIMITS = { maxPathChars: 90, maxPatternChars: 40, maxCommandChars: 200 } as const;
const printable = /^[^\u0000-\u001f\u007f]+$/;
export const ActivityField = z
  .object({
    tool: z.enum(ACTIVITY_TOOLS),
    path: z.string().min(1).max(ACTIVITY_LIMITS.maxPathChars).regex(printable).optional(),
    pattern: z.string().min(1).max(ACTIVITY_LIMITS.maxPatternChars).regex(printable).optional(),
    command: z.string().min(1).max(ACTIVITY_LIMITS.maxCommandChars).regex(printable).optional(),
  })
  .strict();
export type ActivityField = z.infer<typeof ActivityField>;

/** D#6 C42-1: the stages a runner marks, once each per run. `workspace_ready` is stored as the sandbox runs' `sandbox_ready`. D#6 C44-4: `deps_installed` and `deps_install_failed` are the closed outcomes of the host-side dependency install, at most one of them per run. */
export const RUNNER_STAGES = ["workspace_ready", "cloned", "deps_installed", "deps_install_failed", "writing_result"] as const;
export const RunnerStage = z.enum(RUNNER_STAGES);
export type RunnerStage = z.infer<typeof RunnerStage>;

/**
 * D#6 R4a-2 (correction C24 section 1; additive under C8 section 6): why the runner ended a run it refused or could not finish. A
 * closed set, and the only thing a `run_ended` event says: no job content, no error text. Each reason has a closed `detail` set
 * where C24 gives one, and none otherwise (`DETAILS_OF_RUN_ENDED` maps a reason to its set; an empty set means "no detail").
 */
export const RUN_ENDED_REASONS = ["job_refused", "repo_not_private", "agent_failed", "wall_clock", "runner_setup", "runner_shutdown", "push_rejected", "handed_off"] as const;
export const RunEndedReason = z.enum(RUN_ENDED_REASONS);
export type RunEndedReason = z.infer<typeof RunEndedReason>;

export const JOB_REFUSED_DETAILS = ["job_signature_invalid", "run_id_mismatch", "duplicate_job", "unknown_role", "task_prompt_hash_mismatch", "role_card_hash_mismatch", "role_tools_mismatch", "continues_wrong_role", "review_sha_missing", "review_wrong_role", "sandbox_allowance_forbidden"] as const;
export const RUNNER_SETUP_DETAILS = [
  "sandbox_unavailable",
  "claude_binary_missing",
  "claude_version_unsupported",
  "claude_flags_unsupported",
  "auth_missing",
  "bad_start_options",
  "no_init_line",
  "permission_mode_forced",
  // D#6 R4a-3b (C25 section 1.4): a fix round's branch was gone at prepare or before the push.
  "continuation_branch_missing",
  "other",
  // D#6 R5a-2b (C27 section 4.5; additive under C8 section 6): the cloud-verified path (path A) could not start or finish its pushes.
  // `push_too_large` is the only detail that comes with a `size_mb`.
  "git_proxy_unpinned",
  "git_ticket_refused",
  "path_a_no_mirror",
  "clone_limited",
  "push_too_large",
  "push_incomplete",
  // The job's `model_hint` is not a price-table id the runner can map to a CLI model name (see `cliModels.ts`). Refused before any process starts.
  "model_unsupported",
  // D#6 R4d-2 (C32 section 3; additive under C8 section 6): every code the daemon's git path can fail a run with used to be sent as `other`.
  // The cloud must accept these before a runner sends them (the event is strict, with an enum), so the cloud deploys first.
  "push_ref_refused",
  "snapshot_refused",
  "push_failed",
  "mirror_failed",
  "mirror_dir_insecure",
  "git_version_unsupported",
  "workspace_failed",
  "workspace_git_refused",
  "head_not_from_base",
  "sandbox_stub_committed",
  // D#6 R4d-4 (C33; additive under C8 section 6): the commit a review job names is not on any branch of the runner's copy of the repository. The cloud deploys first.
  "review_sha_not_in_mirror",
  // D#6 R5b-3 (C38 section 1; additive under C8 section 6): an api_key runner's key file is missing or unusable when a job starts. The cloud deploys first.
  "api_key_not_configured",
] as const;
/**
 * D#599 HO-1 (additive under C8 section 6; the cloud deploys first): how a handed-off run ended its side of the move. `pushed`: the
 * checkpoint's commit reached the run branch. `push_failed`: it did not, and the cloud continues from the branch head it reads itself.
 * `deadline`: the checkpoint did not finish in time. Fixed words only; the note travels in the existing checkpoint event, not here.
 */
export const HANDED_OFF_DETAILS = ["pushed", "push_failed", "deadline"] as const;
// `push_failed` is already a runner_setup code; the event's detail enum lists each word once.
export const RUN_ENDED_DETAILS = [...JOB_REFUSED_DETAILS, ...RUNNER_SETUP_DETAILS, "pushed", "deadline"] as const;
export type RunEndedDetail = (typeof RUN_ENDED_DETAILS)[number];

/** D#6 R5a-2b (C27 section 4.5): the size of the largest commit, in whole MB, rounded up. Over the proxy's 4 MB push limit, so it starts at 5. */
export const PUSH_TOO_LARGE_SIZE_MB = { min: 5, max: 10_000 } as const;

export const DETAILS_OF_RUN_ENDED: Record<RunEndedReason, readonly RunEndedDetail[]> = {
  job_refused: JOB_REFUSED_DETAILS,
  repo_not_private: [],
  agent_failed: [],
  wall_clock: [],
  runner_setup: RUNNER_SETUP_DETAILS,
  runner_shutdown: [],
  // D#6 R4a-3b (C25 section 1.4): the push to a fix round's branch was rejected because the branch moved while the agent worked. No detail.
  push_rejected: [],
  // D#599 HO-1: the run stopped at a checkpoint so the other side can continue it. See `HANDED_OFF_DETAILS`.
  handed_off: HANDED_OFF_DETAILS,
};

const TAKEN_OVER_FORBIDDEN = ["tool_name", "file_path", "exit_code", "duration_ms", "engine_version", "usage", "reset_at", "reason", "detail", "size_mb", "activity", "stage"] as const;

// D#599 HO-1: a handed-off `run_ended` is a reason and one fixed word, as `taken_over` is a timestamp. Every other event field is refused on it.
const HANDED_OFF_FORBIDDEN = ["tool_name", "file_path", "exit_code", "duration_ms", "engine_version", "usage", "reset_at", "size_mb", "activity", "stage"] as const;

const STAGE_FORBIDDEN = ["tool_name", "file_path", "exit_code", "duration_ms", "engine_version", "usage", "reset_at", "reason", "detail", "size_mb"] as const;

export const LocalOnlyEvent = z
  .object({
    seq: safeInt.min(0),
    ts: z.string().datetime(),
    type: z.enum(LOCAL_ONLY_EVENT_TYPES),
    tool_name: z.string().regex(/^[A-Za-z0-9_:.-]{1,64}$/).optional(),
    file_path: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
    exit_code: safeInt.optional(),
    duration_ms: safeInt.min(0).optional(),
    // The agent build that ran (a plain dotted version, so there is no room for anything else). Set on `engine_version` events.
    engine_version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/).optional(),
    // Display only; the cloud settles no money against it. `input` and `output` count model tokens (the name avoids
    // the word G1 reserves for credentials).
    // D#6 R2b-5a (C32 section 5.3; additive under C8 section 6, the cloud first): `cache_read` and `cache_write` are the cache token counts, which the CLI's `input` leaves out. An older runner sends neither.
    // `usd` is the runner's own figure; the cloud never stores or sums it and recomputes the API-equivalent from the token counts.
    usage: z
      .object({
        input: safeInt.min(0).max(USAGE_TOKENS_MAX).optional(),
        output: safeInt.min(0).max(USAGE_TOKENS_MAX).optional(),
        cache_read: safeInt.min(0).max(USAGE_TOKENS_MAX).optional(),
        cache_write: safeInt.min(0).max(USAGE_TOKENS_MAX).optional(),
        usd: z.number().min(0).finite().optional(),
      })
      .strict()
      .optional(),
    // D#6 R2b-3 (comment 27 item 7; additive under C8 section 6): when the plan's usage limit resets, on a `usage_limit_reached`
    // event only. Display data: the follow-up run becomes claimable from it, and a false value only affects the tenant that sent it.
    reset_at: z.string().datetime().optional(),
    // D#6 R4a-2 (C24 section 1), on a `run_ended` event only: why the run ended, and for two reasons which closed code. Neither holds job content.
    reason: RunEndedReason.optional(),
    detail: z.enum(RUN_ENDED_DETAILS).optional(),
    // D#6 R5a-2b (C27 section 4.5), on a `run_ended` event with detail `push_too_large` only: the largest commit's size in whole MB.
    size_mb: safeInt.min(PUSH_TOO_LARGE_SIZE_MB.min).max(PUSH_TOO_LARGE_SIZE_MB.max).optional(),
    // D#6 C42-1 (additive under C8 section 6): what a tool use did (`tool_use` only) and which stage a `stage` event marks (that type only).
    activity: ActivityField.optional(),
    stage: RunnerStage.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.activity !== undefined && event.type !== "tool_use") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "activity belongs to tool_use only", path: ["activity"] });
    if (event.type === "stage") {
      if (event.stage === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a stage event names its stage", path: ["stage"] });
      for (const field of STAGE_FORBIDDEN) if (event[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a stage event carries no field but seq, ts and stage", path: [field] });
    } else if (event.stage !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stage belongs to the stage event only", path: ["stage"] });
    if (event.size_mb !== undefined && !(event.type === "run_ended" && event.reason === "runner_setup" && event.detail === "push_too_large"))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "size_mb belongs to run_ended push_too_large only", path: ["size_mb"] });
    // D#6 R4a-7 (additive under C8 section 6): `taken_over` is a timestamp and nothing else. The owner took the run over on the machine; no other field fits.
    if (event.type === "taken_over") {
      for (const field of TAKEN_OVER_FORBIDDEN) if (event[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "taken_over carries no field but seq and ts", path: [field] });
    }
    if (event.reset_at !== undefined && event.type !== "usage_limit_reached") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reset_at belongs to usage_limit_reached only", path: ["reset_at"] });
    if (event.type !== "run_ended") {
      if (event.reason !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reason belongs to run_ended only", path: ["reason"] });
      if (event.detail !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "detail belongs to run_ended only", path: ["detail"] });
      return;
    }
    if (event.reason === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "run_ended names its reason", path: ["reason"] });
    else if (event.detail !== undefined && !DETAILS_OF_RUN_ENDED[event.reason].includes(event.detail)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "detail is not one of this reason's codes", path: ["detail"] });
    if (event.reason === "handed_off") {
      for (const field of HANDED_OFF_FORBIDDEN) if (event[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a handed_off run_ended carries no field but seq, ts, reason and detail", path: [field] });
    }
  });
export type LocalOnlyEvent = z.infer<typeof LocalOnlyEvent>;

/** The largest value of a Postgres `integer` column. `runners.protocol_version` is one, so the schema refuses anything above it (D#6 R2b). */
export const INT4_MAX = 2_147_483_647;

export const HelloMessage = z
  .object({
    // Bounded by the column it is stored in: a larger value would otherwise reach the database and fail there as a 500.
    protocol_version: safeInt.min(1).max(INT4_MAX),
    binary_version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
    // Whether a model login is present. Never an email, organisation or account name.
    model_auth_present: z.boolean(),
    isolation: IsolationTier,
  })
  .strict();

/**
 * D#6 R4a-6 (correction C16 section 1.3): why a runner's sandbox cannot start, a closed set and the only detail about it that leaves the
 * machine. The runner's probe (`fx-runner doctor` runs it too) answers with one of these.
 */
export const SANDBOX_UNAVAILABLE_REASONS = ["bwrap_missing", "socat_missing", "userns_disabled", "apparmor_userns_restricted", "probe_failed_other"] as const;
export const SandboxUnavailableReason = z.enum(SANDBOX_UNAVAILABLE_REASONS);
export type SandboxUnavailableReason = z.infer<typeof SandboxUnavailableReason>;

/**
 * A claim carries nothing: the signature identifies the runner and the cloud reads its scope from its own row. The one exception is the
 * status poll of a runner whose sandbox does not work (C16 section 1.3): it names the reason, takes no job, and the cloud answers it with
 * `retry_after` only. Absent means the sandbox works.
 */
/**
 * D#6 C43-2a (with the resource-aware addendum): what a runner declares on a claim, per job class. `limit` is the live capacity it
 * works out from its free resources, bounded by its safety ceilings; `in_use` is the jobs it holds now. Whole numbers; light 0..8,
 * heavy 0..4. `in_use` may exceed `limit` (the limit was lowered while jobs ran). Optional: absent is today's behaviour.
 */
export const MAX_LIGHT_CAPACITY = 8;
export const MAX_HEAVY_CAPACITY = 4;
const classLoad = (max: number) => z.object({ limit: z.number().int().min(0).max(max), in_use: z.number().int().min(0).max(max) }).strict();
/**
 * Why a runner's limit sits below what it could hold, so a run that waits for a slot can say so. Closed. Optional and nullable: a runner
 * that sends none (an older one, or one with nothing holding it back) leaves the wait unexplained.
 */
export const LIMITED_BY = ["memory", "cpu", "disk", "paused", "ceiling", "usage_limit"] as const;
export const LimitedBy = z.enum(LIMITED_BY);
export type LimitedBy = z.infer<typeof LimitedBy>;
export const ClaimCapacity = z.object({ light: classLoad(MAX_LIGHT_CAPACITY), heavy: classLoad(MAX_HEAVY_CAPACITY), limited_by: LimitedBy.nullable().optional() }).strict();
export type ClaimCapacity = z.infer<typeof ClaimCapacity>;

/** The most jobs a runner may hold in all, light and heavy together. The class maxima above are each bounded by it, not added to it. */
export const MAX_TOTAL_CAPACITY = 8;

/**
 * D#6 C43-2b: what the cloud holds a runner to on one claim. The class limits it declared, kept inside the ceilings (light 8, heavy 4;
 * together at most 8 held), and the free slots per class: `limit - in_use`, never below 0. `in_use` is the larger of what the runner says it holds and
 * what the cloud counts as running for it (`running`), so neither side's lag can open a slot the other has filled.
 */
export function capacityFreeSlots(capacity: ClaimCapacity, running: { light: number; heavy: number }): { light: number; heavy: number; total: number } {
  const light = Math.min(capacity.light.limit, MAX_LIGHT_CAPACITY);
  const heavy = Math.min(capacity.heavy.limit, MAX_HEAVY_CAPACITY);
  const freeLight = Math.max(0, light - Math.max(capacity.light.in_use, running.light));
  const freeHeavy = Math.max(0, heavy - Math.max(capacity.heavy.in_use, running.heavy));
  const headroom = Math.max(0, MAX_TOTAL_CAPACITY - Math.max(capacity.light.in_use + capacity.heavy.in_use, running.light + running.heavy));
  return { light: Math.min(freeLight, headroom), heavy: Math.min(freeHeavy, headroom), total: Math.min(freeLight + freeHeavy, headroom) };
}

export const ClaimMessage = z.object({ sandbox_unavailable: SandboxUnavailableReason.optional(), capacity: ClaimCapacity.optional() }).strict();

export const HeartbeatMessage = z.object({ run_id: uuid, lease_generation: leaseGeneration }).strict();

/** D#6 R5a-2b (C27 section 1.1): a cloud-verified run asks for a git ticket. The run and generation are checked against the lease; nothing else travels. */
export const GitTicketMessage = z.object({ run_id: uuid, lease_generation: leaseGeneration }).strict();

/** The signed route a runner asks for a git ticket on. The signature covers the cloud origin plus this constant path. */
export const GIT_TICKET_PATH = "/api/runner/git-ticket";

export const EventsMessage = z.object({ run_id: uuid, lease_generation: leaseGeneration, events: z.array(LocalOnlyEvent).min(1).max(MAX_EVENTS_PER_BATCH) }).strict();

/** The deepest nesting `agentOutput` may have. Real envelopes are a few levels deep. */
export const MAX_AGENT_OUTPUT_DEPTH = 32;

/**
 * True when `value` nests no deeper than `maxDepth` and serialises to at most `maxBytes` characters. Depth is measured
 * first, with an explicit stack, because `JSON.stringify` overflows the stack at a few thousand levels: hostile input
 * must give a failed check, never an exception.
 */
export function isBoundedJson(value: unknown, maxDepth: number, maxBytes: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (typeof node !== "object" || node === null) continue;
    if (depth > maxDepth) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, depth + 1]);
  }
  try {
    return JSON.stringify(value).length <= maxBytes;
  } catch {
    // fx-swallow-ok: input that cannot be serialised is, by design, a failed check
    return false;
  }
}

/** `done` is a hint. The cloud checks GitHub itself; `agentOutput` is stored as advisory only. */
export const DoneMessage = z
  .object({
    run_id: uuid,
    lease_generation: leaseGeneration,
    // D#6 R3b (C12 section 2.8; additive under C8 section 6): the Claude Code session the run ended in, so a fix round can resume it.
    session_id: z.string().regex(SESSION_ID_PATTERN).optional(),
    agentOutput: z
      .record(z.unknown())
      .refine((value) => isBoundedJson(value, MAX_AGENT_OUTPUT_DEPTH, MAX_ENVELOPE_INPUT_BYTES), { message: "agentOutput is too large or too deeply nested" })
      .optional(),
  })
  .strict();

/** A registration code is `fxrr_` and 32 to 128 letters or digits. The cap keeps a hostile body from reaching the hash. */
export const REGISTRATION_CODE_PATTERN = /^fxrr_[A-Za-z0-9]{32,128}$/;

export const RegisterMessage = z.object({ code: z.string().max(133).regex(REGISTRATION_CODE_PATTERN), public_key_jwk: Ed25519PublicJwk }).strict();

/**
 * The cloud's 201 reply to a registration (cloud to runner, so it is not one of `RUNNER_MESSAGES`). `account_id` and
 * `credential_mode` are read from the stored runner row, never from the request: the runner compares the mode with the
 * one it was asked to register for, and keeps the account for display only. Strict, so a reply with anything else is refused.
 */
export const RegisterResponse = z.object({ runner_id: uuid, account_id: uuid, credential_mode: CredentialMode }).strict();
export type RegisterResponse = z.infer<typeof RegisterResponse>;

/** The new key. The request itself is signed by the old key. */
export const RotateMessage = z.object({ public_key_jwk: Ed25519PublicJwk }).strict();

export const RevokeMessage = z.object({ reason: z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).optional() }).strict();

/** The complete set of runner-to-cloud messages. A test pins these keys. */
export const RUNNER_MESSAGES = {
  hello: HelloMessage,
  claim: ClaimMessage,
  heartbeat: HeartbeatMessage,
  git_ticket: GitTicketMessage,
  events: EventsMessage,
  done: DoneMessage,
  register: RegisterMessage,
  rotate: RotateMessage,
  revoke: RevokeMessage,
} as const;

export type RunnerMessageName = keyof typeof RUNNER_MESSAGES;
export type RunnerMessage<N extends RunnerMessageName> = z.infer<(typeof RUNNER_MESSAGES)[N]>;
