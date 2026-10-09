import type { Pool } from "pg";
import { z } from "zod";
import { createCheckoutSession, defaultStripeClient, getBillingPortalUrl, setAccountBudgets, type StripeLike } from "@fx/billing";
import { getBudgets, getUsage } from "@fx/spend";
import type { RouteContext, RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { ApiError } from "../errors.js";
import { platformOpsPool } from "../sse/pools.js";

/** D#31 API-7e: `{ url }` and nothing else -- never a Stripe session id, customer id or key. */
export const billingLinkResponseSchema = z.object({ url: z.string().url() });

const portalSessionBodySchema = z.object({ return_path: z.string().optional(), flow: z.enum(["change_plan"]).optional() }).strict();
const checkoutSessionBodySchema = z.object({ plan: z.string(), success_path: z.string(), cancel_path: z.string() }).strict();

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
      return new ApiError(409, "already_subscribed", "this account already has a subscription");
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
  "409": "`no_billing_account` (portal: the account has no Stripe customer yet) or `already_subscribed` (checkout).",
  "422": "`invalid_return_url` (a path that is not a plain absolute path on this app) or `invalid_plan`.",
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

export const billingRoutes: RouteEntry[] = [
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
    summary: "Set the monthly model budget (owner or admin, session only)",
    description:
      "Body `{ model_usd_month }`: 1.00 to 100000.00, at most 2 decimals. Compute budgets are set by the plan and cannot be changed: any `compute_*` key is a 422 with `not_settable`. Each accepted request writes one audit row, even when the value is unchanged. Returns the budgets in the `GET /budgets` shape.",
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
        modelUsdMonth: body.model_usd_month!,
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
      "Session only, owner only. Plans are sold only through Checkout Sessions this route creates; it never accepts or returns a Payment Link. `success_path` and `cancel_path` are plain absolute paths on this app. Returns only the checkout `url`.",
    extraResponses: linkErrors,
    bodySchema: checkoutSessionBodySchema,
    responseSchema: billingLinkResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof checkoutSessionBodySchema>;
      const stripe = billingLinkDeps.getStripe();
      const result = await createCheckoutSession(billingCtx(ctx), {
        accountId: ctx.principal.accountId,
        plan: body.plan,
        successPath: body.success_path,
        cancelPath: body.cancel_path,
        stripe,
      });
      if (!result.ok) throw billingLinkError(result.reason);
      return { url: result.url };
    },
  },
];
