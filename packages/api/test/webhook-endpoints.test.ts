import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { webhookEndpointLimitFor } from '@fx/spend';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const FX_WEBHOOK_KEK_V1 = Buffer.alloc(32, 3).toString('base64');

interface EndpointDTO {
  id: string;
  secret?: string;
  url: string;
  event_types: string[];
  status: string;
  disabled_reason: string | null;
}

interface ErrorBody {
  error: { code: string; message: string; request_id: string };
  details?: { path: string; code: string }[];
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * D#31 API-4b: the webhook-endpoints route table (criterion 10 and "The
 * v1 contract"'s route rows). SSRF/signing/dispatch themselves are
 * packages/webhooks's own real-Postgres-and-receiver suite
 * (ssrf/sign/payload/dispatcher/e2e.test.ts); this file covers the HTTP
 * layer: CRUD, role/scope gates, the endpoint cap, secret-reveal-once,
 * and the redeliver/rotate DB-only paths, all through the real
 * `handleApiRequest` dispatcher (no live network call is ever made from
 * here -- `/test` is exercised in packages/webhooks/test/dispatcher.test.ts
 * instead, calling `sendTestEvent` directly).
 */
describe('D#31 API-4b: webhook-endpoints routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
    process.env.FX_WEBHOOK_KEK_V1 = FX_WEBHOOK_KEK_V1;
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_WEBHOOK_KEK_V1;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function sessionRequest(url: string, identity: { userId: string; accountId: string }, init: RequestInit = {}): Promise<Request> {
    const token = await signSession(identity);
    const headers = new Headers(init.headers);
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    return new Request(url, { ...init, headers });
  }

  function bearerRequest(url: string, plaintext: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${plaintext}`);
    return new Request(url, { ...init, headers });
  }

  async function dispatch(req: Request): Promise<Response> {
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function createEndpoint(
    identity: { accountId: string; userId: string },
    body: Record<string, unknown> = { url: 'https://example.com/hooks/fulcrumaxe', event_types: ['pr.opened'] },
  ): Promise<Response> {
    return dispatch(
      await sessionRequest('http://localhost/api/v1/webhook-endpoints', identity, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  async function mintReadToken(identity: { accountId: string; userId: string }): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return plaintext;
  }

  it('creates an endpoint, reveals the secret once, and the secret never reappears on GET/list', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await createEndpoint(owner);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; secret: string; url: string; event_types: string[]; status: string };
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.url).toBe('https://example.com/hooks/fulcrumaxe');
    expect(created.status).toBe('active');

    const getRes = await dispatch(await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}`, owner));
    expect(getRes.status).toBe(200);
    const got = await json<EndpointDTO>(getRes);
    expect(got).not.toHaveProperty('secret');

    const listRes = await dispatch(await sessionRequest('http://localhost/api/v1/webhook-endpoints', owner));
    const list = (await listRes.json()) as { data: Record<string, unknown>[] };
    expect(list.data.every((row) => !('secret' in row))).toBe(true);
  });

  it('criterion 1: rejects a non-https URL with 422 invalid_webhook_url (scheme)', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await createEndpoint(owner, { url: 'http://example.com/hook', event_types: ['pr.opened'] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string }; details: { path: string; code: string }[] };
    expect(body.error.code).toBe('invalid_webhook_url');
    expect(body.details).toEqual([{ path: 'url', code: 'scheme' }]);
  });

  it('criterion 1: rejects a blocked IP-literal URL with 422 invalid_webhook_url (blocked_address)', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await createEndpoint(owner, { url: 'https://169.254.169.254/hook', event_types: ['pr.opened'] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details: { code: string }[] };
    expect(body.details[0]!.code).toBe('blocked_address');
  });

  it('rejects an unknown event type with 422 validation_failed (the catalogue is a closed enum)', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await createEndpoint(owner, { url: 'https://example.com/hook', event_types: ['not.a.real.event'] });
    expect(res.status).toBe(422);
    const body = await json<ErrorBody>(res);
    expect(body.error.code).toBe('validation_failed');
  });

  it('criterion 10: a member (not owner/admin) gets 403 insufficient_role on every route', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const created = await json<EndpointDTO>(await createEndpoint(owner));
    const member = await seedAccountWithMember(admin, { role: 'member' });
    // Seed the SAME account's member row isn't right here -- reuse owner's account with a member user instead.
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, member.userId]);
    const memberIdentity = { accountId: owner.accountId, userId: member.userId };

    const listRes = await dispatch(await sessionRequest('http://localhost/api/v1/webhook-endpoints', memberIdentity));
    expect(listRes.status).toBe(403);
    // All six mutation routes: a member is refused with insufficient_role
    // (not merely "some 403"), and none of them reaches the handler.
    const base = 'http://localhost/api/v1/webhook-endpoints';
    const jsonHeaders = { 'content-type': 'application/json' };
    const mutations: { name: string; res: Promise<Response> }[] = [
      { name: 'create', res: createEndpoint(memberIdentity) },
      {
        name: 'PATCH',
        res: sessionRequest(`${base}/${created.id}`, memberIdentity, {
          method: 'PATCH',
          headers: jsonHeaders,
          body: JSON.stringify({ url: 'https://example.com/other' }),
        }).then(dispatch),
      },
      { name: 'delete', res: sessionRequest(`${base}/${created.id}`, memberIdentity, { method: 'DELETE' }).then(dispatch) },
      { name: 'rotate-secret', res: sessionRequest(`${base}/${created.id}/rotate-secret`, memberIdentity, { method: 'POST' }).then(dispatch) },
      { name: 'test', res: sessionRequest(`${base}/${created.id}/test`, memberIdentity, { method: 'POST' }).then(dispatch) },
      {
        name: 'redeliver',
        res: sessionRequest(`${base}/deliveries/${randomUUID()}/redeliver`, memberIdentity, { method: 'POST' }).then(dispatch),
      },
    ];
    for (const m of mutations) {
      const res = await m.res;
      expect(res.status, m.name).toBe(403);
      expect((await json<ErrorBody>(res)).error.code, m.name).toBe('insufficient_role');
    }
    // Nothing was created, changed or removed by the refused calls.
    const { rows } = await admin.query(`SELECT url, previous_secret_ciphertext IS NULL AS never_rotated FROM webhook_endpoints WHERE account_id = $1`, [
      owner.accountId,
    ]);
    expect(rows).toEqual([{ url: 'https://example.com/hooks/fulcrumaxe', never_rotated: true }]);
  });

  it('criterion 10: a read-scoped token CAN list endpoints (GET is S+T(read))', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await createEndpoint(owner);
    const token = await mintReadToken(owner);
    const res = await dispatch(bearerRequest('http://localhost/api/v1/webhook-endpoints', token));
    expect(res.status).toBe(200);
  });

  it("criterion 10: the endpoint past the plan's limit -> 409 endpoint_limit_reached", async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner', plan: 'starter' });
    for (let i = 0; i < webhookEndpointLimitFor('starter'); i++) {
      const res = await createEndpoint(owner, { url: `https://example${i}.com/hook`, event_types: ['pr.opened'] });
      expect(res.status).toBe(201);
    }
    const pastLimit = await createEndpoint(owner, { url: 'https://over-limit.example.com/hook', event_types: ['pr.opened'] });
    expect(pastLimit.status).toBe(409);
    const body = await json<ErrorBody>(pastLimit);
    expect(body.error.code).toBe('endpoint_limit_reached');
  });

  it('endpoint cap holds under concurrency: N parallel creates at cap-1 yield exactly one 201 and the rest 409', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner', plan: 'starter' });
    for (let i = 0; i < webhookEndpointLimitFor('starter') - 1; i++) {
      const res = await createEndpoint(owner, { url: `https://example${i}.com/hook`, event_types: ['pr.opened'] });
      expect(res.status).toBe(201);
    }
    // Real parallel connections: the requests are built first, then all fired at once.
    const N = 8;
    const reqs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        sessionRequest('http://localhost/api/v1/webhook-endpoints', owner, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `https://race${i}.example.com/hook`, event_types: ['pr.opened'] }),
        }),
      ),
    );
    const responses = await Promise.all(reqs.map((r) => dispatch(r)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, ...Array(N - 1).fill(409)]);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect((await json<ErrorBody>(res)).error.code).toBe('endpoint_limit_reached');
    }
    const { rows } = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM webhook_endpoints WHERE account_id = $1`, [owner.accountId]);
    expect(rows[0]!.n).toBe(String(webhookEndpointLimitFor('starter')));
  });

  it('PATCH updates url and event_types, and re-enabling via status clears disabled_reason', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const created = await json<EndpointDTO>(await createEndpoint(owner));
    await admin.query(`UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = 'failing' WHERE id = $1`, [created.id]);

    const patchRes = await dispatch(
      await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}`, owner, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = await json<EndpointDTO>(patchRes);
    expect(patched.status).toBe('active');
    expect(patched.disabled_reason).toBeNull();
  });

  it('PATCH with an empty body is rejected as validation_failed', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const created = await json<EndpointDTO>(await createEndpoint(owner));
    const res = await dispatch(
      await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}`, owner, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(422);
  });

  it('DELETE removes the endpoint; a second DELETE and a subsequent GET both 404', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const created = await json<EndpointDTO>(await createEndpoint(owner));

    const del1 = await dispatch(await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}`, owner, { method: 'DELETE' }));
    expect(del1.status).toBe(204);

    const del2 = await dispatch(await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}`, owner, { method: 'DELETE' }));
    expect(del2.status).toBe(404);

    const getRes = await dispatch(await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}`, owner));
    expect(getRes.status).toBe(404);
  });

  it('CWE-639: another account\'s endpoint id, and a random uuid, both 404 with identical bodies apart from request_id', async () => {
    const ownerA = await seedAccountWithMember(admin, { role: 'owner' });
    const ownerB = await seedAccountWithMember(admin, { role: 'owner' });
    const created = await json<EndpointDTO>(await createEndpoint(ownerA));

    const crossTenant = await dispatch(await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}`, ownerB));
    const randomId = await dispatch(await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${randomUUID()}`, ownerB));
    expect(crossTenant.status).toBe(404);
    expect(randomId.status).toBe(404);
    const [crossBody, randomBody] = await Promise.all([json<ErrorBody>(crossTenant), json<ErrorBody>(randomId)]);
    expect(crossBody.error.code).toBe(randomBody.error.code);
    expect(crossBody.error.message).toBe(randomBody.error.message);
  });

  it('rotate-secret reveals a new secret distinct from the original and opens a ~24h overlap window', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const created = await json<EndpointDTO>(await createEndpoint(owner));

    const before = Date.now();
    const res = await dispatch(
      await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${created.id}/rotate-secret`, owner, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as { secret: string; rotated_at: string; previous_secret_expires_at: string };
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);

    const overlapMs = new Date(rotated.previous_secret_expires_at).getTime() - before;
    expect(overlapMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(overlapMs).toBeLessThan(25 * 60 * 60 * 1000);

    const { rows } = await admin.query(`SELECT previous_secret_ciphertext IS NOT NULL AS has_previous FROM webhook_endpoints WHERE id = $1`, [created.id]);
    expect(rows[0].has_previous).toBe(true);
  });

  it('redeliver resets a dead delivery to pending (202); an unknown delivery id 404s', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const created = await json<EndpointDTO>(await createEndpoint(owner));
    const eventId = 'evt_' + randomUUID();
    await admin.query(`INSERT INTO domain_events (id, account_id, type, payload) VALUES ($1, $2, 'pr.opened', '{}'::jsonb)`, [eventId, owner.accountId]);
    const deliveryRow = await admin.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (account_id, endpoint_id, event_id, event_type, status, dead_at)
       VALUES ($1, $2, $3, 'pr.opened', 'dead', now()) RETURNING id`,
      [owner.accountId, created.id, eventId],
    );
    const deliveryId = deliveryRow.rows[0]!.id;

    const res = await dispatch(
      await sessionRequest(`http://localhost/api/v1/webhook-endpoints/deliveries/${deliveryId}/redeliver`, owner, { method: 'POST' }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'queued' });

    const { rows } = await admin.query(`SELECT status, dead_at FROM webhook_deliveries WHERE id = $1`, [deliveryId]);
    expect(rows[0]).toEqual({ status: 'pending', dead_at: null });

    const notFound = await dispatch(
      await sessionRequest(`http://localhost/api/v1/webhook-endpoints/deliveries/${randomUUID()}/redeliver`, owner, { method: 'POST' }),
    );
    expect(notFound.status).toBe(404);
  });

  it('lists the delivery log for one endpoint, scoped correctly and excluding other endpoints\' deliveries', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const endpointA = await json<EndpointDTO>(await createEndpoint(owner, { url: 'https://a.example.com/hook', event_types: ['pr.opened'] }));
    const endpointB = await json<EndpointDTO>(await createEndpoint(owner, { url: 'https://b.example.com/hook', event_types: ['pr.opened'] }));
    const eventId = 'evt_' + randomUUID();
    await admin.query(`INSERT INTO domain_events (id, account_id, type, payload) VALUES ($1, $2, 'pr.opened', '{}'::jsonb)`, [eventId, owner.accountId]);
    await admin.query(
      `INSERT INTO webhook_deliveries (account_id, endpoint_id, event_id, event_type, status, last_status_code)
       VALUES ($1, $2, $3, 'pr.opened', 'succeeded', 200)`,
      [owner.accountId, endpointA.id, eventId],
    );
    await admin.query(
      `INSERT INTO webhook_deliveries (account_id, endpoint_id, event_id, event_type, status, last_status_code)
       VALUES ($1, $2, $3, 'pr.opened', 'succeeded', 200)`,
      [owner.accountId, endpointB.id, eventId],
    );

    const res = await dispatch(await sessionRequest(`http://localhost/api/v1/webhook-endpoints/${endpointA.id}/deliveries`, owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data).toHaveLength(1);
  });
});
