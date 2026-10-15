import { z } from "zod";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry, RouteContext } from "../registry.js";

/**
 * D#605 FL-4: the routing rules of a repository and of a work item, `{ require, prefer }` (see the claim, packages/worker/src/runnerRouting.ts). The
 * item's rules replace the repo's per key. An owner or admin sets them, from a session only: a token never can, and the database function re-derives
 * the caller's role and checks that every preferred runner is a live runner of the caller's own account, so the route decides no permission. A rule
 * only narrows or reorders which runner may take a run; it never widens it. The body is checked here and again in the database, by hand rather than by
 * the framework's 422, because the contract for a bad rule is a plain 400 with nothing written.
 */
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RUNNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const labels = z.array(z.string().regex(LABEL)).max(16).refine((l) => new Set(l).size === l.length);
const routingSchema = z
  .object({
    require: z
      .object({
        os: z.enum(["linux", "macos"]).optional(),
        arch: z.enum(["x64", "arm64"]).optional(),
        engine: z.enum(["os_sandbox", "microvm"]).optional(),
        labels: labels.optional(),
        heavy_labels: labels.optional(),
      })
      .strict()
      .optional(),
    prefer: z
      .array(z.string().regex(RUNNER_ID))
      .max(20)
      .refine((l) => new Set(l).size === l.length)
      .optional(),
  })
  .strict();
type Routing = z.infer<typeof routingSchema>;

/** The rules as stored. A rule set with nothing in it is stored as no rules at all, so "cleared" has one form. */
export const runnerRoutingResponseSchema = z.object({ id: z.string().uuid(), runner_routing: routingSchema.nullable() });

const idParamsSchema = z.object({ id: z.string() });
/** The framework's own body check accepts any object; the real check is `parseRouting`. */
const bodySchema = z.record(z.string(), z.unknown());

function parseRouting(raw: unknown): Routing | null {
  const parsed = routingSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_input", "the routing rules do not match the schema");
  const out: Routing = {};
  const require = Object.fromEntries(Object.entries(parsed.data.require ?? {}).filter(([, v]) => v !== undefined));
  if (Object.keys(require).length > 0) out.require = require as NonNullable<Routing["require"]>;
  // An empty list is kept: on an item it overrides the repository's list, which is how an item says "no preference".
  if (parsed.data.prefer !== undefined) out.prefer = parsed.data.prefer;
  return Object.keys(out).length === 0 ? null : out;
}

async function put(ctx: RouteContext, kind: "repo" | "work_item", id: string, body: unknown) {
  if (!UUID.test(id)) throw new NotFoundError(`${kind} ${id} not found`);
  const routing = parseRouting(body);
  const { accountId, userId } = ctx.principal;
  const table = kind === "repo" ? "repos" : "work_items";
  try {
    return await withTenant(ctx.pool, accountId, userId, async (client) => {
      await client.query("SELECT runner_routing_set($1, $2::uuid, $3::jsonb)", [kind, id, routing === null ? null : JSON.stringify(routing)]);
      const row = (await client.query<{ runner_routing: Routing | null }>(`SELECT runner_routing FROM ${table} WHERE id = $1`, [id])).rows[0];
      return { id, runner_routing: row?.runner_routing ?? null };
    });
  } catch (error) {
    switch ((error as { code?: string }).code) {
      case "P0002":
        throw new NotFoundError(`${kind} ${id} not found`);
      case "22023":
        // A preferred runner that is not a live runner of this account (another account's id looks the same as an unknown one).
        throw new ApiError(400, "invalid_input", "a preferred runner is not a live runner of this account");
      default:
        throw error;
    }
  }
}

export const runnerRoutingRoutes: RouteEntry[] = [
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/runner-routing",
    operationId: "putRepoRunnerRouting",
    summary: "Set which runners may take a repository's runs: required os, arch, engine and labels, and preferred runners in order",
    description: "Owners and admins only, from a session. The body replaces the repository's rules; `{}` clears them. A preferred runner must be a live runner of the account, and a label must match `^[a-z0-9][a-z0-9-]{0,31}$`; otherwise 400 and nothing is written. Rules only narrow or reorder which runner may take a run.",
    // principals omitted -> session-only: an API token can never change who may run work.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema,
    responseSchema: runnerRoutingResponseSchema,
    async handler(ctx, input) {
      return put(ctx, "repo", input.params.id!, input.body);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/work-items/{id}/runner-routing",
    operationId: "putWorkItemRunnerRouting",
    summary: "Set which runners may take a work item's runs, replacing the repository's rules key by key",
    description: "Owners and admins only, from a session. The body replaces the item's rules; `{}` clears them, which restores the repository's rules. Same checks as the repository's route.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema,
    responseSchema: runnerRoutingResponseSchema,
    async handler(ctx, input) {
      return put(ctx, "work_item", input.params.id!, input.body);
    },
  },
];
