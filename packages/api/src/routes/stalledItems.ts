import { z } from "zod";
import { listStalledItems } from "@fx/core/src/work-items/stalled.js";
import type { RouteEntry } from "../registry.js";

/**
 * The work items that stopped on their own: the stage expects the pipeline to carry on, and its workflow has ended (or is parked) with no run live, no
 * question waiting for an answer and no request of a person in flight. Read for the Needs you list. List only: the row's button is the card's own
 * top button, the approve route (POST /api/v1/work-items/{id}/approve), which has its own role check and refusals. Nothing is stored for the list: an item
 * is on it while the facts hold, so it leaves by itself when the item moves.
 */

/** The most items one read returns; the rest are counted in `not_shown`. */
export const STALLED_LIST_LIMIT = 100;

const itemSchema = z.object({
  work_item_id: z.string(),
  /** Untrusted text from the issue, already cleaned to one line: show it as text only. Null when the item has none. */
  title: z.string().nullable(),
  stage: z.string(),
  /** A closed code for the kind of stop. */
  code: z.string(),
  /** What stopped, in the cloud's own words. */
  why: z.string(),
  /** The card's top button for this stage ("Approve and review", "Check the merge", ...), or null when no automatic step applies and a person picks an action on the card. */
  action_label: z.string().nullable(),
  /** True when the caller may press it (an owner or an admin); the approve route checks again. */
  can_act: z.boolean(),
  since: z.string(),
});

const listResponseSchema = z.object({ items: z.array(itemSchema), not_shown: z.number().int().min(0) });

export const stalledItemRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/stalled-items",
    operationId: "listStalledItems",
    summary: "The work items that stopped on their own and need a push, newest first",
    description:
      "Session only, any member. At most 100 items; `not_shown` counts the rest. An item is listed while its stage expects the pipeline to carry on by itself and nothing is running, no question is waiting and no request is in flight; it leaves when it moves. `action_label` names the card's top button and `can_act` says whether the caller may press it (it is the approve route). Read only.",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    responseSchema: listResponseSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      const { items, total } = await listStalledItems({ pool: ctx.pool, principal: { accountId, userId } }, { limit: STALLED_LIST_LIMIT });
      const mayAct = ctx.principal.role === "owner" || ctx.principal.role === "admin";
      return {
        items: items.map((i) => ({
          work_item_id: i.workItemId,
          title: i.title,
          stage: i.stage,
          code: i.code,
          why: i.why,
          action_label: i.actionLabel,
          can_act: mayAct && i.actionLabel !== null,
          since: i.since.toISOString(),
        })),
        not_shown: Math.max(0, total - items.length),
      };
    },
  },
];
