import type { Pool } from "pg";
import { z } from "zod";
import { createCheckoutSession, defaultStripeClient, enginePlanOffered, getBillingPortalUrl, setAccountBudgets, setEngineQuantity, type StripeLike } from "@fx/billing";
import { enginePricePerMonthUsd, getBudgets, getUsage } from "@fx/spend";
import { countLiveEngines } from "@fx/core/src/onboarding/liveEngines.js";
import { ENGINE_BILLING_MAX, readEngineBilling } from "@fx/core/src/onboarding/engineBilling.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { ApiError } from "../errors.js";
import { platformOpsPool } from "../sse/pools.js";

/** D#31 API-7e: `{ url }` and nothing else -- never a Stripe session id, customer id or key. */
export const billingLinkResponseSchema = z.object({ url: z.string().url() });

const portalSessionBodySchema = z.object({ return_path: z.string().optional(), flow: z.enum(["change_plan"]).optional() }).strict();
const checkoutSessionBodySchema = z.object({ plan: z.string(), success_path: z.string(), cancel_path: z.string(), quantity: z.number().int().optional() }).strict();
const engineQuantityBodySchema = z.object({ quantity: z.number().int() }).strict();

/** Test seam: the Stripe client and the platform_ops pool the billing service runs on. */
export const billingLinkDeps: { getStripe: () => StripeLike; getPlatformOpsPool: () => Pool } = {
  getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new ApiError(503, "billing_not_configured", "billing is not configured");
    }
    return defaultStripeClient();
  },
  getPlatformOpsPool: platformOpsPool,
};

/**
 * Maps the billing service's closed `reason` list onto the API error table.
 * Every message is fixed text: nothing from Stripe (or the caller) is
 * forwarded, so no Stripe identifier can reach an error body.
 */
function billingLinkError(reason: string): ApiError {
  switch (reason) {
    case "no_stripe_customer":
      return new ApiError(409, "no_billing_account", "this account has no billing account yet");
    case "already_subscribed":
      return new ApiError(409, "already_subscribed", "this account already has this plan");
    case "no_subscription":
      return new ApiError(409, "no_subscription", "this account has no paying subscription yet; choose the Engine plan to start one");
    case "subscription_not_paying":
      return new ApiError(409, "subscription_not_paying", "the subscription is not being paid right now; settle the payment in the billing portal first");
    case "engine_quantity_in_use":
      return new ApiError(409, "engine_quantity_in_use", "more engines are running than that quantity; park or stop an engine first");
    case "payment_pending":
      return new ApiError(402, "payment_pending", "a change to this subscription is waiting for payment, or the provider could not collect it, so this change was not applied; update your payment method in the billing portal and try again once it settles");
    case "invalid_quantity":
      return new ApiError(422, "invalid_quantity", "the quantity must be a whole number from 1 to 100");
    case "invalid_return_url":
      return new ApiError(422, "invalid_return_url", "a return path was not accepted");
    case "invalid_plan":
      return new ApiError(422, "invalid_plan", "the plan is not available");
    case "account_not_found":
      return new ApiError(404, "not_found", "not found");
    default:
      // stripe_unavailable and anything unexpected: one body, no detail.
      return new ApiError(502, "internal_error", "the billing provider is unavailable");
  }
}

function billingCtx(ctx: RouteContext) {
  return {
    pool: billingLinkDeps.getPlatformOpsPool(),
    principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId },
  };
}

const linkRoute: Pick<RouteEntry, "method" | "minRole" | "idempotency" | "rateClass"> = {
  method: "POST",
  // principals omitted -> session-only: a token never opens a billing link.
  minRole: "owner",
  idempotency: "never",
  rateClass: "write",
};

const linkErrors = {
  "409": "`no_billing_account` (portal: the account has no Stripe customer yet), `already_subscribed` (checkout: the account already has this plan), `no_subscription`, `subscription_not_paying` (the stored standing is past due, unpaid, incomplete or paused, or its ids are missing) or `engine_quantity_in_use` (engine quantity).",
  "402": "`payment_pending` (engine quantity, an item added to the subscription, or a checkout: an earlier change is still waiting for payment, or the charge for this change was not collected, so nothing changed).",
  "422": "`invalid_return_url` (a path that is not a plain absolute path on this app), `invalid_plan` or `invalid_quantity`.",
  "502": "`internal_error`: the billing provider could not be reached. No detail is returned.",
  "503": "`billing_not_configured`: Stripe is not set up on this deployment.",
};

const budgetUsageSchema = z.object({
  spent_usd: z.number(),
  reserved_usd: z.number(),
  limit_usd: z.number(),
});

/** D#31 API-7a: the month so far per budget. `spent_usd` is settled only, `reserved_usd` is open reservations only. */
export const usageResponseSchema = z.object({
  period_start: z.string(),
  model: budgetUsageSchema,
  foreground_compute: budgetUsageSchema,
  background_compute: budgetUsageSchema,
  // D#6 R2b-5a: the API-equivalent of this month's runs on the person's own machine. Information; never part of any budget above.
  own_plan_api_equivalent_usd: z.number().describe("What this month's runs on the person's own machine would have cost at API prices. Information, never spend, and not part of any budget above. The same figure the stats endpoint calls runner_api_equivalent_usd (named differently there because the stats key guard refuses keys containing plan)."),
  engine_api_equivalent_usd: z.number().describe("What this month's usage of the person's own engine (the tokens it reported, priced by the cloud) would have cost at API prices. Information, never spend, and not part of any budget above."),
  // D#483 S5-k3: derived on every read, never stored; it pauses nothing.
  compute_notice: z
    .object({ code: z.enum(["compute_allowance_80"]), message: z.string() })
    .nullable()
    .describe("Set from 80% of a compute budget's cap until that budget reaches its cap, then null (the pause shows instead). A notice only: it never pauses work or denies a start. Computed from this month's usage on each read, so a higher cap or a new month removes it."),
});

/** `model_usd_month` of 0 means "not set" (the column default). */
export const budgetsResponseSchema = z.object({
  model_usd_month: z.number(),
  foreground_compute_usd_month: z.number(),
  background_compute_usd_month: z.number(),
  compute_cap_usd_month: z.number(),
  plan: z.string(),
});

/** The column is numeric(10, 2): a third decimal would be rounded silently, so refuse it instead. */
function isWholeCents(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

/**
 * D#31 API-7d: `model_usd_month` is the only settable budget (1.00 to 100000.00, at most 2 decimals).
 * Any other key is refused by the handler -- a `compute_*` key with `not_settable`, because compute
 * budgets are derived from the plan at Launch -- so unknown keys are let through parsing to be named there.
 */
const patchBudgetsBodySchema = z
  .object({
    model_usd_month: z
      .number()
      .min(1)
      .max(100000)
      .refine(isWholeCents, "model_usd_month takes at most 2 decimal places")
      // null clears the budget back to "not set" (stored as 0, the same as an account that never set one).
      .nullable()
      .optional(),
  })
  .catchall(z.unknown());

const readRoute: Pick<RouteEntry, "method" | "principals" | "minRole" | "scope" | "idempotency" | "rateClass"> = {
  method: "GET",
  principals: ["session", "token"],
  minRole: "member",
  scope: "read",
  idempotency: "never",
  rateClass: "read",
};

/** D#845 ON-22c: the Engine row of Budget & billing. One read of synced rows; the billing provider is never called. */
export const engineBillingResponseSchema = z.object({
  offered: z.boolean().describe("False when the plan data carries no Engine plan or no engine price is configured: the row is hidden."),
  price_usd_month: z.number().nullable().describe("The Engine plan's price per live engine a month, from the plan data; null when it is not offered."),
  paid_quantity: z.number().int().describe("Engines the subscription pays for, as last synced; 0 for an ended plan."),
  live_count: z.number().int().describe("Engines live now."),
  min_quantity: z.number().int().describe("The lowest total a change may ask for: the engines live now, and at least 1."),
  max_quantity: z.number().int(),
  state: z.enum(["none", "active", "past_due", "not_paying", "ended"]),
  ended_at: z.string().nullable().describe("When the subscription ended (the synced `subscription_ended_at`); null when it has not, or the grace period ran out first."),
  can_change: z.boolean().describe("True for the account owner on a session. The change routes stay owner-only whatever this says."),
  as_of: z.string().nullable().describe("When the subscription was last synced from the provider; null before the first sync."),
});

export const billingRoutes: RouteEntry[] = [
  {
    method: "GET",
    // principals omitted -> session-only: the owner flag belongs to a signed-in person.
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    path: "/api/v1/billing/engine",
    operationId: "getEngineBilling",
    summary: "The account's Engine plan: price, engines paid for and live, standing",
    description:
      "Session only, any member. Read from the account's synced billing rows and the engines live now: no billing-provider call is made. `state` is `none` (no engines paid for), `active`, `past_due` (inside the seven day grace), `not_paying` (unpaid, incomplete, paused, or its ids are missing) or `ended`. `min_quantity` is the engines live now (at least 1), `max_quantity` is 100. `can_change` is true for the owner. A change shows here once the provider confirms it.",
    responseSchema: engineBillingResponseSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      const view = await withTenant(ctx.pool, accountId, userId, (client) => readEngineBilling(client, accountId));
      if (!view) throw new ApiError(404, "not_found", "not found");
      const offered = enginePlanOffered();
      // The price is shown only when the plan is offered: a configured price with no engine price id would otherwise leak a number for a hidden row.
      const price = offered ? enginePricePerMonthUsd() : null;
      return {
        offered,
        price_usd_month: price,
        paid_quantity: view.paid_quantity,
        live_count: view.live_count,
        min_quantity: Math.max(view.live_count, 1),
        max_quantity: ENGINE_BILLING_MAX,
        state: view.state,
        ended_at: view.ended_at,
        can_change: ctx.principal.kind === "session" && ctx.principal.role === "owner",
        as_of: view.as_of,
      };
    },
  },
  {
    ...readRoute,
    path: "/api/v1/usage",
    operationId: "getUsage",
    summary: "This month's spend per budget",
    responseSchema: usageResponseSchema,
    handler: (ctx) => getUsage(ctx),
  },
  {
    ...readRoute,
    path: "/api/v1/budgets",
    operationId: "getBudgets",
    summary: "The account's monthly budgets",
    responseSchema: budgetsResponseSchema,
    handler: (ctx) => getBudgets(ctx),
  },
  {
    method: "PATCH",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    path: "/api/v1/budgets",
    operationId: "updateBudgets",
    summary: "Set or remove the monthly model budget (owner or admin, session only)",
    description:
      "Body `{ model_usd_month }`: 1.00 to 100000.00, at most 2 decimals, or `null` to remove the budget and return to \"not set\" (the `GET /budgets` value is then 0, exactly as for an account that never set one). Compute budgets are set by the plan and cannot be changed: any `compute_*` key is a 422 with `not_settable`. Each accepted request writes one audit row, even when the value is unchanged. Returns the budgets in the `GET /budgets` shape.",
    extraResponses: { "422": "`validation_failed` with `details` naming each bad key; a `compute_*` key has code `not_settable`." },
    bodySchema: patchBudgetsBodySchema,
    responseSchema: budgetsResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof patchBudgetsBodySchema>;
      const details: { path: string; code: string }[] = [];
      for (const key of Object.keys(body)) {
        if (key === "model_usd_month") continue;
        details.push({ path: key, code: key.startsWith("compute_") ? "not_settable" : "unrecognized_keys" });
      }
      if (body.model_usd_month === undefined) details.push({ path: "model_usd_month", code: "invalid_type" });
      if (details.length > 0) throw new ApiError(422, "validation_failed", "request failed validation", details);

      const result = await setAccountBudgets(billingCtx(ctx), {
        accountId: ctx.principal.accountId,
        modelUsdMonth: body.model_usd_month ?? 0,
      });
      if (!result.ok) throw billingLinkError(result.reason);
      return getBudgets(ctx);
    },
  },
  {
    ...linkRoute,
    path: "/api/v1/billing/portal-session",
    sessionLimit: SESSION_LIMITS.stripe,
    operationId: "createPortalSession",
    summary: "A Stripe billing-portal link for the account",
    description:
      "Session only, owner only. `return_path` is a plain absolute path on this app (default `/billing`), never a URL. `flow: \"change_plan\"` opens the portal on the plan-change screen for the account's own subscription (the ordinary portal when the account has none, or when the portal is not set up to allow plan changes). Returns only the portal `url`.",
    extraResponses: linkErrors,
    bodySchema: portalSessionBodySchema,
    responseSchema: billingLinkResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof portalSessionBodySchema>;
      const stripe = billingLinkDeps.getStripe();
      const result = await getBillingPortalUrl(billingCtx(ctx), {
        accountId: ctx.principal.accountId,
        returnUrl: body.return_path ?? "/billing",
        ...(body.flow === "change_plan" ? { flow: "subscription_update" as const } : {}),
        stripe,
      });
      if (!result.ok) throw billingLinkError(result.reason);
      return { url: result.url };
    },
  },
  {
    ...linkRoute,
    path: "/api/v1/billing/checkout-session",
    sessionLimit: SESSION_LIMITS.stripe,
    operationId: "createCheckoutSession",
    summary: "A Stripe Checkout link to subscribe to a plan",
    description:
      "Session only, owner only. Plans are sold only through Checkout Sessions this route creates; it never accepts or returns a Payment Link. `success_path` and `cancel_path` are plain absolute paths on this app. `plan` is a hosted plan or `engine` (with `quantity`, 1 to 100). An account that already has a paying subscription never gets a second one: the plan or the engines join it as an item and the answer is the success path. An engine checkout on a subscription that already holds engines sets the total to the larger of what it holds and `quantity`, and writes nothing when nothing is raised. Returns only the `url`.",
    extraResponses: linkErrors,
    bodySchema: checkoutSessionBodySchema,
    responseSchema: billingLinkResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof checkoutSessionBodySchema>;
      const stripe = billingLinkDeps.getStripe();
      const result = await createCheckoutSession(billingCtx(ctx), {
        accountId: ctx.principal.accountId,
        plan: body.plan,
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        successPath: body.success_path,
        cancelPath: body.cancel_path,
        stripe,
      });
      if (!result.ok) throw billingLinkError(result.reason);
      return { url: result.url };
    },
  },
  {
    ...linkRoute,
    path: "/api/v1/billing/engine-quantity",
    sessionLimit: SESSION_LIMITS.stripe,
    operationId: "setEngineQuantity",
    summary: "Set how many engines the subscription pays for",
    description:
      "Session only, owner only. `quantity` is the new total, 1 to 100. A total below the number of engines running now is refused with 409 `engine_quantity_in_use` (park or stop an engine first); an account with no paying subscription gets 409 `no_subscription` and buys its first engines through the checkout route with `plan: \"engine\"`. The change is billed by the provider's own proration and shows in the account once the provider confirms it.",
    extraResponses: linkErrors,
    bodySchema: engineQuantityBodySchema,
    responseSchema: z.object({ quantity: z.number().int() }),
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof engineQuantityBodySchema>;
      const stripe = billingLinkDeps.getStripe();
      const result = await setEngineQuantity(billingCtx(ctx), {
        accountId: ctx.principal.accountId,
        quantity: body.quantity,
        stripe,
        liveEngines: () => countLiveEngines({ pool: ctx.pool, principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId } }),
      });
      if (!result.ok) throw billingLinkError(result.reason);
      return { quantity: body.quantity };
    },
  },
];
