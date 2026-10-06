import { createHash } from "node:crypto";
import { z } from "zod";
import { withTenant } from "@fx/db/src/withTenant.js";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { checkRetryAuthor, hasBlockingRetryChild, requestRunAction, type AuthorCheckProvider, type RunActionKind, type RunActionSignal } from "@fx/core/src/runActions/index.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { maxFixRounds } from "@fx/spend";
import { advanceActionFor } from "@fx/core/src/work-items/advance.js";
import {
  AlreadyRunningError,
  AuthorCheckUnavailableError,
  EscalateError,
  ExternalRequiresHumanError,
  IdempotencyKeyReusedError,
  NoRepoError,
  NotApprovableError,
  NotCancellableError,
  RunActionsUnavailableError,
  RunNotRetryableError,
  UntrustedAuthorError,
} from "../errors.js";

/**
 * Statuses with a legal edge to `cancelled` in packages/runner's
 * RUN_STATUS_TRANSITIONS (D#31 C32 s1). Declared here because @fx/api does not
 * import @fx/runner (D#2 C52 s5 criterion 5); a test reads that file as text and
 * fails on drift. Anything else, an unknown status included, is refused.
 */
export const CANCELLABLE_RUN_STATUSES = ["pending", "running", "paused"] as const;

/** The injected signal seam (D#2 C52 s5 criterion 4). `null` until H14c-3b registers the worker's signal: both POSTs then answer 503. */
export const runActionDeps: {
  getRunActionSignal: () => RunActionSignal | null;
  /**
   * The H07 author check for retry (D#31 API-6b-3): the GitHub lookup and the allowlist intake uses. `null` until
   * production registers it: an external chain then answers 503 `author_check_unavailable`, an internal one is unaffected.
   */
  getAuthorCheck: AuthorCheckProvider;
} = {
  getRunActionSignal: () => null,
  getAuthorCheck: () => null,
};

/**
 * Statuses a run cannot leave (empty edge list in packages/runner's
 * RUN_STATUS_TRANSITIONS). Only these may be retried (D#31 API-6b-1). Declared
 * here for the same reason as CANCELLABLE_RUN_STATUSES; a test reads the runner
 * file as text and fails on drift.
 */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"] as const;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATES = ["accepted", "claimed", "done", "refused", "failed"] as const;

export const acceptedSchema = z.object({ action_id: z.string().uuid(), state: z.enum(STATES) });
const runActionSchema = z.object({
  action_id: z.string().uuid(),
  kind: z.string(),
  target_id: z.string().uuid(),
  state: z.enum(STATES),
  outcome: z.record(z.string(), z.unknown()).nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export const idParamsSchema = z.object({ id: z.string() });

const ACCEPTED_TEXT =
  "Answers 202 `{ action_id, state }`, not a 200 with settled amounts: the final state arrives as the `run.status_changed` event and through `GET /api/v1/run-actions/{id}`. " +
  "A second cancel of the same live target returns the same `action_id`. A request carrying an `Idempotency-Key` that was already used replays its original `action_id` (with `Idempotent-Replayed: true`) and current `state`, even after the target has stopped. ";
const STOPPED_TEXT = "409 `not_cancellable`: nothing left to cancel. Clients should treat it as already stopped. ";

export const notFound = () => new NotFoundError("not found");

/** Definer errors reach the caller as pg codes: 42501 forbidden, P0002 not found, 22023 a reused key (D#31 C32 s3). */
export function mapDbError(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42501") throw new ForbiddenError("not permitted");
  if (code === "P0002") throw notFound();
  if (code === "22023") throw new IdempotencyKeyReusedError();
  throw err;
}

async function cancel(ctx: RouteContext, kind: Extract<RunActionKind, "cancel_run" | "cancel_work_item">, id: string) {
  // Route order (D#31 C32 s5): the gates ran in handler.ts; 2 id format, 3 signal, 4 target, 5 keyed replay, 6 cancellable, 7 request.
  if (!UUID_RE.test(id)) throw notFound();
  const signal = runActionDeps.getRunActionSignal();
  if (!signal) throw new RunActionsUnavailableError();
  const { accountId, userId, tokenId } = ctx.principal;
  const key = ctx.idempotencyKey || undefined;
  const actor = tokenId ? `token:${tokenId}` : `session:${userId}`;

  await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    let status: string | undefined;
    if (kind === "cancel_run") {
      const { rows } = await client.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [id]);
      if (!rows[0]) throw notFound();
      status = rows[0].status;
    } else {
      const { rows } = await client.query("SELECT 1 FROM work_items WHERE id = $1", [id]);
      if (!rows[0]) throw notFound();
    }
    if (key) {
      const { rows } = await client.query(
        "SELECT 1 FROM run_action_requests WHERE requested_by = $1 AND idempotency_key = $2",
        [actor, key],
      );
      if (rows[0]) return;
    }
    if (kind === "cancel_run") {
      if (!(CANCELLABLE_RUN_STATUSES as readonly string[]).includes(status!)) {
        throw new NotCancellableError(`run is ${status}`);
      }
    } else {
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND status = ANY($2::text[])",
        [id, CANCELLABLE_RUN_STATUSES],
      );
      if (Number(rows[0]!.n) === 0) throw new NotCancellableError("work item has no cancellable runs");
    }
  });

  const requestHash = createHash("sha256").update(`${kind}:${id.toLowerCase()}`).digest("hex");
  const result = await requestRunAction(
    { pool: ctx.pool, principal: ctx.principal },
    { kind, targetId: id, idempotencyKey: key, requestHash },
    { signal },
  ).catch(mapDbError);
  if (result.replayed) ctx.markReplayed?.();
  return { action_id: result.actionId, state: result.state as (typeof STATES)[number] };
}

/**
 * Retry a finished run. Same shape as `cancel`: read-only refusals first, each
 * writing nothing, then the one request. The worker that performs the retry is
 * a later step; until a signal is registered this answers 503.
 */
async function retry(ctx: RouteContext, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const signal = runActionDeps.getRunActionSignal();
  if (!signal) throw new RunActionsUnavailableError();
  const { accountId, userId, tokenId } = ctx.principal;
  const key = ctx.idempotencyKey || undefined;
  const actor = `session:${userId}`;

  const gate = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    const { rows } = await client.query<{ status: string; work_item_id: string | null }>(
      "SELECT status, work_item_id FROM agent_runs WHERE id = $1",
      [id],
    );
    const run = rows[0];
    if (!run) throw notFound();
    if (key) {
      const { rows: seen } = await client.query(
        "SELECT 1 FROM run_action_requests WHERE requested_by = $1 AND idempotency_key = $2",
        [actor, key],
      );
      // A keyed replay beats the author check (D#31 C32 s2): the action was accepted when the author was trusted.
      if (seen[0]) return { replayed: true as const, workItemId: null };
    }
    if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new RunNotRetryableError(`run is ${run.status}`);
    }
    // A null link cannot prove the run never carried an outside author's text (the link is SET NULL when the item is deleted).
    if (!run.work_item_id) throw new RunNotRetryableError("run has no work item");
    // RETRY-ONCE: a run that already has a live or started same-role child (a retry or a continuation) is retried on that child.
    if (await hasBlockingRetryChild(client, accountId, id)) throw new RunNotRetryableError("run already has a later run");
    const { rows: n } = await client.query<{ n: string }>(
      // The KPI view's count of changes_requested stages is the fix-round count (the same number the fix loop escalates on).
      "SELECT n_changes_requested AS n FROM v_kpi_work_items WHERE work_item_id = $1",
      [run.work_item_id],
    );
    if (Number(n[0]?.n ?? 0) >= maxFixRounds()) throw new EscalateError();
    return { replayed: false as const, workItemId: run.work_item_id };
  });

  // H07 (D#31 API-6b-3): the early, advisory author check. It writes nothing; the worker re-checks before it starts a run.
  // It runs after the transaction above has committed, so no connection is held across a GitHub call.
  if (!gate.replayed && gate.workItemId) {
    const check = runActionDeps.getAuthorCheck();
    const verdict = await checkRetryAuthor({
      pool: ctx.pool,
      accountId,
      userId,
      workItemId: gate.workItemId,
      lookup: check?.lookup ?? null,
      allowlist: check?.allowlist ?? [],
    });
    if (verdict === "untrusted") throw new UntrustedAuthorError();
    if (verdict === "unavailable") throw new AuthorCheckUnavailableError();
  }

  const requestHash = createHash("sha256").update(`retry_run:${id.toLowerCase()}`).digest("hex");
  const result = await requestRunAction(
    { pool: ctx.pool, principal: ctx.principal },
    { kind: "retry_run", targetId: id, idempotencyKey: key, requestHash },
    { signal },
  ).catch(mapDbError);
  if (result.replayed) ctx.markReplayed?.();
  return { action_id: result.actionId, state: result.state as (typeof STATES)[number] };
}


/**
 * D#483 P1: approve one work item into the pipeline. Session only, owner or admin. Same shape as `cancel` and
 * `retry`: read-only refusals first, each writing nothing, then the one request. The worker that performs it
 * re-checks all of it (the item can change between the request and the perform).
 *
 * Accepts only an INTERNAL item with a repo and an issue behind it, at a stage the driver can advance, that has not
 * been triaged by the pipeline yet and has no run live. An external item needs a person to move it.
 */
async function approve(ctx: RouteContext, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const signal = runActionDeps.getRunActionSignal();
  if (!signal) throw new RunActionsUnavailableError();
  const { accountId, userId, tokenId } = ctx.principal;
  const key = ctx.idempotencyKey || undefined;
  const actor = `session:${userId}`;

  await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    const { rows } = await client.query<{ stage: string; provenance: string; repo_id: string | null; gh_number: string | null; discussion_id: string | null; kind: string | null; has_spec: boolean }>(
      `SELECT w.stage, w.provenance, w.repo_id, w.gh_number, w.discussion_id, d.kind,
              EXISTS (SELECT 1 FROM spec_versions s WHERE s.work_item_id = w.id AND s.erased_at IS NULL) AS has_spec
         FROM work_items w LEFT JOIN discussions d ON d.id = w.discussion_id
        WHERE w.id = $1`,
      [id],
    );
    const item = rows[0];
    if (!item) throw notFound();
    if (key) {
      const { rows: seen } = await client.query("SELECT 1 FROM run_action_requests WHERE requested_by = $1 AND idempotency_key = $2", [actor, key]);
      // A keyed replay beats the refusals below: the action was accepted when the item was approvable.
      if (seen[0]) return;
    }
    // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
    if (item.provenance !== "internal") throw new ExternalRequiresHumanError();
    if (item.repo_id === null) throw new NoRepoError();
    if (item.gh_number === null) throw new NotApprovableError("work item has no GitHub issue");
    const verdict = advanceActionFor(item);
    if (!verdict.ok) throw new NotApprovableError(verdict.message);
    const live = await client.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND NOT (status = ANY($2::text[]))", [id, TERMINAL_RUN_STATUSES]);
    if (Number(live.rows[0]!.n) > 0) throw new AlreadyRunningError();
  });

  const requestHash = createHash("sha256").update(`advance_work_item:${id.toLowerCase()}`).digest("hex");
  const result = await requestRunAction(
    { pool: ctx.pool, principal: ctx.principal },
    { kind: "advance_work_item", targetId: id, idempotencyKey: key, requestHash },
    { signal },
  ).catch(mapDbError);
  if (result.replayed) ctx.markReplayed?.();
  return { action_id: result.actionId, state: result.state as (typeof STATES)[number] };
}

const cancelCommon = {
  method: "POST",
  principals: ["session", "token"],
  minRole: "member",
  scope: "runs:cancel",
  idempotency: "optional",
  rateClass: "write",
  paramsSchema: idParamsSchema,
  responseSchema: acceptedSchema,
  successStatus: 202,
} as const satisfies Partial<RouteEntry>;

export const UNAVAILABLE_TEXT = "Error `run_actions_unavailable`: no worker is registered to process run actions yet.";

export const runActionRoutes: RouteEntry[] = [
  {
    ...cancelCommon,
    principals: ["session", "token"],
    path: "/api/v1/runs/{id}/cancel",
    operationId: "cancelRun",
    summary: "Ask for a run to be cancelled",
    description: ACCEPTED_TEXT + STOPPED_TEXT + "A run that is not pending, running or paused is refused.",
    extraResponses: { "409": "Error `not_cancellable`: the run is already stopped.", "503": UNAVAILABLE_TEXT },
    handler: (ctx, input) => cancel(ctx, "cancel_run", input.params.id!),
  },
  {
    ...cancelCommon,
    principals: ["session", "token"],
    path: "/api/v1/work-items/{id}/cancel",
    operationId: "cancelWorkItem",
    summary: "Ask for a work item's runs to be cancelled",
    description: ACCEPTED_TEXT + STOPPED_TEXT + "A work item with no pending, running or paused run is refused.",
    extraResponses: { "409": "Error `not_cancellable`: the work item has no cancellable run.", "503": UNAVAILABLE_TEXT },
    handler: (ctx, input) => cancel(ctx, "cancel_work_item", input.params.id!),
  },
  {
    method: "POST",
    path: "/api/v1/runs/{id}/retry",
    operationId: "retryRun",
    sessionLimit: SESSION_LIMITS.runRetry,
    summary: "Ask for a finished run to be retried",
    description:
      "Session only; a token is refused. `Idempotency-Key` is required. Answers 202 `{ action_id, state }`: the new run arrives as events and the outcome through `GET /api/v1/run-actions/{id}`. " +
      "The same key, run and user replays the original `action_id` (with `Idempotent-Replayed: true`); the same key from another member is 422. " +
      "409 `run_not_retryable`: the run is still live, or it has already been retried or continued (a run is retried at most once; Retry goes on the newest run). 409 `escalate`: the work item has used its fix rounds.",
    principals: ["session"],
    minRole: "member",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "403": "Error `session_required`, `insufficient_role` or `untrusted_author`: the work item came from an outside author who no longer holds write access on the repository. There is no override.",
      "409": "Error `run_not_retryable` (the run is not finished, or already has a later run: retry the newest run) or `escalate` (fix rounds used up).",
      "503": UNAVAILABLE_TEXT + " Or `author_check_unavailable`: the author's access could not be checked right now, so nothing was started.",
    },
    handler: (ctx, input) => retry(ctx, input.params.id!),
  },
  {
    method: "POST",
    path: "/api/v1/work-items/{id}/approve",
    operationId: "approveWorkItem",
    summary: "Approve a work item into the pipeline",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. Answers 202 `{ action_id, state }`: the pipeline starts working on the work item (at `triaged`: it is triaged, then a critical or feature item is discussed by the panel and given a Spec, and a small, bug or doc item gets a short Spec from the project manager and is built; a small, bug or doc item that was triaged earlier and has no Spec gets the short Spec again; at `discussing`: the panel and the Spec run again (a Spec that already exists is superseded by the new version); at `spec_ready`: the executor builds it and opens a pull request; at `needs_human` with a published Spec (\"Build again\"): a fresh build from the same Spec, unless a pull request is still open for the issue's branch, which stops it with nothing started; at `in_progress` with nothing running: the pipeline checks whether the build opened a pull request (found: the reviewers run on it; none: the item goes to `needs_human`); at `pr_opened`, `changes_requested` or `review_passed`: the reviewers check the pull request's latest commit, the executor fixes what they ask for, and the merge is checked), and the outcome of the request arrives through `GET /api/v1/run-actions/{id}`. " +
      "Only an internal work item that has a repository and a GitHub issue behind it, has no live run (pending, running or paused) and either sits at `triaged` and has not been triaged by the pipeline yet (or was, is small, bug or doc and has no Spec), or sits at `discussing` with a panel kind (critical or feature), or sits at `needs_human` with a published Spec of a kind that is built, or sits at `spec_ready` with a published Spec of a kind that is built (not a question or a project), or sits at `in_progress` (with a published Spec), or sits at one of the three pull-request stages with a published Spec, can be approved. A second approval of the same work item while the first is still being processed returns the same `action_id`, and so does a repeat of a keyed request (with `Idempotent-Replayed: true`).",
    principals: ["session"],
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "403": "Error `session_required`, `insufficient_role` or `external_requires_human`: the work item came from an outside author, and only a person moving it starts it. There is no override.",
      "409": "Error `not_approvable` (not at a stage the pipeline advances from, already triaged, a Spec that is not built, no published Spec, or no GitHub issue behind it), `no_repo` (no repository) or `already_running` (agents are already working on it).",
      "503": UNAVAILABLE_TEXT,
    },
    handler: (ctx, input) => approve(ctx, input.params.id!),
  },
  {
    method: "GET",
    path: "/api/v1/run-actions/{id}",
    operationId: "getRunAction",
    summary: "The state of a run action",
    description: "The fallback to the `run.status_changed` event for the final state. A finished action is kept for 90 days.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: runActionSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) throw notFound();
      const { accountId, userId, tokenId } = ctx.principal;
      const row = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
        const { rows } = await client.query<{
          id: string;
          kind: string;
          target_id: string;
          state: (typeof STATES)[number];
          outcome: Record<string, unknown> | null;
          error_code: string | null;
          created_at: Date;
          finished_at: Date | null;
        }>(
          "SELECT id, kind, target_id, state, outcome, error_code, created_at, finished_at FROM run_action_requests WHERE id = $1",
          [id],
        );
        return rows[0];
      });
      if (!row) throw notFound();
      return {
        action_id: row.id,
        kind: row.kind,
        target_id: row.target_id,
        state: row.state,
        outcome: row.outcome,
        error_code: row.error_code,
        created_at: row.created_at.toISOString(),
        finished_at: row.finished_at?.toISOString() ?? null,
      };
    },
  },
];
