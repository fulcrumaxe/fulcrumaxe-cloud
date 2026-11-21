/* eslint-disable @typescript-eslint/no-explicit-any -- raw JSON bodies of the fake, read field by field */
import https from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWorld, startStrictStripe, type FakeSubscription, type StrictStripe } from './helpers/strictStripe.js';

/**
 * The fake itself: each rule below is something the real Stripe refuses, and each test is the request a lenient fake
 * would have let through. Requests go through Node's real TLS path with the certificate as explicit `ca`.
 */
const VERSION = '2025-02-24.acacia';
const RK = 'rk_test_restricted_for_tests';
const SK = 'sk_test_secret_for_tests';

let server: StrictStripe;

beforeAll(async () => {
  const world = newWorld();
  world.customers.add('cus_a');
  for (let i = 0; i < 12; i += 1) {
    const sub: FakeSubscription = {
      id: `sub_${String(i).padStart(2, '0')}`,
      customer: 'cus_a',
      status: i === 0 ? 'canceled' : 'active',
      created: 1_700_000_000 + i,
      ended_at: i === 0 ? 1_700_000_500 : null,
      cancel_at_period_end: false,
      current_period_end: 1_900_000_000,
      livemode: false,
      priceId: 'price_x',
    };
    world.subscriptions.push(sub);
  }
  server = await startStrictStripe({ pinnedVersion: VERSION, keys: { [RK]: 'restricted', [SK]: 'secret' } }, world);
});
afterAll(async () => {
  await server.close();
});

function call(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: server.port, method, path, ca: server.ca, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const auth = (key: string, version: string | null = VERSION) => ({ authorization: `Bearer ${key}`, ...(version ? { 'stripe-version': version } : {}) });

describe('the strict Stripe fake refuses what Stripe refuses', () => {
  it('rejects a request with no key or an unknown key (401)', async () => {
    expect((await call('GET', '/v1/subscriptions?customer=cus_a')).status).toBe(401);
    expect((await call('GET', '/v1/subscriptions?customer=cus_a', auth('rk_test_unknown'))).status).toBe(401);
  });

  it('rejects a request without our pinned Stripe-Version, or with another one', async () => {
    expect((await call('GET', '/v1/subscriptions?customer=cus_a', auth(RK, null))).status).toBe(400);
    expect((await call('GET', '/v1/subscriptions?customer=cus_a', auth(RK, '2020-08-27'))).status).toBe(400);
  });

  it('rejects ANY write made with the restricted key, and reads outside customers and subscriptions', async () => {
    const write = await call('POST', '/v1/subscriptions/sub_01', { ...auth(RK), 'idempotency-key': 'k1', 'content-type': 'application/x-www-form-urlencoded' }, 'cancel_at_period_end=true');
    expect(write.status).toBe(403);
    expect((await call('DELETE', '/v1/subscriptions/sub_01', auth(RK))).status).toBe(403);
    expect((await call('GET', '/v1/charges', auth(RK))).status).toBe(403);
    expect(server.world.subscriptions.find((s) => s.id === 'sub_01')!.cancel_at_period_end).toBe(false);
  });

  it('rejects list parameters Stripe does not know, and a limit outside 1..100', async () => {
    const unknown = await call('GET', '/v1/subscriptions?customer=cus_a&repo=octo', auth(RK));
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.code).toBe('parameter_unknown');
    expect((await call('GET', '/v1/subscriptions?customer=cus_a&limit=0', auth(RK))).status).toBe(400);
    expect((await call('GET', '/v1/subscriptions?customer=cus_a&limit=101', auth(RK))).status).toBe(400);
    expect((await call('GET', '/v1/subscriptions?customer=cus_a&status=bogus', auth(RK))).status).toBe(400);
  });

  it('answers 404 resource_missing for a customer that does not exist', async () => {
    const res = await call('GET', '/v1/subscriptions?customer=cus_nope&status=all', auth(RK));
    expect(res.status).toBe(404);
    expect(res.json.error).toMatchObject({ code: 'resource_missing', type: 'invalid_request_error' });
  });

  it('lists newest first, ten at a time by default, excludes canceled unless status=all, and pages with has_more and starting_after', async () => {
    const first = await call('GET', '/v1/subscriptions?customer=cus_a', auth(RK));
    expect(first.json.object).toBe('list');
    expect(first.json.data).toHaveLength(10); // the default limit
    expect(first.json.has_more).toBe(true); // 11 active, so one remains
    expect(first.json.data.map((s: any) => s.id)[0]).toBe('sub_11'); // newest first
    expect(first.json.data.some((s: any) => s.status === 'canceled')).toBe(false); // canceled is hidden by default

    const rest = await call('GET', `/v1/subscriptions?customer=cus_a&starting_after=${first.json.data.at(-1).id}`, auth(RK));
    expect(rest.json.data.map((s: any) => s.id)).toEqual(['sub_01']);
    expect(rest.json.has_more).toBe(false);

    const all = await call('GET', '/v1/subscriptions?customer=cus_a&status=all&limit=100', auth(RK));
    expect(all.json.data).toHaveLength(12);
    expect(all.json.data.find((s: any) => s.id === 'sub_00').ended_at).toBe(1_700_000_500);

    expect((await call('GET', '/v1/subscriptions?customer=cus_a&starting_after=sub_nope', auth(RK))).status).toBe(404);
  });

  it('applies idempotency to a write: the same key replays, the same key with other parameters is an idempotency_error', async () => {
    const headers = { ...auth(SK), 'idempotency-key': 'idem-1', 'content-type': 'application/x-www-form-urlencoded' };
    const first = await call('POST', '/v1/subscriptions/sub_02', headers, 'cancel_at_period_end=true');
    expect(first.status).toBe(200);
    expect(first.json.cancel_at_period_end).toBe(true);
    const replay = await call('POST', '/v1/subscriptions/sub_02', headers, 'cancel_at_period_end=true');
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const clash = await call('POST', '/v1/subscriptions/sub_02', headers, 'cancel_at_period_end=false');
    expect(clash.status).toBe(400);
    expect(clash.json.error.type).toBe('idempotency_error');
    const noKey = await call('POST', '/v1/subscriptions/sub_02', { ...auth(SK), 'content-type': 'application/x-www-form-urlencoded' }, 'cancel_at_period_end=false');
    expect(noKey.status).toBe(400);
  });

  it('answers 429 rate_limit and 5xx on demand', async () => {
    server.world.failNext.push(429, 503);
    const limited = await call('GET', '/v1/subscriptions?customer=cus_a', auth(RK));
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('rate_limit');
    expect((await call('GET', '/v1/subscriptions?customer=cus_a', auth(RK))).status).toBe(503);
    expect((await call('GET', '/v1/subscriptions?customer=cus_a', auth(RK))).status).toBe(200);
  });
});

describe('D#845 ON-22a: subscription items (the contract the engine billing code is written against)', () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const w = (key: string, idem: string) => ({ ...auth(key), ...form, 'idempotency-key': idem });
  function seed(id: string, items: { id: string; priceId: string; quantity: number }[], status: FakeSubscription['status'] = 'active'): FakeSubscription {
    const sub: FakeSubscription = { id, customer: 'cus_a', status, created: 1_700_001_000, ended_at: null, cancel_at_period_end: false, current_period_end: 1_900_000_000, livemode: false, priceId: items[0]!.priceId, items };
    server.world.subscriptions.push(sub);
    return sub;
  }

  it('retrieves one subscription with its items and quantities; an unknown id is 404 resource_missing', async () => {
    seed('sub_it1', [{ id: 'si_a', priceId: 'p_plan', quantity: 1 }, { id: 'si_b', priceId: 'p_engine', quantity: 3 }]);
    const res = await call('GET', '/v1/subscriptions/sub_it1', auth(RK));
    expect(res.json.items.data.map((i: any) => [i.id, i.price.id, i.quantity])).toEqual([['si_a', 'p_plan', 1], ['si_b', 'p_engine', 3]]);
    expect((await call('GET', '/v1/subscriptions/sub_nope', auth(RK))).json.error.code).toBe('resource_missing');
  });

  it('updates an item quantity: secret key only, whole numbers 0 or more, a known proration, known parameters, an existing item, a live subscription', async () => {
    const sub = seed('sub_it2', [{ id: 'si_c', priceId: 'p_engine', quantity: 2 }]);
    expect((await call('POST', '/v1/subscription_items/si_c', w(RK, 'q0'), 'quantity=9')).status).toBe(403);
    for (const [body, code] of [['quantity=-1', 'parameter_invalid_integer'], ['quantity=1.5', 'parameter_invalid_integer'], ['quantity=two', 'parameter_invalid_integer'], ['quantity=1&proration_behavior=sometimes', 'parameter_invalid_enum'], ['quantity=1&price=p_other', 'parameter_unknown']] as const) {
      const res = await call('POST', '/v1/subscription_items/si_c', w(SK, `bad-${body}`), body);
      expect([res.status, res.json.error.code], body).toEqual([400, code]);
    }
    expect((await call('POST', '/v1/subscription_items/si_nope', w(SK, 'q-nope'), 'quantity=1')).json.error.code).toBe('resource_missing');
    expect(sub.items![0]!.quantity).toBe(2); // none of the refusals changed it
    const ok = await call('POST', '/v1/subscription_items/si_c', w(SK, 'q-ok'), 'quantity=5&proration_behavior=none');
    expect([ok.status, ok.json.quantity, ok.json.subscription]).toEqual([200, 5, 'sub_it2']);
    expect(sub.items![0]!.quantity).toBe(5);
    expect((await call('POST', '/v1/subscription_items/si_c', { ...auth(SK), ...form }, 'quantity=1')).status).toBe(400); // no Idempotency-Key
    const replay = await call('POST', '/v1/subscription_items/si_c', w(SK, 'q-ok'), 'quantity=5&proration_behavior=none');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await call('POST', '/v1/subscription_items/si_c', w(SK, 'q-ok'), 'quantity=6')).json.error.type).toBe('idempotency_error');
    seed('sub_it2c', [{ id: 'si_dead', priceId: 'p_engine', quantity: 1 }], 'canceled');
    expect((await call('POST', '/v1/subscription_items/si_dead', w(SK, 'q-dead'), 'quantity=2')).status).toBe(400);
  });

  it('adds an item by a subscription update, and refuses a price already held, an unknown price once prices are registered, a bad quantity, an unknown item key and a canceled subscription', async () => {
    const sub = seed('sub_it3', [{ id: 'si_e', priceId: 'p_plan', quantity: 1 }]);
    const add = (price: string, extra = '') => `items[0][price]=${price}${extra}`;
    const dup = await call('POST', '/v1/subscriptions/sub_it3', w(SK, 'a-dup'), add('p_plan'));
    expect(dup.status).toBe(400);
    expect(dup.json.error.message).toMatch(/same price/);
    for (const [body, code] of [[add('p_engine', '&items[0][quantity]=x'), 'parameter_invalid_integer'], [add('p_engine', '&items[0][metadata]=1'), 'parameter_unknown'], ['items[0][quantity]=2', 'parameter_missing']] as const) {
      expect((await call('POST', '/v1/subscriptions/sub_it3', w(SK, `a-${body}`), body)).json.error.code, body).toBe(code);
    }
    server.world.prices.add('p_plan');
    expect((await call('POST', '/v1/subscriptions/sub_it3', w(SK, 'a-unknown'), add('p_engine', '&items[0][quantity]=2'))).json.error.code).toBe('resource_missing');
    server.world.prices.add('p_engine');
    expect(sub.items).toHaveLength(1);
    const ok = await call('POST', '/v1/subscriptions/sub_it3', w(SK, 'a-ok'), add('p_engine', '&items[0][quantity]=2'));
    expect(ok.status).toBe(200);
    expect(ok.json.items.data.map((i: any) => [i.price.id, i.quantity])).toEqual([['p_plan', 1], ['p_engine', 2]]);
    server.world.prices.clear();
    seed('sub_it3c', [{ id: 'si_f', priceId: 'p_plan', quantity: 1 }], 'canceled');
    expect((await call('POST', '/v1/subscriptions/sub_it3c', w(SK, 'a-dead'), add('p_engine'))).status).toBe(400);
  });
});
