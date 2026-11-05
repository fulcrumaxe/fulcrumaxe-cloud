import { z } from "zod";
import type { Pool } from "pg";
import { MAX_JOB_PINS } from "@fulcrumaxe/runner-protocol";
import { CONTEXT_EXCLUDES_MAX, ContextRuleError, listContextRules, type ContextRuleErrorCode } from "@fx/core/src/context/contextRules.js";
import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { createMissingResolver, DEFAULT_CONTEXT_RULE_TIMEOUTS, removeContextRuleChecked, saveContextRule, type ContextRuleTimeouts, type PinTreeSource, type SaveContextRuleDeps } from "@fx/pipeline";
import { ApiError } from "../errors.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#600 CX-5a: `GET /api/v1/context-rules`, the pins and excludes of one repository (its repo scope) or the rules in force for one item (its own over the
 * repository's, for every path the item has no rule on). Read only, session only, member. Names of paths and a fixed kind and scope only; another
 * account's repository or item answers an empty list.
 *
 * D#600 CX-9a: `PUT /api/v1/context-rules` saves a rule and `DELETE /api/v1/context-rules/{id}` removes one, both through the pipeline services that call the
 * store's definer functions (the only writers), each with its audit row in the same transaction. Session only. The definer decides who may write: a member
 * may set item rules, only an owner or admin the repository's. The code host is asked (through `contextRuleDeps.openTree`, which the app registers) only to
 * measure pins.
 */
export interface ContextRuleDeps {
  /** Opens the one-repository tree reader the pin budget check uses; null until the app registers it (a pin then answers `tree_unavailable`). */
  openTree: ((repo: { accountId: string; repoId: string; owner: string; name: string }) => Promise<PinTreeSource>) | null;
  timeouts: ContextRuleTimeouts;
}
export const contextRuleDeps: ContextRuleDeps = { openTree: null, timeouts: DEFAULT_CONTEXT_RULE_TIMEOUTS };

/** D#600 CX-9b: the pinned paths that are not in the default branch's tree, read lazily through the same registered tree reader. */
export const missingResolver = createMissingResolver({ openTree: () => contextRuleDeps.openTree });

export const saveDeps = (pool: Pool): SaveContextRuleDeps => ({
  pool,
  openTree: contextRuleDeps.openTree ?? (() => Promise.reject(new Error("no tree reader is registered"))),
  timeouts: contextRuleDeps.timeouts,
});

const REFUSALS: Record<ContextRuleErrorCode, [number, string]> = {
  invalid_path: [422, "that path cannot be used: it must be a repository-relative path, and a pin cannot contain * or ?"],
  pins_exceed_budget: [409, "the pinned files would not fit the repository's context budget"],
  pins_exceed_ceiling: [409, `a run can carry at most ${MAX_JOB_PINS} pinned files`],
  excludes_exceed_cap: [409, `a run can hold at most ${CONTEXT_EXCLUDES_MAX} excluded paths`],
  exclude_readds_pins: [409, "removing this exclude puts pinned files back in this item's runs and they no longer fit the budget; repeat with confirm=true to remove it anyway"],
  context_rules_busy: [409, "another change to this repository's rules is in progress; try again"],
  tree_truncated: [409, "the repository is too large to measure its pins; nothing was saved"],
  tree_unavailable: [503, "the repository could not be read just now; nothing was saved"],
  repo_not_connected: [409, "the repository is not connected"],
};

/** The pipeline's refusals as the API's, and the definer's pg codes (42501 not allowed, P0002 not found). Anything else is rethrown as it is. */
export function mapRuleRefusal(error: unknown): unknown {
  if (error instanceof ContextRuleError) return new ApiError(REFUSALS[error.code][0], error.code, REFUSALS[error.code][1]);
  const code = (error as { code?: string } | null)?.code;
  if (code === "42501") return new ForbiddenError("not permitted");
  if (code === "P0002") return new NotFoundError("not found");
  return error;
}

const querySchema = z
  .object({ repo_id: z.string().uuid().optional(), work_item_id: z.string().uuid().optional() })
  .strict()
  .refine((q) => (q.repo_id === undefined) !== (q.work_item_id === undefined), { message: "name exactly one of repo_id and work_item_id" });

const ruleSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(["repo", "item"]),
  kind: z.enum(["pin", "exclude"]),
  path: z.string().min(1).max(512),
  repo_id: z.string().uuid().nullable(),
  work_item_id: z.string().uuid().nullable(),
});
/** A listed rule; `missing_at` (D#600 CX-9b) is the default branch's head sha a pinned path was not found at, and is absent when the path exists or could not be checked. */
const listedRuleSchema = ruleSchema.extend({ missing_at: z.string().regex(/^[0-9a-f]{40}$/).optional() });
export const contextRuleResponseSchema = z.object({ data: z.array(listedRuleSchema).max(1000) });

const putBodySchema = z
  .object({
    scope: z.enum(["repo", "item"]),
    repo_id: z.string().uuid().optional(),
    work_item_id: z.string().uuid().optional(),
    kind: z.enum(["pin", "exclude"]),
    path: z.string().min(1).max(512),
  })
  .strict()
  .refine((b) => (b.scope === "repo" ? b.repo_id !== undefined && b.work_item_id === undefined : b.work_item_id !== undefined && b.repo_id === undefined), {
    message: "a repo rule names repo_id only; an item rule names work_item_id only",
  });
const idParamsSchema = z.object({ id: z.string().uuid() });
const removeQuerySchema = z.object({ confirm: z.literal("true").optional() }).strict();

const WRITE_ERRORS = {
  "403": "`insufficient_role`: a member may set item rules only; the repository's rules are an owner's or admin's.",
  "404": "`not_found`: no such repository, item or rule in this account.",
  "409":
    "`pins_exceed_budget` (the pins would not fit the repository's budget, for this item or for any item the repository rule lands in), `pins_exceed_ceiling` (more than 500 pins in one set), " +
    "`excludes_exceed_cap` (more than 500 excludes in one set), `context_rules_busy` (another change is in progress; try again), `tree_truncated`, `repo_not_connected`, " +
    "or, on a remove, `exclude_readds_pins`. Nothing is written.",
  "422": "`invalid_path`: not a repository-relative path, or a pin containing * or ?.",
  "503": "`tree_unavailable`: the repository could not be read while measuring a pin. Nothing is written.",
};

export const contextRuleRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/context-rules",
    operationId: "listContextRules",
    summary: "The pins and excludes of a repository, or in force for an item",
    description:
      "Session only, member. Name `repo_id` for the rules set on a repository, or `work_item_id` for the rules in force for an item: the item's own rules, and the repository's for every path the item has no rule on. " +
      "A pin keeps a file in the run's prompt; an exclude keeps a path (or glob) out of what the agent may read. A change applies from the next run, and a run already started keeps the rules it began with. " +
      "Another account's repository or item answers an empty list. A pin whose path is not in the default branch's tree carries `missing_at`, the head sha it was looked for at; the label is best effort and left off when the tree cannot be read, is too large, or the read is slow.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema,
    responseSchema: contextRuleResponseSchema,
    handler: async (ctx, input) => {
      const q = input.query as z.infer<typeof querySchema>;
      const target = q.repo_id !== undefined ? { repoId: q.repo_id } : { workItemId: q.work_item_id! };
      const rules = await listContextRules(ctx.pool, ctx.principal, target);
      const missing = await missingResolver.missingPins(ctx.pool, ctx.principal, target, rules);
      return { data: rules.map((r) => ({ id: r.id, scope: r.scope, kind: r.kind, path: r.path, repo_id: r.repoId, work_item_id: r.workItemId, ...(missing.has(r.id) ? { missing_at: missing.get(r.id)! } : {}) })) };
    },
  },
  {
    method: "PUT",
    path: "/api/v1/context-rules",
    operationId: "putContextRule",
    summary: "Save a pin or an exclude on a repository or an item",
    description:
      "Session only, member. The other kind saved for a path that already has a rule in the same scope replaces it. A pin is measured against the repository's context budget (the executor's default when none is stored) for every item the rule lands in, " +
      "under a lock held per repository; a save over the budget writes nothing. One audit row per save, in the same transaction. A change applies from the next run; a run already started keeps the rules it began with.",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.contextRuleWrite,
    minRole: "member",
    idempotency: "never",
    extraResponses: WRITE_ERRORS,
    bodySchema: putBodySchema,
    responseSchema: ruleSchema,
    handler: async (ctx, input) => {
      const b = input.body as z.infer<typeof putBodySchema>;
      const target = b.scope === "repo" ? ({ scope: "repo", repoId: b.repo_id! } as const) : ({ scope: "item", workItemId: b.work_item_id! } as const);
      try {
        const { id } = await saveContextRule(saveDeps(ctx.pool), ctx.principal, target, b.kind, b.path);
        return { id, scope: b.scope, kind: b.kind, path: b.path, repo_id: b.repo_id ?? null, work_item_id: b.work_item_id ?? null };
      } catch (error) {
        throw mapRuleRefusal(error);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/context-rules/{id}",
    operationId: "deleteContextRule",
    summary: "Remove a pin or an exclude",
    description:
      "Session only, member (item rules) or owner/admin (repository rules). The rule is deleted and one audit row records the removal; a run already started keeps the rules it began with. " +
      "Removing an item's exclude can bring a repository pin back into that item's runs: if the pins then no longer fit the budget, this answers 409 `exclude_readds_pins` and removes nothing; " +
      "repeat with `?confirm=true` to remove it anyway (a budget is never enforced on pins that are already saved).",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.contextRuleWrite,
    minRole: "member",
    idempotency: "never",
    extraResponses: WRITE_ERRORS,
    paramsSchema: idParamsSchema,
    querySchema: removeQuerySchema,
    responseSchema: z.object({ removed: z.literal(true) }),
    handler: async (ctx, input) => {
      const q = input.query as z.infer<typeof removeQuerySchema>;
      try {
        await removeContextRuleChecked(saveDeps(ctx.pool), ctx.principal, input.params.id!, q.confirm === "true");
      } catch (error) {
        throw mapRuleRefusal(error);
      }
      return { removed: true as const };
    },
  },
];
