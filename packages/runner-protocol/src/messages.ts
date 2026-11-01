/**
 * The messages a runner sends to the cloud. Every schema is strict, and none has a field that could carry a
 * credential (test/messages.test.ts walks every schema). The fields are the smallest set the protocol needs; a later
 * change may add a field but never remove or rename one.
 */
import { z } from "zod";
import { CONTEXT_MAX_COUNT, CONTEXT_MAX_TOOL_CALLS, CONTEXT_SECTION_CODES, CONTEXT_TOOL_ENUM, CONTEXT_TRIMMED_REASONS } from "./contextLedger.js";
import { MAX_ENVELOPE_INPUT_BYTES } from "./envelope.js";
import { RUNNER_CAPABILITIES, SESSION_ID_PATTERN } from "./job.js";

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
export const RUN_ENDED_REASONS = ["job_refused", "repo_not_private", "agent_failed", "wall_clock", "runner_setup", "runner_shutdown", "push_rejected", "handed_off", "check_failed", "resource_limit"] as const;
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
  // D#600 CX-4b (additive under C8 section 6; the cloud deploys first): the files a cut prompt points at could not be written, so the run did not start with a marker that leads nowhere.
  "context_spill_unwritable",
  // The shell sandbox could not start a Bash call under this job's rules (bubblewrap refused a no-op before the agent began). Additive under C8 section 6; the cloud deploys first.
  "sandbox_unusable",
] as const;
/**
 * D#599 HO-1 (additive under C8 section 6; the cloud deploys first): how a handed-off run ended its side of the move. `pushed`: the
 * checkpoint's commit reached the run branch. `push_failed`: it did not, and the cloud continues from the branch head it reads itself.
 * `deadline`: the checkpoint did not finish in time. Fixed words only; the note travels in the existing checkpoint event, not here.
 */
export const HANDED_OFF_DETAILS = ["pushed", "push_failed", "deadline"] as const;
// `push_failed` is already a runner_setup code; the event's detail enum lists each word once.
// D#6 R-CHK-2 (C47): the run ended because its repository's approved check did not pass. The one detail, `check_no_dev_shell`, says the check needs the dev shell and none was built; the
// check was not run. The result itself (exit code, duration, timed-out flag, summary) travels on `done` as `check`, never on this event.
export const CHECK_FAILED_DETAILS = ["check_no_dev_shell"] as const;
export const RUN_ENDED_DETAILS = [...JOB_REFUSED_DETAILS, ...RUNNER_SETUP_DETAILS, "pushed", "deadline", ...CHECK_FAILED_DETAILS] as const;
export type RunEndedDetail = (typeof RUN_ENDED_DETAILS)[number];

/** D#6 R5a-2b (C27 section 4.5): the size of the largest commit, in whole MB, rounded up. Over the proxy's 4 MB push limit, so it starts at 5. */
export const PUSH_TOO_LARGE_SIZE_MB = { min: 5, max: 10_000 } as const;

/**
 * D#6 CARD-OOM-CAUSE-WORDS (additive under C8 section 6): the memory cap, in bytes, the job's scope ran under, on a `run_ended` `resource_limit` only. A positive whole number up to one TiB.
 * The runner sends it only to a cloud whose hello kept the `memory_limit_v1` capability (an older cloud's strict parse would refuse the key); an older runner sends none and the card keeps its plain sentence.
 */
export const MEMORY_LIMIT_BYTES = { min: 1, max: 2 ** 40 } as const;

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
  check_failed: CHECK_FAILED_DETAILS,
  // D#6 RUNNER-AGENT-NO-FULLCHECK (additive under C8 section 6; the cloud deploys first): the job's own memory limit ended the agent (the kernel's OOM killer in the job's
  // scope, C43-5). It used to be sent as `agent_failed`, which read as the agent giving up. No detail: the budget is the runner's own setting.
  resource_limit: [],
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
    // D#6 CARD-OOM-CAUSE-WORDS, on a `run_ended` `resource_limit` event only: the job's memory cap in bytes (see `MEMORY_LIMIT_BYTES`).
    memory_limit_bytes: safeInt.min(MEMORY_LIMIT_BYTES.min).max(MEMORY_LIMIT_BYTES.max).optional(),
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
    if (event.memory_limit_bytes !== undefined && !(event.type === "run_ended" && event.reason === "resource_limit"))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "memory_limit_bytes belongs to run_ended resource_limit only", path: ["memory_limit_bytes"] });
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

/**
 * The protocol version both sides speak: the cloud's current version, and the one a runner sends on `hello`. One constant, so a bump cannot move only one.
 * Version 2 is the first whose runner acts on the heartbeat's `handoff` (the checkpoint turn). Version 3 is the first whose runner accepts a cross-side
 * `continues` (a null session id, the item's pull request branch and `pr_number`; `CONTINUES_CROSS_SIDE_MIN_PROTOCOL`). Version 4 is the first whose runner accepts a job's
 * `memory` object (`MEMORY_JOB_MIN_PROTOCOL`). Version 5 is the first whose runner applies a job's `excludes` (`EXCLUDES_JOB_MIN_PROTOCOL`). Version 6 is the first whose runner writes a job's `spill` files (`SPILL_JOB_MIN_PROTOCOL`). Version 7 is the first whose runner reads a job's `context_window` (`CONTEXT_WINDOW_JOB_MIN_PROTOCOL`). Version 8 is the first whose runner runs a job's approved `check` and reports it on `done` (`CHECK_JOB_MIN_PROTOCOL`). Version 9 is the first whose runner reads a job's `pins` from its checkout (`PINS_JOB_MIN_PROTOCOL`). Version 10 is the first whose runner reads a continuation's `base_sha`, the diff base of the public publish (`BASE_SHA_JOB_MIN_PROTOCOL`). Version 11 is the first whose runner accepts a `base_sha` on a run-branch continuation too (`BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL`). Version 12 is the first whose runner accepts a planned PR child's branch, `fx/<parent#>-<key>`, as the item pull request branch of a continuation (`CHILD_BRANCH_JOB_MIN_PROTOCOL`). Version 13 is the first whose runner names the failing test files on `done`'s `check` (`CHECK_FAILED_FILES_MIN_PROTOCOL`). A bump never cuts an older runner off, see below.
 */
export const CURRENT_PROTOCOL_VERSION = 13;
/**
 * The oldest version `hello` still accepts. It is fixed and moves only on purpose: a bump of the current version gates a capability for the runners
 * that declare it and never refuses the ones that do not (D#599 R-599-HO1, owner question R-599-PL2b-1). A runner below it gets 426.
 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
/**
 * The first version whose runner can read and act on a heartbeat reply's `handoff` (replies.ts). The runner parse is strict, so the cloud sends the
 * signal only to a run whose runner has declared at least this version (the cloud-side gate); an older runner gets a plain reply and keeps running.
 */
export const HANDOFF_MIN_PROTOCOL_VERSION = 2;
/**
 * D#599 PL-2b: the first version whose runner can read a job whose `continues` has a null `session_id` or a `pr_number` (the cross-side
 * continuation). The runner's job parse is strict, so the cloud never offers such a job to a runner whose stored version is lower (the claim gate,
 * `agent_runs.min_protocol_version`). It is HANDOFF's version plus one, per owner question R-599-PL2b-1; the runner release that carries it
 * (PL-2b-3) raises `CURRENT_PROTOCOL_VERSION` to this value, so until then the gated job simply waits for an updated runner.
 */
export const CONTINUES_CROSS_SIDE_MIN_PROTOCOL = 3;
/**
 * D#601 MEM-3b: the first version whose runner can read a job that has a `memory` object. The runner's job parse is strict, so the cloud never offers such a job to
 * a runner whose stored version is lower (the same claim gate as above, `agent_runs.min_protocol_version`). The cloud deploys first: it understands version 4 before any
 * runner declares it, and until a runner is updated a run that carries memory waits for one (the run page says so).
 */
export const MEMORY_JOB_MIN_PROTOCOL = 4;
/**
 * D#600 CX-5c: the first version whose runner reads a job's `excludes` and writes them as deny entries before the agent starts. Same claim gate as above. A job with excludes is never
 * offered to a lower version: its strict parse would refuse the key and, were it lenient, a runner that ignored the list would run the agent with nothing denied. Fail closed: such a
 * job waits for an updated runner. A job without excludes keeps its floor, so a repository with no excludes loses no runner.
 */
export const EXCLUDES_JOB_MIN_PROTOCOL = 5;
/**
 * D#600 CX-4b: the first version whose runner reads a job's `spill` and writes the files before the agent starts. Same claim gate as above. A prompt that was cut points at those
 * files, so it is never offered to a lower version: its strict parse would refuse the key, and a runner that ignored it would show the agent a marker with nothing behind it.
 * Such a job waits for an updated runner (the run page says so) and is never sent uncut. A job without a spill keeps its floor.
 */
export const SPILL_JOB_MIN_PROTOCOL = 6;
/**
 * D#600 CX-6b: the first version whose runner reads a job's `context_window` and tells the agent when its context is filling. Same claim gate as above: an older runner's strict
 * parse would refuse the key, so the job waits for an updated runner. Only a job whose model has a window figure carries the key; a job without one keeps its floor.
 */
export const CONTEXT_WINDOW_JOB_MIN_PROTOCOL = 7;
/**
 * D#6 R-CHK-1 (C47): the first version whose runner is given a job's approved `check`. Same claim gate as above (`agent_runs.min_protocol_version`): a job that carries a check is
 * never offered to a lower version, because its strict parse would refuse the key and a runner that ignored it would finish a run nobody checked. Such a job waits for an updated
 * runner, and the run says so (`runner_too_old_for_check`). A job without a check keeps its floor.
 */
export const CHECK_JOB_MIN_PROTOCOL = 8;
/**
 * D#600 CX-5c2: the first version whose runner reads a job's `pins` (paths) from its own checkout and puts the files in the prompt. Same claim gate as above: a job that carries pins is
 * never offered to a lower version, because its strict parse would refuse the key. Such a job waits for an updated runner and the run page says so (the wait line for a runner update), so a run
 * never starts silently without the pins the person chose. A job without pins keeps its floor.
 */
export const PINS_JOB_MIN_PROTOCOL = 9;
/**
 * D#6 FIXROUND-BASE-SYNC (R2-b): the first version whose runner reads a continuation's `base_sha`, the commit the cloud chose as the diff base of a fix round's public publish.
 * Same claim gate as above: a job that carries it is never offered to a lower version, because its strict parse would refuse the key, and a runner that ignored it would have to
 * pick its own diff base. Such a job waits for an updated runner and the run page says so. A job without a `base_sha` keeps its floor.
 */
export const BASE_SHA_JOB_MIN_PROTOCOL = 10;
/**
 * D#6 FIXROUND-REPUBLISH (R2-c0): the first version whose runner accepts a `base_sha` on a continuation of a RUN branch (a runner-built item opens its pull request on `fx/<run>-g<n>`, so
 * most fix rounds are of this kind). Version 10 refuses the key there at parse time, so such a job is never offered below this floor.
 */
export const BASE_SHA_RUN_BRANCH_JOB_MIN_PROTOCOL = 11;
/**
 * D#483 S5-b2c-3: the first version whose runner accepts a planned PR child's branch (`fx/<parent#>-<key>`) as the item pull request branch of a cross-side continuation or check-fix
 * round. Version 11 refuses that branch at parse time (its item branch is `fx/issue-<n>` only), so a job on a child's branch is never offered to a lower version: the same claim gate
 * as above (`agent_runs.min_protocol_version`). Such a job waits for an updated runner, and the run page says so (the wait line for a runner update).
 */
export const CHILD_BRANCH_JOB_MIN_PROTOCOL = 12;
/**
 * D#6 CHECK-FAILFILES-TO-CLOUD: the first version whose runner sends `check.failed_files` on `done`. This is a runner-to-cloud field, so no job is gated on it and no runner is cut off: a version 8 to 12
 * runner omits it and the cloud then records and shows none. The bump protects the other direction: a runner that sends the field declares 13, and a cloud that predates it answers `hello` 426
 * (its strict `done` schema would have refused the key), so the cloud deploys first.
 */
export const CHECK_FAILED_FILES_MIN_PROTOCOL = 13;

/** The largest value of a Postgres `integer` column. `runners.protocol_version` is one, so the schema refuses anything above it (D#6 R2b). */
export const INT4_MAX = 2_147_483_647;

/**
 * D#605 FL-2: the facts a runner reports about its machine on `hello`. Closed enums and bounded numbers, no free text. They are claims by a
 * semi-trusted machine, used to narrow or reorder routing and never as an input to any authorization decision. The same sets are the CHECK
 * constraints of `runner_facts` (migration 0783); a value outside them is a 400 here and could not be stored there either.
 */
export const RUNNER_OS = ["linux", "macos"] as const;
export const RUNNER_ARCH = ["x64", "arm64"] as const;
export const RUNNER_MEM_GB_BUCKETS = [4, 8, 16, 32, 64, 128] as const;
export const RUNNER_SANDBOX_ENGINES = ["os_sandbox", "microvm"] as const;
export const RunnerFacts = z
  .object({
    os: z.enum(RUNNER_OS),
    arch: z.enum(RUNNER_ARCH),
    mem_gb_bucket: z.union([z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64), z.literal(128)]),
    cpus: safeInt.min(1).max(256),
    sandbox_engine: z.enum(RUNNER_SANDBOX_ENGINES),
  })
  .strict();
export type RunnerFacts = z.infer<typeof RunnerFacts>;

export const HelloMessage = z
  .object({
    // Bounded by the column it is stored in: a larger value would otherwise reach the database and fail there as a 500.
    protocol_version: safeInt.min(1).max(INT4_MAX),
    binary_version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
    // Whether a model login is present. Never an email, organisation or account name.
    model_auth_present: z.boolean(),
    isolation: IsolationTier,
    // D#605 FL-2: what this machine is, read from the operating system. Optional: a runner built before this sends none, and the cloud accepts both.
    facts: RunnerFacts.optional(),
    // D#483 S4-b2c: the job kinds this build can run beyond the protocol version's, closed codes, each at most once. Optional: absent is none. The
    // cloud stores the list as sent on every hello (a downgraded runner loses what it no longer sends) and offers a capability-gated role only to a
    // runner that listed it. A claim by a semi-trusted machine: it only narrows what the claim offers, never widens a permission.
    capabilities: z
      .array(z.enum(RUNNER_CAPABILITIES))
      .max(RUNNER_CAPABILITIES.length)
      .refine((list) => new Set(list).size === list.length, { message: "a capability appears once" })
      .optional(),
  })
  .strict();
export type HelloMessage = z.infer<typeof HelloMessage>;

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

/**
 * D#598 P1f-2: an executor run on a repo paired with a public code repo asks the cloud for the ONE restricted token its run-end hook may push with.
 * The run and generation are checked against the lease; the repo, the branch and the base come from the cloud's own rows, so nothing else travels.
 */
export const PlanePushTokenMessage = z.object({ run_id: uuid, lease_generation: leaseGeneration }).strict();

/** The signed route a runner asks for its one-use public push token on. */
export const PLANE_PUSH_TOKEN_PATH = "/api/runner/plane-push-token";

/**
 * D#598 P1f-2b: the run-end hook asks for the repository's pairing (the private paths, the two rule-file paths, the paired repo) as it is NOW. The
 * hook asks twice by design, once to load it and once after its scan to see that it did not move, so nothing here is use-once. Nothing but the
 * run and generation travels: the pairing is the cloud's own row.
 */
export const PlanePushPairingMessage = z.object({ run_id: uuid, lease_generation: leaseGeneration }).strict();

/** The signed route a runner reads the live pairing on. */
export const PLANE_PUSH_PAIRING_PATH = "/api/runner/plane-push-pairing";

/** The phases a run-end hook reports, in the order they happen. */
export const PLANE_PUSH_PHASES = ["building", "scanning", "pushed", "pr_opened", "refused", "pr_failed", "no_change", "updated"] as const;
export const PlanePushPhase = z.enum(PLANE_PUSH_PHASES);
export type PlanePushPhase = z.infer<typeof PlanePushPhase>;

const fixedText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/);
const gitSha = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);

/** One thing a refusal names: its kind, the place (a path and line, never a value) and the rule key. No field here can hold matched text. */
export const PlanePushRefusal = z.object({ kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), place: fixedText(300), rule_key: fixedText(200) }).strict();
export const MAX_PLANE_PUSH_REFUSALS = 100;

/**
 * D#598 P1f-2: what the hook did, as a HINT. The cloud reads GitHub itself before it records a pushed branch or a pull request. There is no field
 * that can carry file content, a diff, a matched value or a token (test/planePush.test.ts walks the schema).
 */
export const PlanePushReportMessage = z
  .object({
    run_id: uuid,
    lease_generation: leaseGeneration,
    phase: PlanePushPhase,
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    refusals: z.array(PlanePushRefusal).max(MAX_PLANE_PUSH_REFUSALS).optional(),
    branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,330}$/).optional(),
    head_sha: gitSha.optional(),
    tip_sha: gitSha.optional(),
    pr_number: safeInt.min(1).max(2_147_483_647).optional(),
    token_revoked: z.boolean().optional(),
    pairing_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // The digest the hook read from the pairing route, echoed so the cloud can see which pairing the push was scanned against. Required for the
    // phases that say something exists on GitHub; the cloud compares it with its own stamp and never uses the value.
    if ((m.phase === "pushed" || m.phase === "pr_failed" || m.phase === "pr_opened" || m.phase === "updated") && m.pairing_digest === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pairing_digest"], message: "pairing_digest is required for this phase" });
    }
  });
export type PlanePushReportMessage = z.infer<typeof PlanePushReportMessage>;

/** The signed route a runner reports a phase of its public push on. */
export const PLANE_PUSH_REPORT_PATH = "/api/runner/plane-push-report";

/**
 * D#6 PUBLIC-MERGE PR2a: the three messages of a merge order on the local runner (design: the cloud decides, the runner checks content and merges,
 * GitHub enforces the sha). Nothing a runner sends names a repository, branch, pull request or sha that is then USED: every such value is compared with
 * the order's own row. There is no field that can hold file content, a diff, a patch or a token (test/planeMerge.test.ts walks the schemas).
 */
export const PLANE_MERGE_CLAIM_PATH = "/api/runner/plane-merge-claim";
export const PLANE_MERGE_VERIFY_PATH = "/api/runner/plane-merge-verify";
export const PLANE_MERGE_REPORT_PATH = "/api/runner/plane-merge-report";
/** The paths of a verify: at most this many; a longer change set is sent cut short with `incomplete` true. */
export const MAX_PLANE_MERGE_PATHS = 3000;
/** Why the runner stopped before it called merge, a closed set. */
export const PLANE_MERGE_ABORT_CODES = ["head_moved", "base_retargeted", "pr_not_open", "pr_draft", "read_failed", "internal", "queue_unreadable", "queue_mode_mismatch"] as const;
export const PlaneMergeAbortCode = z.enum(PLANE_MERGE_ABORT_CODES);
export type PlaneMergeAbortCode = z.infer<typeof PlaneMergeAbortCode>;

/** A claim carries nothing: the signature names the runner, and the cloud picks the oldest order this runner may take. */
export const PlaneMergeClaimMessage = z.object({}).strict();

const repoPath = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/);

/**
 * The runner's content check, bound to both shas. `same` is the result of the shared change-set comparison (planePush/changeSet.ts); `incomplete`
 * means the runner could not know (a fetch failed, a tree was malformed, no merge base): it implies `same` false. `paths` are the public change set.
 */
export const PlaneMergeVerifyMessage = z
  .object({
    order_id: uuid,
    lease_generation: z.number().int().safe().min(1),
    reviewed_head: gitSha,
    public_head: gitSha,
    same: z.boolean(),
    incomplete: z.boolean(),
    paths: z.array(repoPath).max(MAX_PLANE_MERGE_PATHS),
    pairing_digest: z.string().regex(/^[0-9a-f]{64}$/),
    token_revoked: z.boolean(),
  })
  .strict()
  .refine((m) => !(m.same && m.incomplete), { message: "an incomplete check cannot be the same", path: ["same"] });
export type PlaneMergeVerifyMessage = z.infer<typeof PlaneMergeVerifyMessage>;

/** What the runner did with the merge, as a HINT: the cloud reads GitHub itself before it records anything. */
export const PlaneMergeReportMessage = z
  .object({
    order_id: uuid,
    lease_generation: z.number().int().safe().min(1),
    result: z.enum(["merged", "enqueued", "refused", "aborted"]),
    http_status: z.number().int().min(100).max(599).optional(),
    abort_code: PlaneMergeAbortCode.optional(),
    token_revoked: z.boolean(),
  })
  .strict()
  .refine((m) => (m.result === "aborted") === (m.abort_code !== undefined), { message: "abort_code goes with result aborted, and only with it", path: ["abort_code"] });
export type PlaneMergeReportMessage = z.infer<typeof PlaneMergeReportMessage>;

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

/**
 * D#600 CX-1b (additive under C8 section 6; the cloud deploys first): what a runner says about the context a run loaded. Section codes
 * (a closed enum), integers, a sha256 per section and tool names (a closed enum) only: no free text, no path, no key outside this schema.
 * Every string is an enum member or a 64-character hex digest, so none can carry content. `measured` needs the first turn and the peak.
 */
const ledgerCount = safeInt.min(0).max(CONTEXT_MAX_COUNT);
export const ContextLedgerBody = z
  .object({
    basis: z.enum(["measured", "partial"]),
    sections: z
      .array(z.object({ code: z.enum(CONTEXT_SECTION_CODES), bytes: ledgerCount, sha256: z.string().regex(/^[0-9a-f]{64}$/), trimmed_bytes: ledgerCount, trimmed_reason: z.enum(CONTEXT_TRIMMED_REASONS).optional() }).strict())
      .max(64),
    first_turn_input: ledgerCount.optional(),
    peak_context: ledgerCount.optional(),
    cache_read: ledgerCount.optional(),
    cache_write: ledgerCount.optional(),
    memory: ledgerCount.optional(),
    tool_output_bytes: z.object(Object.fromEntries(CONTEXT_TOOL_ENUM.map((tool) => [tool, ledgerCount.optional()])) as Record<(typeof CONTEXT_TOOL_ENUM)[number], z.ZodOptional<typeof ledgerCount>>).strict(),
    // D#600 CX-10a (additive): tool calls by tool, over the same closed list; a runner that does not send it leaves the row's null ("Not recorded").
    tool_call_counts: z.object(Object.fromEntries(CONTEXT_TOOL_ENUM.map((tool) => [tool, safeInt.min(0).max(CONTEXT_MAX_TOOL_CALLS).optional()])) as Record<(typeof CONTEXT_TOOL_ENUM)[number], z.ZodOptional<z.ZodNumber>>).strict().optional(),
    compactions: safeInt.min(0).max(1_000_000),
  })
  .strict()
  .refine((v) => v.basis !== "measured" || (v.first_turn_input !== undefined && v.peak_context !== undefined), { message: "a measured ledger names its first turn and its peak" })
  .refine((v) => v.first_turn_input === undefined || v.peak_context === undefined || v.peak_context >= v.first_turn_input, { message: "the peak is at least the first turn" });
export type ContextLedgerBody = z.infer<typeof ContextLedgerBody>;

/**
 * D#6 R-CHK-2 (C47): what the runner says about running the repository's approved check. `exit_code` is null when the check did not exit (killed at its cap, or not run); `summary` is
 * the last 4096 bytes of its combined output after redaction; `skipped_tests` is read from the test runner's summary line when there is one. Integers, a flag and redacted text only.
 */
export const CHECK_SUMMARY_MAX_BYTES = 4096;
export const CHECK_EXIT_CODE_MAX = 1_000_000;
export const CHECK_DURATION_MS_MAX = 604_800_000;
export const CHECK_SKIPPED_MAX = 100_000_000;
// The bounds are the cloud's `run_checks` table's (migration 0888): a body this schema accepts must also be storable, or a crafted `done` could pass here and fail the finish.
/**
 * D#6 R-CHK-3d: why a check could not run safely (or was stopped from counting), as a closed code beside the summary. Optional, so a protocol 8 runner that omits it still works: the
 * cloud then records no reason. On the wire it is only a short lowercase word (a newer runner may name a reason this build does not know); the cloud maps any word outside this set
 * to `other` before it stores or shows anything, and a check that carries a reason never counts as passed. `other` is the generic code.
 */
export const CHECK_NOT_RUN_REASONS = ["sandbox_unavailable", "sandbox_refused", "pin_failed", "protected_unreadable", "protected_changed", "not_restored", "start_failed", "not_set_up", "base_missing", "agent_not_stopped", "other"] as const;
export type CheckNotRunReason = (typeof CHECK_NOT_RUN_REASONS)[number];
/** The closed code for a word off the wire or out of a row: a known code as it is, anything else `other`. */
export const checkNotRunReason = (word: unknown): CheckNotRunReason => (typeof word === "string" && (CHECK_NOT_RUN_REASONS as readonly string[]).includes(word) ? (word as CheckNotRunReason) : "other");
/**
 * D#6 CHECK-FAILFILES-TO-CLOUD: the names of the test files a failed check reported, so the card and the fix round can name them. Names only, never output or file contents. At most 20 names
 * (the card shows a short list; the runner counts the rest in `failed_files_more`), each at most 200 characters. Each is a plain repo-relative path: no leading slash, no `.`, `..` or
 * empty segment, no backslash or space, and no repeats.
 */
export const CHECK_FAILED_FILES_MAX = 20;
export const CHECK_FAILED_FILE_CHARS = 200;
export const CHECK_FAILED_FILES_MORE_MAX = 1_000_000;
const FAILED_FILE_NAME = /^[A-Za-z0-9_@+][A-Za-z0-9_./@+-]*$/;
/** The fixed log code written when a list is dropped. */
export const CHECK_FAILED_FILES_DROPPED = "check_failed_files_dropped";
export interface CheckFailedFiles {
  files: string[];
  more: number;
}
/** The list as the cloud keeps it. `value` is null when none was sent (or an empty one); `ok: false` is a malformed list, which the caller drops while the rest of the check stands. */
export function readCheckFailedFiles(files: unknown, more: unknown): { ok: true; value: CheckFailedFiles | null } | { ok: false } {
  if (files === undefined && more === undefined) return { ok: true, value: null };
  if (!Array.isArray(files) || files.length > CHECK_FAILED_FILES_MAX) return { ok: false };
  const moreCount = more === undefined ? 0 : more;
  if (typeof moreCount !== "number" || !Number.isSafeInteger(moreCount) || moreCount < 0 || moreCount > CHECK_FAILED_FILES_MORE_MAX) return { ok: false };
  const seen = new Set<string>();
  for (const name of files as unknown[]) {
    if (typeof name !== "string" || name.length > CHECK_FAILED_FILE_CHARS || !FAILED_FILE_NAME.test(name) || name.split("/").some((part) => part === "" || part === "." || part === "..") || seen.has(name)) return { ok: false };
    seen.add(name);
  }
  if (files.length === 0) return moreCount === 0 ? { ok: true, value: null } : { ok: false };
  return { ok: true, value: { files: files as string[], more: moreCount } };
}
export const DoneCheck = z
  .object({
    exit_code: safeInt.min(-CHECK_EXIT_CODE_MAX).max(CHECK_EXIT_CODE_MAX).nullable(),
    duration_ms: safeInt.min(0).max(CHECK_DURATION_MS_MAX),
    timed_out: z.boolean(),
    skipped_tests: safeInt.min(0).max(CHECK_SKIPPED_MAX).nullable(),
    // No NUL: the cloud's text column refuses it and the finish would abort.
    summary: z.string().max(CHECK_SUMMARY_MAX_BYTES).refine((text) => !text.includes("\u0000"), { message: "the summary holds no NUL" }),
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
    // Read with `readCheckFailedFiles` by the cloud, not refused here: a malformed list is dropped and must not turn the whole `done` into a 400.
    failed_files: z.unknown().optional(),
    failed_files_more: z.unknown().optional(),
  })
  .strict()
  // A check stopped at its cap did not exit.
  .refine((check) => !check.timed_out || check.exit_code === null, { message: "a timed-out check has no exit code", path: ["exit_code"] });
export type DoneCheck = z.infer<typeof DoneCheck>;

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
    context_ledger: ContextLedgerBody.optional(),
    check: DoneCheck.optional(),
  })
  .strict();

/**
 * A registration secret is `fxrr_` (the one-time code a signed-in person copies) or `fxrp_` (a provisioning token for a machine with no browser, D#605 FL-6), then 32 to 128
 * letters or digits. The cap keeps a hostile body from reaching the hash.
 */
export const REGISTRATION_CODE_PATTERN = /^fxr[rp]_[A-Za-z0-9]{32,128}$/;

/** The longest runner name, in characters (code points), as in `runner_settings` (migration 0783). */
export const RUNNER_NAME_MAX = 64;
// The name rule of `runner_name_valid` (0783), written the same way: no control character (C0, DEL, C1), no Unicode Default_Ignorable_Code_Point
// (soft hyphen, zero-width and bidirectional marks, variation selectors, tag characters ...), and at least one character that is none of those,
// whitespace, or the blank braille cell, so a name cannot render as nothing. The database repeats the test; this one only gives a clean 400.
const RUNNER_NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;
const RUNNER_NAME_VISIBLE = /[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u2800\u3000]/u;
// No `u` flag on purpose: with it a lone surrogate is one code point and the pair test below would not see it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** True for a name the cloud stores: 1 to 64 printable characters, nothing invisible or controlling. Never trims or repairs. */
export function isValidRunnerName(name: string): boolean {
  // A lone UTF-16 surrogate cannot be written as UTF-8: the database driver would store U+FFFD in its place, which is not what was sent. Refused here, so the stored name is exactly the sent one.
  return !LONE_SURROGATE.test(name) && [...name].length >= 1 && [...name].length <= RUNNER_NAME_MAX && !RUNNER_NAME_FORBIDDEN.test(name) && RUNNER_NAME_VISIBLE.test(name);
}
export const RunnerName = z.string().max(RUNNER_NAME_MAX * 2).refine(isValidRunnerName, { message: "a runner name is 1 to 64 printable characters" });

// `name` (D#605 FL-2) is optional: a runner built before it sends none, and its row then reads as an unnamed runner.
export const RegisterMessage = z.object({ code: z.string().max(133).regex(REGISTRATION_CODE_PATTERN), public_key_jwk: Ed25519PublicJwk, name: RunnerName.optional() }).strict();

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
  plane_push_token: PlanePushTokenMessage,
  plane_push_pairing: PlanePushPairingMessage,
  plane_push_report: PlanePushReportMessage,
  plane_merge_claim: PlaneMergeClaimMessage,
  plane_merge_verify: PlaneMergeVerifyMessage,
  plane_merge_report: PlaneMergeReportMessage,
  events: EventsMessage,
  done: DoneMessage,
  register: RegisterMessage,
  rotate: RotateMessage,
  revoke: RevokeMessage,
} as const;

export type RunnerMessageName = keyof typeof RUNNER_MESSAGES;
export type RunnerMessage<N extends RunnerMessageName> = z.infer<(typeof RUNNER_MESSAGES)[N]>;
