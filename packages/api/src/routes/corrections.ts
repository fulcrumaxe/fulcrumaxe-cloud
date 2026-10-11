import { z } from "zod";
import { DISCUSSION_KINDS, createDiscussion } from "@fx/discussions";
import { CORRECTION_KINDS, CorrectionInputError, createCorrection, type Correction } from "@fx/core/src/corrections/index.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import {
  AmendRefusedError,
  ApplyFailedError,
  ContentChangedError,
  PauseUnavailableError,
  acceptCorrection,
  checkBody,
  rejectCorrection,
  type DecisionResult,
} from "@fx/core/src/corrections/accept.js";
import { listCorrectionHistory, type CorrectionHistoryEntry } from "@fx/core/src/corrections/history.js";
import { ActionNotAvailableError, AlreadyRunningError, ApiError, ExternalRequiresHumanError, NoRepoError, RunActionsUnavailableError, SessionRequiredError } from "../errors.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { UUID_RE, mapDbError, notFound, runActionDeps } from "./run-actions.js";

/**
 * D#597 CC-2a: the three correction routes. A correction is somebody's note about a work item in flight; it is `proposed` until an
 * owner or admin accepts or rejects it. Nothing here lets an agent decide: the decision routes need an owner or admin as the
 * session, or as the creator of the token, and a token must carry the hash of the text it approves. There is no route that clears a
 * halt, moves a stage or edits a Spec.
 */

const idParamsSchema = z.object({ id: z.string() });
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const createBodySchema = z.object({ kind: z.enum(CORRECTION_KINDS), body: z.string() }).strict();
const decideBodySchema = z.object({ content_hash: hashSchema.optional() }).strict().optional();

const correctionSchema = z.object({
  id: z.string().uuid(),
  work_item_id: z.string().uuid(),
  origin: z.enum(["person", "agent"]),
  kind: z.enum(CORRECTION_KINDS),
  body: z.string(),
  status: z.enum(["proposed", "accepted", "rejected", "applied", "superseded"]),
  content_hash: z.string(),
  decided_via: z.enum(["workspace", "terminal", "auto"]).nullable(),
  applied_run_id: z.string().uuid().nullable(),
  created_by_name: z.string(),
  decided_by_name: z.string().nullable(),
  attribution: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  applied_at: z.string().nullable(),
});
const listSchema = z.object({ data: z.array(correctionSchema) });

function dto(c: Correction, h?: Partial<CorrectionHistoryEntry>) {
  return {
    id: c.id,
    work_item_id: c.workItemId,
    origin: c.origin,
    kind: c.kind,
    body: c.body,
    status: c.status,
    content_hash: c.contentHash,
    decided_via: c.decidedVia,
    applied_run_id: c.appliedRunId,
    created_by_name: h?.createdByName ?? "",
    decided_by_name: h?.decidedByName ?? null,
    attribution: h?.attribution ?? null,
    created_at: c.createdAt.toISOString(),
    decided_at: c.decidedAt?.toISOString() ?? null,
    applied_at: c.appliedAt?.toISOString() ?? null,
  };
}

function invalid(path: string): ApiError {
  return new ApiError(422, "validation_failed", "request failed validation", [{ path, code: "invalid" }]);
}

/** Core refusals as the fixed sentences a client sees; no server text is echoed. */
function mapCorrectionError(err: unknown): never {
  if (err instanceof CorrectionInputError) throw invalid("body");
  if (err instanceof ContentChangedError) throw new ApiError(409, "content_changed", "the correction text is not the text you approved");
  if (err instanceof PauseUnavailableError) throw new RunActionsUnavailableError();
  if (err instanceof AmendRefusedError) {
    // The same answers Re-spec gives for the same table's verdict. Nothing was decided.
    const v = err.verdict;
    if (v.reason === "role") throw new ForbiddenError("not permitted");
    if (v.reason === "external") throw new ExternalRequiresHumanError(v.message);
    if (v.reason === "no_repo") throw new NoRepoError(v.message);
    if (v.reason === "live") throw new AlreadyRunningError(v.message);
    throw new ActionNotAvailableError(v.message);
  }
  if (err instanceof ApplyFailedError) throw new ApiError(500, "apply_failed", "the correction could not be applied; for a new item the decision may be recorded without the item, so check the work item before deciding again");
  return mapDbError(err);
}

const cctx = (ctx: RouteContext) => ({ pool: ctx.pool, principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId } });

function requireId(id: string | undefined): string {
  if (id === undefined || !UUID_RE.test(id)) throw notFound();
  return id;
}

/**
 * CLOSED HOOK (D#597 R-597-1). Deciding is a person's act: today only an owner or admin SESSION may accept or reject, and the
 * two routes below list no token principal, so a token is refused with 403 `session_required` before this runs. A token that can
 * propose cannot also approve, whatever hash it sends. When CC-4's delegation token lands (its secret kept from the model and
 * the person's own confirmation drawn by the runner), that kind alone may be allowed here and in the routes' `principals`;
 * until then this stays false and nothing reads it as a setting.
 */
const DELEGATION_TOKEN_MAY_DECIDE = false as boolean;

async function decide(ctx: RouteContext, id: string, hash: string | undefined, to: "accept" | "reject") {
  if (ctx.principal.kind === "token" && !DELEGATION_TOKEN_MAY_DECIDE) throw new SessionRequiredError();
  const input = { id, via: "workspace" as const, contentHash: hash };
  let result: DecisionResult;
  try {
    if (to === "reject") result = await rejectCorrection(cctx(ctx), input);
    else {
      result = await acceptCorrection(cctx(ctx), input, {
        signal: runActionDeps.getRunActionSignal(),
        itemKinds: DISCUSSION_KINDS,
        createItem: async (item) => {
          // The deciding owner or admin writes it: the accept is their act.
          await createDiscussion(
            { pool: ctx.pool, principal: { kind: "session", accountId: ctx.principal.accountId, userId: ctx.principal.userId, role: ctx.principal.role } },
            { title: item.title, kind: item.kind as (typeof DISCUSSION_KINDS)[number], body: item.body },
          );
        },
      });
    }
  } catch (err) {
    throw mapCorrectionError(err);
  }
  if (result.outcome === "already_decided") throw new ApiError(409, "already_decided", "this correction was already decided");
  return dto(result.correction);
}

const SHARED = "Error `already_decided` (it already left the state this step needs; nothing changed) or `content_changed` (the `content_hash` is not the stored text's hash; nothing changed).";

export const correctionRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/work-items/{id}/corrections",
    operationId: "createCorrection",
    summary: "Propose a correction to a work item in flight",
    description:
      "Session, or a token with `corrections:write`. Records the correction as `proposed`; nothing changes until an owner or admin accepts it. A session's correction has origin `person`, a token's has origin `agent`. A `priority` body is `{\"priority\": \"urgent|high|normal|low\"}` and a `new_item` body is `{\"title\", \"kind\", \"body\"}`; both are checked now. The text is at most 4,000 characters.",
    principals: ["session", "token"],
    scope: "corrections:write",
    minRole: "member",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: createBodySchema,
    responseSchema: correctionSchema,
    successStatus: 201,
    async handler(ctx, input) {
      const workItemId = requireId(input.params.id);
      const body = input.body as z.infer<typeof createBodySchema>;
      try {
        checkBody(body.kind, body.body, DISCUSSION_KINDS);
        const c = await createCorrection(cctx(ctx), {
          workItemId,
          kind: body.kind,
          body: body.body,
          origin: ctx.principal.kind === "token" ? "agent" : "person",
        });
        return dto(c);
      } catch (err) {
        throw mapCorrectionError(err);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/work-items/{id}/corrections",
    operationId: "listCorrections",
    summary: "A work item's corrections, oldest first",
    description: "Session, or a token with `read`. Each entry says who made it and who decided it (\"a former member\" where that person is gone), and `attribution` reads \"<name> via assistant\" for an assistant's proposal or an assistant-token decision.",
    principals: ["session", "token"],
    scope: "read",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: listSchema,
    async handler(ctx, input) {
      const workItemId = requireId(input.params.id);
      const rows = await listCorrectionHistory(cctx(ctx), workItemId);
      return { data: rows.map((r) => dto(r.correction, r)) };
    },
  },
  ...(["accept", "reject"] as const).map(
    (verb): RouteEntry => ({
      method: "POST",
      path: `/api/v1/corrections/{id}/${verb}`,
      operationId: `${verb}Correction`,
      summary: `${verb === "accept" ? "Accept" : "Reject"} a proposed correction`,
      description:
        `Owner or admin session only; a token is refused (403 \`session_required\`), including one that proposed this correction. An optional \`content_hash\` must equal the stored text's hash. ` +
        (verb === "accept"
          ? "Accepting a question, pause, priority or new_item correction applies it through the existing writer and stamps it `applied`: a pause asks for the halt (undone only by a person's resume, never by a token), a priority sets the priority, a new_item creates a Discussion. A run note stays `accepted` until a run uses it. A Spec amendment stays `accepted` until the platform publishes the next Spec version (the old text plus the amendment under a labelled heading, with control tokens stripped); it is refused 409 `already_running` while an agent run of the item is live, and `action_not_available` outside Spec ready or Needs a person. "
          : "Rejecting stays possible while a correction is `proposed` or `accepted` and not yet `applied`. ") +
        "Answers 200 with the correction.",
      extraResponses: { "409": SHARED, ...(verb === "accept" ? { "503": "Error `run_actions_unavailable` for a pause or a Spec amendment: nothing was decided." } : {}) },
      principals: ["session"],
      minRole: "admin",
      idempotency: "optional",
      rateClass: "write",
      paramsSchema: idParamsSchema,
      bodySchema: decideBodySchema,
      responseSchema: correctionSchema,
      async handler(ctx, input) {
        const id = requireId(input.params.id);
        const body = input.body as z.infer<typeof decideBodySchema>;
        return decide(ctx, id, body?.content_hash, verb);
      },
    }),
  ),
];
