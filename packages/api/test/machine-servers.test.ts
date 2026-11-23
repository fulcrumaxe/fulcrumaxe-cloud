import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { connectHetznerCredential, machineKekSource } from '@fx/model-connection';
import { hashProvisioningToken, mintProvisioningToken } from '@fx/runner-cloud';
import { createHetznerCredentialProbe } from '../../hetzner/src/index.js';
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from '../../hetzner/test/helpers/strictHetzner.js';
import { handleApiRequest } from '../src/handler.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { serverQuoteSchema, serverSchema } from '../src/routes/machine-servers.js';
import { STANDARD_TIER_NOTICE, createServer, getServer, machineServerDeps, sameMoney, type CreateStep, type PriceTriple } from '../src/machines/servers.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const BASE = 'http://localhost/api/v1/machine-servers';
const ORIGIN = 'https://cloud.example.test';
const newToken = (): string => randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(64, 'x').slice(0, 64);
/** What the strict fake's /pricing says for cx22 in fsn1: net 3.79 a month and 0.0059 an hour at 19 percent, and 0.5000 / 0.0008 for the IPv4 address. */
const LIVE: PriceTriple = { currency: 'EUR', hourly_gross: '0.0070', monthly_gross: '4.5101', ipv4_monthly_gross: '0.5950' };
const SIZE = { server_type: 'cx22', location: 'fsn1' };
/** The few fields of the fake's records and of the API's replies that these tests read. */
interface Made { id: number; labels: Record<string, string>; public_net: { firewalls: unknown; ipv6: unknown } }
interface Wall { id: number; rules: unknown }
interface Reply { id: string; price: unknown; error: { code: string; message: string }; data: { live: Record<string, string> }; public_net: unknown; image: unknown; ssh_keys: unknown; user_data: string }

/** D#845 MC-4: quote and create, through the real handler, a real database and the strict Hetzner fake. Nothing here can reach the real Hetzner API. */
describe('machine servers: quote and create', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let fake: StrictHetzner;
  let world: FakeWorld;
  let token: string;
  const defaults = { ...machineServerDeps };

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });
  beforeEach(async () => {
    token = newToken();
    world = newWorld([token]);
    // A server delete is an action that finishes later, and the server (with its firewall) stays until then, as at Hetzner.
    world.deleteSteps = 2;
    fake = await startStrictHetzner(world);
    const kek = machineKekSource({ FX_MACHINE_KEK_V1: randomBytes(32).toString('base64') });
    machineServerDeps.getKek = () => kek;
    machineServerDeps.getOrigin = () => ORIGIN;
    // Every client in these tests goes to the local TLS fake: the test target pins the address and the certificate. No retry sleeps.
    machineServerDeps.hetznerOptions = () => ({ maxRetries: 0, timeoutMs: 2000, sleep: async () => undefined, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
  });
  afterEach(async () => {
    Object.assign(machineServerDeps, defaults);
    delete machineServerDeps.checkpoint;
    await fake.close();
  });

  async function owner(role: 'owner' | 'admin' = 'owner'): Promise<{ accountId: string; userId: string }> {
    const who = await seedAccountWithMember(admin, { role });
    const kek = machineServerDeps.getKek();
    await connectHetznerCredential({ pool: appUserPool, principal: who, kek, probe: createHetznerCredentialProbe({ maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } }) }, { token });
    return who;
  }
  async function call(who: { accountId: string; userId: string } | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const h = new Headers({ ...(who ? { cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` } : {}), ...headers });
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const create = (who: { accountId: string; userId: string } | null, key: string, extra: Record<string, unknown> = {}, quoted: PriceTriple = LIVE) =>
    call(who, 'POST', '', { ...SIZE, quoted, ...extra }, { 'idempotency-key': key });
  const serversOf = async (accountId: string) => (await admin.query(`SELECT * FROM managed_servers WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows;
  const tokenRows = async (accountId: string) => (await admin.query(`SELECT id, used_at, revoked_at FROM runner_provisioning_tokens WHERE account_id = $1`, [accountId])).rows;
  const auditCount = async (accountId: string, action: string) => Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [accountId, action])).rows[0].n);
  const postsTo = (path: string) => world.requests.filter((r) => r.method === 'POST' && r.path === `/v1${path}`);
  /** Nothing of a create is left at Hetzner, in the tokens or in the audit log. */
  async function expectNothingLeft(accountId: string): Promise<void> {
    expect(world.servers).toEqual([]);
    expect(world.firewalls).toEqual([]);
    for (const t of await tokenRows(accountId)) expect(t.revoked_at, 'every token made was revoked').not.toBeNull();
    expect(await auditCount(accountId, 'server.create_confirmed')).toBe(0);
  }

  describe('the routes', () => {
    it('are session-only and owner-or-admin; create needs an idempotency key; the Hetzner routes have their own session limits', () => {
      const mine = ROUTES.filter((r) => r.path.startsWith('/api/v1/machine-servers'));
      expect(mine.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/machine-servers', 'GET /api/v1/machine-servers/catalog', 'GET /api/v1/machine-servers/quote', 'POST /api/v1/machine-servers', 'GET /api/v1/machine-servers/{id}', 'DELETE /api/v1/machine-servers/{id}']);
      for (const r of mine) { expect(effectivePrincipals(r), r.operationId).toEqual(['session']); expect(r.minRole, r.operationId).toBe('admin'); }
      expect(mine.find((r) => r.method === 'POST')).toMatchObject({ idempotency: 'required', sessionLimit: { name: 'machine-server-create' } });
      expect(mine.find((r) => r.operationId === 'quoteHetznerServer')?.sessionLimit?.name).toBe('machine-server-quote');
    });

    it('answer 401 with no session, 403 to a plain member and to an API token (even one holding every scope), and nothing reaches Hetzner', async () => {
      const who = await owner();
      world.requests.length = 0;
      expect((await call(null, 'GET', `/quote?server_type=cx22&location=fsn1`)).status).toBe(401);
      expect((await create(null, 'k-anon')).status).toBe(401);
      expect((await call(null, 'GET', `/${randomUUID()}`)).status).toBe(401);
      const memberId = randomUUID();
      await seedUser(admin, memberId);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [who.accountId, memberId]);
      const plain = { accountId: who.accountId, userId: memberId };
      expect((await call(plain, 'GET', `/quote?server_type=cx22&location=fsn1`)).status).toBe(403);
      expect((await create(plain, 'k-member')).status).toBe(403);
      expect((await call(plain, 'GET', `/${randomUUID()}`)).status).toBe(403);
      const plaintext = generateToken();
      await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
      for (const [method, path, body] of [['GET', '/quote?server_type=cx22&location=fsn1', undefined], ['POST', '', { ...SIZE, quoted: LIVE }], ['GET', `/${randomUUID()}`, undefined]] as const) {
        const res = await handleApiRequest(new Request(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json', 'idempotency-key': 'k-token' }, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect(world.requests).toEqual([]);
      expect(await serversOf(who.accountId)).toEqual([]);
    });
  });

  describe('the quote (item 1)', () => {
    it('answers the live hourly, monthly and IPv4 gross prices, with the standard-tier statement ahead of every price', async () => {
      const who = await owner();
      const res = await call(who, 'GET', '/quote?server_type=cx22&location=fsn1');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(token);
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(serverQuoteSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ tier: 'standard', ...LIVE, billed_by: 'Hetzner bills you directly', server_type: 'cx22', location: 'fsn1', available: true });
      // Item 5: the copy is there, and it is read before any price (the key order is the document order).
      expect(body.tier_notice).toBe(STANDARD_TIER_NOTICE);
      expect(STANDARD_TIER_NOTICE).toMatch(/can't run microVMs/);
      expect(STANDARD_TIER_NOTICE).toMatch(/Standard isolation and host one project/);
      const keys = Object.keys(body);
      expect(keys.indexOf('tier')).toBe(0);
      expect(keys.indexOf('tier_notice')).toBeLessThan(keys.indexOf('hourly_gross'));
      expect(keys.indexOf('tier_notice')).toBeLessThan(keys.indexOf('monthly_gross'));
      expect(keys.indexOf('tier_notice')).toBeLessThan(keys.indexOf('ipv4_monthly_gross'));
      // The price is the live one: it moves when Hetzner's moves, and nothing is cached between two quotes.
      world.priceMonthlyDelta = 1;
      expect(await (await call(who, 'GET', '/quote?server_type=cx22&location=fsn1')).json()).toMatchObject({ monthly_gross: '5.7001' });
      expect(world.requests.filter((r) => r.path.startsWith('/v1/pricing')).length).toBe(2);
    });

    it('reports a size that is listed but not offered there as unavailable, and answers 422 for a size or a place Hetzner does not list', async () => {
      const who = await owner();
      expect(await (await call(who, 'GET', '/quote?server_type=cx32&location=nbg1')).json()).toMatchObject({ available: false });
      const unknown = await call(who, 'GET', '/quote?server_type=nope&location=fsn1');
      expect(unknown.status).toBe(422);
      expect(await unknown.json()).toMatchObject({ error: { code: 'unknown_size' } });
      expect((await call(who, 'GET', '/quote?server_type=cx22&location=Mars!')).status).toBe(422);
      expect((await call(who, 'GET', '/quote?server_type=cx22')).status).toBe(422);
    });

    it('answers 503 with no price when Hetzner is down: a server error, a dropped connection, a hang, a limit', async () => {
      const who = await owner();
      for (const failure of [{ status: 500, code: 'server_error' }, { drop: true }, { hang: true }, { status: 429, code: 'rate_limit_exceeded' }]) {
        world.failNext.push(failure, failure);
        const res = await call(who, 'GET', '/quote?server_type=cx22&location=fsn1');
        expect(res.status, JSON.stringify(failure)).toBe(503);
        const text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ error: { code: 'price_unavailable' } });
        expect(text).not.toMatch(/gross|\d\.\d{4}/);
        world.failNext.length = 0;
      }
    });

    it('says the stored token was refused (and marks it invalid) rather than showing a price', async () => {
      const who = await owner();
      world.tokens.clear();
      const res = await call(who, 'GET', '/quote?server_type=cx22&location=fsn1');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'hetzner_unauthorized' } });
      expect((await admin.query(`SELECT status FROM machine_provider_credentials WHERE account_id = $1`, [who.accountId])).rows[0].status).toBe('invalid');
    });

    it('is 404 not_connected when no token is stored, and 503 machine_kek_unset when the machine key is missing', async () => {
      const bare = await seedAccountWithMember(admin, { role: 'owner' });
      expect((await call(bare, 'GET', '/quote?server_type=cx22&location=fsn1')).status).toBe(404);
      const who = await owner();
      machineServerDeps.getKek = () => machineKekSource({});
      const off = await call(who, 'GET', '/quote?server_type=cx22&location=fsn1');
      expect(off.status).toBe(503);
      expect(await off.json()).toMatchObject({ error: { code: 'machine_kek_unset' } });
    });
  });

  describe('price comparison', () => {
    it('treats the same amount written two ways as equal and any difference as different', () => {
      expect(sameMoney('4.5100', '4.51')).toBe(true);
      expect(sameMoney('4.5100', '4.5101')).toBe(false);
      expect(sameMoney('0.0070', '0.007000')).toBe(true);
      expect(sameMoney('0.0070', '0.0071')).toBe(false);
      expect(sameMoney('1', '1.0000')).toBe(true);
      expect(sameMoney('10', '1')).toBe(false);
      expect(sameMoney('1e3', '1000')).toBe(false);
      expect(sameMoney('', '')).toBe(false);
    });
  });

  describe('create: the order, and what is stamped (items 2 and 3)', () => {
    it('makes the firewall, the token, the row, the server and the audit row, binds the token to the IPv4, and never keeps the root password or the token', async () => {
      const who = await owner();
      const res = await create(who, 'k-happy');
      expect(res.status).toBe(201);
      const text = await res.text();
      const body = JSON.parse(text) as Reply;
      expect(serverSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ kind: 'hetzner_cloud', status: 'creating', server_type: 'cx22', location: 'fsn1', public_ipv4: '203.0.113.7', failure_code: null });
      expect(body.price).toEqual({ currency: 'EUR', hourly_gross: '0.007000', monthly_gross: '4.5101', ipv4_monthly_gross: '0.5950' });
      expect(text).not.toMatch(/fxrp_|root_password|SECRET|provisioning_token/);

      // Hetzner: one firewall with no rule, one server on it, an IPv4 address and no IPv6, labelled for the row.
      expect(world.firewalls).toHaveLength(1);
      expect(world.firewalls[0]).toMatchObject({ rules: [], labels: { 'fx-managed': '1', 'fx-server': body.id } });
      expect(world.servers).toHaveLength(1);
      const made = world.servers[0] as unknown as Made;
      expect(made.labels).toMatchObject({ 'fx-managed': '1', 'fx-server': body.id, 'fx-create-key': body.id });
      expect(made.public_net.firewalls).toEqual([{ id: (world.firewalls[0] as unknown as Wall).id, status: 'pending' }]);
      expect(made.public_net.ipv6, 'FU-186: the server has no IPv6 address, so the token-to-IP binding (IPv4) is the only way it can reach us').toBeNull();
      const post = JSON.parse(postsTo('/servers')[0]!.body) as Reply;
      expect(post.public_net).toEqual({ enable_ipv4: true, enable_ipv6: false });
      expect(post.image).toBe('ubuntu-24.04');
      expect(post.ssh_keys).toBeUndefined();
      // The user_data carries one fxrp_ token, once, and the origin; the token is bound to the row and its IPv4.
      const secret = /fxrp_[A-Za-z0-9]{40}/.exec(post.user_data as string)?.[0];
      expect(secret).toBeDefined();
      expect((post.user_data as string).split(secret!)).toHaveLength(2);
      expect(post.user_data).toContain(ORIGIN);

      const [row] = await serversOf(who.accountId);
      expect(row).toMatchObject({ id: body.id, kind: 'hetzner_cloud', status: 'creating', name: `fx-${body.id.slice(0, 8)}`, provider_server_id: String(made.id), provider_firewall_id: String((world.firewalls[0] as unknown as Wall).id), public_ipv4: '203.0.113.7', currency: 'EUR', idempotency_key: 'k-happy', created_by: who.userId });
      expect([row.price_hourly_gross, row.price_monthly_gross, row.ipv4_monthly_gross]).toEqual(['0.007000', '4.5101', '0.5950']);
      const bound = await withTenant(appUserPool, who.accountId, who.userId, async (c) => (await c.query(`SELECT bound, ip FROM runner_provisioning_token_bound_ip($1)`, [hashProvisioningToken(secret!)])).rows[0]);
      expect(bound).toEqual({ bound: true, ip: '203.0.113.7' });
      const tokens = await tokenRows(who.accountId);
      expect(tokens).toEqual([{ id: row.provisioning_token_id, used_at: null, revoked_at: null }]);
      expect((await admin.query(`SELECT expires_at - created_at AS life, cardinality(allowed_repo_ids) AS repos FROM runner_provisioning_tokens WHERE id = $1`, [row.provisioning_token_id])).rows[0]).toMatchObject({ life: { minutes: 30 }, repos: 0 });

      // The audit row: one, with ids and enums only (no price, no token).
      const audit = (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'server.create_confirmed'`, [who.accountId])).rows;
      expect(audit).toEqual([{ payload: { server_id: body.id, server_type: 'cx22', location: 'fsn1' } }]);
      // The token was opened once for the create, and audited by MC-2's reader.
      expect(await auditCount(who.accountId, 'server.unsealed')).toBe(1);
      // Reading it back gives the same view.
      expect(await (await call(who, 'GET', `/${body.id}`)).json()).toEqual(body);
    });

    it('opens SSH on the firewall only when an SSH key was given, and hands Hetzner that key', async () => {
      const who = await owner();
      const res = await create(who, 'k-ssh', { ssh_key_id: 4242, name: 'build-box' });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ name: 'build-box' });
      expect((world.firewalls[0] as unknown as Wall).rules).toEqual([expect.objectContaining({ direction: 'in', protocol: 'tcp', port: '22' })]);
      expect(JSON.parse(postsTo('/servers')[0]!.body).ssh_keys).toEqual([4242]);
    });

    it('refuses a malformed body with 422 and creates nothing: an extra field, a bad name, a price that is not a decimal, a missing key', async () => {
      const who = await owner();
      expect((await create(who, 'k-extra', { password: 'x' })).status).toBe(422);
      expect((await create(who, 'k-name', { name: 'Not A Host Name' })).status).toBe(422);
      expect((await create(who, 'k-money', {}, { ...LIVE, monthly_gross: '4,51' })).status).toBe(422);
      expect((await create(who, 'k-ssh0', { ssh_key_id: 0 })).status).toBe(422);
      const noKey = await call(who, 'POST', '', { ...SIZE, quoted: LIVE });
      expect(noKey.status).toBe(400);
      expect(await serversOf(who.accountId)).toEqual([]);
      expect(postsTo('/servers')).toEqual([]);
    });

    it('answers a size that is not offered in the location with 409 and creates nothing', async () => {
      const who = await owner();
      const res = await create(who, 'k-unavailable', { server_type: 'cx32', location: 'nbg1' }, { ...LIVE, monthly_gross: '8.0920', hourly_gross: '0.0134', ipv4_monthly_gross: '0.5950' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'hetzner_resource_unavailable' } });
      await expectNothingLeft(who.accountId);
      expect(await serversOf(who.accountId)).toEqual([]);
    });
  });

  describe('create: the price (item 2)', () => {
    it('answers 409 price_changed, with the live price, when the price moved by any amount, and creates nothing at all', async () => {
      const who = await owner();
      world.priceMonthlyDelta = 0.0001;
      const res = await create(who, 'k-moved');
      expect(res.status).toBe(409);
      const body = (await res.json()) as Reply;
      expect(body.error.code).toBe('price_changed');
      expect(body.data.live).toMatchObject({ currency: 'EUR', ipv4_monthly_gross: '0.5950' });
      expect(body.data.live.monthly_gross).not.toBe(LIVE.monthly_gross);
      expect(postsTo('/firewalls')).toEqual([]);
      expect(postsTo('/servers')).toEqual([]);
      expect(await serversOf(who.accountId)).toEqual([]);
      expect(await tokenRows(who.accountId)).toEqual([]);
      expect(await auditCount(who.accountId, 'server.create_confirmed')).toBe(0);
    });

    it('refuses each of the four fields on its own: the hourly price, the monthly price, the IPv4 price and the currency', async () => {
      const who = await owner();
      for (const [i, q] of [{ hourly_gross: '0.0071' }, { monthly_gross: '4.5102' }, { ipv4_monthly_gross: '0.5951' }, { currency: 'USD' }].entries()) {
        const res = await create(who, `k-field-${i}`, {}, { ...LIVE, ...q });
        expect(res.status, JSON.stringify(q)).toBe(409);
        expect(await res.json()).toMatchObject({ error: { code: 'price_changed' } });
      }
      expect(postsTo('/servers')).toEqual([]);
    });

    it('accepts the same amount written with other trailing zeros, and stamps the live price, not the quoted spelling', async () => {
      const who = await owner();
      const res = await create(who, 'k-zeros', {}, { currency: 'EUR', hourly_gross: '0.00700', monthly_gross: '4.51010', ipv4_monthly_gross: '0.595' });
      expect(res.status).toBe(201);
      expect((await serversOf(who.accountId))[0].price_monthly_gross).toBe('4.5101');
    });

    it('answers 503 price_unavailable when Hetzner cannot say the price, and creates nothing', async () => {
      const who = await owner();
      world.failNext.push({ status: 500, code: 'server_error' }, { status: 500, code: 'server_error' });
      const res = await create(who, 'k-down');
      expect(res.status).toBe(503);
      expect(postsTo('/firewalls')).toEqual([]);
      expect(await serversOf(who.accountId)).toEqual([]);
      expect(await tokenRows(who.accountId)).toEqual([]);
    });
  });

  describe('create: every failure point undoes what came before (item 3), one test per point', () => {
    const failAt = (step: CreateStep): void => {
      machineServerDeps.checkpoint = (s) => {
        if (s === step) throw new Error(`injected failure at ${step}`);
      };
    };

    it('firewall: Hetzner refuses it, so no token, row or server exists', async () => {
      const who = await owner();
      world.failNext.push({ method: 'POST', path: '/firewalls', status: 500, code: 'server_error' });
      const res = await create(who, 'k-fw');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'hetzner_server_error' } });
      await expectNothingLeft(who.accountId);
      expect(await serversOf(who.accountId)).toEqual([]);
      expect(await tokenRows(who.accountId)).toEqual([]);
    });

    it('token: the token cannot be made (five are outstanding), so the firewall is deleted and nothing else exists', async () => {
      const who = await owner();
      for (let i = 0; i < 5; i++) expect((await mintProvisioningToken({ appUserPool, origin: ORIGIN, failRunnerLeases: null }, who, { credential_mode: 'subscription' })).status).toBe(201);
      const res = await create(who, 'k-token');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'token_limit' } });
      expect(postsTo('/firewalls')).toHaveLength(1);
      expect(world.firewalls).toEqual([]);
      expect(world.servers).toEqual([]);
      expect(await serversOf(who.accountId)).toEqual([]);
      expect((await tokenRows(who.accountId)).filter((t) => t.revoked_at !== null)).toEqual([]);
    });

    it('render: the user_data cannot be rendered, so the firewall is deleted and the token revoked', async () => {
      const who = await owner();
      failAt('render');
      expect((await create(who, 'k-render')).status).toBe(500);
      await expectNothingLeft(who.accountId);
      expect(await tokenRows(who.accountId)).toHaveLength(1);
      expect(await serversOf(who.accountId)).toEqual([]);
    });

    it('render: a server origin that is not https makes no server and leaves nothing behind', async () => {
      const who = await owner();
      machineServerDeps.getOrigin = () => 'http://cloud.example.test';
      expect((await create(who, 'k-origin')).status).toBe(500);
      await expectNothingLeft(who.accountId);
      machineServerDeps.getOrigin = () => undefined;
      world.requests.length = 0;
      const off = await create(who, 'k-origin-none');
      expect(off.status).toBe(503);
      expect(world.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    });

    it('insert: the row cannot be written, so the firewall is deleted and the token revoked', async () => {
      const who = await owner();
      failAt('insert');
      expect((await create(who, 'k-insert')).status).toBe(500);
      await expectNothingLeft(who.accountId);
      expect(await tokenRows(who.accountId)).toHaveLength(1);
      expect(await serversOf(who.accountId)).toEqual([]);
    });

    it('server: Hetzner refuses the create (its server limit), so the firewall is deleted, the token revoked and the row is failed with the reason in plain words', async () => {
      const who = await owner();
      world.serverLimit = 0;
      const res = await create(who, 'k-limit');
      expect(res.status).toBe(409);
      const body = (await res.json()) as Reply;
      expect(body.error).toMatchObject({ code: 'hetzner_resource_limit_exceeded', message: "Hetzner's server limit for your Hetzner account was reached. Ask Hetzner to raise it, or delete a server" });
      await expectNothingLeft(who.accountId);
      const rows = await serversOf(who.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', failure_code: 'hetzner_resource_limit_exceeded', provider_server_id: null, provider_firewall_id: null, public_ipv4: null });
      expect(await tokenRows(who.accountId)).toHaveLength(1);
    });

    it('server: the create fails with an error answer and a taken name is reported as such', async () => {
      const who = await owner();
      await create(who, 'k-first', { name: 'taken-name' });
      const res = await create(who, 'k-second', { name: 'taken-name' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'hetzner_uniqueness_error' } });
      expect(world.servers).toHaveLength(1);
      expect(world.firewalls).toHaveLength(1);
      expect((await serversOf(who.accountId)).map((r) => r.status).sort()).toEqual(['creating', 'failed']);
      expect((await tokenRows(who.accountId)).filter((t) => t.revoked_at !== null)).toHaveLength(1);
    });

    it('server: a server that landed while its answer was lost is adopted, not duplicated', async () => {
      const who = await owner();
      world.failNext.push({ method: 'POST', path: '/servers', after: 'drop' });
      const res = await create(who, 'k-lost');
      expect(res.status).toBe(201);
      expect(world.servers).toHaveLength(1);
      expect(postsTo('/servers')).toHaveLength(1);
      expect((await serversOf(who.accountId))[0]).toMatchObject({ status: 'creating', provider_server_id: String((world.servers[0] as unknown as Made).id) });
    });

    it('server: a create that failed with no way to tell if it landed is looked for by label and removed if it did', async () => {
      const who = await owner();
      world.failNext.push({ method: 'POST', path: '/servers', after: '500' });
      // maxRetries is 0: the client finds the landed server by its create-key label and returns it, so this is a success, not a failure.
      expect((await create(who, 'k-500')).status).toBe(201);
      expect(world.servers).toHaveLength(1);
    });

    it('server: the create timed out, the client\'s own search also failed, and the server did land: unwind finds it by label, deletes it, waits for the delete, then the firewall', async () => {
      const who = await owner();
      // The first search (before the send) passes; the create lands and then hangs; the client's search after the timeout is dropped. Only unwind's search sees the server.
      world.failNext.push({ method: 'POST', path: '/servers', after: 'hang' }, { method: 'GET', path: '/servers', drop: true, skip: 1 });
      const res = await create(who, 'k-landed-lost');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'hetzner_unavailable' } });
      expect(postsTo('/servers')).toHaveLength(1);
      await expectNothingLeft(who.accountId);
      expect((await serversOf(who.accountId))[0]).toMatchObject({ status: 'failed', failure_code: 'hetzner_unavailable', provider_server_id: null, provider_firewall_id: null });
      const labelSearches = world.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/v1/servers?') && r.path.includes('fx-server'));
      expect(labelSearches.length, 'unwind searched by the row label').toBeGreaterThan(0);
    });

    it('server: the create got no answer, the search finds nothing yet, and the server lands later: the row is cleanup_failed (never a clean failure) and keeps the firewall id for the sweep', async () => {
      const who = await owner();
      world.failNext.push({ method: 'POST', path: '/servers', status: 500, code: 'server_error' });
      const res = await create(who, 'k-late');
      expect(res.status).toBe(503);
      expect(world.servers).toEqual([]);
      const row = (await serversOf(who.accountId))[0];
      expect(row).toMatchObject({ status: 'failed', failure_code: 'cleanup_failed', provider_server_id: null });
      expect(row.provider_firewall_id).toBe(String((world.firewalls[0] as unknown as Wall).id));
      // The firewall is kept (a server may still be made with it), and so is the token's revocation: only the server and firewall are unknown.
      expect(world.firewalls).toHaveLength(1);
      // The server that Hetzner was still making now exists, labelled with the row: a label search finds it, which is what the sweep and the status worker do.
      world.servers.push({ id: 4242, name: row.name, status: 'initializing', labels: { 'fx-server': row.id } });
      expect(world.servers.filter((x) => (x.labels as Record<string, string>)['fx-server'] === row.id)).toHaveLength(1);
    });

    it('server: a plain refusal (Hetzner says the size is unavailable) is a clean failure, because nothing was made', async () => {
      const who = await owner();
      world.failNext.push({ method: 'POST', path: '/servers', status: 412, code: 'resource_unavailable' });
      expect((await create(who, 'k-refused')).status).toBe(409);
      await expectNothingLeft(who.accountId);
      expect((await serversOf(who.accountId))[0]).toMatchObject({ status: 'failed', failure_code: 'hetzner_resource_unavailable' });
    });

    it('finalize: the IP cannot be stamped after the server was made, so the server, firewall and token are all undone', async () => {
      const who = await owner();
      failAt('finalize');
      expect((await create(who, 'k-finalize')).status).toBe(500);
      await expectNothingLeft(who.accountId);
      const rows = await serversOf(who.accountId);
      expect(rows[0]).toMatchObject({ status: 'failed', failure_code: 'create_failed', provider_server_id: null, provider_firewall_id: null, public_ipv4: null });
      // The server first, then the firewall (Hetzner refuses a firewall that is still applied).
      expect(world.requests.filter((r) => r.method === 'DELETE' && !r.path.includes('/ssh_keys')).map((r) => r.path.split('/')[2])).toEqual(['servers', 'firewalls']);
    });

    it('audit: the audit row cannot be written, so the IP stamp rolls back with it and the server, firewall and token are undone', async () => {
      const who = await owner();
      failAt('audit');
      expect((await create(who, 'k-audit')).status).toBe(500);
      await expectNothingLeft(who.accountId);
      expect((await serversOf(who.accountId))[0]).toMatchObject({ status: 'failed', public_ipv4: null, provider_server_id: null });
    });

    it('a failed undo is not hidden: the row says cleanup_failed and keeps the ids the sweep needs, and the error is still the cause', async () => {
      const who = await owner();
      failAt('finalize');
      world.failNext.push({ method: 'DELETE', status: 500, code: 'server_error' });
      const res = await create(who, 'k-cleanup');
      expect(res.status).toBe(500);
      const rows = await serversOf(who.accountId);
      expect(rows[0]).toMatchObject({ status: 'failed', failure_code: 'cleanup_failed' });
      expect(rows[0].provider_server_id).toBe(String((world.servers[0] as unknown as Made).id));
      expect(world.servers).toHaveLength(1);
      expect(world.firewalls, 'a firewall still applied to a server is not deleted out from under it').toHaveLength(1);
    });
  });

  describe('create: idempotency and double submit (item 4)', () => {
    it('the same key twice answers the first server and creates nothing more; another key is another server', async () => {
      const who = await owner();
      const first = await create(who, 'k-twice');
      const again = await create(who, 'k-twice');
      expect(again.status).toBe(201);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(await again.json()).toEqual(await first.json());
      expect(world.servers).toHaveLength(1);
      expect((await create(who, 'k-other', { name: 'second-box' })).status).toBe(201);
      expect(world.servers).toHaveLength(2);
      expect(await serversOf(who.accountId)).toHaveLength(2);
    });

    it('the service answers the first row for a repeated key, calling nothing at Hetzner, even after the HTTP replay window', async () => {
      const who = await owner();
      const input = { idempotencyKey: 'k-service', serverType: 'cx22', location: 'fsn1', quoted: LIVE };
      const ctx = { pool: appUserPool, principal: who };
      const a = await createServer(ctx, input);
      const seen = world.requests.length;
      const b = await createServer(ctx, input);
      expect(b).toEqual({ server: a.server, reused: true });
      expect(a.reused).toBe(false);
      expect(world.requests.length).toBe(seen);
      // Even a price that moved since (which would be refused for a new key) answers the existing row.
      world.priceMonthlyDelta = 5;
      expect((await createServer(ctx, input)).server.id).toBe(a.server.id);
    });

    it('RACE: eight requests with one key at once make one server, one firewall, one token, one row and one audit row, and all eight answer it', async () => {
      const who = await owner();
      const ctx = { pool: appUserPool, principal: who };
      const results = await Promise.all(Array.from({ length: 8 }, () => createServer(ctx, { idempotencyKey: 'k-race', serverType: 'cx22', location: 'fsn1', quoted: LIVE })));
      expect(new Set(results.map((r) => r.server.id)).size).toBe(1);
      expect(results.filter((r) => !r.reused)).toHaveLength(1);
      expect(world.servers).toHaveLength(1);
      expect(world.firewalls).toHaveLength(1);
      expect(postsTo('/servers')).toHaveLength(1);
      expect(postsTo('/firewalls')).toHaveLength(1);
      expect(await serversOf(who.accountId)).toHaveLength(1);
      expect(await tokenRows(who.accountId)).toHaveLength(1);
      expect(await auditCount(who.accountId, 'server.create_confirmed')).toBe(1);
      expect(await auditCount(who.accountId, 'server.unsealed')).toBe(1);
    });

    it('POOL: more creates at once than the pool has connections all finish (a create never holds its lock connection while waiting for a second one)', async () => {
      const who = await owner();
      const small = createPool(process.env.API_DATABASE_URL_APP_USER!, { max: 3 });
      try {
        // Five accounts: one account makes one server at a time, so the pool is loaded by different accounts.
        const whos = [who, ...(await Promise.all(Array.from({ length: 4 }, () => owner())))];
        const results = await Promise.all(whos.map((w, i) => createServer({ pool: small, principal: w }, { idempotencyKey: `k-pool-${i}`, serverType: 'cx22', location: 'fsn1', name: `pool-box-${i}`, quoted: LIVE })));
        expect(results.every((r) => !r.reused && r.server.status === 'creating')).toBe(true);
        expect(world.servers).toHaveLength(5);
        expect(await serversOf(who.accountId)).toHaveLength(1);
      } finally {
        await small.end();
      }
    }, 30_000);

    it('RACE over HTTP: four clicks with one key never make two servers and never answer a 5xx (the rest are held by the create limit or the in-progress key)', async () => {
      const who = await owner();
      await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
      const h = { cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}`, 'content-type': 'application/json', 'idempotency-key': 'k-click' };
      const send = () => handleApiRequest(new Request(BASE, { method: 'POST', headers: h, body: JSON.stringify({ ...SIZE, quoted: LIVE }) }), appUserPool, platformOpsPool, ROUTES);
      const responses = await Promise.all(Array.from({ length: 4 }, send));
      for (const r of responses) expect([201, 409, 429], `status ${r.status}`).toContain(r.status);
      expect(responses.some((r) => r.status === 201)).toBe(true);
      expect(world.servers).toHaveLength(1);
      expect(await serversOf(who.accountId)).toHaveLength(1);
      expect(await tokenRows(who.accountId)).toHaveLength(1);
    });

    describe('one create at a time per account (FU-238)', () => {
      const input = (key: string, name: string) => ({ idempotencyKey: key, serverType: 'cx22', location: 'fsn1', quoted: LIVE, name });
      /** Runs `during` once the first create has reached the Hetzner server step, with its locks held, then lets it finish. */
      async function whileCreating(who: { accountId: string; userId: string }, key: string, during: () => Promise<void>): Promise<Awaited<ReturnType<typeof createServer>>> {
        let reached!: () => void;
        const atServer = new Promise<void>((r) => { reached = r; });
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        let blocked = false;
        machineServerDeps.checkpoint = async (step) => { if (step === 'server' && !blocked) { blocked = true; reached(); await held; } };
        const first = createServer({ pool: appUserPool, principal: who }, input(key, 'box-first'));
        await atServer;
        try { await during(); } finally { release(); }
        const out = await first;
        delete machineServerDeps.checkpoint;
        return out;
      }

      it('RACE across keys: while one create runs, a create under another key is refused at once with 409 server_creating and Hetzner sees one server', async () => {
        const who = await owner();
        const first = await whileCreating(who, 'k-a', async () => {
          const started = Date.now();
          const res = await create(who, 'k-b', { name: 'box-b' });
          expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'server_creating']);
          expect(Date.now() - started, 'refused without waiting').toBeLessThan(5000);
          await expect(createServer({ pool: appUserPool, principal: who }, input('k-c', 'box-c'))).rejects.toMatchObject({ status: 409, code: 'server_creating' });
        });
        expect(first.reused).toBe(false);
        expect(world.servers).toHaveLength(1);
        expect(postsTo('/servers')).toHaveLength(1);
        expect(postsTo('/firewalls')).toHaveLength(1);
        expect(await serversOf(who.accountId)).toHaveLength(1);
        expect(await tokenRows(who.accountId)).toHaveLength(1);
      });

      it('a retry with the same key during the create waits for it and replays its answer, not server_creating', async () => {
        const who = await owner();
        let retry!: Promise<Awaited<ReturnType<typeof createServer>>>;
        const first = await whileCreating(who, 'k-same', async () => {
          retry = createServer({ pool: appUserPool, principal: who }, input('k-same', 'box-first'));
          retry.catch(() => undefined);
          await new Promise((r) => setTimeout(r, 300));
        });
        const again = await retry;
        expect(again).toEqual({ server: first.server, reused: true });
        expect(world.servers).toHaveLength(1);
      });

      it('after the first create finishes a new key succeeds, and a failed create frees the account too', async () => {
        const who = await owner();
        expect((await create(who, 'k-one')).status).toBe(201);
        expect((await create(who, 'k-two', { name: 'box-two' })).status).toBe(201);
        world.serverLimit = 0;
        expect((await create(who, 'k-bad', { name: 'box-bad' })).status).toBe(409);
        world.serverLimit = 10;
        expect((await create(who, 'k-three', { name: 'box-three' })).status).toBe(201);
        expect(world.servers).toHaveLength(3);
      });

      it('another account is not blocked by a create that is running, even with the same key', async () => {
        const who = await owner();
        const other = await owner();
        await whileCreating(who, 'k-shared', async () => {
          expect((await create(who, 'k-x', { name: 'box-x' })).status).toBe(409);
          expect((await create(other, 'k-shared', { name: 'box-y' })).status).toBe(201);
        });
        expect(world.servers).toHaveLength(2);
      });

      it('a create killed after its row, with no lock left, still blocks a new key for ten minutes and not after; its own key still replays', async () => {
        const who = await owner();
        expect((await create(who, 'k-dead')).status).toBe(201);
        await admin.query(`UPDATE managed_servers SET provider_server_id = NULL WHERE account_id = $1`, [who.accountId]);
        const refused = await create(who, 'k-new', { name: 'box-new' });
        expect([refused.status, ((await refused.json()) as Reply).error.code]).toEqual([409, 'server_creating']);
        expect(world.servers).toHaveLength(1);
        expect((await create(who, 'k-dead')).headers.get('idempotent-replayed')).toBe('true');
        await admin.query(`UPDATE managed_servers SET created_at = now() - interval '11 minutes' WHERE account_id = $1`, [who.accountId]);
        expect((await create(who, 'k-new', { name: 'box-new' })).status).toBe(201);
      });
    });

    it('the unique index is the backstop: a second row with the same key in one account is refused by the database, another account may use it', async () => {
      const who = await owner();
      await create(who, 'k-index');
      const [row] = await serversOf(who.accountId);
      const dup = await admin.query(`SELECT id FROM runner_provisioning_tokens WHERE account_id = $1`, [who.accountId]);
      await expect(
        admin.query(
          `INSERT INTO managed_servers (account_id, kind, credential_id, name, status, price_hourly_gross, price_monthly_gross, ipv4_monthly_gross, provisioning_token_id, created_by, idempotency_key)
           VALUES ($1, 'hetzner_cloud', $2, 'dup', 'creating', 0, 0, 0, $3, $4, 'k-index')`,
          [who.accountId, row.credential_id, dup.rows[0].id, who.userId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      const other = await owner();
      expect((await create(other, 'k-index')).status).toBe(201);
    });

    it('a key that already has a failed row answers that row and calls nothing; a new key tries again', async () => {
      const who = await owner();
      world.serverLimit = 0;
      expect((await create(who, 'k-fail')).status).toBe(409);
      world.serverLimit = 10;
      const seen = world.requests.length;
      const ctx = { pool: appUserPool, principal: who };
      const again = await createServer(ctx, { idempotencyKey: 'k-fail', serverType: 'cx22', location: 'fsn1', quoted: LIVE });
      expect(again.reused).toBe(true);
      expect(again.server).toMatchObject({ status: 'failed', failure_code: 'hetzner_resource_limit_exceeded' });
      expect(world.requests.length).toBe(seen);
      expect((await create(who, 'k-fail-2')).status).toBe(201);
    });
  });

  describe('reading one server (FU-182)', () => {
    it('answers 400 for an id that is not a UUID, 404 for one that is not this account\'s, and never 500', async () => {
      const who = await owner();
      for (const bad of ['not-a-uuid', '123', 'hetzner', '%00', `${randomUUID()}x`, 'g'.repeat(36)]) {
        const res = await call(who, 'GET', `/${bad}`);
        expect(res.status, bad).toBe(400);
        expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
      }
      expect((await call(who, 'GET', `/${randomUUID()}`)).status).toBe(404);
      await create(who, 'k-read');
      const [row] = await serversOf(who.accountId);
      const stranger = await owner();
      const foreign = await call(stranger, 'GET', `/${row.id}`);
      expect(foreign.status).toBe(404);
      expect((await call(who, 'GET', `/${String(row.id).toUpperCase()}`)).status).toBe(200);
    });

    it('is never the quote or the create route by another name: the literal quote path wins over the id', async () => {
      const who = await owner();
      expect((await call(who, 'GET', '/quote?server_type=cx22&location=fsn1')).status).toBe(200);
    });
  });

  describe('the explicit account predicates (without row security to help)', () => {
    it('reads and keys are per account even on a connection that bypasses row security: another account\'s id is not found, and its key is not reused', async () => {
      const a = await owner();
      const b = await owner();
      const made = await createServer({ pool: appUserPool, principal: a }, { idempotencyKey: 'k-bypass', serverType: 'cx22', location: 'fsn1', quoted: LIVE, name: 'box-a' });
      // The admin pool owns the tables, so row security does not apply to it: only the queries' own `account_id = ...` keeps the accounts apart.
      const bypass = { pool: adminPool, principal: b };
      expect(await getServer(bypass, made.server.id)).toBeNull();
      const mine = await createServer(bypass, { idempotencyKey: 'k-bypass', serverType: 'cx22', location: 'fsn1', quoted: LIVE, name: 'box-b' });
      expect(mine.reused).toBe(false);
      expect(mine.server.id).not.toBe(made.server.id);
      expect(world.servers).toHaveLength(2);
      expect(await serversOf(a.accountId)).toHaveLength(1);
      expect(await serversOf(b.accountId)).toHaveLength(1);
    });
  });

  describe('cross-account', () => {
    it('keeps one account\'s servers, tokens and keys out of another\'s, and each account unseals only its own token', async () => {
      const a = await owner();
      const b = await owner();
      await create(a, 'k-shared');
      await create(b, 'k-shared');
      expect(await serversOf(a.accountId)).toHaveLength(1);
      expect(await serversOf(b.accountId)).toHaveLength(1);
      expect((await serversOf(a.accountId))[0].id).not.toBe((await serversOf(b.accountId))[0].id);
      const seen = await withTenant(appUserPool, a.accountId, a.userId, async (c) => (await c.query(`SELECT id FROM managed_servers`)).rows);
      expect(seen).toHaveLength(1);
    });
  });
});
