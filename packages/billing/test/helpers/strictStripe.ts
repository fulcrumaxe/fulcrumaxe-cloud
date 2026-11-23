/* eslint-disable @typescript-eslint/no-explicit-any -- the fake reads raw form-encoded nesting and JSON bodies field by field */
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { generateSelfSignedCert } from '../../../webhooks/test/helpers/selfSignedCert.js';

/**
 * A Stripe API that refuses what the real one refuses, served over real TLS so the REAL `stripe` SDK (the same client
 * the cron route builds) talks to it through Node's real connection path. The SDK gets the certificate as its explicit
 * `ca`; nothing sets `rejectUnauthorized: false`.
 *
 * What it enforces (each has a test that the stricter fake catches what a lenient one would let through):
 *  - `Authorization: Bearer <key>` with a key it knows; 401 with Stripe's error body otherwise.
 *  - `Stripe-Version` equal to the version the code pins; 400 for another or none.
 *  - A restricted key (`rk_`) reads customers and subscriptions only; any other path, and ANY write (POST/DELETE), is 403.
 *  - `GET /v1/subscriptions`: only Stripe's list parameters (400 `parameter_unknown` otherwise), `limit` 1..100 (default
 *    10), `status` one of Stripe's values (default: everything not canceled; `all` includes canceled), newest first,
 *    `starting_after` must name a subscription in the list, `has_more` true exactly when more remain, the `customer` must
 *    exist (404 `resource_missing`, "No such customer").
 *  - `POST /v1/subscriptions/{id}`: secret key only, and `Idempotency-Key` semantics (same key and parameters replays the
 *    stored answer with `Idempotent-Replayed: true`; same key with other parameters is an `idempotency_error`).
 *  - `GET /v1/subscriptions/{id}`: retrieve; 404 `resource_missing` for an unknown id.
 *  - Subscription items (D#845 ON-22a), secret key only, with the same `Idempotency-Key` rules:
 *      `POST /v1/subscription_items/{id}` takes only `quantity` (a whole number, 0 or more; `parameter_invalid_integer` otherwise) and
 *      `proration_behavior` (`create_prorations`, `none` or `always_invoice`), 404 for an unknown item, and refuses a canceled subscription;
 *      `POST /v1/subscriptions/{id}` with `items[n][price]` and `items[n][quantity]` and no `items[n][id]` ADDS an item, and refuses a price the
 *      subscription already holds (Stripe will not hold one price twice), a price missing from `world.prices` once a test registered any (404
 *      `resource_missing`), a bad quantity, an item key it does not know and a canceled subscription. A subscription keeps at most the items it was given.
 *  - 429 `rate_limit` and 5xx on demand (`world.failNext`).
 *
 *  - Pending updates (D#845 ON-22a, Stripe's "pending updates" page): `payment_behavior` is one of `allow_incomplete` (the default), `default_incomplete`,
 *    `error_if_incomplete` and `pending_if_incomplete`. An item change with `proration_behavior=always_invoice` raises an invoice; with the default proration it raises none and
 *    applies at once, whatever the card does (the provider default the review flagged). The invoice follows `world.paymentOutcome`: `paid` applies the change; `requires_action` or
 *    `declined` leave it open, and then `pending_if_incomplete` keeps the change out of `items` and answers 200 with a `pending_update` hash (`expires_at` 23 hours out) while
 *    `error_if_incomplete` answers 402 `card_error` and the default applies it anyway. Only an increase is charged; a decrease is a credit and always settles. `payPending` (the invoice
 *    is paid) applies a pending update, `expirePending` voids the invoice and drops it, and a later subscription update with a non-empty `items` list voids and drops it too.
 *    The item endpoint answers the item as it stands, so a pending quantity change still shows the old quantity. `world.ignoreWrites` makes writes answer 200 and change nothing
 *    (a stored answer replayed for a request the provider already saw).
 *  - Billing portal (D#845 ON-22a): `GET/POST /v1/billing_portal/configurations` (secret key only; `features` keys it does not know are 400, an enabled `subscription_update` needs
 *    `products` whose prices belong to the stated product and a non-empty `default_allowed_updates` of `price`, `quantity` or `promotion_code`), `GET /v1/prices/{id}`, and
 *    `POST /v1/billing_portal/sessions` (the customer and, when named, the active `configuration` must exist; a `subscription_update` flow needs a configuration that enables it).
 *
 * Not faked faithfully (the PR says so): proration amounts and invoice contents (an invoice here has an id, a status and the subscription), the other item
 * parameters (`price` swap, `metadata`, `tax_rates`), a `quantity` upper bound, the full subscription object (only the fields our code reads, in Stripe's
 * shapes), expansion, the other list filters (`price`, `created`, `collection_method`, `test_clock`) which answer 400
 * here rather than filtering, Stripe's real rate-limit thresholds, and the exact wording of every message.
 */

export type StripeKeyKind = 'restricted' | 'secret';

export interface FakeSubscription {
  id: string;
  customer: string;
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
  created: number;
  ended_at: number | null;
  cancel_at_period_end: boolean;
  current_period_end: number;
  livemode: boolean;
  /** The first item's price. Tests that set no `items` get one item of this price, quantity 1. */
  priceId: string;
  /** D#845 ON-22a: the items, in Stripe's order. Absent until a test sets it or a write materializes it from `priceId`. */
  items?: FakeItem[];
  /** D#845 ON-22a: a change waiting for its invoice to be paid; the items above do not include it. */
  pending_update?: FakePendingUpdate | null;
}

export type FakeChange = { kind: 'add'; price: string; quantity: number } | { kind: 'set'; itemId: string; quantity: number };

export interface FakePendingUpdate {
  expires_at: number;
  changes: FakeChange[];
  invoiceId: string;
}

export interface FakeInvoice {
  id: string;
  subscription: string;
  status: 'open' | 'paid' | 'void';
}

export interface FakePortalConfiguration {
  id: string;
  active: boolean;
  metadata: Record<string, string>;
  features: Record<string, unknown>;
}

export interface FakePortalSession {
  customer: string;
  configuration: string | null;
  flow: string | null;
}

export interface FakeItem {
  id: string;
  priceId: string;
  quantity: number;
}

export interface StripeWorld {
  customers: Set<string>;
  /** Price ids Stripe knows. Empty means every price is accepted; once a test adds one, an item with any other price is 404. */
  prices: Set<string>;
  subscriptions: FakeSubscription[];
  /** Answer the next requests with these statuses (429 is `rate_limit`, others a Stripe `api_error`), then carry on. */
  failNext: number[];
  /** What the card does when an invoice for an increase is paid: `paid`, or left open (`requires_action`, `declined`). */
  paymentOutcome: 'paid' | 'requires_action' | 'declined';
  invoices: FakeInvoice[];
  /** Writes answer 200 with the object as it stands and change nothing. */
  ignoreWrites: boolean;
  /** Price id -> product id for `GET /v1/prices/{id}`; a price not listed belongs to `prod_<price>`. */
  priceProducts: Map<string, string>;
  portalConfigurations: FakePortalConfiguration[];
  portalSessions: FakePortalSession[];
  /** The next N write (POST) requests are applied and then the connection is destroyed before any answer is sent: the caller sees a connection error for a change that did happen. */
  dropWriteReplies: number;
  /** Run before each answer is built; lets a test land a webhook write "while the fetch is in flight". */
  onRequest?: (req: SeenRequest) => void | Promise<void>;
}

export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
  servername: string | false | undefined;
}

export interface StrictStripe {
  port: number;
  ca: string;
  world: StripeWorld;
  seen: SeenRequest[];
  /** The invoice of a subscription's pending update is paid: the change is applied. False when there is none. */
  payPending(subscriptionId: string): boolean;
  /** The pending update expires (or is voided): the invoice is void and the change is dropped. False when there is none. */
  expirePending(subscriptionId: string): boolean;
  /** Forget every stored idempotent answer (Stripe keeps them 24 hours; a test that clears the world between cases clears them too). */
  forgetKeys(): void;
  close(): Promise<void>;
}

const LIST_PARAMS = new Set(['customer', 'status', 'limit', 'starting_after', 'ending_before']);
const UNSUPPORTED_FILTERS = new Set(['price', 'created', 'collection_method', 'test_clock', 'plan', 'current_period_end', 'current_period_start', 'expand[]']);
const STATUSES = new Set(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'all', 'ended']);

function err(status: number, type: string, message: string, extra: Record<string, string> = {}) {
  return { status, body: { error: { type, message, ...extra } } };
}

const subscriptionObject = (s: FakeSubscription) => ({
  id: s.id,
  object: 'subscription',
  customer: s.customer,
  status: s.status,
  created: s.created,
  ended_at: s.ended_at,
  cancel_at_period_end: s.cancel_at_period_end,
  current_period_end: s.current_period_end,
  livemode: s.livemode,
  pending_update: s.pending_update ? { expires_at: s.pending_update.expires_at, subscription_items: s.pending_update.changes.map((c) => (c.kind === 'add' ? { price: c.price, quantity: c.quantity } : { id: c.itemId, quantity: c.quantity })) } : null,
  items: { object: 'list', data: itemsOf(s).map((i) => ({ id: i.id, object: 'subscription_item', quantity: i.quantity, subscription: s.id, price: { id: i.priceId, object: 'price' } })), has_more: false, url: `/v1/subscription_items?subscription=${s.id}` },
});

function itemsOf(s: FakeSubscription): FakeItem[] {
  s.items ??= [{ id: `si_${s.id}`, priceId: s.priceId, quantity: 1 }];
  return s.items;
}

export function newWorld(): StripeWorld {
  return { customers: new Set(), prices: new Set(), subscriptions: [], failNext: [], paymentOutcome: 'paid', invoices: [], ignoreWrites: false, dropWriteReplies: 0, priceProducts: new Map(), portalConfigurations: [], portalSessions: [] };
}

export interface StrictStripeOptions {
  /** The API version the code under test pins. */
  pinnedVersion: string;
  keys: Record<string, StripeKeyKind>;
}

export async function startStrictStripe(options: StrictStripeOptions, world: StripeWorld = newWorld()): Promise<StrictStripe> {
  const { certPem, keyPem } = generateSelfSignedCert('127.0.0.1', 1, { ipAddresses: ['127.0.0.1'] });
  const seen: SeenRequest[] = [];
  const idempotent = new Map<string, { fingerprint: string; reply: { status: number; body: unknown } }>();

  async function answer(req: SeenRequest): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    await world.onRequest?.(req);
    const failure = world.failNext.shift();
    if (failure === 429) return err(429, 'invalid_request_error', 'Request rate limit exceeded. Please retry later.', { code: 'rate_limit' });
    if (failure !== undefined) return err(failure, 'api_error', 'An error occurred with our API.');

    const auth = req.headers['authorization'] ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const kind = options.keys[key];
    if (!key || !kind) {
      return err(401, 'invalid_request_error', key ? `Invalid API Key provided: ${key.slice(0, 8)}****` : 'You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. "Authorization: Bearer YOUR_SECRET_KEY").');
    }
    if (req.headers['stripe-version'] !== options.pinnedVersion) {
      return err(400, 'invalid_request_error', `Invalid Stripe API version: ${req.headers['stripe-version'] ?? '(none)'}; this client pins ${options.pinnedVersion}`);
    }
    if (!req.path.startsWith('/v1/')) return err(404, 'invalid_request_error', `Unrecognized request URL (${req.method}: ${req.path}).`);

    const write = req.method !== 'GET' && req.method !== 'HEAD';
    const readable = req.path === '/v1/subscriptions' || req.path.startsWith('/v1/subscriptions/') || req.path.startsWith('/v1/customers');
    if (kind === 'restricted' && (write || !readable) && !/^\/v1\/(prices|billing_portal)\b/.test(req.path)) {
      return err(403, 'invalid_request_error', `The provided key '${key.slice(0, 8)}****' does not have the required permissions for this endpoint on account 'acct_fake'. Having the 'rak_${write ? 'subscription_write' : 'charge_read'}' permission would allow this request to continue.`);
    }

    if (req.method === 'GET' && req.path === '/v1/subscriptions') return list(req);
    const one = /^\/v1\/subscriptions\/(sub_[A-Za-z0-9_]+)$/.exec(req.path);
    if (req.method === 'GET' && one) {
      const sub = world.subscriptions.find((s) => s.id === one[1]);
      return sub ? { status: 200, body: subscriptionObject(sub) } : err(404, 'invalid_request_error', `No such subscription: '${one[1]}'`, { code: 'resource_missing', param: 'subscription' });
    }
    if (req.method === 'POST' && one) return writeSubscription(req, one[1]!);
    const item = /^\/v1\/subscription_items\/(si_[A-Za-z0-9_]+)$/.exec(req.path);
    if (req.method === 'POST' && item) return writeItem(req, item[1]!);
    if (kind === 'restricted') return err(403, 'invalid_request_error', 'The provided key does not have the required permissions for this endpoint.');
    const price = /^\/v1\/prices\/([A-Za-z0-9_]+)$/.exec(req.path);
    if (req.method === 'GET' && price) {
      if (world.prices.size > 0 && !world.prices.has(price[1]!)) return err(404, 'invalid_request_error', `No such price: '${price[1]}'`, { code: 'resource_missing', param: 'price' });
      return { status: 200, body: { id: price[1], object: 'price', product: world.priceProducts.get(price[1]!) ?? `prod_${price[1]}` } };
    }
    const configuration = /^\/v1\/billing_portal\/configurations\/([A-Za-z0-9_]+)$/.exec(req.path);
    if (req.method === 'GET' && configuration) {
      const found = world.portalConfigurations.find((c) => c.id === configuration[1]);
      return found ? { status: 200, body: configurationObject(found) } : err(404, 'invalid_request_error', `No such configuration: '${configuration[1]}'`, { code: 'resource_missing', param: 'configuration' });
    }
    if (req.path === '/v1/billing_portal/configurations') return req.method === 'GET' ? listConfigurations(req) : req.method === 'POST' ? createConfiguration(req) : err(405, 'invalid_request_error', 'Method not allowed.');
    if (req.method === 'POST' && req.path === '/v1/billing_portal/sessions') return createPortalSession(req);
    return err(404, 'invalid_request_error', `Unrecognized request URL (${req.method}: ${req.path}).`);
  }

  function list(req: SeenRequest) {
    for (const name of req.query.keys()) {
      if (UNSUPPORTED_FILTERS.has(name) || !LIST_PARAMS.has(name)) {
        return err(400, 'invalid_request_error', `Received unknown parameter: ${name}`, { code: 'parameter_unknown', param: name });
      }
    }
    const customer = req.query.get('customer');
    if (customer !== null && !world.customers.has(customer)) {
      return err(404, 'invalid_request_error', `No such customer: '${customer}'`, { code: 'resource_missing', param: 'customer' });
    }
    const rawLimit = req.query.get('limit');
    let limit = 10;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
        return err(400, 'invalid_request_error', `Invalid integer: ${rawLimit}`, { code: 'parameter_invalid_integer', param: 'limit' });
      }
      limit = Number(rawLimit);
    }
    const status = req.query.get('status');
    if (status !== null && !STATUSES.has(status)) {
      return err(400, 'invalid_request_error', `Invalid status: must be one of ${[...STATUSES].join(', ')}`, { code: 'parameter_invalid_enum', param: 'status' });
    }
    // Stripe's default is everything that has not been canceled; `all` includes canceled; `ended` is canceled and incomplete_expired.
    const matching = world.subscriptions
      .filter((s) => customer === null || s.customer === customer)
      .filter((s) => (status === null ? s.status !== 'canceled' : status === 'all' ? true : status === 'ended' ? s.status === 'canceled' || s.status === 'incomplete_expired' : s.status === status))
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    let start = 0;
    const after = req.query.get('starting_after');
    if (after !== null) {
      const at = matching.findIndex((s) => s.id === after);
      if (at < 0) return err(404, 'invalid_request_error', `No such subscription: '${after}'`, { code: 'resource_missing', param: 'starting_after' });
      start = at + 1;
    }
    const page = matching.slice(start, start + limit);
    return { status: 200, body: { object: 'list', url: '/v1/subscriptions', data: page.map(subscriptionObject), has_more: start + limit < matching.length } };
  }

  const BEHAVIORS = new Set(['allow_incomplete', 'default_incomplete', 'error_if_incomplete', 'pending_if_incomplete']);
  const PRORATIONS = new Set(['create_prorations', 'none', 'always_invoice']);
  const PENDING_WINDOW_SECONDS = 23 * 3600;

  /** Stripe's idempotency: a replay of the same key with the same parameters answers the stored reply; other parameters are an error. `remember` when the key is new. */
  function replay(req: SeenRequest, params: URLSearchParams): { answer: { status: number; body: unknown; headers?: Record<string, string> } } | { remember: (reply: { status: number; body: unknown }) => void } {
    const idemKey = req.headers['idempotency-key'];
    if (!idemKey) return { answer: err(400, 'invalid_request_error', 'This fake requires an Idempotency-Key on every write (our code always sends one).') };
    const fingerprint = `${req.path}?${[...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&')}`;
    const previous = idempotent.get(idemKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return { answer: err(400, 'idempotency_error', `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idemKey}' if you meant to execute a different request.`) };
      }
      return { answer: { ...previous.reply, headers: { 'idempotent-replayed': 'true' } } };
    }
    return { remember: (reply: { status: number; body: unknown }) => void idempotent.set(idemKey, { fingerprint, reply }) };
  }

  function validatePayment(params: URLSearchParams) {
    const proration = params.get('proration_behavior');
    if (proration !== null && !PRORATIONS.has(proration)) return err(400, 'invalid_request_error', `Invalid proration_behavior: ${proration}`, { code: 'parameter_invalid_enum', param: 'proration_behavior' });
    const behavior = params.get('payment_behavior');
    if (behavior !== null && !BEHAVIORS.has(behavior)) return err(400, 'invalid_request_error', `Invalid payment_behavior: ${behavior}`, { code: 'parameter_invalid_enum', param: 'payment_behavior' });
    return null;
  }

  function applyChanges(sub: FakeSubscription, changes: FakeChange[]) {
    const items = itemsOf(sub);
    for (const c of changes) {
      if (c.kind === 'add') items.push({ id: `si_${sub.id}_${items.length + 1}`, priceId: c.price, quantity: c.quantity });
      else {
        const row = items.find((i) => i.id === c.itemId);
        if (row) row.quantity = c.quantity;
      }
    }
  }

  function voidPending(sub: FakeSubscription) {
    if (!sub.pending_update) return;
    const invoice = world.invoices.find((i) => i.id === sub.pending_update!.invoiceId);
    if (invoice) invoice.status = 'void';
    sub.pending_update = null;
  }

  /** Settles a validated change: raises an invoice when the proration is `always_invoice`, applies it, or holds it as a pending update. Returns an error answer or null. */
  function settle(sub: FakeSubscription, changes: FakeChange[], params: URLSearchParams) {
    if (world.ignoreWrites) return null;
    const proration = params.get('proration_behavior') ?? 'create_prorations';
    const behavior = params.get('payment_behavior') ?? 'allow_incomplete';
    const increase = changes.some((c) => c.kind === 'add' || c.quantity > (itemsOf(sub).find((i) => i.id === c.itemId)?.quantity ?? 0));
    if (proration !== 'always_invoice') {
      applyChanges(sub, changes);
      return null;
    }
    const outcome = increase ? world.paymentOutcome : 'paid';
    const invoice: FakeInvoice = { id: `in_fake_${world.invoices.length + 1}`, subscription: sub.id, status: outcome === 'paid' ? 'paid' : 'open' };
    world.invoices.push(invoice);
    if (outcome === 'paid') {
      applyChanges(sub, changes);
      return null;
    }
    if (behavior === 'pending_if_incomplete') {
      voidPending(sub);
      sub.pending_update = { expires_at: Math.floor(Date.now() / 1000) + PENDING_WINDOW_SECONDS, changes, invoiceId: invoice.id };
      return null;
    }
    if (behavior === 'error_if_incomplete') {
      invoice.status = 'void';
      return err(402, 'card_error', outcome === 'declined' ? 'Your card was declined.' : 'This payment requires additional user action before it can be completed successfully.', { code: outcome === 'declined' ? 'card_declined' : 'payment_intent_authentication_failure' });
    }
    applyChanges(sub, changes);
    return null;
  }

  function writeSubscription(req: SeenRequest, id: string) {
    const params = new URLSearchParams(req.body);
    const seenKey = replay(req, params);
    if ('answer' in seenKey) return seenKey.answer;
    const sub = world.subscriptions.find((s) => s.id === id);
    if (!sub) return err(404, 'invalid_request_error', `No such subscription: '${id}'`, { code: 'resource_missing', param: 'subscription' });
    const refused = validatePayment(params);
    if (refused) return refused;
    const parsed = parseAddedItems(sub, params);
    if ('status' in parsed) return parsed;
    if (parsed.changes.length > 0 && !world.ignoreWrites) {
      voidPending(sub); // a later update with a non-empty items list drops the pending one
      const failed = settle(sub, parsed.changes, params);
      if (failed) return failed;
    }
    const flag = params.get('cancel_at_period_end');
    if (flag !== null) {
      if (flag !== 'true' && flag !== 'false') return err(400, 'invalid_request_error', `Invalid boolean: ${flag}`, { code: 'parameter_invalid_boolean', param: 'cancel_at_period_end' });
      if (!world.ignoreWrites) sub.cancel_at_period_end = flag === 'true';
    }
    const reply = { status: 200, body: subscriptionObject(sub) };
    seenKey.remember(reply);
    return reply;
  }

  /** `items[n][...]` of a subscription update: an entry without `id` adds an item. Returns an error answer, or the changes (all valid, none applied yet). */
  function parseAddedItems(sub: FakeSubscription, params: URLSearchParams): { changes: FakeChange[] } | { status: number; body: unknown } {
    const entries = new Map<string, Record<string, string>>();
    for (const [key, value] of params) {
      const m = /^items\[(\d+)\]\[([a-z_]+)\]$/.exec(key);
      if (m) entries.set(m[1]!, { ...entries.get(m[1]!), [m[2]!]: value });
    }
    if (entries.size === 0) return { changes: [] };
    if (sub.status === 'canceled') return err(400, 'invalid_request_error', 'A canceled subscription can only update its cancellation_details.');
    const held = new Set(itemsOf(sub).map((i) => i.priceId));
    const changes: FakeChange[] = [];
    for (const entry of entries.values()) {
      const unknown = Object.keys(entry).find((k) => !['id', 'price', 'quantity'].includes(k));
      if (unknown) return err(400, 'invalid_request_error', `Received unknown parameter: items[][${unknown}]`, { code: 'parameter_unknown', param: `items[][${unknown}]` });
      if (entry.id !== undefined) return err(400, 'invalid_request_error', 'This fake updates an existing item through /v1/subscription_items/{id} only.');
      if (!entry.price) return err(400, 'invalid_request_error', 'Missing required param: items[][price].', { code: 'parameter_missing', param: 'items[][price]' });
      if (entry.quantity !== undefined && !/^\d+$/.test(entry.quantity)) return err(400, 'invalid_request_error', `Invalid integer: ${entry.quantity}`, { code: 'parameter_invalid_integer', param: 'items[][quantity]' });
      if (world.prices.size > 0 && !world.prices.has(entry.price)) return err(404, 'invalid_request_error', `No such price: '${entry.price}'`, { code: 'resource_missing', param: 'items[][price]' });
      if (held.has(entry.price)) return err(400, 'invalid_request_error', 'You cannot create multiple subscription items with the same price.');
      held.add(entry.price);
      changes.push({ kind: 'add', price: entry.price, quantity: entry.quantity === undefined ? 1 : Number(entry.quantity) });
    }
    return { changes };
  }

  function writeItem(req: SeenRequest, id: string) {
    const params = new URLSearchParams(req.body);
    const seenKey = replay(req, params);
    if ('answer' in seenKey) return seenKey.answer;
    for (const name of params.keys()) {
      if (name !== 'quantity' && name !== 'proration_behavior' && name !== 'payment_behavior') return err(400, 'invalid_request_error', `Received unknown parameter: ${name}`, { code: 'parameter_unknown', param: name });
    }
    const owner = world.subscriptions.find((s) => itemsOf(s).some((i) => i.id === id));
    if (!owner) return err(404, 'invalid_request_error', `No such subscription_item: '${id}'`, { code: 'resource_missing', param: 'subscription_item' });
    if (owner.status === 'canceled') return err(400, 'invalid_request_error', 'A canceled subscription can only update its cancellation_details.');
    const refused = validatePayment(params);
    if (refused) return refused;
    const quantity = params.get('quantity');
    if (quantity !== null && !/^\d+$/.test(quantity)) return err(400, 'invalid_request_error', `Invalid integer: ${quantity}`, { code: 'parameter_invalid_integer', param: 'quantity' });
    if (quantity !== null) {
      const failed = settle(owner, [{ kind: 'set', itemId: id, quantity: Number(quantity) }], params);
      if (failed) return failed;
    }
    const row = itemsOf(owner).find((i) => i.id === id)!;
    const reply = { status: 200, body: { id: row.id, object: 'subscription_item', quantity: row.quantity, subscription: owner.id, price: { id: row.priceId, object: 'price' } } };
    seenKey.remember(reply);
    return reply;
  }

  // ---- billing portal ------------------------------------------------------------------------------------------------------------------------
  const CONFIG_FEATURES = new Set(['customer_update', 'invoice_history', 'payment_method_update', 'subscription_cancel', 'subscription_update', 'subscription_pause']);
  const ALLOWED_UPDATES = new Set(['price', 'quantity', 'promotion_code']);

  /** Form-encoded nested params (`a[b][0][c]=v`) back into an object, the way Stripe reads them. */
  function nested(params: URLSearchParams): Record<string, any> {
    const root: Record<string, any> = {};
    for (const [key, value] of params) {
      const path = key.replace(/\]/g, '').split('[');
      let at = root;
      path.forEach((part, i) => {
        if (i === path.length - 1) at[part] = value;
        else at = at[part] ??= {};
      });
    }
    return root;
  }

  /** Form-encoded values come back typed: Stripe answers booleans as booleans, not as the strings the request carried. */
  const typed = (v: unknown): unknown => (v === 'true' ? true : v === 'false' ? false : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typed(x)])) : v);
  const configurationObject = (c: FakePortalConfiguration) => ({ id: c.id, object: 'billing_portal.configuration', active: c.active, metadata: c.metadata, features: typed(c.features) });

  function createConfiguration(req: SeenRequest) {
    const params = new URLSearchParams(req.body);
    const seenKey = replay(req, params);
    if ('answer' in seenKey) return seenKey.answer;
    const body = nested(params);
    const features = body.features ?? {};
    for (const name of Object.keys(features)) {
      if (!CONFIG_FEATURES.has(name)) return err(400, 'invalid_request_error', `Received unknown parameter: features[${name}]`, { code: 'parameter_unknown', param: `features[${name}]` });
    }
    const update = features.subscription_update;
    if (update?.enabled === 'true') {
      const allowed = Object.values<string>(update.default_allowed_updates ?? {});
      if (allowed.length === 0) return err(400, 'invalid_request_error', 'Missing required param: features[subscription_update][default_allowed_updates].', { code: 'parameter_missing', param: 'features[subscription_update][default_allowed_updates]' });
      if (allowed.some((a) => !ALLOWED_UPDATES.has(a))) return err(400, 'invalid_request_error', 'Invalid default_allowed_updates.', { code: 'parameter_invalid_enum', param: 'features[subscription_update][default_allowed_updates]' });
      const products = Object.values<any>(update.products ?? {});
      if (products.length === 0) return err(400, 'invalid_request_error', 'Missing required param: features[subscription_update][products].', { code: 'parameter_missing', param: 'features[subscription_update][products]' });
      for (const p of products) {
        for (const price of Object.values<string>(p.prices ?? {})) {
          if ((world.priceProducts.get(price) ?? `prod_${price}`) !== p.product) return err(400, 'invalid_request_error', `The price ${price} does not belong to product ${p.product}.`, { code: 'parameter_invalid_empty', param: 'features[subscription_update][products]' });
        }
      }
    }
    const config: FakePortalConfiguration = { id: `bpc_fake_${world.portalConfigurations.length + 1}`, active: true, metadata: body.metadata ?? {}, features };
    world.portalConfigurations.push(config);
    const reply = { status: 200, body: configurationObject(config) };
    seenKey.remember(reply);
    return reply;
  }

  function listConfigurations(req: SeenRequest) {
    for (const name of req.query.keys()) {
      if (name !== 'active' && name !== 'limit' && name !== 'starting_after') return err(400, 'invalid_request_error', `Received unknown parameter: ${name}`, { code: 'parameter_unknown', param: name });
    }
    const active = req.query.get('active');
    const limit = Number(req.query.get('limit') ?? 10);
    const rows = world.portalConfigurations.filter((c) => active === null || c.active === (active === 'true')).slice(0, limit);
    return { status: 200, body: { object: 'list', url: '/v1/billing_portal/configurations', data: rows.map(configurationObject), has_more: false } };
  }

  function createPortalSession(req: SeenRequest) {
    const body = nested(new URLSearchParams(req.body));
    if (!body.customer || !world.customers.has(body.customer)) return err(404, 'invalid_request_error', `No such customer: '${body.customer ?? ''}'`, { code: 'resource_missing', param: 'customer' });
    let configuration: FakePortalConfiguration | null = null;
    if (body.configuration !== undefined) {
      configuration = world.portalConfigurations.find((c) => c.id === body.configuration && c.active) ?? null;
      if (!configuration) return err(404, 'invalid_request_error', `No such configuration: '${body.configuration}'`, { code: 'resource_missing', param: 'configuration' });
    }
    const flow: string | null = body.flow_data?.type ?? null;
    if (flow === 'subscription_update' && (configuration === null || (configuration.features as any).subscription_update?.enabled !== 'true')) {
      return err(400, 'invalid_request_error', 'The portal configuration does not allow subscription updates.');
    }
    world.portalSessions.push({ customer: body.customer, configuration: configuration?.id ?? null, flow });
    return { status: 200, body: { id: `bps_fake_${world.portalSessions.length}`, object: 'billing_portal.session', url: `https://billing.stripe.test/session/${world.portalSessions.length}` } };
  }

  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const url = new URL(req.url ?? '/', 'https://127.0.0.1');
      const seenReq: SeenRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
        servername: (req.socket as unknown as { servername?: string | false }).servername,
      };
      seen.push(seenReq);
      answer(seenReq).then(
        (r) => {
          if (seenReq.method === 'POST' && world.dropWriteReplies > 0) {
            world.dropWriteReplies -= 1;
            req.socket.destroy();
            return;
          }
          res.writeHead(r.status, { 'content-type': 'application/json', 'request-id': `req_fake_${seen.length}`, ...(r.headers ?? {}) });
          res.end(JSON.stringify(r.body));
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: certPem,
    world,
    seen,
    payPending: (subscriptionId) => {
      const sub = world.subscriptions.find((x) => x.id === subscriptionId);
      if (!sub?.pending_update) return false;
      const invoice = world.invoices.find((i) => i.id === sub.pending_update!.invoiceId);
      if (invoice) invoice.status = 'paid';
      applyChanges(sub, sub.pending_update.changes);
      sub.pending_update = null;
      return true;
    },
    forgetKeys: () => idempotent.clear(),
    expirePending: (subscriptionId) => {
      const sub = world.subscriptions.find((x) => x.id === subscriptionId);
      if (!sub?.pending_update) return false;
      voidPending(sub);
      return true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
