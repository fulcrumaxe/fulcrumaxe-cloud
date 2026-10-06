import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import {
  buildExecutionRun,
  readExecutionMode,
  resolveExecutionTarget,
  insertAgentRun,
  writeRunStatus,
  QUEUE_TTL_MS,
  DispatchAbortedError,
  DispatchFailedError,
  EXECUTOR_ROLE,
  DEFAULT_BACKEND,
  type DispatchResult,
  type ExecutionRun,
  type ExecutionTargetRegistry,
  type RunStatus,
  type StartAgentRunInput,
} from "@fx/runner";
import { ResumeBackendError, lookupOwnedExecutorSession } from "./resumeOwnership.js";

/**
 * D#2 H14a, criterion 2 (H09.9's "real caller", per the split ruling and
 * the #171 security review): the fix-round counterpart to `startAgentRun`
 * -- referenced but never built by packages/runner (see that package's
 * own `resumeAgentRun.ts` mentions in sandboxTarget.ts/runStatusWriter.ts
 * doc comments; C10: "H14 doesn't need to edit packages/runner"). Mirrors
 * `startAgentRun`'s shape (insert a fresh `pending` row, `admit` a new
 * spend reservation, race the sandbox call against `QUEUE_TTL_MS`, write
 * the terminal CAS status) but calls `target.resume(run, sessionId)`
 * instead of `target.dispatch(run)`, and the session id is never taken
 * from `input` -- it is read back by `lookupOwnedExecutorSession`, scoped
 * to the SAME tenant, work item and role as `input`, before this function
 * ever reaches the target.
 */

export type ResumeAgentRunResult =
  | { id: string; status: "refused_spend"; reason: string }
  | { id: string; status: "timed_out" }
  | { id: string; status: "running"; hookToken: string }
  /** D#6 C12 section 2.1: the target queued the fix round for a runner. It stays `pending`; a caller that cannot wait for
   * a claim fails closed on it. */
  | { id: string; status: "pending"; queued: true }
  | { id: string; status: Exclude<RunStatus, "pending" | "running">; raceLost: true };

type ResumeRace = { timedOut: true } | { timedOut: false; dispatched: DispatchResult };

function raceResume(resume: Promise<DispatchResult>, queueTtlMs: number): Promise<ResumeRace> {
  return Promise.race<ResumeRace>([
    resume.then((r): ResumeRace => ({ timedOut: false, dispatched: r })),
    new Promise<ResumeRace>((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), queueTtlMs);
    }),
  ]);
}

/** Mirrors `startAgentRun.ts`'s private `dispatchOrCleanup` exactly,
 * substituting `target.resume` for `target.dispatch` -- same
 * DispatchAbortedError/DispatchFailedError handling, because
 * `SandboxTarget.resume`'s own `SandboxNotFoundError` fallback path is
 * simply `this.dispatch(run)` internally (sandboxTarget.ts), so the same
 * two error shapes can propagate from a `resume()` call too. */
async function resumeOrCleanup(
  target: { resume: (run: ExecutionRun, sessionId: string) => Promise<DispatchResult>; cancel: (run: ExecutionRun) => Promise<unknown> },
  run: ExecutionRun,
  sessionId: string,
  pool: Pool,
  accountId: string,
  runId: string,
): Promise<DispatchResult> {
  try {
    return await target.resume(run, sessionId);
  } catch (err) {
    if (err instanceof DispatchAbortedError) {
      await target.cancel(run).catch(() => {});
      throw err;
    }
    await writeRunStatus(pool, {
      accountId,
      runId,
      from: "pending",
      to: "failed",
      failureReason: "internal_error",
    }).catch(() => {});
    await target.cancel(run).catch(() => {});
    throw new DispatchFailedError(runId, err);
  }
}

/**
 * `input.role` must be `"executor"` -- only the executor role is ever
 * resumable (C10, `isPersistentRole`). `input.workItemId` is required
 * (the ownership lookup is scoped by it).
 */
export async function resumeAgentRun(
  pool: Pool,
  registry: ExecutionTargetRegistry,
  input: StartAgentRunInput,
  queueTtlMs: number = QUEUE_TTL_MS,
): Promise<ResumeAgentRunResult> {
  if (input.role !== EXECUTOR_ROLE) {
    throw new Error(`resumeAgentRun: role must be "${EXECUTOR_ROLE}", got "${input.role}"`);
  }
  if (!input.workItemId) {
    throw new Error("resumeAgentRun: workItemId is required");
  }
  const workItemId = input.workItemId;

  // The ownership check (same tenant via RLS, same run via workItemId,
  // same role via the executor-only query in resumeOwnership.ts) happens
  // BEFORE anything is written or any target method is called -- a
  // foreign/absent session throws ForeignSessionError here and nothing
  // downstream ever runs.
  const { sessionId, backend: storedBackend } = await withTenant(pool, input.accountId, (client) =>
    lookupOwnedExecutorSession(client, { accountId: input.accountId, workItemId }),
  );

  // D#221 R1b: the round continues on the backend the session was started on, or not at all. Checked before any write.
  if ((input.backend ?? DEFAULT_BACKEND) !== storedBackend) throw new ResumeBackendError("different");

  const mode = await readExecutionMode(pool, input.accountId, input.repoId);
  const target = resolveExecutionTarget(mode, registry);

  const runId = randomUUID();
  const { id } = await insertAgentRun(pool, {
    id: runId,
    accountId: input.accountId,
    workItemId,
    parentRunId: input.parentRunId,
    role: input.role,
    runtime: target.runtime,
    initiatedBy: input.initiatedBy,
    headSha: input.headSha,
    executionMode: mode,
    dispatchRepoId: input.repoId,
    dispatchPrNumber: input.pr ?? null,
    idempotency: input.idempotency,
  });

  const run: ExecutionRun = buildExecutionRun(id, { ...input, backend: storedBackend });

  const admitClient = await pool.connect();
  admitClient.release();
  const admitResult = await target.admit(run, admitClient);
  if (!admitResult.admitted) {
    await writeRunStatus(pool, { accountId: input.accountId, runId: id, from: "pending", to: "refused_spend" });
    return { id, status: "refused_spend", reason: admitResult.reason };
  }

  const raced = await raceResume(
    resumeOrCleanup(target, run, sessionId, pool, input.accountId, id),
    queueTtlMs,
  );

  if (raced.timedOut) {
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

  // D#6 C12 section 2.1: a queued fix round stays `pending` for a runner to claim; there is no hook to wait on.
  if ("queued" in raced.dispatched) return { id, status: "pending", queued: true };

  const write = await writeRunStatus(pool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
  if (!write.updated) {
    await target.cancel(run).catch(() => {});
    return {
      id,
      status: (write.currentStatus ?? "cancelled") as Exclude<RunStatus, "pending" | "running">,
      raceLost: true,
    };
  }
  return { id, status: "running", hookToken: raced.dispatched.hookToken };
}
