import { z } from "zod";
import type { PoolClient } from "pg";
import { estimateItem, firstRunReservationUsd, type ItemEstimate } from "@fx/pipeline/estimate";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { approveProposalBatch, StartUnavailableError, UUID_RE, type PlanEnvelope, type ProposalToApprove } from "@fx/core/src/plan/index.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { EnvelopeWriteError, effectiveMargin, remainingAccountBudgetUsd, setWorkItemEnvelope, writeEnvelopeVersion } from "@fx/spend";
import type { RouteEntry } from "../registry.js";
import { AmountRequiredError, ApiError, EnvelopeBelowFirstRunError, OverAccountBudgetError, RunActionsUnavailableError } from "../errors.js";
import { UNAVAILABLE_TEXT } from "./run-actions.js";
import { proposalCtx, proposalSchema, refuse, startFiler } from "./proposal-shared.js";

/**
 * D#483 S5-e1: the envelope a person's approval gives the work it starts, and the two routes around it.
 *
 *   GET  /repos/{id}/proposals/estimate?ids=      the priced estimate of the proposals, the margin, the account's remaining budget and the pre-fill
 *   POST /repos/{id}/proposals/approve-batch      approves a set under ONE `batch` envelope (Idempotency-Key)
 *   POST /proposals/{id}/approve                  (proposals.ts) now also creates the item's own `item` envelope
 *
 * Every price is `estimateItem` (S5-p), the only place one is computed; `proposals.estimate_usd` is never used (it runs 3 to 4 times low).
 * The pre-fill is `total_usd x (1 + margin)`, capped at what the account can still spend this month. The margin is the account's own setting (S5-e2),
 * else the plan data's `envelope.defaultMarginPct`; with neither the pre-fill is the bare estimate.
 *
 * A proposal that cannot be priced (`basis: "none"`: a question, or no category) has no pre-fill. The approve then needs an explicit `amount_usd`
 * and answers 400 `amount_required` without it, before anything is written; so does a batch holding one.
 *
 * A limit below the first run's reservation could never start the item, so it is refused 409 `envelope_below_first_run`; one above what the account can
 * still spend is refused 409 `over_account_budget`. Both refuse before any write, and a refused set approves none of its proposals.
 */

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const floor4 = (n: number): number => Math.floor(n * 1e4 + 1e-9) / 1e4;
/** The most numeric(12,4) can hold; an input bound only, never a product cap. */
const MAX_AMOUNT_USD = 99_999_999;

export const amountField = z.number().finite().positive().max(MAX_AMOUNT_USD);

export const envelopeSchema = z.object({
  envelope_id: z.string().uuid(),
  scope: z.enum(["item", "batch"]),
  version: z.number().int(),
  amount_usd: z.number(),
  estimate_usd: z.number().nullable(),
  margin_pct: z.number().nullable(),
});

export interface PricedProposal {
  proposal_id: string;
  estimate: ItemEstimate;
}

export interface PricedSet {
  items: PricedProposal[];
  /** Sum of the estimates; meaningful only while `needsAmount` is false. */
  totalUsd: number;
  /** At least one proposal has `basis: "none"`: there is no pre-fill and the caller must give an amount. */
  needsAmount: boolean;
  /** The account's own margin setting, else the plan data's, or null (the pre-fill is then the bare estimate). */
  marginPct: number | null;
  remainingUsd: number;
  firstRunUsd: number;
}

/** Prices a set of proposals of one repo. Must run inside a `withTenant` transaction for `accountId`. */
export async function priceProposals(client: PoolClient, input: { accountId: string; repoId: string; proposals: ProposalToApprove[] }): Promise<PricedSet> {
  const { accountId, repoId } = input;
  const items: PricedProposal[] = [];
  for (const p of input.proposals) {
    const estimate = await estimateItem(client, { accountId, repoId, category: p.category_hint, title: p.title, ...(p.summary ? { summary: p.summary } : {}) });
    items.push({ proposal_id: p.id, estimate });
  }
  const needsAmount = items.some((i) => i.estimate.basis === "none");
  return {
    items,
    totalUsd: round4(items.reduce((sum, i) => sum + (i.estimate.basis === "none" ? 0 : i.estimate.total_usd), 0)),
    needsAmount,
    marginPct: (await effectiveMargin(client, accountId)).marginPct,
    remainingUsd: await remainingAccountBudgetUsd(client, accountId),
    firstRunUsd: await firstRunReservationUsd(client, { accountId, repoId }),
  };
}

/** `total x (1 + margin)`, capped at what the account can still spend. With no margin it is the bare estimate. */
export function prefill(totalUsd: number, marginPct: number | null, remainingUsd: number): { amountUsd: number; capped: boolean } {
  const want = round4(totalUsd * (1 + (marginPct ?? 0) / 100));
  const cap = floor4(Math.max(0, remainingUsd));
  return want > cap ? { amountUsd: cap, capped: true } : { amountUsd: want, capped: false };
}

/** The writer's named refusals as the API's answers. */
export function mapEnvelopeError(err: unknown): unknown {
  if (err instanceof EnvelopeWriteError) {
    if (err.code === "over_account_budget") return new OverAccountBudgetError();
    if (err.code === "envelope_below_first_run") return new EnvelopeBelowFirstRunError();
    if (err.code === "invalid_amount") return new ApiError(422, "invalid_input", "amount_usd must be a positive number", [{ path: "amount_usd", code: err.code }]);
  }
  return err;
}

/**
 * The planner the approve routes hand to core: prices the set, decides the amount (the caller's, else the pre-fill), writes version 1 of the envelope, and
 * returns what attaches it to each new work item. Runs before any proposal is approved, so a refusal leaves nothing behind.
 */
export function planEnvelope(input: { accountId: string; scope: "item" | "batch"; amountUsd?: number | undefined }): PlanEnvelope {
  return async (client, proposals) => {
    // Core guarantees one repository for the set: a single approve has one proposal, a batch refuses any other repo's before this runs.
    const repoId = proposals[0]!.repo_id;
    const priced = await priceProposals(client, { accountId: input.accountId, repoId, proposals });
    let amountUsd: number;
    let marginPct: number | null = null;
    if (input.amountUsd !== undefined) amountUsd = input.amountUsd;
    else if (priced.needsAmount) throw new AmountRequiredError(input.scope);
    else {
      amountUsd = prefill(priced.totalUsd, priced.marginPct, priced.remainingUsd).amountUsd;
      marginPct = priced.marginPct;
    }
    const estimateUsd = priced.needsAmount ? null : priced.totalUsd;
    const { envelopeId, version } = await writeEnvelopeVersion(client, {
      accountId: input.accountId,
      scope: input.scope,
      repoId,
      amountUsd,
      estimateUsd,
      marginPct,
      minAmountUsd: priced.firstRunUsd,
    }).catch((err: unknown) => {
      throw mapEnvelopeError(err);
    });
    const attachment = { envelope_id: envelopeId, scope: input.scope, version, amount_usd: amountUsd, estimate_usd: estimateUsd, margin_pct: marginPct };
    return async (c, workItemId) => {
      await setWorkItemEnvelope(c, workItemId, envelopeId);
      return attachment;
    };
  };
}

const MAX_BATCH = 50;
const repoParams = z.object({ id: z.string() });
const estimateQuery = z.object({ ids: z.string().min(1) });
const batchBody = z.object({ proposal_ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH), amount_usd: amountField.optional() }).strict();

const estimateItemSchema = z.object({
  proposal_id: z.string().uuid(),
  /** `history` or `seed` when priced, `none` when it cannot be (a question, or no category). */
  basis: z.enum(["history", "seed", "none"]),
  /** Set with `basis: "none"`. */
  reason: z.string().nullable(),
  total_usd: z.number().nullable(),
  slot_phase_usd: z.number().nullable(),
  /** The model part is priced at the API rate for a repo on a runner subscription, and labelled "estimated" wherever it is shown. */
  estimated: z.boolean(),
});
const estimateResponse = z.object({
  repo_id: z.string().uuid(),
  proposals: z.array(estimateItemSchema),
  /** Sum of the estimates, or null while any proposal has none. */
  total_usd: z.number().nullable(),
  /** The default margin in percent, or null when none is configured (the pre-fill is then the bare estimate). */
  margin_pct: z.number().nullable(),
  /** The pre-fill: total x (1 + margin), capped at the remaining budget. Null while any proposal has none. */
  prefill_usd: z.number().nullable(),
  /** The pre-fill was cut down to the remaining budget. */
  capped: z.boolean(),
  /** At least one proposal cannot be priced, so an approve of this set needs an explicit `amount_usd`. */
  needs_amount: z.boolean(),
  remaining_budget_usd: z.number(),
  /** The smallest limit that could start the item: below it a write is refused `envelope_below_first_run`. */
  first_run_usd: z.number(),
});

const batchResponse = z.object({
  envelope: envelopeSchema,
  items: z.array(z.object({ proposal: proposalSchema, work_item_id: z.string().uuid(), started: z.boolean(), not_started_reason: z.enum(["no_write_install", "owned_by_internal_loop"]).nullable() })),
});

export const proposalEnvelopeRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/proposals/estimate",
    operationId: "estimateProposals",
    summary: "The priced estimate of some proposals, with the margin, the remaining budget and the envelope pre-fill",
    description:
      "`ids` is a comma-separated list of up to 50 proposal ids of this repository. Each is priced for the whole pipeline it will go through (`basis` is `history` or `seed`), or has `basis: none` when it cannot be priced (a question, or no category). " +
      "`prefill_usd` is the sum times (1 + `margin_pct`), capped at `remaining_budget_usd`; it is null while any proposal has no estimate, and `needs_amount` is then true. With no margin configured the pre-fill is the bare estimate. " +
      "`first_run_usd` is the smallest limit that could start the item. Reads only; any member, session or read token.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoParams,
    querySchema: estimateQuery,
    responseSchema: estimateResponse,
    extraResponses: { "400": "Error `invalid_input`: `ids` is empty, has more than 50 ids, repeats one or holds something that is not an id.", "404": "Error `not_found`: the repository or one of the proposals is not in this account." },
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const ids = (input.query as z.infer<typeof estimateQuery>).ids.split(",");
      if (ids.length > MAX_BATCH || new Set(ids).size !== ids.length || !ids.every((i) => UUID_RE.test(i))) {
        throw new ApiError(400, "invalid_input", "ids must be 1 to 50 distinct proposal ids", [{ path: "ids", code: "invalid_ids" }]);
      }
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        const { rows } = await client.query<ProposalToApprove>(
          "SELECT id, repo_id, title, summary, category_hint FROM proposals WHERE repo_id = $1::uuid AND id = ANY($2::uuid[])",
          [repoId, ids],
        );
        if (rows.length !== ids.length) throw new NotFoundError("proposal not found");
        const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
        const priced = await priceProposals(client, { accountId, repoId, proposals: ids.map((id) => byId.get(id.toLowerCase())!) });
        const pf = priced.needsAmount ? null : prefill(priced.totalUsd, priced.marginPct, priced.remainingUsd);
        return {
          repo_id: repoId,
          proposals: priced.items.map((i) => ({
            proposal_id: i.proposal_id,
            basis: i.estimate.basis,
            reason: i.estimate.reason,
            total_usd: i.estimate.basis === "none" ? null : round4(i.estimate.total_usd),
            slot_phase_usd: i.estimate.basis === "none" ? null : round4(i.estimate.slot_phase_usd),
            estimated: i.estimate.modelPartEstimated,
          })),
          total_usd: priced.needsAmount ? null : priced.totalUsd,
          margin_pct: priced.marginPct,
          prefill_usd: pf?.amountUsd ?? null,
          capped: pf?.capped ?? false,
          needs_amount: priced.needsAmount,
          remaining_budget_usd: round4(priced.remainingUsd),
          first_run_usd: priced.firstRunUsd,
        };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/repos/{id}/proposals/approve-batch",
    operationId: "approveProposalBatch",
    summary: "Approve a set of proposals under one batch envelope",
    description:
      "Session only, owner or admin; a token is refused. `Idempotency-Key` is required: a replay with the same key answers the same envelope and work items and creates nothing. " +
      "Every proposal must be `new` and product-owned, and belong to this repository; one that is not refuses the whole set (409) and nothing is written. " +
      "The set shares ONE `batch` envelope of `amount_usd`, or, when it is omitted, of the pre-fill (the sum of the estimates times (1 + margin), capped at the remaining budget). " +
      "A set holding a proposal that cannot be priced needs an explicit `amount_usd` (400 `amount_required`). A limit below the first run's reservation is refused 409 `envelope_below_first_run`, and one above the remaining budget 409 `over_account_budget`. " +
      "Each work item is created and its start requested exactly as a single approve does it. If a start cannot be requested (no worker is registered) nothing is written and the answer is 503.",
    // principals omitted -> session-only: an API token can never approve.
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: repoParams,
    bodySchema: batchBody,
    responseSchema: batchResponse,
    extraResponses: {
      "400": "Error `amount_required`: a proposal in the set cannot be priced and no `amount_usd` was given.",
      "404": "Error `not_found`: the repository or one of the proposals is not in this account.",
      "409": "Error `not_new`, `owned_by_internal_loop`, `work_started`, `envelope_below_first_run` or `over_account_budget`.",
      "503": UNAVAILABLE_TEXT + " Nothing was written.",
    },
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof batchBody>;
      if (new Set(body.proposal_ids).size !== body.proposal_ids.length) {
        throw new ApiError(400, "invalid_input", "proposal_ids must be distinct", [{ path: "proposal_ids", code: "duplicate_ids" }]);
      }
      const plan = planEnvelope({ accountId: ctx.principal.accountId, scope: "batch", amountUsd: body.amount_usd });
      const out = await approveProposalBatch(proposalCtx(ctx), repoId, body.proposal_ids, startFiler(ctx, { perItemKey: true }), plan).catch((err: unknown) => {
        if (err instanceof StartUnavailableError) throw new RunActionsUnavailableError();
        return refuse(err);
      });
      return {
        envelope: out.items[0]!.envelope!,
        items: out.items.map((i) => ({ proposal: i.proposal, work_item_id: i.work_item_id, started: i.started, not_started_reason: i.not_started_reason })),
      };
    },
  },
];
