import type { PoolClient } from "pg";
import {
  effectiveRoleModel,
  loadComputeRunMedians,
  loadModelRunMedians,
  MEDIAN_MIN_RUNS,
  modelRunPrice,
  type RoleModelResolvers,
} from "@fx/core/src/role-settings/runPrice.js";
import { isRunnerMode, roleRunComputeUpperBoundUsd } from "@fx/runner";
import { debaterEnabledFor, tierOfKind } from "../review/reviewPlan.js";
import { runPlanFor, type NoEstimateReason, type PlannedRun } from "./runPlan.js";

/**
 * D#483 S5-p: the one priced estimate of what an item will cost, and the only place a price is computed. The concurrency preview and the
 * envelope pre-fill read it; nothing else may add its own figure. `proposals.estimate_usd` is never used here (the preview's build-and-review
 * figure runs 3 to 4 times low).
 *
 * The price of one run of a role, for the item's repo:
 *  - model part: the tenant's own median once the role has `MEDIAN_MIN_RUNS` runs on its effective model, else the plan-data seed for the
 *    model's tier (the shared lookup in core's runPrice.ts, which role settings also uses). A runner repo's subscription runs are still
 *    priced at the API rate, and the result says so (`modelPartEstimated`): the person's own subscription has a value though it is not billed.
 *  - compute part: a hosted repo uses the median compute spend of that role's runs once there are `MEDIAN_MIN_RUNS` of them, else the upper
 *    bound from the role's own run limits (runner `roleRunComputeUpperBoundUsd`, the chain the seat prices its reservation from). A runner
 *    repo's compute is 0.
 */

export type EstimateBasis = "history" | "seed" | "none";

export interface ItemEstimate {
  total_usd: number;
  /** The executor and review runs: what is still to spend once the item waits for a build slot. */
  slot_phase_usd: number;
  /** `history` when every role used had at least `MEDIAN_MIN_RUNS` runs to price from, `seed` otherwise, `none` when there is nothing to price. */
  basis: EstimateBasis;
  /** Set with `basis: "none"`. */
  reason: NoEstimateReason | null;
  /** The model part comes from the API rate for a runner repo (labelled "estimated" wherever it is shown). */
  modelPartEstimated: boolean;
}

export interface RolePrice {
  usd: number;
  /** Both parts came from the tenant's own runs. */
  history: boolean;
}

/** A price that is never negative, NaN or infinite. */
const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** Pure: the sums of a run plan at fixture prices. A role with no price counts 0 and makes the basis `seed`. */
export function priceRunPlan(runs: readonly PlannedRun[], priceOf: (role: string) => RolePrice | undefined): Pick<ItemEstimate, "total_usd" | "slot_phase_usd" | "basis"> {
  let total = 0;
  let slot = 0;
  let history = true;
  for (const run of runs) {
    const price = priceOf(run.role);
    if (price === undefined || !price.history) history = false;
    const usd = clean((price?.usd ?? 0) * clean(run.count));
    total += usd;
    if (run.slotPhase) slot += usd;
  }
  return { total_usd: total, slot_phase_usd: slot, basis: history ? "history" : "seed" };
}

interface RolePriceContext {
  accountId: string;
  runner: boolean;
  modelOverride: ReadonlyMap<string, string | null>;
  resolvers: RoleModelResolvers | undefined;
  modelMedians: Awaited<ReturnType<typeof loadModelRunMedians>>;
  computeMedians: Awaited<ReturnType<typeof loadComputeRunMedians>>;
}

async function rolePriceContext(
  client: PoolClient,
  input: { accountId: string; runner: boolean; modelOverride: ReadonlyMap<string, string | null>; resolvers?: RoleModelResolvers },
): Promise<RolePriceContext> {
  const { accountId, runner } = input;
  return {
    accountId,
    runner,
    modelOverride: input.modelOverride,
    resolvers: input.resolvers,
    modelMedians: await loadModelRunMedians(client, accountId),
    computeMedians: runner ? new Map() : await loadComputeRunMedians(client, accountId),
  };
}

/** The price of one run of `role` (the model part and the compute part described in the file header). */
async function priceRole(client: PoolClient, ctx: RolePriceContext, role: string): Promise<RolePrice> {
  const model = modelRunPrice(ctx.modelMedians, role, effectiveRoleModel(role, ctx.modelOverride.get(role), ctx.resolvers));
  let computeUsd = 0;
  let computeHistory = true;
  if (!ctx.runner) {
    const median = ctx.computeMedians.get(role);
    if (median !== undefined && median.n >= MEDIAN_MIN_RUNS) computeUsd = median.median;
    else {
      computeHistory = false;
      computeUsd = await roleRunComputeUpperBoundUsd(client, { accountId: ctx.accountId, role });
    }
  }
  return { usd: clean(model.usd) + clean(computeUsd), history: model.source === "ledger" && computeHistory };
}

/**
 * D#483 S5-b2c-1: p(role) for the repo, the same price `estimateItem` uses for that role's runs (no second formula). The child launch gate asks for p("executor"):
 * the first run of a planned PR child is the executor build.
 */
export async function rolePriceUsd(client: PoolClient, input: { accountId: string; repoId: string; role: string; resolvers?: RoleModelResolvers }): Promise<RolePrice> {
  const { accountId, repoId } = input;
  const repo = (await client.query<{ execution_mode: string | null }>("SELECT execution_mode FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId])).rows[0];
  if (repo === undefined) throw new Error("estimate: repo not found");
  const settings = (await client.query<{ role: string; model: string | null }>("SELECT role, model FROM role_settings WHERE repo_id = $1", [repoId])).rows;
  const ctx = await rolePriceContext(client, {
    accountId,
    runner: isRunnerMode(repo.execution_mode ?? "sandbox"),
    modelOverride: new Map(settings.map((s) => [s.role, s.model])),
    ...(input.resolvers !== undefined && { resolvers: input.resolvers }),
  });
  return priceRole(client, ctx, input.role);
}

/** The price of a planned PR child's first run: one executor run, rounded up to the unit the money columns hold (as `firstRunReservationUsd` rounds). */
export async function childFirstRunUsd(client: PoolClient, input: { accountId: string; repoId: string }): Promise<number> {
  const { usd } = await rolePriceUsd(client, { ...input, role: "executor" });
  return Math.ceil(usd * 1e4 - 1e-9) / 1e4;
}

export interface EstimateItemInput {
  accountId: string;
  repoId: string;
  /** The item's triage category (for a proposal: the verifier's, else the hint, else null). */
  category: string | null | undefined;
  title?: string;
  summary?: string;
  resolvers?: RoleModelResolvers;
}

/** Must run inside a `withTenant` transaction for `input.accountId` (RLS scopes every read; the WHEREs name the account too). */
export async function estimateItem(client: PoolClient, input: EstimateItemInput): Promise<ItemEstimate> {
  const { accountId, repoId } = input;
  const repo = (await client.query<{ execution_mode: string | null }>("SELECT execution_mode FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId])).rows[0];
  if (repo === undefined) throw new Error("estimate: repo not found");
  const runner = isRunnerMode(repo.execution_mode ?? "sandbox");

  const settings = (await client.query<{ role: string; mode: string; model: string | null }>("SELECT role, mode, model FROM role_settings WHERE repo_id = $1", [repoId])).rows;
  const debaterMode = settings.find((s) => s.role === "debater")?.mode ?? null;
  const modelOverride = new Map(settings.map((s) => [s.role, s.model]));

  const plan = runPlanFor({
    category: input.category,
    ...(input.title !== undefined && { title: input.title }),
    ...(input.summary !== undefined && { summary: input.summary }),
    debaterEnabled: debaterEnabledFor(debaterMode, tierOfKind(input.category) ?? "small"),
  });
  if (!plan.ok) return { total_usd: 0, slot_phase_usd: 0, basis: "none", reason: plan.reason, modelPartEstimated: false };

  const ctx = await rolePriceContext(client, { accountId, runner, modelOverride, ...(input.resolvers !== undefined && { resolvers: input.resolvers }) });
  const prices = new Map<string, RolePrice>();
  for (const { role } of plan.runs) {
    if (prices.has(role)) continue;
    prices.set(role, await priceRole(client, ctx, role));
  }
  return { ...priceRunPlan(plan.runs, (role) => prices.get(role)), reason: null, modelPartEstimated: runner };
}
