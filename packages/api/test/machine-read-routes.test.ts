import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { MachineOpsError, connectHetznerCredential, machineKekSource } from '@fx/model-connection';
import { createHetznerCredentialProbe } from '../../hetzner/src/index.js';
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from '../../hetzner/test/helpers/strictHetzner.js';
import { handleApiRequest } from '../src/handler.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { hetznerCredentialStatusSchema } from '../src/routes/machine-credential.js';
import { catalogSchema, serverListSchema, serverSchema } from '../src/routes/machine-servers.js';
import { CATALOG_TTL_MS, catalogDeps, clearCatalogCache, getCatalog, resolvePreset, type CatalogType } from '../src/machines/catalog.js';
import { getServer, listServers, machineServerDeps } from '../src/machines/servers.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const API = 'http://localhost/api/v1';
const ORIGIN = 'https://cloud.example.test';
const newToken = (): string => randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(64, 'x').slice(0, 64);
const LIVE = { currency: 'EUR', hourly_gross: '0.0070', monthly_gross: '4.5101', ipv4_monthly_gross: '0.5950' };
type Who = { accountId: string; userId: string };

/** D#845 MC-10b0: the three machine read routes, through the real handler, a real database and the strict Hetzner fake. Nothing here can reach the real Hetzner API. */
describe('machine read routes', () => {
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
    fake = await startStrictHetzner(world);
    const kek = machineKekSource({ FX_MACHINE_KEK_V1: randomBytes(32).toString('base64') });
    machineServerDeps.getKek = () => kek;
    machineServerDeps.getOrigin = () => ORIGIN;
    machineServerDeps.hetznerOptions = () => ({ maxRetries: 0, timeoutMs: 2000, sleep: async () => undefined, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
    clearCatalogCache();
    catalogDeps.now = () => Date.now();
  });
  afterEach(async () => {
    Object.assign(machineServerDeps, defaults);
    catalogDeps.now = () => Date.now();
    await fake.close();
  });

  const probe = () => createHetznerCredentialProbe({ maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
  async function owner(opts: { connect?: boolean; role?: 'owner' | 'admin' } = {}): Promise<Who> {
    const who = await seedAccountWithMember(admin, { role: opts.role ?? 'owner' });
    if (opts.connect !== false) await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: probe() }, { token });
    return who;
  }
  async function member(accountId: string): Promise<Who> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, userId]);
    return { accountId, userId };
  }
  async function call(who: Who | null, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; keepLimits?: boolean; pool?: Pool } = {}): Promise<Response> {
    if (!opts.keepLimits) await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const h = new Headers({ ...(who ? { cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` } : {}), ...opts.headers });
    if (opts.body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`${API}${path}`, { method, headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), opts.pool ?? appUserPool, platformOpsPool, ROUTES);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: each test asserts the shape of the reply it reads
  const getJson = async (who: Who, path: string) => { const r = await call(who, 'GET', path); return { status: r.status, body: (await r.json()) as Record<string, any> }; };
  const catalogCalls = () => world.requests.filter((r) => r.path.startsWith('/v1/server_types')).length;
  let n = 0;
  const makeServer = (who: Who) => call(who, 'POST', '/machine-servers', { body: { server_type: 'cx22', location: 'fsn1', quoted: LIVE }, headers: { 'idempotency-key': `read-${++n}-${randomUUID()}` } });

  describe('the routes', () => {
    it('are session-only; the catalog, credential and list reads are owner-or-admin; the catalog is limited like the quote', () => {
      const by = (id: string) => ROUTES.find((r) => r.operationId === id)!;
      for (const id of ['getHetznerCredential', 'getHetznerCatalog', 'listHetznerServers']) expect(effectivePrincipals(by(id)), id).toEqual(['session']);
      expect(by('getHetznerCredential')).toMatchObject({ method: 'GET', path: '/api/v1/machine-credentials/hetzner', minRole: 'admin' });
      expect(by('getHetznerCatalog')).toMatchObject({ method: 'GET', path: '/api/v1/machine-servers/catalog', minRole: 'admin', sessionLimit: { name: 'machine-server-quote' } });
      expect(by('listHetznerServers')).toMatchObject({ method: 'GET', path: '/api/v1/machine-servers', minRole: 'admin' });
    });

    it('answer 401 with no session and 403 to an API token holding every scope; a plain member is 403 on the credential, the catalog and the list; nothing reaches Hetzner', async () => {
      const who = await owner();
      const plain = await member(who.accountId);
      world.requests.length = 0;
      for (const p of ['/machine-credentials/hetzner', '/machine-servers/catalog', '/machine-servers']) expect((await call(null, 'GET', p)).status, p).toBe(401);
      expect((await call(plain, 'GET', '/machine-credentials/hetzner')).status).toBe(403);
      expect((await call(plain, 'GET', '/machine-servers/catalog')).status).toBe(403);
      expect((await call(plain, 'GET', '/machine-servers')).status).toBe(403);
      const plaintext = generateToken();
      await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
      for (const p of ['/machine-credentials/hetzner', '/machine-servers/catalog', '/machine-servers']) {
        const res = await handleApiRequest(new Request(`${API}${p}`, { headers: { authorization: `Bearer ${plaintext}` } }), appUserPool, platformOpsPool, ROUTES);
        expect(res.status, p).toBe(403);
      }
      expect(world.requests).toEqual([]);
    });
  });

  describe('GET /machine-credentials/hetzner', () => {
    it('is 200 `none` with no token (never 404), `connected` with the last four characters and never the token, `invalid` after Hetzner refuses it, and `none` again once removed', async () => {
      const who = await owner({ connect: false });
      const none = await getJson(who, '/machine-credentials/hetzner');
      expect(none).toEqual({ status: 200, body: { status: 'none', token_hint: null, unlabelled_server_count: null } });

      await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: probe() }, { token });
      const res = await call(who, 'GET', '/machine-credentials/hetzner');
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(token);
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(hetznerCredentialStatusSchema.safeParse(body).success).toBe(true);
      expect(body).toEqual({ status: 'connected', token_hint: token.slice(-4), unlabelled_server_count: null });

      await admin.query(`UPDATE machine_provider_credentials SET status = 'invalid' WHERE account_id = $1`, [who.accountId]);
      expect((await getJson(who, '/machine-credentials/hetzner')).body).toMatchObject({ status: 'invalid', token_hint: token.slice(-4) });

      expect((await call(who, 'DELETE', '/machine-credentials/hetzner')).status).toBe(204);
      expect((await getJson(who, '/machine-credentials/hetzner')).body).toEqual({ status: 'none', token_hint: null, unlabelled_server_count: null });
    });

    it("never shows another account's token: the same call is `none` for an account with none, and the row is not returned through the RLS-bypassing client under a foreign id either", async () => {
      const a = await owner();
      const b = await owner({ connect: false });
      expect((await getJson(b, '/machine-credentials/hetzner')).body.status).toBe('none');
      expect((await getJson(a, '/machine-credentials/hetzner')).body.status).toBe('connected');
      // The admin pool ignores row security: only the route's own account predicate can keep a's row out of b's answer.
      const viaAdmin = await call(b, 'GET', '/machine-credentials/hetzner', { pool: adminPool });
      expect((await viaAdmin.json()) as Record<string, unknown>).toMatchObject({ status: 'none', token_hint: null });
      expect(world.requests).not.toContainEqual(expect.objectContaining({ path: '/v1/servers', method: 'POST' }));
    });
  });

  describe('GET /machine-servers', () => {
    it('answers the account\'s servers, newest first, each exactly as GET /{id} answers it, and not a deleted one or another account\'s', async () => {
      const a = await owner();
      const other = await owner();
      const first = (await (await makeServer(a)).json()) as { id: string };
      const second = (await (await makeServer(a)).json()) as { id: string };
      const gone = (await (await makeServer(a)).json()) as { id: string };
      await makeServer(other);
      await admin.query(`UPDATE managed_servers SET status = 'deleted', deleted_at = now(), deleted_by = $2 WHERE id = $1`, [gone.id, a.userId]);
      const res = await getJson(a, '/machine-servers');
      expect(res.status).toBe(200);
      expect(serverListSchema.safeParse(res.body).success).toBe(true);
      const ids = (res.body.servers as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toEqual([second.id, first.id]);
      for (const s of res.body.servers as Array<{ id: string }>) expect(s).toEqual((await getJson(a, `/machine-servers/${s.id}`)).body);
      expect((res.body.servers as Array<Record<string, unknown>>)[0]).toHaveProperty('price');
      const otherIds = (await getJson(other, '/machine-servers')).body.servers.map((s: { id: string }) => s.id);
      expect(otherIds).toHaveLength(1);
      expect(otherIds).not.toContain(first.id);
    });

    it('is an empty list for an account with none, and through the RLS-bypassing client a foreign account\'s servers are not returned', async () => {
      const a = await owner();
      const b = await owner();
      await makeServer(a);
      expect((await getJson(b, '/machine-servers')).body).toEqual({ servers: [] });
      expect(await listServers({ pool: adminPool, principal: b })).toEqual([]);
      expect(await listServers({ pool: adminPool, principal: { accountId: randomUUID(), userId: b.userId } })).toEqual([]);
      expect((await listServers({ pool: adminPool, principal: a })).length).toBe(1);
    });
  });

  describe('the server view: runner, status time, kept, last contact and placed projects', () => {
    const REPLICA = 'SET session_replication_role = replica';
    const seedRepo = async (accountId: string, name: string | null): Promise<string> => {
      const id = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, $5)`, [id, accountId, Math.floor(Math.random() * 1e9) + 1, name === null ? null : 'acme', name]);
      return id;
    };
    const place = (accountId: string, repoId: string, runnerId: string) => admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repoId, accountId, runnerId]);
    /** A server of `who` that has registered a runner: returns both ids. */
    async function serverWithRunner(who: Who): Promise<{ id: string; runnerId: string }> {
      const id = ((await (await makeServer(who)).json()) as { id: string }).id;
      const runnerId = await insertRunner(admin, who.accountId, who.userId);
      await admin.query(`UPDATE managed_servers SET runner_id = $3 WHERE account_id = $1 AND id = $2`, [who.accountId, id, runnerId]);
      return { id, runnerId };
    }

    it('answers runner_id (null before the runner registers), status_at, kept and last_seen_at, the same on the list and on GET /{id}', async () => {
      const a = await owner();
      const fresh = (await getJson(a, `/machine-servers/${((await (await makeServer(a)).json()) as { id: string }).id}`)).body;
      expect(fresh).toMatchObject({ runner_id: null, kept: false, last_seen_at: null });
      expect(new Date(fresh.status_at as string).toISOString()).toBe(fresh.status_at);
      expect(fresh.placed_projects).toEqual([]);

      const s = await serverWithRunner(a);
      await admin.query(`UPDATE runners SET last_seen_at = timestamptz '2026-11-24T10:00:00Z' WHERE id = $1`, [s.runnerId]);
      await admin.query(`UPDATE managed_servers SET status = 'orphaned', kept_at = now(), kept_by = $3, status_at = timestamptz '2026-11-24T09:00:00Z' WHERE account_id = $1 AND id = $2`, [a.accountId, s.id, a.userId]);
      const one = await getJson(a, `/machine-servers/${s.id}`);
      expect(serverSchema.safeParse(one.body).success).toBe(true);
      expect(one.body).toMatchObject({ runner_id: s.runnerId, kept: true, last_seen_at: '2026-11-24T10:00:00.000Z', status_at: '2026-11-24T09:00:00.000Z' });
      const listed = (await getJson(a, '/machine-servers')).body.servers.find((x: { id: string }) => x.id === s.id);
      expect(listed).toEqual(one.body);
    });

    it("lists the projects placed on that server's runner only: not the account's other repos, not another server's, and a repo with no name shows its product label", async () => {
      const a = await owner();
      const one = await serverWithRunner(a);
      const two = await serverWithRunner(a);
      const named = await seedRepo(a.accountId, 'widgets');
      const bare = await seedRepo(a.accountId, null);
      await seedRepo(a.accountId, 'unplaced');
      const elsewhere = await seedRepo(a.accountId, 'elsewhere');
      await place(a.accountId, named, one.runnerId);
      await place(a.accountId, elsewhere, two.runnerId);
      expect((await getJson(a, `/machine-servers/${one.id}`)).body.placed_projects).toEqual([{ repo_id: named, name: 'acme/widgets' }]);
      expect((await getJson(a, `/machine-servers/${two.id}`)).body.placed_projects).toEqual([{ repo_id: elsewhere, name: 'acme/elsewhere' }]);
      await admin.query('DELETE FROM project_placements WHERE repo_id = $1', [named]);
      await place(a.accountId, bare, one.runnerId);
      expect((await getJson(a, `/machine-servers/${one.id}`)).body.placed_projects).toEqual([{ repo_id: bare, name: 'team' }]);
    });

    it("never shows another account's runner or repo, read through the RLS-bypassing client: rows made inconsistent on purpose, so only the queries' own account predicates stand in the way", async () => {
      const a = await owner();
      const b = await owner();
      const mine = await serverWithRunner(a);
      const foreignRunner = await insertRunner(admin, b.accountId, b.userId);
      await admin.query(`UPDATE runners SET last_seen_at = now() WHERE id = $1`, [foreignRunner]);
      const foreignRepo = await seedRepo(b.accountId, 'secret');
      await place(b.accountId, foreignRepo, foreignRunner);
      const own = await seedRepo(a.accountId, 'own');
      // a's server points at b's runner; a's placements point at b's repo, and a's repo at b's runner. The composite foreign keys forbid all of it, so the checks are switched off for these writes only.
      await admin.query(REPLICA);
      try {
        await admin.query(`UPDATE managed_servers SET runner_id = $3 WHERE account_id = $1 AND id = $2`, [a.accountId, mine.id, foreignRunner]);
        await place(a.accountId, foreignRepo, mine.runnerId);
        await place(a.accountId, own, foreignRunner);
      } finally {
        await admin.query('RESET session_replication_role');
      }
      const view = await getServer({ pool: adminPool, principal: { ...a, role: 'owner' } }, mine.id);
      expect(view).toMatchObject({ runner_id: foreignRunner, last_seen_at: null });
      expect(JSON.stringify(view)).not.toContain(foreignRepo);
      expect(JSON.stringify(view)).not.toContain('secret');
      expect(view!.placed_projects!.map((p) => p.name)).toEqual(['acme/own']);
      // With a's runner back, b's repo placed there under a's account still does not show.
      await admin.query(`UPDATE managed_servers SET runner_id = $3 WHERE account_id = $1 AND id = $2`, [a.accountId, mine.id, mine.runnerId]);
      expect((await getServer({ pool: adminPool, principal: { ...a, role: 'owner' } }, mine.id))!.placed_projects).toEqual([]);
      // A foreign account (or an unknown one) reads none of a's servers.
      expect(await getServer({ pool: adminPool, principal: { ...b, role: 'owner' } }, mine.id)).toBeNull();
      expect(await listServers({ pool: adminPool, principal: { ...b, role: 'owner' } })).toEqual([]);
      expect(await listServers({ pool: adminPool, principal: { accountId: randomUUID(), userId: b.userId, role: 'owner' } })).toEqual([]);
    });

    it('sends placed_projects to an owner and an admin and no such key at all to a member or a caller that names no role; the routes stay owner-or-admin', async () => {
      const a = await owner();
      const s = await serverWithRunner(a);
      await place(a.accountId, await seedRepo(a.accountId, 'widgets'), s.runnerId);
      const adminWho = await member(a.accountId);
      await admin.query(`UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`, [a.accountId, adminWho.userId]);
      for (const role of ['owner', 'admin'] as const) {
        const v = await getServer({ pool: adminPool, principal: { ...a, role } }, s.id);
        expect(v!.placed_projects).toHaveLength(1);
        expect((await listServers({ pool: adminPool, principal: { ...a, role } }))[0]!.placed_projects).toHaveLength(1);
      }
      expect((await getJson(adminWho, `/machine-servers/${s.id}`)).body.placed_projects).toHaveLength(1);
      const plain = await member(a.accountId);
      for (const principal of [{ ...a, role: 'member' as const }, { ...a }]) {
        const v = await getServer({ pool: adminPool, principal }, s.id);
        expect(v).not.toHaveProperty('placed_projects');
        expect(v).toMatchObject({ id: s.id, runner_id: s.runnerId });
        const l = await listServers({ pool: adminPool, principal });
        expect(l).toHaveLength(1);
        expect(l[0]).not.toHaveProperty('placed_projects');
      }
      expect((await call(plain, 'GET', `/machine-servers/${s.id}`)).status).toBe(403);
    });
  });

  describe('GET /machine-servers/catalog', () => {
    it('answers the live locations, types, availability and prices, the Small size for the chosen location, and never the token', async () => {
      const who = await owner();
      const res = await call(who, 'GET', '/machine-servers/catalog?location=fsn1');
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(token);
      const body = JSON.parse(text) as ReturnType<typeof catalogSchema.parse>;
      expect(catalogSchema.safeParse(body).success).toBe(true);
      expect(body.currency).toBe('EUR');
      expect(body.locations.map((l) => l.name)).toEqual(['fsn1', 'nbg1']);
      const cx22 = body.server_types.find((t) => t.name === 'cx22')!;
      expect(cx22).toMatchObject({ cores: 2, memory_gb: 4, architecture: 'x86', cpu_type: 'shared' });
      // The same live prices the quote answers.
      expect(cx22.locations.find((l) => l.location === 'fsn1')).toEqual({ location: 'fsn1', available: true, hourly_gross: LIVE.hourly_gross, monthly_gross: LIVE.monthly_gross, ipv4_monthly_gross: LIVE.ipv4_monthly_gross });
      expect(body.server_types.find((t) => t.name === 'cx32')!.locations.map((l) => [l.location, l.available])).toEqual([['fsn1', true], ['nbg1', false]]);
      expect(body.location).toBe('fsn1');
      // cx32 (4 vCPU, 8 GB) is the cheapest available type that fits Small; nothing in the live list reaches Medium.
      expect(body.presets).toEqual({ small: 'cx32', medium: null });
      // Where cx32 is not available there is no Small; with no location, or a location Hetzner does not list, there is no preset.
      expect((await getJson(who, '/machine-servers/catalog?location=nbg1')).body.presets).toEqual({ small: null, medium: null });
      expect((await getJson(who, '/machine-servers/catalog?location=zzz9')).body.presets).toEqual({ small: null, medium: null });
      expect((await getJson(who, '/machine-servers/catalog')).body).toMatchObject({ location: null, presets: { small: null, medium: null } });
      expect((await call(who, 'GET', '/machine-servers/catalog?location=Mars!')).status).toBe(422);
    });

    it('is cached for five minutes per account and refetched after, and the preset follows the location without another Hetzner call', async () => {
      const a = await owner();
      const b = await owner();
      let t = 1_800_000_000_000;
      catalogDeps.now = () => t;
      await call(a, 'GET', '/machine-servers/catalog?location=fsn1');
      await call(a, 'GET', '/machine-servers/catalog?location=nbg1');
      expect(catalogCalls()).toBe(1);
      // Another account has its own entry.
      await call(b, 'GET', '/machine-servers/catalog');
      expect(catalogCalls()).toBe(2);
      t += CATALOG_TTL_MS - 1;
      await call(a, 'GET', '/machine-servers/catalog');
      expect(catalogCalls()).toBe(2);
      t += 1;
      const fresh = await getJson(a, '/machine-servers/catalog');
      expect(catalogCalls()).toBe(3);
      expect(fresh.body.fetched_at).toBe(new Date(t).toISOString());
      // A price that moved at Hetzner shows after the window and not before.
      world.priceMonthlyDelta = 1;
      expect((await getJson(a, '/machine-servers/catalog')).body.server_types[0].locations[0].monthly_gross).toBe('4.5101');
      t += CATALOG_TTL_MS;
      expect((await getJson(a, '/machine-servers/catalog')).body.server_types[0].locations[0].monthly_gross).toBe('5.7001');
    });

    it('is refused without a token (404 not_connected) and with one Hetzner has refused (409 credential_invalid) before the cache is read, and a removed token is not served from the cache', async () => {
      const none = await owner({ connect: false });
      const res = await call(none, 'GET', '/machine-servers/catalog');
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'not_connected' } });
      expect(world.requests).toEqual([]);

      const who = await owner();
      expect((await call(who, 'GET', '/machine-servers/catalog')).status).toBe(200);
      expect((await call(who, 'DELETE', '/machine-credentials/hetzner')).status).toBe(204);
      world.requests.length = 0;
      expect((await call(who, 'GET', '/machine-servers/catalog')).status).toBe(404);
      // A new token is a new credential: its answer is fetched, not the removed token's cached one.
      await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: probe() }, { token });
      world.requests.length = 0;
      expect((await call(who, 'GET', '/machine-servers/catalog')).status).toBe(200);
      expect(catalogCalls()).toBe(1);
      await admin.query(`UPDATE machine_provider_credentials SET status = 'invalid' WHERE account_id = $1 AND removed_at IS NULL`, [who.accountId]);
      const invalid = await call(who, 'GET', '/machine-servers/catalog');
      expect(invalid.status).toBe(409);
      expect(await invalid.json()).toMatchObject({ error: { code: 'credential_invalid' } });
    });

    it('maps a Hetzner failure to the closed code with fixed copy, caches nothing from it, and marks a refused token invalid', async () => {
      const who = await owner();
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ status: 429, code: 'rate_limit_exceeded', message: 'RAW-HETZNER-WORDS' }, 429, 'hetzner_rate_limit_exceeded'],
        [{ status: 500, code: 'server_error', message: 'RAW-HETZNER-WORDS' }, 503, 'hetzner_server_error'],
        [{ drop: true }, 503, 'hetzner_unavailable'],
      ];
      for (const [failure, status, code] of cases) {
        world.failNext.push({ ...failure, path: '/server_types' });
        const res = await call(who, 'GET', '/machine-servers/catalog');
        const text = await res.text();
        expect(res.status, code).toBe(status);
        expect(JSON.parse(text)).toMatchObject({ error: { code } });
        expect(text).not.toContain('RAW-HETZNER-WORDS');
        expect(text).not.toContain(token);
      }
      // None of those was cached: the next call fetches and succeeds.
      expect((await call(who, 'GET', '/machine-servers/catalog')).status).toBe(200);
      clearCatalogCache();
      world.failNext.push({ status: 401, code: 'unauthorized', path: '/locations' });
      const refused = await call(who, 'GET', '/machine-servers/catalog');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'hetzner_unauthorized' } });
      expect((await getJson(who, '/machine-credentials/hetzner')).body.status).toBe('invalid');
    });

    it('is limited like the quote: the 21st call in a minute is 429', async () => {
      const who = await owner();
      await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
      const seen: number[] = [];
      for (let i = 0; i < 21; i++) seen.push((await call(who, 'GET', '/machine-servers/catalog', { keepLimits: true })).status);
      expect(seen.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(seen[20]).toBe(429);
    });

    it("never answers from another account's cache or credential: an account with no token is refused even when another has a cached catalog, through the RLS-bypassing client too", async () => {
      const a = await owner();
      const b = await owner({ connect: false });
      expect((await call(a, 'GET', '/machine-servers/catalog')).status).toBe(200);
      expect((await call(b, 'GET', '/machine-servers/catalog')).status).toBe(404);
      await expect(getCatalog({ pool: adminPool, principal: b }, {})).rejects.toBeInstanceOf(MachineOpsError);
      await expect(getCatalog({ pool: adminPool, principal: { accountId: randomUUID(), userId: b.userId } }, {})).rejects.toMatchObject({ code: 'not_connected' });
    });
  });

  describe('Small and Medium come from the live list', () => {
    const t = (name: string, cores: number, memory_gb: number, monthly: string, over: Partial<CatalogType> = {}, available = true): CatalogType => ({
      name, description: name, cores, memory_gb, disk_gb: 80, architecture: 'x86', cpu_type: 'shared',
      locations: [{ location: 'fsn1', available, hourly_gross: '0.01', monthly_gross: monthly, ipv4_monthly_gross: '0.5' }], ...over,
    });
    const SMALL = { cores: 4, memory: 8 };
    const MEDIUM = { cores: 8, memory: 16 };

    it('picks the cheapest available x86 shared type over the floor, by price and not by name or size', () => {
      const types = [t('a-big', 16, 32, '30.0'), t('z-small', 4, 8, '7.0'), t('m-mid', 8, 16, '12.5'), t('b-small', 4, 8, '7.5'), t('tiny', 2, 4, '3.0')];
      expect(resolvePreset(types, 'fsn1', SMALL)).toBe('z-small');
      expect(resolvePreset(types, 'fsn1', MEDIUM)).toBe('m-mid');
      // A cheaper type that is bigger than the floor still wins, so the answer is not a named size.
      expect(resolvePreset([t('big', 8, 16, '5.0'), t('exact', 4, 8, '7.0')], 'fsn1', SMALL)).toBe('big');
      // Prices compare as decimals: 10.0 is dearer than 9.5.
      expect(resolvePreset([t('ten', 4, 8, '10.0'), t('nine', 4, 8, '9.5')], 'fsn1', SMALL)).toBe('nine');
      // A tie goes to the lower name.
      expect(resolvePreset([t('b', 4, 8, '7.0'), t('a', 4, 8, '7.0')], 'fsn1', SMALL)).toBe('a');
    });

    it('compares prices of any length exactly: 16 places, the cheaper type has the later name', () => {
      const small = [t('a-dear', 4, 8, '7.0000000000000002'), t('z-cheap', 4, 8, '7.0000000000000001')];
      expect(resolvePreset(small, 'fsn1', SMALL)).toBe('z-cheap');
      expect(resolvePreset([...small].reverse(), 'fsn1', SMALL)).toBe('z-cheap');
      const medium = [t('a-dear', 8, 16, '12.0000000000000002'), t('z-cheap', 8, 16, '12.0000000000000001')];
      expect(resolvePreset(medium, 'fsn1', MEDIUM)).toBe('z-cheap');
      // Different lengths: 7.5 equals 7.50000000000000, and the tie goes to the lower name.
      expect(resolvePreset([t('b', 4, 8, '7.5'), t('a', 4, 8, '7.50000000000000')], 'fsn1', SMALL)).toBe('a');
    });

    it('skips what is not available there, not x86, not shared, under either floor, or not priced there; and is null when nothing fits', () => {
      expect(resolvePreset([t('gone', 4, 8, '1.0', {}, false)], 'fsn1', SMALL)).toBeNull();
      expect(resolvePreset([t('arm', 4, 8, '1.0', { architecture: 'arm' })], 'fsn1', SMALL)).toBeNull();
      expect(resolvePreset([t('ded', 4, 8, '1.0', { cpu_type: 'dedicated' })], 'fsn1', SMALL)).toBeNull();
      expect(resolvePreset([t('cores', 3, 8, '1.0'), t('mem', 4, 7, '1.0')], 'fsn1', SMALL)).toBeNull();
      expect(resolvePreset([t('cores', 7, 16, '1.0'), t('mem', 8, 15, '1.0')], 'fsn1', MEDIUM)).toBeNull();
      expect(resolvePreset([t('here', 4, 8, '1.0')], 'nbg1', SMALL)).toBeNull();
      expect(resolvePreset([], 'fsn1', SMALL)).toBeNull();
    });
  });
});
