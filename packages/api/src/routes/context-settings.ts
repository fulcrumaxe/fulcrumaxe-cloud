import { z } from "zod";
import { CONTEXT_BUDGET_MAX_BYTES, CONTEXT_BUDGET_MIN_BYTES, ROLE_CONTEXT_DEFAULTS } from "@fx/core/src/context/contextBudget.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { contextBudgetView, readContextBudget, writeContextBudget, type ContextBudgetView } from "@fx/pipeline";
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
const viewSchema = z.object({
  /** The stored size, or null for "use each role's default". */
  context_budget_bytes: z.number().int().nullable(),
  min_bytes: z.number().int(),
  max_bytes: z.number().int(),
  role_defaults: byRole,
  /** What each role's prompt is held to now. */
  effective_by_role: byRole,
});
const putResponseSchema = viewSchema.extend({
  changed: z.boolean(),
  /** Whether the repository's pins fit the executor's budget now: `fit`, `over_budget` (accepted anyway: pins are never cut at run time) or `not_measured` (no answer to measure with). */
  pins_status: z.enum(["fit", "over_budget", "not_measured"]),
});

const toView = (v: ContextBudgetView) => ({
  context_budget_bytes: v.contextBudgetBytes,
  min_bytes: CONTEXT_BUDGET_MIN_BYTES,
  max_bytes: CONTEXT_BUDGET_MAX_BYTES,
  role_defaults: { ...ROLE_CONTEXT_DEFAULTS },
  effective_by_role: v.effectiveByRole,
});

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
        return { ...toView(contextBudgetView(done.contextBudgetBytes)), changed: done.changed, pins_status: done.pinsStatus };
      } catch (error) {
        throw mapRuleRefusal(error);
      }
    },
  },
];
