import { z } from "zod";
import type { Pool } from "pg";
import { pauseAccount, resumeAccount, setSharePublicFigures, type LifecycleResult } from "@fx/billing";
import { withTenant } from "@fx/db/src/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { NotPausableError, NotPausedError, PaymentNotSettledError } from "../errors.js";
import { platformOpsPool } from "../sse/pools.js";
import { onboardingDeps } from "./onboarding.js";

/** Test seam for the platform_ops pool the billing writes run on. */
export const accountDeps: { getPlatformOpsPool: () => Pool } = { getPlatformOpsPool: platformOpsPool };

export const accountStatusResponseSchema = z.object({ status: z.string() });

async function readStatus(ctx: RouteContext): Promise<string> {
  const { accountId, userId } = ctx.principal;
  const row = await withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [accountId]);
    return rows[0];
  });
  if (!row) throw new NotFoundError(`account ${accountId} not found`);
  return row.status;
}

/** Runs a billing lifecycle write as the session's own user on the caller's own account, then maps its refusals. */
async function lifecycle(
  ctx: RouteContext,
  write: typeof pauseAccount,
  illegal: () => Promise<Error>,
): Promise<{ status: string }> {
  const { accountId, userId } = ctx.principal;
  const result: LifecycleResult = await write({ pool: accountDeps.getPlatformOpsPool(), principal: { accountId, userId } }, { accountId });
  if (!result.ok) {
    if (result.reason === "illegal_transition") throw await illegal();
    throw new NotFoundError(`account ${accountId} not found`);
  }
  return { status: await readStatus(ctx) };
}

/** "The v1 contract" endpoints table: `GET /api/v1/account | S+T(read), member`. API-7 adds fields later -- additive only. */
export const accountResponseSchema = z.object({
  id: z.string().uuid(),
  plan: z.string(),
  status: z.string(),
  /** True when a reseller (partner) owns the account's billing. */
  partner_billed: z.boolean(),
  /** D#31 API-7d: whether the account opts in to sharing its public figures. */
  share_public_figures: z.boolean(),
  /** True when the Stripe subscription is set to end at the close of the paid period. False when there is none. */
  cancel_at_period_end: z.boolean(),
  /** The end of the paid period (ISO 8601), or null when no subscription has been synced. */
  current_period_end: z.string().nullable(),
  /** Which model path the account's runs use: our operator subscription, or the account's own model key. Names no setting or value. */
  model_source: z.enum(["operator_subscription", "own_key"]),
});

export const accountSettingsResponseSchema = z.object({ share_public_figures: z.boolean() });
const patchAccountSettingsBodySchema = z.object({ share_public_figures: z.boolean() }).strict();

export const accountRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/account",
    operationId: "getAccount",
    summary: "The caller's own account",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: accountResponseSchema,
    async handler(ctx) {
      const row = await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
        const { rows } = await client.query<{
          id: string;
          plan: string;
          status: string;
          partner_billed: boolean;
          share_public_figures: boolean;
          cancel_at_period_end: boolean;
          current_period_end: Date | null;
        }>(
          `SELECT id, plan, status, (partner_id IS NOT NULL) AS partner_billed, share_public_figures,
                  stripe_cancel_at_period_end AS cancel_at_period_end, stripe_current_period_end AS current_period_end
             FROM accounts WHERE id = $1`,
          [ctx.principal.accountId],
        );
        return rows[0] ?? null;
      });
      if (!row) {
        throw new NotFoundError(`account ${ctx.principal.accountId} not found`);
      }
      return {
        ...row,
        current_period_end: row.current_period_end ? row.current_period_end.toISOString() : null,
        model_source: onboardingDeps.isOperatorAccount?.(row.id) === true ? ("operator_subscription" as const) : ("own_key" as const),
      };
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/account/settings",
    operationId: "updateAccountSettings",
    summary: "Set account settings (owner or admin, session only)",
    description:
      "Body `{ share_public_figures }`. Each accepted request writes one audit row, even when the value is unchanged.",
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    bodySchema: patchAccountSettingsBodySchema,
    responseSchema: accountSettingsResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof patchAccountSettingsBodySchema>;
      const { accountId, userId } = ctx.principal;
      const result = await setSharePublicFigures(
        { pool: accountDeps.getPlatformOpsPool(), principal: { accountId, userId } },
        { accountId, value: body.share_public_figures },
      );
      if (!result.ok) throw new NotFoundError(`account ${accountId} not found`);
      return { share_public_figures: result.after };
    },
  },
  {
    method: "POST",
    path: "/api/v1/account/pause",
    operationId: "pauseAccount",
    summary: "Pause the account (owner or admin, session only)",
    description: "Pausing an already-paused account succeeds and writes nothing. 409 `not_pausable` when the status has no pause transition.",
    extraResponses: { "409": "Error `not_pausable`: the account cannot be paused from its current status." },
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    responseSchema: accountStatusResponseSchema,
    handler: (ctx) => lifecycle(ctx, pauseAccount, async () => new NotPausableError()),
  },
  {
    method: "POST",
    path: "/api/v1/account/resume",
    operationId: "resumeAccount",
    summary: "Resume a paused account (owner or admin, session only)",
    description:
      "Returns the status the account derives once the pause is cleared, which is `past_due` when a payment failure is still open. 409 `not_paused` when the account is not paused, or `payment_not_settled` when it is past due and not paused.",
    extraResponses: { "409": "Error `not_paused` or `payment_not_settled`." },
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    responseSchema: accountStatusResponseSchema,
    handler: (ctx) =>
      lifecycle(ctx, resumeAccount, async () =>
        (await readStatus(ctx)) === "past_due" ? new PaymentNotSettledError() : new NotPausedError(),
      ),
  },
];
