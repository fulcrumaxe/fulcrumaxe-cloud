import { z } from "zod";
import {
  MEMORY_AUTHOR_KINDS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MemoryInputError,
  decideMemory,
  editMemory,
  type LiveSecretsSource,
  type MemoryEntry,
} from "@fx/core/src/memory/index.js";
import { MEMORY_BATCH_DECISIONS, MEMORY_BATCH_MAX, decideMemoryBatch, markMemoryOpened } from "@fx/core/src/memory/batch.js";
import { memoryRunsOf } from "@fx/core/src/memory/runCounts.js";
import { MEMORY_LIST_MAX, listMemory, memoryMoveRef, memoryPendingCounts, memoryQueue, type MemoryScopeFilter } from "@fx/core/src/memory/view.js";
import { ApiError } from "../errors.js";
import type { RouteContext, RouteEntry } from "../registry.js";

/**
 * D#601 MEM-4a2: the memory review routes. List, the review queue, "this card was opened", decide one and decide a batch.
 *
 * Session only, member: a person approves memory (R-597-1), so no route here lists a token principal, and none of them can be reached with
 * one. Every rule (who may decide, one source per batch, opened before batched, the 20-entry cap) lives in the database (migration 0835);
 * a route validates the shape of the call, hands it to core and maps the refusal. It holds no second copy of any rule.
 */

/**
 * Where the edit route gets the tenant's live token values to scan an edited text against. The app registers the real source (the process's
 * live installation tokens); with none registered the scan still runs its credential-shape check and finds no live value. Tokens minted in
 * another process (the worker) are not visible here: the shape check is the net for those.
 */
export const memoryEditDeps: { liveSecrets: LiveSecretsSource } = { liveSecrets: () => [] };

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
/** The most ids one counts read takes (the core read's own limit). */
const MEMORY_COUNT_IDS_MAX = 200;
const uuidList = z
  .string()
  .max(200 * 37)
  .transform((s) => s.split(",").filter((p) => p !== ""))
  .pipe(z.array(uuid).min(1).max(MEMORY_COUNT_IDS_MAX));
const countsQuerySchema = z
  .object({ repo_ids: uuidList.optional(), item_ids: uuidList.optional() })
  .strict()
  .refine((q) => q.repo_ids !== undefined || q.item_ids !== undefined, { message: "name repo_ids or item_ids" });
const editBodySchema = z
  .object({
    body: z.string().min(1).max(4096),
    why: z.string().max(1024).nullable().optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    // "Change scope": naming `scope` moves the entry, with the one id (or role name) of the place it moves to.
    scope: z.enum(MEMORY_SCOPES).optional(),
    repo_id: uuid.optional(),
    item_id: uuid.optional(),
    role: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((b) => b.scope !== undefined || (b.repo_id === undefined && b.item_id === undefined && b.role === undefined), { message: "a place needs a scope" });
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
const runsResponseSchema = z.object({ total: z.number().int().min(0), truncated: z.boolean(), runs: z.array(z.object({ id: z.string().uuid(), recorded_at: z.string() })) });
const editResponseSchema = z.object({ entry: entrySchema, previous_id: z.string().uuid() });
const countMap = z.record(z.string(), z.number().int().min(0));
export const memoryPendingCountsResponseSchema = z.object({ repos: countMap, items: countMap });
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
    method: "GET",
    path: "/api/v1/memory/pending-counts",
    operationId: "getMemoryPendingCounts",
    summary: "How many memory proposals wait, per repo and per item",
    description:
      "Session only, member. For each repo id in `repo_ids` and each work item id in `item_ids` (comma-separated, at most 200 of each, at least one list), the number of `proposed` entries waiting: the same number the queue holds, so a badge equals the queue. Every id asked for gets a number, 0 when none is waiting. An id the caller cannot see also reads 0, which is what a repo with nothing waiting reads, so the call cannot be used to find out what exists in another account.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema: countsQuerySchema,
    responseSchema: memoryPendingCountsResponseSchema,
    async handler(ctx, input) {
      try {
        const q = input.query as z.infer<typeof countsQuerySchema>;
        return await memoryPendingCounts(mctx(ctx), { repoIds: q.repo_ids ?? [], itemIds: q.item_ids ?? [] });
      } catch (err) {
        throw mapMemoryError(err);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/memory/{id}/runs",
    operationId: "listMemoryRuns",
    summary: "The runs that used a memory entry",
    description:
      "Session only, member. The runs behind the entry's \"Used in N runs\": the newest at most 50 (`runs`, each with its run `id` and when the recall was recorded), and `total`, the number of runs, which equals the `runs` figure the list shows for the same entry. An edit does not reset it: the count follows the entry's versions. `truncated` is true when `total` is above what `runs` holds. An id that is not one of the caller's entries, another account's included, answers 404.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: runsResponseSchema,
    async handler(ctx, input) {
      try {
        const r = await memoryRunsOf(mctx(ctx), input.params.id!);
        return { total: r.total, truncated: r.total > r.runs.length, runs: r.runs.map((x) => ({ id: x.runId, recorded_at: x.recordedAt.toISOString() })) };
      } catch (err) {
        throw mapMemoryError(err);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/memory/{id}/edit",
    operationId: "editMemory",
    summary: "Edit a memory entry, which records a new version",
    description:
      "Session only, member. Replaces the text of a `proposed` or `approved` entry with `body` (1 KiB at most once cleaned) and `why` (256 B at most; leave it out or send null for none), optionally changing its `kind` or moving it (\"Change scope\": `scope` with the one `repo_id`, `item_id` or `role` it moves to; an `account` move names none). The old version stays readable as `superseded`, and the answer is the new version with `previous_id`. The entry keeps its status, so editing a proposal leaves it waiting: approve the answer's id afterwards. Who wrote the text never changes: an agent's proposal still reads as proposed by that agent after a person edits it, and its text stays fenced. Text that looks like a credential, or holds one of the tenant's live token values, is refused (422 `secret_detected`) and nothing is stored. Session only: a token is refused, whatever it holds. Owner or admin for repo and account entries (the person who proposed a still-waiting entry may edit it in place), an item member for item entries; the database re-checks. A second edit of a version that was already edited answers 409 `conflict`.",
    principals: ["session"],
    minRole: "member",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: editBodySchema,
    responseSchema: editResponseSchema,
    extraResponses: { "409": "Error `conflict`: the entry was edited by someone else first. Nothing changed." },
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof editBodySchema>;
      try {
        const m = mctx(ctx);
        const scopeRef =
          body.scope === undefined
            ? null
            : await memoryMoveRef(m, {
                scope: body.scope,
                ...(body.repo_id !== undefined ? { repoId: body.repo_id } : {}),
                ...(body.item_id !== undefined ? { itemId: body.item_id } : {}),
                ...(body.role !== undefined ? { role: body.role } : {}),
              });
        const entry = await editMemory(
          { ...m, liveSecrets: () => memoryEditDeps.liveSecrets() },
          {
            id: input.params.id!,
            body: body.body,
            why: body.why ?? null,
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.scope !== undefined ? { scope: body.scope, scopeRef } : {}),
          },
        );
        return { entry: entryDto(entry), previous_id: entry.supersedesId! };
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
