import { describe, expect, it, vi } from 'vitest';
import { checkNoPaymentLinks, type PaymentLinksStripe } from '../../src/sitekit/paymentLinks.js';

type Page<T> = { data: T[]; has_more: boolean };
/** links: pages of link ids; items: link id -> pages of price ids. */
function fakeLinks(links: string[][], items: Record<string, string[][]> = {}) {
  const list = vi.fn(async (p: { starting_after?: string }) => {
    const index = p.starting_after ? links.findIndex((page) => page.includes(p.starting_after!)) + 1 : 0;
    return { data: (links[index] ?? []).map((id) => ({ id })), has_more: index < links.length - 1 } as Page<{ id: string }>;
  });
  const listLineItems = vi.fn(async (id: string, p: { starting_after?: string }) => {
    const pages = items[id] ?? [[]];
    const index = p.starting_after ? pages.findIndex((page) => page.includes(p.starting_after!)) + 1 : 0;
    return { data: (pages[index] ?? []).map((price) => ({ id: price, price: { id: price } })), has_more: index < pages.length - 1 };
  });
  return { stripe: { paymentLinks: { list, listLineItems } } as unknown as PaymentLinksStripe, list, listLineItems };
}

describe('checkNoPaymentLinks (D#3 K09a, go-live check)', () => {
  it('passes when there is no Payment Link', async () => {
    expect(await checkNoPaymentLinks(fakeLinks([[]]).stripe, ['price_sync'])).toEqual({ ok: true });
  });

  it('passes when links sell only other prices', async () => {
    const { stripe } = fakeLinks([['plink_1']], { plink_1: [['price_other']] });
    expect(await checkNoPaymentLinks(stripe, ['price_sync', 'price_setup'])).toEqual({ ok: true });
  });

  it('fails naming a link that sells the sync price', async () => {
    const { stripe } = fakeLinks([['plink_1', 'plink_2']], { plink_1: [['price_other']], plink_2: [['price_sync']] });
    expect(await checkNoPaymentLinks(stripe, ['price_sync', 'price_setup'])).toEqual({ ok: false, linkIds: ['plink_2'] });
  });

  it('checks both pages of links', async () => {
    const f = fakeLinks([['plink_1'], ['plink_2']], { plink_1: [['price_setup']], plink_2: [['price_sync']] });
    expect(await checkNoPaymentLinks(f.stripe, ['price_sync', 'price_setup'])).toEqual({ ok: false, linkIds: ['plink_1', 'plink_2'] });
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.list.mock.calls[1]![0]).toMatchObject({ starting_after: 'plink_1' });
  });

  it('checks a second page of line items on one link', async () => {
    const { stripe } = fakeLinks([['plink_1']], { plink_1: [['price_a'], ['price_sync']] });
    expect(await checkNoPaymentLinks(stripe, ['price_sync'])).toEqual({ ok: false, linkIds: ['plink_1'] });
  });
});
