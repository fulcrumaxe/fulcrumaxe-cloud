import { randomUUID } from "node:crypto";
import { reportError } from "@fx/telemetry";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { CLOUD_VERIFIED_COPY_SHA256, effectiveModeSql } from "./effectiveMode.js";
import {
  resolveExecutionTarget,
  runtimeFor,
  AgentStartError,
  DispatchAbortedError,
  DispatchFailedError,
  isAdmitDenyReason,
  type AdmitResult,
  type DispatchResult,
  type ExecutionRun,
  type FailureReason,
  type ExecutionTarget,
  type ExecutionTargetRegistry,
  type PrecheckDenyReason,
} from "./executionTarget.js";
import { defaultResolvePayer, type RunFunding } from "./funding.js";
import { insertAgentRun, writeRunStatus, type InsertAgentRunParams } from "./runStatusWriter.js";
import type { RunStatus } from "./statusTransitions.js";
import type { Product, Role } from "./types.js";
import type { ContextSection } from "@fulcrumaxe/runner-protocol";

/**
 * D#2 H09b, correction C10: `startAgentRun` owns "resolving the run;
 * inserting and moving `agent_runs` rows; the Workflow hook, raced
 * against a watchdog." H09b1's slice: resolve the target, insert the
 * `pending` row, `admit`, race `dispatch` against the queue TTL, and land
 * on `refused_spend`/`timed_out`/`running`. Waiting on the DISPATCHED
 * work's own hook (post-dispatch watchdog, mid-run metering, key-failure
 * handling, `resume`) is H09b2's, in `workflows/agentRun.ts` -- not this
 * PR.
 *
 * Import-boundary rule (pass/fail 9): this file imports none of
 * `sandboxPort`/`fakeSandbox`/`firewallPolicy`/`sandboxEnv`/`networkPolicy`/
 * `@fx/spend` -- it reaches the sandbox only through the target-agnostic
 * `ExecutionTarget`/`ExecutionTargetRegistry` (`./executionTarget.js`).
 */

/** C10: "`QUEUE_TTL_MS` is an exported constant, 15 minutes by default." */
export const QUEUE_TTL_MS = 15 * 60 * 1000;

/** What an admit refusal with an unrecognised reason is recorded as. */
export const ADMIT_REFUSED_FALLBACK = "admit_refused";

/**
 * D#5 E9: what the environment step decided for this run. Structurally what `@fx/env-orchestration`'s
 * `ensureEnvironment` returns; declared here so this package does not depend on it. `error` is an environment failure:
 * it ends the start before anything is written (C14).
 */
export type RunEnvironment =
  | { kind: "none" }
  | { kind: "ready"; envVersionId: string; imageDigest: string }
  | { kind: "error"; file: string; step: string; message: string };

/** The environment step failed, so no run exists: no row, no event, no reservation, no sandbox (D#5 C14). */
export class EnvironmentFailedError extends Error {
  readonly code = "environment_failed";
  constructor(readonly file: string, readonly step: string, message: string) {
    super(message);
    this.name = "EnvironmentFailedError";
  }
}

export interface StartAgentRunInput {
  accountId: string;
  /** `repos.id` -- `startAgentRun` reads `repos.execution_mode` from this
   * row to pick a target (C10: "Routing is by data, never by
   * environment"), and it doubles as the executor role's sandbox-naming
   * input. */
  repoId: string;
  workItemId?: string | null;
  parentRunId?: string | null;
  /** D#6 R4d-5a (C34): the `spec_versions.id` the run is built from; written to `agent_runs.spec_version_id` at insert and never changed. Absent: no pin. */
  specVersionId?: string | null;
  /** D#600 CX-2: see `ExecutionRun.contextSections`. */
  contextSections?: readonly ContextSection[];
  /** D#601 MEM-3: see `ExecutionRun.memoryTokens`. */
  memoryTokens?: number;
  /** D#600 CX-2: see `ExecutionRun.fallbackPrompt`. */
  fallbackPrompt?: string;
  fallbackContextSections?: readonly ContextSection[];
  /** D#6 R3a: the member who started the run, written to `agent_runs.initiated_by` at insert and never changed. The
   * definer refuses a user who is not a member of `accountId`. Absent for a run no member started. */
  initiatedBy?: string | null;
  role: Role;
  product: Product;
  /**
   * D#6 R4d-1 (C32): the `repos.execution_mode` the caller built the run's prompt and role card for. When the mode this start
   * reads is different, it throws `ExecutionModeChangedError` before anything is written: a sandbox prompt never reaches a runner
   * and a runner prompt never reaches a sandbox. Absent: no check. Not copied onto the run.
   */
  expectedExecutionMode?: string;
  /** Required, and only meaningful, for the executor role. */
  pr?: number;
  headSha?: string | null;
  roleCard: string;
  prompt: string;
  model: string;
  /** D#221 R1b: see `ExecutionRun.backend`. */
  backend?: string;
  /**
   * D#599 PL-2b-2: a round on the other side of a hand-over works on the branch the pull request already has. Only a runner target uses it (it issues a
   * continuation with no session); a sandbox target ignores it (its prompt names the branch). `prNumber` goes with an item branch (`fx/issue-<n>`) only.
   */
  continues?: { branch: string; prNumber?: number };
  workdir?: string;
  /** D#2 PREVIEW-RUNNER-EVENTS: preview runs only; see `ExecutionRun.cloneRepo`. */
  cloneRepo?: { owner: string; name: string };
  capUsd: number;
  /** Milliseconds. Spec: "2 h default" for the sandbox itself -- distinct
   * from `QUEUE_TTL_MS`, which bounds how long `dispatch` may take to
   * return at all. */
  timeoutMs?: number;
  /** D#2 H14c-3-2d-1: copied onto the run; see `ExecutionRun.limits`. */
  limits?: ExecutionRun["limits"];
  /** D#2 H14c-3-2e: copied onto the run; see `ExecutionRun.maxExtensions`. */
  maxExtensions?: ExecutionRun["maxExtensions"];
  spend: ExecutionRun["spend"];
  /** D#2 H09b2, correction C16: see `ExecutionRun.funding`/`funding.ts`.
   * Omitted (or `{kind:'self'}`) is every pre-C16 caller, unchanged. */
  funding?: RunFunding;
  /** D#2 H14c-4: when set, the run row and a claim on `key` commit together;
   * a key that is already taken makes this throw `IdempotencyKeyTakenError`
   * before `admit` (no reservation, no sandbox). */
  idempotency?: { key: string; requestHash: string };
  /** D#2 H17c-2b (R-ATOMIC): handed to `insertAgentRun`; runs inside the create
   * transaction, right after the run row exists. See `InsertAgentRunParams`. */
  inCreateTransaction?: InsertAgentRunParams["inCreateTransaction"];
  /** D#31 API-6b-2: platform-only start facts kept with the run's `run.input` row; see `InsertAgentRunParams.startMeta`. */
  startMeta?: InsertAgentRunParams["startMeta"];
  /**
   * Called once `admit` has decided (reservation committed, or refused), before the sandbox is created. For a caller that
   * holds a lock only to keep a shared cap honest until the reservation exists: it can let go here instead of across the
   * (slow) launch that follows. Never awaited and never allowed to throw into the start.
   */
  afterAdmit?: () => void;
  /**
   * D#5 E9: resolves the run's environment (the caller binds `ensureEnvironment`). Called before anything is written;
   * an `error` throws `EnvironmentFailedError`, and a `ready` result's version and image digest are recorded on the run
   * row at insert, before the run starts. Absent, or `none`, the run starts as it always did.
   */
  ensureEnv?: () => Promise<RunEnvironment>;
}

export type StartAgentRunResult =
  | { id: string; status: "refused_spend"; reason: string }
  | { id: string; status: "timed_out" }
  | { id: string; status: "running"; hookToken: string }
  /** D#6 C12 section 2.1: the target queued the run (a runner will claim it). It stays `pending`; there is no hook to
   * wait on. A caller that waits on a hook must fail closed on this (`failClosedOnQueued`); one whose wait is a status poll
   * that credits queued time accepts it by name (`acceptQueuedRunnerRun`). */
  | { id: string; status: "pending"; queued: true }
  /** PR #85 fix round item 2 (CWE-362): the final `pending -> running`
   * write is a compare-and-set like every other write in this file --
   * this is what it returns when that write LOSES the race (something
   * else already moved the run away from `pending`, e.g. a cancel that
   * landed between `admit` and here). `status` excludes `"running"` at
   * the type level: a caller that actually won the CAS race always gets
   * the variant above instead, so the two can never be confused. */
  | { id: string; status: Exclude<RunStatus, "pending" | "running">; raceLost: true };

/** Exported for `workflows/agentRun.ts`: the post-dispatch watchdog (H09.7)
 * and the fix-round `resumeAgentRun` (H09.9) both need the identical
 * `ExecutionRun` shape `startAgentRun` builds internally, to call
 * `cancel`/`finalize`/`resume` on the SAME target after this function has
 * already returned. */
export function buildExecutionRun(id: string, input: StartAgentRunInput): ExecutionRun {
  return {
    id,
    accountId: input.accountId,
    workItemId: input.workItemId,
    parentRunId: input.parentRunId,
    initiatedBy: input.initiatedBy,
    role: input.role,
    product: input.product,
    repoId: input.repoId,
    pr: input.pr,
    headSha: input.headSha,
    roleCard: input.roleCard,
    prompt: input.prompt,
    model: input.model,
    backend: input.backend,
    ...(input.continues ? { continuesBranch: input.continues.branch, continuesFresh: true, ...(input.continues.prNumber === undefined ? {} : { continuesPrNumber: input.continues.prNumber }) } : {}),
    workdir: input.workdir,
    cloneRepo: input.cloneRepo,
    contextSections: input.contextSections,
    memoryTokens: input.memoryTokens,
    fallbackPrompt: input.fallbackPrompt,
    fallbackContextSections: input.fallbackContextSections,
    capUsd: input.capUsd,
    timeoutMs: input.timeoutMs,
    limits: input.limits,
    maxExtensions: input.maxExtensions,
    spend: input.spend,
    funding: input.funding,
  };
}

/** D#6 R4d-1 (C32): the repository's execution mode is not the one the caller built the run's prompt for. Nothing was written. */
export class ExecutionModeChangedError extends Error {
  /** The closed code a caller reports (the same word as the failure reason on a queued run cancelled by a mode change). */
  readonly code = "execution_mode_changed";
  constructor() {
    super("the repository's execution mode changed since the run's prompt was built");
    this.name = "ExecutionModeChangedError";
  }
}

/** Throws `ExecutionModeChangedError` when the caller named the mode it built for and the mode just read is another. */
export function assertExpectedExecutionMode(input: { expectedExecutionMode?: string }, mode: string): void {
  if (input.expectedExecutionMode !== undefined && input.expectedExecutionMode !== mode) throw new ExecutionModeChangedError();
}

/** D#599 PL-2: a run was refused before its row was written (the target's `precheck`, or the repository's stored cloud-verified consent no longer being the current wording). Nothing was written. */
export class RunPrecheckRefusedError extends Error {
  /** The closed code a caller reports for the whole class; `reason` says which refusal. */
  readonly code = "run_precheck_refused";
  constructor(readonly reason: PrecheckDenyReason) {
    super(`the run was refused before it was created: ${reason}`);
    this.name = "RunPrecheckRefusedError";
  }
}

/** Where a run goes, as read at its creation: the effective mode (the item's placement, else the repo's mode) and the repo's stored cloud-verified consent. */
export interface RunSide {
  mode: string;
  verifiedCopySha256: string | null;
}

/**
 * D#599 PL-2: the one read of where a run goes. The mode is `effectiveExecutionMode` in SQL: the item's `placement`, else `repos.execution_mode`.
 * An item that is not in this repo is ignored (the repo's mode applies), so a caller cannot route a repo's run by naming another repo's item.
 * Exported for `workflows/agentRun.ts`: the post-dispatch watchdog (H09.7) needs to resolve the SAME `ExecutionTarget` again, once
 * `startAgentRun` has already returned, to call `cancel`/`finalize` on it.
 */
export async function readRunSide(pool: Pool, accountId: string, repoId: string, workItemId?: string | null): Promise<RunSide> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ mode: string; verified_copy_sha256: string | null }>(
      `SELECT ${effectiveModeSql("w", "r")} AS mode, r.verified_copy_sha256
         FROM repos r LEFT JOIN work_items w ON w.account_id = r.account_id AND w.id = $3::uuid AND w.repo_id = r.id
        WHERE r.account_id = $1 AND r.id = $2`,
      [accountId, repoId, workItemId ?? null],
    );
    if (!rows[0]) {
      throw new NotFoundError(`repos ${repoId} not found`);
    }
    return { mode: rows[0].mode, verifiedCopySha256: rows[0].verified_copy_sha256 };
  });
}

export async function readExecutionMode(pool: Pool, accountId: string, repoId: string, workItemId?: string | null): Promise<string> {
  return (await readRunSide(pool, accountId, repoId, workItemId)).mode;
}

/** The mode a run was STARTED in (`agent_runs.execution_mode`, fixed at insert). A caller that stops a run it started reads this, never the repo's mode now. Null when the run is not visible. */
export async function readRunExecutionMode(pool: Pool, accountId: string, runId: string): Promise<string | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ execution_mode: string | null }>("SELECT execution_mode FROM agent_runs WHERE account_id = $1 AND id = $2", [accountId, runId]);
    return rows[0]?.execution_mode ?? null;
  });
}

/**
 * D#599 PL-2: every refusal that can be decided before the run's row exists, re-checked at EACH run creation for the run's own mode. Placement
 * is a routing input and never a permission, so a run on the other side meets the other side's guards here, now, whatever was true when the
 * placement was set:
 *  - a `runner_verified` run needs the cloud-verified wording the repo's owner accepted to be the wording this server ships now (a repo
 *    switched before the hash was stored has none, and needs the same re-consent);
 *  - the target's own `precheck` (the runner's backend, role and a live visibility read, where anything but `private` refuses).
 * A refusal throws `RunPrecheckRefusedError` and writes nothing.
 */
export async function precheckRun(target: ExecutionTarget, side: RunSide, input: Pick<StartAgentRunInput, "accountId" | "repoId" | "role" | "backend">): Promise<void> {
  if (side.mode === "runner_verified" && side.verifiedCopySha256 !== CLOUD_VERIFIED_COPY_SHA256) throw new RunPrecheckRefusedError("verified_consent_stale");
  if (!target.precheck) return;
  const result = await target.precheck({ accountId: input.accountId, repoId: input.repoId, role: input.role, ...(input.backend === undefined ? {} : { backend: input.backend }) });
  if (!result.ok) throw new RunPrecheckRefusedError(result.reason);
}

type DispatchRace = { timedOut: true } | { timedOut: false; dispatched: DispatchResult };

/**
 * C10, "New run edge `pending -> timed_out` (the queue TTL)": "If
 * `dispatch` has not returned within `QUEUE_TTL_MS`, the run becomes
 * `timed_out` and `cancel` runs." A plain `Promise.race` against a
 * `setTimeout`-based sleep (`queueTtlMs` is a caller-overridable
 * parameter so tests use a short real timeout instead of mocking time),
 * deliberately NOT `AbortController`-based: the losing side (a `dispatch`
 * whose internal `createSandbox` never resolves) is left to settle on its
 * own, matching `SandboxPort.startDetached`'s "detached, fire-and-forget"
 * shape.
 */
function raceDispatch(dispatch: Promise<DispatchResult>, queueTtlMs: number): Promise<DispatchRace> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The TTL timer is disarmed in the same step that carries the dispatch's outcome (no extra promise hop: a dispatch that
  // settles must not leave a live TTL behind, which would outlive the caller's pool and fire a write at a closed one).
  return Promise.race<DispatchRace>([
    dispatch.then(
      (r): DispatchRace => {
        clearTimeout(timer);
        return { timedOut: false, dispatched: r };
      },
      (err: unknown): never => {
        clearTimeout(timer);
        throw err;
      },
    ),
    new Promise<DispatchRace>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), queueTtlMs);
    }),
  ]);
}

/**
 * PR #85 fix round item 3 (CWE-772): wraps `target.dispatch` so a
 * REJECTION -- e.g. a `modelConnection.get` failure AFTER `createSandbox`
 * already created a real sandbox -- can never leak that sandbox or the
 * reservation `admit` already opened. Before this fix, a rejecting
 * `dispatch` propagated straight out of `startAgentRun` with the run
 * stuck at `pending` forever, its reservation never released and
 * whatever the target created never cleaned up.
 *
 * `DispatchAbortedError` (item 1) is handled differently: it means the
 * run already left `"pending"` via someone else's durable write (a
 * cancel/timeout that landed mid-dispatch), so there is no fresh status
 * to write here -- only a best-effort, idempotent cleanup call.
 */
async function dispatchOrCleanup(
  target: ExecutionTarget,
  run: ExecutionRun,
  pool: Pool,
  accountId: string,
  runId: string,
): Promise<DispatchResult> {
  try {
    return await target.dispatch(run);
  } catch (err) {
    if (err instanceof DispatchAbortedError) {
      await target.cancel(run).catch(() => {});
      throw err;
    }
    // An agent that never started has its own fixed reason; everything else stays an internal error.
    const failureReason = err instanceof AgentStartError ? err.failureReason : "internal_error";
    // Why the start failed, as fixed fields only (the error's class, operation and status; never its message).
    const e = err as { name?: unknown; operation?: unknown; status?: unknown } | null;
    console.warn(
      JSON.stringify({
        event: "run.dispatch_failed",
        run_id: runId,
        failure_reason: failureReason,
        error: typeof e?.name === "string" ? e.name : null,
        operation: typeof e?.operation === "string" ? e.operation : null,
        status: typeof e?.status === "number" ? e.status : null,
      }),
    );
    await writeRunStatus(pool, {
      accountId,
      runId,
      from: "pending",
      to: "failed",
      failureReason,
    }).catch(() => {});
    await target.cancel(run).catch(() => {});
    throw new DispatchFailedError(runId, err, failureReason);
  }
}

export async function startAgentRun(
  pool: Pool,
  registry: ExecutionTargetRegistry,
  input: StartAgentRunInput,
  queueTtlMs: number = QUEUE_TTL_MS,
  /** D#2 H09b2, correction C16: "`startAgentRun` calls `resolvePayer`
   * before `admit`, in the same position as the `UnknownExecutionModeError`
   * check. A throw there leaves no reservation, no `createSandbox` call and
   * no status write." Dependency-injected (never imported by
   * `SandboxTarget`'s own internals here) so this file's import-boundary
   * rule holds: only `funding.ts` (no forbidden import) is a static
   * dependency; the production resolver a composition root wires in is
   * whatever `SandboxTargetDeps.resolvePayer` also uses, so both agree. */
  resolvePayer: (run: Pick<ExecutionRun, "accountId" | "funding">) => string = defaultResolvePayer,
): Promise<StartAgentRunResult> {
  // C10 pass/fail 10: "Given 'runner', the resolver throws
  // UnknownExecutionModeError. The run leaves no reservation, no
  // createSandbox call and no status write." Resolved BEFORE the INSERT
  // below, so an unknown mode never creates a row at all.
  const side = await readRunSide(pool, input.accountId, input.repoId, input.workItemId);
  const mode = side.mode;
  assertExpectedExecutionMode(input, mode);
  const target = resolveExecutionTarget(mode, registry);
  // D#599 PL-2: the guards of this run's own mode, before a row exists.
  await precheckRun(target, side, input);

  // C16.3: fails closed for unsupported funding BEFORE anything is
  // written -- same position as the mode check above, and for the same
  // reason (an unsupported/misconfigured input must never create a row,
  // let alone reserve money, that then has to be unwound).
  resolvePayer({ accountId: input.accountId, funding: input.funding });

  // D#5 E9 (C14): the environment is resolved before the run row exists, so its failure leaves no run and no events.
  const env = input.ensureEnv ? await input.ensureEnv() : undefined;
  if (env?.kind === "error") throw new EnvironmentFailedError(env.file, env.step, env.message);

  // C10 pass/fail 1: "the run goes `pending -> refused_spend`" -- the row
  // must exist (as `pending`) before `admit` runs, since `reserve()`
  // inserts a `spend_reservations` row that foreign-keys to it.
  //
  // PR #85 fix round item 4 (CWE-636/362/672): `mode`/`repoId`/`pr` are
  // persisted onto the row HERE, once, rather than left for `cancelRun`
  // to reconstruct later via a `work_items`/`repos` join that can go
  // stale (a deleted repo, a `gh_number` edited after dispatch) -- see
  // 0605_execution_mode.sql's header and cancelRun.ts.
  const runId = randomUUID();
  const { id } = await insertAgentRun(pool, {
    id: runId,
    accountId: input.accountId,
    workItemId: input.workItemId,
    parentRunId: input.parentRunId,
    specVersionId: input.specVersionId ?? null,
    role: input.role,
    // D#6 C12 A1: the target says what its runs are (a sandbox writes `production`, a runner writes `runner`).
    runtime: runtimeFor(target, input.role),
    initiatedBy: input.initiatedBy,
    ...(env?.kind === "ready" ? { envVersionId: env.envVersionId, imageDigest: env.imageDigest } : {}),
    headSha: input.headSha,
    executionMode: mode,
    dispatchRepoId: input.repoId,
    dispatchPrNumber: input.pr ?? null,
    idempotency: input.idempotency,
    inCreateTransaction: input.inCreateTransaction,
    startPrompt: input.prompt,
    startMeta: input.startMeta,
  });

  const run: ExecutionRun = buildExecutionRun(id, input);

  // See ExecutionTarget.admit's own doc comment (executionTarget.ts) for
  // why a client is threaded through here even though the current
  // `reserve(pool, …)` fallback (targets/sandboxTarget.ts) doesn't use
  // it -- this is exactly the seam D#31 API-1's `reserveWith` will plug
  // into later, with no signature change needed here.
  //
  // PR #85 fix round item 5 (CWE-833/400): acquire and release strictly
  // SEQUENTIALLY -- `admit()` does not use `client` yet (see the comment
  // above), and its own `reserve()` call does its OWN `pool.connect()`
  // against this SAME pool. Holding this connection open for the
  // duration of `target.admit()` was a nested-pool-acquisition deadlock
  // on a small pool: N concurrent callers can each hold one connection
  // waiting on a second that never frees. When `reserveWith` lands, this
  // must become one shared transaction instead of this
  // acquire-then-release-then-pass dance (a released client must never
  // gain real use inside `admit` without that rewrite).
  const admitClient = await pool.connect();
  admitClient.release();
  let admitResult: AdmitResult;
  try {
    admitResult = await target.admit(run, admitClient);
  } finally {
    try {
      input.afterAdmit?.();
    } catch (err) {
      reportError(err, { stage: "run.after_admit" });
    }
  }

  if (!admitResult.admitted) {
    // The one write site of an admit refusal: a reason outside the closed set (a target's free text) is recorded as a fixed code.
    const reason = isAdmitDenyReason(admitResult.reason) ? admitResult.reason : ADMIT_REFUSED_FALLBACK;
    await writeRunStatus(pool, { accountId: input.accountId, runId: id, from: "pending", to: "refused_spend", failureReason: reason });
    return { id, status: "refused_spend", reason };
  }

  const raced = await raceDispatch(dispatchOrCleanup(target, run, pool, input.accountId, id), queueTtlMs);

  if (raced.timedOut) {
    // PR #85 fix round 2, should-fix 3 (CWE-362): this CAS write's own
    // result used to be ignored, exactly the bug item 2 (above) already
    // fixed for the "running" branch -- if a concurrent `cancelRun`
    // already committed `cancelled` while `dispatch` was still in
    // flight, this write LOSES (the row is no longer `pending`), and the
    // caller was still told `timed_out` even though the row's real,
    // durable status disagreed. `target.cancel` still runs unconditionally
    // either way (unchanged from before this fix): whether this write
    // wins or loses, anything `dispatch` may still be in the middle of
    // starting must still be stopped and its reservation released -- see
    // sandboxTarget.ts's own re-checks for why that call is always safe
    // (a no-op) when there is nothing left to do.
    const write = await writeRunStatus(pool, { accountId: input.accountId, runId: id, from: "pending", to: "timed_out" });
    await target.cancel(run);
    if (!write.updated) {
      return {
        id,
        status: (write.currentStatus ?? "cancelled") as Exclude<RunStatus, "pending" | "running">,
        raceLost: true,
      };
    }
    return { id, status: "timed_out" };
  }

  // D#6 C12 section 2.1: a queued run has no process to mark running. It stays `pending` until a runner claims it (R2b),
  // and nothing here waits on a hook, because a runner run has none.
  if ("queued" in raced.dispatched) return { id, status: "pending", queued: true };

  // PR #85 fix round item 2 (CWE-362): the CAS result used to be ignored
  // outright. If something else already moved this run away from
  // "pending" (a cancel that landed between `admit` and here), returning
  // "running" would lie about the run's actual status AND leave the
  // sandbox `dispatch` just started live with nobody the wiser. Return
  // the run's real status instead, and make sure nothing is left behind.
  const write = await writeRunStatus(pool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
  if (!write.updated) {
    await target.cancel(run).catch(() => {});
    return {
      id,
      status: (write.currentStatus ?? "cancelled") as Exclude<RunStatus, "pending" | "running">,
      raceLost: true,
    };
  }
  // A running run is work for the compute-settle cron: its sandbox may be lost, and the cron skips ticks while nothing is
  // marked. The cron keeps the marker while running runs exist (its lost-run sweep lists them) and clears it when none remain.
  void markWorkPending("compute-settle-sweep");
  return { id, status: "running", hookToken: raced.dispatched.hookToken };
}

/**
 * D#6 C12 section 2.1: thrown when a caller that cannot wait for a runner to claim a run was handed a queued one. The run
 * has already been cancelled; this error only tells the caller its start did not happen.
 */
export class QueuedRunNotSupportedError extends Error {
  constructor(public readonly runId: string) {
    super(`run ${runId} was queued for a runner, which this caller cannot wait for`);
    this.name = "QueuedRunNotSupportedError";
  }
}

/**
 * The default for a library caller of `startAgentRun` or `resumeAgentRun`: a queued runner run is not a start it can use. A
 * runner run has no Workflow hook and may sit `pending` for up to the runner queue TTL, so a caller that waits on a hook
 * would wait for ever. A `pending` result is cancelled (compare-and-set from `pending`, so a run a runner already claimed is
 * left alone) and `QueuedRunNotSupportedError` is thrown; every other result passes through unchanged, with the queued
 * variant removed from its type.
 *
 * A caller whose wait is a status poll that credits queued time (or that waits on nothing) opts in by name instead, with
 * `acceptQueuedRunnerRun`. A new caller has to choose one of the two; a source test pins the set that fails closed.
 */
export async function failClosedOnQueued<R extends { id: string; status: string }>(
  pool: Pool,
  accountId: string,
  result: R,
): Promise<Exclude<R, { status: "pending" }>> {
  if (result.status !== "pending") return result as Exclude<R, { status: "pending" }>;
  const failureReason: FailureReason = "queued_not_supported";
  try {
    await writeRunStatus(pool, { accountId, runId: result.id, from: "pending", to: "cancelled", failureReason });
  } catch {
    // fx-swallow-ok: the caller still gets QueuedRunNotSupportedError; a fixed code and the run id are logged, never the error text (it can carry a connection string)
    console.warn(JSON.stringify({ event: "run.queued_cancel_failed", run_id: result.id }));
  }
  throw new QueuedRunNotSupportedError(result.id);
}

/**
 * For a caller that can show its wait is a status poll that credits queued time, or that waits on nothing: a run the runner
 * target queued is accepted as started. It stays `pending` for a runner to claim, no follower is started (there is no hook,
 * and the `done` route and the queue sweeper end the run), one `run.queued` line with the run id and account id is logged,
 * and the result is returned as it came.
 *
 * Only a result with `queued: true` whose run belongs to the runner target is accepted. Anything else that is `pending`
 * (including a run whose runtime cannot be read) goes to `failClosedOnQueued`, exactly as before; every other status passes
 * through unchanged.
 */
export async function acceptQueuedRunnerRun<R extends { id: string; status: string }>(pool: Pool, accountId: string, result: R): Promise<R> {
  if (result.status !== "pending") return result;
  if ((result as { queued?: unknown }).queued === true && (await isRunnerRun(pool, accountId, result.id))) {
    console.info(JSON.stringify({ event: "run.queued", run_id: result.id, account_id: accountId }));
    return result;
  }
  return failClosedOnQueued(pool, accountId, result) as Promise<R>;
}

async function isRunnerRun(pool: Pool, accountId: string, runId: string): Promise<boolean> {
  try {
    return await withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ runtime: string }>("SELECT runtime FROM agent_runs WHERE id = $1 AND account_id = $2", [runId, accountId]);
      return rows[0]?.runtime === "runner";
    });
  } catch {
    // fx-swallow-ok: an unreadable runtime is not proof of a runner run, so the caller fails closed (the run is cancelled and a fixed code is thrown)
    return false;
  }
}
