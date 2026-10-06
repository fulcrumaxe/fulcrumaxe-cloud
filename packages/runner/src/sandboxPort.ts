import type { AgentHandle, NormalizedEvent, Role, StartOptions } from "./types.js";
import type { NetworkPolicyRule } from "./networkPolicy.js";
import type { SandboxRetentionPolicy } from "./sandboxNaming.js";
import type { ExtensionPolicy } from "./runLimitDecision.js";
import type { RunLimits } from "./meteringGuard.js";
import { SANDBOX_PINNED_VCPUS } from "@fx/spend";

/**
 * H09a's sandbox lifecycle port. H04 (`@fx/runtime`) owns starting an
 * agent process (local/production/fake `AgentRuntime`); this port owns
 * the layer around it that H04 explicitly leaves to H09 -- see
 * `packages/runtime/src/production/index.ts`'s file header: "H04 owns the
 * construction/start-time refusal rules... H09 owns wiring these to a
 * real `@vercel/sandbox`." Concretely: sandbox creation with an explicit
 * timeout, the "start detached, wait on a hook raced against a watchdog"
 * shape from the Consensus Summary ("24 h sandbox sessions and an 800 s
 * step ceiling mean no step blocks on an agent: start the agent detached
 * and wait on a hook raced against a watchdog"), snapshot retention, and
 * deletion.
 *
 * No production implementation ships in this PR -- only the interface and
 * `fakeSandbox.ts`'s test double. Wiring a real `@vercel/sandbox`
 * implementation, and the orchestration that actually calls
 * `startDetached`/races it against a watchdog (`startAgentRun`), is H09b.
 */
export interface SandboxHandle extends AgentHandle {
  sandboxName: string;
  /** D#2 COMPUTE-SETTLE CS-1: the session (VM) `createSandbox` created, when the port knows it. */
  sessionId?: string;
}

/** D#2 COMPUTE-SETTLE CS-1: one session's usage as reported; any field but the id can be missing. MB, ms, bytes. */
export interface SandboxSessionUsage {
  sessionId: string;
  memoryMb?: number;
  region?: string;
  durationMs?: number;
  activeCpuMs?: number;
  egressBytes?: number;
}

/** The vCPUs every sandbox is created with (pinned, not an SDK default). */
export const SANDBOX_VCPUS = SANDBOX_PINNED_VCPUS;

/**
 * D#2 H14c-3-2d-2 (R-MAX): the longest sandbox Vercel allows on the plan this deployment runs
 * (Pro, confirmed by the owner 2026-09-30): 24 hours. Source: https://vercel.com/docs/vercel-sandbox
 * (the installed @vercel/sandbox README says the same: 24 h for Pro/Enterprise, 45 min for Hobby, which
 * would refuse a default run, see docs/ops/pipeline-worker.md).
 */
export const SANDBOX_MAX_TIMEOUT_MS = 24 * 60 * 60_000;

/** How long a run's sandbox outlives the longest the run can go, so the runner's own clock always fires first. */
export const SANDBOX_TIMEOUT_MARGIN_MS = 10 * 60_000;

/** The VM's own counters, read inside the sandbox just before it is stopped (CS-1b); `sessionId` is the session they were read in. */
export interface SandboxCounters {
  sessionId: string;
  /** CPU time used since boot, across vCPUs. */
  cpuMs: number;
  /** Bytes sent on every interface but loopback since boot. */
  txBytes: number;
  uptimeMs: number;
}

export interface CreateSandboxOptions {
  sandboxName: string;
  retention: SandboxRetentionPolicy;
  /** Milliseconds. Spec: "2 h default" -- the default lives with the
   * caller (H09b), not here; this port just carries whatever value it's
   * given. */
  timeoutMs: number;
  /** D#2 H14c-3-2d-2 (R-CT): the limits of the run this sandbox is for. The port refuses a sandbox
   * whose `timeoutMs` is not at least this run's `maxRunMs` plus `SANDBOX_TIMEOUT_MARGIN_MS`; absent, the port's defaults are checked. */
  limits?: Partial<RunLimits>;
}

export interface StartDetachedOptions extends Omit<StartOptions, "onEvent" | "sandboxSpec"> {
  role: Role;
  /** D#2 COMPUTE-SETTLE CS-1: awaited with the id of the session the command runs in, before the command starts. */
  onSession?: (sessionId: string) => void | Promise<void>;
  /**
   * D#2 PREVIEW-RUNNER-EVENTS: called once the sandbox is ready for the agent (locked down, prompt and settings written),
   * just before the agent command starts. Best effort: a rejection is swallowed and never fails the launch.
   */
  onStage?: (stage: "sandbox_ready" | "cloned") => void | Promise<void>;
  /**
   * D#2 PREVIEW-RUNNER-EVENTS: clone this GitHub repository (shallow, default branch) into `workdir` before the agent
   * starts, through the GitHub proxy forward rule. A failed clone fails the launch with a `CloneError`. Ignored on resume.
   */
  clone?: { owner: string; name: string };
  networkPolicy: NetworkPolicyRule[];
  /**
   * D#221 R1a: which agent backend runs this start or resume, by registered name. Absent = "claude-code". A name that
   * is not registered (with the hostile-config contract) is refused before anything starts.
   */
  backend?: string;
  env: Record<string, string>;
  /** D#2 H14c-5c-2a (X-1): the per-run in-run extension policy. Absent = a limit ends the run. */
  extension?: ExtensionPolicy;
  /** D#2 H14c-3-2d-1 (C56 s1): this run's limits. Fields left out take the port's
   * own defaults, so nothing one run sets reaches another. The port refuses a launch
   * whose `maxRunMs` is not below its sandbox's `timeoutMs` (MP-CLOCK). */
  limits?: Partial<RunLimits>;
  /** D#2 H09b2 fix round 1 (S-MUST 2): may return a promise -- see
   * `@fx/runtime`'s `StartOptions.onEvent` for why every runtime awaits it
   * before producing the next event. */
  onEvent: (event: NormalizedEvent) => void | Promise<void>;
}

export interface StartDetachedResult {
  handle: AgentHandle;
  /**
   * Resolves once the sandbox's hook fires with the run's terminal event
   * (its last `NormalizedEvent`, `undefined` if the run produced none).
   * "Detached" means `startDetached` itself does NOT await this -- it
   * returns synchronously with the promise, so the caller can race it
   * against a watchdog `sleep` (H09b pass/fail 7) without ever awaiting a
   * sandbox-side operation directly. May also REJECT -- never hang
   * silently -- when the run needs to abort before its hook would
   * otherwise fire (e.g. H09b's mid-run spend-kill, which aborts by
   * throwing from inside the caller's own `onEvent`); a promise that
   * simply never settles is reserved for the one scenario H09b pass/fail
   * 7 tests: the hook genuinely never fires.
   */
  hookFired: Promise<NormalizedEvent | undefined>;
  /**
   * Resolves once the agent command exists in the sandbox (the provider accepted it), or at once if the run was stopped
   * before that. REJECTS if the launch failed before a command existed. The caller awaits it INSIDE the invocation that
   * called `startDetached`: everything before the command exists is the launch, and a serverless invocation that returns
   * during it is frozen with the launch half done (the agent never starts). Never settles on its own for a launch that
   * hangs, so the caller bounds the wait. Optional: a port without it has no launch phase to wait for.
   */
  launched?: Promise<void>;
}

/** Thrown by `resume` when the named sandbox's snapshot is gone (expired,
 * evicted, or never existed) -- Spec pass/fail 9's "fake: NotFound"
 * fallback scenario. `fakeSandbox.ts` throws this on command for tests; a
 * real implementation would throw it when the underlying sandbox platform
 * reports the snapshot missing. */
export class SandboxNotFoundError extends Error {
  constructor(public readonly sandboxName: string) {
    super(`sandbox not found: "${sandboxName}"`);
    this.name = "SandboxNotFoundError";
  }
}

/**
 * A fresh executor build found its persistent sandbox name taken by a sandbox that is not stopped: another session is
 * using it (or it is mid-stop or mid-snapshot). It is never reused or stopped from here; the build is refused with the
 * fixed reason `sandbox_busy`.
 */
export class SandboxBusyError extends Error {
  constructor(public readonly sandboxName: string) {
    super(`sandbox is busy: "${sandboxName}"`);
    this.name = "SandboxBusyError";
  }
}

export interface SandboxPort {
  createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle>;
  /** Fire-and-forget: starts the agent detached inside an already-created
   * sandbox and returns immediately. See `StartDetachedResult.hookFired`. */
  startDetached(handle: SandboxHandle, opts: StartDetachedOptions): StartDetachedResult;
  /** Spec: "`extendTimeout` for outliers." */
  extendTimeout(handle: SandboxHandle, additionalMs: number): Promise<void>;
  /** Stops the sandbox's running agent process. Idempotent -- calling it
   * on an already-stopped/deleted sandbox must not throw (H09b's watchdog
   * and mid-run-kill paths both call this unconditionally). PR #85 fix
   * round 3, must-fix 1: a real implementation must also make this
   * effective against a start that is still in flight at the provider
   * (e.g. by serializing per handle), not only against one that has
   * already finished starting -- `SandboxTarget` calls this right after
   * its own `startDetached`, with no way to know whether the provider
   * has actually finished bringing the agent up yet. */
  stop(handle: SandboxHandle): Promise<void>;
  /** Resume the same named sandbox with `--resume <sessionId>` semantics
   * (Spec pass/fail 9). Throws `SandboxNotFoundError` when the sandbox's
   * snapshot is gone. */
  resume(handle: SandboxHandle, sessionId: string, prompt: string, opts: StartDetachedOptions): StartDetachedResult;
  /**
   * Deletes the sandbox. By default the provider keeps its snapshots until they expire (as the compute settle's deletes always
   * did); `deleteSnapshots: true` also removes the ones no other sandbox uses. An already-gone sandbox (404, 410) is done.
   */
  deleteSandbox(handle: SandboxHandle, opts?: DeleteSandboxOptions): Promise<void>;
  /**
   * D#2 COMPUTE-SETTLE CS-1: usage for exactly the sessions in `sessionIds` (never by clock
   * window), read after the stop; at most 3 reads. Figures not reported yet are left out, not
   * thrown; a provider API failure throws `SandboxPortError`.
   */
  measure(handle: SandboxHandle, sessionIds: readonly string[]): Promise<SandboxSessionUsage[]>;
  /**
   * D#2 COMPUTE-SETTLE CS-1b: one short read-only command inside the running sandbox, called just
   * BEFORE `stop`. Bounded (about 5 s) and never throws: any error, a sandbox that is not running,
   * or an unparseable counter gives `undefined`, so it can neither fail nor hold up the stop.
   */
  readCounters(handle: SandboxHandle): Promise<SandboxCounters | undefined>;
  /**
   * D#2 COMPUTE-SETTLE CS-2b-1: whether a sandbox of this name still exists at the provider. `false` ONLY for a
   * definite "not found" (404 or 410); anything else -- a timeout, a 5xx, a network error, a malformed answer --
   * is `true`, so a doubt settles toward the conservative fallback, never toward $0. Never throws.
   */
  sandboxExists(handle: SandboxHandle): Promise<boolean>;
  /**
   * What the provider says the sandbox's compute is doing now, without waking it: "running" (starting counts), "stopped"
   * (stopped, failed or aborted from outside or by us), "gone" (a definite 404 or 410), or "unknown" for any doubt
   * (timeout, 5xx, a status it does not know). Callers act on "stopped"/"gone" only. Never throws. Optional so a
   * port without a provider to ask (a test double) is treated as "unknown"; the real port and the fake implement it.
   */
  sandboxState?(handle: SandboxHandle): Promise<SandboxComputeState>;
  /**
   * D#2 SANDBOX-REAPER: one page of the project's sandboxes whose name starts with `prefix` ("ex-" or "rn-" only; any other
   * prefix throws before a request is made), with the cursor for the next page. A read: it never starts, resumes or changes
   * a sandbox. `SandboxPortError` on a provider failure. Optional so a test double without a provider is simply not listable.
   */
  listSandboxes?(opts: ListSandboxesOptions): Promise<SandboxListPage>;
}

export interface DeleteSandboxOptions {
  /** Also delete the snapshots of this sandbox that no other sandbox uses. */
  deleteSnapshots?: boolean;
}

/** The only name prefixes a list may ask for: executor sandboxes and every other role's. */
export type ListablePrefix = "ex-" | "rn-";
export const LISTABLE_PREFIXES: readonly ListablePrefix[] = Object.freeze(["ex-", "rn-"] as const);

export interface ListSandboxesOptions {
  prefix: ListablePrefix;
  /** The `next` of the previous page; absent for the first. */
  cursor?: string;
}

/** The provider's sandbox statuses, as the SDK declares them. */
export type SandboxProviderStatus = "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";

export interface ListedSandbox {
  name: string;
  persistent: boolean;
  status: SandboxProviderStatus;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export interface SandboxListPage {
  sandboxes: ListedSandbox[];
  /** Pass as `cursor` for the next page; `null` on the last. */
  next: string | null;
}

export type SandboxComputeState = "running" | "stopped" | "gone" | "unknown";
