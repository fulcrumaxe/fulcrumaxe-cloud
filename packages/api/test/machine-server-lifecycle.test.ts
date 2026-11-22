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
import { machineServerDeps, type PriceTriple, type ServerCtx } from '../src/machines/servers.js';
import { advanceServer, sweepOrphans } from '../src/machines/lifecycle.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const BASE = 'http://localhost/api/v1/machine-servers';
const newToken = (): string => randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(64, 'x').slice(0, 64);
const LIVE: PriceTriple = { currency: 'EUR', hourly_gross: '0.0070', monthly_gross: '4.5101', ipv4_monthly_gross: '0.5950' };
type Who = { accountId: string; userId: string };
interface Reply { id: string; status: string; already_deleted: boolean; error: { code: string } }

/** D#845 MC-7: delete, the status worker's step and the orphan sweep, through the real handler, a real database and the strict Hetzner fake. Nothing here can reach the real Hetzner API. */
describe('machine servers: lifecycle, orphans and delete', () => {
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
    world.requests.length = 0; // the token check made and deleted a probe key: only what a test does is counted
    return who;
  }
  async function call(who: Who | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const h = new Headers({ ...(who ? { cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` } : {}), ...headers });
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const ctxOf = (who: Who): ServerCtx => ({ pool: appUserPool, principal: who });
  const create = async (who: Who, key: string): Promise<string> => {
    const res = await call(who, 'POST', '', { server_type: 'cx22', location: 'fsn1', quoted: LIVE }, { 'idempotency-key': key });
    expect(res.status).toBe(201);
    return ((await res.json()) as Reply).id;
  };
  const row = async (id: string) => (await admin.query(`SELECT * FROM managed_servers WHERE id = $1`, [id])).rows[0];
  const audit = async (accountId: string, action: string) => Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [accountId, action])).rows[0].n);
  const credOf = async (accountId: string) => (await admin.query<{ id: string }>(`SELECT id FROM machine_provider_credentials WHERE account_id = $1 AND removed_at IS NULL`, [accountId])).rows[0]!.id;
  const deletes = () => world.requests.filter((r) => r.method === 'DELETE');
  /** A runner registered for the server, as the register route links it. */
  async function link(who: Who, serverId: string, seen: boolean): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, last_seen_at) VALUES ($1, $2, $3, '{"kty":"OKP","crv":"Ed25519","x":"AAAA"}', $4, 'subscription', $5)`, [id, who.accountId, who.userId, randomBytes(32).toString('base64url'), seen ? new Date() : null]);
    await admin.query(`UPDATE managed_servers SET runner_id = $2 WHERE id = $1`, [serverId, id]);
    return id;
  }
  async function place(who: Who, runnerId: string): Promise<string> {
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'Acme', 'r1')`, [repoId, who.accountId]);
    await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repoId, who.accountId, runnerId]);
    return repoId;
  }

  describe('a delete during a create', () => {
    const makeWithHook = async (who: Who, key: string, step: string, hook: (rowId: string) => Promise<void>) => {
      machineServerDeps.checkpoint = async (s) => {
        if (s !== step) return;
        const id = (await admin.query<{ id: string }>(`SELECT id FROM managed_servers WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`, [who.accountId])).rows[0]!.id;
        await hook(id);
      };
      const res = await call(who, 'POST', '', { server_type: 'cx22', location: 'fsn1', quoted: LIVE }, { 'idempotency-key': key });
      delete machineServerDeps.checkpoint;
      return res;
    };

    it('is refused with 409 server_creating while the row has no Hetzner id, and the create finishes normally', async () => {
      const who = await owner();
      let status = 0;
      let code = '';
      const res = await makeWithHook(who, 'race1', 'server', async (id) => {
        const d = await call(who, 'DELETE', `/${id}`);
        status = d.status;
        code = ((await d.json()) as Reply).error.code;
      });
      expect(res.status).toBe(201);
      expect([status, code]).toEqual([409, 'server_creating']);
      expect(world.servers).toHaveLength(1);
      expect((await row(((await res.json()) as Reply).id)).status).toBe('creating');
      expect(deletes()).toEqual([]);
    });

    it('leaves no server behind when the row was made deleted before the create finalized: the create is undone', async () => {
      const who = await owner();
      let rowId = '';
      const res = await makeWithHook(who, 'race2', 'finalize', async (id) => {
        rowId = id;
        await admin.query(`UPDATE managed_servers SET status = 'deleted', deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, who.userId]);
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(world.servers).toEqual([]);
      expect(world.firewalls).toEqual([]);
      expect(await row(rowId)).toMatchObject({ status: 'deleted', provider_server_id: null });
      expect(await audit(who.accountId, 'server.create_confirmed')).toBe(0);
    });
  });

  describe('a create that was killed part way', () => {
    /** The state a killed create leaves: the row as inserted, no Hetzner ids, long ago; the server and firewall made at Hetzner with our labels. */
    const killed = async (who: Who, key: string, ageSql = "interval '2 hours'") => {
      const id = await create(who, key);
      await admin.query(`UPDATE managed_servers SET provider_server_id = NULL, provider_firewall_id = NULL, public_ipv4 = NULL, create_action_id = NULL, created_at = now() - ${ageSql}, status_at = now() - ${ageSql} WHERE id = $1`, [id]);
      return id;
    };

    it('Delete finds the server and firewall by their labels and removes them, since no create holds the lock', async () => {
      const who = await owner();
      const foreign = { id: 9301, name: 'theirs', status: 'running', labels: { 'fx-managed': '1', 'fx-server': randomUUID() }, public_net: { ipv4: null, ipv6: null, firewalls: [] }, server_type: { id: 1, name: 'cx22' }, location: { id: 1, name: 'fsn1' } };
      const id = await killed(who, 'crash1');
      world.servers.push(foreign);
      expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
      expect(world.servers.map((x) => x.id)).toEqual([9301]);
      expect(world.firewalls).toEqual([]);
      expect((await row(id)).status).toBe('deleted');
    });

    it('Delete still answers 409 server_creating while a create holds its lock', async () => {
      const who = await owner();
      const id = await killed(who, 'crash2', "interval '1 second'");
      const holder = await adminPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`machine-server-create:${who.accountId}:crash2`]);
        const res = await call(who, 'DELETE', `/${id}`);
        expect([res.status, ((await res.json()) as Reply).error.code]).toEqual([409, 'server_creating']);
        expect(deletes()).toEqual([]);
        await holder.query('COMMIT');
      } finally { holder.release(); }
      expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
      expect(world.servers).toEqual([]);
    });

    it('the sweep stamps the server on an old creating row and marks it cleanup_failed, so Delete can remove it; a young row is left to its create', async () => {
      const who = await owner();
      const credId = await credOf(who.accountId);
      const young = await killed(who, 'crash3', "interval '2 minutes'");
      expect(await sweepOrphans(ctxOf(who), credId)).toEqual({ orphaned: 0, deleted: 0 });
      expect(await row(young)).toMatchObject({ status: 'creating', provider_server_id: null });
      await admin.query(`UPDATE managed_servers SET created_at = now() - interval '2 hours' WHERE id = $1`, [young]);
      await sweepOrphans(ctxOf(who), credId);
      expect(await row(young)).toMatchObject({ status: 'failed', failure_code: 'cleanup_failed', provider_server_id: String(world.servers[0]!.id) });
      expect(deletes()).toEqual([]);
      expect((await call(who, 'DELETE', `/${young}`)).status).toBe(200);
      expect(world.servers).toEqual([]);
    });
  });

  describe('the sweep with the ports a Workflow step has', () => {
    it('does not abort on a gone server that had a runner when no lease-fail port is installed: the runner is revoked and the next rows are still handled', async () => {
      const who = await owner();
      const first = await create(who, 'wire1');
      const runnerId = await link(who, first, true);
      const second = await create(who, 'wire2');
      world.servers.length = 0;
      delete machineServerDeps.failRunnerLeases;
      expect(await sweepOrphans(ctxOf(who), await credOf(who.accountId))).toEqual({ orphaned: 0, deleted: 2 });
      expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).not.toBeNull();
      expect([(await row(first)).status, (await row(second)).status]).toEqual(['deleted', 'deleted']);
    });
  });

  describe('delete', () => {
    it('is session-only and owner-or-admin; a bad id is 400 and another account\'s server is 404, with nothing deleted', async () => {
      const a = await owner();
      const b = await owner();
      const id = await create(a, 'k1');
      const route = ROUTES.find((r) => r.method === 'DELETE' && r.path === '/api/v1/machine-servers/{id}')!;
      expect(route).toMatchObject({ minRole: 'admin', idempotency: 'never', sessionLimit: { name: 'machine-server-delete' } });
      expect(route.principals).toBeUndefined();
      expect((await call(null, 'DELETE', `/${id}`)).status).toBe(401);
      const memberId = randomUUID();
      await seedUser(admin, memberId);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
      expect((await call({ accountId: a.accountId, userId: memberId }, 'DELETE', `/${id}`)).status).toBe(403);
      const plaintext = generateToken();
      await insertApiToken(appUserPool, { accountId: a.accountId, createdBy: a.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
      expect((await call(null, 'DELETE', `/${id}`, undefined, { authorization: `Bearer ${plaintext}` })).status).toBe(403);
      expect((await call(a, 'DELETE', '/not-a-uuid')).status).toBe(400);
      expect((await call(b, 'DELETE', `/${id}`)).status).toBe(404);
      expect(deletes()).toEqual([]);
      expect((await row(id)).status).toBe('creating');
    });

    it('revokes the runner and the token, deletes the server and then the firewall, writes the audit row, and is idempotent', async () => {
      const who = await owner();
      const id = await create(who, 'k2');
      const runnerId = await link(who, id, true);
      const res = await call(who, 'DELETE', `/${id}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id, status: 'deleted', already_deleted: false });
      expect(world.servers).toEqual([]);
      expect(world.firewalls).toEqual([]);
      expect(deletes().map((r) => r.path.split('/')[2])).toEqual(['servers', 'firewalls']);
      const r = await row(id);
      expect(r).toMatchObject({ status: 'deleted', deleted_by: who.userId });
      expect(r.deleted_at).toBeInstanceOf(Date);
      expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).not.toBeNull();
      expect((await admin.query(`SELECT revoked_at, used_at FROM runner_provisioning_tokens WHERE id = $1`, [r.provisioning_token_id])).rows[0].revoked_at).not.toBeNull();
      expect(await audit(who.accountId, 'server.deleted')).toBe(1);
      const before = world.requests.length;
      const again = await call(who, 'DELETE', `/${id}`);
      expect(await again.json()).toEqual({ id, status: 'deleted', already_deleted: true });
      expect(world.requests.length).toBe(before);
      expect(await audit(who.accountId, 'server.deleted')).toBe(1);
    });

    it('revokes the runner and the token before it makes any Hetzner call, so a Hetzner failure leaves nothing that can still register', async () => {
      const who = await owner();
      const id = await create(who, 'k9');
      const runnerId = await link(who, id, true);
      world.failNext.push({ status: 500, code: 'server_error', method: 'DELETE', path: '/servers/' + (await row(id)).provider_server_id });
      expect((await call(who, 'DELETE', `/${id}`)).status).toBe(503);
      expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).not.toBeNull();
      expect((await admin.query(`SELECT revoked_at FROM runner_provisioning_tokens WHERE id = $1`, [(await row(id)).provisioning_token_id])).rows[0].revoked_at).not.toBeNull();
      expect(world.servers).toHaveLength(1);
      expect((await row(id)).status).toBe('deleting');
    });

    it('also removes the firewall of an adopted orphan, found by the label its server carries', async () => {
      const who = await owner();
      const credId = await credOf(who.accountId);
      const made = await create(who, 'k10');
      const wallId = Number((await row(made)).provider_firewall_id);
      const serverId = Number((await row(made)).provider_server_id);
      // The create's row is lost; the sweep adopts the server as an orphan, which holds no firewall id.
      await admin.query(`DELETE FROM managed_servers WHERE id = $1`, [made]);
      expect(await sweepOrphans(ctxOf(who), credId)).toEqual({ orphaned: 1, deleted: 0 });
      const orphan = (await admin.query<{ id: string }>(`SELECT id FROM managed_servers WHERE account_id = $2 AND provider_server_id = $1`, [String(serverId), who.accountId])).rows[0]!.id;
      expect((await call(who, 'DELETE', `/${orphan}`)).status).toBe(200);
      expect(world.servers).toEqual([]);
      expect(world.firewalls.map((f) => f.id)).not.toContain(wallId);
      expect(world.firewalls).toEqual([]);
    });

    it('counts a server or firewall Hetzner no longer has as deleted, and finishes what a failed first call left', async () => {
      const who = await owner();
      const id = await create(who, 'k3');
      world.servers.length = 0;
      world.firewalls.length = 0;
      expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
      expect((await row(id)).status).toBe('deleted');
      const second = await create(who, 'k3b');
      world.failNext.push({ status: 500, code: 'server_error', method: 'DELETE', path: '/firewalls/' + (await row(second)).provider_firewall_id });
      const failed = await call(who, 'DELETE', `/${second}`);
      expect(failed.status).toBe(503);
      expect(await row(second)).toMatchObject({ status: 'deleting' });
      expect(world.servers).toEqual([]);
      expect((await call(who, 'DELETE', `/${second}`)).status).toBe(200);
      expect(world.firewalls).toEqual([]);
      expect((await row(second)).status).toBe('deleted');
    });

    it('refuses while a project is placed (409 projects_placed), and removal asked for with no removal wired is 409 project_removal_unavailable; nothing is revoked or deleted', async () => {
      const who = await owner();
      const id = await create(who, 'k4');
      const runnerId = await link(who, id, true);
      await place(who, runnerId);
      const plain = await call(who, 'DELETE', `/${id}`);
      expect(plain.status).toBe(409);
      expect(((await plain.json()) as Reply).error.code).toBe('projects_placed');
      const ticked = await call(who, 'DELETE', `/${id}?remove_projects=true`);
      expect(((await ticked.json()) as Reply).error.code).toBe('project_removal_unavailable');
      expect(deletes()).toEqual([]);
      expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).toBeNull();
      expect((await row(id)).status).toBe('creating');
    });

    it('removes the projects through the injected seam when asked, then deletes; a seam that leaves one behind keeps the server', async () => {
      const who = await owner();
      const id = await create(who, 'k5');
      const runnerId = await link(who, id, true);
      await place(who, runnerId);
      const seen: string[] = [];
      machineServerDeps.removeProjects = async () => undefined;
      const stuck = await call(who, 'DELETE', `/${id}?remove_projects=true`);
      expect(((await stuck.json()) as Reply).error.code).toBe('projects_placed');
      machineServerDeps.removeProjects = async (c, rid) => { seen.push(rid); await admin.query(`DELETE FROM project_placements WHERE account_id = $1 AND runner_id = $2`, [c.principal.accountId, rid]); };
      expect((await call(who, 'DELETE', `/${id}?remove_projects=true`)).status).toBe(200);
      expect(seen).toEqual([runnerId]);
      expect((await row(id)).status).toBe('deleted');
    });

    it('will not use another token: with the credential removed the answer is 409 credential_changed and nothing is deleted', async () => {
      const who = await owner();
      const id = await create(who, 'k6');
      await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
      const res = await call(who, 'DELETE', `/${id}`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as Reply).error.code).toBe('credential_changed');
      expect(deletes()).toEqual([]);
      expect(world.servers).toHaveLength(1);
    });

    it('waits for Hetzner\'s delete action before it deletes the firewall (the server is still applied until the action finishes)', async () => {
      const who = await owner();
      const id = await create(who, 'k8');
      world.deleteSteps = 3;
      expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
      expect(world.servers).toEqual([]);
      expect(world.firewalls).toEqual([]);
      expect((await row(id)).status).toBe('deleted');
    });

    it('a failed (cleanup_failed) row is deleted from its stamped ids, and a server that ours did not make is never named', async () => {
      const who = await owner();
      const id = await create(who, 'k7');
      const foreign = { id: 9001, name: 'theirs', status: 'running', labels: {}, public_net: { ipv4: null, ipv6: null, firewalls: [] }, server_type: { id: 1, name: 'cx22' }, location: { id: 1, name: 'fsn1' } };
      world.servers.push(foreign);
      await call(who, 'DELETE', `/${id}`);
      expect(world.servers.map((s) => s.id)).toEqual([9001]);
      expect(deletes().every((r) => !r.path.includes('9001'))).toBe(true);
    });
  });

  describe('the orphan sweep', () => {
    const labelled = (n: number, labels: Record<string, string>, name = `box-${n}`) => ({ id: n, name, status: 'running', created: '2026-01-01T00:00:00+00:00', labels, public_net: { ipv4: { ip: '203.0.113.9' }, ipv6: null, firewalls: [] }, server_type: { id: 1, name: 'cx22' }, location: { id: 1, name: 'fsn1' } });

    it('records our unlinked servers as orphaned and never deletes anything, leaving a foreign server and one with only a similar label untouched', async () => {
      const who = await owner();
      const credId = await credOf(who.accountId);
      const made = await create(who, 'o1');
      world.servers.push(labelled(7001, { 'fx-managed': '1', 'fx-server': randomUUID() }), labelled(7002, {}), labelled(7003, { 'fx-managed': '0' }), labelled(7004, { owner: 'someone' }));
      const out = await sweepOrphans(ctxOf(who), credId);
      expect(out).toEqual({ orphaned: 1, deleted: 0 });
      const rows = (await admin.query(`SELECT provider_server_id, status, provisioning_token_id, created_by, host(public_ipv4) AS ip FROM managed_servers WHERE account_id = $1 AND status = 'orphaned'`, [who.accountId])).rows;
      expect(rows).toEqual([{ provider_server_id: '7001', status: 'orphaned', provisioning_token_id: null, created_by: who.userId, ip: '203.0.113.9' }]);
      expect(deletes()).toEqual([]);
      expect(world.requests.filter((r) => r.method !== 'GET')).toEqual(world.requests.filter((r) => r.method === 'POST'));
      expect(world.servers.map((s) => s.id).sort()).toContain(7002);
      expect((await row(made)).status).toBe('creating');
      // A second pass finds the same thing and adds nothing.
      expect(await sweepOrphans(ctxOf(who), credId)).toEqual({ orphaned: 0, deleted: 0 });
    });

    it('gives a cleanup_failed row the id of the server that landed after all, so Delete can remove it', async () => {
      const who = await owner();
      const credId = await credOf(who.accountId);
      const id = await create(who, 'o9');
      await admin.query(`UPDATE managed_servers SET status = 'failed', failure_code = 'cleanup_failed', provider_server_id = NULL WHERE id = $1`, [id]);
      expect(await sweepOrphans(ctxOf(who), credId)).toEqual({ orphaned: 0, deleted: 0 });
      expect(await row(id)).toMatchObject({ status: 'failed', provider_server_id: String(world.servers[0]!.id) });
      expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
      expect(world.servers).toEqual([]);
      expect(world.firewalls).toEqual([]);
    });

    it('does not trust a deleted row whose server Hetzner still lists with our labels: it becomes orphaned again, and nothing is deleted', async () => {
      const who = await owner();
      const credId = await credOf(who.accountId);
      const id = await create(who, 'o11');
      await admin.query(`UPDATE managed_servers SET status = 'deleted', deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, who.userId]);
      expect(await sweepOrphans(ctxOf(who), credId)).toEqual({ orphaned: 1, deleted: 0 });
      expect(await row(id)).toMatchObject({ status: 'orphaned', deleted_at: null, deleted_by: null });
      expect(world.servers).toHaveLength(1);
      expect(deletes()).toEqual([]);
      expect(await sweepOrphans(ctxOf(who), credId)).toEqual({ orphaned: 0, deleted: 0 });
    });

    it('revokes the runner of a row whose server is gone', async () => {
      const who = await owner();
      const id = await create(who, 'o12');
      const runnerId = await link(who, id, true);
      world.servers.length = 0;
      expect(await sweepOrphans(ctxOf(who), await credOf(who.accountId))).toEqual({ orphaned: 0, deleted: 1 });
      expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [runnerId])).rows[0].revoked_at).not.toBeNull();
    });

    it('marks a row whose server is gone deleted, and keeps one whose server is still there even without its label', async () => {
      const who = await owner();
      const credId = await credOf(who.accountId);
      const gone = await create(who, 'o2');
      const unlabelled = await create(who, 'o3');
      const goneId = Number((await row(gone)).provider_server_id);
      world.servers.splice(world.servers.findIndex((s) => s.id === goneId), 1);
      const keepId = Number((await row(unlabelled)).provider_server_id);
      (world.servers.find((s) => s.id === keepId)!.labels as Record<string, string>) = {};
      expect(await sweepOrphans(ctxOf(who), credId)).toEqual({ orphaned: 0, deleted: 1 });
      expect(await row(gone)).toMatchObject({ status: 'deleted', deleted_by: null });
      expect((await row(unlabelled)).status).toBe('creating');
      expect(deletes()).toEqual([]);
    });

    it('looks only at rows of the credential it swept: a row of an earlier credential of the same account is left alone, and it is not marked deleted', async () => {
      const who = await owner();
      const old = await create(who, 'o10');
      world.servers.length = 0;
      await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
      await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: createHetznerCredentialProbe({ maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } }) }, { token });
      expect(await sweepOrphans(ctxOf(who), await credOf(who.accountId))).toEqual({ orphaned: 0, deleted: 0 });
      expect((await row(old)).status).toBe('creating');
    });

    it('works only on the account\'s own connected credential: another account\'s credential id reads nothing and calls nothing', async () => {
      const a = await owner();
      const b = await owner();
      world.servers.push(labelled(7101, { 'fx-managed': '1', 'fx-server': randomUUID() }));
      world.requests.length = 0;
      expect(await sweepOrphans(ctxOf(b), await credOf(a.accountId))).toEqual({ orphaned: 0, deleted: 0 });
      expect(world.requests).toEqual([]);
      expect((await admin.query(`SELECT 1 FROM managed_servers WHERE provider_server_id = '7101'`)).rowCount).toBe(0);
    });

    it('an orphan row can then be deleted by the person: that server goes, the foreign one stays', async () => {
      const who = await owner();
      world.servers.push(labelled(7201, { 'fx-managed': '1', 'fx-server': randomUUID() }), labelled(7202, {}));
      await sweepOrphans(ctxOf(who), await credOf(who.accountId));
      const id = (await admin.query<{ id: string }>(`SELECT id FROM managed_servers WHERE provider_server_id = '7201'`)).rows[0]!.id;
      expect((await call(who, 'GET', `/${id}`)).status).toBe(200);
      expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
      expect(world.servers.map((s) => s.id)).toEqual([7202]);
      expect((await row(id)).status).toBe('deleted');
    });

    it('the sweep list reads only through the definer: no sealed column, only connected credentials, and platform_ops only', async () => {
      const who = await owner();
      const rows = (await platformOpsPool.query(`SELECT * FROM machine_sweep_credentials() WHERE account_id = $1`, [who.accountId])).rows;
      expect(rows).toEqual([{ account_id: who.accountId, credential_id: await credOf(who.accountId), created_by: who.userId }]);
      await expect(appUserPool.query('SELECT * FROM machine_sweep_credentials()')).rejects.toMatchObject({ code: '42501' });
      await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
      expect((await platformOpsPool.query(`SELECT * FROM machine_sweep_credentials() WHERE account_id = $1`, [who.accountId])).rows).toEqual([]);
    });
  });

  describe('the status worker step', () => {
    it('a create starts the worker once; a start that is refused does not undo the server', async () => {
      const who = await owner();
      const started: unknown[] = [];
      machineServerDeps.startStatusWorker = async (a) => { started.push(a); };
      const id = await create(who, 's1');
      expect(started).toEqual([{ accountId: who.accountId, userId: who.userId, serverId: id }]);
      machineServerDeps.startStatusWorker = async () => { throw new Error('no workflow'); };
      const id2 = await create(who, 's2');
      expect((await row(id2)).status).toBe('creating');
      // A replay of the same key answers the row and starts nothing more.
      machineServerDeps.startStatusWorker = async (a) => { started.push(a); };
      await create(who, 's1');
      expect(started).toHaveLength(1);
    });

    it('moves creating -> booting -> registering from Hetzner, then ready once the linked runner has heartbeated', async () => {
      const who = await owner();
      const id = await create(who, 's3');
      expect(await advanceServer(ctxOf(who), id)).toMatchObject({ final: false, status: 'creating', delaySeconds: 15 });
      (world.servers[0]!.status as string) = 'running';
      expect(await advanceServer(ctxOf(who), id)).toMatchObject({ final: false, status: 'registering' });
      await link(who, id, false);
      expect(await advanceServer(ctxOf(who), id)).toMatchObject({ final: false, status: 'registering' });
      await admin.query(`UPDATE runners SET last_seen_at = now() WHERE id = (SELECT runner_id FROM managed_servers WHERE id = $1)`, [id]);
      expect(await advanceServer(ctxOf(who), id)).toEqual({ final: true, status: 'ready', delaySeconds: 0 });
      const before = world.requests.length;
      expect((await advanceServer(ctxOf(who), id)).final).toBe(true);
      expect(world.requests.length).toBe(before);
    });

    it('stays booting while the create action runs, and fails the row when it errors', async () => {
      const who = await owner();
      const id = await create(who, 's4');
      (world.servers[0]!.status as string) = 'running';
      world.actionStatus = 'running';
      expect(await advanceServer(ctxOf(who), id)).toMatchObject({ final: false, status: 'booting' });
      world.actionStatus = 'error';
      expect(await advanceServer(ctxOf(who), id)).toMatchObject({ final: true, status: 'failed' });
      expect(await row(id)).toMatchObject({ status: 'failed', failure_code: 'hetzner_action_failed' });
    });

    it('fails a row that has not registered in 35 minutes, whatever Hetzner says, and never overwrites a delete in progress', async () => {
      const who = await owner();
      const id = await create(who, 's5');
      await admin.query(`UPDATE managed_servers SET created_at = now() - interval '36 minutes' WHERE id = $1`, [id]);
      world.failNext.push({ status: 500, code: 'server_error' }, { status: 500, code: 'server_error' }, { status: 500, code: 'server_error' });
      expect(await advanceServer(ctxOf(who), id)).toEqual({ final: true, status: 'failed', delaySeconds: 0 });
      world.failNext.length = 0;
      expect(await row(id)).toMatchObject({ status: 'failed', failure_code: 'registration_timeout' });
      const id2 = await create(who, 's6');
      await admin.query(`UPDATE managed_servers SET status = 'deleting', created_at = now() - interval '40 minutes' WHERE id = $1`, [id2]);
      expect((await advanceServer(ctxOf(who), id2)).status).toBe('deleting');
      expect((await row(id2)).status).toBe('deleting');
    });

    it('answers only for the account\'s own row', async () => {
      const a = await owner();
      const b = await owner();
      const id = await create(a, 's7');
      expect(await advanceServer(ctxOf(b), id)).toMatchObject({ final: true });
      expect((await row(id)).status).toBe('creating');
    });
  });
});
