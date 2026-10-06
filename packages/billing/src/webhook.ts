import { reportError } from '@fx/telemetry';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import type { StripeLike } from './stripeClient.js';
import type { PriceMap } from './priceMap.js';
import { syncSubscriptionEvent } from './subscriptionSync.js';
import { handleSitekitEvent } from './sitekit/webhook.js';
import type { SitekitPriceMap } from './sitekit/priceMap.js';

export interface StripeWebhookDeps {
  stripe: StripeLike;
  webhookSecret: string;
  platformOpsPool: Pool;
  /** D#69 B3: whether the configured Stripe key is live-mode (`stripeKeyIsLive`). An event of the other mode is refused. */
  livemode: boolean;
  /** Price id -> plan. Tests inject one; production builds it from `STRIPE_PRICE_ID_*` per event. */
  priceMap?: PriceMap;
  /** Price id -> site-kit product. Tests inject one; production builds it from `STRIPE_PRICE_ID_SITEKIT_*`. */
  sitekitPriceMap?: SitekitPriceMap;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The single entrypoint apps/web/app/api/stripe/webhook/handler.ts
 * delegates to. Everything -- signature verification, event dispatch,
 * idempotent replay, and the account write -- lives here so the route
 * layer stays a thin translation from NextRequest/NextResponse (H10
 * pass/fail 2, 3, 4).
 *
 * Order matters for pass/fail 2: signature verification happens BEFORE
 * any database access, so a bad/missing `Stripe-Signature` never touches
 * Postgres at all. D#69 hardening: an empty/unconfigured webhook secret
 * is refused before that too -- passing an empty string to the Stripe SDK
 * is a misconfiguration, not something a signature check should have to
 * fail safe against on its own.
 */
export async function handleStripeWebhookRequest(
  rawBody: string,
  signatureHeader: string | null,
  deps: StripeWebhookDeps,
): Promise<WebhookResponse> {
  if (!deps.webhookSecret) {
    return { status: 500, body: { error: 'webhook_secret_not_configured' } };
  }
  if (!signatureHeader) {
    return { status: 400, body: { error: 'missing_signature' } };
  }

  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(rawBody, signatureHeader, deps.webhookSecret) as Stripe.Event;
  } catch (err) {
    reportError(err, { stage: "billing.verify_signature", route: "/api/stripe/webhook" });
    // The SDK's thrown error can embed the raw payload/signature --
    // never forward it into the response or a log line (pass/fail 5).
    return { status: 400, body: { error: 'invalid_signature' } };
  }

  // D#3 K09a: a site-kit event is recorded by its own handler, which never writes `accounts`.
  const sitekit = await handleSitekitEvent(event, deps);
  if (sitekit) return sitekit;
  return syncSubscriptionEvent(event, deps);
}
