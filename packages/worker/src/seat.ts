import type { Pool, PoolClient } from "pg";
import { effectivePlan } from "@fx/plan-data";
import { withTenant } from "@fx/db/src/withTenant.js";
import { resolveRunLimits } from "@fx/core/src/run-limits/resolve.js";
import { InstallationNotWritableError, assertWriteInstallation } from "@fx/github";
import { loadLiveRoutingTable, route, type Size } from "@fx/model-router";
import { getRoleEntry } from "@fx/roles";
import { loadPlatformCard, loadProductCard, type CardRuntime } from "@fx/roles/cards";
import { PREVIEW_COMPUTE_CAP_USD, PREVIEW_MAX_RUN_MS, PREVIEW_MODEL_CAP_USD } from "./preview.js";
import type { RetrySeatSource } from "./retry.js";
import { DEPLOY_VERIFIER_ROLE, SURVEY_MAX_RUN_MS, SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { RUNNER_SIGN_IN_KIND_SQL, type RunnerSignInKind } from "@fx/db/src/runnerSignIn.js";
import { DISCOVERY_ANALYST_ROLE, PROPOSAL_VERIFIER_ROLE, effectiveModeSql, runsInOurSandbox, RUN_TIME_CEILING_MS, SANDBOX_MAX_TIMEOUT_MS, boundedLimit, runnerLimitsFrom, sandboxComputeUsdFor, sandboxTimeFor, type Product, type RunLimitsInput, type StartAgentRunInput } from "@fx/runner";
import { isClaudeModelId, TIER_TO_MODEL_ID, type PlanId } from "@fx/spend";
import { estimateRunModelUsd } from "@fx/core/src/role-settings/runPrice.js";

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
  | { accountId: string; role: string; repoId: string; purpose: "preview" }
  /**
   * D#483 S4-b2a: the claim verifier (`role` is its run role, proposal-verifier). It borrows VERIFY_LIMITS_ROLE's limits and model, as a
   * preview borrows the project manager's, and runs on its own platform card; `capUsd` is the per-proposal figure, its cap and its reservation.
   */
  | { accountId: string; role: string; repoId: string; purpose: "verify"; capUsd: number }
  /**
   * D#483 S4-f1: the discovery analyst (`role` is discovery-analyst). The same shape as a verify seat: VERIFY_LIMITS_ROLE's limits and model,
   * its own platform card, and `capUsd` (the analysis figure) as its cap and its reservation. Read-only on either team App.
   */
  | { accountId: string; role: string; repoId: string; purpose: "analyse"; capUsd: number }
  /**
   * D#749 V3c: the post-merge deploy verifier (`role` is deploy-verifier). The same shape as a verify seat: VERIFY_LIMITS_ROLE's limits and model, its own platform card, and `capUsd`
   * (one tester job's figure) as its cap and its reservation. Read-only on either team App; the run is a runner job.
   */
  | { accountId: string; role: string; repoId: string; purpose: "deploy_verify"; capUsd: number }
  /**
   * D#845 ON-10b1 (Ruling 88): the project survey (`role` is project-surveyor), on the machine the repo is placed on (`runnerId`). It borrows VERIFY_LIMITS_ROLE's limits and model and runs on its
   * own platform card. Only a `runner_local` repo gets one. What the account's model budget must be depends on how Claude is signed in on that machine (`runnerSignInKind`, owner ruling 88.0):
   * a subscription costs nothing metered (`capUsd: 0`, any budget), an API key meets the normal budget gate, and a sign-in the cloud cannot tell is treated as an API key.
   */
  | { accountId: string; role: string; repoId: string; runnerId: string; purpose: "survey" };

/** The manifest role a verifier run takes its limits and model from (TL ruling 1, 10-22). Customer role settings are unchanged. */
export const VERIFY_LIMITS_ROLE = "project-manager";

export type SeatRefusal =
  | "unknown_role"
  | "no_card"
  | "no_repo"
  | "no_installation"
  | "installation_not_writable"
  | "no_model"
  | "model_budget_unset"
  /** D#845 ON-10b1: the survey seat's own refusals. */
  | "survey_not_placed"
  | "survey_needs_runner"
  | "survey_sign_in_unknown"
  | "limits_exceed_sandbox"
  | "account_not_found";

export type SeatRunConfig = Omit<StartAgentRunInput, "accountId" | "role" | "workItemId" | "prompt" | "idempotency">;
export type SeatResult = { ok: true; seat: SeatRunConfig & { limits: RunLimitsInput; timeoutMs: number; maxExtensions: number } } | { ok: false; reason: SeatRefusal };

// D#483 S5-p: the run-time chain (limits -> longest run -> compute price) lives in @fx/runner so the pipeline estimate prices from the same code.
export { RUN_TIME_CEILING_MS, boundedLimit, runnerLimitsFrom, sandboxTimeFor };
/** The one place a manifest tier becomes a model id (C55 s4) is `TIER_TO_MODEL_ID` in @fx/spend; re-exported here for this package's callers. */
export { TIER_TO_MODEL_ID };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZE_OF_KIND: Readonly<Record<string, Size>> = { small: "Small", feature: "Feature", critical: "Critical" };
const refuse = (reason: SeatRefusal): SeatResult => ({ ok: false, reason });

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
    const { accountId } = request;
    const repoScoped = "purpose" in request;
    const preview = repoScoped && request.purpose === "preview";
    // A verify seat and an analyse seat are one shape: a confined read-only platform run on a borrowed role. Each is bound to its own role name.
    const verify = repoScoped && (request.purpose === "verify" || request.purpose === "analyse" || request.purpose === "deploy_verify");
    if (verify && request.role !== (request.purpose === "verify" ? PROPOSAL_VERIFIER_ROLE : request.purpose === "analyse" ? DISCOVERY_ANALYST_ROLE : DEPLOY_VERIFIER_ROLE)) return refuse("unknown_role");
    const survey = repoScoped && request.purpose === "survey";
    if (survey && request.role !== SURVEY_ROLE) return refuse("unknown_role");
    // A verifier or survey run is billed, limited and routed as the role it borrows; only its card and its run row are its own.
    const borrowed = verify || survey;
    const role = borrowed ? VERIFY_LIMITS_ROLE : request.role;
    const entry = getRoleEntry(role);
    if (entry === undefined) return refuse("unknown_role");
    // D#483 S4-b2c: the verifier's one card on either runtime (it names no path and no tool beyond "the file tools you are given"); whether a run may
    // go to a runner at all is the sweep's decision (cloud-verified repositories only) and the runner target's (a Local-only one refuses the role).
    const loadCard = borrowed ? (_r: string, _o?: { runtime: CardRuntime }) => loadPlatformCard(request.role) : (deps.loadCard ?? loadProductCard);
    // A role with no card is refused before anything is read. The card for the run's runtime is picked once the repository is read.
    if (loadCard(role) === undefined) return refuse("no_card");
    if (typeof accountId !== "string" || !UUID_RE.test(accountId)) return refuse("account_not_found");
    const ownerId = repoScoped ? request.repoId : request.workItemId;
    if (typeof ownerId !== "string" || !UUID_RE.test(ownerId)) return refuse("no_repo");
    if (survey && !(typeof request.runnerId === "string" && UUID_RE.test(request.runnerId))) return refuse("survey_not_placed");

    return withTenant(deps.pool, accountId, async (client): Promise<SeatResult> => {
      const account = (await client.query<{ plan: PlanId; budget: string; hosted_plan_paid: boolean }>("SELECT plan, hosted_plan_paid, model_budget_usd_month AS budget FROM accounts WHERE id = $1", [accountId])).rows[0];
      if (account === undefined) return refuse("account_not_found");

      let repoId = ownerId;
      let kind: string | null = null;
      let hasEnvelope = false;
      if (!repoScoped) {
        const item = (await client.query<{ repo_id: string | null; kind: string | null; envelope_id: string | null }>("SELECT repo_id, kind, envelope_id FROM work_items WHERE id = $1 AND account_id = $2", [ownerId, accountId])).rows[0];
        if (item?.repo_id == null) return refuse("no_repo");
        repoId = item.repo_id;
        kind = item.kind;
        hasEnvelope = item.envelope_id !== null;
      }
      const repo = (
        await client.query<{ product: Product; app_kind: string | null; execution_mode: string }>(
          // D#599 PL-2: the mode a work item's run goes to is its placement's, else the repository's (a preview has no item).
          `SELECT r.product, ${effectiveModeSql("w", "r")} AS execution_mode, i.app_kind FROM repos r
             LEFT JOIN work_items w ON w.account_id = r.account_id AND w.id = $3::uuid AND w.repo_id = r.id
             LEFT JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
            WHERE r.id = $1 AND r.account_id = $2`,
          [repoId, accountId, repoScoped ? null : ownerId],
        )
      ).rows[0];
      if (repo === undefined) return refuse("no_repo");
      // The card follows the mode the caller built its prompt for; a preview has no work-item prompt, so it follows the repository.
      const cardMode = "expectedExecutionMode" in request && request.expectedExecutionMode !== undefined ? request.expectedExecutionMode : repo.execution_mode;
      const roleCard = runsInOurSandbox(cardMode, role) ? loadCard(role) : loadCard(role, { runtime: "runner" });
      if (roleCard === undefined) return refuse("no_card");
      // D#845 ON-10b1 (Ruling 88 item 1, door 1 of 4): a survey runs on the person's own machine and nowhere else, so any other mode is no seat.
      if (survey && repo.execution_mode !== "runner_local") return refuse("survey_needs_runner");
      if (repo.app_kind === null) return refuse("no_installation");
      if (preview) {
        // A preview reads a repo through the read-only App and never writes: any other kind is not a preview seat.
        if (repo.app_kind !== "team_readonly") return refuse("no_installation");
      } else if (verify || survey) {
        // A verifier only reads (its GitHub role holds contents: read); either team App will do, and nothing else. The survey's mirror reads through the same App.
        if (repo.app_kind !== "team_readonly" && repo.app_kind !== "team") return refuse("no_installation");
      } else {
        try {
          assertWriteInstallation(repo.app_kind);
        } catch (err) {
          if (err instanceof InstallationNotWritableError) return refuse("installation_not_writable");
          throw err;
        }
      }

      const monthlyModelBudgetUsd = Number(account.budget);
      // D#845 ON-10b1 (Ruling 88): the machine the survey is for must be this repo's placement and live; its sign-in kind is read in this same transaction, from the stored row only.
      let signIn: RunnerSignInKind = "unknown";
      if (survey) {
        const placed = (
          await client.query<{ kind: RunnerSignInKind }>(
            `SELECT ${RUNNER_SIGN_IN_KIND_SQL("rn")} AS kind FROM project_placements pp
               JOIN runners rn ON rn.account_id = pp.account_id AND rn.id = pp.runner_id AND rn.revoked_at IS NULL
              WHERE pp.account_id = $1 AND pp.repo_id = $2 AND pp.runner_id = $3 AND rn.account_id = $1`,
            [accountId, repoId, request.runnerId],
          )
        ).rows[0];
        if (placed === undefined) return refuse("survey_not_placed");
        signIn = placed.kind;
      }
      // A subscription survey costs the account nothing metered, so no budget is needed for it (88.0).
      const freeSurvey = survey && signIn === "subscription";
      // An operator account runs on our own subscription, which no account budget pays for: it needs none set.
      if (!freeSurvey && !(monthlyModelBudgetUsd > 0) && !(deps.isOperatorAccount?.(accountId) ?? false)) return refuse(survey && signIn === "unknown" ? "survey_sign_in_unknown" : "model_budget_unset");

      const resolved = runnerLimitsFrom(await resolveRunLimits(client, { accountId, role }));
      // A preview (and a verifier, read the same way) must end by its own limit inside the invocation that reads its stream, and takes no extension.
      const limits = survey ? { ...resolved.limits, maxRunMs: SURVEY_MAX_RUN_MS } : repoScoped ? { ...resolved.limits, maxRunMs: Math.min(resolved.limits.maxRunMs, PREVIEW_MAX_RUN_MS) } : resolved.limits;
      const maxExtensions = repoScoped ? 0 : resolved.maxExtensions;
      const capUsd = preview ? PREVIEW_MODEL_CAP_USD : verify ? request.capUsd : freeSurvey ? 0 : resolved.perRunUsd;
      if (verify && !(capUsd > 0)) return refuse("model_budget_unset");
      const { maxPossibleRunMs, timeoutMs } = sandboxTimeFor(limits, maxExtensions);
      // A survey uses no sandbox of ours, so it has no compute to estimate or to cap.
      const estimateComputeUsd = survey ? 0 : sandboxComputeUsdFor(maxPossibleRunMs);
      if (!survey && (timeoutMs > (deps.maxTimeoutMs ?? SANDBOX_MAX_TIMEOUT_MS) || (repoScoped && estimateComputeUsd > PREVIEW_COMPUTE_CAP_USD))) return refuse("limits_exceed_sandbox");

      const size = repoScoped ? "Small" : kind === null ? undefined : SIZE_OF_KIND[kind];
      const model = await modelFor(client, deps, { accountId, repoId, role, tier: entry.defaultModel, size });
      if (model === undefined) return refuse("no_model");

      const workItemKind = kind === "small" ? "small" : kind === "feature" ? "feature" : undefined;
      // D#483 S5-d: a run that reserves no model money (an operator subscription run) still counts against its item's spend envelope, at this estimated price.
      const envelopeFloorUsd = hasEnvelope ? await estimateRunModelUsd(client, { accountId, repoId, role }) : undefined;
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
            ...(!repoScoped && { workItemId: ownerId }),
            ...(workItemKind !== undefined && { workItemKind }),
            purpose: preview ? "preview" : "run",
            trigger: "foreground",
            estimateModelUsd: capUsd,
            estimateComputeUsd,
            // D#845 ON-22a (ruling 42): the plan the spend is sized on is the entry tier unless the account carries a paid hosted plan item (reserve() refuses hosted spend without it anyway).
            plan: effectivePlan(account, "starter" as PlanId),
            monthlyModelBudgetUsd,
            perSpawnCapUsd: capUsd,
            ...(envelopeFloorUsd !== undefined && { envelopeFloorUsd }),
          },
        },
      };
    });
  };
}
