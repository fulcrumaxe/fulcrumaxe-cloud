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
 *  - 429 `rate_limit` and 5xx on demand (`world.failNext`).
 *
 * Not faked faithfully (the PR says so): the full subscription object (only the fields our code reads, in Stripe's
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
  priceId: string;
}

export interface StripeWorld {
  customers: Set<string>;
  subscriptions: FakeSubscription[];
  /** Answer the next requests with these statuses (429 is `rate_limit`, others a Stripe `api_error`), then carry on. */
  failNext: number[];
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
  items: { object: 'list', data: [{ id: `si_${s.id}`, object: 'subscription_item', price: { id: s.priceId, object: 'price' } }], has_more: false, url: `/v1/subscription_items?subscription=${s.id}` },
});

export function newWorld(): StripeWorld {
  return { customers: new Set(), subscriptions: [], failNext: [] };
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
    if (kind === 'restricted' && (write || !readable)) {
      return err(403, 'invalid_request_error', `The provided key '${key.slice(0, 8)}****' does not have the required permissions for this endpoint on account 'acct_fake'. Having the 'rak_${write ? 'subscription_write' : 'charge_read'}' permission would allow this request to continue.`);
    }

    if (req.method === 'GET' && req.path === '/v1/subscriptions') return list(req);
    const update = /^\/v1\/subscriptions\/(sub_[A-Za-z0-9_]+)$/.exec(req.path);
    if (req.method === 'POST' && update) return writeSubscription(req, update[1]!);
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

  function writeSubscription(req: SeenRequest, id: string) {
    const params = new URLSearchParams(req.body);
    const idemKey = req.headers['idempotency-key'];
    if (!idemKey) return err(400, 'invalid_request_error', 'This fake requires an Idempotency-Key on every write (our code always sends one).');
    const fingerprint = `${req.path}?${[...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&')}`;
    const previous = idempotent.get(idemKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return err(400, 'idempotency_error', `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idemKey}' if you meant to execute a different request.`);
      }
      return { ...previous.reply, headers: { 'idempotent-replayed': 'true' } };
    }
    const sub = world.subscriptions.find((s) => s.id === id);
    if (!sub) return err(404, 'invalid_request_error', `No such subscription: '${id}'`, { code: 'resource_missing', param: 'subscription' });
    const flag = params.get('cancel_at_period_end');
    if (flag !== null) {
      if (flag !== 'true' && flag !== 'false') return err(400, 'invalid_request_error', `Invalid boolean: ${flag}`, { code: 'parameter_invalid_boolean', param: 'cancel_at_period_end' });
      sub.cancel_at_period_end = flag === 'true';
    }
    const reply = { status: 200, body: subscriptionObject(sub) };
    idempotent.set(idemKey, { fingerprint, reply });
    return reply;
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
