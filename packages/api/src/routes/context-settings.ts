import { z } from "zod";
import { CONTEXT_BUDGET_CONSUMERS, CONTEXT_BUDGET_MAX_BYTES, CONTEXT_BUDGET_MIN_BYTES, CONTEXT_BUDGET_ROLES, consumesContextBudget, ROLE_CONTEXT_DEFAULTS, itemBudgetMax, roleBudgetMax, type ContextBudgetRole } from "@fx/core/src/context/contextBudget.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { BudgetOutOfRangeError, readContextBudget, readItemContextBudget, writeBudgetOverride, writeContextBudget, type ContextBudgetView, type ItemBudgetView } from "@fx/pipeline";
import { ApiError } from "../errors.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import type { RouteEntry } from "../registry.js";
import { mapRuleRefusal, saveDeps } from "./context-rules.js";

/**
 * D#600 CX-9a: a repository's context budget, the bytes its prompts are held to. `GET` and `PUT /api/v1/repos/{id}/context-settings`, session only. A read is
 * any member's. The write is an owner's or admin's (the definer re-derives the role, so a member gets 403): `context_budget_bytes` between 4096 and 2097152, or
 * `null` to reset to each role's default ("Reset to default" is a write of null, so a later change of a default reaches the repository). The answer always
 * carries every role's default and what each role is held to now, so a screen never shows an empty value.
 */
const idParamsSchema = z.object({ id: z.string() });
const putBodySchema = z.object({ context_budget_bytes: z.number().int().min(CONTEXT_BUDGET_MIN_BYTES).max(CONTEXT_BUDGET_MAX_BYTES).nullable() }).strict();

const roles = ["executor", "fix", "code-reviewer", "acceptance-tester", "security-reviewer", "debater"] as const;
const byRole = z.object(Object.fromEntries(roles.map((r) => [r, z.number().int()])) as Record<(typeof roles)[number], z.ZodNumber>);
const sourceEnum = z.enum(["item", "role", "repo", "default"]);
const bySource = z.object(Object.fromEntries(roles.map((r) => [r, sourceEnum])) as Record<(typeof roles)[number], typeof sourceEnum>);
const byRoleOrNull = z.object(Object.fromEntries(roles.map((r) => [r, z.number().int().nullable()])) as Record<(typeof roles)[number], z.ZodNullable<z.ZodNumber>>);
const viewSchema = z.object({
  /** The stored size, or null for "use each role's default". */
  context_budget_bytes: z.number().int().nullable(),
  min_bytes: z.number().int(),
  max_bytes: z.number().int(),
  role_defaults: byRole,
  /** What each role's prompt is held to now (a role's own size, else the repository's, else its default), and which level said so. */
  effective_by_role: byRole,
  /** D#600 CX-12: each role's own stored size in this repository (null: none), the most each may be (its default times 2), and which level each effective size comes from. */
  role_budgets: byRoleOrNull,
  role_max: byRole,
  source_by_role: bySource,
  /** The roles whose runs actually use a budget today. A screen offers and explains only these; the other roles' numbers are stored but no run reads them yet. */
  consuming_roles: z.array(z.enum(roles)),
});
const itemViewSchema = z.object({
  /** This item's own stored size (null: none). It applies to every role's runs on the item, each held to its own default times 2. */
  item_budget_bytes: z.number().int().nullable(),
  min_bytes: z.number().int(),
  max_bytes: z.number().int(),
  role_defaults: byRole,
  effective_by_role: byRole,
  source_by_role: bySource,
  consuming_roles: z.array(z.enum(roles)),
});
const pinsStatusSchema = z.enum(["fit", "over_budget", "not_measured"]);
const overrideBodySchema = z.object({ budget_bytes: z.number().int().nullable() }).strict();
const putResponseSchema = viewSchema.extend({
  changed: z.boolean(),
  /** Whether the pins fit the budget of the role that uses them now: `fit`, `over_budget` (accepted anyway: pins are never cut at run time) or `not_measured` (no answer to measure with). Null when the written role's runs use no budget yet. */
  pins_status: pinsStatusSchema.nullable(),
  /** False when the written role's runs use no budget yet (the number is stored, and nothing reads it until that role consumes one). */
  applies_to_runs: z.boolean(),
});

const toView = (v: ContextBudgetView) => ({
  context_budget_bytes: v.contextBudgetBytes,
  min_bytes: CONTEXT_BUDGET_MIN_BYTES,
  max_bytes: CONTEXT_BUDGET_MAX_BYTES,
  role_defaults: { ...ROLE_CONTEXT_DEFAULTS },
  effective_by_role: v.effectiveByRole,
  role_budgets: v.roleBudgets,
  role_max: Object.fromEntries(CONTEXT_BUDGET_ROLES.map((r) => [r, roleBudgetMax(r)])) as Record<ContextBudgetRole, number>,
  source_by_role: v.sourceByRole,
  consuming_roles: [...CONTEXT_BUDGET_CONSUMERS],
});
const toItemView = (v: ItemBudgetView) => ({
  item_budget_bytes: v.itemBudgetBytes,
  min_bytes: CONTEXT_BUDGET_MIN_BYTES,
  max_bytes: itemBudgetMax(),
  role_defaults: { ...ROLE_CONTEXT_DEFAULTS },
  effective_by_role: v.effectiveByRole,
  source_by_role: v.sourceByRole,
  consuming_roles: [...CONTEXT_BUDGET_CONSUMERS],
});
/** The write's refusals: a value out of its level's range (the bound is in the message), and the definer's 403 and 404. */
const mapOverrideRefusal = (error: unknown): unknown =>
  error instanceof BudgetOutOfRangeError ? new ApiError(422, "budget_out_of_range", `The budget must be a whole number of bytes from ${error.min} to ${error.max}.`) : mapRuleRefusal(error);

export const contextSettingsRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/context-settings",
    operationId: "getRepoContextSettings",
    summary: "A repository's context budget, the role defaults and what each role is held to now",
    description: "Session only, member. `context_budget_bytes` is null when the repository never chose a size.",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: viewSchema,
    handler: async (ctx, input) => {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      return toView(await readContextBudget(saveDeps(ctx.pool), ctx.principal, repoId));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/context-settings",
    operationId: "putRepoContextSettings",
    summary: "Set or reset a repository's context budget. One audit row per real change",
    description:
      "Session only, owner or admin. `context_budget_bytes` from 4096 to 2097152, or null to reset to the role defaults. A budget lowered below the repository's existing pins is accepted: pins are never cut at run time, " +
      "and `pins_status` answers `over_budget` so the person knows. If GitHub cannot be asked, `pins_status` is `not_measured` and the write stands. An equal value writes nothing (`changed: false`).",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.contextRuleWrite,
    minRole: "admin",
    idempotency: "never",
    extraResponses: { "404": "`not_found`: no such repository in this account." },
    paramsSchema: idParamsSchema,
    bodySchema: putBodySchema,
    responseSchema: putResponseSchema,
    handler: async (ctx, input) => {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof putBodySchema>;
      try {
        const done = await writeContextBudget(saveDeps(ctx.pool), ctx.principal, repoId, body.context_budget_bytes);
        return { ...toView(done), changed: done.changed, pins_status: done.pinsStatus, applies_to_runs: true };
      } catch (error) {
        throw mapRuleRefusal(error);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/context-settings/roles/{role}",
    operationId: "putRepoRoleContextBudget",
    summary: "Set or reset one role's context budget in a repository. One audit row per real change",
    description:
      "Session only, owner or admin. `budget_bytes` from 4096 to the role's default times 2 (`role_max`), or null to remove the role's own budget so the repository's, then the role default, applies. A value outside the range answers 422 `budget_out_of_range` with the bound in the message. " +
      "A budget below the repository's existing pins is accepted and `pins_status` answers `over_budget`. A role whose runs use no budget yet (see `consuming_roles`) stores the number, answers `applies_to_runs: false` and `pins_status: null`. An equal value writes nothing (`changed: false`).",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.contextRuleWrite,
    minRole: "admin",
    idempotency: "never",
    extraResponses: { "404": "`not_found`: no such repository or role in this account." },
    paramsSchema: z.object({ id: z.string(), role: z.string() }),
    bodySchema: overrideBodySchema,
    responseSchema: putResponseSchema,
    handler: async (ctx, input) => {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const role = CONTEXT_BUDGET_ROLES.find((r) => r === input.params.role);
      if (role === undefined) throw new NotFoundError("not found");
      try {
        const done = await writeBudgetOverride(saveDeps(ctx.pool), ctx.principal, { scope: "role", repoId, role }, (input.body as z.infer<typeof overrideBodySchema>).budget_bytes);
        return { ...toView(await readContextBudget(saveDeps(ctx.pool), ctx.principal, repoId)), changed: done.changed, pins_status: done.pinsStatus, applies_to_runs: consumesContextBudget(role) };
      } catch (error) {
        throw mapOverrideRefusal(error);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/work-items/{id}/context-settings",
    operationId: "getWorkItemContextBudget",
    summary: "A work item's own context budget and what each role's run on it is held to",
    description: "Session only, member. `item_budget_bytes` is null when the item has none.",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: itemViewSchema,
    handler: async (ctx, input) => {
      assertRepoIdShape(input.params.id!);
      return toItemView(await readItemContextBudget(saveDeps(ctx.pool), ctx.principal, input.params.id!));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/work-items/{id}/context-settings",
    operationId: "putWorkItemContextBudget",
    summary: "Set or reset a work item's context budget. One audit row per real change",
    description:
      "Session only, owner or admin. `budget_bytes` from 4096 to the largest role default times 2 (`max_bytes`), or null to remove it. It applies to every role's runs on the item; a run is held to the smaller of it and its own role's default times 2. " +
      "A value outside the range answers 422 `budget_out_of_range` with the bound in the message. A budget below the item's pins is accepted and `pins_status` answers `over_budget`. An equal value writes nothing (`changed: false`).",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.contextRuleWrite,
    minRole: "admin",
    idempotency: "never",
    extraResponses: { "404": "`not_found`: no such work item in this account." },
    paramsSchema: idParamsSchema,
    bodySchema: overrideBodySchema,
    responseSchema: itemViewSchema.extend({ changed: z.boolean(), pins_status: pinsStatusSchema.nullable(), applies_to_runs: z.boolean() }),
    handler: async (ctx, input) => {
      const workItemId = input.params.id!;
      assertRepoIdShape(workItemId);
      try {
        const done = await writeBudgetOverride(saveDeps(ctx.pool), ctx.principal, { scope: "item", workItemId }, (input.body as z.infer<typeof overrideBodySchema>).budget_bytes);
        return { ...toItemView(await readItemContextBudget(saveDeps(ctx.pool), ctx.principal, workItemId)), changed: done.changed, pins_status: done.pinsStatus, applies_to_runs: true };
      } catch (error) {
        throw mapOverrideRefusal(error);
      }
    },
  },
];
