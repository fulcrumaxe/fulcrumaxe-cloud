import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import type { DiscussionsContext, Principal } from "./principals.js";
import { accountIdOf, runIdOf } from "./principals.js";
import { assertAllowed, assertUuidOrNotFound, rejectAccountIdInInput, DiscussionsError } from "./operations.js";
import type { Discussion, DiscussionKind, Visibility } from "./discussions.js";
import type { Comment } from "./comments.js";

/** Same numbers as packages/api/src/pagination.ts. The route parses `limit`
 * first; the service checks it again and never trusts its caller. */
const MAX_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `created_at` at millisecond precision. The cursor carries a JS `Date`
 * (milliseconds), so both the ordering and the cursor comparison use the
 * truncated value: a microsecond tail can never make a row sort on the
 * wrong side of its own cursor (no gap, no repeat). */
const CREATED_MS = `date_trunc('milliseconds', created_at)`;

export interface PageCursor {
  createdAt: Date;
  id: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: PageCursor | null;
}

export interface ListDiscussionsInput {
  limit: number;
  after?: PageCursor;
}

export interface GetDiscussionInput {
  discussionId: string;
}

export interface ListCommentsInput {
  discussionId: string;
  limit: number;
  after?: PageCursor;
}

/** A discussion plus its latest revision. */
export interface DiscussionDetail extends Discussion {
  body: string;
  rev: number;
  revisedAt: Date;
}

/** A comment as read back. A tombstoned comment keeps its row (replies still
 * have their parent) with `body: null`; an erased one returns the stored
 * placeholder body. */
export interface CommentView extends Comment {
  authorUserId: string | null;
  role: string | null;
  body: string | null;
  editedAt: Date | null;
  deleted: boolean;
}

function requireLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DiscussionsError("invalid_input", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function requireCursor(after: unknown): PageCursor | null {
  if (after === undefined) return null;
  if (typeof after !== "object" || after === null || Array.isArray(after)) {
    throw new DiscussionsError("invalid_input", "after must be an object");
  }
  const { createdAt, id } = after as { createdAt?: unknown; id?: unknown };
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new DiscussionsError("invalid_input", "after.createdAt must be a valid date");
  }
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new DiscussionsError("invalid_input", "after.id must be a UUID");
  }
  return { createdAt, id };
}

/** The work items a `run` principal may read: its own (read fresh from
 * `agent_runs`, never off the principal), its `parent_id` ancestors and its
 * direct dependencies. Empty when the run has no row or no work item. */
export async function runReadableWorkItemIds(client: PoolClient, principal: Principal): Promise<string[]> {
  const { rows: own } = await client.query<{ work_item_id: string | null }>(
    `SELECT work_item_id FROM agent_runs WHERE id = $1`,
    [runIdOf(principal)],
  );
  const ownWorkItemId = own[0]?.work_item_id ?? null;
  if (!ownWorkItemId) return [];
  const { rows } = await client.query<{ id: string }>(
    `WITH RECURSIVE ancestors(id, parent_id) AS (
       SELECT w.id, w.parent_id FROM work_items w WHERE w.id = $1
       UNION
       SELECT w.id, w.parent_id FROM ancestors a JOIN work_items w ON w.id = a.parent_id
     )
     SELECT id FROM ancestors
     UNION
     SELECT depends_on_id FROM work_item_deps WHERE work_item_id = $1`,
    [ownWorkItemId],
  );
  return rows.map((r) => r.id);
}

interface DiscussionRow {
  id: string;
  number: string;
  root_work_item_id: string;
  kind: DiscussionKind;
  title: string;
  visibility: Visibility;
  security: boolean;
  provenance: "internal" | "external";
  created_at: Date;
}

const DISCUSSION_COLUMNS = `id, number, root_work_item_id, kind, title, visibility, security, provenance, created_at`;

function toDiscussion(r: DiscussionRow): Discussion {
  return {
    id: r.id,
    number: Number(r.number),
    rootWorkItemId: r.root_work_item_id,
    kind: r.kind,
    title: r.title,
    visibility: r.visibility,
    security: r.security,
    provenance: r.provenance,
    createdAt: r.created_at,
  };
}

function pageOf<T extends { id: string; createdAt: Date }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

/** The discussion row for `discussionId` if the principal may read it, else
 * `NotFoundError` -- the same error for a missing id, another tenant's id
 * (RLS) and, for a run, a thread outside its readable set. */
async function readableDiscussion(
  client: PoolClient,
  ctx: DiscussionsContext,
  access: string,
  discussionId: string,
): Promise<DiscussionRow> {
  const { rows } = await client.query<DiscussionRow>(
    `SELECT ${DISCUSSION_COLUMNS} FROM discussions WHERE account_id = $1 AND id = $2`,
    [accountIdOf(ctx.principal), discussionId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`discussion not found: ${discussionId}`);
  if (access === "thread_only") {
    const readable = await runReadableWorkItemIds(client, ctx.principal);
    if (!readable.includes(row.root_work_item_id)) {
      throw new NotFoundError(`discussion not found: ${discussionId}`);
    }
  }
  return row;
}

/** `read`. Newest first (`created_at DESC, id DESC`), no bodies. A `run`
 * sees, and pages over, only discussions rooted in its readable work items. */
export async function listDiscussions(ctx: DiscussionsContext, input: ListDiscussionsInput): Promise<Page<Discussion>> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  const access = assertAllowed(ctx.principal, "read");
  const limit = requireLimit(input.limit);
  const after = requireCursor(input.after);
  const accountId = accountIdOf(ctx.principal);

  return withTenant(ctx.pool, accountId, async (client) => {
    const params: unknown[] = [accountId];
    let where = `account_id = $1`;
    if (access === "thread_only") {
      const readable = await runReadableWorkItemIds(client, ctx.principal);
      if (readable.length === 0) return { items: [], nextCursor: null };
      params.push(readable);
      where += ` AND root_work_item_id = ANY($${params.length}::uuid[])`;
    }
    if (after) {
      params.push(after.createdAt, after.id);
      where += ` AND (${CREATED_MS}, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    const { rows } = await client.query<DiscussionRow>(
      `SELECT ${DISCUSSION_COLUMNS} FROM discussions WHERE ${where}
        ORDER BY ${CREATED_MS} DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows.map(toDiscussion), limit);
  });
}

/** `read`. The discussion plus its latest revision's body. */
export async function getDiscussion(ctx: DiscussionsContext, input: GetDiscussionInput): Promise<DiscussionDetail> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  const access = assertAllowed(ctx.principal, "read");
  const discussionId = assertUuidOrNotFound(input.discussionId, "discussion");
  const accountId = accountIdOf(ctx.principal);

  return withTenant(ctx.pool, accountId, async (client) => {
    const row = await readableDiscussion(client, ctx, access, discussionId);
    const { rows: revs } = await client.query<{ rev: number; body: string; created_at: Date }>(
      `SELECT rev, body, created_at FROM discussion_revisions
        WHERE account_id = $1 AND discussion_id = $2 ORDER BY rev DESC LIMIT 1`,
      [accountId, discussionId],
    );
    const rev = revs[0];
    if (!rev) throw new NotFoundError(`discussion not found: ${discussionId}`);
    return { ...toDiscussion(row), body: rev.body, rev: rev.rev, revisedAt: rev.created_at };
  });
}

interface CommentRow {
  id: string;
  discussion_id: string;
  reply_to_id: string | null;
  author_kind: Comment["authorKind"];
  author_user_id: string | null;
  role: string | null;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

/** `read`. Thread order (`created_at ASC, id ASC`). */
export async function listComments(ctx: DiscussionsContext, input: ListCommentsInput): Promise<Page<CommentView>> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  const access = assertAllowed(ctx.principal, "read");
  const discussionId = assertUuidOrNotFound(input.discussionId, "discussion");
  const limit = requireLimit(input.limit);
  const after = requireCursor(input.after);
  const accountId = accountIdOf(ctx.principal);

  return withTenant(ctx.pool, accountId, async (client) => {
    await readableDiscussion(client, ctx, access, discussionId);
    const params: unknown[] = [accountId, discussionId];
    let where = `account_id = $1 AND discussion_id = $2`;
    if (after) {
      params.push(after.createdAt, after.id);
      where += ` AND (${CREATED_MS}, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    const { rows } = await client.query<CommentRow>(
      `SELECT id, discussion_id, reply_to_id, author_kind, author_user_id, role, body, created_at, edited_at, deleted_at
         FROM discussion_comments WHERE ${where}
        ORDER BY ${CREATED_MS} ASC, id ASC LIMIT $${params.length}`,
      params,
    );
    return pageOf(
      rows.map(
        (r): CommentView => ({
          id: r.id,
          discussionId: r.discussion_id,
          replyToId: r.reply_to_id,
          authorKind: r.author_kind,
          createdAt: r.created_at,
          authorUserId: r.author_user_id,
          role: r.role,
          body: r.deleted_at ? null : r.body,
          editedAt: r.edited_at,
          deleted: r.deleted_at !== null,
        }),
      ),
      limit,
    );
  });
}
