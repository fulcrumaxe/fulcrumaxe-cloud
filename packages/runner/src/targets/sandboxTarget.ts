import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import type { HostLookup } from "@fx/net-guard";
import {
  claudeModelIds,
  computeModelUsd,
  isClaudeModelId,
  meter,
  monthToDateUsd,
  reserve,
  releaseWith,
  sandboxRunCost,
  settleWith,
  type Budget,
  type ModelId,
  type SettleEntry,
  type SandboxSessionFigures,
} from "@fx/spend";
import {
  AgentStartError,
  DispatchAbortedError,
  type AdmitResult,
  type CancelResult,
  type ExecutionRun,
  type ExecutionTarget,
  type HookResult,
  type LostRunOutcome,
  type RunLimit,
  type TerminalReport,
} from "../executionTarget.js";
import { buildFirewallPolicy, buildOperatorFirewallPolicy, type DecryptTenantKey, type EncryptedTenantKey } from "../firewallPolicy.js";
import type { GithubForwardConfig } from "../githubForwardConfig.js";
import { defaultResolvePayer } from "../funding.js";
import {
  MAX_LINE_INPUT_SIDE_TOKENS,
  MAX_LINE_OUTPUT_TOKENS,
  RunLimitError,
  createUsageMeter,
  type TokenTotals,
} from "../meteringGuard.js";
import { AgentOutputRecorder } from "../agentOutput.js";
import { RunProgressRecorder } from "../runProgress.js";
import { CloneError } from "../repoClone.js";
import { detectModelFailure, type ModelFailureCode } from "../modelFailure.js";
import { pauseQueuedRuns, recordLimitExtended, writeRunStatus } from "../runStatusWriter.js";
import type { ExtensionPolicy, ExtensionPolicyInput } from "../runLimitDecision.js";
import { buildSandboxEnv } from "../sandboxEnv.js";
import { isPersistentRole, retentionPolicyFor, sandboxNameFor } from "../sandboxNaming.js";
import {
  SandboxBusyError,
  SandboxNotFoundError,
  type SandboxHandle,
  type SandboxPort,
  type SandboxSessionUsage,
  type StartDetachedResult,
} from "../sandboxPort.js";
import { reportError } from "@fx/telemetry";
import { modelIdForCliName } from "../vercelSandboxPort.js";
import type { BrokenConnectionCode, ConnectionStatusPort } from "../connectionStatusPort.js";
import type { ModelProvider, NormalizedEvent } from "../types.js";

/**
 * D#2 H09b, correction C10: `SandboxTarget` wraps `SandboxPort`,
 * `buildFirewallPolicy`, `buildSandboxEnv` and H05's `reserve`/`release`.
 * This is the ONLY file in `packages/runner/src` that may import
 * `sandboxPort`, `fakeSandbox`, `firewallPolicy`, `sandboxEnv`,
 * `networkPolicy` or `@fx/spend` (test/importBoundary.test.ts, pass/fail
 * 9) -- every other H09b file reaches this only through `ExecutionTarget`.
 *
 * **H09b1 vs H09b2.** H09b1 built `admit`, `dispatch` and `cancel` --
 * enough to take a run `pending -> running` (or `refused_spend`/
 * `timed_out` before it ever runs) and to cancel it at any point, with
 * `dispatch`'s `onEvent` a no-op. H09b2 (this PR, C10's revised criteria
 * 2-6) wires mid-run metering/spend-kill (H09.8) and key-failure handling
 * (H09.5) into that same `onEvent`, adds `resume` (H09.9) and `finalize`
 * (the write-the-outcome half of H09.5/H09.7/H09.8, called once a
 * dispatched run's hook resumes). The post-dispatch watchdog (H09.7,
 * distinct from H09b1's own `pending -> timed_out` queue TTL) is
 * `workflows/agentRun.ts`'s: it races the hook against a watchdog sleep,
 * and on a timeout calls `writeRunStatus(..., "timed_out")` then this
 * class's own `cancel` -- exactly `startAgentRun.ts`'s existing queue-TTL
 * pattern, one level up.
 *
 * **The `admit`/`reserveWith` gap (documented, not a bug).**
 * `reserveWith` (D#31 API-1) was not on `main` when this branch was cut,
 * so `admit` calls `reserve(pool, …)` in its OWN transaction instead of
 * the caller's `client` -- reservation and `agent_runs` INSERT do not
 * commit atomically in this PR (C10: "H09b does not extract `reserveWith`
 * itself"). `client` is accepted (matching the future signature) but
 * unused.
 */

/** C10: "the sandbox's completion resumes the hook from outside the
 * sandbox." H09b2 wires a real implementation against Vercel Workflow's
 * hook API; H09b1 only injects this port so `dispatch`'s hook-resumption
 * (contract test, pass/fail 8) is testable without it. */
export interface HookResumePort {
  resume(hookToken: string, result: HookResult): Promise<void>;
}

/** Read side of the tenant's model connection -- H21 is HOLD and does not
 * exist yet. Mirrors `connectionStatusPort.ts`'s pattern (H09a). */
export interface ModelConnectionPort {
  get(accountId: string): Promise<{ provider: ModelProvider; encryptedKey: EncryptedTenantKey; connectionId: string }>;
}

export interface SandboxTargetDeps {
  pool: Pool;
  sandboxPort: SandboxPort;
  decryptTenantKey: DecryptTenantKey;
  /** D#66: constructor dependency only, no default. Nothing in
   * `packages/runner/src` calls `loadGithubForwardConfig` -- tests build
   * this via that function over a `.test` hostname/suffix pair, never a
   * real one. */
  githubForward: GithubForwardConfig;
  /** D#66: optional injectable DNS lookup, threaded straight through to
   * `buildFirewallPolicy`'s own `deps.lookup` -- `undefined` here means
   * "use the real `dns.promises.lookup`", exactly like
   * `buildFirewallPolicy`'s own default. */
  lookup?: HostLookup;
  hooks: HookResumePort;
  modelConnection: ModelConnectionPort;
  /** Spec: "2 h default." Milliseconds. */
  defaultTimeoutMs?: number;
  /** D#2 H09b2 (C10's revised criterion 2, H09.5): "calls H21's markBroken
   * for 401/403" -- H21 (`packages/model-connection/**`) is HOLD; this is
   * the same narrow port H09a already defined for it (connectionStatusPort.ts). */
  connectionStatus: ConnectionStatusPort;
  /** D#2 H09b2, correction C16: resolves which account's spend/model-key
   * this run draws on. Defaults to `defaultResolvePayer` (funding.ts) --
   * `{kind:'self'}`/omitted returns `run.accountId`; `{kind:'claim'}` fails
   * closed until D#70 BRD-4 ships a real resolver. */
  resolvePayer?: (run: ExecutionRun) => string;
  /**
   * The operator exception (see @fx/runtime's operatorSubscription.ts). Returns our own subscription token
   * ONLY when every named account (the run's own and its payer) is an operator account and the switch and
   * token are in place, else undefined. The token is used right here to build the firewall policy and is
   * never stored, logged or put in the sandbox env. Absent, no run ever takes the operator path.
   */
  operatorToken?: (accountId: string, payerAccountId: string) => string | undefined;
  /** D#2 H14c-5c-2a (X-1): the run's in-run extension inputs (`maxExtensions`,
   * ceilings, the gh-proxy write counter, the `reserve()` callback). H14c-3
   * wires it; absent, a limit ends the run as before. */
  extensionPolicyFor?: (run: ExecutionRun) => ExtensionPolicyInput | undefined;
  /**
   * D#2 H14c-3-3a-3 (P2). Default true: the target finalizes a finished run itself, then wakes the hook with
   * `{ runId, status }` only. Set to false ONLY by the older tests that script the sequence by hand (wait for the
   * hook's full report, then call `finalize`): the hook then carries the whole report as it did before. Production
   * never sets it.
   */
  finalizeBeforeResume?: boolean;
  /**
   * Keeps the invocation that ran `dispatch` alive while the run's stream is read and finalized (Vercel's `waitUntil`).
   * The launch itself never relies on it: `dispatch` awaits the launch before it returns. Absent (tests, a long-lived
   * process), the stream simply runs on as a floating promise.
   */
  keepAlive?: (work: Promise<unknown>) => void;
  /** Tests only: the start window, default `AGENT_START_TIMEOUT_MS`. */
  agentStartTimeoutMs?: number;
  /** Tests only: the pause between the two looks of the lost-run check, default `LOST_CONFIRM_DELAY_MS`. */
  lostConfirmDelayMs?: number;
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * How long after the sandbox is created the agent command may take to exist (the launch: attach, firewall policy, CLI
 * version check, prompt files, the command itself; normally seconds). Past it the run fails as `agent_start_timeout`
 * and its sandbox is stopped and measured, instead of sitting in `running` with nothing in it.
 */
export const AGENT_START_TIMEOUT_MS = 3 * 60_000;

/** The pause between the lost-run check's two looks. */
export const LOST_CONFIRM_DELAY_MS = 5_000;

/** How long (and how often) a finished agent's finalize waits for `startAgentRun` to move the run out of `pending`. */
const PENDING_WAIT_MS = 10_000;
const PENDING_POLL_MS = 25;

/** How long after a stop this runner recorded itself a still-`running` run is left to its own finalize before the lost-run check settles it. */
export const OWN_STOP_GRACE_MS = 5 * 60_000;

interface RunBookkeeping {
  /** Set when the run's firewall policy was built from the operator subscription (decided once, at dispatch/resume). */
  operatorSubscription?: boolean;
  handle?: SandboxHandle;
  hookToken?: string;
  hookResumed: boolean;
  cancelled: boolean;
  cachedCancelResult?: CancelResult;
  /** PR #85 fix round 3, must-fix 1 (CWE-367/362/672): true once THIS
   * instance has called `startDetached` for this run -- set immediately
   * after, with nothing awaited in between (see `dispatch` below). Lets
   * `cancel`, when it reaches the SAME instance, stop the agent directly
   * instead of going through the reservation-gated path below, which a
   * competing writer that committed between the second re-check and
   * `startDetached` may already have emptied. */
  started: boolean;
  /** True once ANY call to `cancel()` on THIS instance has asked for this
   * run to be cancelled -- set as the very first thing `cancel` does,
   * before its own cached-result short-circuit and before the
   * reservation gate. `dispatch` checks this immediately after
   * `startDetached` (again, nothing awaited in between) to catch a
   * cancel -- or the queue TTL's own `cancel` call -- that reached THIS
   * instance before `startDetached` returned. */
  cancelRequested: boolean;
  /** True once `directStop` has actually run for this run, on this
   * instance -- makes both call sites below (`cancel` and `dispatch`)
   * idempotent, and lets `cancel`'s reservation-gated block skip its own
   * `stop()` call when the direct one already ran ("stops exactly once"
   * still holds). */
  stoppedDirectly: boolean;
  /** D#2 H09b2 (H09.5/H09.8): set by `onEvent` (dispatch, below) the
   * instant it decides to abort the run mid-stream -- the reason
   * `buildTerminalReport` classifies `hookFired`'s REJECTION as, since a
   * bare rejected promise carries no structured payload of its own once
   * it crosses the `RunAbortSignal` throw site. */
  abort?: RunAbortReason;
  /** D#2 H09b2 fix round 1 (S-MUST 1): this run's own running total of
   * ACTUAL metered model spend -- 0 until the first metered event. See
   * `meterModelUnderLock`, `settleOpenRows`. */
  cumulativeModelUsd: number;
  /** X-4: in-run extensions granted so far (the checkpoint's `extensions_used`). */
  extensionsUsed: number;
  /** The metered token total (W3) and the plausibility flags (MP-PLAUS), both for the terminal report. */
  meteredTokens: TokenTotals;
  /** The same tokens by the model each message was priced at (W2). */
  modelTokens: Map<ModelId, TokenTotals>;
  meterFlags: Set<string>;
  /** H14c-3-2c: this run's `agent.output` writer; created on the first `dispatch`/`resume` here. */
  output?: AgentOutputRecorder;
  /** D#2 PREVIEW-RUNNER-EVENTS: this run's stage and tool-activity writer; created with `output`. */
  progress?: RunProgressRecorder;
  /** D#2 COMPUTE-SETTLE CS-1: the ids of the sandbox sessions this run launched, in order, and when each began. */
  sessionIds: string[];
  sessionStartedMs: Map<string, number>;
  /** The persisting writes of those ids still in flight; a stop waits for them so it measures every session. */
  sessionWrites: Promise<unknown>[];
  /** What was measured for those sessions when the sandbox was stopped; the settle (CS-2) prices it. */
  measurement?: SandboxSessionFigures[];
  /** True once this run's sandbox was deleted (always after it was measured). */
  deleted: boolean;
}

function freshBookkeeping(): RunBookkeeping {
  return {
    hookResumed: false,
    cancelled: false,
    started: false,
    cancelRequested: false,
    stoppedDirectly: false,
    cumulativeModelUsd: 0,
    extensionsUsed: 0,
    meteredTokens: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    modelTokens: new Map(),
    meterFlags: new Set(),
    sessionIds: [],
    sessionStartedMs: new Map(),
    sessionWrites: [],
    deleted: false,
  };
}

/** D#2 H09b2 (H09.5/H09.8): why `onEvent` threw to abort a dispatched run
 * mid-stream. `code` is only meaningful for `"model_key_broken"`, and only
 * 401/403 ever reach `ConnectionStatusPort.markBroken` -- see
 * `modelFailure.ts`'s own doc comment for why 402 is excluded there. */
export type RunAbortReason =
  | { kind: "model_key_broken"; code: ModelFailureCode }
  | { kind: "spend_kill"; cause: "per_run_cap" | "monthly_budget"; limit?: RunLimit }
  | { kind: "limit"; limit: RunLimit; reportedUsd?: number }
  /** MP-PLAUS: a line no model could have produced, killed under the cap. */
  | { kind: "implausible" };

/** Thrown from `onEvent` (never caught anywhere but `dispatch`'s own
 * `hookFired` continuation below) to abort the run's `AgentRuntime.start`
 * loop -- `SandboxPort.startDetached`'s own contract documents `onEvent`
 * throwing as the sanctioned way to reject `hookFired` mid-stream. */
class RunAbortSignal extends Error {
  constructor(public readonly reason: RunAbortReason) {
    super(`run aborted mid-stream: ${reason.kind}`);
    this.name = "RunAbortSignal";
  }
}

export class SandboxTarget implements ExecutionTarget {
  /** D#6 C12 A1: the runtime a sandbox run is stamped with. It used to be a literal in `startAgentRun`. */
  readonly runtime = "production" as const;
  private readonly runs = new Map<string, RunBookkeeping>();

  constructor(private readonly deps: SandboxTargetDeps) {}

  private bookkeeping(runId: string): RunBookkeeping {
    let bk = this.runs.get(runId);
    if (!bk) {
      bk = freshBookkeeping();
      this.runs.set(runId, bk);
    }
    return bk;
  }

  /** D#2 H09b2, correction C16: the ONE place this class resolves which
   * account a spend/key call draws on. Every `reserve`/`release`/`settle`/
   * `modelConnection.get` call below uses THIS, never `run.accountId`
   * directly (C16.4's source-check test greps for exactly that). */
  private payerFor(run: ExecutionRun): string {
    return (this.deps.resolvePayer ?? defaultResolvePayer)(run);
  }

  /**
   * Whether this run took the operator-subscription path: what dispatch/resume decided when it built the
   * policy, else (a fresh instance settling a run another one started) the same decision made now.
   */
  private isOperatorRun(run: ExecutionRun, payerAccountId: string): boolean {
    const decided = this.runs.get(run.id)?.operatorSubscription;
    if (decided !== undefined) return decided;
    return this.deps.operatorToken?.(run.accountId, payerAccountId) !== undefined;
  }

  /** See file header for why `client` is accepted but unused. */
  async admit(run: ExecutionRun, client: PoolClient): Promise<AdmitResult> {
    void client;
    // C46 MP-MODEL: a model outside `@fx/spend`'s price table has no live
    // meter, so the run is refused before it reserves anything or gets a
    // sandbox (metering no longer skips an unpriced model).
    if (!isKnownModelId(run.model)) return { admitted: false, reason: "unknown_model" };
    const payerAccountId = this.payerFor(run);
    // An operator-subscription run holds no model money (the subscription is not billed per token) and needs
    // no model connection row; its per-run cap is enforced by the live meter, and its compute is reserved as usual.
    const operator = this.deps.operatorToken?.(run.accountId, payerAccountId) !== undefined;
    const result = await reserve(this.deps.pool, {
      accountId: payerAccountId,
      runId: run.id,
      ...run.spend,
      // Never taken from the run's own spend facts: only the operator decision above can set it.
      modelBrokeredBy: undefined,
      ...(operator && { estimateModelUsd: 0, modelBrokeredBy: "operator_subscription" as const }),
    });
    if (result.decision === "deny") {
      return { admitted: false, reason: result.reason };
    }
    return { admitted: true };
  }

  async dispatch(run: ExecutionRun): Promise<{ hookToken: string }> {
    assertMeterableModel(run.model);
    const bk = this.bookkeeping(run.id);
    const payerAccountId = this.payerFor(run);

    const retention = retentionPolicyFor(run.role);
    // PR #85 fix round 3, must-fix 2 (CWE-639/706/200): `accountId` is
    // now part of the sandbox name's injective triple -- see
    // sandboxNaming.ts's own doc comment for why `repoId` alone let a
    // deleted-and-reinserted `repos.id` collide across tenants.
    const sandboxName = sandboxNameFor({
      role: run.role,
      runId: run.id,
      accountId: run.accountId,
      repoId: run.repoId,
      pr: run.pr,
    });
    // H14c-3-1 (CARRY-12): the tenant's key is resolved and turned into the
    // model host's header transform BEFORE any sandbox exists, so a tenant
    // with no usable key is refused with nothing created and nothing to
    // clean up.
    const { networkPolicyRules, env } = await this.buildRunMaterials(run, payerAccountId);

    await this.markRequested(run, sandboxName);
    let handle: SandboxHandle;
    try {
      handle = await this.deps.sandboxPort.createSandbox({
        sandboxName,
        retention,
        timeoutMs: run.timeoutMs ?? this.deps.defaultTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
        ...(run.limits && { limits: run.limits }),
      });
    } catch (err) {
      if (err instanceof SandboxBusyError) {
        // The name belongs to a session that is still in use. This run owns no sandbox: the cancel that follows must
        // not stop (or measure) it by name, or it would stop the other session's work.
        bk.stoppedDirectly = true;
        throw new AgentStartError(run.id, "sandbox_busy");
      }
      throw err;
    }
    bk.handle = handle;
    if (handle.sessionId !== undefined) await this.recordSession(run, bk, handle.sessionId);

    // PR #85 fix round item 1 (CWE-362/672): `createSandbox` can take
    // arbitrarily long (a slow provider, a cold start). A cancel/timeout
    // landing while it was in flight already committed a DURABLE terminal
    // status via the CAS writer before this line ever runs -- re-check it
    // now, right after `createSandbox` resolves and BEFORE ever starting
    // the agent, so a run that already left "pending" never actually
    // starts just because its sandbox happened to finish being created
    // after the fact. The reservation itself is released by whichever
    // cancel/timeout path already ran (its release loop below is
    // idempotent either way) -- this only owns cleaning up the sandbox
    // resource THIS call just created, which nothing else knows exists
    // yet.
    if (!(await this.isRunStillPending(run.accountId, run.id))) {
      bk.stoppedDirectly = true; // the cancel that follows must not stop (and re-measure) it again
      await this.stopAndMeasure(run, bk, handle, true);
      throw new DispatchAbortedError(run.id);
    }

    // D#2 H09b2: built BEFORE the second re-check below -- see that
    // re-check's own comment for why nothing may be `await`ed between it
    // resolving and `startDetached`. Fix round 1 (S-MUST 2) dropped this
    // method's own up-front await (month-to-date is now re-read fresh,
    // under lock, per event) but the call stays here regardless.
    const { onEvent, onStage, getSessionId } = await this.buildMeteredOnEvent(run, payerAccountId, handle, bk);

    // PR #85 fix round 2, must-fix 1 (security re-review of 1781b3b,
    // finding 1; CWE-367/362/672): the re-check above closes the window
    // up to that point, but `buildMeteredOnEvent` (and the first re-check's
    // own read) each `await`, so a cancel/TTL committing its durable write
    // in one of those gaps would still be invisible to `dispatch` -- it
    // would go straight on to `startDetached`. (The model-connection lookup
    // and key decryption used to be such a gap too; since H14c-3-1 they run
    // before `createSandbox`, ahead of both re-checks.) Re-read the durable status ONE more time, as the LAST
    // thing before `startDetached`, with NOTHING `await`ed between this
    // read resolving and the call below: Node runs single-threaded, so
    // once this `await` resolves, nothing else gets a turn to run until
    // `startDetached` has already been called -- a concurrent writer's
    // commit either lands before this read (and is seen here) or hasn't
    // landed yet at all (and is instead caught by `startAgentRun`'s own
    // final `pending -> running` CAS, whose loser always routes back
    // through `target.cancel` -- see startAgentRun.ts). This closes
    // every window that was previously open for the length of an
    // `await`, which is exactly what was still open after fix round 1's
    // single re-check.
    if (!(await this.isRunStillPending(run.accountId, run.id))) {
      bk.stoppedDirectly = true; // the cancel that follows must not stop (and re-measure) it again
      await this.stopAndMeasure(run, bk, handle, true);
      throw new DispatchAbortedError(run.id);
    }

    const hookToken = randomUUID();
    bk.hookToken = hookToken;

    const { hookFired, launched } = this.deps.sandboxPort.startDetached(handle, {
      onSession: (id) => this.recordSession(run, bk, id),
      runId: run.id,
      role: run.role,
      roleCard: run.roleCard,
      prompt: run.prompt,
      model: run.model,
      workdir: run.workdir,
      ...(run.cloneRepo && { clone: run.cloneRepo }),
      capUsd: perSpawnCapUsd(run),
      networkPolicy: networkPolicyRules,
      env,
      ...this.extensionOf(run, bk),
      ...(run.limits && { limits: run.limits }),
      onEvent,
      onStage,
    });
    // PR #85 fix round 3, must-fix 1 (CWE-367/362/672): mark that THIS
    // instance started an agent for this run, with nothing awaited
    // between `startDetached` above and this line -- Node is
    // single-threaded, so no concurrent code gets a turn to run in
    // between. Immediately after, check whether a cancel (or the queue
    // TTL's own cancel call) already reached THIS SAME instance before
    // `startDetached` returned -- e.g. the TTL firing and calling
    // `target.cancel()` on this instance while this call was still
    // awaiting `createSandbox` or the re-checks above. At the
    // time that cancel ran, `bk.started` was still false, so its own
    // direct-stop check (see `cancel` below) was a no-op; catch it here
    // instead, before this function does anything else. The re-checks
    // above already close every window up to the `startDetached` call
    // itself -- this closes the one AFTER it, which a third re-check
    // can't (nothing can be re-checked once the agent is already
    // starting; it has to be stopped instead).
    bk.started = true;
    if (bk.cancelRequested) {
      await this.directStop(run, bk); // the cancel that asked for this settles, then deletes
    }

    // Fire-and-forget (SandboxPort.startDetached's own contract): exactly
    // one of these two branches runs, and resumeHookOnce is idempotent,
    // so the hook is resumed exactly once either way (pass/fail 8).
    const finalizing = hookFired
      .then((lastEvent) => this.finalizeAndResume(run, buildTerminalReport(lastEvent, getSessionId(), bk.cumulativeModelUsd, snapshotOf(bk))))
      .catch((err: unknown) =>
        this.finalizeAndResume(run, buildAbortTerminalReport(abortOf(bk, err), getSessionId(), bk.cumulativeModelUsd, snapshotOf(bk))),
      );
    this.keepAlive(finalizing);
    // The agent command must exist before this invocation can end: whatever is still pending when a serverless
    // invocation returns is frozen, and a launch frozen half way leaves a sandbox with nothing running in it.
    await this.awaitAgentStart(run, bk, handle, launched);

    return { hookToken };
  }

  /** Hands the stream/finalize chain to the platform's keep-alive; a throwing hook can never fail the run. */
  private keepAlive(work: Promise<unknown>): void {
    try {
      this.deps.keepAlive?.(work);
    } catch (err) {
      // The stream runs on as without a hook, but on Vercel that means it is dropped at the freeze: say so.
      console.warn(JSON.stringify({ event: "run.keep_alive_failed" }));
      reportError(err, { stage: "run.keep_alive" });
    }
  }

  /**
   * Waits for the launch to put the agent command in the sandbox, at most the start window. A launch that fails or
   * outlives the window stops and measures the sandbox (the run never started, so the stream's finalize is switched
   * off) and throws `AgentStartError`, which `startAgentRun` turns into a failed run with a fixed reason.
   */
  private async awaitAgentStart(run: ExecutionRun, bk: RunBookkeeping, handle: SandboxHandle, launched: Promise<void> | undefined): Promise<void> {
    if (!launched) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cloneReason: CloneError["reason"] | undefined;
    let cloneDetail: CloneError["detail"];
    const outcome = await Promise.race([
      launched.then(
        () => "started" as const,
        (err: unknown) => {
          if (err instanceof CloneError) {
            cloneReason = err.reason;
            cloneDetail = err.detail;
          }
          return "failed" as const;
        },
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.deps.agentStartTimeoutMs ?? AGENT_START_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === "started") {
      console.info(JSON.stringify({ event: "run.agent_started", run_id: run.id }));
      return;
    }
    bk.hookResumed = true; // no agent ever ran: the stream's finalize must not write an outcome for it
    bk.stoppedDirectly = true; // the cancel that follows must not stop (and re-measure) it again
    await this.stopAndMeasure(run, bk, handle, true);
    // A failed clone adds its exit code and the redacted, capped end of git's output (operator log only: the run's
    // failure reason stays the fixed code). Without it a clone failure says nothing about why.
    console.warn(
      JSON.stringify({
        event: "run.agent_start_failed",
        run_id: run.id,
        reason: outcome,
        ...(cloneReason !== undefined && { clone_reason: cloneReason }),
        ...(cloneDetail !== undefined && { clone_exit_code: cloneDetail.exitCode, clone_output_tail: cloneDetail.tail }),
      }),
    );
    throw new AgentStartError(run.id, outcome === "timeout" ? "agent_start_timeout" : (cloneReason ?? "sandbox_error"));
  }

  /**
   * A run that is `running` but whose sandbox was stopped or deleted from outside never reaches its own finalize (the
   * stream that would call it is gone). Settles it as failed with `sandbox_stopped` through the normal `finalize`:
   * stop (a no-op on a stopped one), measure from the persisted session ids, status, reservations. Acts only on a
   * definite "stopped"/"gone" from the provider; a running sandbox or any doubt changes nothing.
   */
  async settleIfLost(run: ExecutionRun): Promise<LostRunOutcome> {
    let handle: SandboxHandle;
    try {
      handle = { runId: run.id, sandboxName: sandboxNameFor({ role: run.role, runId: run.id, accountId: run.accountId, repoId: run.repoId, pr: run.pr }) };
    } catch {
      // fx-swallow-ok: a run whose sandbox cannot be named has nothing to look at; it stays for the follower's watchdog
      return "unknown";
    }
    // One look: the provider FIRST, the run's row second. The run's own finalize records its stop before it asks the
    // provider to stop, so a provider that already reports "stopped" guarantees the row read after it shows that mark.
    const look = async (): Promise<"lost" | LostRunOutcome> => {
      const state = (await this.deps.sandboxPort.sandboxState?.(handle)) ?? "unknown";
      if (state === "running") return "alive";
      if (state === "unknown") return "unknown";
      const { rows } = await this.withAccount(run.accountId, (client) =>
        client.query<{ status: string; stopped: Date | null }>(
          `SELECT status, sandbox_stopped_at AS stopped FROM agent_runs WHERE account_id = $1 AND id = $2`,
          [run.accountId, run.id],
        ),
      );
      if (rows[0]?.status !== "running") return "alive"; // not ours to settle (already over, or not started)
      // A stop WE recorded is the run's own finalize at work (it stops the sandbox and writes the outcome after):
      // leave it that long, so a stopped sandbox is never taken for a lost one while a real result is being written.
      if (rows[0].stopped !== null && Date.now() - rows[0].stopped.getTime() < OWN_STOP_GRACE_MS) return "alive";
      // A persistent role's name is shared by every run on the PR: a newer run owns it, and its state says nothing about this one.
      if (isPersistentRole(run.role) && !(await this.stillOwnsSandbox(run).catch(() => false))) return "unknown";
      return "lost";
    };
    // The same definite answer must come twice, a few seconds apart: one odd answer (a credential or team mix-up that
    // makes every sandbox read 404, a provider hiccup) must never settle a healthy run, and a finalize that was mid-way
    // has recorded its stop by the second look.
    const first = await look();
    if (first !== "lost") return first;
    await new Promise((resolve) => setTimeout(resolve, this.deps.lostConfirmDelayMs ?? LOST_CONFIRM_DELAY_MS));
    const second = await look();
    if (second !== "lost") return second;
    await this.finalize(run, { status: "failed", failureReason: "sandbox_stopped" });
    return "settled";
  }

  /** X-4: the port's policy = the composition root's inputs + the runner's own meter and event write. */
  private extensionOf(run: ExecutionRun, bk: RunBookkeeping): { extension?: ExtensionPolicy } {
    const input = this.deps.extensionPolicyFor?.(run);
    if (!input) return {};
    return {
      extension: {
        ...input,
        meteredUsd: () => bk.cumulativeModelUsd,
        onExtended: async (e) => {
          bk.extensionsUsed = e.extensionsUsed;
          await recordLimitExtended(this.deps.pool, { accountId: run.accountId, runId: run.id, ...e });
        },
      },
    };
  }

  /**
   * D#2 H09b2 (C10's revised criterion 5, H09.9): "`resume` uses the same
   * sandbox name and `--resume <cc_session_id>` from `agent_runs`. When
   * the snapshot has expired (fake: `NotFound`), it falls back to a fresh
   * executor seeded with the PR diff." The "fresh executor seeded with the
   * PR diff" fallback is simply THIS SAME `dispatch()` -- `run.prompt` is
   * whatever the caller (`resumeAgentRun.ts`) already built, PR diff
   * included; this package has no GitHub access to seed one itself.
   */
  async resume(run: ExecutionRun, sessionId: string): Promise<{ hookToken: string }> {
    assertMeterableModel(run.model);
    const bk = this.bookkeeping(run.id);
    const payerAccountId = this.payerFor(run);
    const sandboxName = sandboxNameFor({
      role: run.role,
      runId: run.id,
      accountId: run.accountId,
      repoId: run.repoId,
      pr: run.pr,
    });
    const handle: SandboxHandle = { runId: run.id, sandboxName };
    bk.handle = handle;

    const { networkPolicyRules, env } = await this.buildRunMaterials(run, payerAccountId);
    const { onEvent, onStage, getSessionId } = await this.buildMeteredOnEvent(run, payerAccountId, handle, bk);

    let startResult: StartDetachedResult;
    await this.markRequested(run, sandboxName);
    try {
      startResult = this.deps.sandboxPort.resume(handle, sessionId, run.prompt, {
        onSession: (id) => this.recordSession(run, bk, id),
        runId: run.id,
        role: run.role,
        roleCard: run.roleCard,
        prompt: run.prompt,
        model: run.model,
        workdir: run.workdir,
        capUsd: perSpawnCapUsd(run),
        networkPolicy: networkPolicyRules,
        env,
        ...this.extensionOf(run, bk),
        ...(run.limits && { limits: run.limits }),
        onEvent,
        onStage,
      });
    } catch (err) {
      if (err instanceof SandboxNotFoundError) {
        // H09.9's own fallback: the snapshot is gone, so there is nothing
        // to resume -- dispatch a fresh sandbox under this same run
        // instead of failing the whole fix round.
        return this.dispatch(run);
      }
      throw err;
    }

    const hookToken = randomUUID();
    bk.hookToken = hookToken;
    const { hookFired, launched } = startResult;
    const finalizing = hookFired
      .then((lastEvent) =>
        this.finalizeAndResume(run, buildTerminalReport(lastEvent, getSessionId() ?? sessionId, bk.cumulativeModelUsd, snapshotOf(bk))),
      )
      .catch((err: unknown) =>
        this.finalizeAndResume(
          run,
          buildAbortTerminalReport(abortOf(bk, err), getSessionId() ?? sessionId, bk.cumulativeModelUsd, snapshotOf(bk)),
        ),
      );
    this.keepAlive(finalizing);
    await this.awaitAgentStart(run, bk, handle, launched);

    return { hookToken };
  }

  /**
   * D#2 H09b2 (C10's revised criteria 2/4, H09.5/H09.8): the model-usage
   * event handler shared by `dispatch` and `resume`. Returns `getSessionId`
   * alongside the callback so the caller can read the sandbox-reported
   * session id once the run finishes, without a second shared mutable
   * field.
   *
   * Fix round 1 (S-MUST 2, CWE-362): no more up-front, dispatch-time
   * month-to-date snapshot held for the run's whole life -- see
   * `meterModelUnderLock` below for why, and for the bound this now
   * achieves against concurrent siblings of the same tenant.
   */
  private async buildMeteredOnEvent(
    run: ExecutionRun,
    payerAccountId: string,
    handle: SandboxHandle,
    bk: RunBookkeeping,
  ): Promise<{
    onEvent: (event: NormalizedEvent) => Promise<void>;
    onStage: (stage: "sandbox_ready" | "cloned") => void;
    getSessionId: () => string | undefined;
  }> {
    let sessionId: string | undefined;
    // This command's own meter. A resumed command reports usage from zero,
    // so its priced total sits on top of what earlier commands metered.
    const usageMeter = createUsageMeter();

    const output = (bk.output ??= new AgentOutputRecorder(this.deps.pool, run.accountId, run.id));
    const progress = (bk.progress ??= new RunProgressRecorder(this.deps.pool, run.accountId, run.id));

    const meterEvent = async (event: NormalizedEvent): Promise<void> => {
      sessionId = event.sessionId ?? sessionId;

      // H09.5: a fake model response of 401/402/403 stops the run.
      const failureCode = detectModelFailure(event);
      if (failureCode !== undefined) {
        bk.abort = { kind: "model_key_broken", code: failureCode };
        this.deps.sandboxPort.stop(handle).catch(() => {});
        throw new RunAbortSignal(bk.abort);
      }

      // H09.8: mid-run kill on the per-spawn cap or the model budget. The
      // compute leg is exercised only once a caller starts reporting
      // compute usage on the event stream; the model leg alone covers
      // pass/fail 4. The meter (C46 MP-MSG) turns lines into a monotonic
      // token total keyed by message id, and only a rise reaches the
      // Postgres round trip. The model is known: `admit` and
      // `assertMeterableModel` refuse any other (MP-MODEL). Every usage
      // event of an admitted run is metered whatever the spend fields say:
      // the per-spawn cap always applies, the monthly leg only when a
      // budget exists, so the sandbox never sets its own spend figure.
      if (event.usage) {
        // Each line's raise is priced as it arrives (the meter bounds it,
        // MP-PLAUS/S7), so the total is the sum of priced raises.
        const rise = usageMeter.observeRise(event);
        for (const flag of usageMeter.flags()) bk.meterFlags.add(flag);
        const implausible = usageMeter.implausible();
        if (rise === undefined && !implausible) return;
        // W2: a message is priced at the dearer of the run's model and the
        // one it claims, so a forged claim can only raise the figure.
        const priced = pricedModel(run.model as ModelId, event.type === "assistant" ? event.messageModel : undefined);
        if (priced.unknown) bk.meterFlags.add("unknown_message_model");
        // Tokens are held per priced model and each model's total is priced
        // whole, so a single-model run prices exactly as the total does.
        if (rise !== undefined) bk.meteredTokens = addTotals(bk.meteredTokens, rise.delta);
        const bucket = addTotals(bk.modelTokens.get(priced.model) ?? ZERO_TOKENS, rise?.delta ?? ZERO_TOKENS);
        bk.modelTokens.set(priced.model, bucket);
        let otherModelsUsd = 0;
        for (const [model, tokens] of bk.modelTokens) if (model !== priced.model) otherModelsUsd += computeModelUsd(model, tokens);
        const result = await this.meterModelUnderLock(
          payerAccountId,
          run.id,
          priced.model,
          bucket,
          otherModelsUsd,
          perSpawnCapUsd(run),
          bk.operatorSubscription === true ? Number.POSITIVE_INFINITY : (run.spend.monthlyModelBudgetUsd ?? Number.POSITIVE_INFINITY),
          implausible,
          bk.operatorSubscription === true,
        );
        bk.cumulativeModelUsd = result.cumulativeUsd;
        if (result.decision === "kill") {
          // Same test as `meter()`: a per-run cap kill is resumable
          // (LIMIT-END) and counts as such when both bounds tripped; a
          // monthly-budget kill is not. A kill on implausible usage alone
          // is neither: the run failed.
          const overCap = result.cumulativeUsd > perSpawnCapUsd(run);
          const overMonth = result.spendKill;
          bk.abort = overCap
            ? { kind: "spend_kill", cause: "per_run_cap", limit: { kind: "per_run_usd", limit: perSpawnCapUsd(run), observed: result.cumulativeUsd } }
            : overMonth
              ? { kind: "spend_kill", cause: "monthly_budget" }
              : { kind: "implausible" };
          this.deps.sandboxPort.stop(handle).catch(() => {});
          throw new RunAbortSignal(bk.abort);
        }
      }
    };

    // H14c-3-2c: output persistence never delays metering or the kill. The text is handed to the recorder first, but
    // only awaited (its bounded backpressure) once metering has passed; a kill throws out of `meterEvent` unawaited.
    const onEvent = async (event: NormalizedEvent): Promise<void> => {
      progress.observe(event); // synchronous and never throws: the writes run behind the stream
      const stored = event.type === "assistant" && event.text ? output.record(event.text) : undefined;
      await meterEvent(event);
      await stored;
    };

    return { onEvent, onStage: (stage) => progress.stage(stage), getSessionId: () => sessionId };
  }

  /**
   * D#2 H09b2 fix round 1 (S-MUST 1 + S-MUST 2): a fresh, lock-protected
   * mid-run cap check, replacing a stale dispatch-time snapshot. Takes the
   * SAME advisory lock (same key) `reserveWith` takes, reads
   * `monthToDateUsd` fresh inside it, decides with `meter()`, and on
   * "kill" settles this run's real cost (same transaction) instead of
   * leaving it for `finalize` to release later.
   *
   * Bound achieved: racers serialize one at a time under the lock instead
   * of all reading the same stale total, so overshoot is bounded by at
   * most one in-flight event per concurrently-racing run -- not the
   * unbounded, whole-dispatch-lifetime staleness this replaces. See PR
   * description for the full writeup.
   */
  private async meterModelUnderLock(
    payerAccountId: string,
    runId: string,
    model: ModelId,
    usage: TokenTotals,
    cumulativeUsdSoFar: number,
    perSpawnCapUsd: number,
    monthlyBudgetUsd: number,
    forceKill = false,
    operator = false,
  ): Promise<{ cumulativeUsd: number; decision: "continue" | "kill"; spendKill: boolean }> {
    return this.withAccount(payerAccountId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${payerAccountId}:model`]);
      const freshMonthToDateUsd = await monthToDateUsd(client, payerAccountId, "model", new Date());
      const metered = meter({
        model,
        usage,
        cumulativeUsdSoFar,
        perSpawnCapUsd,
        monthToDateUsd: freshMonthToDateUsd,
        monthlyBudgetUsd,
      });
      // Priced raises are 4 dp each; keep the running sum at 4 dp too.
      const cumulativeUsd = Math.round(metered.cumulativeUsd * 10_000) / 10_000;
      const spendKill = metered.decision === "kill" || cumulativeUsd > perSpawnCapUsd;
      const kill = spendKill || forceKill;
      // A forced kill with nothing metered yet has nothing to settle (the
      // reservation, if any, is released by `finalize`).
      if (kill && (spendKill || cumulativeUsd > 0)) {
        await settleWith(client, {
          accountId: payerAccountId,
          runId,
          entries: [modelLedgerEntry(operator, cumulativeUsd)],
        });
      }
      return { cumulativeUsd, decision: kill ? ("kill" as const) : ("continue" as const), spendKill };
    });
  }

  /** The model-connection/firewall-policy/env triple `dispatch` and
   * `resume` both need before calling `startDetached`/`resume` on the
   * port -- factored out so `resume` does not re-derive it by hand. */
  private async buildRunMaterials(
    run: ExecutionRun,
    payerAccountId: string,
  ): Promise<{ networkPolicyRules: Awaited<ReturnType<typeof buildFirewallPolicy>>; env: Record<string, string> }> {
    // The operator exception: our own subscription, for our own accounts only. The token lives in this
    // local for the length of the policy build; the sandbox gets a placeholder and no connection row is read.
    const operatorToken = this.deps.operatorToken?.(run.accountId, payerAccountId);
    const bk = this.bookkeeping(run.id);
    if (operatorToken !== undefined) {
      const networkPolicyRules = await buildOperatorFirewallPolicy(
        operatorToken,
        { role: run.role, product: run.product, phase: "run" },
        { githubForward: this.deps.githubForward, lookup: this.deps.lookup },
      );
      bk.operatorSubscription = true;
      return { networkPolicyRules, env: buildSandboxEnv(run.role, "operator_subscription") };
    }
    bk.operatorSubscription = false;
    const { provider, encryptedKey, connectionId } = await this.deps.modelConnection.get(payerAccountId);
    const networkPolicyRules = await buildFirewallPolicy(
      this.deps.decryptTenantKey,
      { role: run.role, product: run.product, provider, encryptedKey, keyContext: { accountId: payerAccountId, connectionId }, phase: "run" },
      { githubForward: this.deps.githubForward, lookup: this.deps.lookup },
    );
    const env = buildSandboxEnv(run.role);
    return { networkPolicyRules, env };
  }

  /**
   * D#2 H09b2 (C10's revised criteria 2-4, H09.5/H09.7/H09.8): the
   * ONE place a dispatched run's outcome is written once its hook has
   * resumed (or a caller decided the outcome some other way, e.g. the
   * post-dispatch watchdog's own `writeRunStatus(..., "timed_out")` in
   * `workflows/agentRun.ts`, which calls `cancel`, not this method). Writes
   * the final `agent_runs.status`/result columns via the SAME CAS writer
   * every other H09b write goes through, then settles or releases
   * whatever `admit` reserved -- the actual model usd when known (H09.5/
   * H09.8's aborted runs still report SOME usage via `TerminalReport.usd`),
   * a plain release otherwise. For `model_key_broken`, also marks the
   * connection broken (401/403 only) and pauses the tenant's other queued
   * runs -- sec-criteria/H09 pass/fail 5's own wording.
   */
  async finalize(run: ExecutionRun, report: TerminalReport): Promise<CancelResult> {
    const payerAccountId = this.payerFor(run);

    // CS-1: the run is over, so stop its VM now (it used to run to the sandbox timeout): stop, measure, delete.
    const measured = await this.endSandbox(run);

    // H14c-3-2c: output rows (and the one "capped" row, if any) land before the terminal status row.
    await this.runs.get(run.id)?.output?.finish();
    await this.runs.get(run.id)?.progress?.finish();

    const operatorRun = this.isOperatorRun(run, payerAccountId);
    const metering = report.metering ?? { meteredUsd: null, reportedUsd: null, flags: ["no_metering"] };
    const write = await writeRunStatus(this.deps.pool, {
      accountId: run.accountId,
      runId: run.id,
      from: "running",
      to: report.status,
      failureReason: report.failureReason,
      // CARRY-17: a report with no metering block still leaves a row, flagged. An operator run is flagged
      // too (which mode ran), and one that the model host rejected says so.
      metering: operatorRun
        ? { ...metering, flags: [...metering.flags, "operator_subscription", ...(report.failureReason === "model_key_broken" ? ["operator_token_rejected"] : [])] }
        : metering,
      result: {
        envelope: report.envelope,
        tokensIn: report.tokensIn,
        tokensOut: report.tokensOut,
        usd: report.usd,
        sessionId: report.sessionId,
      },
      // LIMIT-END (C48): a limit that ended the run leaves a checkpoint, in
      // the same transaction as the status change.
      ...(report.limit
        ? { checkpoint: { kind: report.limit.kind, ccSessionId: report.sessionId ?? null, meteredUsd: report.usd ?? 0, extensionsUsed: report.extensionsUsed ?? 0 } }
        : report.agentCheckpoint
          ? {
              checkpoint: {
                reason: "agent_checkpoint" as const,
                summary: report.agentCheckpoint.summary,
                ccSessionId: report.sessionId ?? null,
                meteredUsd: report.usd ?? 0,
                extensionsUsed: report.extensionsUsed ?? 0,
              },
            }
          : {}),
    });

    if (write.updated && report.failureReason === "model_key_broken" && !operatorRun) {
      const code = brokenConnectionCodeFor(report);
      if (code !== undefined) {
        await this.deps.connectionStatus.markBroken(run.id, code);
      }
      await pauseQueuedRuns(this.deps.pool, run.accountId, run.id);
    }
    // An operator run has no tenant connection to mark broken and no tenant queue to pause: a rejected
    // operator token is ours to rotate (see the owner notes in docs/ops/staging.md), and the run's row
    // above carries the `operator_token_rejected` flag so the failure reads as ours, not the customer's.

    await this.settleOpenRows(payerAccountId, run, report.usd, { deadlinePassed: false, measured });

    // D#2 H09b2, C21 item 1's OTHER half: `finalize` is the normal
    // (non-cancelled) completion path, and it always runs AFTER the hook
    // has resumed (the caller only has a `TerminalReport` to pass here
    // because the hook already delivered one) -- so pruning is
    // unconditionally safe at this point, for the SAME reason `cancel()`'s
    // own `bk.hookResumed` branch is. Without this, a run nobody ever
    // cancels (the common case) would keep its `bk` in `this.runs` for the
    // life of the instance, since `cancel()` is the only other pruning
    // site and it may never be called.
    const bk = this.runs.get(run.id);
    if (bk && this.runs.get(run.id) === bk) {
      this.runs.delete(run.id);
    }

    return this.totalsFor(payerAccountId, run.id);
  }

  /**
   * D#2 H09b2 fix round 1 (S-MUST 1): shared by `finalize`/`cancel` --
   * settle a still-open 'model' row for whatever this run actually
   * metered instead of releasing it (which writes no ledger row at all).
   * `meteredUsd` undefined means nothing was ever metered.
   *
   * Fix round 2 (double-settle race, CWE-362/840): `finalize()`'s and
   * `cancel()`'s own "read open rows, then settle" sequence used to run
   * outside any lock, in its own transaction, against a `rows` snapshot
   * the CALLER had already read earlier -- so a same-instant metered kill
   * (`meterModelUnderLock`, which settles under
   * `pg_advisory_xact_lock(hashtextextended('accountId:model', 0))`) could
   * commit its own settle in the gap between that snapshot and this
   * method's own settle/release, and `settleWith`'s ledger INSERT is
   * unconditional -- both writers would insert a ledger row for the same
   * run+budget. Closed by taking the SAME lock here and re-reading
   * `spend_reservations` fresh, INSIDE it, instead of trusting a
   * pre-lock snapshot: whichever of {kill, cancel, finalize} gets there
   * first serializes the other out, and the loser's fresh read sees the
   * winner's already-committed state ('settled'/'released', never
   * 'open') and does nothing further.
   */
  private async settleOpenRows(
    payerAccountId: string,
    run: ExecutionRun,
    meteredUsd: number | undefined,
    compute: { deadlinePassed: boolean; measured?: SandboxSessionFigures[] },
  ): Promise<void> {
    const runId = run.id;
    await this.withAccount(payerAccountId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${payerAccountId}:model`]);
      const { rows } = await client.query<{ budget: Budget }>(
        `SELECT budget FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [payerAccountId, runId],
      );
      for (const row of rows) {
        if (row.budget !== "model") continue; // compute is never released: settleRunCompute below
        if (meteredUsd !== undefined) {
          await settleWith(client, {
            accountId: payerAccountId,
            runId,
            entries: [modelLedgerEntry(this.isOperatorRun(run, payerAccountId), meteredUsd)],
          });
        } else {
          await releaseWith(client, { accountId: payerAccountId, runId, budget: row.budget });
        }
      }
      // A metered run with no model reservation (no estimate was reserved)
      // has nothing above to settle, yet its spend is real: ledger it once.
      // The kill path's row (same lock) is what stops a second write.
      if (meteredUsd !== undefined && !rows.some((row) => row.budget === "model")) {
        const { rows: booked } = await client.query(
          `SELECT 1 FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model' LIMIT 1`,
          [payerAccountId, runId],
        );
        if (booked.length === 0) {
          await settleWith(client, {
            accountId: payerAccountId,
            runId,
            entries: [modelLedgerEntry(this.isOperatorRun(run, payerAccountId), meteredUsd)],
          });
        }
      }
    });
    await this.settleRunCompute(run, compute);
  }

  /**
   * D#2 COMPUTE-SETTLE CS-2a: closes this run's open compute reservation with ONE compute ledger row, never a
   * release. Everything it needs is PERSISTED on `agent_runs` (request marker, session ids, stop time, the in-VM
   * counters), so it works on a fresh instance; `opts.measured` is only a shortcut for the instance that just
   * measured. The cost is `sandboxRunCost`, floored at the reservation and never capped at it:
   *  - request marker never written: $0, 'no_sandbox';
   *  - 'measured': settled now;
   *  - any other tier: settled only once `deadlinePassed`; before that the row stays OPEN (still counting its
   *    reservation) and `compute_settle_due_at` is set for the CS-2b sweep.
   * `port.measure` is network I/O: no transaction or lock is held across it.
   *
   * CS-2b-1: returns whether THIS call wrote the ledger row (a concurrent writer's row is not ours). `opts.sweep` is
   * the deferred sweep calling: it deletes the stopped sandbox itself, and only when this call wrote
   * (`deleteSettledSandbox`), so this method leaves the sandbox alone.
   */
  async settleRunCompute(
    run: ExecutionRun,
    opts: { deadlinePassed: boolean; measured?: SandboxSessionFigures[]; sweep?: boolean },
  ): Promise<{ wrote: boolean }> {
    const payerAccountId = this.payerFor(run);
    const openComputeSql = `SELECT budget, usd_reserved::text AS usd_reserved FROM spend_reservations
                            WHERE account_id = $1 AND run_id = $2 AND state = 'open' AND budget <> 'model'`;
    const open = await this.withAccount(payerAccountId, (client) =>
      client.query<{ budget: Budget; usd_reserved: string }>(openComputeSql, [payerAccountId, run.id]),
    );
    if (open.rows.length === 0) {
      if (!opts.sweep) await this.deleteIfEphemeral(run, this.runs.get(run.id));
      return { wrote: false };
    }

    const state = await this.readSandboxState(run);
    // 'no_sandbox' ($0) needs proof that none was ever started: no request marker, or (once the settle deadline has
    // passed, so a creation still in flight is not mistaken for none) no session id AND the provider says it is not there.
    const none = state.requestedAt === null || (opts.deadlinePassed && state.sessionIds.length === 0 && !(await this.sandboxExists(run)));
    const covered = state.sessionIds.every((id) => opts.measured?.some((f) => f.sessionId === id));
    const figures = none ? [] : opts.measured && covered ? opts.measured : await this.measureRun(run, state);
    // The wall time ends at the recorded stop, never at the settle time: waiting for the figures is not billed.
    // The provider's own session durations win; our stop-minus-request is used only when one of them is missing.
    const ownWallMs = state.requestedAt && state.stoppedAt ? state.stoppedAt.getTime() - state.requestedAt.getTime() : undefined;
    const runWallMs = figures.length > 0 && figures.every((f) => f.durationMs !== undefined) ? undefined : ownWallMs;
    const priced = open.rows.map((row) => ({
      budget: row.budget,
      ...(none ? { usd: 0, basis: "no_sandbox" as const } : sandboxRunCost(figures, { reservedUsd: Number(row.usd_reserved), runWallMs })),
    }));
    if (!opts.deadlinePassed && priced.some((p) => p.basis !== "measured" && p.basis !== "no_sandbox")) {
      await this.markSandbox(run, { due: true });
      // D#454 H3c: tell the compute-settle cron this run is waiting (it skips ticks while nothing is marked).
      void markWorkPending("compute-settle-sweep");
      return { wrote: false };
    }

    let wrote = 0;
    await this.withAccount(payerAccountId, async (client) => {
      // The lock reserve() takes, one per budget in its sorted order; the open rows are re-read under it.
      for (const budget of [...new Set(priced.map((p) => p.budget))].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${payerAccountId}:${budget}`]);
      }
      const { rows } = await client.query<{ budget: Budget }>(openComputeSql, [payerAccountId, run.id]);
      for (const row of rows) {
        const cost = priced.find((p) => p.budget === row.budget);
        if (!cost) continue;
        wrote++;
        await settleWith(client, {
          accountId: payerAccountId,
          runId: run.id,
          entries: [{ budget: row.budget, actualUsd: cost.usd, source: "sandbox", computeBasis: cost.basis }],
        });
      }
    });
    // Settled; a failure to clear the mark only leaves a stale one (there is no open row left to settle).
    await this.markSandbox(run, { due: false }).catch(() => {});
    if (!opts.sweep) await this.deleteIfEphemeral(run, this.runs.get(run.id), state.requestedAt !== null);
    return { wrote: wrote > 0 }; // false: a concurrent writer closed the row first
  }

  /**
   * CS-2b-1: the deferred sweep's delete of a settled run's stopped ephemeral sandbox. A persistent role's sandbox is
   * never deleted here. Idempotent: "already gone" (a 404 or 410 from the port) is success; any other failure throws.
   * `backstop` is the delete made WITHOUT a settle: it never deletes a run with no recorded session id. Such a run
   * is settled at $0 only if the provider shows no sandbox, and a backstop delete would forge exactly that proof.
   */
  async deleteSettledSandbox(run: ExecutionRun, opts: { backstop?: boolean } = {}): Promise<void> {
    if (isPersistentRole(run.role)) return;
    if (opts.backstop && (await this.readSandboxState(run)).sessionIds.length === 0) return;
    let handle: SandboxHandle;
    try {
      handle = { runId: run.id, sandboxName: sandboxNameFor({ role: run.role, runId: run.id, accountId: run.accountId, repoId: run.repoId, pr: run.pr }) };
    } catch {
      return; // no identifiable sandbox
    }
    try {
      await this.deps.sandboxPort.deleteSandbox(handle);
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }

  /** Whether the provider still has this run's sandbox; a doubt of any kind (a throw, an unnameable run) is "exists". */
  private async sandboxExists(run: ExecutionRun): Promise<boolean> {
    try {
      const sandboxName = sandboxNameFor({ role: run.role, runId: run.id, accountId: run.accountId, repoId: run.repoId, pr: run.pr });
      return await this.deps.sandboxPort.sandboxExists({ runId: run.id, sandboxName });
    } catch {
      return true;
    }
  }

  /**
   * COMPUTE-SETTLE CS-2a: commits the "a sandbox is being requested" marker BEFORE the request, so a run with no marker
   * provably never asked for one ($0, 'no_sandbox'). It then re-checks the run is still pending: a cancel that read no
   * marker (and settled $0) had already committed its status, so it is seen here and nothing is created.
   */
  private async markRequested(run: ExecutionRun, sandboxName: string): Promise<void> {
    // The sandbox name goes in the same write (first-wins): the gh-proxy finds the run by it, so it must be stored
    // before the sandbox exists to make a request.
    await this.markSandbox(run, { requested: true, sandboxName });
    const { rows } = await this.withAccount(run.accountId, (client) =>
      client.query(`SELECT 1 FROM agent_runs WHERE account_id = $1 AND id = $2 AND status = 'pending'`, [run.accountId, run.id]),
    );
    if (rows.length === 0) throw new DispatchAbortedError(run.id);
  }

  /** The run's sandbox figures re-read from the provider by its PERSISTED session ids, with the persisted counters. */
  private async measureRun(run: ExecutionRun, state: SandboxState): Promise<SandboxSessionFigures[]> {
    let usage: SandboxSessionUsage[] = [];
    if (state.sessionIds.length > 0) {
      try {
        const sandboxName = sandboxNameFor({ role: run.role, runId: run.id, accountId: run.accountId, repoId: run.repoId, pr: run.pr });
        usage = await this.deps.sandboxPort.measure({ runId: run.id, sandboxName }, state.sessionIds);
      } catch {
        // Unreadable now: the figures stay missing, so the deferred settle tries again and then takes a lower tier.
      }
    }
    return figuresOf(state.sessionIds, usage, state.selfMeasured);
  }

  /** The persisted half of the run's sandbox bookkeeping (the in-memory `bk` is lost with the instance). */
  private async readSandboxState(run: ExecutionRun): Promise<SandboxState> {
    const { rows } = await this.withAccount(run.accountId, (client) =>
      client.query<{ requested: Date | null; stopped: Date | null; ids: string[]; own: PersistedCounters | null }>(
        `SELECT sandbox_requested_at AS requested, sandbox_stopped_at AS stopped, sandbox_session_ids AS ids,
                sandbox_self_measured AS own
           FROM agent_runs WHERE account_id = $1 AND id = $2`,
        [run.accountId, run.id],
      ),
    );
    const row = rows[0];
    return { requestedAt: row?.requested ?? null, stoppedAt: row?.stopped ?? null, sessionIds: row?.ids ?? [], selfMeasured: row?.own ?? null };
  }

  /** One first-wins write of the run's persisted sandbox bookkeeping (`agent_run_sandbox_mark`, runner login only). */
  private async markSandbox(
    run: ExecutionRun,
    mark: { requested?: boolean; sessionId?: string; stopped?: boolean; selfMeasured?: PersistedCounters; due?: boolean; sandboxName?: string },
  ): Promise<void> {
    await this.withAccount(run.accountId, (client) =>
      client.query("SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, $3::boolean, $4::text, $5::boolean, $6::jsonb, $7::boolean, $8::text)", [
        run.accountId,
        run.id,
        mark.requested ?? false,
        mark.sessionId ?? null,
        mark.stopped ?? false,
        mark.selfMeasured ? JSON.stringify(mark.selfMeasured) : null,
        mark.due ?? null,
        mark.sandboxName ?? null,
      ]),
    );
  }

  /**
   * D#2 H09b2, C21 item 1 (PR #85 fix round follow-up, CWE-401/754): reads
   * `this.runs` -- it does NOT call `this.bookkeeping()`, which would
   * silently RE-CREATE an entry `cancel()` already pruned, with no
   * `hookToken` recorded, so a hook that fires after cancel found nothing
   * to resume (measured: 0 of 20 resumed with a 20 ms delay). Reading the
   * map directly instead means a MISSING entry is simply "nothing to do"
   * (dispatch never ran for this run on this instance, or the entry was
   * already pruned by THIS method after a prior resume), never a reason to
   * fabricate a fresh one.
   *
   * Pruning now happens HERE, once the hook has actually resumed, not in
   * `cancel()` -- see `cancel()`'s own comment for why: pruning eagerly
   * there is exactly what dropped a late-firing hook's `hookToken`.
   */
  private async finalizeAndResume(run: ExecutionRun, report: TerminalReport): Promise<void> {
    const bk = this.runs.get(run.id);
    if (!bk || bk.hookResumed || !bk.hookToken) return;
    bk.hookResumed = true;
    // P2: this process holds what finalize needs (the output recorder, the meter total, the measurement), so it finalizes
    // BEFORE it wakes anyone. A run already ended by a cancel is not finalized again. If finalize fails the hook is NOT
    // resumed (the run is still `running`, so waking the follower with a terminal status would be a lie): the follower's
    // watchdog ends it. Nothing escapes: this runs at the end of a floating chain, where a rejection would be an unhandled
    // one that can take down a function instance shared with other tenants' runs. The log line is a fixed code and the
    // run id; the error itself is dropped because its text can carry statement text or model output.
    try {
      if (this.deps.finalizeBeforeResume === false) {
        await this.deps.hooks.resume(bk.hookToken, { ...report, runId: run.id });
      } else {
        await this.untilRunning(run);
        if (!bk.cancelled) await this.finalize(run, report);
        await this.deps.hooks.resume(bk.hookToken, { runId: run.id, status: report.status });
      }
    } catch {
      console.warn(JSON.stringify({ event: "run.finalize_or_resume_failed", run_id: run.id }));
    }
    // Pruning does NOT happen here (a prior fix round's mistake this PR
    // reverts): `bk.started`/`bk.stoppedDirectly`/`bk.handle` must survive
    // a hook that resolves EARLY -- a zero-event fixture run, say -- for as
    // long as `cancel()` (via `startAgentRun`'s own final `pending ->
    // running` CAS-loser path, its own safety net for exactly this race)
    // might still be called on THIS SAME instance afterwards. Pruning
    // here, unconditionally, once made that later `cancel()` call
    // reconstruct an empty `bk` (`started: false`) and skip its own
    // direct-stop entirely -- the dispatched agent was then left running.
    // `cancel()` and `finalize()` below are the two places that actually
    // prune, once `bk.hookResumed` is already true by the time either
    // runs, matching that this class's ONE piece of not-yet-durable state
    // is safe to drop only once nothing will read it again.
  }

  /**
   * `dispatch` returns when the agent command exists, and `startAgentRun` writes `pending -> running` after that. An agent
   * that ends in the meantime (it fails at once) would be finalized against a run still `pending`, whose compare-and-set
   * from `running` then loses and leaves the run `running` for good. So a finish waits (bounded) until the run has left
   * `pending`; in the common case it already has and this is one read.
   */
  private async untilRunning(run: ExecutionRun): Promise<void> {
    for (let waited = 0; waited < PENDING_WAIT_MS && (await this.isRunStillPending(run.accountId, run.id)); waited += PENDING_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
    }
  }

  /** PR #85 fix round item 1: reads the run's own durable `agent_runs.status`
   * -- the CAS writer's column, not this instance's in-memory `bk` (a
   * fresh instance racing the same run must see the same answer). `true`
   * only for the exact value `dispatch` was called under; any other
   * status (a row that doesn't exist yet is defensively treated the same
   * as "not pending") means something else already moved this run away. */
  private async isRunStillPending(accountId: string, runId: string): Promise<boolean> {
    const { rows } = await this.withAccount(accountId, (client) =>
      client.query<{ status: string }>(`SELECT status FROM agent_runs WHERE account_id = $1 AND id = $2`, [
        accountId,
        runId,
      ]),
    );
    return rows[0]?.status === "pending";
  }

  /** PR #85 fix round 4, must-fix 1 (CWE-672/664): true only when THIS
   * run still owns whatever sandbox its name resolves to, i.e. it is
   * still safe for THIS run's `cancel()` to stop that sandbox directly.
   * Read fresh against the durable row every call, like
   * `isRunStillPending` above -- never `bk`, so a fresh instance racing
   * the same run sees the same answer a shared one does.
   *
   * Two checks:
   *
   * - The run's own durable status must not already be `succeeded` or
   *   `failed` -- the two terminal outcomes something OTHER than this
   *   very `cancel()` call could have already committed (a watchdog, a
   *   test harness, a future H09b2 writer). `cancelled` and `timed_out`
   *   are deliberately EXCLUDED: `cancelRun.ts`'s own status write (and
   *   `startAgentRun.ts`'s TTL/lost-race paths) commits one of THOSE to
   *   THIS SAME run's row, durably, immediately BEFORE calling
   *   `target.cancel` -- treating either as "someone else already
   *   finished it" would make every legitimate cancel of a still-live
   *   run refuse to stop its own sandbox.
   * - For a persistent role (the only role whose sandbox name is SHARED
   *   across runs -- sandboxNaming.ts), no OTHER `pending`/`running` run
   *   with the same role/account/repo/PR may have been created at or
   *   after this one -- that run, not this one, now owns the shared
   *   name. `run.repoId`/`run.pr` are read from the `ExecutionRun`
   *   itself, not re-queried: `dispatch` already required both (non-
   *   optional for a persistent role -- `sandboxNameFor` throws
   *   otherwise) before it could ever set `bk.started`, which is this
   *   check's own caller-side guard.
   */
  private async stillOwnsSandbox(run: ExecutionRun): Promise<boolean> {
    const statusRows = await this.withAccount(run.accountId, (client) =>
      client.query<{ status: string }>(`SELECT status FROM agent_runs WHERE account_id = $1 AND id = $2`, [
        run.accountId,
        run.id,
      ]),
    );
    const status = statusRows.rows[0]?.status;
    if (status === "succeeded" || status === "failed") {
      return false;
    }

    if (!isPersistentRole(run.role)) {
      return true;
    }

    return !(await this.hasNewerLiveSibling(run));
  }

  /**
   * True when another `pending`/`running` run of this persistent role/account/repo/PR was created at or after `run`: that run, not
   * this one, owns the shared sandbox name. The one test `stillOwnsSandbox` and `stopStraySandbox` both use.
   */
  private async hasNewerLiveSibling(run: ExecutionRun): Promise<boolean> {
    const newerRows = await this.withAccount(run.accountId, (client) =>
      client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM agent_runs
           WHERE account_id = $1
             AND role = $2
             AND dispatch_repo_id = $3
             AND dispatch_pr_number = $4
             AND status IN ('pending', 'running')
             AND id <> $5
             AND created_at >= (SELECT created_at FROM agent_runs WHERE account_id = $1 AND id = $5)
         ) AS exists`,
        [run.accountId, run.role, run.repoId, run.pr, run.id],
      ),
    );
    return newerRows.rows[0]?.exists === true;
  }

  /**
   * D#2 SANDBOX-REAPER (C81 criterion 7): stops a sandbox the provider still shows running although `run`, the newest run
   * that named it, has ended. Returns false (and stops nothing) when a newer live run of the same persistent role/account/repo/PR now
   * owns the name (the ownership test `cancel` and `endSandbox` use), true once the stop was asked for.
   * It is `cancel`'s direct-stop half only: it stops and records the stop, so a settle that is still owed can read the sandbox,
   * and it releases and settles nothing (any compute settle stays with `settleRunCompute`). The sandbox is deleted by a later pass.
   */
  async stopStraySandbox(run: ExecutionRun): Promise<boolean> {
    let handle: SandboxHandle;
    try {
      handle = { runId: run.id, sandboxName: sandboxNameFor({ role: run.role, runId: run.id, accountId: run.accountId, repoId: run.repoId, pr: run.pr }) };
    } catch {
      // fx-swallow-ok: a run that cannot name a sandbox has none to stop; false tells the caller nothing was stopped
      return false;
    }
    if (await this.hasNewerLiveSibling(run)) return false;
    await this.stopAndMeasure(run, freshBookkeeping(), handle, true);
    return true;
  }

  async cancel(run: ExecutionRun): Promise<CancelResult> {
    const bk = this.bookkeeping(run.id);
    const payerAccountId = this.payerFor(run);

    // PR #85 fix round 3, must-fix 1 (CWE-367/362/672): mark a cancel
    // requested on THIS instance's bookkeeping FIRST -- before the
    // cached-result short-circuit below and before the reservation gate
    // further down. If THIS instance already called `startDetached` for
    // this run (`bk.started`), stop the sandbox directly right now,
    // rather than relying on the reservation-gated stop below, which a
    // competing writer that already committed between `dispatch`'s
    // second re-check and its own `startDetached` call may have emptied
    // by the time this reaches it. `dispatch` makes the mirror-image
    // check right after its own `startDetached` call, for a cancel that
    // reached this SAME instance first (e.g. the queue TTL's own
    // `cancel`, which always runs on the instance that called `dispatch`
    // -- see startAgentRun.ts). `directStop` is idempotent
    // (`bk.stoppedDirectly`), so a repeat `cancel()` call re-checking
    // this is harmless.
    //
    // PR #85 fix round 4, must-fix 1 (security re-review of a12153d;
    // CWE-672/664): `bk.started` alone is not enough. Nothing ever
    // cleared it (fixed below too -- see the pruning at the end of this
    // method and in `resumeHookOnce`), so it stayed true for the rest of
    // THIS instance's life once set, regardless of what happened to the
    // run afterwards. For a persistent role (the executor), the sandbox
    // NAME is shared by every run ever dispatched for the same account/
    // repo/PR (sandboxNaming.ts) -- so a finished run R1's `bk.started`
    // was still true when a routine, unprivileged action re-cancelled it
    // (a second click, a client retry, a cleanup sweep), and the direct
    // stop below went ahead and stopped R2, a NEWER run on the same PR
    // that now legitimately owns that name, while R2's own row still
    // said `running`. `stillOwnsSandbox` closes that: it is read fresh
    // against the durable row (never `bk`), so a fresh instance racing
    // the same run sees the same answer this one does.
    bk.cancelRequested = true;
    if (bk.started) {
      // D#2 H09b2, C21 item 3 (PR #85 final security review, informational
      // 1; CWE-755): fail SAFE, not fail open. Before this fix, an
      // ownership-query error (a transient DB error) threw straight out of
      // this `if`, so NO stop ever ran for this call -- the exact opposite
      // of what a cancel is for. Stop first, unconditionally, whenever the
      // ownership check cannot be answered; only skip the stop when the
      // check ANSWERS "no" (a newer sibling now legitimately owns the
      // shared name).
      let stillOwns: boolean;
      try {
        stillOwns = await this.stillOwnsSandbox(run);
      } catch (err) {
        await this.directStop(run, bk);
        throw err;
      }
      if (stillOwns) await this.directStop(run, bk);
    }

    if (bk.cancelled && bk.cachedCancelResult) {
      return bk.cachedCancelResult;
    }

    // Durable idempotency signal, NOT the in-memory `bk` above (a fresh
    // instance resolving the same run must behave the same): "has
    // anything admit() opened for this run still not been closed?" A
    // repeat call finds no open rows, so `stop` runs at most once
    // (contract test: "stops the work only once").
    const openRows = await this.withAccount(payerAccountId, (client) =>
      client.query<{ budget: Budget; usd_reserved: string }>(
        `SELECT budget, usd_reserved FROM spend_reservations
         WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
        [payerAccountId, run.id],
      ),
    );

    if (openRows.rows.length > 0) {
      // Sandbox name is a pure function of (role, runId, accountId,
      // repoId, pr) -- recomputing it means `cancel` never depends on
      // `dispatch` having run in THIS instance ("cancel before
      // dispatch", pass/fail 8). `SandboxPort.stop` is documented safe
      // on a never-created sandbox.
      //
      // PR #85 fix round 3, must-fix 1: skip this stop when the direct
      // one above already ran -- "stops exactly once" still holds. The
      // reservation release below still always runs regardless.
      //
      // PR #85 fix round item 4 (CWE-636/672): `run.repoId`/`run.pr` may
      // be missing (no persisted dispatch identity -- e.g. a pre-migration
      // executor row), in which case `sandboxNameFor` itself throws. Never
      // let that -- or `stop()` failing for any other reason -- block
      // releasing the reservations below: a run whose sandbox can't be
      // identified must still get its money back, not leak it forever
      // because `stop` never got a chance to run. Best-effort only.
      if (!bk.stoppedDirectly) {
        try {
          const handle: SandboxHandle =
            bk.handle ?? {
              runId: run.id,
              sandboxName: sandboxNameFor({
                role: run.role,
                runId: run.id,
                accountId: run.accountId,
                repoId: run.repoId,
                pr: run.pr,
              }),
            };
          await this.stopAndMeasure(run, bk, handle);
        } catch {
          // best-effort -- see comment above.
        }
      }
      // D#2 H09b2 fix round 1 (S-MUST 1): a cancelled/timed-out run (the
      // watchdog calls `cancel` directly, not `finalize`) may already have
      // metered real spend -- settle it instead of erasing it.
      //
      // Fix round 2: `openRows.rows` (read above, outside any lock) is
      // NOT passed through here -- `settleOpenRows` re-reads
      // fresh under the advisory lock itself now, so a concurrent
      // metered kill's own settle (same lock) is never raced past on a
      // stale snapshot. See that method's own comment.
      await this.settleOpenRows(payerAccountId, run, bk.cumulativeModelUsd > 0 ? bk.cumulativeModelUsd : undefined, {
        deadlinePassed: false,
        measured: bk.measurement,
      });
    } else if (bk.stoppedDirectly) {
      await this.deleteIfEphemeral(run, bk); // no compute row is waiting for this sandbox's figures
    }

    const totals = await this.totalsFor(payerAccountId, run.id);
    bk.cancelled = true;
    bk.cachedCancelResult = totals;

    // D#2 H09b2, C21 item 1 (PR #85 final security review, should-fix 2;
    // CWE-401/754): pruning here is now GATED on `!bk.hookToken ||
    // bk.hookResumed` -- never unconditional. Unconditional pruning (PR
    // #85 fix round 4's original shape) is exactly what dropped a hook
    // that fires AFTER cancel: a fresh, empty `bk` has no `hookToken` for
    // `resumeHookOnce` to resume. `bk.hookToken` unset means dispatch
    // never ran on this instance for this run -- nothing pending to
    // protect. `bk.hookResumed` true means the hook already fired (an
    // EARLY-resolving run, before this `cancel()` call reached it) and
    // `resumeHookOnce` deliberately left pruning to this method (see its
    // own comment) -- also nothing left to protect. When NEITHER holds
    // (dispatch ran here, and the hook has not resumed yet), this method
    // must NOT prune: `startAgentRun`'s own final `pending -> running`
    // CAS-loser path calls `cancel()` again, on this SAME instance, right
    // after `dispatch` returns -- exactly the race
    // `cancelRaceAfterSecondRecheck.pg.test.ts` drives -- and that second
    // call needs `bk.started`/`bk.handle` to still be here.
    if ((!bk.hookToken || bk.hookResumed) && this.runs.get(run.id) === bk) {
      this.runs.delete(run.id);
    }
    return totals;
  }

  /** PR #85 fix round 3, must-fix 1 (CWE-367/362/672): stops the sandbox
   * THIS instance started, directly by its known handle -- never by
   * recomputing the name and going through the reservation table, which
   * a competing writer may have already emptied by the time this runs
   * (see `cancel`'s and `dispatch`'s own comments for the two places
   * that call this). Idempotent per run via `bk.stoppedDirectly`: both
   * call sites can reach this for the same run, and it must actually
   * stop at most once either way. CS-1: it also measures, and no longer deletes
   * (`deleteIfEphemeral` does, after the measure). `bk.handle` is always set by this point:
   * `bk.started` (this method's only caller-side guard) is only ever
   * true after `dispatch` already set `bk.handle` earlier in the same
   * call. */
  private async directStop(run: ExecutionRun, bk: RunBookkeeping): Promise<void> {
    void run;
    if (bk.stoppedDirectly || !bk.handle) return;
    bk.stoppedDirectly = true;
    await this.stopAndMeasure(run, bk, bk.handle, true);
  }

  /**
   * D#2 COMPUTE-SETTLE CS-1/CS-2a: remembers a session this run launched, and when it began. The id is PERSISTED
   * first (the settle prices exactly the persisted ids, on any instance) and fails closed: a session nobody
   * recorded would be a hole in the run's measured cost.
   */
  private async recordSession(run: ExecutionRun, bk: RunBookkeeping, sessionId: string): Promise<void> {
    if (bk.sessionIds.includes(sessionId)) return;
    const write = this.markSandbox(run, { sessionId });
    bk.sessionWrites.push(write.catch(() => undefined));
    await write;
    if (bk.sessionIds.includes(sessionId)) return;
    bk.sessionIds.push(sessionId);
    bk.sessionStartedMs.set(sessionId, Date.now());
  }

  /**
   * CS-1: stops the sandbox, then measures exactly this run's sessions onto `bk.measurement`.
   * CS-1b: the VM's own counters are read first (bounded, never throws) to fill figures the provider
   * may not report. CS-2a: the session ids, the stop time and the counters come from / go to `agent_runs`, so a
   * fresh instance measures the same run, and a stop already recorded (by any instance) is not repeated unless forced.
   * None of it can fail or block the stop.
   */
  private async stopAndMeasure(run: ExecutionRun, bk: RunBookkeeping, handle: SandboxHandle, force = false): Promise<void> {
    const port = this.deps.sandboxPort;
    await Promise.all(bk.sessionWrites);
    const state = await this.readSandboxState(run).catch((): SandboxState => ({ requestedAt: null, stoppedAt: null, sessionIds: [], selfMeasured: null }));
    const ids = [...new Set([...state.sessionIds, ...bk.sessionIds])];
    let own: PersistedCounters | undefined;
    // `force` (the direct stop of an agent THIS instance started) stops again even when a cancel already recorded a stop.
    if (state.stoppedAt === null || force) {
      const counters = ids.length > 0 ? await port.readCounters(handle).catch(() => undefined) : undefined;
      // The stop is recorded BEFORE the provider stop: the lost-run check treats a sandbox this runner stopped as the
      // run's own finalize at work, so it must be able to see that the stop is ours the moment the provider reports it
      // stopped (otherwise it could settle a normally finishing run as lost). If the process dies between this write and
      // the stop, the sandbox runs on to its own timeout, which is bounded.
      if (state.requestedAt !== null) await this.markSandbox(run, { stopped: true }).catch(() => reportError(new Error("stop mark failed"), { stage: "run.stop_mark" }));
      try {
        await port.stop(handle);
      } catch {
        // best-effort -- matches the reservation-gated stop's own handling.
      }
      const last = ids[ids.length - 1];
      const started = last === undefined ? undefined : bk.sessionStartedMs.get(last);
      // Only the last session ended now; an earlier one's end time is unknown.
      own = {
        ...(counters && { sessionId: counters.sessionId, cpuMs: counters.cpuMs, txBytes: counters.txBytes, uptimeMs: counters.uptimeMs }),
        ...(started !== undefined && { ownDurationMs: Math.max(Date.now() - started, 0) }),
      };
      if (state.requestedAt !== null && Object.keys(own).length > 0) {
        await this.markSandbox(run, { selfMeasured: own }).catch(() => reportError(new Error("self-measured mark failed"), { stage: "run.stop_mark" }));
      }
    }
    const usage = ids.length > 0 ? await port.measure(handle, ids).catch(() => []) : [];
    bk.measurement = figuresOf(ids, usage, state.selfMeasured ?? own);
  }

  /**
   * CS-1 / CS-2a: deletes a non-persistent role's sandbox, once, and only AFTER its compute is settled (or nothing
   * waits on it): the deferred re-read needs the stopped sandbox to still be there to measure it. `derive` names the
   * sandbox from the run's identity when this instance never held a handle (a settle on a fresh instance).
   */
  private async deleteIfEphemeral(run: ExecutionRun, bk?: RunBookkeeping, derive = false): Promise<void> {
    if (isPersistentRole(run.role) || bk?.deleted) return;
    let handle = bk?.handle;
    if (!handle && derive) {
      try {
        handle = { runId: run.id, sandboxName: sandboxNameFor({ role: run.role, runId: run.id, accountId: run.accountId, repoId: run.repoId, pr: run.pr }) };
      } catch {
        return; // no identifiable sandbox
      }
    }
    if (!handle) return; // this instance never made one, and `derive` was not asked for
    if (bk) bk.deleted = true;
    await this.deps.sandboxPort.deleteSandbox(handle).catch(() => {});
  }

  /** CS-1: the end of a normal run: stop and measure (persistent roles keep their snapshot; the others are deleted once settled). Returns what was measured. */
  private async endSandbox(run: ExecutionRun): Promise<SandboxSessionFigures[] | undefined> {
    const bk = this.runs.get(run.id) ?? freshBookkeeping();
    let handle = bk.handle;
    if (!handle) {
      try {
        handle = { runId: run.id, sandboxName: sandboxNameFor({ role: run.role, runId: run.id, accountId: run.accountId, repoId: run.repoId, pr: run.pr }) };
      } catch {
        return undefined; // no identifiable sandbox (see `cancel`)
      }
    }
    if (!bk.stoppedDirectly) {
      bk.stoppedDirectly = true;
      // A persistent role's sandbox name is shared by every run on the PR, and a durable finalize can be
      // replayed after a newer run took the name over: apply `cancel`'s ownership test before stopping.
      // If the check itself throws, stop anyway (fail safe, as `cancel` does).
      const owns = isPersistentRole(run.role) ? await this.stillOwnsSandbox(run).catch(() => true) : true;
      if (owns) await this.stopAndMeasure(run, bk, handle);
    }
    return bk.measurement;
  }

  /** Recomputed fresh every call (never accumulated in memory), so a
   * repeat `cancel()` -- from any instance -- returns the identical body.
   * `settled_usd` is always 0 in H09b1: nothing here ever calls
   * `settle()` (mid-run metering is H09b2's). */
  private async totalsFor(accountId: string, runId: string): Promise<CancelResult> {
    const settled = await this.withAccount(accountId, (client) =>
      client.query<{ sum: string }>(
        `SELECT COALESCE(SUM(usd), 0)::text AS sum FROM ledger WHERE account_id = $1 AND run_id = $2`,
        [accountId, runId],
      ),
    );
    const released = await this.withAccount(accountId, (client) =>
      client.query<{ sum: string }>(
        `SELECT COALESCE(SUM(usd_reserved), 0)::text AS sum FROM spend_reservations
         WHERE account_id = $1 AND run_id = $2 AND state = 'released'`,
        [accountId, runId],
      ),
    );
    return { settled_usd: Number(settled.rows[0]!.sum), released_usd: Number(released.rows[0]!.sum) };
  }

  /** A small local `withTenant`-alike, so `cancel`'s own bookkeeping
   * queries don't add a `@fx/core` dependency for a two-line helper
   * (`packages/spend/src/pg.ts` sets the same precedent). `BEGIN`/`COMMIT`
   * matter: `set_config(..., true)` ("local") is scoped to the CURRENT
   * transaction, and `pool.connect()`'s client is autocommit outside an
   * explicit one -- without this, `app.account_id` would be gone again
   * before the very next query on the same client ever saw it. */
  private async withAccount<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config($1, $2, true)", ["app.account_id", accountId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      await client.query("RESET app.account_id").catch(() => {});
      client.release();
    }
  }
}

/** What the runner persists about the in-VM counters (and its own stop-to-start time) when it stops a sandbox. */
interface PersistedCounters {
  sessionId?: string;
  cpuMs?: number;
  txBytes?: number;
  uptimeMs?: number;
  ownDurationMs?: number;
}

/** The persisted half of a run's sandbox bookkeeping (agent_runs, 0689). */
interface SandboxState {
  requestedAt: Date | null;
  stoppedAt: Date | null;
  sessionIds: string[];
  selfMeasured: PersistedCounters | null;
}

/** The per-session figures the cost tiers price: the provider's usage, with the counters and own wall time attached. */
function figuresOf(ids: readonly string[], usage: readonly SandboxSessionUsage[], own: PersistedCounters | null | undefined): SandboxSessionFigures[] {
  const last = ids[ids.length - 1];
  return ids.map((id): SandboxSessionFigures => ({
    ...(usage.find((u) => u.sessionId === id) ?? { sessionId: id }),
    ...(own?.sessionId === id && own.cpuMs !== undefined && own.txBytes !== undefined && { selfMeasured: { cpuMs: own.cpuMs, txBytes: own.txBytes, uptimeMs: own.uptimeMs } }),
    ...(id === last && own?.ownDurationMs !== undefined && { ownDurationMs: own.ownDurationMs }),
  }));
}

/** A port error that means "already gone" (a 404 or 410): deleting what is not there is done. */
function isGone(err: unknown): boolean {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  return status === 404 || status === 410;
}

/** The per-run cap the meter kills at, and the one the CLI's `--max-budget-usd` gets. */
/**
 * The model ledger entry for a run's metered figure. An operator-subscription run is not billed per
 * token: it is recorded under its own source at $0, so it never counts against the account's monthly
 * budget. The metered USD still drives the per-run cap while the run is live (meterModelUnderLock).
 */
function modelLedgerEntry(operator: boolean, meteredUsd: number): SettleEntry {
  return operator
    ? { budget: "model", actualUsd: 0, source: "operator_subscription" }
    : { budget: "model", actualUsd: meteredUsd, source: "customer_gateway" };
}

function perSpawnCapUsd(run: ExecutionRun): number {
  return run.spend.perSpawnCapUsd ?? run.capUsd;
}

/** The abort reason for a rejected `hookFired`: what `onEvent` recorded, else
 * the port's own limit (`RunLimitError`), else none (a plain failure). */
function abortOf(bk: RunBookkeeping, err: unknown): RunAbortReason | undefined {
  if (bk.abort === undefined && err instanceof RunLimitError) bk.abort = { kind: "limit", limit: err.limit, reportedUsd: err.reportedUsd };
  return bk.abort;
}

function isKnownModelId(model: string): model is ModelId {
  return isClaudeModelId(model);
}

/** MP-MODEL for the paths that skip `admit` (a resume): fail closed. */
function assertMeterableModel(model: string): void {
  if (!isKnownModelId(model)) throw new Error("SandboxTarget: model is not in the price table, so it cannot be metered");
}

const ZERO_TOKENS: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** What one model costs for a unit of everything: only used to say which is dearer. */
const rankUsd = (id: ModelId): number =>
  computeModelUsd(id, { inputTokens: 1e6, outputTokens: 1e6, cacheWriteTokens: 1e6, cacheReadTokens: 1e6 });
/** Read on first use, not at import: the price table comes from the plan data, which may be unavailable. */
function mostExpensiveModelId(): ModelId {
  return claudeModelIds().reduce((a, b) => (rankUsd(b) > rankUsd(a) ? b : a));
}

/**
 * W2 (C56 point 2): the model a message is priced at, the dearer of the run's
 * and the one it claims. A claim that maps to no priced model is priced at the
 * dearest one and flagged, so a forged model name can only raise a figure.
 */
function pricedModel(runModel: ModelId, claimed: string | undefined): { model: ModelId; unknown: boolean } {
  if (claimed === undefined) return { model: runModel, unknown: false };
  const id = modelIdForCliName(claimed);
  if (id === undefined) return { model: mostExpensiveModelId(), unknown: true };
  return { model: rankUsd(id) > rankUsd(runModel) ? id : runModel, unknown: false };
}

/**
 * L (C59 §3): the price of one maximal message on the dearest priced model.
 * The meter lets one line raise the total by at most this, and a reported
 * cost may exceed the metered one by at most this, so a run settles at most
 * `perSpawnCapUsd + 2 * maxLineUsd()` of model spend.
 */
export function maxLineUsd(): number {
  const dearest = mostExpensiveModelId();
  return Math.max(
    ...(["inputTokens", "cacheWriteTokens", "cacheReadTokens"] as const).map((f) =>
      computeModelUsd(dearest, { ...ZERO_TOKENS, [f]: MAX_LINE_INPUT_SIDE_TOKENS, outputTokens: MAX_LINE_OUTPUT_TOKENS }),
    ),
  );
}

/** The run's metering state as the terminal report needs it. */
interface MeterSnapshot {
  tokens: TokenTotals;
  flags: Iterable<string>;
  extensionsUsed?: number;
}
const snapshotOf = (bk: RunBookkeeping): MeterSnapshot => ({ tokens: bk.meteredTokens, flags: bk.meterFlags, extensionsUsed: bk.extensionsUsed });
const extensionsOf = (snap: MeterSnapshot): { extensionsUsed?: number } => (snap.extensionsUsed ? { extensionsUsed: snap.extensionsUsed } : {});

/**
 * C44 EV-SETTLE + C59 §3 (10e): a run settles max(metered, min(the final
 * valid `total_cost_usd`, metered + L), 0). A reported figure below the
 * metered total (or none) never lowers it, and one above it (a forged
 * result line) raises it by at most one maximal message. `undefined` means
 * nothing was metered or reported, which must still take `finalize`'s
 * release path.
 */
function settledUsd(meteredUsd: number, reportedUsd: number | undefined): number | undefined {
  if (reportedUsd === undefined && !(meteredUsd > 0)) return undefined;
  return Math.max(meteredUsd, Math.min(reportedUsd ?? 0, meteredUsd + maxLineUsd()), 0);
}

/** C46 MP-PLAUS: the `metering` block; H14c-3 persists it. */
function meteringOf(meteredUsd: number, reportedUsd: number | undefined, snap: MeterSnapshot, limit?: RunLimit): NonNullable<TerminalReport["metering"]> {
  const flags = new Set(snap.flags);
  if (reportedUsd !== undefined && reportedUsd > meteredUsd + maxLineUsd()) flags.add("reported_above_metered");
  if (reportedUsd !== undefined && reportedUsd < 0.95 * meteredUsd) flags.add("reported_below_metered");
  if (limit?.kind === "silence") flags.add("metering_silent");
  if (limit?.kind === "model_calls") flags.add("model_call_cap");
  return { meteredUsd, reportedUsd: reportedUsd ?? null, flags: [...flags].sort() };
}

/** W3: the report's token counts are the METERED figures, never the VM's last result. */
function meteredTokenCounts(t: TokenTotals): { tokensIn?: number; tokensOut?: number } {
  return t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens > 0 ? { tokensIn: t.inputTokens, tokensOut: t.outputTokens } : {};
}

export function buildTerminalReport(
  lastEvent: NormalizedEvent | undefined,
  sessionId?: string,
  meteredUsd = 0,
  snap: MeterSnapshot = { tokens: ZERO_TOKENS, flags: [] },
): TerminalReport {
  const usd = settledUsd(meteredUsd, lastEvent?.costUsd);
  const common = { usd, sessionId, ...meteredTokenCounts(snap.tokens), ...extensionsOf(snap), metering: meteringOf(meteredUsd, lastEvent?.costUsd, snap) };
  if (!lastEvent || lastEvent.type === "error" || lastEvent.isError) {
    return { status: "failed", envelope: lastEvent?.agentOutput ?? null, ...common };
  }
  // W-3: a final envelope `{ verdict: "checkpoint", summary: <string> }` ends the
  // run as `timed_out`. It can only end a run: nothing here reads it as an
  // instruction, and the stored envelope carries the verdict alone.
  const out = lastEvent.agentOutput;
  if (out?.verdict === "checkpoint" && typeof out.summary === "string") {
    return { status: "timed_out", envelope: { verdict: "checkpoint" }, agentCheckpoint: { summary: out.summary }, ...common };
  }
  return { status: "succeeded", envelope: lastEvent.agentOutput ?? null, ...common };
}

/**
 * D#2 H09b2 (H09.5/H09.8): builds the `TerminalReport` for a REJECTED
 * `hookFired` -- `onEvent` threw a `RunAbortSignal` (recorded on `bk.abort`
 * before the throw, since a rejected promise carries no structured payload
 * of its own past that point), or something else failed for an unrelated
 * reason (`bk.abort` is `undefined`, and this reports a bare `"failed"`,
 * matching H09a's pre-H09b2 behavior for an unclassified rejection).
 *
 * Fix round 1 (S-MUST 1): `meteredModelUsd` is `bk.cumulativeModelUsd` at
 * abort time -- carried into every branch's `usd`, not just `spend_kill`,
 * since `model_key_broken`/unclassified can follow already-metered usage
 * too. Only attached when positive: 0 means never metered, which must
 * still take `finalize`'s release() path, not settle a $0 ledger row.
 */
function buildAbortTerminalReport(
  reason: RunAbortReason | undefined,
  sessionId: string | undefined,
  meteredModelUsd: number,
  snap: MeterSnapshot,
): TerminalReport {
  const usd = meteredModelUsd > 0 ? meteredModelUsd : undefined;
  const common = { sessionId, ...meteredTokenCounts(snap.tokens), ...extensionsOf(snap) };
  const metering = (reported?: number, limit?: RunLimit) => meteringOf(meteredModelUsd, reported, snap, limit);
  if (!reason) {
    return { status: "failed", usd, ...common, metering: metering() };
  }
  if (reason.kind === "spend_kill") {
    return { status: "killed_spend", usd, ...common, metering: metering(), abortReason: reason.cause, ...(reason.limit ? { limit: reason.limit } : {}) };
  }
  if (reason.kind === "limit") {
    return { status: "timed_out", usd: settledUsd(meteredModelUsd, reason.reportedUsd), ...common, metering: metering(reason.reportedUsd, reason.limit), limit: reason.limit };
  }
  if (reason.kind === "implausible") {
    return { status: "failed", failureReason: "sandbox_error", usd, ...common, metering: metering() };
  }
  return { status: "failed", failureReason: "model_key_broken", modelFailureCode: reason.code, usd, ...common, metering: metering() };
}

/** 401/403 only -- `ConnectionStatusPort.markBroken`'s own type
 * (`BrokenConnectionCode`) excludes 402, and `finalize` must never call it
 * for a `TerminalReport` that didn't carry a code at all (e.g. a
 * `failureReason: "model_key_broken"` written for some other reason). */
function brokenConnectionCodeFor(report: TerminalReport): BrokenConnectionCode | undefined {
  return report.modelFailureCode === 401 || report.modelFailureCode === 403 ? report.modelFailureCode : undefined;
}
