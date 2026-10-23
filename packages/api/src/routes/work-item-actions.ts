import { createHash } from "node:crypto";
import { z } from "zod";
import { requestRunAction } from "@fx/core/src/runActions/index.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { OperatorMovedOnError, OperatorRefusedError, RequestChangesNoteError, checkRespec, closeWorkItem, reopenWorkItem, requestChanges, requestPublicChangeAction, sendBackToDiscussion, treatAsFeature } from "@fx/core/src/work-items/operatorMoves.js";
import { REQUEST_CHANGES_NOTE_MAX } from "@fx/core/src/work-items/operatorActions.js";
import type { OperatorVerdict } from "@fx/core/src/work-items/operatorActions.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { ActionNotAvailableError, AlreadyRunningError, ApiError, EscalateError, ExternalRequiresHumanError, NoRepoError, RunActionsUnavailableError } from "../errors.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { UNAVAILABLE_TEXT, STATES, UUID_RE, acceptedSchema, idParamsSchema, mapDbError, notFound, runActionDeps } from "./run-actions.js";

/**
 * Three explicit routes for the ways a person gets a stuck work item moving or ends it: Back to discussion, Treat as a
 * feature and Close. (Build again is not here: it is the same operation as approving a Spec ready item, a row of the stage
 * driver's one table, so `POST /work-items/{id}/approve` does it from Needs a person.) Why routes of their own and not the
 * approve route with a body: approve takes no body (a body is refused), and these change the item's state in ways approve
 * cannot name; each is one verb on one path, with its own refusals and its own OpenAPI entry.
 *
 * What decides whether an action applies lives in ONE place, @fx/core's work-items/operatorActions.ts, and the writes are
 * in work-items/operatorMoves.ts (this package never writes a stage; a test pins that). The Pipeline app draws its buttons
 * from the same table (the activity read lists the actions), so the app and these routes cannot disagree.
 *
 * Shape, as the approve route: session only, owner or admin (minRole admin), read-only refusals first and each writing
 * nothing, then the writes in ONE transaction (the stage move or the kind change, and its audit row). Back to discussion
 * and Treat as a feature then ask for the stage driver's `advance_work_item` run action, exactly as approve does; if that
 * request fails after the move, the item sits at Discussing, where Approve ("Try the Spec again") starts it. Close writes
 * and answers at once: no agent is involved.
 */

const closedSchema = z.object({ work_item_id: z.string().uuid(), stage: z.literal("closed") });

/** A refusal from the table, as the error a client sees. Nothing has been written when this throws. */
function refuse(v: Extract<OperatorVerdict, { ok: false }>): never {
  switch (v.reason) {
    case "role":
      throw new ForbiddenError("not permitted");
    case "external":
      throw new ExternalRequiresHumanError(v.message);
    case "no_repo":
      throw new NoRepoError(v.message);
    case "live":
      throw new AlreadyRunningError(v.message);
    case "rounds":
      throw new EscalateError(v.message);
    default:
      throw new ActionNotAvailableError(v.message);
  }
}

/** The core writes throw the table's refusal; the stage moving between the read and the write is the same answer as the wrong stage. */
async function guarded<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof OperatorRefusedError) refuse(err.verdict);
    if (err instanceof OperatorMovedOnError) throw new ActionNotAvailableError("work item moved on; open it again");
    throw err;
  }
}

/**
 * Back to discussion and Treat as a feature: the write, then the stage driver's run action. Re-spec (D#6 R4d-5b) is the same shape with a read-only "write" (the
 * table's check) and a run action of its own kind, `respec_work_item`: its only write is the publish of the next Spec version, made by the driver once the
 * project manager's list is read.
 */
async function driven(ctx: RouteContext, id: string, write: (move: Parameters<typeof closeWorkItem>[0], id: string) => Promise<unknown>, kind: "advance_work_item" | "respec_work_item" = "advance_work_item") {
  if (!UUID_RE.test(id)) throw notFound();
  const signal = runActionDeps.getRunActionSignal();
  if (!signal) throw new RunActionsUnavailableError();
  const key = ctx.idempotencyKey || undefined;

  await guarded(() => write({ pool: ctx.pool, principal: ctx.principal, idempotencyKey: key ?? null }, id));

  const requestHash = createHash("sha256").update(`${kind}:${id.toLowerCase()}`).digest("hex");
  const result = await requestRunAction(
    { pool: ctx.pool, principal: ctx.principal },
    { kind, targetId: id, idempotencyKey: key, requestHash },
    { signal },
  ).catch(mapDbError);
  if (result.replayed) ctx.markReplayed?.();
  return { action_id: result.actionId, state: result.state as (typeof STATES)[number] };
}

/** Close: no agent is involved, so it writes and answers. The pull-request stages are not closable from here (see CLOSE_ON_GITHUB_STAGES). */
async function close(ctx: RouteContext, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const done = await guarded(() => closeWorkItem({ pool: ctx.pool, principal: ctx.principal, idempotencyKey: ctx.idempotencyKey || null }, id));
  return { work_item_id: done.workItemId, stage: done.stage };
}

/** Reopen: `closed` back to `triaged`; no agent is involved, so it writes and answers. */
async function reopen(ctx: RouteContext, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const done = await guarded(() => reopenWorkItem({ pool: ctx.pool, principal: ctx.principal, idempotencyKey: ctx.idempotencyKey || null }, id));
  return { work_item_id: done.workItemId, stage: done.stage };
}

/**
 * D#598 P1f-6b: the two ports Try the push again and Open the pull request again reach the worker through (this package never imports it). Both are `null` until
 * apps/web registers them, and the routes then answer 503 before anything is written. Plain data in, so a fake in a test needs no Workflow service.
 */
export const publicChangeDeps: {
  /** Starts the durable job that makes the next push attempt (one step: the worker's `retryPublish`). Resolves once the start is accepted. */
  startRetryPush: ((args: { accountId: string; userId: string; workItemId: string }) => Promise<void>) | null;
  /** Opens the public pull request for a pushed branch, now, and says how it ended. `skipped`: the item no longer allows it. */
  openPublicPullRequest: ((args: { accountId: string; workItemId: string }) => Promise<{ kind: "opened"; prNumber: number } | { kind: "refused"; code: string } | { kind: "skipped" } | { kind: "not_configured" }>) | null;
} = { startRetryPush: null, openPublicPullRequest: null };

const retryStartedSchema = z.object({ work_item_id: z.string().uuid(), state: z.literal("started") });
const openPrSchema = z.object({ work_item_id: z.string().uuid(), result: z.enum(["opened", "refused"]), code: z.string().nullable(), pr_number: z.number().int().nullable() });

/** Try the push again: the table's verdict and the audit row first, then the durable job; the attempt's outcome reaches the item's public change on its next read. */
async function retryPush(ctx: RouteContext, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const start = publicChangeDeps.startRetryPush;
  if (!start) throw new RunActionsUnavailableError();
  await guarded(() => requestPublicChangeAction({ pool: ctx.pool, principal: ctx.principal, idempotencyKey: ctx.idempotencyKey || null }, id, "retry_push"));
  // fx-swallow-ok: the job did not start, so no attempt was made; the item still shows the refusal and the button, and the answer is the usual 503
  await start({ accountId: ctx.principal.accountId, userId: ctx.principal.userId, workItemId: id }).catch(() => {
    throw new RunActionsUnavailableError();
  });
  return { work_item_id: id, state: "started" as const };
}

/** Open the pull request again: no sandbox and no git, one call to GitHub, so it answers with the outcome. */
async function openPr(ctx: RouteContext, id: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const open = publicChangeDeps.openPublicPullRequest;
  if (!open) throw new RunActionsUnavailableError();
  await guarded(() => requestPublicChangeAction({ pool: ctx.pool, principal: ctx.principal, idempotencyKey: ctx.idempotencyKey || null }, id, "open_pr"));
  const r = await open({ accountId: ctx.principal.accountId, workItemId: id });
  if (r.kind === "not_configured") throw new RunActionsUnavailableError();
  if (r.kind === "skipped") throw new ActionNotAvailableError("work item moved on; open it again");
  return r.kind === "opened" ? { work_item_id: id, result: "opened" as const, code: null, pr_number: r.prNumber } : { work_item_id: id, result: "refused" as const, code: r.code, pr_number: null };
}

/** The note: the person's own words, at least one character that is not a space and at most REQUEST_CHANGES_NOTE_MAX characters (code points, as the store counts). */
const requestChangesBody = z
  .object({ note: z.string().refine((v) => v.trim() !== "" && Array.from(v.trim()).length <= REQUEST_CHANGES_NOTE_MAX && !v.includes("\u0000"), { message: `1 to ${REQUEST_CHANGES_NOTE_MAX} characters` }) })
  .strict();

/**
 * Request changes: the person's note and the move into Changes requested (one transaction, in @fx/core), then the stage driver's `advance_work_item`, which
 * starts the fix round first because the note is pending. A keyed repeat writes nothing again: with the same note it answers with the action the first request
 * was given, with another note it is refused (`idempotency_key_reused`).
 */
async function requestChangesRoute(ctx: RouteContext, id: string, note: string) {
  if (!UUID_RE.test(id)) throw notFound();
  const signal = runActionDeps.getRunActionSignal();
  if (!signal) throw new RunActionsUnavailableError();
  const key = ctx.idempotencyKey || undefined;
  const { accountId, userId, tokenId } = ctx.principal;
  const seen = key
    ? await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => (await client.query("SELECT 1 FROM run_action_requests WHERE requested_by = $1 AND idempotency_key = $2", [`session:${userId}`, key])).rowCount !== 0)
    : false;
  if (!seen) {
    await guarded(() =>
      requestChanges({ pool: ctx.pool, principal: ctx.principal, idempotencyKey: key ?? null }, id, note).catch((err: unknown) => {
        if (err instanceof RequestChangesNoteError) throw new ApiError(422, "invalid_note", err.message);
        throw err;
      }),
    );
  }
  // The note is part of what the key names: the same key with another note is a different request. The API's idempotency layer refuses that first (422
  // `idempotency_key_reused`, any route); this hash keeps the run-action record refusing it the same way once that layer's 24-hour record is gone.
  const noteHash = createHash("sha256").update(note.trim()).digest("hex");
  const requestHash = createHash("sha256").update(`request_changes:${id.toLowerCase()}:${noteHash}`).digest("hex");
  const result = await requestRunAction({ pool: ctx.pool, principal: ctx.principal }, { kind: "advance_work_item", targetId: id, idempotencyKey: key, requestHash }, { signal }).catch(mapDbError);
  if (result.replayed) ctx.markReplayed?.();
  return { action_id: result.actionId, state: result.state as (typeof STATES)[number] };
}

const reopenedSchema = z.object({ work_item_id: z.string().uuid(), stage: z.literal("triaged") });

const common = {
  method: "POST",
  principals: ["session"],
  minRole: "admin",
  idempotency: "optional",
  rateClass: "write",
  paramsSchema: idParamsSchema,
} as const satisfies Partial<RouteEntry>;

const SHARED_ERRORS =
  "Error `session_required` or `insufficient_role` (owner or admin only), or `external_requires_human` (only an internal work item can be moved from here; there is no override).";

export const workItemActionRoutes: RouteEntry[] = [
  {
    ...common,
    path: "/api/v1/work-items/{id}/request-changes",
    operationId: "requestChangesWorkItem",
    summary: "Ask for changes on a work item's open pull request",
    description:
      `Session only, owner or admin; a token is refused. Body \`{ note }\`: what to change, 1 to ${REQUEST_CHANGES_NOTE_MAX} characters. \`Idempotency-Key\` is optional. ` +
      "Records the note on the work item (as a run note the caller accepts, with its audit rows), moves the item to `changes_requested`, and asks the pipeline to start a fix round: the executor works on the same pull request branch with the note (passed to it as data inside the untrusted-content fence, alongside any reviewer findings on the current commit), then the reviewers check the new commit and the merge is checked as usual. " +
      "Answers 202 `{ action_id, state }`; the outcome arrives through `GET /api/v1/run-actions/{id}`. The fix round counts toward the item's fix-round limit and waits on spending limits like any other. A fix that pushes nothing stops at `needs_human`. " +
      "Allowed only for an internal work item with a repository, a GitHub issue and a published Spec, at `pr_opened`, `changes_requested` or `review_passed`, or at `needs_human` when it came there from one of those (its pull request was open), with no live run (pending, running or paused) and a fix round left. A keyed repeat with the same note writes nothing and answers with the first request's `action_id`; the same key with a different note is 422 `idempotency_key_reused`, as on every route, and nothing is written. GitHub reviews and pull request comments are not read for this.",
    bodySchema: requestChangesBody,
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "422": "Error `validation_failed` or `invalid_note` (the note is empty or longer than the limit), or `idempotency_key_reused` (the key was already used with a different note).",
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (no open pull request, no Spec, or no GitHub issue), `no_repo` (no repository), `already_running` (agents are already working on it) or `escalate` (the item has used its fix rounds).",
      "503": UNAVAILABLE_TEXT,
    },
    handler: (ctx, input) => requestChangesRoute(ctx, input.params.id!, (input.body as z.infer<typeof requestChangesBody>).note),
  },
  {
    ...common,
    path: "/api/v1/work-items/{id}/respec",
    operationId: "respecWorkItem",
    summary: "Add the file list to a work item's Spec",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. For a Spec that has no file list the platform can read (every Spec written before the list existed, or one whose list is unreadable): asks the pipeline to have the project manager read the repository and list the files the Spec's change may touch, and then publishes the next Spec version, with the same text and the list added. Answers 202 `{ action_id, state }`; the outcome arrives through `GET /api/v1/run-actions/{id}`. " +
      "Allowed only for an internal work item with a repository and a GitHub issue behind it, at `spec_ready` or `needs_human`, whose newest Spec has no readable file list, with no live run (pending, running or paused). Nothing is changed unless the project manager's list is read: an unreadable list publishes nothing and the item stays where it was. A Re-spec from `needs_human` leaves the item at `spec_ready`; then Build again. The route writes nothing itself.",
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (not at `spec_ready` or `needs_human`, no Spec, a kind that is not built, no GitHub issue, or the newest Spec already has a readable file list), `no_repo` (no repository) or `already_running` (agents are already working on it).",
      "503": UNAVAILABLE_TEXT,
    },
    handler: (ctx, input) => driven(ctx, input.params.id!, checkRespec, "respec_work_item"),
  },
  {
    ...common,
    path: "/api/v1/work-items/{id}/back-to-discussion",
    operationId: "backToDiscussionWorkItem",
    summary: "Send a work item that needs a person back to the panel",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. Moves a work item from `needs_human` to `discussing` and asks the pipeline to run the panel and the Spec again: the panel is asked afresh (its earlier comments stay in the record but are not counted) and a new Spec version supersedes the old one. Answers 202 `{ action_id, state }`; the outcome arrives through `GET /api/v1/run-actions/{id}`. " +
      "Only an internal work item that has a repository and a GitHub issue behind it, sits at `needs_human` with a published Spec, is of a kind that has a panel (critical or feature), and has no live run (pending, running or paused) can be sent back. If the request for the pipeline fails after the move, the item stays at `discussing` and approving it starts the panel again.",
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (not at `needs_human`, no Spec, a kind with no panel, or no GitHub issue), `no_repo` (no repository) or `already_running` (agents are already working on it).",
      "503": UNAVAILABLE_TEXT,
    },
    handler: (ctx, input) => driven(ctx, input.params.id!, sendBackToDiscussion),
  },
  {
    ...common,
    path: "/api/v1/work-items/{id}/treat-as-feature",
    operationId: "treatWorkItemAsFeature",
    summary: "Treat a project work item as a feature",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. A project has no panel, so a work item at `discussing` with kind `project` is stuck. This changes its kind (and its discussion's) to `feature`, records an audit row with the old and the new kind and who did it, and asks the pipeline to run the panel and the Spec as for a feature. Answers 202 `{ action_id, state }`; the outcome arrives through `GET /api/v1/run-actions/{id}`. " +
      "Only an internal work item with a repository and a GitHub issue behind it, at `discussing`, whose kind is `project`, with no live run, can be treated as a feature. If the request for the pipeline fails after the change, the item is a feature at `discussing` and approving it starts the panel.",
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (not at `discussing`, not a project, or no GitHub issue), `no_repo` (no repository) or `already_running` (agents are already working on it).",
      "503": UNAVAILABLE_TEXT,
    },
    handler: (ctx, input) => driven(ctx, input.params.id!, treatAsFeature),
  },
  {
    ...common,
    path: "/api/v1/work-items/{id}/close",
    operationId: "closeWorkItem",
    summary: "Close an open work item",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. Moves an internal work item to `closed` and records an audit row with who closed it. Answers 200 `{ work_item_id, stage }` at once; no agent is involved. " +
      "Allowed at `triaged`, `discussing`, `spec_ready`, `in_progress` and `needs_human` when no run is live (pending, running or paused: cancel it first). An item with an open pull request (`pr_opened`, `changes_requested`, `review_passed`) is not closed here: closing the pull request on GitHub moves it to `closed_unmerged` through the webhook. A merged or already closed item is refused.",
    responseSchema: closedSchema,
    extraResponses: {
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (the work item is at a stage that cannot be closed from here, including an open pull request) or `already_running` (agents are working on it; cancel the run first).",
    },
    handler: (ctx, input) => close(ctx, input.params.id!),
  },
  {
    ...common,
    path: "/api/v1/work-items/{id}/reopen",
    operationId: "reopenWorkItem",
    summary: "Reopen a closed work item",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. Moves an internal work item from `closed` back to `triaged` and records an audit row with who reopened it; it can then be approved again. Answers 200 `{ work_item_id, stage }` at once; no agent is involved. " +
      "Allowed only at `closed`. A merged item or one closed without a merge (`closed_unmerged`) is a pull request's outcome and is refused.",
    responseSchema: reopenedSchema,
    extraResponses: {
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (the work item is not at `closed`) or `already_running` (agents are working on it).",
    },
    handler: (ctx, input) => reopen(ctx, input.params.id!),
  },
  {
    ...common,
    path: "/api/v1/work-items/{id}/retry-push",
    operationId: "retryPushWorkItem",
    summary: "Try the push to the public repository again",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. For a work item whose push to its paired public repository was refused on a build the platform ran: records an audit row and starts one more push attempt (at most three per item). Answers 202 `{ work_item_id, state: 'started' }` before the attempt has run; how it ended is the item's `public_change` on the next activity read, where a refusal shows as its fixed sentence. " +
      "Allowed only while `public_change.actions` lists `retry_push` (the same rule): the push is `refused`, its latest attempt ran in the platform's sandbox, fewer than three attempts were made, nobody has taken the branch over, and no agent run of the item is live. A repository that is no longer paired ends the attempt with the stored refusal `pairing_off`, with nothing pushed.",
    responseSchema: retryStartedSchema,
    successStatus: 202,
    extraResponses: {
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (the item has no refused push that may be tried again) or `already_running` (an agent run of the item is live, a publish attempt included).",
      "503": UNAVAILABLE_TEXT,
    },
    handler: (ctx, input) => retryPush(ctx, input.params.id!),
  },
  {
    ...common,
    path: "/api/v1/work-items/{id}/open-pr",
    operationId: "openPrWorkItem",
    summary: "Open the public pull request again",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. `Idempotency-Key` is optional. For a work item whose branch was pushed to its paired public repository but whose pull request was not opened: records an audit row, checks that the branch still holds exactly what was pushed, and opens the pull request, with no sandbox and no push. Answers 200 `{ work_item_id, result, code, pr_number }`: `opened` with the number, or `refused` with a fixed `code` and the branch left as it is. " +
      "Allowed only while `public_change.actions` lists `open_pr`: the state is `pushed_pr_not_opened`, nobody has taken the branch over, and no agent run of the item is live.",
    responseSchema: openPrSchema,
    extraResponses: {
      "403": SHARED_ERRORS,
      "409": "Error `action_not_available` (the item has no pushed branch waiting for a pull request) or `already_running` (an agent run of the item is live).",
      "503": UNAVAILABLE_TEXT,
    },
    handler: (ctx, input) => openPr(ctx, input.params.id!),
  },
];
