import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { invoiceSubscriptionIdOf, subscriptionIdOf } from '../src/subscriptionSync.js';
import { rawInvoicePaid, rawInvoicePaymentFailed, type InvoiceShape } from './helpers/stripeFixtures.js';

const event = (raw: string): Stripe.Event => JSON.parse(raw) as Stripe.Event;

describe('invoice subscription id across API versions', () => {
  it.each<[InvoiceShape]>([['acacia'], ['dahlia'], ['dahlia-expanded']])('reads the id from an invoice.paid and an invoice.payment_failed in the %s shape', (shape) => {
    for (const make of [rawInvoicePaid, rawInvoicePaymentFailed]) {
      expect(subscriptionIdOf(event(make({ eventId: 'evt_1', stripeCustomerId: 'cus_1', subscriptionId: 'sub_1', shape })))).toBe('sub_1');
    }
  });

  it('answers null when the invoice has no subscription, in either shape', () => {
    for (const shape of ['acacia', 'dahlia'] as const) {
      expect(subscriptionIdOf(event(rawInvoicePaid({ eventId: 'evt_1', stripeCustomerId: 'cus_1', subscriptionId: null, shape })))).toBeNull();
    }
    expect(invoiceSubscriptionIdOf({})).toBeNull();
    expect(invoiceSubscriptionIdOf(null)).toBeNull();
    expect(invoiceSubscriptionIdOf({ parent: { type: 'quote_details', subscription_details: null } })).toBeNull();
  });

  it('prefers the dahlia place and falls back to the old field, an expanded object included', () => {
    expect(invoiceSubscriptionIdOf({ subscription: 'sub_old', parent: { subscription_details: { subscription: 'sub_new' } } })).toBe('sub_new');
    expect(invoiceSubscriptionIdOf({ subscription: { id: 'sub_old' }, parent: { subscription_details: { subscription: null } } })).toBe('sub_old');
    expect(invoiceSubscriptionIdOf({ parent: { subscription_details: { subscription: '' } }, subscription: 'sub_old' })).toBe('sub_old');
  });

  it('keeps the other event types as they were', () => {
    expect(subscriptionIdOf({ type: 'customer.subscription.updated', data: { object: { id: 'sub_9' } } } as Stripe.Event)).toBe('sub_9');
    expect(subscriptionIdOf({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', subscription: 'sub_8' } } } as Stripe.Event)).toBe('sub_8');
  });
});
