import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import {
  buildExecutionRun,
  IdempotencyKeyTakenError,
  isLegalRunTransition,
  readExecutionMode,
  resolveExecutionTarget,
  failClosedOnQueued,
  startAgentRun,
  writeRunStatus,
  type ExecutionTarget,
  type ExecutionTargetRegistry,
  type HookWaitPort,
  type RunStatus,
  type StartAgentRunInput,
  type StartAgentRunResult,
} from "@fx/runner";
import type { PanelRunner, PanelSeatRequest, PanelSeatResult } from "./panel.js";

/**
 * D#2 H14c-4 (C41 section 4): the real `PanelRunner`. One seat is one agent
 * run started through H09's `startAgentRun`, waited on through the hook
 * channel and finalized through the same `ExecutionTarget`.
 *
 * Idempotent per key, in the database. `startAgentRun` is handed the seat's
 * key; the claim on it (`agent_run_idempotency_keys`, migration 0646) commits
 * in the same transaction as the run row, so exactly one caller can start
 * the run and every other caller (concurrent, or a replay after a crash)
 * finds the claim, follows that run to its end and returns its envelope. A
 * caller that loses the race has created nothing: no row, reservation or
 * sandbox. The claim is scoped by account (`deps.accountId`, never read from
 * the request) and fingerprints what the key names, so another account's key
 * never resolves here and a key reused for a different seat is refused.
 *
 * A run that started keeps its key. The key is released only when no
 * sandbox was ever started for the run: `startAgentRun` threw, or it ended
 * `refused_spend`, or it timed out or lost a race before it ever ran. A run
 * that started and later failed, timed out or was cancelled at the round
 * deadline keeps the claim, so a replay of the step follows that run and
 * rejects with its terminal status; it never starts (and pays for) a second
 * one. The rule is enforced by the database: this file asks
 * `agent_run_release_idempotency_key` (migration 0646, executable only by
 * `agent_run_writer`), which refuses unless the run is terminal and never
 * held status `running`. `app_user` cannot delete a claim.
 *
 * Cancellable. When `signal` aborts, whoever holds the seat moves the run to
 * `cancelled` (compare-and-set) and calls the target's `cancel`, which stops
 * the sandbox and settles or releases the reservation, then rejects. The
 * run's terminal envelope is only ever read back from `agent_runs`, and this
 * file writes no comment: a rejected seat has no signed row. The key includes
 * the round, so every caller holding a key is holding the same seat: a
 * follower's own abort cancels the run a different caller is driving. That is
 * intended (whoever holds the seat may stop it), not a leak between seats.
 *
 * Abort races. Before start: nothing is claimed. During start:
 * `startAgentRun` cannot be interrupted (it is bounded by its own queue TTL),
 * so the abort is honoured the moment it returns and the run it made is
 * cancelled. After finish: the run is already finalized (spend settled), so
 * there is nothing to stop; the seat still rejects.
 *
 * Two known gaps (also in docs/ops/pipeline-worker.md). GAP1: `startAgentRun`
 * throws after it inserted the run row, so the seat stays held until the next
 * caller's deadline; no money is spent. GAP2: a sandbox is created and then
 * loses the pending-to-running compare-and-set to a concurrent cancel; that
 * costs one short-lived extra sandbox, and the agent never starts in it.
 *
 * Not in scope: what the seat runs (role card, model, cap, repo) comes from
 * `resolveSeat`, and the registry's `SandboxPort` is injected; the real
 * Vercel port and the composition root are H14c-2 and H14c-3.
 */

export type SeatRunConfig = Omit<StartAgentRunInput, "accountId" | "role" | "workItemId" | "prompt" | "idempotency">;

export interface SandboxPanelRunnerDeps {
  /** A login that is a member of app_user and agent_run_writer (H09c). */
  pool: Pool;
  accountId: string;
  registry: ExecutionTargetRegistry;
  hookWait: HookWaitPort;
  resolveSeat(request: PanelSeatRequest): SeatRunConfig | Promise<SeatRunConfig>;
  queueTtlMs?: number;
  /** How often a follower first re-reads the run. Default 1000. It backs off
   * by half again each poll up to 8x this value, so a follower on a long
   * seat settles at a few reads a minute. */
  pollMs?: number;
}

export class PanelSeatAbortedError extends Error {
  constructor() {
    super("panel seat aborted");
    this.name = "PanelSeatAbortedError";
  }
}

export class PanelSeatFailedError extends Error {
  constructor(public readonly runStatus: string) {
    super(`panel seat run ended ${runStatus}`);
    this.name = "PanelSeatFailedError";
  }
}

export class IdempotencyKeyMismatchError extends Error {
  constructor() {
    super("idempotency key was used for a different seat");
    this.name = "IdempotencyKeyMismatchError";
  }
}

interface RunRow {
  status: RunStatus;
  role: string;
  work_item_id: string | null;
  envelope: unknown;
}

const TERMINAL: readonly string[] = ["succeeded", "refused_spend", "failed", "timed_out", "killed_spend", "cancelled"];

/** C41: "a failed start is not remembered". Asks the database to release the
 * claim; it does so only for a run that never ran (see the header). Asking is
 * always safe: for a run that started, or is still live, it changes nothing. */
const RELEASE_SQL = `SELECT agent_run_release_idempotency_key($1::uuid, $2::text) AS released`;

function whenAborted(signal: AbortSignal): { promise: Promise<"aborted">; dispose: () => void } {
  let onAbort = (): void => {};
  const promise = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

export function createSandboxPanelRunner(deps: SandboxPanelRunnerDeps): PanelRunner {
  const { pool, accountId } = deps;
  const pollMs = deps.pollMs ?? 1000;

  const readRun = (runId: string): Promise<RunRow | undefined> =>
    withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<RunRow>(
        `SELECT status, role, work_item_id, envelope FROM agent_runs WHERE account_id = $1 AND id = $2`,
        [accountId, runId],
      );
      return rows[0];
    });

  const releaseKey = (key: string): Promise<unknown> =>
    withTenant(pool, accountId, (client) => client.query(RELEASE_SQL, [accountId, key]));

  const targetFor = async (input: StartAgentRunInput): Promise<ExecutionTarget> =>
    resolveExecutionTarget(await readExecutionMode(pool, accountId, input.repoId), deps.registry);

  /** Stops whatever the run holds. Safe at any point and for any status. */
  async function cancelSeat(runId: string, input: StartAgentRunInput, key: string): Promise<void> {
    let row = await readRun(runId);
    for (let i = 0; i < 3 && row && isLegalRunTransition(row.status, "cancelled"); i++) {
      const write = await writeRunStatus(pool, { accountId, runId, from: row.status, to: "cancelled" });
      if (write.updated) break;
      row = await readRun(runId);
    }
    if (row?.status === "succeeded") return;
    const target = await targetFor(input);
    await target.cancel(buildExecutionRun(runId, input));
    await releaseKey(key);
  }

  /** The finished run's envelope, or a rejection when it did not succeed. */
  async function settled(runId: string, request: PanelSeatRequest): Promise<PanelSeatResult> {
    const row = await readRun(runId);
    if (!row || row.role !== request.role || row.work_item_id !== request.workItemId) throw new PanelSeatFailedError("mismatch");
    if (row.status !== "succeeded") {
      await releaseKey(request.idempotencyKey);
      throw new PanelSeatFailedError(row.status);
    }
    return { agentRunId: runId, agentOutput: row.envelope };
  }

  /** Follows the run another call (or an earlier attempt) started under this key. */
  async function follow(
    request: PanelSeatRequest,
    input: StartAgentRunInput,
    hash: string,
    signal: AbortSignal,
  ): Promise<PanelSeatResult | "retry"> {
    const claim = await withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ run_id: string; request_hash: string }>(
        `SELECT run_id, request_hash FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2`,
        [accountId, request.idempotencyKey],
      );
      return rows[0];
    });
    if (!claim) return "retry"; // released between the conflict and this read
    if (claim.request_hash !== hash) throw new IdempotencyKeyMismatchError();
    const aborted = whenAborted(signal);
    try {
      for (let wait = pollMs; ; wait = Math.min(Math.ceil(wait * 1.5), pollMs * 8)) {
        const row = await readRun(claim.run_id);
        if (row && TERMINAL.includes(row.status)) return await settled(claim.run_id, request);
        const woke = await Promise.race([aborted.promise, new Promise<"tick">((r) => setTimeout(() => r("tick"), wait))]);
        if (woke === "aborted") {
          await cancelSeat(claim.run_id, input, request.idempotencyKey);
          throw new PanelSeatAbortedError();
        }
      }
    } finally {
      aborted.dispose();
    }
  }

  async function drive(
    started: StartAgentRunResult,
    request: PanelSeatRequest,
    input: StartAgentRunInput,
    signal: AbortSignal,
  ): Promise<PanelSeatResult> {
    const key = request.idempotencyKey;
    // Abort during start: the run exists now, so stop it and give its reservation back.
    if (signal.aborted) {
      await cancelSeat(started.id, input, key);
      throw new PanelSeatAbortedError();
    }
    if (started.status !== "running") {
      await releaseKey(key);
      throw new PanelSeatFailedError(started.status);
    }
    const aborted = whenAborted(signal);
    try {
      const raced = await Promise.race([deps.hookWait.wait(started.hookToken), aborted.promise]);
      if (raced === "aborted") {
        await cancelSeat(started.id, input, key);
        throw new PanelSeatAbortedError();
      }
      await (await targetFor(input)).finalize(buildExecutionRun(started.id, input), raced);
    } catch (err) {
      if (!(err instanceof PanelSeatAbortedError)) await cancelSeat(started.id, input, key).catch(() => {});
      throw err;
    } finally {
      aborted.dispose();
    }
    // Finished and finalized: nothing left to stop. A late abort still rejects.
    if (signal.aborted) throw new PanelSeatAbortedError();
    return settled(started.id, request);
  }

  return {
    async runSeat(request, signal) {
      if (signal.aborted) throw new PanelSeatAbortedError(); // before start: nothing claimed, nothing reserved
      const config = await deps.resolveSeat(request);
      const input: StartAgentRunInput = {
        ...config,
        accountId,
        role: request.role,
        workItemId: request.workItemId,
        prompt: request.prompt,
      };
      const hash = createHash("sha256")
        .update(JSON.stringify([request.role, request.workItemId, request.discussionId, request.round]))
        .digest("hex");
      for (let attempt = 0; attempt < 3; attempt++) {
        let started: StartAgentRunResult;
        try {
          // A seat queued for a runner has no hook to wait on: it is cancelled and the seat fails.
          started = await failClosedOnQueued(
            pool,
            accountId,
            await startAgentRun(
              pool,
              deps.registry,
              { ...input, idempotency: { key: request.idempotencyKey, requestHash: hash } },
              deps.queueTtlMs,
            ),
          );
        } catch (err) {
          if (!(err instanceof IdempotencyKeyTakenError)) {
            await releaseKey(request.idempotencyKey).catch(() => {});
            throw err;
          }
          const followed = await follow(request, input, hash, signal);
          if (followed === "retry") continue;
          return followed;
        }
        return drive(started, request, input, signal);
      }
      throw new PanelSeatFailedError("key_contended");
    },
  };
}
