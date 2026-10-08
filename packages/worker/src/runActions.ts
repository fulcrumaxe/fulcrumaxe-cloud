import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { cancelRun, recordStage, type CancelRunPrincipal, type CancelRunResult, type ExecutionTargetRegistry } from "@fx/runner";

/**
 * D#2 H14c-3-2a: the run-action facade on the `Worker`.
 *
 * The `run_action_claim`, `_list_due`, `_settle` and `_purge` definers are
 * EXECUTE for `agent_run_writer` only, and `cancelRun` needs a pool it can run
 * `withTenant` on. Both are the runner login's pool, which nothing outside this
 * package may hold (CARRY-8). So the routes get these methods instead: each is
 * bound to the runner pool here, takes plain data and returns plain data. No
 * pool, client or login is an argument, a result or a property of anything
 * returned, and the platform_ops pool is never used.
 *
 * Errors: an input that fails validation is refused before any SQL with a
 * fixed `RunActionInputError` (never the raw input). A connection or login
 * failure becomes a fixed `RunActionUnavailableError` (never a host, user or
 * driver message). The definers' own refusals (42501, P0002, 22023, 55000,
 * 23514) become a fixed `RunActionRefusedError` carrying only the SQLSTATE:
 * never the driver's detail, where, table or constraint.
 */

export type RunActionSettleState = "accepted" | "done" | "refused" | "failed";

/** An input failed validation. Fixed message; the offending value is never echoed. */
export class RunActionInputError extends Error {
  constructor() {
    super("run action: invalid input");
    this.name = "RunActionInputError";
  }
}

/** The database could not be reached or refused the login. Fixed message; no host, user or driver text. */
export class RunActionUnavailableError extends Error {
  constructor() {
    super("run action: database unavailable");
    this.name = "RunActionUnavailableError";
  }
}

/** The database refused the call on purpose. Carries the SQLSTATE and a fixed message only. */
export class RunActionRefusedError extends Error {
  constructor(public readonly code: string) {
    super(`run action: refused (${code})`);
    this.name = "RunActionRefusedError";
  }
}

/** A principal kind the facade will not act for. */
export class RunActionForbiddenError extends Error {
  constructor() {
    super("run action: principal kind not permitted");
    this.name = "RunActionForbiddenError";
  }
}

/**
 * Who a cancel is for: an authenticated session member, whose active
 * membership is ALWAYS checked. There is no system, token or other kind on the
 * public surface; anything but "session" is refused at run time too.
 */
export interface RunActionPrincipal {
  accountId: string;
  userId: string;
  kind?: "session";
}

/**
 * What a perform method returns. `refused` is a policy refusal the workflow
 * settles as `refused` (no retry); `errorCode` is a fixed lower-case enum, never
 * text from the database. `done.outcome` is plain JSON.
 */
export type PerformResult = { result: "done"; outcome: Record<string, unknown> } | { result: "refused"; errorCode: string };

/** A claimed request, as data. */
export interface ClaimedRunAction {
  id: string;
  accountId: string;
  kind: string;
  targetId: string;
  requestedBy: string;
  principalKind: "session" | "token";
  attempts: number;
  /** ISO timestamp of the lease end. */
  claimedUntil: string;
}

export interface SettleRunActionInput {
  state: RunActionSettleState;
  outcome?: Record<string, unknown> | null;
  errorCode?: string | null;
  /** Only meaningful with `state: "accepted"` (a retry): seconds before the request may be claimed again (0..86400). */
  retryAfterSeconds?: number;
  /**
   * Only with `state: "accepted"`, and with no outcome, error code or delay: a page of a paged
   * cancel made progress. The request goes back to accepted, due now, WITHOUT spending an
   * attempt (a failure still does), up to MAX_PROGRESS_PAGES pages; past that the request
   * settles `failed` with error code `too_many_runs`.
   */
  progress?: true;
}

/**
 * AUTHORITY WARNING. These methods hold the runner login's pool on the
 * caller's behalf and do not decide who may call them.
 *
 * - `cancelRun`: `principal` MUST come from an authenticated request (the
 *   account from the session, never from a request body). A `token` principal
 *   or any kind other than "session" is refused with `RunActionForbiddenError`
 *   and nothing is cancelled; membership is always checked.
 * - `claimRunAction`, `settleRunAction`, `listDueRunActions` and
 *   `purgeRunActions` work ACROSS TENANTS. They are for the worker's own
 *   sweep/kick only and must never be reachable directly from a user request.
 * - H14c-3b's CARRY-28 enforces caller authorisation on the routes that use
 *   this facade; this layer does not.
 */
export interface RunActionFacade {
  /** Takes the lease on one request for `leaseSeconds` (1..3600). Null when it is not claimable. */
  claimRunAction(actionId: string, leaseSeconds: number): Promise<ClaimedRunAction | null>;
  settleRunAction(actionId: string, input: SettleRunActionInput): Promise<void>;
  /**
   * LISTS up to `limit` (1..1000) requests at least `minAgeSeconds` (0..86400) old, or with an
   * expired lease. Returns their ids and changes nothing: the lease is taken by `claimRunAction`
   * in the workflow started for each id (two sweeps may list one id; one claim wins).
   */
  listDueRunActions(minAgeSeconds: number, limit: number): Promise<string[]>;
  /** Deletes up to `limit` (1..1000) finished requests older than `olderThanSeconds` (at least one hour). Returns how many. */
  purgeRunActions(olderThanSeconds: number, limit: number): Promise<number>;
  cancelRun(principal: RunActionPrincipal, runId: string): Promise<CancelRunResult>;
  /**
   * Performs a CLAIMED `cancel_run` action. Takes the action id and nothing else:
   * who it runs as, and whether that principal may still do it, is decided by the
   * database when this runs and only while the action holds a live lease. An
   * already-finished run makes no sandbox call.
   */
  performCancelRun(actionId: string): Promise<PerformResult>;
  /**
   * Performs a CLAIMED `cancel_work_item` action, same authority. Cancels at most
   * 100 live runs per call (`remaining: true`, no stage write: settle `accepted`
   * with `progress: true` and call again), then moves the item to `needs_human` once. Not
   * one transaction, but idempotent: cancelled runs are not listed again and the
   * stage write is keyed on the action id.
   */
  performCancelWorkItem(actionId: string): Promise<PerformResult>;
}

/** Largest settle outcome, as JSON. */
export const MAX_OUTCOME_BYTES = 16 * 1024;
/** Purge never reaches into requests finished less than an hour ago. */
export const MIN_PURGE_AGE_SECONDS = 3600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SETTLE_STATES: ReadonlySet<string> = new Set(["accepted", "done", "refused", "failed"]);

export function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new RunActionInputError();
  return value;
}
function requireInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new RunActionInputError();
  return value;
}

/** A driver-level failure: login refused (28), connection exception (08), server shutdown/resources (57P, 53), or a socket error. */
function isConnectionFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  if (typeof syscall === "string") return true;
  if (typeof code !== "string") return false;
  return /^(08|28|53|57P|3D)/.test(code) || /^E[A-Z]+$/.test(code);
}

/** SQLSTATEs the definers raise on purpose; anything else from the database is not passed on as text. */
const PASS_THROUGH = new Set(["42501", "P0002", "22023", "55000", "23514"]);

export async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RunActionInputError || err instanceof RunActionForbiddenError) throw err;
    const code = (err as { code?: unknown } | null)?.code;
    if (isConnectionFailure(err)) throw new RunActionUnavailableError();
    if (typeof code === "string" && PASS_THROUGH.has(code)) throw new RunActionRefusedError(code);
    // A database error with a code we did not expect can carry the statement's
    // values; the fixed error is enough.
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !PASS_THROUGH.has(code)) throw new RunActionUnavailableError();
    throw err;
  }
}

/** The statuses a run can be cancelled from (api CANCELLABLE_RUN_STATUSES; runner isLegalRunTransition(*, "cancelled")). A drift test pins both. */
export const CANCELLABLE_RUN_STATUSES = ["pending", "running", "paused"] as const;
/** The stage a cancelled work item moves to (reversible: continue moves it back). */
const CANCELLED_ITEM_STAGE = "needs_human";
/** The stages with an edge to needs_human (stages.ts): the others are halted by the marker alone and keep their stage. */
const PARKABLE_STAGES: ReadonlySet<string> = new Set(["in_progress", "pr_opened", "changes_requested", "review_passed"]);
/** Runs cancelled per `performCancelWorkItem` call. */
const RUNS_PER_CALL = 100;
/** Progress re-queues one request may make. Pinned to the constant in run_action_requeue_progress (0686) by a test. */
export const MAX_PROGRESS_PAGES = 100;

interface PerformPrincipalRow {
  allowed: boolean;
  account_id: string;
  kind: string;
  target_id: string;
  principal_kind: "session" | "token";
  user_id: string | null;
}
interface Performer {
  accountId: string;
  userId: string;
  targetId: string;
  principal: CancelRunPrincipal;
}

const isNamed = (err: unknown, name: string): boolean => typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
const refused = (errorCode: string): PerformResult => ({ result: "refused", errorCode });

/** Asks the database who this claimed action runs as. Refuses with one code, never which check failed. */
async function performerFor(runnerPool: Pool, actionId: string, kind: string): Promise<Performer | PerformResult> {
  const { rows } = await runnerPool.query<PerformPrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId]);
  const r = rows[0];
  if (!r || !r.allowed || r.user_id === null) return refused("principal_not_authorised");
  if (r.kind !== kind) return refused("kind_mismatch");
  return {
    accountId: r.account_id,
    userId: r.user_id,
    targetId: r.target_id,
    principal: { accountId: r.account_id, userId: r.user_id, kind: r.principal_kind },
  };
}
const isPerformer = (v: Performer | PerformResult): v is Performer => "principal" in v;

/**
 * One run of a perform. A finished run is answered from read-only sums with NO
 * runner or target call; a live one goes through the runner's `cancelRun`
 * unchanged. Null when the run does not exist in the account.
 */
async function cancelOneRun(runnerPool: Pool, registry: ExecutionTargetRegistry, who: Performer, runId: string): Promise<CancelRunResult | null> {
  const status = await withTenant(runnerPool, who.accountId, who.userId, async (client) => {
    const { rows } = await client.query<{ status: CancelRunResult["status"] }>("SELECT status FROM agent_runs WHERE id = $1 AND account_id = $2", [
      runId,
      who.accountId,
    ]);
    return rows[0]?.status;
  });
  if (status === undefined) return null;
  try {
    if (!(CANCELLABLE_RUN_STATUSES as readonly string[]).includes(status)) {
      return await withTenant(runnerPool, who.accountId, who.userId, async (client) => {
        const settled = await client.query<{ sum: string }>("SELECT COALESCE(SUM(usd), 0)::text AS sum FROM ledger WHERE account_id = $1 AND run_id = $2", [
          who.accountId,
          runId,
        ]);
        const released = await client.query<{ sum: string }>(
          "SELECT COALESCE(SUM(usd_reserved), 0)::text AS sum FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'released'",
          [who.accountId, runId],
        );
        return { status, settled_usd: Number(settled.rows[0]!.sum), released_usd: Number(released.rows[0]!.sum) };
      });
    }
    return await cancelRun({ pool: runnerPool, principal: who.principal }, runId, registry);
  } catch (err) {
    if (isNamed(err, "NotFoundError")) return null;
    throw err;
  }
}

interface ClaimRow {
  id: string | null;
  account_id: string;
  kind: string;
  target_id: string;
  requested_by: string;
  principal_kind: "session" | "token";
  attempts: number;
  claimed_until: Date | string;
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunActionFacade(runnerPool: Pool, registry: ExecutionTargetRegistry): RunActionFacade {
  return {
    claimRunAction: (actionId, leaseSeconds) =>
      guarded(async () => {
        const id = requireUuid(actionId);
        const lease = requireInt(leaseSeconds, 1, 3600);
        const { rows } = await runnerPool.query<ClaimRow>("SELECT * FROM run_action_claim($1::uuid, $2::int)", [id, lease]);
        const r = rows[0];
        // Nothing claimable: the definer returns a NULL composite, which arrives as one row of nulls.
        if (!r || r.id === null) return null;
        return {
          id: r.id,
          accountId: r.account_id,
          kind: r.kind,
          targetId: r.target_id,
          requestedBy: r.requested_by,
          principalKind: r.principal_kind,
          attempts: r.attempts,
          claimedUntil: new Date(r.claimed_until).toISOString(),
        };
      }),
    settleRunAction: (actionId, input) =>
      guarded(async () => {
        const id = requireUuid(actionId);
        if (typeof input !== "object" || input === null || !SETTLE_STATES.has(input.state)) throw new RunActionInputError();
        const retry = input.retryAfterSeconds === undefined ? null : requireInt(input.retryAfterSeconds, 0, 86400);
        if (input.errorCode != null && (typeof input.errorCode !== "string" || !ERROR_CODE_RE.test(input.errorCode))) {
          throw new RunActionInputError();
        }
        if (input.progress !== undefined) {
          // Progress is a re-queue that gives the attempt back: nothing else may ride along with it.
          if (input.progress !== true || input.state !== "accepted" || input.outcome != null || input.errorCode != null || retry !== null) {
            throw new RunActionInputError();
          }
          // The definer writes nothing at the cap; the terminal settle (and its events) stays the settle definer's.
          const { rows } = await runnerPool.query<{ r: string }>("SELECT run_action_requeue_progress($1::uuid) AS r", [id]);
          if (rows[0]?.r === "cap_reached") {
            await runnerPool.query("SELECT run_action_settle($1::uuid, 'failed', $2::jsonb, 'too_many_runs', NULL)", [id, JSON.stringify({ reason: "too_many_runs" })]);
          }
          return;
        }
        let outcome: string | null = null;
        if (input.outcome != null) {
          if (typeof input.outcome !== "object" || Array.isArray(input.outcome)) throw new RunActionInputError();
          outcome = JSON.stringify(input.outcome);
          if (outcome === undefined || Buffer.byteLength(outcome, "utf8") > MAX_OUTCOME_BYTES) throw new RunActionInputError();
        }
        await runnerPool.query("SELECT run_action_settle($1::uuid, $2::text, $3::jsonb, $4::text, $5::int)", [
          id,
          input.state,
          outcome,
          input.errorCode ?? null,
          retry,
        ]);
      }),
    listDueRunActions: (minAgeSeconds, limit) =>
      guarded(async () => {
        const age = requireInt(minAgeSeconds, 0, 86400);
        const n = requireInt(limit, 1, 1000);
        const { rows } = await runnerPool.query<{ id: string }>(
          "SELECT run_action_list_due AS id FROM run_action_list_due($1::int, $2::int)",
          [age, n],
        );
        return rows.map((r) => r.id);
      }),
    purgeRunActions: (olderThanSeconds, limit) =>
      guarded(async () => {
        const age = requireInt(olderThanSeconds, MIN_PURGE_AGE_SECONDS, 10 * 365 * 86400);
        const n = requireInt(limit, 1, 1000);
        const { rows } = await runnerPool.query<{ n: number }>("SELECT run_action_purge(make_interval(secs => $1::int), $2::int) AS n", [age, n]);
        return rows[0]?.n ?? 0;
      }),
    cancelRun: (principal, runId) =>
      guarded(async () => {
        // Only a session principal may cancel, and its membership is always checked by the
        // runner. A token, "system" or anything else is refused before the run id is looked at.
        if (typeof principal !== "object" || principal === null) throw new RunActionInputError();
        const kind: unknown = principal.kind;
        if (kind !== undefined && kind !== "session") throw new RunActionForbiddenError();
        // Both ids are checked here: the runner takes a function-typed userId as a callback
        // and skips the membership check, and a null one throws a raw error.
        const accountId = requireUuid(principal.accountId);
        const userId = requireUuid(principal.userId);
        return cancelRun({ pool: runnerPool, principal: { accountId, userId, kind: "session" } }, runId, registry);
      }),
    performCancelRun: (actionId) =>
      guarded(async () => {
        const id = requireUuid(actionId);
        const who = await performerFor(runnerPool, id, "cancel_run");
        if (!isPerformer(who)) return who;
        const r = await cancelOneRun(runnerPool, registry, who, who.targetId);
        return r ? { result: "done", outcome: { ...r } } : refused("target_not_found");
      }),
    performCancelWorkItem: (actionId) =>
      guarded(async () => {
        const id = requireUuid(actionId);
        const who = await performerFor(runnerPool, id, "cancel_work_item");
        if (!isPerformer(who)) return who;
        // 1. The marker, in one transaction under the item's row lock. A create in flight holds a share lock on the row (the
        // trigger on agent_runs, 0750), so this waits for it and the list below sees its run; a create that starts after this
        // commits is refused by the trigger. Neither depends on the stage. A replay or a later page of the same action
        // leaves the three marker columns as the first call set them.
        const parked = await withTenant(runnerPool, who.accountId, who.userId, async (client) => {
          const item = await client.query<{ halt_action_id: string | null; stage: string }>(
            "SELECT halt_action_id, stage FROM work_items WHERE account_id = $1 AND id = $2 FOR UPDATE",
            [who.accountId, who.targetId],
          );
          const row = item.rows[0];
          if (!row) return null;
          if (row.halt_action_id !== id) {
            await client.query(
              "UPDATE work_items SET halted_at = clock_timestamp(), halt_action_id = $3, halt_epoch = halt_epoch + 1 WHERE account_id = $1 AND id = $2",
              [who.accountId, who.targetId, id],
            );
          }
          // The park is a courtesy of the board, only where the stage graph has the edge: the marker is what stops things.
          let stage = "unchanged";
          if (PARKABLE_STAGES.has(row.stage) || row.stage === CANCELLED_ITEM_STAGE) {
            try {
              await recordStage(client, { workItemId: who.targetId, toStage: CANCELLED_ITEM_STAGE, at: new Date(), source: "control_plane", sourceRef: `run-action:${id}` });
              stage = CANCELLED_ITEM_STAGE;
            } catch (err) {
              if (!isNamed(err, "IllegalStageTransitionError")) throw err;
            }
          }
          return stage;
        });
        if (parked === null) return refused("target_not_found");
        // 2. One list, complete because of 1. A failed cancel fails the action and the marker stays (fail closed).
        const listed = await withTenant(runnerPool, who.accountId, who.userId, async (client) => {
          const runs = await client.query<{ id: string }>(
            `SELECT id FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND status = ANY($3::text[])
              ORDER BY created_at, id LIMIT ${RUNS_PER_CALL + 1}`,
            [who.accountId, who.targetId, [...CANCELLABLE_RUN_STATUSES]],
          );
          return runs.rows.map((r) => r.id);
        });
        let cancelled = 0;
        let settled = 0;
        let released = 0;
        for (const runId of listed.slice(0, RUNS_PER_CALL)) {
          const r = await cancelOneRun(runnerPool, registry, who, runId);
          if (!r) continue; // deleted since it was listed
          if (r.status === "cancelled") cancelled += 1;
          settled += r.settled_usd;
          released += r.released_usd;
        }
        if (listed.length > RUNS_PER_CALL) {
          return { result: "done", outcome: { runs_cancelled: cancelled, settled_usd: settled, released_usd: released, remaining: true, halted: true } };
        }
        return { result: "done", outcome: { runs_cancelled: cancelled, settled_usd: settled, released_usd: released, stage: parked, halted: true } };
      }),
  };
}
