import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { getMemberRole } from "@fx/core/src/tenancy/authorize.js";
import { redactEventPayload } from "@fx/core/src/events/redact.js";
import type { DiscussionsContext } from "./principals.js";
import { accountIdOf, actingUserId, kindOf, redactIfNeeded, runIdOf } from "./principals.js";
import { assertAllowed, assertUuidOrNotFound, rejectAccountIdInInput, DiscussionsError } from "./operations.js";
import {
  requireBodyWithinLimit,
  MAX_COMMENTS_PER_RUN,
  MAX_RUN_COMMENT_BYTES,
  utf8ByteLength,
  chargeStorage,
} from "./limits.js";
import { emitDiscussionsEvent } from "./events.js";

export interface Comment {
  id: string;
  discussionId: string;
  replyToId: string | null;
  authorKind: "user" | "agent" | "system" | "github";
  createdAt: Date;
  /** Set only by `postAgentComment`, when the signed comment for this
   * (discussion, run) already existed and the call wrote nothing. */
  replayed?: true;
}

/** Must equal runner's `runEventsSeqLockKey` (a runner test pins both); discussions may not depend on runner. */
export const runEventsSeqLockKey = (runId: string): string => `run_events_seq:${runId}`;

/** `run_events.seq`, computed the same way runStatusWriter.ts's own
 * `nextRunEventSeq` does -- MAX(seq)+1 inside the same transaction as the
 * event that uses it. */
async function nextRunEventSeq(client: PoolClient, runId: string): Promise<number> {
  // The same per-run lock (same key) runStatusWriter.ts takes, so this insert
  // and an agent.output write for one run never pick the same seq.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [runEventsSeqLockKey(runId)]);
  const { rows } = await client.query<{ next: string }>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = $1`,
    [runId],
  );
  return Number(rows[0]!.next);
}

/** Criterion 10: a run's 21st comment, or one over MAX_RUN_COMMENT_BYTES
 * total, is refused with quota_exceeded and writes exactly one
 * `run_events` row (kind `discussion_quota_exceeded`), redacted at source
 * like every other run_events writer. */
async function insertQuotaExceededEvent(
  client: PoolClient,
  accountId: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const seq = await nextRunEventSeq(client, runId);
  await client.query(
    `INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'discussion_quota_exceeded', $4::jsonb)`,
    [accountId, runId, seq, JSON.stringify(redactEventPayload(payload))],
  );
}

export interface PostCommentInput {
  discussionId: string;
  body: string;
  replyToId?: string | null;
}

/** `comment.post`. A `run` may only post on its own work item's thread --
 * `role`/`work_item_id` are read fresh from `agent_runs` here (never
 * trusted off the principal, see principals.ts). A discussion whose root
 * work item isn't the run's own reads as `NotFoundError`, never 403 --
 * "Not found is uniform" -- so a run can't tell "not mine" from "doesn't
 * exist". */
export async function postComment(ctx: DiscussionsContext, input: PostCommentInput): Promise<Comment> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "comment.post");

  const body = redactIfNeeded(ctx.principal, requireBodyWithinLimit(input.body));

  return withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    let role: string | null = null;
    let runWorkItemId: string | null = null;
    if (kindOf(ctx.principal) === "run") {
      const { rows } = await client.query<{ role: string; work_item_id: string | null }>(
        `SELECT role, work_item_id FROM agent_runs WHERE id = $1`,
        [runIdOf(ctx.principal)],
      );
      if (rows.length === 0) {
        throw new NotFoundError(`agent run not found: ${runIdOf(ctx.principal)}`);
      }
      role = rows[0]!.role;
      runWorkItemId = rows[0]!.work_item_id;
      if (!runWorkItemId) {
        throw new ForbiddenError("comment.post: run has no work item to post from");
      }
    }

    const { rows: discRows } = await client.query<{ root_work_item_id: string }>(
      `SELECT root_work_item_id FROM discussions WHERE id = $1`,
      [input.discussionId],
    );
    if (discRows.length === 0) {
      throw new NotFoundError(`discussion not found: ${input.discussionId}`);
    }
    if (kindOf(ctx.principal) === "run" && discRows[0]!.root_work_item_id !== runWorkItemId) {
      // Same 404 as "doesn't exist" -- a run must not be able to tell the
      // two apart for a thread that isn't its own.
      throw new NotFoundError(`discussion not found: ${input.discussionId}`);
    }

    if (input.replyToId) {
      const { rows: parentRows } = await client.query<{ reply_to_id: string | null }>(
        `SELECT reply_to_id FROM discussion_comments WHERE id = $1 AND discussion_id = $2`,
        [input.replyToId, input.discussionId],
      );
      if (parentRows.length === 0) {
        throw new NotFoundError(`comment not found: ${input.replyToId}`);
      }
      if (parentRows[0]!.reply_to_id !== null) {
        throw new DiscussionsError("invalid_input", "replies go one level deep");
      }
    }

    if (kindOf(ctx.principal) === "run") {
      const { rows: statRows } = await client.query<{ count: string; bytes: string }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(octet_length(body)), 0) AS bytes
           FROM discussion_comments WHERE account_id = $1 AND agent_run_id = $2`,
        [accountIdOf(ctx.principal), runIdOf(ctx.principal)],
      );
      const count = Number(statRows[0]!.count);
      const bytesSoFar = Number(statRows[0]!.bytes);
      const newBytes = utf8ByteLength(body);
      if (count + 1 > MAX_COMMENTS_PER_RUN || bytesSoFar + newBytes > MAX_RUN_COMMENT_BYTES) {
        // A separate withTenant call so this audit row commits on its own
        // connection, surviving the throw below (which rolls back THIS
        // transaction on the outer client).
        const runId = runIdOf(ctx.principal);
        await withTenant(ctx.pool, accountIdOf(ctx.principal), (auditClient) =>
          insertQuotaExceededEvent(auditClient, accountIdOf(ctx.principal), runId, {
            discussion_id: input.discussionId,
            comment_count: count,
            bytes_so_far: bytesSoFar,
            attempted_bytes: newBytes,
          }),
        );
        throw new DiscussionsError("quota_exceeded", "this run has reached its Discussion comment quota");
      }
    }

    await chargeStorage(client, accountIdOf(ctx.principal), utf8ByteLength(body));

    const authorKind = kindOf(ctx.principal) === "run" ? "agent" : kindOf(ctx.principal) === "system" ? "system" : "user";
    const authorUserId = actingUserId(ctx.principal);
    const agentRunId = kindOf(ctx.principal) === "run" ? runIdOf(ctx.principal) : null;

    const { rows: inserted } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO discussion_comments
         (account_id, discussion_id, reply_to_id, author_kind, author_user_id, role, agent_run_id, body, provenance, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'internal', 'fx')
       RETURNING id, created_at`,
      [
        accountIdOf(ctx.principal),
        input.discussionId,
        input.replyToId ?? null,
        authorKind,
        authorUserId,
        role,
        agentRunId,
        body,
      ],
    );
    const commentId = inserted[0]!.id;

    await emitDiscussionsEvent(client, "discussion.comment_created", accountIdOf(ctx.principal), input.discussionId, {
      commentId,
      authorKind,
    });

    return {
      id: commentId,
      discussionId: input.discussionId,
      replyToId: input.replyToId ?? null,
      authorKind: authorKind as Comment["authorKind"],
      createdAt: inserted[0]!.created_at,
    };
  });
}

export interface PostAgentCommentInput {
  discussionId: string;
  agentRunId: string;
  body: string;
}

const POST_AGENT_COMMENT_KEYS: readonly string[] = ["discussionId", "agentRunId", "body"];

/** Thrown inside the transaction when the unique index says another call
 * already signed this (discussion, run). It rolls the whole transaction
 * back (the storage charge goes with it) and is caught by the caller. */
class SignedCommentAlreadyExists extends Error {}

async function readSignedComment(
  client: PoolClient,
  discussionId: string,
  agentRunId: string,
): Promise<Comment | null> {
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM discussion_comments
      WHERE discussion_id = $1 AND agent_run_id = $2 AND system_signed`,
    [discussionId, agentRunId],
  );
  if (rows.length === 0) return null;
  return { id: rows[0]!.id, discussionId, replyToId: null, authorKind: "agent", createdAt: rows[0]!.created_at };
}

/** D#71 DS-2d. Writes a signed comment attributed to an `agent_runs` row.
 * System principal only (the operation table refuses every other kind; the
 * route and tool layers never build a system principal from a request).
 * `role` and the run's work item are read from `agent_runs` inside the
 * transaction -- nothing the caller passes supplies them. The run must be on
 * the discussion's root work item. One row per (discussion, run): the
 * partial unique index decides, and a replay returns the existing comment
 * with `replayed: true` and writes, charges and emits nothing. The replay
 * fast path runs after the work-item check, so a run that has since moved
 * off the discussion's root work item gets ForbiddenError, not
 * `replayed: true`. */
export async function postAgentComment(ctx: DiscussionsContext, input: PostAgentCommentInput): Promise<Comment> {
  assertAllowed(ctx.principal, "comment.post_agent");
  // Belt and braces: the table already refuses every non-system kind, but a
  // signed agent comment must never depend on the table alone.
  if (kindOf(ctx.principal) !== "system") {
    throw new ForbiddenError("comment.post_agent: system principal only");
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DiscussionsError("invalid_input", "input must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!POST_AGENT_COMMENT_KEYS.includes(key)) {
      throw new DiscussionsError("invalid_input", `unexpected input key: ${key}`);
    }
  }
  const discussionId = assertUuidOrNotFound(input.discussionId, "discussion");
  const agentRunId = assertUuidOrNotFound(input.agentRunId, "agent run");
  const body = redactIfNeeded(ctx.principal, requireBodyWithinLimit(input.body));
  const accountId = accountIdOf(ctx.principal);

  try {
    return await withTenant(ctx.pool, accountId, async (client) => {
      const { rows: discRows } = await client.query<{ root_work_item_id: string }>(
        `SELECT root_work_item_id FROM discussions WHERE id = $1`,
        [discussionId],
      );
      if (discRows.length === 0) {
        throw new NotFoundError(`discussion not found: ${discussionId}`);
      }
      const { rows: runRows } = await client.query<{ role: string; work_item_id: string | null }>(
        `SELECT role, work_item_id FROM agent_runs WHERE id = $1`,
        [agentRunId],
      );
      if (runRows.length === 0) {
        throw new NotFoundError(`agent run not found: ${agentRunId}`);
      }
      const { role, work_item_id: runWorkItemId } = runRows[0]!;
      if (runWorkItemId === null || runWorkItemId !== discRows[0]!.root_work_item_id) {
        throw new ForbiddenError("comment.post_agent: the run is not on this discussion's root work item");
      }

      // Fast path so a replay is not refused by the storage quota.
      const existing = await readSignedComment(client, discussionId, agentRunId);
      if (existing) return { ...existing, replayed: true as const };

      await chargeStorage(client, accountId, utf8ByteLength(body));

      const { rows: inserted } = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO discussion_comments
           (account_id, discussion_id, reply_to_id, author_kind, author_user_id, role, agent_run_id, body,
            provenance, origin, system_signed)
         VALUES ($1, $2, NULL, 'agent', NULL, $3, $4, $5, 'internal', 'fx', true)
         ON CONFLICT (discussion_id, agent_run_id) WHERE system_signed DO NOTHING
         RETURNING id, created_at`,
        [accountId, discussionId, role, agentRunId, body],
      );
      if (inserted.length === 0) {
        throw new SignedCommentAlreadyExists();
      }
      const commentId = inserted[0]!.id;

      await emitDiscussionsEvent(client, "discussion.comment_created", accountId, discussionId, {
        commentId,
        authorKind: "agent",
      });

      return {
        id: commentId,
        discussionId,
        replyToId: null,
        authorKind: "agent" as const,
        createdAt: inserted[0]!.created_at,
      };
    });
  } catch (err) {
    if (!(err instanceof SignedCommentAlreadyExists)) throw err;
    // The losing insert rolled back (no charge, no event). Read the winner.
    const winner = await withTenant(ctx.pool, accountId, (client) =>
      readSignedComment(client, discussionId, agentRunId),
    );
    if (!winner) throw err;
    return { ...winner, replayed: true as const };
  }
}

export interface EditOwnCommentInput {
  commentId: string;
  body: string;
}

/** Criterion 13: succeeds only when the caller is the comment's own
 * `user`-kind author AND still a member (`getMemberRole`). `getMemberRole`
 * runs its own `withTenant` call, sequenced before this function opens its
 * own so the two never compete for the same connection pool. */
export async function editOwnComment(ctx: DiscussionsContext, input: EditOwnCommentInput): Promise<void> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "comment.edit_own");

  const body = redactIfNeeded(ctx.principal, requireBodyWithinLimit(input.body));
  const userId = actingUserId(ctx.principal);
  if (!userId) {
    throw new ForbiddenError("comment.edit_own: requires a session or token principal");
  }

  const role = await getMemberRole(ctx.pool, accountIdOf(ctx.principal), userId);
  if (role === null) {
    throw new ForbiddenError("comment.edit_own: caller is not a member of this account");
  }

  await withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rows } = await client.query<{
      author_kind: string;
      author_user_id: string | null;
      deleted_at: Date | null;
      erased_at: Date | null;
    }>(
      `SELECT author_kind, author_user_id, deleted_at, erased_at FROM discussion_comments WHERE id = $1 FOR UPDATE`,
      [input.commentId],
    );
    if (rows.length === 0) {
      throw new NotFoundError(`comment not found: ${input.commentId}`);
    }
    const { author_kind: authorKind, author_user_id: authorUserId } = rows[0]!;
    if (authorKind !== "user" || authorUserId !== userId) {
      throw new ForbiddenError("comment.edit_own: caller is not this comment's own author");
    }
    // A tombstoned or erased comment reads as missing: its body is no longer
    // the author's to rewrite (an erased row's body is the '[erased]' marker).
    if (rows[0]!.deleted_at !== null || rows[0]!.erased_at !== null) {
      throw new NotFoundError(`comment not found: ${input.commentId}`);
    }

    await chargeStorage(client, accountIdOf(ctx.principal), utf8ByteLength(body));
    await client.query(`UPDATE discussion_comments SET body = $1, edited_at = now() WHERE id = $2`, [
      body,
      input.commentId,
    ]);
  });
}

export interface TombstoneCommentInput {
  commentId: string;
}

/** `comment.tombstone_any`: owner/admin only, on any comment in the
 * tenant (not just their own). Soft-deletes via `deleted_at`, the same
 * column `comment.edit_own` is granted -- no DELETE grant exists on
 * `discussion_comments` at all (DS-1 criterion 6). */
export async function tombstoneComment(ctx: DiscussionsContext, input: TombstoneCommentInput): Promise<void> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "comment.tombstone_any");

  await withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rowCount } = await client.query(`UPDATE discussion_comments SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`, [
      input.commentId,
    ]);
    if (!rowCount) {
      throw new NotFoundError(`comment not found: ${input.commentId}`);
    }
  });
}
