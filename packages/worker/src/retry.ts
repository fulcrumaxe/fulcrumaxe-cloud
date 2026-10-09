import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { hasBlockingRetryChild } from "@fx/core/src/runActions/retryChild.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { IdempotencyKeyTakenError, WorkItemHaltedError, cancelRun, acceptQueuedRunnerRun, checkRetryAuthor, startAgentRun, type AuthorCheckProvider, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
// A relative import: @fx/model-router is not a dependency of this package and this change may not touch the lockfile.
import { escalate, type PreviousRun } from "../../model-router/src/escalate.js";
import { PREVIEW_SEAT_REFUSALS, type PreviewSeatConfig } from "./preview.js";
import { RunActionInputError, RunActionRefusedError, RunActionUnavailableError, type PerformResult } from "./runActions.js";

/**
 * D#31 API-6b-2: the worker side of `retry_run`. `performRetryRun` turns a claimed action into ONE new run
 * of the same role on the same work item, with the failed run's start prompt, on the customer's money.
 *
 * Order, and why: (1) who it runs as, from `run_action_perform_principal` (session principals only);
 * (2) the failed run, tenant-scoped; (3) every refusal that costs nothing; (4) the author check (R2c), the binding
 * gate (the route's is advisory), BEFORE the seat and the start; (5) the seat; (6) one tier of escalation; (7) the start,
 * keyed `run-action:<id>` so a replay finds the same run. Nothing is spent before step 7.
 */

/** Thrown inside the create transaction when a racing performer's child won: rolls back this attempt's run row. */
class RetryBlockedError extends Error {}

/** 0680: at most one live child per parent and role. The loser of a retry race hits it at the insert, before the in-transaction recheck. */
const ONE_LIVE_CHILD_INDEX = "agent_runs_one_live_continuation_per_parent";

/** A retry's seat: everything the run needs but what the performer supplies itself. */
export type RetrySeatConfig = PreviewSeatConfig;
export type RetrySeatResult = { ok: true; seat: RetrySeatConfig } | { ok: false; reason: string };
/**
 * The seat source (Q-6b-3 stand-in). Real piece: H14c-3-2d-2's resolveRunSeat for `{ accountId, role, workItemId }`.
 * Null in the production composition root until that merges: a retry is then refused `retry_unavailable`.
 */
export interface RetrySeatSource {
  retrySeat(input: { accountId: string; role: string; workItemId: string }): Promise<RetrySeatResult>;
}

export interface RetryModuleDeps {
  seats: RetrySeatSource | null;
  /** BuiltWorker.authorCheck: the lookup and the allowlist intake uses. Read at perform time, never cached. */
  authorCheck: AuthorCheckProvider;
}

export interface RetryFacade {
  /**
   * Performs a CLAIMED `retry_run` action. Takes the action id and nothing else. Outcome
   * `{ run_id, model, escalated_from_model }`; a replay returns the same run and starts nothing. Refusals:
   * principal_not_authorised, kind_mismatch, target_not_found, run_not_retryable (not finished, no work item, or already retried or continued),
   * retry_unavailable (no seat source), prompt_not_retained, untrusted_author, a seat refusal, or the DenyReason of a denied start.
   * An author check that cannot answer THROWS AuthorCheckUnavailableError, so the action stays accepted with backoff.
   */
  performRetryRun(actionId: string): Promise<PerformResult>;
}

/** The author check could not answer (no provider, over the cap, past the deadline, a GitHub error). Retried with backoff. */
export class AuthorCheckUnavailableError extends Error {
  constructor() {
    super("retry: author check unavailable");
    this.name = "AuthorCheckUnavailableError";
  }
}

export const RETRY_TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"] as const;
const SEAT_REFUSALS: readonly string[] = PREVIEW_SEAT_REFUSALS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** The reason R2b's sweeper records when a queued runner run expires unclaimed (`FailureReason` in @fx/runner). */
const QUEUE_TTL_REASON = "queue_ttl";
const refused = (errorCode: string): PerformResult => ({ result: "refused", errorCode });
/** H22's `runStatus` words for the terminal statuses that escalate (a spend kill is deliberately not passed on). */
const ESCALATING: Readonly<Record<string, PreviousRun["runStatus"]>> = { failed: "fail", timed_out: "timed_out" };

interface PrincipalRow {
  allowed: boolean;
  account_id: string;
  kind: string;
  target_id: string;
  principal_kind: string;
  user_id: string | null;
}
interface RunRow {
  id: string;
  status: string;
  role: string;
  work_item_id: string | null;
  /** A bigint column: node-postgres returns it as a string. */
  dispatch_pr_number: string | number | null;
  head_sha: string | null;
}
/** What step 2 reads in one tenant transaction. */
interface Found {
  run: RunRow | undefined;
  /** The `failureReason` the run's last move to its terminal status recorded, when it recorded one (a closed code). */
  failureReason: string | null;
  /** The retained start prompt; null when no `run.input` row exists or only its hash was kept. */
  prompt: string | null;
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRetryModule(runnerPool: Pool, registry: ExecutionTargetRegistry, deps: RetryModuleDeps): RetryFacade {
  const key = (actionId: string): string => `run-action:${actionId}`;

  const startedBy = async (accountId: string, userId: string, actionId: string): Promise<{ id: string; status: string } | undefined> =>
    withTenant(runnerPool, accountId, userId, async (client) => {
      const { rows } = await client.query<{ id: string; status: string }>(
        "SELECT r.id, r.status FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.account_id = k.account_id AND r.id = k.run_id WHERE k.account_id = $1 AND k.idempotency_key = $2",
        [accountId, key(actionId)],
      );
      return rows[0];
    });

  /** The first attempt's answer, read back from what it stored with the run (its model facts, or the denial's reason). */
  async function recorded(accountId: string, userId: string, run: { id: string; status: string }): Promise<PerformResult> {
    const read = (sql: string) => withTenant(runnerPool, accountId, userId, async (c) => (await c.query<{ v: unknown }>(sql, [run.id])).rows[0]?.v);
    if (run.status === "refused_spend") {
      const reason = await read("SELECT payload->>'failureReason' AS v FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'refused_spend' ORDER BY seq LIMIT 1");
      return refused(typeof reason === "string" && CODE_RE.test(reason) ? reason : "refused_spend");
    }
    const meta = (await read("SELECT payload->'meta' AS v FROM run_events WHERE run_id = $1 AND kind = 'run.input' ORDER BY seq LIMIT 1")) as { model?: string; escalated_from_model?: string | null } | null | undefined;
    return { result: "done", outcome: { run_id: run.id, model: meta?.model ?? null, escalated_from_model: meta?.escalated_from_model ?? null } };
  }

  /** A later run of the target exists. If it is THIS action's own (a kick and a sweep at once) answer with it; else another action's run won. */
  async function blockedOrOwn(accountId: string, userId: string, actionId: string): Promise<PerformResult> {
    const own = await startedBy(accountId, userId, actionId);
    return own ? recorded(accountId, userId, own) : refused("run_not_retryable");
  }

  /**
   * R-NO: a start that threw leaves the run THIS attempt created (if it got that far) cancelled and its claim released,
   * so the next attempt starts clean. Only `createdId` is touched: the claim may by now belong to a racing performer's live run.
   */
  async function cleanUp(accountId: string, userId: string, actionId: string, createdId: string | undefined): Promise<void> {
    const run = await startedBy(accountId, userId, actionId);
    if (!run || run.id !== createdId) return;
    if (!(RETRY_TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
      // The status write commits before the target is asked to release, so a throw after it still leaves the run terminal.
      await cancelRun({ pool: runnerPool, principal: { accountId, userId, kind: "session" } }, run.id, registry).catch(() => undefined);
    }
    await withTenant(runnerPool, accountId, userId, (client) => client.query("SELECT agent_run_release_idempotency_key($1::uuid, $2::text)", [accountId, key(actionId)]));
  }

  async function perform(actionId: string): Promise<PerformResult> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) throw new RunActionInputError();
    const principal = (await runnerPool.query<PrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId])).rows[0];
    if (!principal || !principal.allowed || principal.user_id === null || principal.principal_kind !== "session") return refused("principal_not_authorised");
    if (principal.kind !== "retry_run") return refused("kind_mismatch");
    const { account_id: accountId, user_id: userId, target_id: runId } = principal;

    const found = await withTenant(runnerPool, accountId, userId, async (client): Promise<Found> => {
      const run = (
        await client.query<RunRow>("SELECT id, status, role, work_item_id, dispatch_pr_number, head_sha FROM agent_runs WHERE id = $1 AND account_id = $2", [runId, accountId])
      ).rows[0];
      const input = (await client.query<{ payload: { prompt?: unknown } }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.input' ORDER BY seq LIMIT 1", [runId])).rows[0];
      const prompt = typeof input?.payload.prompt === "string" ? input.payload.prompt : null;
      const why = (
        await client.query<{ v: string | null }>(
          "SELECT payload->>'failureReason' AS v FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = $2 ORDER BY seq DESC LIMIT 1",
          [runId, run?.status ?? ""],
        )
      ).rows[0]?.v;
      return { run, prompt, failureReason: typeof why === "string" && CODE_RE.test(why) ? why : null };
    });
    const run = found.run;
    if (!run) return refused("target_not_found");
    // A replay (a second kick, a sweep, a crash after the start) is answered from the claim: nothing more is spent.
    const earlier = await startedBy(accountId, userId, actionId);
    if (earlier) return recorded(accountId, userId, earlier);

    if (!(RETRY_TERMINAL_STATUSES as readonly string[]).includes(run.status)) return refused("run_not_retryable");
    // K7: a null link cannot prove the run never carried an outside author's text (the link is SET NULL when the item is deleted).
    if (run.work_item_id === null) return refused("run_not_retryable");
    // The PR number is a bigint (a string from the driver); the run start needs a positive safe integer, so anything else is refused, never NaN.
    // Digits only (no sign, space, exponent or fraction), then a safe-integer check.
    const dispatchPr = run.dispatch_pr_number === null ? undefined : /^[1-9][0-9]*$/.test(String(run.dispatch_pr_number)) ? Number(run.dispatch_pr_number) : Number.NaN;
    if (dispatchPr !== undefined && !Number.isSafeInteger(dispatchPr)) return refused("run_not_retryable");
    // RETRY-ONCE: a live or started same-role child (a retry, a continuation) means Retry belongs on that newer run.
    if (await withTenant(runnerPool, accountId, userId, (client) => hasBlockingRetryChild(client, accountId, run.id))) return blockedOrOwn(accountId, userId, actionId);
    if (deps.seats === null) return refused("retry_unavailable");
    if (found.prompt === null) return refused("prompt_not_retained");

    // R2c: the binding author check, with the same provider the route's advisory one uses, before the seat and any start.
    const check = deps.authorCheck();
    const verdict = await checkRetryAuthor({ pool: runnerPool, accountId, userId, workItemId: run.work_item_id, lookup: check?.lookup ?? null, allowlist: check?.allowlist ?? [] });
    if (verdict === "untrusted") return refused("untrusted_author");
    if (verdict === "unavailable") throw new AuthorCheckUnavailableError();

    const seated = await deps.seats.retrySeat({ accountId, role: run.role, workItemId: run.work_item_id });
    if (!seated.ok) return refused(SEAT_REFUSALS.includes(seated.reason) ? seated.reason : "seat_refused");
    const seat = seated.seat;
    // D#6 C12 section 2.9 / A5: a run that sat in a runner's queue until it expired never ran, so the model was never at fault.
    // Its retry keeps the seat's model; every other timeout escalates as before.
    const up = found.failureReason === QUEUE_TTL_REASON ? undefined : escalate({ role: run.role, model: seat.model as PreviousRun["model"], tableVersion: 0, runStatus: ESCALATING[run.status] });
    const model = up?.model ?? seat.model;

    // The id of a run this attempt's own create transaction made (set before it commits; compared with the claim in cleanUp).
    let createdId: string | undefined;
    const input: StartAgentRunInput = {
      ...seat,
      accountId,
      role: run.role,
      workItemId: run.work_item_id,
      parentRunId: run.id,
      pr: seat.pr ?? dispatchPr,
      headSha: seat.headSha ?? run.head_sha,
      model,
      prompt: found.prompt,
      startMeta: { model, escalated_from_model: up ? seat.model : null },
      // Under the work item's exposure lock: a racing performer's child, committed since the pre-check, is seen here and this attempt rolls back.
      inCreateTransaction: async (client, id) => {
        if (await hasBlockingRetryChild(client, accountId, run.id, id)) throw new RetryBlockedError();
        createdId = id;
      },
      idempotency: { key: key(actionId), requestHash: createHash("sha256").update(`retry_run:${run.id}`).digest("hex") },
    };
    let started;
    try {
      // A retry on a runner repo is queued for a runner and nothing waits on it here: it is accepted and its id returned.
      started = await acceptQueuedRunnerRun(runnerPool, accountId, await startAgentRun(runnerPool, registry, input));
    } catch (err) {
      if (err instanceof RetryBlockedError) return blockedOrOwn(accountId, userId, actionId);
      // The item was halted: the trigger refused the insert, so nothing exists. The person resumes with Approve or Build again.
      if (err instanceof WorkItemHaltedError) return refused("item_halted");
      const pg = err as { code?: unknown; constraint?: unknown } | null;
      if (pg?.code === "23505" && pg.constraint === ONE_LIVE_CHILD_INDEX) {
        return blockedOrOwn(accountId, userId, actionId);
      }
      // Two performers raced and the other's claim won: it owns the one run.
      if (err instanceof IdempotencyKeyTakenError) {
        const winner = await startedBy(accountId, userId, actionId);
        if (winner) return recorded(accountId, userId, winner);
      }
      await cleanUp(accountId, userId, actionId, createdId).catch(() => undefined);
      throw err;
    }
    if ("reason" in started) return refused(CODE_RE.test(started.reason) ? started.reason : "refused_spend");
    return { result: "done", outcome: { run_id: started.id, model, escalated_from_model: up ? seat.model : null } };
  }

  /** Fixed errors only: a driver message can carry a host, a user or statement values. */
  async function guarded(actionId: string): Promise<PerformResult> {
    try {
      return await perform(actionId);
    } catch (err) {
      const { code, syscall } = (err ?? {}) as { code?: unknown; syscall?: unknown };
      if (err instanceof RunActionInputError || err instanceof AuthorCheckUnavailableError) throw err;
      if (typeof syscall === "string" || (typeof code === "string" && (/^(08|28|53|57P|3D)/.test(code) || /^E[A-Z]+$/.test(code)))) throw new RunActionUnavailableError();
      if (typeof code === "string" && ["42501", "P0002", "22023", "55000", "23514"].includes(code)) throw new RunActionRefusedError(code);
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) throw new RunActionUnavailableError();
      throw err;
    }
  }

  return { performRetryRun: guarded };
}
