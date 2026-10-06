import { vi } from 'vitest';
import Stripe from 'stripe';
import type { StripeLike } from '../../src/stripeClient.js';

/**
 * Stripe test-mode fixtures, no network: every event body below is exactly
 * what `stripe.webhooks.constructEvent` accepts once signed with
 * `generateTestHeaderString` (pure HMAC). D#69 B2: events are only a
 * trigger, so each carries a subscription id (default `sub_<customer>`)
 * that `fakeStripe().retrieve` resolves -- nothing here reaches the network.
 */
export const defaultSubscriptionId = (stripeCustomerId: string): string => `sub_${stripeCustomerId}`;

interface EventParams {
  eventId: string;
  livemode?: boolean;
}

function rawEvent(p: EventParams, type: string, object: Record<string, unknown>): string {
  return JSON.stringify({ id: p.eventId, object: 'event', type, livemode: p.livemode ?? false, data: { object } });
}

export function rawCheckoutSessionCompleted(
  p: EventParams & {
    accountId: string;
    stripeCustomerId: string;
    subscriptionId?: string | null;
    /** Deliberately untrusted: the sync must ignore `metadata.plan`. */
    plan?: string;
    paymentStatus?: string;
    consent?: 'accepted' | null;
  },
): string {
  return rawEvent(p, 'checkout.session.completed', {
    id: 'cs_test_1',
    object: 'checkout.session',
    client_reference_id: p.accountId,
    customer: p.stripeCustomerId,
    subscription: p.subscriptionId === undefined ? defaultSubscriptionId(p.stripeCustomerId) : p.subscriptionId,
    payment_status: p.paymentStatus ?? 'paid',
    metadata: p.plan ? { plan: p.plan } : {},
    ...(p.consent !== undefined ? { consent: { terms_of_service: p.consent } } : {}),
  });
}

type InvoiceParams = EventParams & { stripeCustomerId: string; subscriptionId?: string | null };
const rawInvoice = (type: string, p: InvoiceParams) =>
  rawEvent(p, type, {
    id: 'in_test_1',
    object: 'invoice',
    customer: p.stripeCustomerId,
    subscription: p.subscriptionId === undefined ? defaultSubscriptionId(p.stripeCustomerId) : p.subscriptionId,
  });
export const rawInvoicePaid = (p: InvoiceParams) => rawInvoice('invoice.paid', p);
export const rawInvoicePaymentFailed = (p: InvoiceParams) => rawInvoice('invoice.payment_failed', p);

export const rawSubscriptionEvent = (
  type: 'customer.subscription.updated' | 'customer.subscription.deleted',
  p: EventParams & { subscriptionId: string; stripeCustomerId: string },
) => rawEvent(p, type, { id: p.subscriptionId, object: 'subscription', customer: p.stripeCustomerId });

export interface FakeSubscriptionOptions {
  id: string;
  customer: string;
  status?: string;
  priceId?: string;
  itemCount?: number;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: number;
  livemode?: boolean;
}

/** The slice of a fetched `Stripe.Subscription` the sync reads. */
export function fakeSubscription(o: FakeSubscriptionOptions): Stripe.Subscription {
  const items = Array.from({ length: o.itemCount ?? 1 }, (_, i) => ({ id: `si_${i}`, price: { id: o.priceId ?? 'price_starter_test' } }));
  return {
    id: o.id,
    object: 'subscription',
    customer: o.customer,
    status: o.status ?? 'active',
    livemode: o.livemode ?? false,
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    current_period_end: o.currentPeriodEnd ?? 1_900_000_000,
    items: { object: 'list', data: items },
  } as unknown as Stripe.Subscription;
}

/**
 * A `StripeLike` with the REAL SDK's signature verification and a fake
 * `subscriptions.retrieve`. `set` registers what a subscription id fetches
 * to (or an Error to throw); an unregistered `sub_<cus>` fetches an active
 * Starter-priced subscription of `<cus>`.
 */
export function fakeStripe() {
  const real = new Stripe('sk_test_FAKE_TEST_ONLY_7e1b4c6a9f');
  const registered = new Map<string, Stripe.Subscription | Error>();
  const retrieve = vi.fn(async (id: string) => {
    const hit = registered.get(id);
    if (hit instanceof Error) throw hit;
    return hit ?? fakeSubscription({ id, customer: id.replace(/^sub_/, '') });
  });
  const stripe = {
    webhooks: real.webhooks,
    billingPortal: real.billingPortal,
    checkout: real.checkout,
    subscriptions: { retrieve, cancel: vi.fn() },
  } as unknown as StripeLike;
  return {
    stripe,
    retrieve,
    set(sub: FakeSubscriptionOptions | Error, id?: string) {
      if (sub instanceof Error) registered.set(id!, sub);
      else registered.set(sub.id, fakeSubscription(sub));
    },
  };
}

export function signTestPayload(payload: string, secret: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}
