import { z } from "zod";
import { WORK_ITEM_PRIORITIES, getWorkItem } from "@fx/core/src/work-items/read.js";
import {
  NotReorderableError,
  PriorityInputError,
  setWorkItemPriority,
  type PriorityMove,
} from "@fx/core/src/work-items/priority.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { workItemResponseSchema } from "./work-items.js";

const idParamsSchema = z.object({ id: z.string() });

const bodyObject = z
  .object({
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    move: z.union([z.enum(["top", "up", "down"]), z.object({ before: z.string().uuid() }).strict()]).optional(),
  })
  .strict()
  .refine((b) => b.priority !== undefined || b.move !== undefined, { message: "give a priority, a move, or both" });

/** A body naming an account is refused outright (400), not as a generic unknown key: the account always comes from the credential. */
const bodySchema = z.preprocess((raw) => {
  if (typeof raw === "object" && raw !== null && "account_id" in raw) {
    throw new ApiError(400, "invalid_input", "account_id cannot be set in the request body");
  }
  return raw;
}, bodyObject);

/** "The v1 contract" > work items: set a priority and/or move an item in the queue (D#31 API-12). */
export const workItemPriorityRoutes: RouteEntry[] = [
  {
    method: "PATCH",
    path: "/api/v1/work-items/{id}/priority",
    operationId: "setWorkItemPriority",
    summary: "Change a work item's priority or move it in the queue",
    description:
      "Owners and admins only. `priority` sets the band (a change without `move` puts the item at the end of the new band); `move` places it inside its band. A merged or closed item is refused.",
    principals: ["session", "token"],
    scope: "work_items:write",
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema,
    responseSchema: workItemResponseSchema,
    extraResponses: { "409": "Error `not_reorderable`: the work item is merged or closed." },
    async handler(ctx, input) {
      const id = input.params.id!;
      const body = input.body as z.infer<typeof bodyObject>;
      try {
        await setWorkItemPriority(
          { pool: ctx.pool, principal: ctx.principal },
          {
            workItemId: id,
            priority: body.priority === undefined ? undefined : WORK_ITEM_PRIORITIES.indexOf(body.priority),
            move: body.move as PriorityMove | undefined,
          },
        );
      } catch (err) {
        if (err instanceof NotReorderableError) throw new ApiError(409, "not_reorderable", err.message);
        if (err instanceof PriorityInputError) {
          throw new ApiError(422, "validation_failed", "request failed validation", [{ path: "move", code: "invalid" }]);
        }
        throw err;
      }
      return getWorkItem({ pool: ctx.pool, principal: ctx.principal }, id);
    },
  },
];
