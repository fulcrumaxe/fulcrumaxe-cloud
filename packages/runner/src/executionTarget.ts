import type { PoolClient } from "pg";
import type { Product, Role } from "./types.js";
import type { DenyReason, ReserveParams } from "@fx/spend";
import type { RunFunding } from "./funding.js";
import type { ModelFailureCode } from "./modelFailure.js";
import type { RunLimits } from "./meteringGuard.js";
import { SandboxTarget, type SandboxTargetDeps } from "./targets/sandboxTarget.js";
import { RunnerTarget, type RunnerTargetDeps } from "./targets/runnerTarget.js";

/**
 * D#2 H09b, correction C10: `startAgentRun` depends on an
 * `ExecutionTarget`, never on `SandboxPort` directly. It owns the work
 * every target shares: resolving the run; inserting/moving `agent_runs`
 * rows; the Workflow hook, raced against a watchdog; writing
 * `run_events`; handing off to the gate. One Workflow, one state
 * machine, one events table, one gate.
 *
 * `SandboxTarget` (targets/sandboxTarget.ts) is the only adapter built in
 * this slice (H09b1); D#6 adds `RunnerTarget` later behind this same
 * interface. "Outside `SandboxTarget`, no H09b code may assume there is a
 * sandbox" -- `startAgentRun.ts`/`cancelRun.ts` are forbidden
 * (test/importBoundary.test.ts, pass/fail 9) from importing
 * `sandboxPort`/`fakeSandbox`/`firewallPolicy`/`sandboxEnv`/`networkPolicy`/
 * `@fx/spend` directly; only `targets/sandboxTarget.ts` may.
 */

/** C10: the `repos.execution_mode` column is `text NOT NULL DEFAULT 'sandbox'` with a named CHECK. D#6 R1b widened
 * that CHECK to `runner_local`; R3a (migration 0714) widens `agent_runs_execution_mode_check` and registers the
 * target. `runner_verified` (D#6 R5b) is not a value yet: the resolver throws `UnknownExecutionModeError` for it. */
export type ExecutionMode = "sandbox" | "runner_local";

/** What `agent_runs.runtime` a target's runs are stamped with (D#6 C12 A1). It comes from the target, never a literal at
 * the call site: the sandbox writes `production`, a runner writes `runner`. */
export type TargetRuntime = "production" | "runner";

/** C10: "a lost runner is `running -> failed`, with
 * `failure_reason: 'runner_lost'`... a closed enum that includes
 * `runner_lost`, which nothing produces in v1." No H09b1 path produces
 * any of these (H09b2 wires key-failure/mid-run-kill; D#6's sweeper is
 * the eventual producer of `runner_lost`). */
export type FailureReason =
  | "runner_lost"
  /** D#6 R2a0: the runner was revoked (by its owner, an admin, or because its registrant lost admin) while it held the run. */
  | "runner_revoked"
  | "model_key_broken"
  | "sandbox_error"
  | "internal_error"
  /** The agent command never came up inside the start window (the sandbox exists, nothing runs in it). */
  | "agent_start_timeout"
  /** The sandbox was stopped or deleted from outside while the run was still `running`. */
  | "sandbox_stopped"
  /** A preview's repository could not be cloned before the agent started (failed, or took too long). */
  | "clone_failed"
  /** A preview's repository is over the clone size limit. */
  | "clone_too_large"
  /** An executor build found its persistent sandbox in use by another session, and refused to touch it. */
  | "sandbox_busy"
  /** D#6 C12 A9: the reasons R2b's criteria name. Nothing in R3a produces them; the type carries them so R2b's writers
   * (claim, done, sweeper, events) record a member of this closed set. */
  | "public_repo"
  | "repo_visibility_unknown"
  | "no_commit"
  | "scope_violation"
  | "usage_limit"
  | "credential_mismatch"
  | "queue_ttl"
  /** D#6 R2b-3 (C21 section 7): a runner run still `running` two hours after it started; the sweeper's `timed_out` write records it. */
  | "wall_clock_limit"
  /** D#6 R2b-3 (C21 section 7): an executor's changes could not be checked against the Spec's file scope (no scope on record, or one the matcher cannot read), so no pull request is opened. */
  | "scope_unknown"
  /** A caller that cannot wait for a runner to claim a run was handed a queued one and cancelled it (`failClosedOnQueued`). */
  | "queued_not_supported";

/** What a target reports once a dispatched run reaches a terminal
 * outcome. `SandboxTarget` builds this from the sandbox's last
 * `NormalizedEvent` (or its absence) and hands it to the Workflow hook
 * named by `dispatch`'s `hookToken`.
 *
 * D#2 H09b2 (C10's revised criteria 2/4, H09.5/H09.8): `"killed_spend"` is
 * a THIRD outcome alongside `"succeeded"`/`"failed"` -- distinct from
 * `"failed"` because `agent_runs.status`'s own vocabulary
 * (`statusTransitions.ts`) treats `killed_spend` as a sibling terminal
 * value reachable from `running`, not a `failureReason` under `"failed"`.
 * A mid-run spend kill (H09.8) reports `"killed_spend"`; a model-key
 * failure (H09.5) reports `"failed"` with `failureReason: "model_key_broken"`. */
export interface TerminalReport {
  status: "succeeded" | "failed" | "killed_spend" | "timed_out";
  failureReason?: FailureReason;
  envelope?: Record<string, unknown> | null;
  tokensIn?: number;
  tokensOut?: number;
  usd?: number;
  /** D#2 H09b2 (H09.9): the sandbox-side session id, when the run reported
   * one -- `finalize` persists this onto `agent_runs.cc_session_id` so a
   * later `resumeAgentRun` can find it. */
  sessionId?: string;
  /** D#2 H09b2 (H09.5): the specific HTTP-shaped code a model-key failure
   * carried (401/402/403), when `failureReason` is `"model_key_broken"`.
   * `finalize` uses this ONLY to decide whether to call
   * `ConnectionStatusPort.markBroken` (401/403 only, never 402) -- see
   * `modelFailure.ts`'s own doc comment. */
  modelFailureCode?: ModelFailureCode;
  /** D#2 H14c-5b-2a (C48 LIMIT-END): set when the run ended because it
   * reached a limit (`timed_out`, or `killed_spend` for `per_run_usd`).
   * `finalize` turns it into the checkpoint row. Absent for a failure. */
  limit?: RunLimit;
  /** D#2 H14c-5c-2a (X-4): in-run extensions this run used; absent when none. */
  extensionsUsed?: number;
  /** D#2 H14c-5c-1 (C48 W-3): the agent's own "won't finish" (`timed_out`, no
   * `limit`). `summary` is untrusted display text: `finalize` writes it to the
   * `checkpoint` event and nothing ever reads it as an instruction or input. */
  agentCheckpoint?: { summary: string };
  /** Why a `killed_spend` run was killed: its own cap, or the monthly budget. */
  abortReason?: "per_run_cap" | "monthly_budget";
  /** The metering summary (C46 MP-PLAUS; produced by H14c-5b-2b). */
  metering?: { meteredUsd: number; reportedUsd: number | null; flags: string[]; modelCalls?: number };
}

/** The runner's own limit set (meteringGuard.ts), as carried on a run. */
export type RunLimitsInput = RunLimits;

/** Which limit ended a run, the limit's value and what was observed. */
export interface RunLimit {
  kind: "run_time" | "model_calls" | "per_run_usd" | "turns" | "silence";
  limit: number;
  observed: number;
}

/**
 * D#2 H14c-3-3a-3 (P2): what the hook carries. The target has ALREADY finalized the run (its terminal status row is
 * the durable record), so the hook is only a wake-up: the run's id and the terminal status, fixed fields, nothing the
 * agent wrote. The full report (with the agent's envelope) never leaves the process that produced it except into
 * `agent_runs`, and never goes into the Workflow service's event log.
 */
export interface HookResult {
  runId: string;
  status: TerminalReport["status"];
}

/** Why `admit` refused: `@fx/spend`'s deny reasons (a type-only import, so no runtime dependency) plus the target's own
 * reasons. `unknown_model` is the sandbox's. The rest are the runner's (D#6 C12 section 2.2): the day's run cap, a public
 * repo, a repo whose visibility could not be read, and a role no runner may run. */
export type AdmitDenyReason =
  | DenyReason
  | "unknown_model"
  | "backend_not_selectable"
  | "runner_daily_limit"
  | "public_repo"
  | "repo_visibility_unknown"
  | "role_not_runner_eligible";
/** The same set at run time, for the one write site. A record, so a new reason fails tsc here until it is listed. */
const ADMIT_DENY_REASON_SET: Readonly<Record<AdmitDenyReason, true>> = {
  unknown_model: true,
  backend_not_selectable: true,
  account_not_active: true,
  model_connection_not_ok: true,
  per_spawn_cap_exceeded: true,
  work_item_cap_exceeded: true,
  model_budget_exceeded: true,
  compute_cap_exceeded: true,
  runner_daily_limit: true,
  public_repo: true,
  repo_visibility_unknown: true,
  role_not_runner_eligible: true,
};
export const isAdmitDenyReason = (reason: unknown): reason is AdmitDenyReason =>
  typeof reason === "string" && Object.hasOwn(ADMIT_DENY_REASON_SET, reason);

/** C10: "`admit` returns `{admitted:true}` or `{admitted:false, reason}`.
 * It refuses a run before anything is created." `reason` is a closed set: it
 * becomes the run's `failure_reason`, which a customer can read, so it is never free text. */
export type AdmitResult = { admitted: true } | { admitted: false; reason: AdmitDenyReason };

/** C10: "`cancel(run)` returns `{settled_usd, released_usd}` and is
 * idempotent." */
export interface CancelResult {
  settled_usd: number;
  released_usd: number;
}

/**
 * The run-shaped input every `ExecutionTarget` method takes. Deliberately
 * target-agnostic -- nothing here is sandbox-specific.
 *
 * `spend` reuses `@fx/spend`'s own `ReserveParams` (minus `accountId`/
 * `runId`, already carried via `id`) rather than re-declaring every
 * cap/budget field. This is a type-only import -- the import-boundary
 * rule (pass/fail 9) is about runtime dependency surface, not types that
 * erase to nothing.
 */
export interface ExecutionRun {
  id: string;
  accountId: string;
  workItemId?: string | null;
  parentRunId?: string | null;
  /** D#6 R3a: the member who started the run (`agent_runs.initiated_by`). Written at insert only; a runner's
   * subscription binding (R2b) reads it. Absent for a run no member started. */
  initiatedBy?: string | null;
  role: Role;
  product: Product;
  /** `repos.id` -- required (and UUID-validated by `sandboxNameFor`)
   * only for the executor role's `ex-{repoId}-{pr}` sandbox name;
   * ignored by every other role. */
  repoId?: string;
  /** Required, and only meaningful, for the executor role. */
  pr?: number;
  headSha?: string | null;
  roleCard: string;
  prompt: string;
  model: string;
  /**
   * D#221 R1b: the agent backend, by registered name. Absent = "claude-code". Resolved once, at `admit`: a name the
   * registry does not select refuses the run (`backend_not_selectable`) before anything is reserved. The run row's
   * `backend` column (0735) is fixed at insert, and a fix round's resume must find the same name on the run it continues.
   */
  backend?: string;
  /**
   * D#6 R2b-3 (C22 section 2): a runner follow-up of a fix round names the branch the lost round was on. `RunnerTarget.resume` passes it
   * to the job issuer, which refuses the run unless the branch it derives for the work item is exactly this one. Absent for every other run.
   */
  continuesBranch?: string;
  workdir?: string;
  /** D#2 PREVIEW-RUNNER-EVENTS: preview runs only. The repository to clone into `workdir` before the agent starts. */
  cloneRepo?: { owner: string; name: string };
  capUsd: number;
  /** Milliseconds. Spec: "2 h default". */
  timeoutMs?: number;
  /** D#2 H14c-3-2d-1: this run's limits, handed to the port at start and resume.
   * Absent = the port's defaults. */
  limits?: RunLimitsInput;
  /** D#2 H14c-3-2e: how many in-run extensions this run may take (the seat's bounded value). Absent = the run is not extendable. */
  maxExtensions?: number;
  spend: Omit<ReserveParams, "accountId" | "runId">;
  /** D#2 H09b2, correction C16: which account's spend/model-key this run
   * draws on. Omitted (or `{kind:'self'}`) means "the run's own account" --
   * every H09b1 caller is unchanged. See `funding.ts`. */
  funding?: RunFunding;
}

/**
 * D#6 C12 section 2.1: what `dispatch` and `resume` return. A sandbox run starts at once and hands back the token of the
 * Workflow hook that its end will resume. A runner run starts nothing: it waits in `pending` until a runner claims it, and
 * no hook exists for it (section 2.6). `queued: true` is that case, and the caller leaves the run `pending`.
 */
export type DispatchResult = { hookToken: string } | { queued: true };

export interface ExecutionTarget {
  /** D#6 C12 A1: the `agent_runs.runtime` this target's runs are stamped with. */
  readonly runtime: TargetRuntime;
  /**
   * `client` is the caller's OWN transaction client: `startAgentRun`
   * inserts `agent_runs` inside one `withTenant` transaction and passes
   * that same client here, so a real `reserveWith(client, …)` (D#31
   * API-1, not merged when this branch was cut) could later commit the
   * reservation and the insert atomically. `SandboxTarget`'s `admit`
   * accepts `client` for that future signature but calls
   * `reserve(pool, …)` in a separate transaction today -- see
   * targets/sandboxTarget.ts's header for the documented gap.
   */
  admit(run: ExecutionRun, client: PoolClient): Promise<AdmitResult>;
  dispatch(run: ExecutionRun): Promise<DispatchResult>;
  cancel(run: ExecutionRun): Promise<CancelResult>;
  /**
   * D#2 H09b2 (C10's revised criterion 5, H09.9): "`resume` uses the same
   * sandbox name and `--resume <cc_session_id>` from `agent_runs`. When
   * the snapshot has expired (fake: `NotFound`), it falls back to a fresh
   * executor seeded with the PR diff." `sessionId` is `agent_runs.cc_session_id`
   * from the run being resumed (the caller's job, not this interface's);
   * seeding the fresh fallback's prompt with the PR diff is the CALLER's
   * job too -- `run.prompt` is whatever the caller already built.
   */
  resume(run: ExecutionRun, sessionId: string): Promise<DispatchResult>;
  /**
   * D#2 H09b2 (C10's revised criteria 2-4, H09.5/H09.7/H09.8): called once
   * a dispatched run's hook has resumed (or the caller decided the run's
   * outcome some other target-agnostic way) with the `TerminalReport` the
   * hook carried. Writes the run's final `agent_runs.status`/result
   * columns, settles or releases whatever `admit` reserved, and (for
   * `failureReason: "model_key_broken"`) marks the tenant's model
   * connection broken and pauses its other queued runs. Idempotent the
   * same way `cancel` is: a repeat call for an already-terminal run is a
   * no-op settle (nothing left `admit` opened to close).
   */
  finalize(run: ExecutionRun, report: TerminalReport): Promise<CancelResult>;
  /**
   * A run still `running` whose compute is gone (its sandbox was stopped or deleted from outside): settle it as
   * failed. Looks at the provider on each call and changes nothing while the compute is still there or the answer
   * is in doubt. Optional: a target without it is never swept for lost runs.
   */
  settleIfLost?(run: ExecutionRun): Promise<LostRunOutcome>;
}

/** What `settleIfLost` found: the run was settled, its compute is alive, or the provider could not say. */
export type LostRunOutcome = "settled" | "alive" | "unknown";

/** C10: "An unregistered mode fails closed. The resolver throws
 * `UnknownExecutionModeError` before `admit`. No reservation, no sandbox
 * and no status write happen, and the run never falls back to
 * `sandbox`." */
export class UnknownExecutionModeError extends Error {
  constructor(public readonly mode: string) {
    super(`unknown repos.execution_mode: ${JSON.stringify(mode)}`);
    this.name = "UnknownExecutionModeError";
  }
}

/**
 * PR #85 fix round item 1 (CWE-362/672): thrown by an `ExecutionTarget`'s
 * `dispatch` when it aborts because the run's durable status (the CAS
 * writer's own column) had already moved away from `"pending"` -- a
 * cancel or the queue-TTL timeout landed -- while `dispatch`'s own
 * resource-creation step was still in flight. The run is left however
 * that OTHER writer already left it (that write is what makes this
 * abort safe to take); this error exists only so `startAgentRun`'s
 * dispatch-rejection handling (see `DispatchFailedError`) can tell "this
 * was an expected abort, not an unexplained crash" and skip re-writing a
 * status that already committed.
 */
export class DispatchAbortedError extends Error {
  constructor(public readonly runId: string) {
    super(`dispatch aborted for run ${runId}: run left "pending" before it could start`);
    this.name = "DispatchAbortedError";
  }
}

/**
 * PR #85 fix round item 3 (CWE-772): thrown by `startAgentRun` when
 * `target.dispatch(run)` rejects for any reason OTHER than
 * `DispatchAbortedError` above -- e.g. a `modelConnection.get` failure
 * after `createSandbox` already created a real sandbox. Keeps the
 * original rejection accessible as `originalError` (for a TRUSTED
 * caller's own logging, never rendered to anyone else) rather than
 * swallowing it, after `startAgentRun` has already written a terminal
 * `failed` status and asked the target to clean up (release the
 * reservation, stop/delete whatever it created) -- see startAgentRun.ts.
 *
 * PR #85 fix round 2, informational (CWE-209): `.message` used to embed
 * `originalError`'s own message verbatim. A provider/KMS/network error
 * can carry text an operator never meant to be public (a hostname, a key
 * id, an internal path) -- any route that ever echoes `err.message` back
 * to a caller (there isn't one today, but this is the kind of assumption
 * that's cheap to protect now and expensive to notice missing later)
 * would leak it. `.message` now carries only the same fixed category
 * `run_events`/`writeRunStatus` already use for this exact failure
 * (`failureReason: "internal_error"`, startAgentRun.ts) -- never the
 * underlying text.
 */
export class DispatchFailedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly originalError: unknown,
    public readonly failureReason: FailureReason = "internal_error",
  ) {
    super(`dispatch failed for run ${runId}: ${failureReason}`);
    this.name = "DispatchFailedError";
  }
}

/**
 * Thrown by a target's `dispatch` when the sandbox exists but the agent never started in it: the start window passed
 * (`agent_start_timeout`) or the launch itself failed (`sandbox_error`). `dispatch` has already stopped and measured the
 * sandbox when it throws this; `startAgentRun` records `failureReason` and fails the run.
 */
export class AgentStartError extends Error {
  constructor(
    public readonly runId: string,
    public readonly failureReason: Extract<FailureReason, "agent_start_timeout" | "sandbox_error" | "clone_failed" | "clone_too_large" | "sandbox_busy">,
  ) {
    super(`agent did not start for run ${runId}: ${failureReason}`);
    this.name = "AgentStartError";
  }
}

/** One factory per registered mode -- a factory, not a pre-built
 * instance, because every real target needs constructor-injected
 * dependencies only `resolveExecutionTarget`'s caller has. */
export type ExecutionTargetFactory<Deps> = (deps: Deps) => ExecutionTarget;

/** D#6 C12 A7: each mode has its own deps type. A runner target takes no sandbox, spend or model-key dependency. */
export interface ExecutionTargetDeps {
  sandbox: SandboxTargetDeps;
  runner_local: RunnerTargetDeps;
}

/**
 * Pass/fail 10, as D#6 R3a amends it: `Object.keys(EXECUTION_TARGETS)` deep-equals `['sandbox', 'runner_local']`. The
 * literal object that test asserts against. `runner_verified` is deliberately absent (R5b).
 *
 * A map of FACTORIES, not built instances -- this is the ONLY place that
 * needs each mode's deps shape. `resolveExecutionTarget` below (what
 * `startAgentRun.ts`/`cancelRun.ts` actually call) takes an already-built,
 * target-agnostic REGISTRY of instances instead, so those two files never
 * need to import a mode-specific dependency type.
 */
export const EXECUTION_TARGETS: Readonly<{ [M in ExecutionMode]: ExecutionTargetFactory<ExecutionTargetDeps[M]> }> =
  Object.freeze({
    sandbox: (deps: SandboxTargetDeps) => new SandboxTarget(deps),
    runner_local: (deps: RunnerTargetDeps) => new RunnerTarget(deps),
  });

/** An already-built registry of target INSTANCES, keyed by mode -- what
 * a composition root gets from calling each `EXECUTION_TARGETS[mode](deps)`
 * factory once. `Partial`: a composition root registers the modes it has deps for. */
export type ExecutionTargetRegistry = Readonly<Partial<Record<ExecutionMode, ExecutionTarget>>>;

/**
 * Pass/fail 10: "Routing is by data, never by environment... A repo with
 * `execution_mode = 'sandbox'` resolves to `SandboxTarget` with `VERCEL=1`
 * set, and also with no `VERCEL*` variable set. The two results are
 * identical." This reads no environment variable at all (the
 * import-boundary test greps the package for `process.env`) -- a pure
 * lookup over `mode`/`registry`, so both scenarios are trivially
 * identical.
 *
 * "Given `'runner'` (and, in D#6, `'runner_verified'`), the resolver throws `UnknownExecutionModeError`. The
 * run leaves no reservation, no `createSandbox` call and no status
 * write." -- `startAgentRun` calls this before writing anything.
 */
export function resolveExecutionTarget(mode: string, registry: ExecutionTargetRegistry): ExecutionTarget {
  const target = Object.hasOwn(registry, mode) ? registry[mode as ExecutionMode] : undefined;
  if (!target) {
    throw new UnknownExecutionModeError(mode);
  }
  return target;
}
