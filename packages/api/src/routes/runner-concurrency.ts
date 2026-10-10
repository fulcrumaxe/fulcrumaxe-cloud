import { z } from "zod";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assertActiveMembership } from "@fx/core/src/tenancy/scopedAccess.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { RUNNER_PLAN_ID, runnerLimitsFor, type HostedRunnerLimits, type RunnerLimits } from "@fx/spend";
import { PlanDataMissingError } from "@fx/plan-data";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#605 FL-12a: how many runner jobs a hosted account may have running at once, in all and on one repository. The figures start at the
 * plan data's defaults; an owner or admin raises or lowers them here with an explicit accept, and each real change writes one audit row.
 * What the claim applies is never more than this and never more than the account's live runners can hold, so the setting is a
 * ceiling the person chose, not a promise of capacity. On the runner plan the account figure is flat plan data, so there is nothing to set.
 */
export const runnerConcurrencyResponseSchema = z.object({
  /** Whether the account's own setting applies: a hosted plan. False on the runner plan, whose figure is flat. */
  applies: z.boolean(),
  total: z.number().int(),
  per_repo: z.number().int(),
  /** The plan's defaults, and whether this account has accepted a figure of its own. */
  default_total: z.number().int(),
  default_per_repo: z.number().int(),
  accepted: z.boolean(),
});

const putBodySchema = z
  .object({
    total: z.number().int().min(1).max(100),
    per_repo: z.number().int().min(1).max(100),
    accept: z.boolean().optional(),
  })
  .strict();

async function readSetting(client: PoolClient, accountId: string): Promise<z.infer<typeof runnerConcurrencyResponseSchema>> {
  const plan = (await client.query<{ plan: string }>("SELECT plan FROM accounts WHERE id = $1", [accountId])).rows[0]?.plan;
  if (plan === undefined) throw new NotFoundError(`account ${accountId} not found`);
  if (plan === RUNNER_PLAN_ID) {
    return { applies: false, total: 0, per_repo: 0, default_total: 0, default_per_repo: 0, accepted: false };
  }
  // Plan data that cannot give the figures throws PlanDataMissingError, which the API answers as 503 plan_data_unavailable.
  const defaults: HostedRunnerLimits | RunnerLimits = runnerLimitsFor(plan);
  if (!("hosted" in defaults)) throw new PlanDataMissingError(`plan ${JSON.stringify(plan)} has no hosted runner figures`);
  const stored = (await client.query<{ total_jobs: number; per_repo_jobs: number }>("SELECT total_jobs, per_repo_jobs FROM account_runner_concurrency WHERE account_id = $1", [accountId])).rows[0];
  return {
    applies: true,
    total: stored?.total_jobs ?? defaults.defaultAccountJobs,
    per_repo: stored?.per_repo_jobs ?? defaults.defaultPerRepoJobs,
    default_total: defaults.defaultAccountJobs,
    default_per_repo: defaults.defaultPerRepoJobs,
    accepted: stored !== undefined,
  };
}

export const runnerConcurrencyRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/account/runner-concurrency",
    operationId: "getRunnerConcurrency",
    summary: "The runner jobs the account may have running at once, in all and on one repository, and the plan's defaults",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: runnerConcurrencyResponseSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertActiveMembership(client, accountId, userId);
        return readSetting(client, accountId);
      });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/account/runner-concurrency",
    operationId: "putRunnerConcurrency",
    summary: "Set the account's runner concurrency. Needs accept true, and an owner or admin; one audit row per real change",
    // principals omitted -> session-only: an API token can never change it.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    bodySchema: putBodySchema,
    responseSchema: runnerConcurrencyResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof putBodySchema>;
      if (body.accept !== true) throw new ApiError(400, "accept_required", "the change needs accept: true");
      if (body.per_repo > body.total) throw new ApiError(400, "invalid_request", "per_repo cannot be more than total");
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        if (!(await readSetting(client, accountId)).applies) throw new ApiError(409, "not_applicable", "the runner plan's account limit is fixed by the plan");
        await client.query("SELECT account_runner_concurrency_set($1::int, $2::int, $3::boolean)", [body.total, body.per_repo, true]);
        return readSetting(client, accountId);
      });
    },
  },
];
