import { createHash, randomInt } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  CLAIM_IDLE_RETRY_AFTER_SECONDS,
  CLAIM_QUEUED_RETRY_AFTER_SECONDS,
  RUNNER_ELIGIBLE_ROLES,
  RUNNER_LEASE_SECONDS,
  SignedJobSchema,
  canonicalJson,
  redactDeep,
  type LocalOnlyEvent,
  type RunEndedReason,
  type SignedJob,
  type StopReason,
} from "@fulcrumaxe/runner-protocol";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { insertRunnerEvent, writeRunStatusOn, type FailureReason, type RepoVisibilityPort } from "@fx/runner";
import { guarded, requireUuid, RunActionInputError, RunActionRefusedError } from "./runActions.js";
import { runnerLimits, type RunnerLimitsSource } from "./runnerLimits.js";
import { requestFollowUp, settleFollowUp, type FollowUpOutcome, type FollowUpPorts } from "./runnerFollowUp.js";

/**
 * D#6 R2b-3 (C9 section 1, C12 section 2.6, C14, C21): the runner lease facade on the `Worker`. Claim, heartbeat and events are
 * the routes' only way to `agent_runs`' lease columns and status, which only the run-writer login may write (CARRY-8), so each
 * is a method here that takes and returns plain data. Every write is one tenant transaction: the fence
 * (`agent_run_runner_lease`, migration 0754) locks the run row, and whatever the call then writes commits with it or not at all.
 *
 * AUTHORITY WARNING. These methods do not decide who may call them. `accountId` and `runnerId` MUST be the ones a verified
 * runner request carries (the signature verifier in packages/runner-cloud); nothing here reads them from a request body.
 *
 * A runner that does not exist in the account or is revoked is a `RunActionRefusedError("42501")` (the routes answer 401).
 */

/** Candidates one claim looks at before it gives up for this poll. */
const CLAIM_CANDIDATES = 5;

export interface ClaimRunnerRunInput {
  accountId: string;
  runnerId: string;
}

export type ClaimRunnerRunResult =
  | { kind: "claimed"; signedJob: SignedJob; runId: string; leaseGeneration: number }
  /** Nothing to hand out. `retryAfter` is seconds: 60 with nothing waiting, 5 to 15 with work queued. */
  | { kind: "idle"; retryAfter: number };

/** Why a lease check did not say `ok` (the verdicts of `agent_run_runner_lease`). Every one of them answers the runner 409 `{continue:false, reason}`. */
export type LeaseVerdict = "ok" | "unknown" | "stale" | "not_running" | "revoked" | "expired" | "wall_clock";

/**
 * The reason a runner is told when it no longer holds a run (C21 section 1). It is derived from the verdict and never stored.
 * A revoked runner's runs are ended by the revoke itself, so `revoked` is a finished run to the runner that still sees it.
 */
export function stopReasonFor(verdict: Exclude<LeaseVerdict, "ok">): StopReason {
  switch (verdict) {
    case "unknown":
    case "stale":
      return "stale_generation";
    case "expired":
      return "lease_expired";
    case "wall_clock":
      return "wall_clock_limit";
    case "not_running":
    case "revoked":
      return "run_terminal";
  }
}

export interface HeartbeatRunnerRunInput {
  accountId: string;
  runnerId: string;
  runId: string;
  leaseGeneration: number;
}

export interface IngestRunnerEventsInput extends HeartbeatRunnerRunInput {
  events: readonly LocalOnlyEvent[];
}

export type HeartbeatRunnerRunResult = { verdict: "ok"; leaseExpiresAt: Date } | { verdict: Exclude<LeaseVerdict, "ok">; reason: StopReason };

export type IngestRunnerEventsResult =
  | {
      outcome: "accepted";
      /** Events newly written. */
      stored: number;
      /** Events the database guard dropped: already stored under that number, with the same body or another one. */
      duplicates: number;
      /** Of `duplicates`, the ones whose body differed from the stored one. A count only; the dropped body is never kept. */
      conflicts: number;
      ended: RunnerEndReason | null;
      /** The lease's new end; unchanged when this batch ended the run. */
      leaseExpiresAt: Date;
    }
  /** The batch's numbers do not strictly increase: 400 `seq_order`. Nothing was read or written. */
  | { outcome: "seq_order" }
  /** The batch starts at or below the last accepted number: 409 `seq_not_increasing`, naming that number. Nothing was written. */
  | { outcome: "seq_not_increasing"; lastAcceptedSeq: number }
  | { outcome: "fenced"; verdict: Exclude<LeaseVerdict, "ok">; reason: StopReason };

export interface RunnerClaimFacade {
  /** Hands the runner one run it may take, or says to ask again later. */
  claimRunnerRun(input: ClaimRunnerRunInput): Promise<ClaimRunnerRunResult>;
  /** Extends the lease by 90 seconds when the runner still holds the run. */
  heartbeatRunnerRun(input: HeartbeatRunnerRunInput): Promise<HeartbeatRunnerRunResult>;
  /**
   * Stores a batch of the runner's events and extends the lease. A `usage_limit_reached` or `credential_mismatch` event ends the
   * run `failed`; a usage limit also makes the follow-up run, claimable at the reset time the runner reported (C21 section 4).
   * A `run_ended` event ends it as C24 section 1's table says (`RUN_ENDED_ENDINGS`); only its `runner_shutdown` reason makes a follow-up.
   */
  ingestRunnerEvents(input: IngestRunnerEventsInput): Promise<IngestRunnerEventsResult>;
}

export interface RunnerClaimDeps {
  visibility: RepoVisibilityPort;
  /** Tests inject a fixed clock (milliseconds since the epoch). */
  now?: () => number;
  /** A whole number in [min, max]; tests pin it. */
  randomBetween?: (min: number, max: number) => number;
  /** The concurrency and wall-clock figures per account (C21 section 8). Defaults to `runnerLimits`. */
  limits?: RunnerLimitsSource;
  /** Dispatches the follow-up run after a usage limit. Absent: the child is made (pending, without a job) and the queue sweep expires it. */
  followUp?: FollowUpPorts;
  /** Told when the work after an accepted batch (the follow-up's dispatch) failed; the batch itself stays accepted. */
  onError?: (runId: string, error: unknown) => void;
}

interface CandidateRow {
  id: string;
  dispatch_repo_id: string;
  job_signed: unknown;
}

/** What an ending event writes: the run's new status and failure reason, and whether the same transaction makes a follow-up run. */
interface Ending {
  to: "failed" | "timed_out";
  reason: FailureReason;
  followUp: boolean;
}

/** The `FailureReason` an event can end a run with. */
export type RunnerEndReason = "usage_limit" | "credential_mismatch" | "job_refused" | "public_repo" | "agent_failed" | "wall_clock_limit" | "runner_setup_failed" | "runner_lost" | "push_rejected";

/**
 * What each terminal event records (the first one stored in a batch wins). `run_ended` (D#6 R4a-2, correction C24 section 1) is keyed
 * by its closed `reason`, which the protocol schema has already checked; every value recorded comes from this table and none from the
 * event, so nothing the runner sends becomes free text. Only a usage limit and a shutdown make a follow-up run: the others would end
 * the same way again. A shutdown is a lost runner told early, so it counts toward the same limit of two losses.
 */
const ENDING_EVENTS = { usage_limit_reached: "usage_limit", credential_mismatch: "credential_mismatch" } as const satisfies Record<string, FailureReason>;
const RUN_ENDED_ENDINGS = {
  job_refused: { to: "failed", reason: "job_refused", followUp: false },
  repo_not_private: { to: "failed", reason: "public_repo", followUp: false },
  agent_failed: { to: "failed", reason: "agent_failed", followUp: false },
  wall_clock: { to: "timed_out", reason: "wall_clock_limit", followUp: false },
  runner_setup: { to: "failed", reason: "runner_setup_failed", followUp: false },
  runner_shutdown: { to: "failed", reason: "runner_lost", followUp: true },
  // D#6 R4a-3b (C25 section 1.4): the fix round's branch moved while the agent worked. A retry runs on the new head, so no automatic follow-up.
  push_rejected: { to: "failed", reason: "push_rejected", followUp: false },
} as const satisfies Record<RunEndedReason, Ending>;

/** The ending a stored event causes, or null for an event that ends nothing. */
function endingOf(event: LocalOnlyEvent): Ending | null {
  if (event.type === "usage_limit_reached") return { to: "failed", reason: ENDING_EVENTS.usage_limit_reached, followUp: true };
  if (event.type === "credential_mismatch") return { to: "failed", reason: ENDING_EVENTS.credential_mismatch, followUp: false };
  // Own-property lookup: a reason that is not a key of the table (such as "constructor") ends nothing, whatever parsed the event.
  if (event.type === "run_ended" && event.reason !== undefined && Object.hasOwn(RUN_ENDED_ENDINGS, event.reason)) return RUN_ENDED_ENDINGS[event.reason];
  return null;
}

/** The fence (`agent_run_runner_lease`, 0754) on a client already inside the tenant transaction. Shared with the sweeper. */
export const leaseVerdict = async (client: PoolClient, i: HeartbeatRunnerRunInput, now: Date, extendSeconds: number, maxWallClockMs: number): Promise<LeaseVerdict> => {
  const { rows } = await client.query<{ verdict: LeaseVerdict }>("SELECT agent_run_runner_lease($1::uuid, $2::uuid, $3::uuid, $4::int, $5::timestamptz, $6::int, $7::bigint) AS verdict", [
    i.accountId,
    i.runId,
    i.runnerId,
    i.leaseGeneration,
    now,
    extendSeconds,
    maxWallClockMs,
  ]);
  return rows[0]!.verdict;
};

export function requireLease(input: HeartbeatRunnerRunInput): void {
  if (typeof input !== "object" || input === null) throw new RunActionInputError();
  requireUuid(input.accountId);
  requireUuid(input.runnerId);
  requireUuid(input.runId);
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 0) throw new RunActionInputError();
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerClaimFacade(runnerPool: Pool, deps: RunnerClaimDeps): RunnerClaimFacade {
  const now = deps.now ?? Date.now;
  const between = deps.randomBetween ?? ((min, max) => randomInt(min, max + 1));
  const limits = deps.limits ?? runnerLimits;

  async function loadRunner(accountId: string, runnerId: string) {
    const runner = await withTenant(runnerPool, accountId, async (client) => {
      const { rows } = await client.query<{ registered_by: string; credential_mode: string; allowed_repo_ids: string[]; allowed_roles: string[]; revoked_at: Date | null }>(
        "SELECT registered_by, credential_mode, allowed_repo_ids, allowed_roles, revoked_at FROM runners WHERE id = $1 AND account_id = $2",
        [runnerId, accountId],
      );
      return rows[0];
    });
    if (!runner || runner.revoked_at !== null) throw new RunActionRefusedError("42501");
    return runner;
  }

  const idle = async (accountId: string): Promise<ClaimRunnerRunResult> => {
    // A run held back until a reset time, and one with no job yet (a dispatch that has not finished or never will), is not work a
    // runner could take now, so neither shortens the poll (C22 section 3).
    const queued = await withTenant(runnerPool, accountId, async (client) => {
      const { rows } = await client.query(
        "SELECT 1 FROM agent_runs WHERE account_id = $1 AND runtime = 'runner' AND status = 'pending' AND job_signed IS NOT NULL AND (claimable_after IS NULL OR claimable_after <= $2::timestamptz) LIMIT 1",
        [accountId, new Date(now())],
      );
      return rows.length > 0;
    });
    return { kind: "idle", retryAfter: queued ? between(CLAIM_QUEUED_RETRY_AFTER_SECONDS.min, CLAIM_QUEUED_RETRY_AFTER_SECONDS.max) : CLAIM_IDLE_RETRY_AFTER_SECONDS };
  };

  /** The claim of one candidate, in one transaction. */
  async function claimOne(accountId: string, runnerId: string, runId: string): Promise<{ generation: number } | "at_limit" | "taken"> {
    return withTenant(runnerPool, accountId, async (client) => {
      // One claimer per account at a time, so the concurrency count below cannot be raced past its limit.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`runner_claim:${accountId}`]);
      const running = await client.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND runtime = 'runner' AND status = 'running'", [accountId]);
      if (Number(running.rows[0]!.n) >= limits(accountId).maxConcurrentRunnerJobs) return "at_limit" as const;
      const locked = await client.query("SELECT id FROM agent_runs WHERE account_id = $1 AND id = $2 AND status = 'pending' AND runner_id IS NULL FOR UPDATE SKIP LOCKED", [accountId, runId]);
      if (locked.rows.length === 0) return "taken" as const;
      const moved = await writeRunStatusOn(client, { accountId, runId, from: "pending", to: "running" });
      if (!moved.updated) return "taken" as const;
      const { rows } = await client.query<{ generation: number | null }>("SELECT agent_run_runner_claim($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::int) AS generation", [
        accountId,
        runId,
        runnerId,
        new Date(now()),
        RUNNER_LEASE_SECONDS,
      ]);
      const generation = rows[0]?.generation;
      // Throwing rolls the status move back with it: a run is never `running` without a lease.
      if (generation === null || generation === undefined) throw new RunActionRefusedError("55000");
      return { generation };
    });
  }

  return {
    claimRunnerRun: (input) =>
      guarded(async () => {
        if (typeof input !== "object" || input === null) throw new RunActionInputError();
        const accountId = requireUuid(input.accountId);
        const runnerId = requireUuid(input.runnerId);
        const runner = await loadRunner(accountId, runnerId);
        // An empty `allowed_roles` means every runner-eligible role; a non-empty one narrows the set, and the eligible set is always the hard limit (C21 section 3).
        const eligible: readonly string[] = RUNNER_ELIGIBLE_ROLES;
        const roles = runner.allowed_roles.length === 0 ? [...eligible] : runner.allowed_roles.filter((role) => eligible.includes(role));
        if (runner.allowed_repo_ids.length === 0 || roles.length === 0) return idle(accountId);

        const tried: string[] = [];
        const seen = new Map<string, "private" | "public" | "unknown">();
        for (let attempt = 0; attempt < CLAIM_CANDIDATES; attempt++) {
          const candidates = await withTenant(runnerPool, accountId, async (client) => {
            const { rows } = await client.query<CandidateRow>(
              `SELECT a.id, a.dispatch_repo_id, a.job_signed
                 FROM agent_runs a
                 JOIN repos r ON r.account_id = a.account_id AND r.id = a.dispatch_repo_id
                 LEFT JOIN agent_runs p ON p.account_id = a.account_id AND p.id = a.parent_run_id
                WHERE a.account_id = $1 AND a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode = 'runner_local'
                  AND a.runner_id IS NULL AND a.job_signed IS NOT NULL AND r.execution_mode = 'runner_local'
                  AND a.dispatch_repo_id = ANY($2::uuid[]) AND a.role = ANY($3::text[])
                  AND ($4 <> 'subscription' OR a.initiated_by = $5 OR a.approved_by = $5)
                  AND a.id <> ALL($6::uuid[])
                  AND (a.claimable_after IS NULL OR a.claimable_after <= $8::timestamptz)
                ORDER BY (p.runner_id IS NOT NULL AND p.runner_id = $7) DESC, a.created_at, a.id
                LIMIT 1`,
              [accountId, runner.allowed_repo_ids, roles, runner.credential_mode, runner.registered_by, tried, runnerId, new Date(now())],
            );
            return rows;
          });
          const candidate = candidates[0];
          if (!candidate) break;
          tried.push(candidate.id);

          const parsed = SignedJobSchema.safeParse(candidate.job_signed);
          // A job that does not parse, or has expired, is left for the sweeper; a runner would refuse it anyway.
          if (!parsed.success || Date.parse(parsed.data.job.expires_at) <= now()) continue;

          // The repo may have been made public since dispatch, and a visibility that cannot be read is not private (C12 section 5).
          let visibility = seen.get(candidate.dispatch_repo_id);
          if (!visibility) {
            visibility = await deps.visibility.visibility({ accountId, repoId: candidate.dispatch_repo_id }).catch((): "unknown" => "unknown");
            seen.set(candidate.dispatch_repo_id, visibility);
          }
          if (visibility !== "private") {
            const failureReason: FailureReason = visibility === "public" ? "public_repo" : "repo_visibility_unknown";
            await withTenant(runnerPool, accountId, (client) => writeRunStatusOn(client, { accountId, runId: candidate.id, from: "pending", to: "failed", failureReason }));
            continue;
          }

          const claimed = await claimOne(accountId, runnerId, candidate.id);
          if (claimed === "taken") continue;
          if (claimed === "at_limit") return idle(accountId);
          // Tells the runner sweeper when this lease ends, so its cron tick does not open the database before then (D#454 H3c's
          // marker; best effort, and an earlier marker is never pushed later). Heartbeats do not mark: a tick that connects
          // re-derives the next due time from the rows.
          void markWorkPending("runner-sweeper", { since: now() + RUNNER_LEASE_SECONDS * 1000 });
          return { kind: "claimed", signedJob: parsed.data, runId: candidate.id, leaseGeneration: claimed.generation };
        }
        return idle(accountId);
      }),

    heartbeatRunnerRun: (input) =>
      guarded(async () => {
        requireLease(input);
        const at = new Date(now());
        const verdict = await withTenant(runnerPool, input.accountId, (client) => leaseVerdict(client, input, at, RUNNER_LEASE_SECONDS, limits(input.accountId).maxRunWallClockMs));
        if (verdict !== "ok") return { verdict, reason: stopReasonFor(verdict) };
        return { verdict, leaseExpiresAt: new Date(at.getTime() + RUNNER_LEASE_SECONDS * 1000) };
      }),

    ingestRunnerEvents: (input) =>
      guarded(async () => {
        requireLease(input);
        if (!Array.isArray(input.events) || input.events.length === 0) throw new RunActionInputError();
        // In the batch the numbers strictly increase (C21 section 2); a batch that does not is refused before anything is read.
        for (let i = 1; i < input.events.length; i++) if (input.events[i]!.seq <= input.events[i - 1]!.seq) return { outcome: "seq_order" };
        const maxWallClockMs = limits(input.accountId).maxRunWallClockMs;
        const result = await withTenant(runnerPool, input.accountId, async (client): Promise<IngestRunnerEventsResult & { followUp?: FollowUpOutcome | null }> => {
          const at = new Date(now());
          // Fence first, without moving the lease: a refused batch must leave it alone. The fence takes the run row's lock and
          // holds it to the end of this transaction, so the last accepted number read below cannot move under it.
          const held = await leaseVerdict(client, input, at, 0, maxWallClockMs);
          if (held !== "ok") return { outcome: "fenced", verdict: held, reason: stopReasonFor(held) };
          const last = await client.query<{ last: string | null }>("SELECT max(runner_seq) AS last FROM run_events WHERE run_id = $1 AND account_id = $2", [input.runId, input.accountId]);
          if (last.rows[0]?.last != null && input.events[0]!.seq <= Number(last.rows[0].last)) return { outcome: "seq_not_increasing", lastAcceptedSeq: Number(last.rows[0].last) };

          let stored = 0;
          let duplicates = 0;
          let conflicts = 0;
          let ending: Ending | null = null;
          for (const event of input.events) {
            // G2 at ingest: the runner redacts before it sends, and the cloud does it again before anything is stored.
            const clean = redactDeep(event, []);
            // `ON CONFLICT (run_id, runner_seq) DO NOTHING` is the defence against a race; a body that differs from the stored one is counted and dropped.
            const outcome = await insertRunnerEvent(client, {
              accountId: input.accountId,
              runId: input.runId,
              runnerSeq: event.seq,
              bodySha256: createHash("sha256").update(canonicalJson(event), "utf8").digest("hex"),
              payload: clean as unknown as Record<string, unknown>,
            });
            if (outcome === "stored") stored++;
            else {
              duplicates++;
              if (outcome === "conflict") conflicts++;
            }
            if (outcome === "stored" && ending === null) ending = endingOf(event);
          }
          if (ending === null) {
            await leaseVerdict(client, input, at, RUNNER_LEASE_SECONDS, maxWallClockMs);
            return { outcome: "accepted", stored, duplicates, conflicts, ended: null, leaseExpiresAt: new Date(at.getTime() + RUNNER_LEASE_SECONDS * 1000) };
          }
          await writeRunStatusOn(client, { accountId: input.accountId, runId: input.runId, from: "running", to: ending.to, failureReason: ending.reason });
          // A usage limit or a shutdown makes the run that follows it, in this same transaction: the child commits with the status move or not at all.
          const followUp = ending.followUp ? await requestFollowUp(client, input.runId) : null;
          const lease = await client.query<{ lease_expires_at: Date }>("SELECT lease_expires_at FROM agent_runs WHERE id = $1 AND account_id = $2", [input.runId, input.accountId]);
          return { outcome: "accepted", stored, duplicates, conflicts, ended: ending.reason as RunnerEndReason, leaseExpiresAt: lease.rows[0]!.lease_expires_at, followUp };
        });
        const { followUp, ...reply } = result as IngestRunnerEventsResult & { followUp?: FollowUpOutcome | null };
        if (followUp && deps.followUp) {
          // After the commit. The batch is accepted whatever happens here; a child that could not be dispatched has been failed by the port.
          await settleFollowUp(deps.followUp, input.accountId, input.runId, followUp).catch((error: unknown) => deps.onError?.(input.runId, error));
        }
        return reply;
      }),
  };
}
