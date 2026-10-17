import { z } from "zod";
import { firstRunReservationUsd } from "@fx/pipeline/estimate";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { UUID_RE } from "@fx/core/src/plan/index.js";
import {
  AUTOSTART_OFF_SENTENCE,
  EnvelopeSettingError,
  EnvelopeWriteError,
  changeAutostart,
  changeEnvelope,
  changeMargin,
  effectiveMargin,
  readAutostart,
  type AutostartState,
  type EffectiveMargin,
} from "@fx/spend";
import type { RouteEntry } from "../registry.js";
import { ApiError, EnvelopeBelowFirstRunError, OverAccountBudgetError } from "../errors.js";
import { amountField } from "./proposal-envelopes.js";

/**
 * D#483 S5-e2: editing an envelope, the weekly auto-start envelope, and the default margin.
 *
 *   PUT /envelopes/{id}                  a new version of an item or batch envelope (never an UPDATE of the old one)
 *   GET/PUT /account/autostart-envelope  the weekly auto-start envelope; a person confirms it; 0 or null turns auto-start off
 *   GET/PUT /account/envelope-margin     the default margin the pre-fill adds to an estimate (an append-only history)
 *
 * Who: a read is any member (session or a read token). Every write is an owner or admin on a SESSION: a plain member is 403 and a token is
 * `session_required`, whatever scopes it holds. The tables' own policies check the owner-or-admin rule again (42501 is answered 403). A refused write
 * leaves nothing behind: the version row and its audit row share one transaction. All the logic is `@fx/spend`'s envelopeSettings.
 */

const MAX_MARGIN_PCT = 500;
const WEEKLY_NOTE = "The weekly auto-start limit renews every Monday at 00:00 UTC. What is not spent does not carry over.";

const envelopeIdParams = z.object({ id: z.string() });
const putEnvelopeBody = z.object({ amount_usd: amountField }).strict();
/** `null` removes the weekly envelope (turns auto-start off) and 0 does the same; a positive amount needs `confirm: true`. */
const putAutostartBody = z.object({ amount_usd: z.number().finite().min(0).max(99_999_999).nullable(), confirm: z.boolean().optional() }).strict();
const putMarginBody = z.object({ margin_pct: z.number().finite().min(0).max(MAX_MARGIN_PCT) }).strict();

const envelopeChangeSchema = z.object({
  envelope_id: z.string().uuid(),
  scope: z.enum(["item", "batch"]),
  version: z.number().int(),
  amount_usd: z.number(),
  /** The amount and version the new one replaced. */
  from_amount_usd: z.number(),
  from_version: z.number().int(),
});

const autostartSchema = z.object({
  envelope_id: z.string().uuid().nullable(),
  version: z.number().int().nullable(),
  /** The weekly amount in force; 0 while auto-start is off. */
  amount_usd: z.number(),
  enabled: z.boolean(),
  week_starts_at: z.string(),
  renews_at: z.string(),
  spent_this_week_usd: z.number(),
  remaining_this_week_usd: z.number(),
  /** The sentence shown while auto-start is off; null while it is on. */
  off_sentence: z.string().nullable(),
  note: z.string(),
});
const autostartChangeSchema = autostartSchema.extend({ changed: z.boolean() });

const marginSchema = z.object({
  /** In percent. Null when the account has no setting and the plan data carries none: the pre-fill is then the bare estimate. */
  margin_pct: z.number().nullable(),
  source: z.enum(["setting", "plan_data", "none"]),
  /** The plan data's default, the value to write to go back to it. Null when it carries none. */
  plan_default_pct: z.number().nullable(),
  version: z.number().int().nullable(),
  history_count: z.number().int(),
});
const marginChangeSchema = marginSchema.extend({ changed: z.boolean() });

const autostartView = (s: AutostartState) => ({
  envelope_id: s.envelopeId,
  version: s.version,
  amount_usd: s.amountUsd,
  enabled: s.enabled,
  week_starts_at: s.weekStartsAt.toISOString(),
  renews_at: s.renewsAt.toISOString(),
  spent_this_week_usd: s.spentThisWeekUsd,
  remaining_this_week_usd: s.remainingThisWeekUsd,
  off_sentence: s.enabled ? null : AUTOSTART_OFF_SENTENCE,
  note: WEEKLY_NOTE,
});
const marginView = (m: EffectiveMargin) => ({ margin_pct: m.marginPct, source: m.source, plan_default_pct: m.planDefaultPct, version: m.version, history_count: m.historyCount });

/** Maps the settings module's and the writer's refusals to the API's. Anything else is rethrown as it is. */
function mapError(error: unknown): unknown {
  if (error instanceof EnvelopeSettingError) {
    if (error.code === "setting_changed") return new ApiError(409, "setting_changed", "the setting changed while you saved; reload and try again");
    if (error.code === "envelope_scope") return new ApiError(409, "envelope_scope", "that envelope is changed with the weekly auto-start limit, not here");
    return new NotFoundError("envelope not found");
  }
  if (error instanceof EnvelopeWriteError) {
    if (error.code === "over_account_budget") return new OverAccountBudgetError();
    if (error.code === "envelope_below_first_run") return new EnvelopeBelowFirstRunError();
    if (error.code === "version_conflict") return new ApiError(409, "setting_changed", "the setting changed while you saved; reload and try again");
    if (error.code === "envelope_not_found") return new NotFoundError("envelope not found");
    return new ApiError(422, "invalid_input", "amount_usd must be a valid amount", [{ path: "amount_usd", code: error.code }]);
  }
  // 42501: the tables' own owner-or-admin policy (the route's minRole already checked the role).
  if ((error as { code?: string } | null)?.code === "42501") return new ForbiddenError("only an owner or admin can change envelope settings");
  return error;
}

const hasAtMostTwoDecimals = (n: number): boolean => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

const WRITE_409 = {
  "409": "`setting_changed` (another change took the same version first), `over_account_budget` or `envelope_below_first_run` (envelope amounts), `envelope_scope` (the weekly envelope is not edited here), or the account is not active.",
};

export const envelopeSettingRoutes: RouteEntry[] = [
  {
    method: "PUT",
    path: "/api/v1/envelopes/{id}",
    operationId: "putEnvelope",
    summary: "Change an item or batch envelope's limit: a new version, with one audit row naming both amounts",
    description:
      "Writes the next version of the envelope; the earlier versions stay as they were and no row is ever updated. The new amount may not be below what the item's first step reserves (409 `envelope_below_first_run`) " +
      "or above what the account can still spend this month (409 `over_account_budget`). Lowering below what is already spent pauses the item at its next run boundary; nothing running is stopped. " +
      "The weekly auto-start envelope is changed through its own route (409 `envelope_scope`). Owner or admin, session only: a plain member is 403 and a token `session_required`.",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { ...WRITE_409, "404": "Error `not_found`: no such envelope in this account." },
    paramsSchema: envelopeIdParams,
    bodySchema: putEnvelopeBody,
    responseSchema: envelopeChangeSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) throw new NotFoundError("envelope not found");
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof putEnvelopeBody>;
      try {
        const out = await withTenant(ctx.pool, accountId, userId, (client) =>
          changeEnvelope(client, { accountId, envelopeId: id.toLowerCase(), amountUsd: body.amount_usd, firstRunUsd: (repoId) => firstRunReservationUsd(client, { accountId, repoId }) }),
        );
        return { envelope_id: out.envelopeId, scope: out.scope as "item" | "batch", version: out.version, amount_usd: out.amountUsd, from_amount_usd: out.fromAmountUsd, from_version: out.fromVersion };
      } catch (error) {
        throw mapError(error);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/account/autostart-envelope",
    operationId: "getAutostartEnvelope",
    summary: "The weekly auto-start envelope: the amount, this week's spend, and when it renews",
    description: "Renews every Monday 00:00 UTC; what is not spent does not carry over. While it is off (never set, 0, or removed) `enabled` is false and `off_sentence` says how to turn it on. Any member, session or read token.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: autostartSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => autostartView(await readAutostart(client, accountId)));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/account/autostart-envelope",
    operationId: "putAutostartEnvelope",
    summary: "Set, change or turn off the weekly auto-start envelope. A person confirms it",
    description:
      "A positive `amount_usd` needs `confirm: true` (400 `confirmation_required` without it): nothing auto-starts until a person has confirmed the weekly limit. " +
      "`amount_usd` of 0, or null, turns auto-start off (a new version of 0) and needs no confirmation; the same amount again writes nothing. One new version and one audit row per real change. " +
      "An amount above what the account can still spend this month is refused 409 `over_account_budget`. Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: {
      ...WRITE_409,
      "400": "Error `confirmation_required`: a positive amount was sent without `confirm: true`.",
    },
    bodySchema: putAutostartBody,
    responseSchema: autostartChangeSchema,
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof putAutostartBody>;
      const amountUsd = body.amount_usd ?? 0;
      if (amountUsd > 0 && body.confirm !== true) {
        throw new ApiError(400, "confirmation_required", "Confirm the weekly auto-start limit to turn auto-start on");
      }
      try {
        const out = await withTenant(ctx.pool, accountId, userId, (client) => changeAutostart(client, { accountId, amountUsd }));
        return { ...autostartView(out.state), changed: out.written };
      } catch (error) {
        throw mapError(error);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/account/envelope-margin",
    operationId: "getEnvelopeMargin",
    summary: "The default margin an approval's envelope pre-fill adds to the estimate",
    description:
      "The account's own setting when it has one (`source: setting`), else the plan data's default (`plan_data`), else none: the pre-fill is then the bare estimate (`source: none`). " +
      "`plan_default_pct` is the value to write to go back to the default. Any member, session or read token.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: marginSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => marginView(await effectiveMargin(client, accountId)));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/account/envelope-margin",
    operationId: "putEnvelopeMargin",
    summary: "Set the default envelope margin: one new version and one audit row per real change",
    description:
      "`margin_pct` is a percent from 0 to 500 with at most two decimals. The same value as the current setting writes nothing. There is no delete: write the earlier value (or `plan_default_pct`) to go back. " +
      "Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: WRITE_409,
    bodySchema: putMarginBody,
    responseSchema: marginChangeSchema,
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof putMarginBody>;
      if (!hasAtMostTwoDecimals(body.margin_pct)) {
        throw new ApiError(422, "invalid_input", "margin_pct has at most two decimals", [{ path: "margin_pct", code: "too_many_decimals" }]);
      }
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          const out = await changeMargin(client, { accountId, userId, marginPct: body.margin_pct });
          return { ...marginView(await effectiveMargin(client, accountId)), changed: out.written };
        });
      } catch (error) {
        throw mapError(error);
      }
    },
  },
];
