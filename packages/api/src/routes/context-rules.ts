import { z } from "zod";
import { listContextRules } from "@fx/core/src/context/contextRules.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#600 CX-5a: `GET /api/v1/context-rules`, the pins and excludes of one repository (its repo scope) or the rules in force for one item (its own over the
 * repository's, for every path the item has no rule on). Read only, session only, member. Names of paths and a fixed kind and scope only; another
 * account's repository or item answers an empty list. Rules are written through the store's definer functions, never by this route.
 */
const querySchema = z
  .object({ repo_id: z.string().uuid().optional(), work_item_id: z.string().uuid().optional() })
  .strict()
  .refine((q) => (q.repo_id === undefined) !== (q.work_item_id === undefined), { message: "name exactly one of repo_id and work_item_id" });

export const contextRuleResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().uuid(),
        scope: z.enum(["repo", "item"]),
        kind: z.enum(["pin", "exclude"]),
        path: z.string().min(1).max(512),
        repo_id: z.string().uuid().nullable(),
        work_item_id: z.string().uuid().nullable(),
      }),
    )
    .max(1000),
});

export const contextRuleRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/context-rules",
    operationId: "listContextRules",
    summary: "The pins and excludes of a repository, or in force for an item",
    description:
      "Session only, member. Name `repo_id` for the rules set on a repository, or `work_item_id` for the rules in force for an item: the item's own rules, and the repository's for every path the item has no rule on. " +
      "A pin keeps a file in the run's prompt; an exclude keeps a path (or glob) out of what the agent may read. A change applies from the next run, and a run already started keeps the rules it began with. " +
      "Another account's repository or item answers an empty list.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema,
    responseSchema: contextRuleResponseSchema,
    handler: async (ctx, input) => {
      const q = input.query as z.infer<typeof querySchema>;
      const rules = await listContextRules(ctx.pool, ctx.principal, q.repo_id !== undefined ? { repoId: q.repo_id } : { workItemId: q.work_item_id! });
      return { data: rules.map((r) => ({ id: r.id, scope: r.scope, kind: r.kind, path: r.path, repo_id: r.repoId, work_item_id: r.workItemId })) };
    },
  },
];
