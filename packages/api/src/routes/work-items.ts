import { z } from "zod";
import { getWorkItem, listWorkItems, OWN_PLAN_USAGE_STATES, WORK_ITEM_PRIORITIES } from "@fx/core/src/work-items/read.js";
import { WORK_ITEM_STAGES } from "@fx/core/src/work-items/stages.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { childFirstRunUsd } from "@fx/pipeline";
import { readItemEnvelope } from "@fx/spend";
import type { RouteEntry } from "../registry.js";
import { assertBoundRepo, boundListRepo } from "../boundRepo.js";
import { decodeCursor, decodeQueueCursor, encodeCursor, encodeQueueCursor, parseLimit } from "../pagination.js";

/** "The v1 contract" > work item DTO (API-3a criterion 3), corrected by C10: `stage` is `WORK_ITEM_STAGES`, not derived from `work_items.state`. */
export const workItemResponseSchema = z.object({
  id: z.string().uuid(),
  repo_id: z.string().uuid().nullable(),
  kind: z.string().nullable(),
  issue_number: z.number().int().nullable(),
  title: z.string().nullable().describe("A one-line plain-English title: the GitHub issue's title with control characters removed, cut to 120 characters. Untrusted text; show it as text only. Null when the item has none yet."),
  stage: z.enum(WORK_ITEM_STAGES),
  provenance: z.enum(["internal", "external"]),
  priority: z.enum(WORK_ITEM_PRIORITIES),
  queue_rank: z.number().int().nullable(),
  cost_usd: z.number(),
  // D#6 R2b-5a: the API-equivalent of this item's runner runs, kept apart from `cost_usd`; information, never spend.
  own_plan_api_equivalent_usd: z.number().nullable().describe("What this item's runs on the person's own machine would have cost at API prices. Information, never spend. The same figure the stats endpoint calls runner_api_equivalent_usd (named differently there because the stats key guard refuses keys containing plan). Null unless own_plan_usage_state is recorded: a figure that was never recorded or never priced is not zero."),
  own_plan_usage_state: z.enum(OWN_PLAN_USAGE_STATES).describe("recorded: every finished run on the person's machine has a priced usage row (or there is none); not_priced: a run has tokens and no API price; not_recorded: a finished run reported no usage."),
  own_plan_tokens: z.object({ input: z.number(), output: z.number(), cache_read: z.number(), cache_write: z.number() }).describe("The tokens the item's runs on the person's machine reported."),
  context_pct: z.number().int().min(0).max(100).nullable().describe("The whole percent of the model's context window that the item's running run has filled, only once it reaches the warning level; null otherwise (no run going, no figure yet, the window not known, or still below the level)."),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * The spend envelope the item draws on, null when it draws on none. `spent_usd` is the sum admission itself uses (what the item and its siblings have spent or hold, subscription runs
 * at what they cost once over); `next_run_need_usd` is the price the launch check puts on the next executor run, or null when it cannot be priced.
 */
export const workItemEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    scope: z.enum(["item", "batch", "weekly_autostart"]),
    version: z.number().int(),
    amount_usd: z.number(),
    spent_usd: z.number(),
    next_run_need_usd: z.number().nullable(),
  })
  .nullable()
  .describe("The spend limit this item draws on, or null when it has none.");

const getWorkItemResponseSchema = workItemResponseSchema.extend({ envelope: workItemEnvelopeSchema });

const listWorkItemsResponseSchema = z.object({
  data: z.array(workItemResponseSchema),
  next_cursor: z.string().nullable(),
});

// Correction C10 item 1: "?stage= accepts only WORK_ITEM_STAGES. Any other
// value returns 422." z.enum -> ZodError -> mapError's 422 validation_failed
// (the contract's own general 422 code; invalid_request is 400-only there).
const listWorkItemsQuerySchema = z.object({
  repo_id: z.string().uuid().optional(),
  stage: z.enum(WORK_ITEM_STAGES).optional(),
  sort: z.enum(["queue"]).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

const workItemIdParamsSchema = z.object({ id: z.string() });

/** "The v1 contract" > route table: `GET /api/v1/work-items`, `/api/v1/work-items/{id}` | S+T(read), member | API-3a. */
export const workItemRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/work-items",
    operationId: "listWorkItems",
    summary: "The caller's own work items, paginated",
    principals: ["session", "token"],
    tokens: ["api", "delegation"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listWorkItemsQuerySchema,
    responseSchema: listWorkItemsResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listWorkItemsQuerySchema>;
      const limit = parseLimit(query.limit);
      // A cursor belongs to the sort that minted it: each decoder refuses the other's payload (422 invalid_cursor).
      const queue = query.sort === "queue";
      const cursor = !query.cursor
        ? undefined
        : queue
          ? decodeQueueCursor(query.cursor)
          : (({ created_at, id }) => ({ createdAt: created_at, id }))(decodeCursor(query.cursor)); // fix round 1: no new Date(...)
      const result = await listWorkItems(
        { pool: ctx.pool, principal: ctx.principal },
        { repoId: boundListRepo(ctx.principal, query.repo_id), stage: query.stage, limit, sort: query.sort, cursor },
      );
      const next = result.nextCursor;
      return {
        data: result.data,
        next_cursor: !next
          ? null
          : queue
            ? encodeQueueCursor({ ...next, priority: next.priority ?? 0, queueRank: next.queueRank ?? null }) // core always sets both under sort=queue
            : encodeCursor(next.createdAt, next.id),
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/work-items/{id}",
    operationId: "getWorkItem",
    summary: "A single work item the caller's account owns",
    principals: ["session", "token"],
    tokens: ["api", "delegation"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: workItemIdParamsSchema,
    responseSchema: getWorkItemResponseSchema,
    async handler(ctx, input) {
      await assertBoundRepo(ctx, { workItemId: input.params.id! });
      const item = await getWorkItem({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      const { accountId, userId } = ctx.principal;
      const envelope = await withTenant(ctx.pool, accountId, userId, async (client) => {
        const read = await readItemEnvelope(client, accountId, item.id);
        if (read === null) return null;
        // fx-swallow-ok: a price that cannot be read (no plan data, a repo that went away) is "unknown" on this screen, not a failed read of the envelope
        const need = item.repo_id === null ? null : await childFirstRunUsd(client, { accountId, repoId: item.repo_id }).catch(() => null);
        return { id: read.id, scope: read.scope, version: read.version, amount_usd: read.amountUsd, spent_usd: read.spentUsd, next_run_need_usd: need };
      });
      return { ...item, envelope };
    },
  },
];
