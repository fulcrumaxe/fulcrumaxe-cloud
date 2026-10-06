import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { authorizeAccountWrite } from '../authorize.js';
import {
  appOriginFromEnv,
  sitekitBundleCouponFromEnv,
  stripeKeyIsLive,
  stripeSecretKeyFromEnv,
  stripeSitekitPriceIdFromEnv,
} from '../env.js';
import { withPlatformOps } from '../pg.js';
import { buildValidatedReturnUrl } from '../returnUrl.js';
import { STRIPE_UNAVAILABLE_RESULT, noRefundsCheckoutLine, termsUrlFromEnv, type StripeLike } from '../stripeClient.js';
import type { BillingCtx } from '../types.js';
import { SITEKIT_PLANS, SITEKIT_PRICES_PROVISIONAL, type SitekitProduct } from './plans.js';

/**
 * D#3 K09b: the site-kit billing services the routes call. A session is only
 * ever created here, on our server, for one site of the caller's own account;
 * its id is stored before the URL is returned, because the webhook finds the
 * site through that row (never through metadata). Nothing here writes `accounts`.
 *
 * `ctx.pool` is the platform_ops pool (as everywhere in @fx/billing); `appPool`
 * is the tenant (app_user) pool, used only to prove the site is the caller's.
 */
export type SitekitResult<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

export interface SitekitBase {
  siteId: string;
  appPool: Pool;
}

export interface SitekitCheckoutInput extends SitekitBase {
  product: SitekitProduct;
  successPath: string;
  cancelPath: string;
  stripe: StripeLike;
  /** Test seams; production leaves both to the module constant and the configured key. */
  provisional?: boolean;
  liveKey?: boolean;
  /** Test seam for the per-call Stripe timeout (default STRIPE_CALL_TIMEOUT_MS). */
  stripeTimeoutMs?: number;
}

/** The customer's own model bill, not ours: fixed text from the cost-analyst's estimates by analogy. */
export const SITEKIT_EXPECTED_SPEND: readonly string[] = Object.freeze([
  'Our charges are platform fees only. Model calls run on your own connected key and appear on your own bill.',
  'One generation and verify pass: about $90 on Opus 5 or about $36 on Sonnet 5 (up to about 2.5 times that at p90).',
  'One diff-scoped sync pass: about $15 to $20 on Opus 5 or about $6 to $8 on Sonnet 5.',
  'A full re-verify: about $55.',
  'These are estimates by analogy, not measurements.',
]);

async function siteVisible(input: SitekitBase, accountId: string, userId: string): Promise<boolean> {
  return withTenant(input.appPool, accountId, userId, async (client) => {
    const { rows } = await client.query('SELECT 1 FROM sites WHERE id = $1 AND account_id = $2', [input.siteId, accountId]);
    return rows.length > 0;
  });
}

/** A new session stays payable for an hour (Stripe's minimum is 30 minutes, its default 24 hours). */
const SESSION_LIFETIME_SECONDS = 3600;
/** Earlier sessions this far back are looked at: covers the 24-hour default of sessions made before the hour limit. */
const EARLIER_SESSION_WINDOW_HOURS = 25;
/** Sync subscriptions carry this in their metadata; the webhook only ever refuses on it (never credits or binds a site). */
export const SITEKIT_MARKER_KEY = 'fx_product';
export const SITEKIT_MARKER_VALUE = 'sitekit';

/**
 * Every Stripe call made while the lock and its connection are held gets this long, no more: the
 * SDK aborts the request and the call also fails on our own timer, whatever the client is. Ten
 * seconds is several times a normal Checkout call (well under a second) yet keeps a stalled Stripe
 * from holding a pool connection for long. A timeout is `stripe_unavailable` with no new session.
 */
export const STRIPE_CALL_TIMEOUT_MS = 10_000;

/** A second checkout for one product of one site while another is in flight: answered at once, nothing created. */
export const CHECKOUT_BUSY_RESULT = Object.freeze({ ok: false, reason: 'checkout_in_progress' } as const);

interface Entitlement {
  setup_paid_at: Date | null;
  sync_subscription_id: string | null;
  sync_ended_at: Date | null;
}

function withTimeout<T>(ms: number, call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('stripe_timeout')), ms);
  });
  return Promise.race([call(), limit]).finally(() => clearTimeout(timer));
}

/** Creates the Checkout Session for the site's setup payment or sync subscription. Owner or admin only. */
export async function createSitekitCheckout(ctx: BillingCtx, input: SitekitCheckoutInput): Promise<SitekitResult<{ url: string }>> {
  const { accountId, userId } = ctx.principal;
  const authFailure = await authorizeAccountWrite(ctx, accountId);
  if (authFailure) return authFailure;
  if (!(await siteVisible(input, accountId, userId))) return { ok: false, reason: 'site_not_found' };

  // While the prices are provisional, a live key never opens a session (the cost re-cut gates live mode).
  const provisional = input.provisional ?? SITEKIT_PRICES_PROVISIONAL;
  if (provisional && (input.liveKey ?? stripeKeyIsLive(stripeSecretKeyFromEnv()))) {
    return { ok: false, reason: 'sitekit_prices_provisional' };
  }

  // One transaction holds a per-(account, site, product) advisory lock across the whole look, expire,
  // create and insert sequence (Stripe calls included), so only one request at a time works on one
  // product of one site. The lock is never waited for: a second request is answered at once and its
  // connection released, so a burst of requests cannot pile up holding connections of the shared pool.
  return withPlatformOps(ctx.pool, async (client): Promise<SitekitResult<{ url: string }>> => {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [
      `sitekit_checkout:${accountId}:${input.siteId}:${input.product}`,
    ]);
    if (!lock.rows[0]?.ok) return CHECKOUT_BUSY_RESULT;
    const a = await client.query<{ stripe_customer_id: string | null; status: string }>(
      'SELECT stripe_customer_id, status FROM accounts WHERE id = $1 AND deleted_at IS NULL',
      [accountId],
    );
    const e = await client.query<Entitlement>(
      'SELECT setup_paid_at, sync_subscription_id, sync_ended_at FROM sitekit_entitlements WHERE site_id = $1 AND account_id = $2',
      [input.siteId, accountId],
    );
    const account = a.rows[0];
    const entitlement = e.rows[0];
    if (!account) return { ok: false, reason: 'account_not_found' };
    if (input.product === 'setup' && entitlement?.setup_paid_at) return { ok: false, reason: 'setup_already_paid' };
    // A subscription on file that has not ended (whatever its status) is one charge already.
    if (input.product === 'sync' && entitlement?.sync_subscription_id && !entitlement.sync_ended_at) {
      return { ok: false, reason: 'sync_already_active' };
    }

    const appOrigin = appOriginFromEnv();
    const successUrl = buildValidatedReturnUrl(input.successPath, appOrigin);
    const cancelUrl = buildValidatedReturnUrl(input.cancelPath, appOrigin);
    if (!successUrl || !cancelUrl) return { ok: false, reason: 'invalid_return_url' };

    let priceId: string;
    try {
      priceId = stripeSitekitPriceIdFromEnv(input.product);
    } catch {
      return { ok: false, reason: 'price_not_configured' };
    }

    const earlier = await closeEarlierSessions(client, accountId, input, entitlement);
    if (earlier) return earlier;

    const coupon = account.status === 'active' ? sitekitBundleCouponFromEnv() : null;
    const mode = SITEKIT_PLANS[input.product].checkoutMode;
    let session;
    try {
      const timeout = input.stripeTimeoutMs ?? STRIPE_CALL_TIMEOUT_MS;
      session = await withTimeout(timeout, () => input.stripe.checkout.sessions.create({
        mode,
        client_reference_id: accountId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        // An hour, so a session left behind stays payable only briefly (Stripe's minimum is 30 minutes).
        expires_at: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS,
        consent_collection: { terms_of_service: 'required' },
        custom_text: { terms_of_service_acceptance: { message: noRefundsCheckoutLine(termsUrlFromEnv()) } },
        // The account's own Stripe customer, when it has one. A customer Checkout creates is never written to `accounts`.
        ...(account.stripe_customer_id ? { customer: account.stripe_customer_id } : {}),
        ...(coupon ? { discounts: [{ coupon }] } : {}),
        // A fixed marker, no ids: the webhook only ever uses it to refuse a stray event (see webhook.ts).
        ...(mode === 'subscription' ? { subscription_data: { metadata: { [SITEKIT_MARKER_KEY]: SITEKIT_MARKER_VALUE } } } : {}),
      }, { timeout }));
    } catch {
      return STRIPE_UNAVAILABLE_RESULT;
    }
    if (!session.url || !session.id) return STRIPE_UNAVAILABLE_RESULT;

    // The row goes in before the URL goes out: the webhook can only credit a session it finds here.
    await client.query('INSERT INTO sitekit_checkout_sessions (session_id, account_id, site_id, product) VALUES ($1, $2, $3, $4)', [
      session.id,
      accountId,
      input.siteId,
      input.product,
    ]);
    return { ok: true, url: session.url };
  });
}

/**
 * The site's earlier sessions for this product (created within the window): a
 * completed one is a payment the webhook hasn't recorded yet, so refuse; open
 * ones are expired so only the new session can be paid. Any Stripe problem
 * leaves no new session.
 */
async function closeEarlierSessions(
  client: PoolClient,
  accountId: string,
  input: SitekitCheckoutInput,
  entitlement: Entitlement | undefined,
): Promise<{ ok: false; reason: string } | null> {
  const sessions = input.stripe.checkout.sessions;
  const timeout = input.stripeTimeoutMs ?? STRIPE_CALL_TIMEOUT_MS;
  if (!sessions.retrieve || !sessions.expire) return STRIPE_UNAVAILABLE_RESULT;
  const { rows } = await client.query<{ session_id: string }>(
    `SELECT session_id FROM sitekit_checkout_sessions
      WHERE account_id = $1 AND site_id = $2 AND product = $3 AND created_at > now() - make_interval(hours => $4::int)
      ORDER BY created_at`,
    [accountId, input.siteId, input.product, EARLIER_SESSION_WINDOW_HOURS],
  );
  try {
    const open: string[] = [];
    for (const row of rows) {
      const { status, subscription } = await withTimeout(timeout, () => sessions.retrieve!(row.session_id, {}, { timeout }));
      if (status === 'complete') {
        // A sync session whose subscription we have recorded as ended is history, not a live charge.
        const endedHere = input.product === 'sync' && !!entitlement?.sync_ended_at && !!entitlement.sync_subscription_id
          && entitlement.sync_subscription_id === (typeof subscription === 'string' ? subscription : subscription?.id);
        if (endedHere) continue;
        return { ok: false, reason: input.product === 'setup' ? 'setup_already_paid' : 'sync_already_active' };
      }
      if (status === 'open') open.push(row.session_id);
      else if (status !== 'expired') return STRIPE_UNAVAILABLE_RESULT; // a status this code doesn't know: fail closed
    }
    for (const id of open) await withTimeout(timeout, () => sessions.expire!(id, {}, { timeout }));
  } catch {
    return STRIPE_UNAVAILABLE_RESULT;
  }
  return null;
}

/** Stops the site's sync subscription at the end of the paid period; the webhook records it. Publishing is untouched. */
export async function cancelSitekitSync(ctx: BillingCtx, input: SitekitBase & { stripe: StripeLike }): Promise<SitekitResult> {
  const { accountId, userId } = ctx.principal;
  const authFailure = await authorizeAccountWrite(ctx, accountId);
  if (authFailure) return authFailure;
  if (!(await siteVisible(input, accountId, userId))) return { ok: false, reason: 'site_not_found' };

  const { rows } = await ctx.pool.query<{ sync_subscription_id: string }>(
    `SELECT sync_subscription_id FROM sitekit_entitlements
      WHERE site_id = $1 AND account_id = $2 AND sync_subscription_id IS NOT NULL AND sync_ended_at IS NULL`,
    [input.siteId, accountId],
  );
  if (!rows[0]) return { ok: false, reason: 'sync_not_active' };
  const subscriptions = input.stripe.subscriptions;
  if (!subscriptions.update) return STRIPE_UNAVAILABLE_RESULT;
  try {
    await subscriptions.update(rows[0].sync_subscription_id, { cancel_at_period_end: true });
  } catch {
    return STRIPE_UNAVAILABLE_RESULT;
  }
  return { ok: true };
}

export interface SitekitBillingView {
  setup: { paid: boolean; paid_at: string | null };
  sync: { status: string | null; current_period_end: string | null; cancel_at_period_end: boolean };
  prices_provisional: boolean;
  expected_spend: string[];
}

/**
 * What the panel shows, read through the tenant connection as the entitlement
 * reads are: a site the caller's account can't see is not found, and an account
 * whose row policy hides the entitlement reads as unpaid (fail closed).
 */
export async function readSitekitBilling(
  appPool: Pool,
  principal: BillingCtx['principal'],
  siteId: string,
): Promise<SitekitResult<{ billing: SitekitBillingView }>> {
  const { accountId, userId } = principal;
  return withTenant(appPool, accountId, userId, async (client) => {
    const site = await client.query('SELECT 1 FROM sites WHERE id = $1 AND account_id = $2', [siteId, accountId]);
    if (site.rows.length === 0) return { ok: false as const, reason: 'site_not_found' };
    const { rows } = await client.query<{
      setup_paid_at: Date | null;
      sync_status: string | null;
      sync_current_period_end: Date | null;
      sync_cancel_at_period_end: boolean;
    }>(
      `SELECT setup_paid_at, sync_status, sync_current_period_end, sync_cancel_at_period_end
         FROM sitekit_entitlements WHERE site_id = $1 AND account_id = $2`,
      [siteId, accountId],
    );
    const e = rows[0];
    return {
      ok: true as const,
      billing: {
        setup: { paid: !!e?.setup_paid_at, paid_at: e?.setup_paid_at?.toISOString() ?? null },
        sync: {
          status: e?.sync_status ?? null,
          current_period_end: e?.sync_current_period_end?.toISOString() ?? null,
          cancel_at_period_end: e?.sync_cancel_at_period_end ?? false,
        },
        prices_provisional: SITEKIT_PRICES_PROVISIONAL,
        expected_spend: [...SITEKIT_EXPECTED_SPEND],
      },
    };
  });
}
