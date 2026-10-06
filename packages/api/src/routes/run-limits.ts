import { z } from "zod";
import type { PoolClient } from "pg";
import { isManifestRole } from "@fx/core/src/repos/read.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assertActiveMembership } from "@fx/core/src/tenancy/scopedAccess.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import {
  ACCOUNT_DEFAULT_ROLE,
  AUTO_RESUME_DEFAULT,
  RUN_LIMIT_BOUNDS,
  RUN_LIMIT_KEYS,
  mergeRunLimits,
  setRunLimits,
  toStored,
  type StoredRunLimits,
} from "@fx/core/src/run-limits/index.js";
import type { RouteEntry } from "../registry.js";

/** The URL's name for the account-wide row (stored as role '*'). */
const DEFAULT_ROLE_PARAM = "default";

const storedSchema = z.object({
  max_run_minutes: z.number().nullable(),
  max_model_calls: z.number().nullable(),
  per_run_usd: z.number().nullable(),
  max_turns: z.number().nullable(),
  silence_minutes: z.number().nullable(),
  max_extensions: z.number().nullable(),
  max_resumes: z.number().nullable(),
  auto_resume: z.boolean().nullable(),
});

const resolvedSchema = z.object({
  max_run_minutes: z.number(),
  max_model_calls: z.number(),
  per_run_usd: z.number(),
  max_turns: z.number(),
  silence_minutes: z.number(),
  max_extensions: z.number(),
  max_resumes: z.number(),
  auto_resume: z.boolean(),
});

/** `stored` is what this row holds (null = inherits); `resolved` is what a run would actually get. */
export const runLimitsEntrySchema = z.object({
  role: z.string(),
  stored: storedSchema,
  resolved: resolvedSchema,
});

const boundSchema = z.object({ default: z.number(), floor: z.number(), ceiling: z.number() });

export const runLimitsResponseSchema = z.object({
  default: runLimitsEntrySchema,
  /** Only roles that have their own row. Any other role resolves to the account default. */
  roles: z.array(runLimitsEntrySchema),
  bounds: z.object({
    max_run_minutes: boundSchema,
    max_model_calls: boundSchema,
    per_run_usd: boundSchema,
    max_turns: boundSchema,
    silence_minutes: boundSchema,
    max_extensions: boundSchema,
    max_resumes: boundSchema,
    auto_resume: z.object({ default: z.boolean() }),
  }),
});

const roleParamsSchema = z.object({ role: z.string() });

/** The column is numeric(8, 2) and would silently round a third decimal (1.005 -> 1.01), so refuse it instead. */
function isWholeCents(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

/**
 * Merge semantics: a key that is left out stays as it is; `null` clears it so
 * the row inherits (role row -> account row -> built-in default); a number
 * must sit within that limit's floor and ceiling (422 with the key as `path`).
 * per_run_usd takes at most 2 decimal places (422, code `custom`).
 */
const putBodySchema = z
  .object({
    max_run_minutes: z.number().nullable().optional(),
    max_model_calls: z.number().nullable().optional(),
    per_run_usd: z.number().refine(isWholeCents, "per_run_usd takes at most 2 decimal places").nullable().optional(),
    max_turns: z.number().nullable().optional(),
    silence_minutes: z.number().nullable().optional(),
    max_extensions: z.number().nullable().optional(),
    max_resumes: z.number().nullable().optional(),
    auto_resume: z.boolean().nullable().optional(),
  })
  .strict();

const COLUMNS = [...RUN_LIMIT_KEYS, "auto_resume"].join(", ");

async function readRows(client: PoolClient, accountId: string): Promise<Map<string, StoredRunLimits>> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT role, ${COLUMNS} FROM run_limits WHERE account_id = $1 ORDER BY role`,
    [accountId],
  );
  return new Map(rows.map((r) => [r.role as string, toStored(r)]));
}

function entry(role: string, rows: Map<string, StoredRunLimits>): z.infer<typeof runLimitsEntrySchema> {
  const account = rows.get(ACCOUNT_DEFAULT_ROLE);
  const isDefault = role === ACCOUNT_DEFAULT_ROLE;
  const own = rows.get(role);
  return {
    role: isDefault ? DEFAULT_ROLE_PARAM : role,
    stored: own ?? toStored(undefined),
    resolved: mergeRunLimits(isDefault ? undefined : own, account),
  };
}

/** D#31 API-8d: run limits read and set. */
export const runLimitRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/run-limits",
    operationId: "getRunLimits",
    summary: "The account's run limits: the default, per-role overrides, resolved values and the floors and ceilings",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: runLimitsResponseSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      const rows = await withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertActiveMembership(client, accountId, userId);
        return readRows(client, accountId);
      });
      const bounds = Object.fromEntries([
        ...RUN_LIMIT_KEYS.map((k) => [k, RUN_LIMIT_BOUNDS[k]] as const),
        ["auto_resume", { default: AUTO_RESUME_DEFAULT }] as const,
      ]) as z.infer<typeof runLimitsResponseSchema>["bounds"];
      return {
        default: entry(ACCOUNT_DEFAULT_ROLE, rows),
        roles: [...rows.keys()].filter((r) => r !== ACCOUNT_DEFAULT_ROLE).map((r) => entry(r, rows)),
        bounds,
      };
    },
  },
  {
    method: "PUT",
    path: "/api/v1/run-limits/{role}",
    operationId: "putRunLimits",
    summary: "Set one role's run limits, or the account default with role 'default'. Omitted keys are unchanged, null inherits",
    // principals omitted -> session-only: an API token can never change limits.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: roleParamsSchema,
    bodySchema: putBodySchema,
    responseSchema: runLimitsEntrySchema,
    async handler(ctx, input) {
      const param = input.params.role!;
      const isDefault = param === DEFAULT_ROLE_PARAM;
      // The URL names a resource; a role that does not exist is a 404 ('*' is not addressable).
      if (!isDefault && !isManifestRole(param)) {
        throw new NotFoundError(`role ${param} not found`);
      }
      const role = isDefault ? ACCOUNT_DEFAULT_ROLE : param;
      const body = input.body as z.infer<typeof putBodySchema>;
      const values = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      await setRunLimits({ pool: ctx.pool, principal: ctx.principal }, { role, values });
      const { accountId, userId } = ctx.principal;
      const rows = await withTenant(ctx.pool, accountId, userId, (client) => readRows(client, accountId));
      return entry(role, rows);
    },
  },
];
