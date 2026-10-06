import type Stripe from 'stripe';

export type PaymentLinksStripe = { paymentLinks: Pick<Stripe.PaymentLinksResource, 'list' | 'listLineItems'> };

export type PaymentLinkCheck = { ok: true } | { ok: false; linkIds: string[] };

/**
 * The go-live check (no Payment Links): every Payment Link in the account,
 * across all pages, has its line items read; a link that sells any of
 * `priceIds` fails the check and is named. Site-kit money moves only through
 * server-created Checkout Sessions, which the webhook can tie to a site.
 */
export async function checkNoPaymentLinks(stripe: PaymentLinksStripe, priceIds: readonly string[]): Promise<PaymentLinkCheck> {
  const wanted = new Set(priceIds);
  const offending: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stripe.paymentLinks.list({ limit: 100, ...(after ? { starting_after: after } : {}) });
    for (const link of page.data) {
      if (await linkSells(stripe, link.id, wanted)) offending.push(link.id);
    }
    if (!page.has_more || page.data.length === 0) break;
    after = page.data[page.data.length - 1]!.id;
  }
  return offending.length === 0 ? { ok: true } : { ok: false, linkIds: offending };
}

async function linkSells(stripe: PaymentLinksStripe, linkId: string, wanted: ReadonlySet<string>): Promise<boolean> {
  let after: string | undefined;
  for (;;) {
    const items = await stripe.paymentLinks.listLineItems(linkId, { limit: 100, ...(after ? { starting_after: after } : {}) });
    if (items.data.some((item) => item.price?.id !== undefined && wanted.has(item.price.id))) return true;
    if (!items.has_more || items.data.length === 0) return false;
    after = items.data[items.data.length - 1]!.id;
  }
}
