import { z } from "zod";
import { cancelSitekitSync, createSitekitCheckout, listSites, readSitekitBilling, type SitekitProduct } from "@fx/billing";
import { ApiError } from "../errors.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import { billingLinkDeps } from "./billing.js";

const idParams = z.object({ id: z.string().uuid() });
const checkoutBodySchema = z.object({ success_path: z.string(), cancel_path: z.string() }).strict();

/** `{ url }` and nothing else: never a Stripe session, customer, subscription, payment intent or price id. */
export const checkoutResponseSchema = z.object({ url: z.string().url() });
export const siteBillingResponseSchema = z.object({
  setup: z.object({ paid: z.boolean(), paid_at: z.string().nullable() }),
  sync: z.object({ status: z.string().nullable(), current_period_end: z.string().nullable(), cancel_at_period_end: z.boolean() }),
  prices_provisional: z.boolean(),
  expected_spend: z.array(z.string()),
});
/** One site as listed: exactly these keys. Never a Vercel project, a sha, a hosting target or any Stripe id. */
export const siteListItemSchema = z.object({
  id: z.string().uuid(),
  domain: z.string().nullable(),
  status: z.string(),
  repo_full_name: z.string().nullable(),
  created_at: z.string(),
  billing: z.object({
    setup_paid: z.boolean(),
    sync_status: z.string().nullable(),
    sync_current_period_end: z.string().nullable(),
    sync_cancel_at_period_end: z.boolean(),
  }),
});
const listSitesResponseSchema = z.object({ data: z.array(siteListItemSchema), next_cursor: z.string().nullable() });
const listSitesQuerySchema = z.object({ limit: z.string().optional(), cursor: z.string().optional() });
const SITES_MAX_LIMIT = 100;

const cancelResponseSchema = z.object({ cancel_at_period_end: z.literal(true) });

/** Every message is fixed text: nothing from Stripe or the caller is forwarded. */
function sitekitError(reason: string): ApiError {
  switch (reason) {
    case "account_not_found":
    case "site_not_found":
      return new ApiError(404, "not_found", "not found");
    case "setup_already_paid":
      return new ApiError(409, "setup_already_paid", "the setup payment for this site is already paid");
    case "sync_already_active":
      return new ApiError(409, "sync_already_active", "this site already has a sync subscription");
    case "checkout_in_progress":
      return new ApiError(409, "checkout_in_progress", "A checkout for this site is already in progress. Try again in a moment.");
    case "sync_not_active":
      return new ApiError(409, "sync_not_active", "this site has no sync subscription to stop");
    case "sitekit_prices_provisional":
      return new ApiError(409, "sitekit_prices_provisional", "site kit prices are not final, so live checkout is closed");
    case "invalid_return_url":
      return new ApiError(422, "invalid_return_url", "a return path was not accepted");
    case "price_not_configured":
      return new ApiError(503, "billing_not_configured", "billing is not configured");
    default:
      return new ApiError(502, "internal_error", "the billing provider is unavailable");
  }
}

function billingCtx(ctx: RouteContext) {
  return {
    pool: billingLinkDeps.getPlatformOpsPool(),
    principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId },
  };
}

function siteId(input: { params: Record<string, string | undefined> }): string {
  const id = input.params.id;
  if (id === undefined) throw new ApiError(422, "validation_failed", "site id is required", [{ path: "id", code: "required" }]);
  return id;
}

const writeRoute: Pick<RouteEntry, "method" | "minRole" | "idempotency" | "rateClass" | "paramsSchema"> = {
  method: "POST",
  // principals omitted -> session-only: a token never opens a billing link.
  minRole: "admin",
  idempotency: "never",
  rateClass: "write",
  paramsSchema: idParams,
};

const checkoutErrors = {
  "404": "`not_found`: the site is not one of this account's.",
  "409": "`setup_already_paid` or `sync_already_active`, `checkout_in_progress` (another checkout for this site and product is being set up; try again shortly), or `sitekit_prices_provisional` while site kit prices are provisional and the Stripe key is live.",
  "422": "`invalid_return_url` (a path that is not a plain absolute path on this app).",
  "502": "`internal_error`: the billing provider could not be reached. No detail is returned.",
  "503": "`billing_not_configured`: Stripe or the site kit prices are not set up on this deployment.",
};

function checkoutRoute(product: SitekitProduct, path: string, operationId: string, summary: string): RouteEntry {
  return {
    ...writeRoute,
    path,
    operationId,
    summary,
    sessionLimit: SESSION_LIMITS.stripe,
    description: "Session only, owner or admin. Returns only the checkout `url`. `success_path` and `cancel_path` are plain absolute paths on this app.",
    extraResponses: checkoutErrors,
    bodySchema: checkoutBodySchema,
    responseSchema: checkoutResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof checkoutBodySchema>;
      const result = await createSitekitCheckout(billingCtx(ctx), {
        product,
        siteId: siteId(input),
        successPath: body.success_path,
        cancelPath: body.cancel_path,
        stripe: billingLinkDeps.getStripe(),
        appPool: ctx.pool,
      });
      if (!result.ok) throw sitekitError(result.reason);
      return { url: result.url };
    },
  };
}

/**
 * D#3 K09b: a site's setup payment and sync subscription. Sessions are created
 * only by these routes (never a Payment Link); the signed webhook alone records
 * what was paid. The read is open to members; the writes are owner or admin, session only.
 */
export const sitekitBillingRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/sites",
    operationId: "listSites",
    summary: "The account's sites, newest first, each with its site-kit billing state",
    description:
      "Session only. `limit` is 1 to 100 (default 50); `cursor` is the `next_cursor` of the previous page. `repo_full_name` is `owner/name`, or null when the site has no repo or the repo's name is not recorded.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema: listSitesQuerySchema,
    responseSchema: listSitesResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listSitesQuerySchema>;
      const limit = parseLimit(query.limit);
      if (limit > SITES_MAX_LIMIT) {
        throw new ApiError(422, "validation_failed", `limit must be an integer between 1 and ${SITES_MAX_LIMIT}, got: ${query.limit}`, [
          { path: "limit", code: "too_big" },
        ]);
      }
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const result = await listSites(ctx.pool, ctx.principal, { limit, cursor: cursor ? { createdAt: cursor.created_at, id: cursor.id } : undefined });
      return { data: result.data, next_cursor: result.nextCursor ? encodeCursor(result.nextCursor.createdAt, result.nextCursor.id) : null };
    },
  },
  {
    method: "GET",
    path: "/api/v1/sites/{id}/billing",
    operationId: "getSiteBilling",
    summary: "What a site has paid for: the setup payment, the sync subscription and the expected model spend",
    description:
      "Session only. `expected_spend` is fixed text shown before purchase: estimates for the customer's own model bill. `prices_provisional` is true until the final prices are set.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    responseSchema: siteBillingResponseSchema,
    extraResponses: { "404": "`not_found`: the site is not one of this account's." },
    async handler(ctx, input) {
      const result = await readSitekitBilling(ctx.pool, ctx.principal, siteId(input));
      if (!result.ok) throw sitekitError(result.reason);
      return result.billing;
    },
  },
  checkoutRoute("setup", "/api/v1/sites/{id}/billing/setup-checkout", "createSiteSetupCheckout", "A Stripe Checkout link for the site's one-time setup payment"),
  checkoutRoute("sync", "/api/v1/sites/{id}/billing/sync-checkout", "createSiteSyncCheckout", "A Stripe Checkout link for the site's monthly sync subscription"),
  {
    ...writeRoute,
    path: "/api/v1/sites/{id}/billing/sync-cancel",
    sessionLimit: SESSION_LIMITS.stripe,
    operationId: "cancelSiteSync",
    summary: "Stop the site's sync subscription at the end of the paid period",
    description: "Session only, owner or admin. The change is recorded when Stripe confirms it; published sites are not touched.",
    successStatus: 202,
    extraResponses: { ...checkoutErrors, "409": "`sync_not_active`: the site has no live sync subscription." },
    responseSchema: cancelResponseSchema,
    async handler(ctx, input) {
      const result = await cancelSitekitSync(billingCtx(ctx), { siteId: siteId(input), stripe: billingLinkDeps.getStripe(), appPool: ctx.pool });
      if (!result.ok) throw sitekitError(result.reason);
      return { cancel_at_period_end: true };
    },
  },
];
