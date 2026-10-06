import { z } from "zod";
import type { Pool } from "pg";
import { assertRepoIdShape, isManifestRole } from "@fx/core/src/repos/read.js";
import { listRoleSettings, type RoleModelResolvers } from "@fx/core/src/role-settings/list.js";
import { setRoleMode } from "@fx/core/src/role-settings/setMode.js";
import { setRoleModel } from "@fx/core/src/role-settings/setModel.js";
import { InvalidRoleSettingsInputError } from "@fx/core/src/role-settings/errors.js";
import { ROLE_MODEL_IDS, type RoleModelId } from "@fx/core/src/role-settings/types.js";
import { allowedModelsFor, applyCustomerOverride, floorFor, loadLiveRoutingTable } from "@fx/model-router";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import type { RoleMode, RoleSettingsEntry } from "@fx/core/src/role-settings/types.js";
import type { RouteEntry } from "../registry.js";

const expectedSpendSchema = z.object({
  text: z.string(),
  monthly_usd: z.number(),
  runs_per_month: z.number(),
  median_cost_per_run_usd: z.number(),
  median_source: z.enum(["seed", "ledger"]),
  caveat: z.string(),
});

/** D#31 API-8a: one role of the 26. `model` is the stored override, null meaning "follows the routing table". */
export const roleResponseSchema = z.object({
  role: z.string(),
  mode: z.string(),
  allowed_modes: z.array(z.string()),
  model: z.string().nullable(),
  /** The lowest model this role may run on (H22), or null when it has no floor. */
  model_floor: z.string().nullable(),
  /** The models this role may be set to, weakest first: what a model PATCH would accept. */
  allowed_models: z.array(z.string()),
  expected_spend: expectedSpendSchema,
});

const listRolesResponseSchema = z.object({ data: z.array(roleResponseSchema) });

const repoIdParamsSchema = z.object({ id: z.string() });
const roleParamsSchema = z.object({ id: z.string(), role: z.string() });

/**
 * Exactly one of `mode` or `model` per request (one transaction, one audit
 * row). `model: null` clears the override; a value outside the three ids is
 * refused by the service and the floor by the route.
 */
const patchRoleBodySchema = z
  .object({ mode: z.string().optional(), model: z.string().nullable().optional() })
  .strict()
  .refine((b) => (b.mode !== undefined) !== (b.model !== undefined), {
    message: "send exactly one of mode or model",
  });

/**
 * What the spend line needs from the router: each role's model in the live
 * routing table (its Feature row, the size the manifest default mirrors) and
 * its floor. A role the table has no row for falls back to its manifest default.
 */
async function modelResolvers(pool: Pool): Promise<RoleModelResolvers> {
  const table = await loadLiveRoutingTable(pool);
  const routed = new Map(table.rows.filter((r) => r.size === "Feature").map((r) => [r.role, r.model as RoleModelId]));
  return { routedModelFor: (role) => routed.get(role), floorFor: (role) => floorFor(role) as RoleModelId | undefined };
}

function toRoleItem(entry: RoleSettingsEntry): z.infer<typeof roleResponseSchema> {
  return {
    role: entry.role,
    mode: entry.mode,
    allowed_modes: entry.allowedModes,
    model: entry.model,
    model_floor: floorFor(entry.role) ?? null,
    allowed_models: allowedModelsFor(entry.role, undefined, ROLE_MODEL_IDS),
    expected_spend: {
      text: entry.costLine.text,
      monthly_usd: entry.costLine.monthlyUsd,
      runs_per_month: entry.costLine.runsPerMonth,
      median_cost_per_run_usd: entry.costLine.medianCostPerRunUsd,
      median_source: entry.costLine.medianSource,
      caveat: entry.costLine.caveat,
    },
  };
}

/** "The v1 contract" > route table, API-8a rows: roles read (S+T(read), member), role-mode PATCH (S, owner/admin). */
export const roleRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/roles",
    operationId: "listRoles",
    summary: "All 26 roles for a repo with mode, allowed modes, model override and expected spend",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    responseSchema: listRolesResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const entries = await listRoleSettings({ pool: ctx.pool, principal: ctx.principal }, repoId, await modelResolvers(ctx.pool));
      return { data: entries.map(toRoleItem) };
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/repos/{id}/roles/{role}",
    operationId: "patchRole",
    summary: "Change one role's mode, or set or clear its model override, on a repo (exactly one per request)",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: roleParamsSchema,
    bodySchema: patchRoleBodySchema,
    responseSchema: roleResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      const role = input.params.role!;
      assertRepoIdShape(repoId);
      // The URL names a resource; one that does not exist is a 404, not a 422.
      if (!isManifestRole(role)) {
        throw new NotFoundError(`role ${role} not found`);
      }
      const body = input.body as z.infer<typeof patchRoleBodySchema>;
      const serviceCtx = { pool: ctx.pool, principal: ctx.principal };
      if (body.model !== undefined) {
        // H22 floor, applied before the transaction opens (a pure function of
        // role and model). An id outside the three is left to the service's
        // own check; the database CHECK is the last backstop.
        if (body.model !== null && (ROLE_MODEL_IDS as readonly string[]).includes(body.model)) {
          const verdict = applyCustomerOverride(role, body.model as RoleModelId);
          if (!verdict.accepted) {
            throw new InvalidRoleSettingsInputError(verdict.reason, "model");
          }
        }
        await setRoleModel(serviceCtx, { repoId, role, model: body.model as RoleModelId | null });
      } else {
        // An out-of-range mode is rejected by the service (InvalidRoleSettingsInputError -> 422).
        await setRoleMode(serviceCtx, { repoId, role, mode: body.mode as RoleMode });
      }
      const entries = await listRoleSettings(serviceCtx, repoId, await modelResolvers(ctx.pool));
      const entry = entries.find((e) => e.role === role);
      if (!entry) {
        throw new NotFoundError(`role ${role} not found`);
      }
      return toRoleItem(entry);
    },
  },
];
