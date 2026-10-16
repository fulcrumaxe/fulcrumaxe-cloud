import { z } from "zod";
import {
  MEMORY_AUTHOR_KINDS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MemoryInputError,
  decideMemory,
  type MemoryEntry,
} from "@fx/core/src/memory/index.js";
import { MEMORY_BATCH_DECISIONS, MEMORY_BATCH_MAX, decideMemoryBatch, markMemoryOpened } from "@fx/core/src/memory/batch.js";
import { MEMORY_LIST_MAX, listMemory, memoryQueue, type MemoryScopeFilter } from "@fx/core/src/memory/view.js";
import { ApiError } from "../errors.js";
import type { RouteContext, RouteEntry } from "../registry.js";

/**
 * D#601 MEM-4a2: the memory review routes. List, the review queue, "this card was opened", decide one and decide a batch.
 *
 * Session only, member: a person approves memory (R-597-1), so no route here lists a token principal, and none of them can be reached with
 * one. Every rule (who may decide, one source per batch, opened before batched, the 20-entry cap) lives in the database (migration 0835);
 * a route validates the shape of the call, hands it to core and maps the refusal. It holds no second copy of any rule.
 */

const uuid = z.string().uuid();
const idParamsSchema = z.object({ id: z.string() });

/** A comma-separated query value as a closed list of names (a name outside the list is a 422). */
function nameList<T extends string>(all: readonly [T, ...T[]]) {
  return z
    .string()
    .max(200)
    .transform((s) => s.split(",").filter((p) => p !== ""))
    .pipe(z.array(z.enum(all)).min(1).max(all.length));
}
const limit = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MEMORY_LIST_MAX));

const listQuerySchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES).optional(),
    repo_id: uuid.optional(),
    item_id: uuid.optional(),
    kind: nameList(MEMORY_KINDS).optional(),
    status: nameList(MEMORY_STATUSES).optional(),
    limit: limit.optional(),
  })
  .strict();
const queueQuerySchema = z.object({ scope: z.enum(MEMORY_SCOPES).optional(), repo_id: uuid.optional(), item_id: uuid.optional(), limit: limit.optional() }).strict();
const decideBodySchema = z.object({ to: z.enum(MEMORY_BATCH_DECISIONS) }).strict();
const batchBodySchema = z.object({ ids: z.array(uuid).min(1).max(MEMORY_BATCH_MAX), to: z.enum(MEMORY_BATCH_DECISIONS) }).strict();

const entrySchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS),
  body: z.string(),
  why: z.string().nullable(),
  author_kind: z.enum(MEMORY_AUTHOR_KINDS),
  status: z.enum(MEMORY_STATUSES),
  version: z.number().int().min(1),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.string(),
  updated_at: z.string(),
  approved_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});

const STATUS_ICONS = ["inbox", "check", "cross", "clock", "pause", "trash", "archive", "replace", "question"] as const;
const listRowSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS),
  kind_label: z.string().min(1),
  status: z.enum(MEMORY_STATUSES),
  status_label: z.string().min(1),
  status_icon: z.enum(STATUS_ICONS),
  title: z.string().min(1),
  author_kind: z.enum(MEMORY_AUTHOR_KINDS),
  source: z.string().min(1),
  version: z.number().int().min(1),
  created_at: z.string(),
  age: z.string().min(1),
  runs: z.number().int().min(0),
  runs_label: z.string().min(1),
});
export const memoryListResponseSchema = z.object({
  groups: z.array(
    z.object({
      scope: z.enum(MEMORY_SCOPES),
      label: z.string().min(1),
      target_id: z.string().uuid().nullable(),
      entries: z.array(listRowSchema),
    }),
  ),
  truncated: z.boolean(),
});

const cardSchema = z.object({
  entry: entrySchema,
  title: z.string().min(1),
  kind_label: z.string().min(1),
  source: z.string().min(1),
  proposed_by: z.string().min(1),
  evidence: z.string(),
  age: z.string().min(1),
  open_state: z.enum(["not_required", "opened", "unopened"]),
  scope_label: z.string().min(1),
});
export const memoryQueueResponseSchema = z.object({ cards: z.array(cardSchema), truncated: z.boolean() });
const openResponseSchema = z.object({ opened: z.boolean() });
const decideResponseSchema = z.object({ outcome: z.enum(["decided", "already_decided"]), entry: entrySchema });
const batchResponseSchema = z.object({ decided: z.number().int().min(0), entries: z.array(entrySchema) });

function entryDto(e: MemoryEntry): z.infer<typeof entrySchema> {
  return {
    id: e.id,
    scope: e.scope,
    kind: e.kind,
    body: e.body,
    why: e.why,
    author_kind: e.authorKind,
    status: e.status,
    version: e.version,
    content_sha256: e.contentSha256,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
    approved_at: e.approvedAt?.toISOString() ?? null,
    expires_at: e.expiresAt?.toISOString() ?? null,
  };
}

/** The memory refusals as the fixed sentences a client sees. Anything else (not found, forbidden) is mapped once, in errors.ts. */
function mapMemoryError(err: unknown): never {
  if (err instanceof MemoryInputError) {
    if (err.code === "conflict") throw new ApiError(409, "conflict", "that entry was changed by someone else; reload and try again");
    if (err.code === "must_open_first") {
      const n = Math.max(0, Math.floor(err.unopened));
      throw new ApiError(422, "must_open_first", `${n} of these cards have not been opened yet; open each one first`, [{ path: "ids", code: "must_open_first" }]);
    }
    if (err.code === "mixed_sources") throw new ApiError(422, "mixed_sources", "a batch can only hold cards from one source", [{ path: "ids", code: "mixed_sources" }]);
    throw new ApiError(422, err.code, "request failed validation", [{ path: "body", code: "invalid" }]);
  }
  throw err;
}

const mctx = (ctx: RouteContext) => ({ pool: ctx.pool, principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId } });

function filterOf(q: z.infer<typeof listQuerySchema>): MemoryScopeFilter {
  return {
    ...(q.scope !== undefined ? { scope: q.scope } : {}),
    ...(q.repo_id !== undefined ? { repoId: q.repo_id } : {}),
    ...(q.item_id !== undefined ? { itemId: q.item_id } : {}),
    ...(q.kind !== undefined ? { kinds: q.kind } : {}),
    ...(q.status !== undefined ? { statuses: q.status } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
  };
}

const DECIDE_NOTE =
  "Session only: a token is refused, whatever it holds. Owner or admin for repo and account entries, an item member for item entries; the database re-checks every entry. Nothing changes unless the whole call succeeds.";

export const memoryRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/memory",
    operationId: "listMemory",
    summary: "The account's memory entries, grouped by scope",
    description:
      "Session only, member. Entries grouped by scope (a repo as `owner/name`, an item as its number and title), newest first inside a group, each with its title, kind, source, age and `runs`, the number of runs that used it (0 when none, never null). With no `status` the list leaves out `superseded` and `deleted`. `kind` and `status` take comma-separated names. At most 200 entries; `truncated` says more matched.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema: listQuerySchema,
    responseSchema: memoryListResponseSchema,
    async handler(ctx, input) {
      try {
        const list = await listMemory(mctx(ctx), filterOf(input.query as z.infer<typeof listQuerySchema>));
        return {
          groups: list.groups.map((g) => ({
            scope: g.scope,
            label: g.label,
            target_id: g.targetId,
            entries: g.entries.map((r) => ({
              id: r.id,
              scope: r.scope,
              kind: r.kind,
              kind_label: r.kindLabel,
              status: r.status,
              status_label: r.statusDisplay.label,
              status_icon: r.statusDisplay.icon,
              title: r.title,
              author_kind: r.authorKind,
              source: r.source,
              version: r.version,
              created_at: r.createdAt.toISOString(),
              age: r.age,
              runs: r.runs,
              runs_label: r.runsLabel,
            })),
          })),
          truncated: list.truncated,
        };
      } catch (err) {
        throw mapMemoryError(err);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/memory/queue",
    operationId: "getMemoryQueue",
    summary: "Memory proposals waiting for a decision",
    description:
      "Session only, member. The `proposed` entries, oldest first, each card with its body, who proposed it, its evidence, and `open_state`: for an imported or runner-sourced card, whether THIS caller opened THIS version (`opened` or `unopened`); `not_required` for every other source. Reading the queue opens nothing. At most 200 cards; `truncated` says more matched.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema: queueQuerySchema,
    responseSchema: memoryQueueResponseSchema,
    async handler(ctx, input) {
      try {
        const q = input.query as z.infer<typeof queueQuerySchema>;
        const queue = await memoryQueue(mctx(ctx), filterOf(q));
        return {
          cards: queue.cards.map((c) => ({
            entry: entryDto(c.entry),
            title: c.title,
            kind_label: c.kindLabel,
            source: c.source,
            proposed_by: c.proposedBy,
            evidence: c.evidence,
            age: c.age,
            open_state: c.openState,
            scope_label: c.scopeLabel,
          })),
          truncated: queue.truncated,
        };
      } catch (err) {
        throw mapMemoryError(err);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/memory/{id}/open",
    operationId: "openMemoryCard",
    summary: "Record that the caller opened a memory card",
    description:
      "Session only, member. Records that this person requested the card for the entry's current text. `opened: true` when the database recorded it (a `proposed` imported or runner-sourced entry); `false` for any other entry, which needs no record. An edit makes a new version, which must be opened again. Opening changes no entry.",
    principals: ["session"],
    minRole: "member",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    responseSchema: openResponseSchema,
    async handler(ctx, input) {
      try {
        return await markMemoryOpened(mctx(ctx), input.params.id!);
      } catch (err) {
        throw mapMemoryError(err);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/memory/{id}/decide",
    operationId: "decideMemory",
    summary: "Approve or reject one memory proposal",
    description: `${DECIDE_NOTE} Answers 200 with \`outcome: decided\`, or \`already_decided\` when the entry was already in that state. A single card is not gated on being opened: its screen shows the whole text.`,
    principals: ["session"],
    minRole: "member",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: decideBodySchema,
    responseSchema: decideResponseSchema,
    extraResponses: { "409": "Error `conflict`: the entry changed under the caller. Nothing changed." },
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof decideBodySchema>;
      try {
        // Deciding never scans text, so no live token values are needed here.
        const r = await decideMemory({ ...mctx(ctx), liveSecrets: () => [] }, { id: input.params.id!, to: body.to });
        return { outcome: r.outcome, entry: entryDto(r.entry) };
      } catch (err) {
        throw mapMemoryError(err);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/memory/decide-batch",
    operationId: "decideMemoryBatch",
    summary: "Approve or reject up to 20 memory proposals at once",
    description: `${DECIDE_NOTE} All or nothing, in one transaction. The batch must come from one source (422 \`mixed_sources\`). Every imported or runner-sourced card must have been opened by the caller, for its current text (422 \`must_open_first\`; the message says how many were not). At most 20 ids.`,
    principals: ["session"],
    minRole: "member",
    idempotency: "optional",
    rateClass: "write",
    bodySchema: batchBodySchema,
    responseSchema: batchResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof batchBodySchema>;
      try {
        const r = await decideMemoryBatch(mctx(ctx), { ids: body.ids, to: body.to });
        return { decided: r.decided, entries: r.entries.map(entryDto) };
      } catch (err) {
        throw mapMemoryError(err);
      }
    },
  },
];
