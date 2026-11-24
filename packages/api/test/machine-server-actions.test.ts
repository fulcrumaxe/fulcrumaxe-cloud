import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { connectHetznerCredential, machineKekSource, removeHetznerCredential } from '@fx/model-connection';
import { createHetznerCredentialProbe } from '../../hetzner/src/index.js';
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from '../../hetzner/test/helpers/strictHetzner.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { machineServerDeps, type ServerCtx } from '../src/machines/servers.js';
import { sweepOrphans } from '../src/machines/lifecycle.js';
import { deleteOrphan, keepOrphan, rebootManagedServer } from '../src/machines/actions.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const BASE = 'http://localhost/api/v1/machine-servers';
const newToken = (): string => randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(64, 'x').slice(0, 64);
type Who = { accountId: string; userId: string };
interface Reply { id: string; status: string; kept: boolean; already_kept: boolean; already_deleted: boolean; rebooting: boolean; error: { code: string } }

/** D#845 MC-7b: reboot, keep it, and delete an orphan, through the real handler, a real database and the strict Hetzner fake. Nothing here can reach the real Hetzner API. */
describe('machine servers: reboot, keep and delete an orphan', () => {
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
    machineServerDeps.getOrigin = () => 'https://cloud.example.test';
    machineServerDeps.hetznerOptions = () => ({ maxRetries: 0, timeoutMs: 2000, sleep: async () => undefined, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
    machineServerDeps.failRunnerLeases = async () => ({ runIds: [], complete: true });
    machineServerDeps.actionWaitMs = 1;
  });
  afterEach(async () => {
    Object.assign(machineServerDeps, defaults);
    delete machineServerDeps.startStatusWorker;
    delete machineServerDeps.removeProjects;
    await fake.close();
  });

  async function owner(role: 'owner' | 'admin' = 'owner'): Promise<Who> {
    const who = await seedAccountWithMember(admin, { role });
    await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: createHetznerCredentialProbe({ maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } }) }, { token });
    world.requests.length = 0;
    return who;
  }
  async function call(who: Who | null, method: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const h = new Headers({ ...(who ? { cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` } : {}), ...headers });
    return handleApiRequest(new Request(`${BASE}${path}`, { method, headers: h }), appUserPool, platformOpsPool, ROUTES);
  }
  const ctxOf = (who: Who): ServerCtx => ({ pool: appUserPool, principal: who });
  /** The same service with the RLS-bypassing admin pool: only the explicit account predicate stands between a foreign id and a row. */
  const bypassCtx = (who: Who): ServerCtx => ({ pool: adminPool, principal: who });
  const row = async (id: string) => (await admin.query(`SELECT * FROM managed_servers WHERE id = $1`, [id])).rows[0];
  const audit = async (accountId: string, action: string) => Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [accountId, action])).rows[0].n);
  const credOf = async (accountId: string) => (await admin.query<{ id: string }>(`SELECT id FROM machine_provider_credentials WHERE account_id = $1 AND removed_at IS NULL`, [accountId])).rows[0]!.id;
  const reboots = () => world.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/actions/reboot'));
  const deletes = () => world.requests.filter((r) => r.method === 'DELETE');
  const labelled = (n: number, labels: Record<string, string>) => ({ id: n, name: `box-${n}`, status: 'running', created: '2026-01-01T00:00:00+00:00', labels, public_net: { ipv4: { ip: '203.0.113.9' }, ipv6: null, firewalls: [] }, server_type: { id: 1, name: 'cx22' }, location: { id: 1, name: 'fsn1' } });
  const OURS = (): Record<string, string> => ({ 'fx-managed': '1', 'fx-server': randomUUID() });

  /** A server row as a create leaves it, in the given status, with a Hetzner server of that id in the fake. */
  async function seedServer(who: Who, status: string, providerId: number | null = 8000 + Math.floor(Math.random() * 1000)): Promise<string> {
    const credId = await credOf(who.accountId);
    const tok = randomUUID();
    await admin.query(`INSERT INTO runner_provisioning_tokens (id, account_id, created_by, token_sha256, credential_mode, expires_at) VALUES ($1, $2, $3, $4, 'subscription', now() + interval '1 hour')`, [tok, who.accountId, who.userId, randomBytes(32).toString('hex')]);
    const deleted = status === 'deleted';
    const r = await admin.query<{ id: string }>(
      `INSERT INTO managed_servers (account_id, kind, credential_id, name, status, created_by, provisioning_token_id, provider_server_id ${deleted ? ', deleted_at, deleted_by' : ''})
       VALUES ($1, 'hetzner_cloud', $2, 'box', $3, $4, $5, $6 ${deleted ? ', now(), $4' : ''}) RETURNING id`, [who.accountId, credId, status, who.userId, tok, providerId === null ? null : String(providerId)]);
    if (providerId !== null) world.servers.push(labelled(providerId, { 'fx-managed': '1', 'fx-server': r.rows[0]!.id }));
    return r.rows[0]!.id;
  }
  /** An orphan, found the way the sweep finds one. */
  async function orphan(who: Who, providerId: number, labels: Record<string, string> = OURS()): Promise<string> {
    world.servers.push(labelled(providerId, labels));
    await sweepOrphans(ctxOf(who), await credOf(who.accountId));
    return (await admin.query<{ id: string }>(`SELECT id FROM managed_servers WHERE account_id = $1 AND provider_server_id = $2`, [who.accountId, String(providerId)])).rows[0]!.id;
  }

  describe.each([['reboot', 'rebootHetznerServer'], ['keep', 'keepOrphanedServer'], ['delete-orphan', 'deleteOrphanedServer']] as const)('POST /{id}/%s', (verb, operationId) => {
    it('is session-only and owner-or-admin: no session 401, a member 403, an API token 403; a bad id is 400 and another account\'s server is 404 with nothing called', async () => {
      const a = await owner();
      const b = await owner();
      const id = verb === 'reboot' ? await seedServer(a, 'ready') : await orphan(a, 7301);
      const route = ROUTES.find((r) => r.method === 'POST' && r.path === `/api/v1/machine-servers/{id}/${verb}`)!;
      expect(route).toMatchObject({ operationId, minRole: 'admin', idempotency: 'never' });
      expect(route.principals).toBeUndefined();
      expect(route.sessionLimit).toBeDefined();
      world.requests.length = 0;
      expect((await call(null, 'POST', `/${id}/${verb}`)).status).toBe(401);
      const memberId = randomUUID();
      await seedUser(admin, memberId);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
      expect((await call({ accountId: a.accountId, userId: memberId }, 'POST', `/${id}/${verb}`)).status).toBe(403);
      const plaintext = generateToken();
      await insertApiToken(appUserPool, { accountId: a.accountId, createdBy: a.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
      expect((await call(null, 'POST', `/${id}/${verb}`, { authorization: `Bearer ${plaintext}` })).status).toBe(403);
      expect((await call(a, 'POST', `/not-a-uuid/${verb}`)).status).toBe(400);
      expect((await call(b, 'POST', `/${id}/${verb}`)).status).toBe(404);
      expect((await call(a, 'POST', `/${randomUUID()}/${verb}`)).status).toBe(404);
      expect(world.requests).toEqual([]);
      expect(await audit(a.accountId, 'server.orphan_kept')).toBe(0);
      expect((await row(id)).kept_at).toBeNull();
    });

    it('an admin may do it as well as the owner (the route is not owner-only)', async () => {
      const who = await owner('admin');
      const id = verb === 'reboot' ? await seedServer(who, 'ready') : await orphan(who, 7302);
      expect((await call(who, 'POST', `/${id}/${verb}`)).status).toBe(200);
    });
  });

  describe('reboot', () => {
    it('sends Hetzner\'s reboot action for that one server, opens the token with the server named in the audit row, and changes nothing on the row', async () => {
      const who = await owner();
      const id = await seedServer(who, 'ready', 8101);
      const other = await seedServer(who, 'ready', 8102);
      const res = await call(who, 'POST', `/${id}/reboot`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id, status: 'ready', rebooting: true });
      expect(reboots().map((r) => r.path)).toEqual(['/v1/servers/8101/actions/reboot']);
      expect((await row(id)).status).toBe('ready');
      expect((await row(other)).status).toBe('ready');
      const unsealed = (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'server.unsealed'`, [who.accountId])).rows.map((r) => JSON.stringify(r.payload));
      expect(unsealed.some((d) => d.includes(id))).toBe(true);
    });

    it.each(['registering', 'needs_claude_login'])('is allowed from %s', async (status) => {
      const who = await owner();
      const id = await seedServer(who, status);
      expect((await call(who, 'POST', `/${id}/reboot`)).status).toBe(200);
      expect(reboots()).toHaveLength(1);
    });

    it.each(['creating', 'booting', 'installing', 'deleting', 'deleted', 'failed', 'orphaned'])('is refused from %s with 409 server_not_rebootable, before the token is opened or Hetzner is called', async (status) => {
      const who = await owner();
      const id = await seedServer(who, status);
      const before = await audit(who.accountId, 'server.unsealed');
      const res = await call(who, 'POST', `/${id}/reboot`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'server_not_rebootable']);
      expect(world.requests).toEqual([]);
      expect(await audit(who.accountId, 'server.unsealed')).toBe(before);
    });

    it('is refused for a row with no Hetzner server id', async () => {
      const who = await owner();
      const id = await seedServer(who, 'ready', null);
      const res = await call(who, 'POST', `/${id}/reboot`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'server_not_rebootable']);
      expect(world.requests).toEqual([]);
    });

    it('answers a server Hetzner no longer has with 409 server_gone', async () => {
      const who = await owner();
      const id = await seedServer(who, 'ready', 8110);
      world.servers.length = 0;
      const res = await call(who, 'POST', `/${id}/reboot`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'server_gone']);
    });

    it.each([
      [423, 'locked', 409, 'hetzner_locked'],
      [429, 'rate_limit_exceeded', 429, 'hetzner_rate_limit_exceeded'],
      [500, 'server_error', 503, 'hetzner_server_error'],
    ])('maps Hetzner %i %s to fixed copy and %i %s, without Hetzner\'s words', async (status, code, want, wantCode) => {
      const who = await owner();
      const id = await seedServer(who, 'ready', 8120);
      world.failNext.push({ status, code, message: 'SECRET-HETZNER-WORDS', method: 'POST', path: '/servers/8120/actions/reboot' });
      const res = await call(who, 'POST', `/${id}/reboot`);
      const text = await res.text();
      expect([res.status, (JSON.parse(text) as Reply).error.code]).toEqual([want, wantCode]);
      expect(text).not.toContain('SECRET-HETZNER-WORDS');
    });

    it('a refused token (401) is 409 hetzner_unauthorized and marks the credential invalid; a malformed Hetzner answer is 503', async () => {
      const who = await owner();
      const id = await seedServer(who, 'ready', 8130);
      world.malformedAction = true;
      const bad = await call(who, 'POST', `/${id}/reboot`);
      expect(bad.status).toBe(503);
      world.malformedAction = false;
      world.tokens.clear();
      const res = await call(who, 'POST', `/${id}/reboot`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'hetzner_unauthorized']);
      expect((await admin.query(`SELECT status FROM machine_provider_credentials WHERE account_id = $1`, [who.accountId])).rows[0].status).toBe('invalid');
      // The next try does not reach Hetzner at all: the credential reads invalid.
      world.requests.length = 0;
      const again = await call(who, 'POST', `/${id}/reboot`);
      expect([again.status, ((await again.json()) as Reply).error.code]).toEqual([409, 'credential_invalid']);
      expect(world.requests).toEqual([]);
    });

    it('with the token removed the answer is 404 not_connected and nothing is called', async () => {
      const who = await owner();
      const id = await seedServer(who, 'ready', 8140);
      await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
      world.requests.length = 0;
      const res = await call(who, 'POST', `/${id}/reboot`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([404, 'not_connected']);
      expect(world.requests).toEqual([]);
    });

    it('is rate-limited per account by its own bucket', async () => {
      const who = await owner();
      const id = await seedServer(who, 'ready');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const h = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
        statuses.push((await handleApiRequest(new Request(`${BASE}/${id}/reboot`, { method: 'POST', headers: h }), appUserPool, platformOpsPool, ROUTES)).status);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
      await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    });

    it('tenant predicate: through the RLS-bypassing pool a foreign account id still finds no row and calls nothing', async () => {
      const a = await owner();
      const b = await owner();
      const id = await seedServer(a, 'ready');
      world.requests.length = 0;
      await expect(rebootManagedServer(bypassCtx(b), id)).rejects.toMatchObject({ status: 404, code: 'not_found' });
      expect(world.requests).toEqual([]);
    });
  });

  describe('keep', () => {
    it('marks the orphan kept, writes server.orphan_kept once, calls nothing at Hetzner, and a repeat or a double click writes nothing more', async () => {
      const who = await owner();
      const id = await orphan(who, 7401);
      const other = await orphan(who, 7402);
      world.requests.length = 0;
      const res = await call(who, 'POST', `/${id}/keep`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id, status: 'orphaned', kept: true, already_kept: false });
      expect(world.requests).toEqual([]);
      expect(await row(id)).toMatchObject({ status: 'orphaned', kept_by: who.userId });
      expect((await row(id)).kept_at).not.toBeNull();
      expect((await row(other)).kept_at).toBeNull();
      expect(await audit(who.accountId, 'server.orphan_kept')).toBe(1);
      const again = await call(who, 'POST', `/${id}/keep`);
      expect(((await again.json()) as Reply).already_kept).toBe(true);
      const both = await Promise.all([keepOrphan(ctxOf(who), other), keepOrphan(ctxOf(who), other)]);
      expect(both.map((b) => b.already_kept).sort()).toEqual([false, true]);
      expect(await audit(who.accountId, 'server.orphan_kept')).toBe(2);
      expect(world.requests).toEqual([]);
    });

    it.each(['creating', 'booting', 'ready', 'failed', 'deleting', 'deleted'])('is refused for a %s server with 409 not_an_orphan, and writes nothing', async (status) => {
      const who = await owner();
      const id = await seedServer(who, status);
      const res = await call(who, 'POST', `/${id}/keep`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'not_an_orphan']);
      expect((await row(id)).kept_at).toBeNull();
      expect(await audit(who.accountId, 'server.orphan_kept')).toBe(0);
    });

    it('is undone by deleting: a kept orphan can still be deleted, and a server that comes back is an orphan again that is not kept', async () => {
      const who = await owner();
      const id = await orphan(who, 7410);
      await keepOrphan(ctxOf(who), id);
      expect((await call(who, 'POST', `/${id}/delete-orphan`)).status).toBe(200);
      expect(await row(id)).toMatchObject({ status: 'deleted' });
      // The same server shows up again with our labels: the row is an orphan again, and the earlier keep does not carry over.
      world.servers.push(labelled(7410, OURS()));
      expect(await sweepOrphans(ctxOf(who), await credOf(who.accountId))).toEqual({ orphaned: 1, deleted: 0 });
      expect(await row(id)).toMatchObject({ status: 'orphaned', kept_at: null, kept_by: null });
    });

    it.each([['delete-orphan', 'POST', '/delete-orphan'], ['the ordinary DELETE', 'DELETE', '']] as const)('a kept orphan that still has its create token (the sweep returned it) can be deleted by %s', async (_n, method, suffix) => {
      const who = await owner();
      // A server a create made, which went `deleted` and then showed up at Hetzner again: the sweep makes it an orphan, and the row keeps its provisioning token.
      const id = await seedServer(who, 'deleted', 7440 + (method === 'POST' ? 0 : 1));
      expect(await sweepOrphans(ctxOf(who), await credOf(who.accountId))).toEqual({ orphaned: 1, deleted: 0 });
      expect((await row(id)).provisioning_token_id).not.toBeNull();
      expect((await keepOrphan(ctxOf(who), id)).kept).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'orphaned', kept_by: who.userId });
      const res = await call(who, method, `/${id}${suffix}`);
      expect(res.status).toBe(200);
      expect(await row(id)).toMatchObject({ status: 'deleted' });
      expect(world.servers).toEqual([]);
      expect(await audit(who.accountId, 'server.deleted')).toBe(1);
    });

    it('the database allows kept only on an orphan or its history, and both columns or neither', async () => {
      const who = await owner();
      const id = await seedServer(who, 'ready');
      await expect(admin.query(`UPDATE managed_servers SET kept_at = now(), kept_by = $2 WHERE id = $1`, [id, who.userId])).rejects.toMatchObject({ code: '23514' });
      const o = await orphan(who, 7420);
      await expect(admin.query(`UPDATE managed_servers SET kept_at = now() WHERE id = $1`, [o])).rejects.toMatchObject({ code: '23514' });
    });

    it('tenant predicate: through the RLS-bypassing pool a foreign account id finds no row and marks nothing', async () => {
      const a = await owner();
      const b = await owner();
      const id = await orphan(a, 7430);
      await expect(keepOrphan(bypassCtx(b), id)).rejects.toMatchObject({ status: 404 });
      expect((await row(id)).kept_at).toBeNull();
      expect(await audit(a.accountId, 'server.orphan_kept')).toBe(0);
    });

    it('tenant predicate on the write: even when the row was read as the caller\'s, the update names the account', async () => {
      const a = await owner();
      const b = await owner();
      const id = await orphan(a, 7440);
      // b's principal over the bypass pool, with a's row id: the guarded update must touch nothing.
      await expect(keepOrphan(bypassCtx(b), id)).rejects.toBeDefined();
      expect((await row(id)).kept_by).toBeNull();
    });
  });

  describe('delete an orphan', () => {
    it('deletes the server and then its labelled firewall, writes the audit row once, and a repeat calls nothing', async () => {
      const who = await owner();
      const made = await seedServerWithFirewall();
      const orphanId = await adopt(who, made);
      const keepSibling = await orphan(who, 7503);
      world.requests.length = 0;
      const res = await call(who, 'POST', `/${orphanId}/delete-orphan`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: orphanId, status: 'deleted', already_deleted: false });
      expect(world.servers.map((s) => s.id)).toEqual([7503]);
      expect(world.firewalls).toEqual([]);
      const order = deletes().map((d) => d.path.split('/')[2]);
      expect(order).toEqual(['servers', 'firewalls']);
      expect(await row(orphanId)).toMatchObject({ status: 'deleted' });
      expect((await row(keepSibling)).status).toBe('orphaned');
      expect(await audit(who.accountId, 'server.deleted')).toBe(1);
      world.requests.length = 0;
      const again = await call(who, 'POST', `/${orphanId}/delete-orphan`);
      expect(((await again.json()) as Reply).already_deleted).toBe(true);
      expect(world.requests).toEqual([]);
      expect(await audit(who.accountId, 'server.deleted')).toBe(1);
    });

    async function seedServerWithFirewall(): Promise<{ serverId: number; label: string }> {
      const label = randomUUID();
      world.firewalls.push({ id: 9001, name: 'fw', labels: { 'fx-managed': '1', 'fx-server': label }, created: '2026-01-01T00:00:00+00:00', rules: [], applied_to: [] });
      world.servers.push({ ...labelled(7501, { 'fx-managed': '1', 'fx-server': label }), public_net: { ipv4: { ip: '203.0.113.9' }, ipv6: null, firewalls: [] } });
      return { serverId: 7501, label };
    }
    async function adopt(who: Who, made: { serverId: number }): Promise<string> {
      await sweepOrphans(ctxOf(who), await credOf(who.accountId));
      return (await admin.query<{ id: string }>(`SELECT id FROM managed_servers WHERE account_id = $1 AND provider_server_id = $2`, [who.accountId, String(made.serverId)])).rows[0]!.id;
    }

    it.each(['creating', 'booting', 'ready', 'failed', 'deleting'])('is refused for a %s server with 409 not_an_orphan: nothing at Hetzner is touched', async (status) => {
      const who = await owner();
      const id = await seedServer(who, status, 7510);
      world.requests.length = 0;
      const res = await call(who, 'POST', `/${id}/delete-orphan`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'not_an_orphan']);
      expect(world.requests).toEqual([]);
      expect(world.servers.map((s) => s.id)).toContain(7510);
      expect((await row(id)).status).toBe(status);
    });

    it('will not delete a server whose label was taken off since the sweep found it: 409 not_an_orphan, and it stays', async () => {
      const who = await owner();
      const id = await orphan(who, 7520);
      world.servers.find((s) => s.id === 7520)!.labels = {};
      const res = await call(who, 'POST', `/${id}/delete-orphan`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'not_an_orphan']);
      expect(deletes()).toEqual([]);
      expect(world.servers.map((s) => s.id)).toEqual([7520]);
      expect((await row(id)).status).toBe('orphaned');
    });

    it('the ordinary DELETE holds the same label guard: a server whose label was taken off since the sweep found it is 409 not_an_orphan, and it stays', async () => {
      const who = await owner();
      const id = await orphan(who, 7521);
      world.servers.find((s) => s.id === 7521)!.labels = {};
      const res = await call(who, 'DELETE', `/${id}`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'not_an_orphan']);
      expect(deletes()).toEqual([]);
      expect(world.servers.map((s) => s.id)).toEqual([7521]);
      expect((await row(id)).status).toBe('orphaned');
    });

    it('counts a server Hetzner no longer has as deleted', async () => {
      const who = await owner();
      const id = await orphan(who, 7530);
      world.servers.length = 0;
      expect((await call(who, 'POST', `/${id}/delete-orphan`)).status).toBe(200);
      expect((await row(id)).status).toBe('deleted');
    });

    it('counts a firewall that is already gone (404) as deleted, and finishes what a failed first call left', async () => {
      const who = await owner();
      const made = await seedServerWithFirewall();
      const id = await adopt(who, made);
      world.failNext.push({ status: 500, code: 'server_error', method: 'DELETE', path: '/servers/7501' });
      const first = await call(who, 'POST', `/${id}/delete-orphan`);
      expect(first.status).toBe(503);
      expect((await row(id)).status).toBe('orphaned');
      expect(world.servers).toHaveLength(1);
      world.failNext.push({ status: 404, code: 'not_found', method: 'DELETE', path: '/firewalls/9001' });
      const second = await call(who, 'POST', `/${id}/delete-orphan`);
      expect(second.status).toBe(200);
      expect((await row(id)).status).toBe('deleted');
      expect(world.servers).toEqual([]);
    });

    it('will not use another token: with the credential removed it is refused and nothing is deleted', async () => {
      const who = await owner();
      const id = await orphan(who, 7540);
      await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
      world.requests.length = 0;
      const res = await call(who, 'POST', `/${id}/delete-orphan`);
      expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([404, 'not_connected']);
      expect(deletes()).toEqual([]);
      expect(world.servers.map((s) => s.id)).toEqual([7540]);
      expect((await row(id)).status).toBe('orphaned');
    });

    it('a second orphan of the same account and one of another account are never touched', async () => {
      const a = await owner();
      const b = await owner();
      const first = await orphan(a, 7550);
      const second = await orphan(a, 7551);
      expect((await call(b, 'POST', `/${first}/delete-orphan`)).status).toBe(404);
      expect(deletes()).toEqual([]);
      expect((await call(a, 'POST', `/${first}/delete-orphan`)).status).toBe(200);
      expect(world.servers.map((s) => s.id)).toEqual([7551]);
      expect((await row(second)).status).toBe('orphaned');
    });

    it('tenant predicate: through the RLS-bypassing pool a foreign account id finds no row and deletes nothing', async () => {
      const a = await owner();
      const b = await owner();
      const id = await orphan(a, 7560);
      world.requests.length = 0;
      await expect(deleteOrphan(bypassCtx(b), id)).rejects.toMatchObject({ status: 404 });
      expect(world.requests).toEqual([]);
      expect((await row(id)).status).toBe('orphaned');
    });
  });
});
