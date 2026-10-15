import type { Pool } from "pg";
import { SignedJobSchema, type StopReason } from "@fulcrumaxe/runner-protocol";
import { MAX_CONTINUATIONS_PER_WORK_ITEM } from "@fx/core/src/run-limits/limits.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordRunHandoffEvent, recordRunnerDispatchBaseOn, writeRunStatus, writeRunStatusOn, type ContinuationBasePort, type RunHandoffState } from "@fx/runner";
import { leaseVerdict, stopReasonFor } from "./runnerClaims.js";
import { runnerLimits, type RunnerLimitsSource } from "./runnerLimits.js";

/**
 * D#599 HO-2b: finishing a handoff HO-2a asked for. Three entry points reach `completeRunHandoff`: the runner's `run_ended handed_off`
 * event (after its batch has committed), a `done` from a run that has a live handoff, and the deadline sweep. All of them end the same
 * way, in one transaction:
 *
 *   the parent leaves `running` for `cancelled` (reason `handed_off`; its work is on its branch and it has no result), the database
 *   definer `run_handoff_complete` makes the child on the target side and moves the held reservations to it, and the child's
 *   `dispatch_base` is written. A reader sees all of it or none of it.
 *
 * The base is the branch head read from GitHub by the cloud, before the transaction and never from a message: nothing a runner
 * sent names a sha, and a GitHub that cannot answer writes nothing (`retry`), as `done` does. After the commit the child is dispatched
 * through `dispatchChild` (the seam FL-11's drain reuses, and the one PL-2's cross-side job lands in). A child that cannot start fails
 * the handoff: the child ends `failed`, the definer releases the reservations and puts the placement back, and the item is parked with
 * the work's branch named.
 *
 * Moves stay pull-based (D#605): the child is an ordinary pending run. It passes the full claim predicate, including the subscription gate,
 * on whichever runner takes it, and the machine it came from is excluded by `agent_runs.excluded_runner_id`.
 */

/** How often the deadline sweep wants to run while a handoff is live. */
export const HANDOFF_SWEEP_INTERVAL_MS = 30_000;
const BATCH = 50;
const NIL_RUN_ID = "00000000-0000-0000-0000-000000000000";
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

export type HandoffFailure = "work_item_ceiling" | "child_not_started";

export interface RunHandoffPorts {
  /** Reads a branch head from GitHub (apps/web's live read). Absent: nothing can be completed (`unavailable`), and nothing is written. */
  base?: ContinuationBasePort | null;
  /** Starts the pending child on its side. Throws when it could not. Absent: the child cannot start, and the handoff fails. */
  dispatchChild?: (input: { accountId: string; runId: string; toSide: "cloud" | "runner" }) => Promise<void>;
  /** Parks the work item with a fixed code (the stage driver's `needs_human`). */
  park?: (input: { accountId: string; workItemId: string; runId: string; code: "work_item_ceiling" | "handoff_failed" }) => Promise<void>;
  now?: () => number;
  limits?: RunnerLimitsSource;
  onError?: (runId: string, error: unknown) => void;
}

export interface CompleteRunHandoffInput {
  accountId: string;
  runId: string;
  /** The deadline has passed: continue from the head GitHub shows, whether or not the side said it pushed. */
  forced: boolean;
  /** `done`: the run must still be this runner's at this generation, checked in the transaction that ends it. */
  fence?: { runnerId: string; leaseGeneration: number };
  /** The run branch of a run with no signed job (a sandbox run; HO-4 supplies it from its own rows). A runner run's branch is derived from its job. */
  branch?: string;
}

export type CompleteRunHandoffResult =
  | { kind: "created"; childRunId: string; toSide: "cloud" | "runner"; workItemId: string; forced: boolean }
  /** The parent is ended and the handoff is `failed`; nothing continues. The work is saved on `branch`. */
  | { kind: "failed"; reason: HandoffFailure; workItemId: string; branch: string | null }
  /** No live handoff, not yet due or ready, or the run is not running: nothing was written. */
  | { kind: "none" }
  /** GitHub could not be asked: nothing was written. */
  | { kind: "retry" }
  | { kind: "unavailable" }
  | { kind: "fenced"; reason: StopReason };

export interface RunHandoffSweepResult {
  listed: number;
  completed: number;
  failed: number;
  waiting: number;
  errors: number;
  /** When the next listed deadline falls (epoch ms), or soon after a failure; null when nothing is live. */
  nextDueAt: number | null;
}

/** What `done` is told: the handoff is finished (the parent has ended, whether or not the child started), nothing was live, GitHub could not be asked, or the run is not this runner's any more. */
export type DoneHandoffResult = { kind: "completed" } | { kind: "none" } | { kind: "retry" } | { kind: "fenced"; reason: StopReason };

export interface RunHandoffs {
  completeRunHandoff(input: CompleteRunHandoffInput): Promise<CompleteRunHandoffResult>;
  sweepRunHandoffs(): Promise<RunHandoffSweepResult>;
  /** `done` from a run that may have a live handoff: it is finished instead of judged. `none` means the ordinary `done` goes on. */
  completeHandoffOnDone(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<DoneHandoffResult>;
}

class Unwind extends Error {}

/** The branch a runner run pushed: its continuation's own, else `<prefix><run>-g<generation>` (the formula `done` uses). */
export const runBranchOf = (job: { continues: { branch: string } | null; branch_prefix: string }, runId: string, generation: number): string => (job.continues ? job.continues.branch : `${job.branch_prefix}${runId}-g${generation}`);

interface Facts {
  status: string;
  lease_generation: number;
  job_signed: unknown;
  repo_id: string | null;
  gh_owner: string | null;
  gh_name: string | null;
}

/** Package-internal: `pool` is the runner login's pool and is captured here, never exposed. */
export function createRunHandoffs(pool: Pool, ports: RunHandoffPorts = {}): RunHandoffs {
  const now = ports.now ?? Date.now;
  const limits = ports.limits ?? runnerLimits;
  const warn = (runId: string, error: unknown) => ports.onError?.(runId, error);

  async function fail(accountId: string, runId: string, reason: HandoffFailure | "expired" | "run_ended"): Promise<{ workItemId: string | null }> {
    return withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ outcome: string; item_id: string | null }>("SELECT outcome, item_id FROM run_handoff_fail($1::uuid, $2::text)", [runId, reason]);
      return { workItemId: rows[0]?.outcome === "failed" ? rows[0].item_id : null };
    });
  }

  async function park(accountId: string, workItemId: string, runId: string, code: "work_item_ceiling" | "handoff_failed"): Promise<void> {
    try {
      await ports.park?.({ accountId, workItemId, runId, code });
    } catch (error) {
      // fx-swallow-ok: the handoff is already recorded as failed; a failed park is reported and the stage driver finds the childless end
      warn(runId, error);
    }
  }

  /** After the commit: the child starts, or the handoff fails with the work saved on its branch. */
  async function settle(input: CompleteRunHandoffInput, created: Extract<CompleteRunHandoffResult, { kind: "created" }>, branch: string | null): Promise<CompleteRunHandoffResult> {
    try {
      if (!ports.dispatchChild) throw new Error("handoff: no dispatcher is configured for the child");
      await ports.dispatchChild({ accountId: input.accountId, runId: created.childRunId, toSide: created.toSide });
      return created;
    } catch (error) {
      // fx-swallow-ok: reported through onError; the child is failed and the handoff with it just below
      warn(input.runId, error);
    }
    // A child that never started must not sit queued. The compare-and-set leaves one the dispatcher already failed, or one that started, alone.
    await writeRunStatus(pool, { accountId: input.accountId, runId: created.childRunId, from: "pending", to: "failed", failureReason: "internal_error" }).catch((error: unknown) => warn(created.childRunId, error));
    const failed = await fail(input.accountId, input.runId, "child_not_started");
    if (failed.workItemId === null) return created;
    await withTenant(pool, input.accountId, (client) => recordRunHandoffEvent(client, { accountId: input.accountId, runId: input.runId, state: "failed", branch }));
    await park(input.accountId, created.workItemId, input.runId, "handoff_failed");
    return { kind: "failed", reason: "child_not_started", workItemId: created.workItemId, branch };
  }

  async function completeRunHandoff(input: CompleteRunHandoffInput): Promise<CompleteRunHandoffResult> {
    const { accountId, runId } = input;
    const live = await withTenant(pool, accountId, async (client) => {
      const handoff = await client.query<{ state: string; deadline: Date }>("SELECT state, deadline FROM run_handoff_list_due(1, $1::uuid)", [runId]);
      const facts = await client.query<Facts>(
        `SELECT a.status, a.lease_generation, a.job_signed, r.id AS repo_id, r.gh_owner, r.gh_name
           FROM agent_runs a LEFT JOIN repos r ON r.account_id = a.account_id AND r.id = a.dispatch_repo_id
          WHERE a.account_id = $1 AND a.id = $2`,
        [accountId, runId],
      );
      return { handoff: handoff.rows[0], facts: facts.rows[0] };
    });
    const { handoff, facts } = live;
    if (!handoff || !facts || facts.status !== "running") return { kind: "none" };
    if (input.forced ? new Date(handoff.deadline).getTime() > now() : handoff.state !== "checkpointing") return { kind: "none" };
    if (!ports.base) return { kind: "unavailable" };

    // The branch comes from our own rows: the run's signed job, or the caller's own record for a run that has none.
    const job = SignedJobSchema.safeParse(facts.job_signed);
    const branch = job.success ? runBranchOf(job.data.job, runId, facts.lease_generation) : (input.branch ?? null);
    if (branch === null || !SAFE_BRANCH.test(branch) || facts.repo_id === null || facts.gh_owner === null || facts.gh_name === null) return { kind: "unavailable" };
    let head: string | null;
    try {
      head = await ports.base.headOid({ repo: { id: facts.repo_id, owner: facts.gh_owner, name: facts.gh_name }, branch });
    } catch (error) {
      // fx-swallow-ok: GitHub could not be asked, so nothing is written and the caller (the runner's retry, or the next sweep) asks again
      warn(runId, error);
      return { kind: "retry" };
    }

    let outcome: CompleteRunHandoffResult;
    try {
      outcome = await withTenant(pool, accountId, async (client): Promise<CompleteRunHandoffResult> => {
        if (input.fence) {
          const held = await leaseVerdict(client, { accountId, runnerId: input.fence.runnerId, runId, leaseGeneration: input.fence.leaseGeneration }, new Date(now()), 0, limits(accountId).maxRunWallClockMs);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
        }
        const moved = await writeRunStatusOn(client, { accountId, runId, from: "running", to: "cancelled", failureReason: "handed_off" });
        if (!moved.updated) throw new Unwind();
        const { rows } = await client.query<{ outcome: string; child_id: string | null; item_id: string | null; to_side: "cloud" | "runner" | null }>(
          "SELECT outcome, child_id, item_id, to_side FROM run_handoff_complete($1::uuid, $2::boolean, $3::int)",
          [runId, input.forced, MAX_CONTINUATIONS_PER_WORK_ITEM],
        );
        const r = rows[0];
        if (r?.outcome === "created" && r.child_id && r.item_id && r.to_side) {
          await recordRunnerDispatchBaseOn(client, { accountId, runId: r.child_id, headOid: head });
          await recordRunHandoffEvent(client, { accountId, runId, state: input.forced ? "forced" : "handed_off", branch });
          return { kind: "created", childRunId: r.child_id, toSide: r.to_side, workItemId: r.item_id, forced: input.forced };
        }
        if (r && r.item_id && (r.outcome === "work_item_ceiling" || r.outcome === "child_not_created")) {
          const state: RunHandoffState = "failed";
          await recordRunHandoffEvent(client, { accountId, runId, state, branch });
          return { kind: "failed", reason: r.outcome === "work_item_ceiling" ? "work_item_ceiling" : "child_not_started", workItemId: r.item_id, branch };
        }
        // Anything else (no live handoff, not due, not ready): the parent's move is undone with the rest.
        throw new Unwind();
      });
    } catch (error) {
      if (error instanceof Unwind) return { kind: "none" };
      throw error;
    }
    if (outcome.kind === "failed") {
      await park(accountId, outcome.workItemId, runId, outcome.reason === "work_item_ceiling" ? "work_item_ceiling" : "handoff_failed");
      return outcome;
    }
    if (outcome.kind !== "created") return outcome;
    return settle(input, outcome, branch);
  }

  async function sweepRunHandoffs(): Promise<RunHandoffSweepResult> {
    const result: RunHandoffSweepResult = { listed: 0, completed: 0, failed: 0, waiting: 0, errors: 0, nextDueAt: null };
    const soonest = (t: number) => {
      result.nextDueAt = result.nextDueAt === null ? t : Math.min(result.nextDueAt, t);
    };
    let rows: { account_id: string; run_id: string; state: string; deadline: Date; reserve_until: Date; run_status: string; ended_event: boolean }[];
    try {
      rows = (await pool.query("SELECT account_id, run_id, state, deadline, reserve_until, run_status, ended_event FROM run_handoff_list_due($1::int, NULL)", [BATCH])).rows;
    } catch (error) {
      // fx-swallow-ok: counted and handed to onError; the next tick lists again
      result.errors++;
      warn(NIL_RUN_ID, error);
      soonest(now() + HANDOFF_SWEEP_INTERVAL_MS);
      return result;
    }
    result.listed = rows.length;
    for (const row of rows) {
      const at = now();
      const deadline = new Date(row.deadline).getTime();
      try {
        if (row.run_status !== "running") {
          // The run ended some other way (a cancel, a lost lease): the move has nothing to continue. Its holds are released and the placement goes back.
          await fail(row.account_id, row.run_id, "run_ended");
          result.failed++;
        } else if (row.ended_event && row.state === "checkpointing") {
          await tally(row.account_id, row.run_id, false);
        } else if (deadline <= at) {
          if (new Date(row.reserve_until).getTime() <= at) {
            // GitHub (or the child) has not been reachable for the whole hold: release it rather than hold the money any longer.
            await fail(row.account_id, row.run_id, "expired");
            result.failed++;
          } else await tally(row.account_id, row.run_id, true);
        } else {
          result.waiting++;
          soonest(deadline);
        }
      } catch (error) {
        // fx-swallow-ok: counted and reported through onError; the next tick lists this handoff again
        result.errors++;
        warn(row.run_id, error);
        soonest(at + HANDOFF_SWEEP_INTERVAL_MS);
      }
    }
    if (result.listed >= BATCH) soonest(now() + HANDOFF_SWEEP_INTERVAL_MS);
    return result;

    async function tally(accountId: string, runId: string, forced: boolean): Promise<void> {
      const done = await completeRunHandoff({ accountId, runId, forced });
      if (done.kind === "created") result.completed++;
      else if (done.kind === "failed") result.failed++;
      else {
        // retry, unavailable or none: look again soon.
        result.waiting++;
        soonest(now() + HANDOFF_SWEEP_INTERVAL_MS);
      }
    }
  }

  async function completeHandoffOnDone(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<DoneHandoffResult> {
    const done = await completeRunHandoff({ accountId: input.accountId, runId: input.runId, forced: false, fence: { runnerId: input.runnerId, leaseGeneration: input.leaseGeneration } });
    if (done.kind === "created" || done.kind === "failed") return { kind: "completed" };
    if (done.kind === "retry" || done.kind === "fenced") return done;
    // `unavailable` means a live handoff that cannot be completed by what we hold (no GitHub read configured, or no branch/repo to read), which
    // asking again would not change; it goes on like `none` to the ordinary `done`. The handoff stays live and the sweep then ends it
    // (`run_ended`: the parent is no longer running), so the work stays on its branch. Only a GitHub read that failed (`retry`) is asked again.
    return { kind: "none" };
  }

  return { completeRunHandoff, sweepRunHandoffs, completeHandoffOnDone };
}
