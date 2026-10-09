import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUN_LIMIT_BOUNDS, RUN_LIMIT_INTEGER_KEYS, type RunLimitKey } from "@fx/core/src/run-limits/limits.js";
import { resolveRunLimits } from "@fx/core/src/run-limits/resolve.js";
import { InstallationNotWritableError, assertWriteInstallation } from "@fx/github";
import { loadLiveRoutingTable, route, type Size } from "@fx/model-router";
import { getRoleEntry } from "@fx/roles";
import { loadProductCard, type CardRuntime } from "@fx/roles/cards";
import { PREVIEW_COMPUTE_CAP_USD, PREVIEW_MAX_RUN_MS, PREVIEW_MODEL_CAP_USD } from "./preview.js";
import type { RetrySeatSource } from "./retry.js";
import { runsInOurSandbox, EXTENSION_SLICE_FRACTION, SANDBOX_MAX_TIMEOUT_MS, SANDBOX_TIMEOUT_MARGIN_MS, SANDBOX_VCPUS, type Product, type RunLimitsInput, type StartAgentRunInput } from "@fx/runner";
import { PINNED_MEMORY_MB, computeComputeUsd, isClaudeModelId, type PlanId } from "@fx/spend";

/**
 * D#2 H14c-3-2d-2: the seat resolver. It reads everything for one run inside ONE tenant transaction and
 * answers with plain data: a seat or a fixed refusal. It starts nothing, reserves nothing, writes nothing,
 * and no pool or client leaves it. Every field has one source and no default (CARRY-9).
 */

export type SeatRequest =
  | {
      accountId: string;
      role: string;
      workItemId: string;
      /**
       * D#6 R4d-1 (C32): the repository's `execution_mode` the caller built the run's prompt for. The role card is the one for THAT
       * mode (the runner's executor card for `runner_local`), so a card always matches its prompt. The start itself refuses
       * `execution_mode_changed` when the mode is no longer that. Absent: the card follows the mode read here.
       */
      expectedExecutionMode?: string;
    }
  | { accountId: string; role: string; repoId: string; purpose: "preview" };

export type SeatRefusal =
  | "unknown_role"
  | "no_card"
  | "no_repo"
  | "no_installation"
  | "installation_not_writable"
  | "no_model"
  | "model_budget_unset"
  | "limits_exceed_sandbox"
  | "account_not_found";

export type SeatRunConfig = Omit<StartAgentRunInput, "accountId" | "role" | "workItemId" | "prompt" | "idempotency">;
export type SeatResult = { ok: true; seat: SeatRunConfig & { limits: RunLimitsInput; timeoutMs: number; maxExtensions: number } } | { ok: false; reason: SeatRefusal };

const MIN = 60_000;
/** The platform ceiling on one run's length (also what the extension policy is handed). */
export const RUN_TIME_CEILING_MS = RUN_LIMIT_BOUNDS.max_run_minutes.ceiling * MIN;
/** The one place a manifest tier becomes a model id (C55 s4). */
export const TIER_TO_MODEL_ID: Readonly<Record<string, string>> = { haiku: "haiku-4.5", sonnet: "sonnet-5", opus: "opus-5" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZE_OF_KIND: Readonly<Record<string, Size>> = { small: "Small", feature: "Feature", critical: "Critical" };
const refuse = (reason: SeatRefusal): SeatResult => ({ ok: false, reason });

/** R-BOUNDS (a): every resolved value is held to core's floor and ceiling (a non-number takes the default); whole numbers stay whole. */
export function boundedLimit(key: RunLimitKey, value: unknown): number {
  const b = RUN_LIMIT_BOUNDS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return b.default;
  const clamped = Math.min(Math.max(value, b.floor), b.ceiling);
  return RUN_LIMIT_INTEGER_KEYS.includes(key) ? Math.trunc(clamped) : clamped;
}

/** The one mapping from core's resolved limits (minutes, snake_case) to the runner's (ms), plus the two figures the seat itself needs. */
export function runnerLimitsFrom(resolved: Record<RunLimitKey, number>): { limits: RunLimitsInput; maxExtensions: number; perRunUsd: number } {
  return {
    limits: {
      maxRunMs: boundedLimit("max_run_minutes", resolved.max_run_minutes) * MIN,
      maxTurns: boundedLimit("max_turns", resolved.max_turns),
      maxModelCalls: boundedLimit("max_model_calls", resolved.max_model_calls),
      meteringSilenceMs: boundedLimit("silence_minutes", resolved.silence_minutes) * MIN,
    },
    maxExtensions: boundedLimit("max_extensions", resolved.max_extensions),
    perRunUsd: boundedLimit("per_run_usd", resolved.per_run_usd),
  };
}

/** D-TIMEOUT: the sandbox lives past the longest the run can go (every extension taken, up to the platform ceiling) by one margin. */
export function sandboxTimeFor(limits: RunLimitsInput, maxExtensions: number): { maxPossibleRunMs: number; timeoutMs: number } {
  const slice = Math.floor(limits.maxRunMs * EXTENSION_SLICE_FRACTION);
  const maxPossibleRunMs = Math.min(limits.maxRunMs + maxExtensions * slice, RUN_TIME_CEILING_MS);
  return { maxPossibleRunMs, timeoutMs: maxPossibleRunMs + SANDBOX_TIMEOUT_MARGIN_MS };
}

/**
 * The retry module's seat source over the resolver (H14c-3-2e). The retry module types `limits` as an index-signature
 * record, which the runner's `RunLimits` interface is not, so the limits are copied into a plain object (no cast);
 * the refusal passes through as is.
 */
export function retrySeatSourceOf(resolve: (request: SeatRequest) => Promise<SeatResult>): RetrySeatSource {
  return {
    retrySeat: async (input) => {
      const result = await resolve(input);
      return result.ok ? { ok: true, seat: { ...result.seat, limits: { ...result.seat.limits } } } : result;
    },
  };
}

export interface SeatDeps {
  /** The runner login's pool. */
  pool: Pool;
  /** The role's card for a run on `options.runtime` (default: the product card; only the executor has a runner variant). */
  loadCard?: (role: string, options?: { runtime: CardRuntime }) => string | undefined;
  tierToModelId?: Readonly<Record<string, string>>;
  maxTimeoutMs?: number;
  /** The operator decision for an account (operatorMode(env, id).active). Absent: no account is an operator. */
  isOperatorAccount?: (accountId: string) => boolean;
}

const NO_ROUTE = /^no (live routing_tables row|routing row)/;

/** The model: the repo's role override, else the live routing table, else the manifest tier through TIER_TO_MODEL_ID. Always a priced id or undefined. */
async function modelFor(client: PoolClient, deps: SeatDeps, q: { accountId: string; repoId: string; role: string; tier: string; size: Size | undefined }): Promise<string | undefined> {
  const { rows } = await client.query<{ model: string | null }>("SELECT model FROM role_settings WHERE account_id = $1 AND repo_id = $2 AND role = $3", [q.accountId, q.repoId, q.role]);
  let model: string | undefined = rows[0]?.model ?? undefined;
  if (model === undefined && q.size !== undefined) {
    try {
      // The tenant client stands in for the pool: the router only calls `.query`, and routing tables are readable by app_user.
      model = route({ role: q.role, size: q.size }, await loadLiveRoutingTable(client as unknown as Pool)).model;
    } catch (err) {
      if (!(err instanceof Error && NO_ROUTE.test(err.message))) throw err;
    }
  }
  model ??= (deps.tierToModelId ?? TIER_TO_MODEL_ID)[q.tier];
  return model !== undefined && isClaudeModelId(model) ? model : undefined;
}

export function createSeatResolver(deps: SeatDeps): (request: SeatRequest) => Promise<SeatResult> {
  return async function resolveRunSeat(request) {
    const { accountId, role } = request;
    const entry = getRoleEntry(role);
    if (entry === undefined) return refuse("unknown_role");
    const loadCard = deps.loadCard ?? loadProductCard;
    // A role with no card is refused before anything is read. The card for the run's runtime is picked once the repository is read.
    if (loadCard(role) === undefined) return refuse("no_card");
    if (typeof accountId !== "string" || !UUID_RE.test(accountId)) return refuse("account_not_found");
    const preview = "purpose" in request;
    const ownerId = preview ? request.repoId : request.workItemId;
    if (typeof ownerId !== "string" || !UUID_RE.test(ownerId)) return refuse("no_repo");

    return withTenant(deps.pool, accountId, async (client): Promise<SeatResult> => {
      const account = (await client.query<{ plan: PlanId; budget: string }>("SELECT plan, model_budget_usd_month AS budget FROM accounts WHERE id = $1", [accountId])).rows[0];
      if (account === undefined) return refuse("account_not_found");

      let repoId = ownerId;
      let kind: string | null = null;
      if (!preview) {
        const item = (await client.query<{ repo_id: string | null; kind: string | null }>("SELECT repo_id, kind FROM work_items WHERE id = $1 AND account_id = $2", [ownerId, accountId])).rows[0];
        if (item?.repo_id == null) return refuse("no_repo");
        repoId = item.repo_id;
        kind = item.kind;
      }
      const repo = (
        await client.query<{ product: Product; app_kind: string | null; execution_mode: string }>(
          `SELECT r.product, r.execution_mode, i.app_kind FROM repos r
             LEFT JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
            WHERE r.id = $1 AND r.account_id = $2`,
          [repoId, accountId],
        )
      ).rows[0];
      if (repo === undefined) return refuse("no_repo");
      // The card follows the mode the caller built its prompt for; a preview has no work-item prompt, so it follows the repository.
      const cardMode = "expectedExecutionMode" in request && request.expectedExecutionMode !== undefined ? request.expectedExecutionMode : repo.execution_mode;
      const roleCard = runsInOurSandbox(cardMode, role) ? loadCard(role) : loadCard(role, { runtime: "runner" });
      if (roleCard === undefined) return refuse("no_card");
      if (repo.app_kind === null) return refuse("no_installation");
      if (preview) {
        // A preview reads a repo through the read-only App and never writes: any other kind is not a preview seat.
        if (repo.app_kind !== "team_readonly") return refuse("no_installation");
      } else {
        try {
          assertWriteInstallation(repo.app_kind);
        } catch (err) {
          if (err instanceof InstallationNotWritableError) return refuse("installation_not_writable");
          throw err;
        }
      }

      const monthlyModelBudgetUsd = Number(account.budget);
      // An operator account runs on our own subscription, which no account budget pays for: it needs none set.
      if (!(monthlyModelBudgetUsd > 0) && !(deps.isOperatorAccount?.(accountId) ?? false)) return refuse("model_budget_unset");

      const resolved = runnerLimitsFrom(await resolveRunLimits(client, { accountId, role }));
      // A preview must end by its own limit inside the invocation that reads its stream, and takes no extension.
      const limits = preview ? { ...resolved.limits, maxRunMs: Math.min(resolved.limits.maxRunMs, PREVIEW_MAX_RUN_MS) } : resolved.limits;
      const maxExtensions = preview ? 0 : resolved.maxExtensions;
      const capUsd = preview ? PREVIEW_MODEL_CAP_USD : resolved.perRunUsd;
      const { maxPossibleRunMs, timeoutMs } = sandboxTimeFor(limits, maxExtensions);
      const estimateComputeUsd = computeComputeUsd(maxPossibleRunMs / 1000, SANDBOX_VCPUS, PINNED_MEMORY_MB / 1024);
      if (timeoutMs > (deps.maxTimeoutMs ?? SANDBOX_MAX_TIMEOUT_MS) || (preview && estimateComputeUsd > PREVIEW_COMPUTE_CAP_USD)) return refuse("limits_exceed_sandbox");

      const size = preview ? "Small" : kind === null ? undefined : SIZE_OF_KIND[kind];
      const model = await modelFor(client, deps, { accountId, repoId, role, tier: entry.defaultModel, size });
      if (model === undefined) return refuse("no_model");

      const workItemKind = kind === "small" ? "small" : kind === "feature" ? "feature" : undefined;
      return {
        ok: true,
        seat: {
          repoId,
          product: repo.product,
          roleCard,
          model,
          capUsd,
          timeoutMs,
          limits,
          maxExtensions,
          spend: {
            ...(!preview && { workItemId: ownerId }),
            ...(workItemKind !== undefined && { workItemKind }),
            purpose: preview ? "preview" : "run",
            trigger: "foreground",
            estimateModelUsd: capUsd,
            estimateComputeUsd,
            plan: account.plan,
            monthlyModelBudgetUsd,
            perSpawnCapUsd: capUsd,
          },
        },
      };
    });
  };
}
