import { z } from "zod";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import {
  DISCUSSION_KINDS,
  VISIBILITIES,
  assertAllowed,
  clearSecurity,
  createDiscussion,
  editOwnComment,
  getDiscussion,
  listComments,
  listDiscussions,
  postComment,
  reviseDiscussion,
  setSecurity,
  setVisibility,
  tombstoneComment,
  type CommentView,
  type Discussion,
  type DiscussionDetail,
  type DiscussionsContext,
  type Principal as DiscussionsPrincipal,
  type TokenScope,
} from "@fx/discussions";
import type { RouteContext, RouteEntry } from "../registry.js";
import { ApiError, InsufficientScopeError, SessionRequiredError } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";

const discussionSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int(),
  root_work_item_id: z.string().uuid(),
  kind: z.enum(DISCUSSION_KINDS),
  title: z.string(),
  visibility: z.enum(VISIBILITIES),
  security: z.boolean(),
  provenance: z.enum(["internal", "external"]),
  created_at: z.string(),
});

const discussionDetailSchema = discussionSchema.extend({
  body: z.string(),
  rev: z.number().int(),
  revised_at: z.string(),
});

const listResponseSchema = z.object({ data: z.array(discussionSchema), next_cursor: z.string().nullable() });
const revisionResponseSchema = z.object({ rev: z.number().int() });

const listQuerySchema = z.object({ limit: z.string().optional(), cursor: z.string().optional() });
const idParamsSchema = z.object({ id: z.string() });

// `.loose()` keeps unknown keys so an `account_id` reaches `refuseAccountId` instead of being stripped.
const createBodySchema = z
  .object({
    title: z.string().min(1).max(256),
    kind: z.enum(DISCUSSION_KINDS),
    body: z.string(),
    visibility: z.enum(VISIBILITIES).optional(),
    security: z.boolean().optional(),
    // Checked in the service: a foreign, missing or malformed id is one 422.
    repo_id: z.string().nullish(),
  })
  .loose();
type CreateBody = z.infer<typeof createBodySchema>;

const patchBodySchema = z
  .object({ visibility: z.enum(VISIBILITIES).optional(), security: z.boolean().optional() })
  .loose()
  .refine((b) => b.visibility !== undefined || b.security !== undefined, "visibility or security is required")
  .refine((b) => !(b.security === true && b.visibility !== undefined && b.visibility !== "private"), "a security discussion must stay private");
type PatchBody = z.infer<typeof patchBodySchema>;

const reviseBodySchema = z.object({ body: z.string() }).loose();
type ReviseBody = z.infer<typeof reviseBodySchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id is the same 404 as a missing or other-tenant one, before any query. */
function requireId(id: string | undefined): string {
  if (id === undefined || !UUID_RE.test(id)) throw new NotFoundError("discussion not found");
  return id;
}

function refuseAccountId(body: object): void {
  if (Object.hasOwn(body, "account_id") || Object.hasOwn(body, "accountId")) {
    throw new ApiError(400, "invalid_input", "request body must not carry an account id");
  }
}

/** The service principal for this request. A token's `read` scope is the service's `read`; its `discussions:write` scope is the service's `write` (never implied by `read`). */
function serviceCtx(ctx: RouteContext): DiscussionsContext {
  const p = ctx.principal;
  const scopes: TokenScope[] = [];
  if (p.scopes.includes("read")) scopes.push("read");
  if (p.scopes.includes("discussions:write")) scopes.push("write");
  const principal: DiscussionsPrincipal =
    p.kind === "token"
      ? { kind: "token", accountId: p.accountId, userId: p.userId, tokenId: p.tokenId!, scopes }
      : { kind: "session", accountId: p.accountId, userId: p.userId, role: p.role };
  return { pool: ctx.pool, principal };
}

function toDto(d: Discussion) {
  return {
    id: d.id,
    number: d.number,
    root_work_item_id: d.rootWorkItemId,
    kind: d.kind,
    title: d.title,
    visibility: d.visibility,
    security: d.security,
    provenance: d.provenance,
    created_at: d.createdAt.toISOString(),
  };
}

function toDetailDto(d: DiscussionDetail) {
  return { ...toDto(d), body: d.body, rev: d.rev, revised_at: d.revisedAt.toISOString() };
}

/** D#71 DS-3a-1: the five discussion routes over `@fx/discussions`. Reads are S+T(read); the three writes are S+T(discussions:write), and a token may only set `security` to true. */
export const discussionRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/discussions",
    operationId: "listDiscussions",
    summary: "The account's discussions, newest first, paginated",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listQuerySchema,
    responseSchema: listResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const page = await listDiscussions(serviceCtx(ctx), {
        limit,
        // The cursor carries microseconds; the service pages on milliseconds.
        after: cursor ? { createdAt: new Date(`${cursor.created_at.slice(0, 23)}Z`), id: cursor.id } : undefined,
      });
      const last = page.nextCursor;
      return {
        data: page.items.map(toDto),
        next_cursor: last ? encodeCursor(last.createdAt.toISOString().replace("Z", "000Z"), last.id) : null,
      };
    },
  },
  {
    method: "POST",
    path: "/api/v1/discussions",
    operationId: "createDiscussion",
    summary: "Create a discussion with its first revision",
    description:
      "Session, or a token with `discussions:write`. An optional `repo_id` must be one of the account's repos; a missing, malformed or other-account id is one 422 `validation_failed` at `repo_id`. A body over the size limit is 413 `payload_too_large`; an account over its storage quota is 413 `storage_quota_exceeded`.",
    extraResponses: { "413": "Error `payload_too_large` or `storage_quota_exceeded`." },
    principals: ["session", "token"],
    minRole: "member",
    scope: "discussions:write",
    idempotency: "optional",
    rateClass: "write",
    bodySchema: createBodySchema,
    responseSchema: discussionSchema,
    successStatus: 201,
    async handler(ctx, input) {
      const body = input.body as CreateBody;
      refuseAccountId(body);
      const created = await createDiscussion(serviceCtx(ctx), {
        title: body.title,
        kind: body.kind,
        body: body.body,
        visibility: body.visibility,
        security: body.security,
        repoId: body.repo_id ?? null,
      });
      return toDto(created);
    },
  },
  {
    method: "GET",
    path: "/api/v1/discussions/{id}",
    operationId: "getDiscussion",
    summary: "A discussion with its latest revision",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: discussionDetailSchema,
    async handler(ctx, input) {
      const detail = await getDiscussion(serviceCtx(ctx), { discussionId: requireId(input.params.id) });
      return toDetailDto(detail);
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/discussions/{id}",
    operationId: "patchDiscussion",
    summary: "Change a discussion's visibility or security flag",
    description:
      "Session, or a token with `discussions:write`. Changing visibility, or clearing `security`, needs an owner or admin session (a token is 403 `session_required`); any member, or a token, may set `security` to true, which also makes the discussion private. Stage changes are not made here.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "discussions:write",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: patchBodySchema,
    responseSchema: discussionDetailSchema,
    async handler(ctx, input) {
      const body = input.body as PatchBody;
      refuseAccountId(body);
      const discussionId = requireId(input.params.id);
      const sctx = serviceCtx(ctx);
      // A token may only turn `security` on: changing visibility and clearing are human-only, refused before any write.
      if (ctx.principal.kind === "token" && ((body.visibility !== undefined && body.security !== true) || body.security === false)) {
        throw new SessionRequiredError("this change needs a session principal");
      }
      // The response reads the discussion back, and `discussions:write` does not imply `read`: refuse before writing rather than write and then 403.
      if (ctx.principal.kind === "token" && !ctx.principal.scopes.includes("read")) {
        throw new InsufficientScopeError("PATCH returns the discussion, which needs the read scope as well");
      }
      const setsVisibility = body.visibility !== undefined && body.security !== true;
      // Authorise every requested change before the first write, so a refusal never leaves half of a PATCH applied.
      if (setsVisibility) assertAllowed(sctx.principal, "visibility.set");
      if (body.security !== undefined) assertAllowed(sctx.principal, body.security ? "security.set" : "security.clear");
      if (body.security === false) await clearSecurity(sctx, { discussionId });
      if (body.security === true) await setSecurity(sctx, { discussionId });
      if (setsVisibility) await setVisibility(sctx, { discussionId, visibility: body.visibility! });
      return toDetailDto(await getDiscussion(sctx, { discussionId }));
    },
  },
  {
    method: "POST",
    path: "/api/v1/discussions/{id}/revisions",
    operationId: "reviseDiscussion",
    summary: "Add a revision to a discussion's body",
    description:
      "Session, or a token with `discussions:write`. An owner or admin session may revise any discussion; a member, or a token, only one its creator made. 413 `payload_too_large` or `storage_quota_exceeded` as for create.",
    extraResponses: { "413": "Error `payload_too_large` or `storage_quota_exceeded`." },
    principals: ["session", "token"],
    minRole: "member",
    scope: "discussions:write",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: reviseBodySchema,
    responseSchema: revisionResponseSchema,
    successStatus: 201,
    async handler(ctx, input) {
      const body = input.body as ReviseBody;
      refuseAccountId(body);
      const { rev } = await reviseDiscussion(serviceCtx(ctx), { discussionId: requireId(input.params.id), body: body.body });
      return { rev };
    },
  },
];

const commentSchema = z.object({
  id: z.string().uuid(),
  discussion_id: z.string().uuid(),
  reply_to_id: z.string().uuid().nullable(),
  author_kind: z.enum(["user", "agent", "system", "github"]),
  created_at: z.string(),
});
const commentViewSchema = commentSchema.extend({
  author_user_id: z.string().uuid().nullable(),
  role: z.string().nullable(),
  body: z.string().nullable(),
  edited_at: z.string().nullable(),
  deleted: z.boolean(),
});
const commentListResponseSchema = z.object({ data: z.array(commentViewSchema), next_cursor: z.string().nullable() });
// Postgres text cannot hold NUL: refuse it as a 422 instead of letting the insert fail as a 500.
const commentText = z.string().refine((t) => !t.includes("\u0000"), "body must not contain a NUL character");
const postCommentBodySchema = z.object({ body: commentText, reply_to_id: z.string().uuid().nullish() }).loose();
const editCommentBodySchema = z.object({ body: commentText }).loose();

/** Same 404 as a missing or other-tenant comment, before any query. */
function requireCommentId(id: string | undefined): string {
  if (id === undefined || !UUID_RE.test(id)) throw new NotFoundError("comment not found");
  return id;
}

function toCommentDto(c: { id: string; discussionId: string; replyToId: string | null; authorKind: CommentView["authorKind"]; createdAt: Date }) {
  return { id: c.id, discussion_id: c.discussionId, reply_to_id: c.replyToId, author_kind: c.authorKind, created_at: c.createdAt.toISOString() };
}

function toCommentViewDto(c: CommentView) {
  return {
    ...toCommentDto(c),
    author_user_id: c.authorUserId,
    role: c.role,
    // Comment bodies are untrusted text: returned as data in a JSON string, never interpreted.
    body: c.body,
    edited_at: c.editedAt ? c.editedAt.toISOString() : null,
    deleted: c.deleted,
  };
}

/** D#71 DS-3a-2: the four comment routes over `@fx/discussions`. Posting and editing admit `discussions:write` tokens; tombstoning is owner/admin session only. */
export const commentRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/discussions/{id}/comments",
    operationId: "listComments",
    summary: "A discussion's comments in thread order, paginated",
    description: "A tombstoned comment keeps its row with `body: null` and `deleted: true`, so replies still have their parent.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    querySchema: listQuerySchema,
    responseSchema: commentListResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const page = await listComments(serviceCtx(ctx), {
        discussionId: requireId(input.params.id),
        limit,
        // The cursor carries microseconds; the service pages on milliseconds.
        after: cursor ? { createdAt: new Date(`${cursor.created_at.slice(0, 23)}Z`), id: cursor.id } : undefined,
      });
      const last = page.nextCursor;
      return {
        data: page.items.map(toCommentViewDto),
        next_cursor: last ? encodeCursor(last.createdAt.toISOString().replace("Z", "000Z"), last.id) : null,
      };
    },
  },
  {
    method: "POST",
    path: "/api/v1/discussions/{id}/comments",
    operationId: "postComment",
    summary: "Post a comment, or a one-level reply, on a discussion",
    description:
      "Session, or a token with `discussions:write`. Posting a comment never changes a stage, whatever the body says. 413 `payload_too_large` or `storage_quota_exceeded` as for create.",
    extraResponses: { "413": "Error `payload_too_large` or `storage_quota_exceeded`." },
    principals: ["session", "token"],
    minRole: "member",
    scope: "discussions:write",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: postCommentBodySchema,
    responseSchema: commentSchema,
    successStatus: 201,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof postCommentBodySchema>;
      refuseAccountId(body);
      const posted = await postComment(serviceCtx(ctx), {
        discussionId: requireId(input.params.id),
        body: body.body,
        replyToId: body.reply_to_id ?? null,
      });
      return toCommentDto(posted);
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/comments/{id}",
    operationId: "editComment",
    summary: "Edit your own comment's body",
    description: "Session, or a token with `discussions:write`. Only the comment's own author may edit it; anyone else is 403, another account's comment is 404.",
    extraResponses: { "413": "Error `payload_too_large` or `storage_quota_exceeded`." },
    principals: ["session", "token"],
    minRole: "member",
    scope: "discussions:write",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: editCommentBodySchema,
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof editCommentBodySchema>;
      refuseAccountId(body);
      await editOwnComment(serviceCtx(ctx), { commentId: requireCommentId(input.params.id), body: body.body });
      return null;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/comments/{id}",
    operationId: "deleteComment",
    summary: "Tombstone any comment in the account",
    description: "Session only, owner or admin. The comment keeps its row and its replies; its body is no longer returned.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx, input) {
      await tombstoneComment(serviceCtx(ctx), { commentId: requireCommentId(input.params.id) });
      return null;
    },
  },
];
