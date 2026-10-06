import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import type { DiscussionsContext } from "./principals.js";
import { accountIdOf, actingUserId, actorForWrite, kindOf, redactIfNeeded } from "./principals.js";
import { assertAllowed, rejectAccountIdInInput, DiscussionsError } from "./operations.js";
import { requireBodyWithinLimit, utf8ByteLength, chargeStorage, allocateDiscussionNumber } from "./limits.js";
import { emitDiscussionsEvent } from "./events.js";

export const DISCUSSION_KINDS = [
  "feature",
  "critical",
  "small",
  "bug",
  "doc",
  "process",
  "review",
  "other",
  "question",
  "project",
] as const;
export type DiscussionKind = (typeof DISCUSSION_KINDS)[number];

/** D#2 C58 G8/G9: a `question` is answered in its thread and a `project` is
 * planned; neither ever starts a build. Every build entry point asks this. */
export function isBuildableKind(kind: string): boolean {
  return kind !== "question" && kind !== "project";
}

export const VISIBILITIES = ["private", "repo", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface Discussion {
  id: string;
  number: number;
  rootWorkItemId: string;
  kind: DiscussionKind;
  title: string;
  visibility: Visibility;
  security: boolean;
  provenance: "internal" | "external";
  createdAt: Date;
  /** Set only when a `sourceEventId` call found the discussion already
   * created and wrote nothing. */
  replayed?: true;
}

function requireTitle(title: unknown): string {
  if (typeof title !== "string" || title.length < 1 || title.length > 256) {
    throw new DiscussionsError("invalid_input", "title must be a string of 1 to 256 characters");
  }
  return title;
}

function requireKind(kind: unknown): DiscussionKind {
  if (typeof kind !== "string" || !(DISCUSSION_KINDS as readonly string[]).includes(kind)) {
    throw new DiscussionsError("invalid_input", `kind must be one of: ${DISCUSSION_KINDS.join(", ")}`);
  }
  return kind as DiscussionKind;
}

function requireVisibility(visibility: unknown): Visibility {
  if (typeof visibility !== "string" || !(VISIBILITIES as readonly string[]).includes(visibility)) {
    throw new DiscussionsError("invalid_input", `visibility must be one of: ${VISIBILITIES.join(", ")}`);
  }
  return visibility as Visibility;
}

export interface CreateDiscussionInput {
  title: string;
  kind: DiscussionKind;
  body: string;
  repoId?: string | null;
  /** Ignored (forced to 'private') when `security` is true -- CHECK
   * (NOT security OR visibility = 'private') on the discussions table. */
  visibility?: Visibility;
  security?: boolean;
  /** System principal only. An opaque upstream event key (an identifier,
   * never content): one discussion per (account, key), enforced by a
   * partial unique index. A replay returns the first discussion unchanged
   * with `replayed: true`. */
  sourceEventId?: string;
}

/** Thrown inside the transaction when the unique index says another call
 * already created the discussion for this source event. It rolls the whole
 * transaction back -- the allocated number, the work item, the storage
 * charge -- and is caught by createDiscussion. */
class SourceEventAlreadyExists extends Error {}

/** The `repoId` on a create is not a repo of this account: missing, deleted, malformed, or another tenant's. One error for all four, so a caller cannot tell them apart. */
export class RepoNotFoundError extends Error {
  constructor() {
    super("repo not found");
    this.name = "RepoNotFoundError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function readBySourceEvent(
  client: PoolClient,
  accountId: string,
  sourceEventId: string,
): Promise<Discussion | null> {
  const { rows } = await client.query<DiscussionRow>(
    `SELECT id, number, root_work_item_id, kind, title, visibility, security, provenance, created_at
       FROM discussions WHERE account_id = $1 AND source_event_id = $2`,
    [accountId, sourceEventId],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
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

/** Creates the root work item, allocates the next `discussions.number`
 * (criterion 16), inserts the `discussions` row, links the work item back,
 * and writes revision 1 -- one `withTenant` transaction, so a failure at
 * any step (including a storage-quota refusal) leaves no row at all.
 * Provenance is always 'internal': `run` is denied for this operation, so
 * 'external' rows only ever arrive through DS-7/DS-8, not this function. */
export async function createDiscussion(ctx: DiscussionsContext, input: CreateDiscussionInput): Promise<Discussion> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "discussion.create");

  let sourceEventId: string | null = null;
  if (input.sourceEventId !== undefined) {
    if (kindOf(ctx.principal) !== "system") {
      throw new ForbiddenError("discussion.create: sourceEventId is system-only");
    }
    const key: unknown = input.sourceEventId;
    if (typeof key !== "string" || key.length < 1 || key.length > 200) {
      throw new DiscussionsError("invalid_input", "sourceEventId must be a string of 1 to 200 characters");
    }
    // Lone surrogates are not valid text (they would be stored as a
    // replacement character, colliding distinct keys) and Postgres rejects NUL.
    // (Not `isWellFormed()`: the tsconfig lib predates ES2024.)
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/.test(key)) {
      throw new DiscussionsError("invalid_input", "sourceEventId must be well-formed Unicode without NUL");
    }
    sourceEventId = key;
  }

  const title = requireTitle(input.title);
  const kind = requireKind(input.kind);
  const security = input.security ?? false;
  const visibility = security ? "private" : requireVisibility(input.visibility ?? "private");
  const body = redactIfNeeded(ctx.principal, requireBodyWithinLimit(input.body));
  const actor = actorForWrite(ctx.principal);

  const accountId = accountIdOf(ctx.principal);
  const repoId = input.repoId ?? null;
  // A malformed id is the same refusal as a missing one, before any query.
  if (repoId !== null && (typeof repoId !== "string" || !UUID_RE.test(repoId))) throw new RepoNotFoundError();
  try {
    return await createInTransaction();
  } catch (err) {
    // The composite (account_id, repo_id) foreign key is the backstop: a repo deleted after the check below.
    if (repoId !== null && (err as { code?: string } | null)?.code === "23503") throw new RepoNotFoundError();
    if (!(err instanceof SourceEventAlreadyExists) || sourceEventId === null) throw err;
    // The losing insert rolled back everything. Read the winner.
    const winner = await withTenant(ctx.pool, accountId, (client) =>
      readBySourceEvent(client, accountId, sourceEventId!),
    );
    if (!winner) throw err;
    return { ...winner, replayed: true as const };
  }

  function createInTransaction(): Promise<Discussion> {
    return withTenant(ctx.pool, accountId, async (client) => {
      if (sourceEventId !== null) {
        // Fast path so a replay is not refused by the storage quota. The
        // unique index below is what actually decides under concurrency.
        const existing = await readBySourceEvent(client, accountId, sourceEventId);
        if (existing) return { ...existing, replayed: true as const };
      }

      if (repoId !== null) {
        // RLS-scoped: another tenant's repo reads as no row, exactly like a missing one.
        const { rowCount } = await client.query(`SELECT 1 FROM repos WHERE id = $1`, [repoId]);
        if (!rowCount) throw new RepoNotFoundError();
      }

      const number = await allocateDiscussionNumber(client, accountIdOf(ctx.principal), utf8ByteLength(body));

      const workItemId = randomUUID();
      await client.query(
        `INSERT INTO work_items (id, account_id, kind, provenance, title)
         VALUES ($1, $2, $3, 'internal', $4)`,
        [workItemId, accountIdOf(ctx.principal), kind, title],
      );

      const { rows } = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO discussions
           (account_id, number, repo_id, kind, title, visibility, security, root_work_item_id,
            provenance, created_by_kind, created_by_user_id, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'internal', $9, $10, $11)
         ON CONFLICT (account_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
         RETURNING id, created_at`,
        [
          accountIdOf(ctx.principal),
          number,
          repoId,
          kind,
          title,
          visibility,
          security,
          workItemId,
          actor.kind,
          actor.userId,
          sourceEventId,
        ],
      );
      if (rows.length === 0) {
        throw new SourceEventAlreadyExists();
      }
      const discussionId = rows[0]!.id;

      await client.query(`UPDATE work_items SET discussion_id = $1 WHERE id = $2`, [discussionId, workItemId]);

      await client.query(
        `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind, author_user_id, agent_run_id)
         VALUES ($1, $2, 1, $3, $4, $5, NULL)`,
        [accountIdOf(ctx.principal), discussionId, body, actor.kind, actor.userId],
      );

      await emitDiscussionsEvent(client, "discussion.created", accountIdOf(ctx.principal), discussionId, {
        number,
        kind,
        visibility,
      });

      return {
        id: discussionId,
        number,
        rootWorkItemId: workItemId,
        kind,
        title,
        visibility,
        security,
        provenance: "internal",
        createdAt: rows[0]!.created_at,
      };
    });
  }
}

export interface ReviseDiscussionInput {
  discussionId: string;
  body: string;
}

/** `discussion.revise`: 'own' means the discussion's own
 * `created_by_user_id`. The `SELECT ... FOR UPDATE` that checks it also
 * serializes concurrent revisers on the `rev = MAX(rev) + 1` insert below,
 * so no extra locking is needed for that. */
export async function reviseDiscussion(
  ctx: DiscussionsContext,
  input: ReviseDiscussionInput,
): Promise<{ rev: number }> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  const access = assertAllowed(ctx.principal, "discussion.revise");

  const body = redactIfNeeded(ctx.principal, requireBodyWithinLimit(input.body));
  const actor = actorForWrite(ctx.principal);

  return withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rows } = await client.query<{ created_by_user_id: string | null }>(
      `SELECT created_by_user_id FROM discussions WHERE id = $1 FOR UPDATE`,
      [input.discussionId],
    );
    if (rows.length === 0) {
      throw new NotFoundError(`discussion not found: ${input.discussionId}`);
    }
    if (access === "own" && rows[0]!.created_by_user_id !== actingUserId(ctx.principal)) {
      throw new ForbiddenError("discussion.revise: caller is not this discussion's own author");
    }

    await chargeStorage(client, accountIdOf(ctx.principal), utf8ByteLength(body));

    const { rows: revRows } = await client.query<{ rev: number }>(
      `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind, author_user_id, agent_run_id)
       SELECT $1, $2, COALESCE(MAX(rev), 0) + 1, $3, $4, $5, NULL
         FROM discussion_revisions WHERE account_id = $1 AND discussion_id = $2
       RETURNING rev`,
      [accountIdOf(ctx.principal), input.discussionId, body, actor.kind, actor.userId],
    );
    const rev = revRows[0]!.rev;

    await emitDiscussionsEvent(client, "discussion.revised", accountIdOf(ctx.principal), input.discussionId, { rev });

    return { rev };
  });
}

export interface SetVisibilityInput {
  discussionId: string;
  visibility: Visibility;
}

/** `visibility.set`: human-only for a session (owner/admin); a system
 * principal may only apply a repo's creation-time default (DS-6's own
 * call site enforces that it only ever calls this at creation time --
 * nothing in this PR constructs a system principal for this path, since
 * createDiscussion sets the initial visibility inline). */
export async function setVisibility(ctx: DiscussionsContext, input: SetVisibilityInput): Promise<void> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "visibility.set");
  const visibility = requireVisibility(input.visibility);

  await withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rows } = await client.query<{ security: boolean }>(
      `SELECT security FROM discussions WHERE id = $1 FOR UPDATE`,
      [input.discussionId],
    );
    if (rows.length === 0) {
      throw new NotFoundError(`discussion not found: ${input.discussionId}`);
    }
    if (rows[0]!.security && visibility !== "private") {
      throw new DiscussionsError("invalid_input", "a security discussion must stay visibility=private");
    }
    await client.query(`UPDATE discussions SET visibility = $1 WHERE id = $2`, [visibility, input.discussionId]);
  });
}

export interface DiscussionIdInput {
  discussionId: string;
}

/** `security.set` (to true): sets `security = true` and `visibility =
 * 'private'` in the same UPDATE statement (criterion 17). Open to owner,
 * admin, member and a write-scoped token -- unlike `security.clear`,
 * which is human-only. */
export async function setSecurity(ctx: DiscussionsContext, input: DiscussionIdInput): Promise<void> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "security.set");

  await withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rowCount } = await client.query(
      `UPDATE discussions SET security = true, visibility = 'private' WHERE id = $1`,
      [input.discussionId],
    );
    if (!rowCount) {
      throw new NotFoundError(`discussion not found: ${input.discussionId}`);
    }
  });
}

/** `security.clear`: human-only (owner/admin session). */
export async function clearSecurity(ctx: DiscussionsContext, input: DiscussionIdInput): Promise<void> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "security.clear");

  await withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rowCount } = await client.query(`UPDATE discussions SET security = false WHERE id = $1`, [
      input.discussionId,
    ]);
    if (!rowCount) {
      throw new NotFoundError(`discussion not found: ${input.discussionId}`);
    }
  });
}
