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
import { getServer, listServers, machineServerDeps, type PriceTriple, type ServerCtx } from '../src/machines/servers.js';
import { NOT_IN_TOKEN_PROJECT_MESSAGE, advanceServer, deleteManagedServer, ensureCredential, markDeleteFailed, sweepOrphans } from '../src/machines/lifecycle.js';
import { DELETE_RUN_MAX_MINUTES, projectServerState, removeProjectOfServer, startProjectServerDelete } from '../src/machines/projectServer.js';
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
    delete machineServerDeps.startServerDelete;
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
      // The plain Delete writes its own failure on the row, so nothing is left `deleting` with no run behind it.
      expect(await row(id)).toMatchObject({ status: 'failed', failure_code: expect.stringMatching(/^[a-z][a-z0-9_]*$/) });
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
      expect(await row(second)).toMatchObject({ status: 'failed' });
      expect(world.servers).toEqual([]);
      expect((await call(who, 'DELETE', `/${second}`)).status).toBe(200);
      expect(world.firewalls).toEqual([]);
      expect((await row(second)).status).toBe('deleted');
    });

    it('refuses while a project is placed (409 projects_placed), and removal asked for with no removal wired is 409 project_removal_unavailable; nothing is revoked or deleted', async () => {
      const who = await owner();
      const id = await create(who, 'k4');
      delete machineServerDeps.removeProjects;
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
      // A hello that has not said whether the machine is signed in to Claude is not read as signed in.
      expect(await advanceServer(ctxOf(who), id)).toMatchObject({ final: false, status: 'registering' });
      await admin.query(`UPDATE runners SET model_auth_present = true WHERE id = (SELECT runner_id FROM managed_servers WHERE id = $1)`, [id]);
      expect(await advanceServer(ctxOf(who), id)).toEqual({ final: true, status: 'ready', delaySeconds: 0 });
      const before = world.requests.length;
      expect((await advanceServer(ctxOf(who), id)).final).toBe(true);
      expect(world.requests.length).toBe(before);
    });

    it('a registered runner that says it is not signed in to Claude makes the row needs_claude_login, which is final; a ready row is never restamped when the fact later changes', async () => {
      const who = await owner();
      const id = await create(who, 's3b');
      (world.servers[0]!.status as string) = 'running';
      await advanceServer(ctxOf(who), id);
      await link(who, id, false);
      await admin.query(`UPDATE runners SET last_seen_at = now(), model_auth_present = false WHERE id = (SELECT runner_id FROM managed_servers WHERE id = $1)`, [id]);
      expect(await advanceServer(ctxOf(who), id)).toEqual({ final: true, status: 'needs_claude_login', delaySeconds: 0 });
      expect(await advanceServer(ctxOf(who), id)).toMatchObject({ final: true, status: 'needs_claude_login' });
      const id2 = await create(who, 's3c');
      await admin.query(`UPDATE managed_servers SET status = 'registering' WHERE id = $1`, [id2]);
      await link(who, id2, false);
      await admin.query(`UPDATE runners SET last_seen_at = now(), model_auth_present = true WHERE id = (SELECT runner_id FROM managed_servers WHERE id = $1)`, [id2]);
      expect(await advanceServer(ctxOf(who), id2)).toEqual({ final: true, status: 'ready', delaySeconds: 0 });
      await admin.query(`UPDATE runners SET model_auth_present = false WHERE id = (SELECT runner_id FROM managed_servers WHERE id = $1)`, [id2]);
      expect(await advanceServer(ctxOf(who), id2)).toMatchObject({ final: true, status: 'ready' });
      expect((await row(id2)).status).toBe('ready');
    });

    it('the card\'s sign-in state is derived on each read from the linked runner, never stamped: ready then logout reads false, needs_claude_login then a hello that says true reads true, no runner reads null', async () => {
      const who = await owner();
      const signedIn = async (id: string) => (await getServer(ctxOf(who), id))!.claude_signed_in;
      const runnerOf = (id: string) => `(SELECT runner_id FROM managed_servers WHERE id = '${id}')`;
      // No runner linked yet: nothing to derive from.
      const none = await create(who, 's3d');
      expect(await signedIn(none)).toBeNull();
      // Ready, then the machine signs out: the next read says false and the row's own status is untouched.
      const a = await create(who, 's3e');
      await admin.query(`UPDATE managed_servers SET status = 'registering' WHERE id = $1`, [a]);
      await link(who, a, false);
      expect(await signedIn(a)).toBeNull();
      await admin.query(`UPDATE runners SET last_seen_at = now(), model_auth_present = true WHERE id = ${runnerOf(a)}`);
      expect(await advanceServer(ctxOf(who), a)).toMatchObject({ final: true, status: 'ready' });
      expect(await signedIn(a)).toBe(true);
      await admin.query(`UPDATE runners SET model_auth_present = false WHERE id = ${runnerOf(a)}`);
      expect(await signedIn(a)).toBe(false);
      expect((await row(a)).status).toBe('ready');
      // needs_claude_login, then a hello that says it is signed in.
      const b = await create(who, 's3f');
      await admin.query(`UPDATE managed_servers SET status = 'registering' WHERE id = $1`, [b]);
      await link(who, b, false);
      await admin.query(`UPDATE runners SET last_seen_at = now(), model_auth_present = false WHERE id = ${runnerOf(b)}`);
      expect(await advanceServer(ctxOf(who), b)).toMatchObject({ final: true, status: 'needs_claude_login' });
      expect(await signedIn(b)).toBe(false);
      await admin.query(`UPDATE runners SET model_auth_present = true WHERE id = ${runnerOf(b)}`);
      expect(await signedIn(b)).toBe(true);
      // A runner that was removed no longer speaks for the card.
      await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = ${runnerOf(b)}`);
      expect(await signedIn(b)).toBeNull();
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

  /** D#845 MC-12: the removal behind MC-7's seam, and "Also delete server": the route that starts the run, and the run's two steps. */
  describe('Also delete server (MC-12)', () => {
    /** A repo placed on the runner, with the engine's sandbox listed (so a removal that did not skip the machine parts would queue a cleanup). */
    async function placeWithSession(who: Who, runnerId: string): Promise<string> {
      const repoId = randomUUID();
      const gh = Math.floor(Math.random() * 2_000_000_000) + 1;
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [repoId, who.accountId, gh]);
      await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repoId, who.accountId, runnerId]);
      await admin.query(`INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, 'stopped', now() - interval '1 hour', 1000, 1)`, [runnerId, who.accountId, `fx-engine-${gh}`]);
      return repoId;
    }
    const placements = async (accountId: string) => (await admin.query(`SELECT repo_id FROM project_placements WHERE account_id = $1`, [accountId])).rows.length;
    const cleanups = async (accountId: string) => (await admin.query(`SELECT 1 FROM machine_cleanups WHERE account_id = $1`, [accountId])).rows.length;
    const jobs = async (accountId: string) => (await admin.query(`SELECT 1 FROM machine_jobs WHERE account_id = $1`, [accountId])).rows.length;
    const removedAudit = async (accountId: string) => (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'project.removed'`, [accountId])).rows.map((r) => r.payload as Record<string, unknown>);
    async function rig(): Promise<{ who: Who; serverId: string; runnerId: string; repoId: string }> {
      const who = await owner();
      const serverId = await create(who, `m12-${randomUUID()}`);
      const runnerId = await link(who, serverId, true);
      return { who, serverId, runnerId, repoId: await placeWithSession(who, runnerId) };
    }
    /** An install job the machine holds (`issued`) for the repo, with the setup row it names. */
    async function installJob(who: Who, runnerId: string, repoId: string): Promise<void> {
      const setup = (await admin.query<{ id: string }>(`INSERT INTO project_setups (account_id, repo_id, runner_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', 'done', $4) RETURNING id`, [who.accountId, repoId, runnerId, who.userId])).rows[0]!.id;
      const jobId = randomUUID();
      const at = new Date();
      const expires = new Date(at.getTime() + 600_000);
      await admin.query(
        `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, state, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, 'project_setup', $6::jsonb, 'issued', $7, $8)`,
        [jobId, who.accountId, runnerId, repoId, setup, JSON.stringify({ job: { job_id: jobId, kind: 'project_setup', runner_id: runnerId, setup_id: setup, issued_at: at.toISOString(), expires_at: expires.toISOString() } }), at, expires],
      );
    }
    async function member(accountId: string): Promise<Who> {
      const userId = randomUUID();
      await seedUser(admin, userId);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, userId]);
      return { accountId, userId };
    }
    const post = (who: Who | null, serverId: string, body: unknown, headers: Record<string, string> = {}) => call(who, 'POST', `/${serverId}/delete-with-project`, body, headers);
    const codeOf = async (res: Response): Promise<string> => ((await res.json()) as Reply).error.code;
    const runnerDeps = (): never => ({ appUserPool, origin: 'https://cloud.example.test', failRunnerLeases: null }) as never;

    it('the delete that asks to remove projects runs ON-16 with no machine parts: the placement goes, no cleanup or job is written even though the machine ran a session, and the server is deleted', async () => {
      const r = await rig();
      expect((await call(r.who, 'DELETE', `/${r.serverId}?remove_projects=true`)).status).toBe(200);
      expect(await placements(r.who.accountId)).toBe(0);
      expect([await cleanups(r.who.accountId), await jobs(r.who.accountId)]).toEqual([0, 0]);
      expect(await removedAudit(r.who.accountId)).toEqual([expect.objectContaining({ repo_id: r.repoId, machine_parts: 'none' })]);
      expect((await row(r.serverId)).status).toBe('deleted');
      expect(deletes().length).toBeGreaterThan(0);
    });

    it('a member cannot use the seam: the removal refuses, nothing is removed and nothing is deleted', async () => {
      const r = await rig();
      const m = await member(r.who.accountId);
      await expect(machineServerDeps.removeProjects!(ctxOf(m), r.runnerId)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(await placements(r.who.accountId)).toBe(1);
      expect(deletes()).toEqual([]);
    });

    it('the route checks, starts the run with exactly the ids it was given, and removes and deletes nothing itself', async () => {
      const r = await rig();
      const started: unknown[] = [];
      machineServerDeps.startServerDelete = async (a) => { started.push(a); };
      const res = await post(r.who, r.serverId.toUpperCase(), { repo_id: r.repoId.toUpperCase(), removal_pr: true });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ id: r.serverId, repo_id: r.repoId, status: 'deleting' });
      expect(started).toEqual([{ accountId: r.who.accountId, userId: r.who.userId, serverId: r.serverId, repoId: r.repoId, removalPr: true }]);
      expect(await placements(r.who.accountId)).toBe(1);
      expect(deletes()).toEqual([]);
      expect((await row(r.serverId)).status).toBe('deleting'); // marked before the run starts, so the project cannot be placed on it again meanwhile
    });

    it('refuses before starting anything: 503 with no run to start, 409 for a project that is elsewhere or not placed, 409 while an install runs, and 400, 404 or 422 for bad input', async () => {
      const r = await rig();
      const body = { repo_id: r.repoId, removal_pr: false };
      const noRun = await post(r.who, r.serverId, body);
      expect([noRun.status, await codeOf(noRun)]).toEqual([503, 'not_configured']);
      const started: unknown[] = [];
      machineServerDeps.startServerDelete = async (a) => { started.push(a); };
      const otherRunner = await link(r.who, await create(r.who, 'm12-b'), true);
      const elsewhere = await placeWithSession(r.who, otherRunner);
      const none = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 41, 'team', 'acme', 'unplaced')`, [none, r.who.accountId]);
      for (const repo of [elsewhere, none]) expect(await codeOf(await post(r.who, r.serverId, { repo_id: repo, removal_pr: false }))).toBe('project_not_on_server');
      await installJob(r.who, r.runnerId, r.repoId);
      expect(await codeOf(await post(r.who, r.serverId, body))).toBe('setup_running');
      expect((await post(r.who, 'not-a-uuid', body)).status).toBe(400);
      expect((await post(r.who, r.serverId, { repo_id: 'nope', removal_pr: false })).status).toBe(422);
      expect((await post(r.who, r.serverId, { repo_id: r.repoId })).status).toBe(422);
      expect((await post(r.who, r.serverId, { ...body, extra: 1 })).status).toBe(422);
      expect((await post(r.who, randomUUID(), body)).status).toBe(404);
      expect(started).toEqual([]);
      expect(await placements(r.who.accountId)).toBe(2);
    });

    it('is owner or admin on a session only: no session is 401, a member and an API token get 403, and nothing starts', async () => {
      const r = await rig();
      machineServerDeps.startServerDelete = async () => { throw new Error('must not start'); };
      const route = ROUTES.find((x) => x.method === 'POST' && x.path === '/api/v1/machine-servers/{id}/delete-with-project')!;
      expect(route).toMatchObject({ minRole: 'admin', idempotency: 'never', successStatus: 202, sessionLimit: { name: 'machine-server-delete' } });
      expect(route.principals).toBeUndefined();
      const body = { repo_id: r.repoId, removal_pr: false };
      expect((await post(null, r.serverId, body)).status).toBe(401);
      expect((await post(await member(r.who.accountId), r.serverId, body)).status).toBe(403);
      const plaintext = generateToken();
      await insertApiToken(appUserPool, { accountId: r.who.accountId, createdBy: r.who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
      expect((await post(null, r.serverId, body, { authorization: `Bearer ${plaintext}` })).status).toBe(403);
      expect(await placements(r.who.accountId)).toBe(1);
    });

    it("another account's server is a 404 and its project is not named; a repo of another account is not on this server: nothing starts", async () => {
      const r = await rig();
      const foreign = await owner();
      machineServerDeps.startServerDelete = async () => { throw new Error('must not start'); };
      expect((await post(foreign, r.serverId, { repo_id: r.repoId, removal_pr: false })).status).toBe(404);
      await expect(projectServerState(ctxOf(foreign), r.serverId, r.repoId)).rejects.toMatchObject({ status: 404 });
      const fRepo = await placeWithSession(foreign, await link(foreign, await create(foreign, 'm12-f'), true));
      expect(await codeOf(await post(r.who, r.serverId, { repo_id: fRepo, removal_pr: false }))).toBe('project_not_on_server');
    });

    it("an install running for another repo of the account does not hold this one back, and the check reads the install of this repo only", async () => {
      const r = await rig();
      const twinRunner = await link(r.who, await create(r.who, 'm12-i'), true);
      const twinRepo = await placeWithSession(r.who, twinRunner);
      await installJob(r.who, twinRunner, twinRepo);
      const started: unknown[] = [];
      machineServerDeps.startServerDelete = async (a) => { started.push(a); };
      expect((await post(r.who, r.serverId, { repo_id: r.repoId, removal_pr: false })).status).toBe(202);
      expect(started).toHaveLength(1);
    });

    it("through the RLS-bypassing client a foreign account id still reads nothing: no server, no placement, no list row, nothing started", async () => {
      const r = await rig();
      const foreign = await owner();
      const bypass = { pool: adminPool, principal: foreign };
      machineServerDeps.startServerDelete = async () => { throw new Error('must not start'); };
      await expect(projectServerState(bypass, r.serverId, r.repoId)).rejects.toMatchObject({ status: 404 });
      await expect(startProjectServerDelete(bypass, { serverId: r.serverId, repoId: r.repoId, removalPr: false })).rejects.toMatchObject({ status: 404 });
      expect(await listServers(bypass, r.repoId)).toEqual([]);
      expect((await listServers({ pool: adminPool, principal: r.who }, r.repoId)).map((s) => s.id)).toEqual([r.serverId]);
      // The same account's own state through the same client reads as it should (the client sees the rows; the predicates are what narrow it).
      expect(await projectServerState({ pool: adminPool, principal: r.who }, r.serverId, r.repoId)).toMatchObject({ here: true, elsewhere: false });
    });

    it("the first step removes the cloud parts and skips the machine's: no cleanup, no job, the audit row says none; run again it changes nothing, though the account has another project on another server", async () => {
      const r = await rig();
      await placeWithSession(r.who, await link(r.who, await create(r.who, 'm12-o'), true));
      const a = { serverId: r.serverId, repoId: r.repoId, removalPr: false };
      await removeProjectOfServer(ctxOf(r.who), runnerDeps(), a);
      expect(await placements(r.who.accountId)).toBe(1);
      expect([await cleanups(r.who.accountId), await jobs(r.who.accountId)]).toEqual([0, 0]);
      expect(await removedAudit(r.who.accountId)).toEqual([expect.objectContaining({ repo_id: r.repoId, delete_sandbox: false, machine_parts: 'none' })]);
      await removeProjectOfServer(ctxOf(r.who), runnerDeps(), a);
      expect(await removedAudit(r.who.accountId)).toHaveLength(1);
    });

    it('the first step never removes a project that has moved to another machine: it refuses and leaves everything', async () => {
      const r = await rig();
      const other = await link(r.who, await create(r.who, 'm12-c'), true);
      await admin.query(`UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1`, [r.repoId, other]);
      await expect(removeProjectOfServer(ctxOf(r.who), runnerDeps(), { serverId: r.serverId, repoId: r.repoId, removalPr: false })).rejects.toMatchObject({ status: 409, code: 'project_not_on_server' });
      expect(await placements(r.who.accountId)).toBe(1);
      expect(await removedAudit(r.who.accountId)).toEqual([]);
    });

    it("the run's two steps in order remove the project and then delete the server at Hetzner; a repeat of either finishes and does not repeat", async () => {
      const r = await rig();
      const a = { serverId: r.serverId, repoId: r.repoId, removalPr: false };
      await removeProjectOfServer(ctxOf(r.who), runnerDeps(), a);
      expect(deletes()).toEqual([]);
      expect((await deleteManagedServer(ctxOf(r.who), r.serverId, { removeProjects: false })).already_deleted).toBe(false);
      expect(world.servers).toEqual([]);
      expect((await row(r.serverId)).status).toBe('deleted');
      expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [r.runnerId])).rows[0].revoked_at).not.toBeNull();
      expect((await deleteManagedServer(ctxOf(r.who), r.serverId, { removeProjects: false })).already_deleted).toBe(true);
      expect(await removedAudit(r.who.accountId)).toHaveLength(1);
    });

    it('the list narrows to the server that holds the repo, hides one already being deleted, and reads nothing across accounts', async () => {
      const r = await rig();
      const twin = await create(r.who, 'm12-t');
      const twinRepo = await placeWithSession(r.who, await link(r.who, twin, true));
      expect((await listServers(ctxOf(r.who), r.repoId)).map((s) => s.id)).toEqual([r.serverId]);
      expect((await listServers(ctxOf(r.who), twinRepo)).map((s) => s.id)).toEqual([twin]);
      expect((await listServers(ctxOf(r.who))).map((s) => s.id).sort()).toEqual([r.serverId, twin].sort());
      expect(await listServers(ctxOf(await owner()), r.repoId)).toEqual([]);
      const viaRoute = await call(r.who, 'GET', `?repo_id=${r.repoId}`);
      expect(((await viaRoute.json()) as { servers: { id: string }[] }).servers.map((s) => s.id)).toEqual([r.serverId]);
      expect((await call(r.who, 'GET', '?repo_id=nope')).status).toBe(422);
      await admin.query(`UPDATE managed_servers SET status = 'deleting' WHERE id = $1`, [r.serverId]);
      expect(await listServers(ctxOf(r.who), r.repoId)).toEqual([]);
    });

    describe('a token that is not the one that made the server', () => {
      const probe = () => createHetznerCredentialProbe({ maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
      /** `removed`: no token connected. `reconnected`: a token connected again afterwards (a different credential). */
      async function change(who: Who, how: 'removed' | 'reconnected'): Promise<void> {
        await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
        if (how === 'reconnected') await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: probe() }, { token });
        world.requests.length = 0;
      }
      /** Nothing was written and nothing was asked of Hetzner: the project is placed, the runner is live, the row is as it was. */
      async function untouched(r: { who: Who; serverId: string; runnerId: string }): Promise<void> {
        expect(await placements(r.who.accountId)).toBe(1);
        expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [r.runnerId])).rows[0].revoked_at).toBeNull();
        expect((await row(r.serverId)).status).toBe('creating');
        expect((await admin.query(`SELECT 1 FROM managed_servers WHERE id = $1 AND provisioning_token_id IS NOT NULL`, [r.serverId])).rows).toHaveLength(1);
        expect(await removedAudit(r.who.accountId)).toEqual([]);
        expect(world.requests).toEqual([]);
      }
      for (const how of ['removed'] as const) {
        it(`${how}: the plain delete that removes projects refuses with 409 credential_changed before removing the project or revoking anything`, async () => {
          const r = await rig();
          await change(r.who, how);
          const res = await call(r.who, 'DELETE', `/${r.serverId}?remove_projects=true`);
          expect([res.status, await codeOf(res)]).toEqual([409, 'credential_changed']);
          await untouched(r);
        });

        it(`${how}: the route refuses with 409 credential_changed before it marks the server or starts the run`, async () => {
          const r = await rig();
          machineServerDeps.startServerDelete = async () => { throw new Error('must not start'); };
          await change(r.who, how);
          const res = await post(r.who, r.serverId, { repo_id: r.repoId, removal_pr: false });
          expect([res.status, await codeOf(res)]).toEqual([409, 'credential_changed']);
          await untouched(r);
        });

        it(`${how}: the run's second step refuses before it revokes the runner or the token, and the project is not removed by it`, async () => {
          const r = await rig();
          await change(r.who, how);
          await expect(deleteManagedServer(ctxOf(r.who), r.serverId, { removeProjects: true })).rejects.toMatchObject({ status: 409, code: 'credential_changed' });
          await untouched(r);
        });
      }
    });

    /** Ruling 99: a reconnect makes a new credential id, so Delete asks Hetzner through the CURRENT token and follows it only when both of our labels match. */
    describe('a different token is connected: the server follows it only when it is in that token\'s Hetzner project', () => {
      const probeOf = (f: StrictHetzner) => createHetznerCredentialProbe({ maxRetries: 0, testTarget: { lookup: f.lookup, port: f.port, ca: f.ca } });
      const extra: StrictHetzner[] = [];
      afterEach(async () => { for (const f of extra.splice(0)) await f.close(); });
      const reconnect = async (who: Who): Promise<string> => {
        await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
        await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: probeOf(fake) }, { token });
        world.requests.length = 0;
        return credOf(who.accountId);
      };
      /** Another Hetzner project: its own world (no servers) and its own token, connected in place of the first. */
      async function otherProject(who: Who): Promise<{ world: FakeWorld; cred: string }> {
        const t2 = newToken();
        const w2 = newWorld([t2]);
        const f2 = await startStrictHetzner(w2);
        extra.push(f2);
        machineServerDeps.hetznerOptions = () => ({ maxRetries: 0, timeoutMs: 2000, sleep: async () => undefined, testTarget: { lookup: f2.lookup, port: f2.port, ca: f2.ca } });
        await removeHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek() });
        await connectHetznerCredential({ pool: appUserPool, principal: who, kek: machineServerDeps.getKek(), probe: probeOf(f2) }, { token: t2 });
        w2.requests.length = 0;
        world.requests.length = 0;
        return { world: w2, cred: await credOf(who.accountId) };
      }
      const rebound = async (accountId: string) => (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'machine_server.credential_rebound'`, [accountId])).rows.map((r) => r.payload as Record<string, unknown>);
      /** Nothing changed: the row keeps its credential and status, no rebind is written, the runner is live and the project is placed. */
      async function unchanged(r: { who: Who; serverId: string; runnerId: string }, oldCred: string): Promise<void> {
        expect(await row(r.serverId)).toMatchObject({ credential_id: oldCred, status: 'creating' });
        expect(await rebound(r.who.accountId)).toEqual([]);
        expect(await placements(r.who.accountId)).toBe(1);
        expect((await admin.query(`SELECT revoked_at FROM runners WHERE id = $1`, [r.runnerId])).rows[0].revoked_at).toBeNull();
        expect(await removedAudit(r.who.accountId)).toEqual([]);
        expect(deletes()).toEqual([]);
        expect(world.servers).toHaveLength(1);
      }
      const labelsOf = (x: unknown): Record<string, string> => (x as { labels: Record<string, string> }).labels;
      const credentialOf = async (serverId: string): Promise<string> => (await row(serverId)).credential_id as string;
      const killedRow = (id: string) => admin.query(`UPDATE managed_servers SET provider_server_id = NULL, provider_firewall_id = NULL, public_ipv4 = NULL, create_action_id = NULL, created_at = now() - interval '2 hours', status_at = now() - interval '2 hours' WHERE id = $1`, [id]);

      it('the same token connected again: the plain delete that removes projects works, the row follows the new credential, and one audit row says so', async () => {
        const r = await rig();
        const oldCred = await credentialOf(r.serverId);
        const now = await reconnect(r.who);
        expect(now).not.toBe(oldCred);
        const res = await call(r.who, 'DELETE', `/${r.serverId}?remove_projects=true`);
        expect([res.status, ((await res.json()) as Reply).status]).toEqual([200, 'deleted']);
        expect(await row(r.serverId)).toMatchObject({ status: 'deleted', credential_id: now });
        expect(world.servers).toEqual([]);
        expect(world.firewalls).toEqual([]);
        expect(await rebound(r.who.accountId)).toEqual([{ server_id: r.serverId, from_credential_id: oldCred, credential_id: now }]);
      });

      it('the route follows the token before it marks the server or answers 202, and the run then finds the current credential', async () => {
        const r = await rig();
        const now = await reconnect(r.who);
        const seen: unknown[] = [];
        machineServerDeps.startServerDelete = async () => { seen.push(await row(r.serverId)); };
        expect((await post(r.who, r.serverId, { repo_id: r.repoId, removal_pr: false })).status).toBe(202);
        expect(seen).toMatchObject([{ status: 'deleting', credential_id: now }]);
        expect((await rebound(r.who.accountId)).length).toBe(1);
        await deleteManagedServer(ctxOf(r.who), r.serverId, { removeProjects: true, fromRun: true });
        expect(await row(r.serverId)).toMatchObject({ status: 'deleted', credential_id: now });
        expect(world.servers).toEqual([]);
        expect((await rebound(r.who.accountId)).length).toBe(1);
      });

      it('a row with no Hetzner ids (a killed create) is found by the same labels, and follows the token', async () => {
        const who = await owner();
        const id = await create(who, 'rb-killed');
        await killedRow(id);
        const now = await reconnect(who);
        expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
        expect(await row(id)).toMatchObject({ status: 'deleted', credential_id: now });
        expect(world.servers).toEqual([]);
        expect(world.firewalls).toEqual([]);
        expect((await rebound(who.accountId)).length).toBe(1);
      });

      it('the token of another Hetzner project: all three paths refuse 409 server_not_in_token_project with the sentence, and nothing is changed or deleted anywhere', async () => {
        const base = machineServerDeps.hetznerOptions;
        for (const path of ['plain', 'route', 'run'] as const) {
          machineServerDeps.hetznerOptions = base;
          const r = await rig();
          const oldCred = await credentialOf(r.serverId);
          machineServerDeps.startServerDelete = async () => { throw new Error('must not start'); };
          const other = await otherProject(r.who);
          const outcome = path === 'plain' ? await call(r.who, 'DELETE', `/${r.serverId}?remove_projects=true`)
            : path === 'route' ? await post(r.who, r.serverId, { repo_id: r.repoId, removal_pr: false }) : null;
          if (outcome !== null) {
            const body = (await outcome.json()) as { error: { code: string; message: string } };
            expect([outcome.status, body.error.code, body.error.message]).toEqual([409, 'server_not_in_token_project', NOT_IN_TOKEN_PROJECT_MESSAGE]);
          } else {
            await expect(deleteManagedServer(ctxOf(r.who), r.serverId, { removeProjects: true })).rejects.toMatchObject({ status: 409, code: 'server_not_in_token_project', message: NOT_IN_TOKEN_PROJECT_MESSAGE });
          }
          await unchanged(r, oldCred);
          expect(other.world.requests.filter((q) => q.method !== 'GET')).toEqual([]);
          expect(other.world.servers).toEqual([]);
          world.servers.length = 0;
        }
      });

      it('a server at Hetzner that does not carry both of our labels is never followed or deleted: each label compared on its own, by id and by label lookup', async () => {
        const cases: Array<[string, (w: FakeWorld) => void]> = [
          ['the fx-server label names another row', (w) => { labelsOf(w.servers[0])['fx-server'] = randomUUID(); }],
          ['the fx-server label is gone', (w) => { delete labelsOf(w.servers[0])['fx-server']; }],
          ['the managed label is gone', (w) => { delete labelsOf(w.servers[0])['fx-managed']; }],
          ['the managed label has another value', (w) => { labelsOf(w.servers[0])['fx-managed'] = '0'; }],
          ['Hetzner no longer has the server', (w) => { w.servers.length = 0; }],
        ];
        for (const [why, mutate] of cases) {
          const r = await rig();
          const oldCred = await credentialOf(r.serverId);
          await reconnect(r.who);
          mutate(world);
          const res = await call(r.who, 'DELETE', `/${r.serverId}`);
          expect([why, res.status, await codeOf(res)]).toEqual([why, 409, 'server_not_in_token_project']);
          expect(await row(r.serverId)).toMatchObject({ credential_id: oldCred, status: 'creating' });
          expect(await rebound(r.who.accountId)).toEqual([]);
          expect(deletes()).toEqual([]);
          world.servers.length = 0;
          world.firewalls.length = 0;
        }
        // A row with no ids is found by label: the server and the firewall carrying only part of our labels do not count.
        const partial: Array<[string, (labels: Record<string, string>) => void]> = [
          ['no managed label', (l) => { delete l['fx-managed']; }],
          ['another managed value', (l) => { l['fx-managed'] = '0'; }],
        ];
        for (const [why, mutate] of partial) {
          const who = await owner();
          const id = await create(who, `rb-lbl-${why.length}`);
          await killedRow(id);
          const oldCred = await credentialOf(id);
          await reconnect(who);
          mutate(labelsOf(world.servers[0]));
          mutate(labelsOf(world.firewalls[0]));
          const res = await call(who, 'DELETE', `/${id}`);
          expect([why, res.status, await codeOf(res)]).toEqual([why, 409, 'server_not_in_token_project']);
          expect(await credentialOf(id)).toBe(oldCred);
          expect(await rebound(who.accountId)).toEqual([]);
          expect(deletes()).toEqual([]);
          world.servers.length = 0;
          world.firewalls.length = 0;
        }
      });

      it('a row with no ids whose project holds only a firewall of ours follows the token: the firewall is the evidence', async () => {
        const who = await owner();
        const id = await create(who, 'rb-fw');
        await killedRow(id);
        const now = await reconnect(who);
        world.servers.length = 0;
        expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
        expect(await row(id)).toMatchObject({ status: 'deleted', credential_id: now });
        expect(world.firewalls).toEqual([]);
      });

      it('the update names the old credential: a row that moved to another credential while Hetzner was asked is not touched, and no audit row is written', async () => {
        const r = await rig();
        const oldCred = await credentialOf(r.serverId);
        await reconnect(r.who);
        const moved = (await admin.query<{ id: string }>(`INSERT INTO machine_provider_credentials (account_id, provider, kek_version, token_hint, created_by, removed_at, removed_by) VALUES ($1, 'hetzner_cloud', 1, 'zz99', $2, now(), $2) RETURNING id`, [r.who.accountId, r.who.userId])).rows[0]!.id;
        // The row moves while the call to Hetzner is being made (the lookup of the connection is the first thing that call does).
        machineServerDeps.hetznerOptions = () => ({ maxRetries: 0, timeoutMs: 2000, sleep: async () => undefined, testTarget: { lookup: async () => { await admin.query(`UPDATE managed_servers SET credential_id = $2 WHERE id = $1`, [r.serverId, moved]); return fake.lookup(); }, port: fake.port, ca: fake.ca } });
        await expect(ensureCredential(ctxOf(r.who), { id: r.serverId, credential_id: oldCred, provider_server_id: (await row(r.serverId)).provider_server_id })).rejects.toMatchObject({ status: 409, code: 'credential_changed' });
        expect(await credentialOf(r.serverId)).toBe(moved);
        expect(await rebound(r.who.accountId)).toEqual([]);
      });

      it("another account's row is never rebound, even through the RLS-bypassing client: the update names the account", async () => {
        const r = await rig();
        const oldCred = await credentialOf(r.serverId);
        const foreign = await owner();
        await expect(ensureCredential({ pool: adminPool, principal: foreign }, { id: r.serverId, credential_id: oldCred, provider_server_id: (await row(r.serverId)).provider_server_id })).rejects.toMatchObject({ status: 409, code: 'credential_changed' });
        expect(await credentialOf(r.serverId)).toBe(oldCred);
        expect(await rebound(r.who.accountId)).toEqual([]);
        expect(await rebound(foreign.accountId)).toEqual([]);
      });

      it("an orphan row the new token's sweep already made for the same server is retired, so the row with the history takes the server and Delete works", async () => {
        const who = await owner();
        const id = await create(who, 'rb-dup');
        const now = await reconnect(who);
        expect(await sweepOrphans(ctxOf(who), now)).toMatchObject({ orphaned: 1 });
        const dup = (await admin.query<{ id: string }>(`SELECT id FROM managed_servers WHERE account_id = $1 AND status = 'orphaned'`, [who.accountId])).rows[0]!.id;
        expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
        expect(await row(id)).toMatchObject({ status: 'deleted', credential_id: now });
        expect(await row(dup)).toMatchObject({ status: 'deleted', provider_server_id: null, credential_id: now });
        expect(world.servers).toEqual([]);
      });
    });

    describe("the token cannot be removed while a server is being deleted", () => {
      const CRED = 'http://localhost/api/v1/machine-credentials/hetzner';
      async function removeToken(who: Who): Promise<Response> {
        await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
        const h = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
        return handleApiRequest(new Request(CRED, { method: 'DELETE', headers: h }), appUserPool, platformOpsPool, ROUTES);
      }
      const connected = async (who: Who) => (await admin.query(`SELECT 1 FROM machine_provider_credentials WHERE account_id = $1 AND removed_at IS NULL`, [who.accountId])).rows.length;

      it('refuses with 409 credential_in_use, keeps the token and the server row, and allows the removal once the delete has ended', async () => {
        const r = await rig();
        await admin.query(`UPDATE managed_servers SET status = 'deleting' WHERE id = $1`, [r.serverId]);
        const res = await removeToken(r.who);
        expect([res.status, await codeOf(res)]).toEqual([409, 'credential_in_use']);
        expect(await connected(r.who)).toBe(1);
        expect((await row(r.serverId)).status).toBe('deleting');
        await markDeleteFailed(ctxOf(r.who), r.serverId, 'delete_failed');
        expect((await removeToken(r.who)).status).toBe(204);
        expect(await connected(r.who)).toBe(0);
      });

      it("is not blocked by another account's deleting server, and a server that is not deleting does not block", async () => {
        const mine = await rig();
        const theirs = await rig();
        await admin.query(`UPDATE managed_servers SET status = 'deleting' WHERE id = $1`, [theirs.serverId]);
        expect((await removeToken(mine.who)).status).toBe(204);
        expect(await connected(theirs.who)).toBe(1);
      });

      it('a plain Delete that Hetzner refuses (a Read-only token, 403) leaves the row failed with its code, and the token can then be removed', async () => {
        const who = await owner();
        const id = await create(who, 'k-ro');
        world.failNext.push({ status: 403, code: 'forbidden', method: 'DELETE', path: '/servers/' + (await row(id)).provider_server_id });
        const res = await call(who, 'DELETE', `/${id}`);
        expect([res.status, await codeOf(res)]).toEqual([409, 'hetzner_forbidden']);
        expect(await row(id)).toMatchObject({ status: 'failed', failure_code: 'hetzner_forbidden' });
        expect((await removeToken(who)).status).toBe(204);
        expect(await connected(who)).toBe(0);
      });

      describe('a plain Delete never takes over or fails a delete that a run owns (D#845 MC-12 race)', () => {
        const queued = async (r: Awaited<ReturnType<typeof rig>>) => {
          machineServerDeps.startServerDelete = async () => undefined;
          expect((await post(r.who, r.serverId, { repo_id: r.repoId, removal_pr: false })).status).toBe(202);
        };
        const statusAt = async (id: string) => (await admin.query<{ at: string }>(`SELECT status_at::text AS at FROM managed_servers WHERE id = $1`, [id])).rows[0]!.at;

        it('after "Also delete server" a plain Delete (with or without remove_projects) is 409 server_deleting, the row stays deleting and untouched, and the token stays held', async () => {
          const r = await rig();
          await queued(r);
          const at = await statusAt(r.serverId);
          for (const q of ['', '?remove_projects=true']) {
            const res = await call(r.who, 'DELETE', `/${r.serverId}${q}`);
            expect([res.status, await codeOf(res)], q).toEqual([409, 'server_deleting']);
            expect(await row(r.serverId), q).toMatchObject({ status: 'deleting', failure_code: null });
            expect(await statusAt(r.serverId), q).toBe(at);
          }
          expect(deletes()).toEqual([]);
          const held = await removeToken(r.who);
          expect([held.status, await codeOf(held)]).toEqual([409, 'credential_in_use']);
          expect(await connected(r.who)).toBe(1);
        });

        it('a second plain Delete while the first is still running is refused with 409 server_deleting and writes nothing', async () => {
          const who = await owner();
          const id = await create(who, 'k-twice');
          await admin.query(`UPDATE managed_servers SET status = 'deleting', status_at = now() WHERE id = $1`, [id]);
          const at = await statusAt(id);
          const res = await call(who, 'DELETE', `/${id}`);
          expect([res.status, await codeOf(res)]).toEqual([409, 'server_deleting']);
          expect(await row(id)).toMatchObject({ status: 'deleting', failure_code: null });
          expect(await statusAt(id)).toBe(at);
          expect(deletes()).toEqual([]);
        });

        it('a delete with no run behind it (older than the window) is still finished by a plain Delete', async () => {
          const who = await owner();
          const id = await create(who, 'k-old');
          await admin.query(`UPDATE managed_servers SET status = 'deleting', status_at = now() - make_interval(mins => $2::int + 1) WHERE id = $1`, [id, DELETE_RUN_MAX_MINUTES]);
          expect((await call(who, 'DELETE', `/${id}`)).status).toBe(200);
          expect((await row(id)).status).toBe('deleted');
        });

        it("the run's own call (fromRun) goes through on its deleting row, and a plain call on the same row is refused", async () => {
          const who = await owner();
          const id = await create(who, 'k-run');
          await admin.query(`UPDATE managed_servers SET status = 'deleting', status_at = now() WHERE id = $1`, [id]);
          await expect(deleteManagedServer(ctxOf(who), id, { removeProjects: false })).rejects.toMatchObject({ status: 409, code: 'server_deleting' });
          expect(deletes()).toEqual([]);
          await expect(deleteManagedServer(ctxOf(who), id, { removeProjects: false, fromRun: true })).resolves.toMatchObject({ status: 'deleted', already_deleted: false });
          expect((await row(id)).status).toBe('deleted');
        });

        it('a run that starts between the read and the mark makes the plain Delete answer 409 server_deleting instead of taking the row, and its failure write leaves the run\'s row alone', async () => {
          const r = await rig();
          machineServerDeps.removeProjects = async (c, rid) => {
            await admin.query(`DELETE FROM project_placements WHERE account_id = $1 AND runner_id = $2`, [c.principal.accountId, rid]);
            await admin.query(`UPDATE managed_servers SET status = 'deleting', status_at = now() WHERE id = $1`, [r.serverId]);
          };
          const res = await call(r.who, 'DELETE', `/${r.serverId}?remove_projects=true`);
          expect([res.status, await codeOf(res)]).toEqual([409, 'server_deleting']);
          expect(await row(r.serverId)).toMatchObject({ status: 'deleting', failure_code: null });
          expect(deletes()).toEqual([]);
        });

        it("a plain Delete's failure write fails only its own mark: a row marked again since is not flipped, the row it marked is", async () => {
          const who = await owner();
          const id = await create(who, 'k-own');
          world.failNext.push({ status: 403, code: 'forbidden', method: 'DELETE', path: '/servers/' + (await row(id)).provider_server_id });
          let mine: string | undefined;
          await expect(deleteManagedServer(ctxOf(who), id, { removeProjects: false, onMarked: (at) => { mine = at; } })).rejects.toMatchObject({ code: 'hetzner_forbidden' });
          expect(mine).toBe(await statusAt(id));
          await admin.query(`UPDATE managed_servers SET status_at = status_at + interval '1 second' WHERE id = $1`, [id]); // someone else marked it again
          await markDeleteFailed(ctxOf(who), id, 'hetzner_forbidden', mine);
          expect(await row(id)).toMatchObject({ status: 'deleting', failure_code: null });
          await markDeleteFailed(ctxOf(who), id, 'hetzner_forbidden', await statusAt(id));
          expect(await row(id)).toMatchObject({ status: 'failed', failure_code: 'hetzner_forbidden' });
        });

      });

      it("a delete that began a moment ago blocks the removal, one older than the run's longest does not", async () => {
        const r = await rig();
        await admin.query(`UPDATE managed_servers SET status = 'deleting', status_at = now() - make_interval(mins => $2::int - 1) WHERE id = $1`, [r.serverId, DELETE_RUN_MAX_MINUTES]);
        expect(await codeOf(await removeToken(r.who))).toBe('credential_in_use');
        await admin.query(`UPDATE managed_servers SET status_at = now() - make_interval(mins => $2::int + 1) WHERE id = $1`, [r.serverId, DELETE_RUN_MAX_MINUTES]);
        expect((await removeToken(r.who)).status).toBe(204);
        expect(await connected(r.who)).toBe(0);
      });

      it('a deleting server whose token is no longer accepted does not block replacing it', async () => {
        const r = await rig();
        await admin.query(`UPDATE managed_servers SET status = 'deleting', status_at = now() WHERE id = $1`, [r.serverId]);
        await admin.query(`UPDATE machine_provider_credentials SET status = 'invalid' WHERE account_id = $1 AND removed_at IS NULL`, [r.who.accountId]);
        expect((await removeToken(r.who)).status).toBe(204);
      });

      it("the run's first step refuses a token removed after the route's check, before it removes any part of the project", async () => {
        const r = await rig();
        await removeHetznerCredential({ pool: appUserPool, principal: r.who, kek: machineServerDeps.getKek() });
        await expect(removeProjectOfServer(ctxOf(r.who), runnerDeps(), { serverId: r.serverId, repoId: r.repoId, removalPr: false })).rejects.toMatchObject({ status: 409, code: 'credential_changed' });
        expect(await placements(r.who.accountId)).toBe(1);
        expect(await removedAudit(r.who.accountId)).toEqual([]);
      });
    });

    it('the route marks the server deleting before the run starts: a second request is refused, the lookup hides it, and a run that cannot start puts the status back', async () => {
      const r = await rig();
      const seen: string[] = [];
      machineServerDeps.startServerDelete = async () => { seen.push((await row(r.serverId)).status); };
      expect((await post(r.who, r.serverId, { repo_id: r.repoId, removal_pr: false })).status).toBe(202);
      expect(seen).toEqual(['deleting']);
      expect(await codeOf(await post(r.who, r.serverId, { repo_id: r.repoId, removal_pr: false }))).toBe('server_deleting');
      expect(await listServers(ctxOf(r.who), r.repoId)).toEqual([]);
      const q = await rig();
      machineServerDeps.startServerDelete = async () => { throw new Error('refused'); };
      expect((await post(q.who, q.serverId, { repo_id: q.repoId, removal_pr: false })).status).toBe(500);
      expect((await row(q.serverId)).status).toBe('creating');
    });

    it('a run that ends without deleting is written on the row: a deleting row becomes failed with the closed code, any other row is left alone, and a code that is not a word is delete_failed', async () => {
      const r = await rig();
      await markDeleteFailed(ctxOf(r.who), r.serverId, 'hetzner_unauthorized');
      expect(await row(r.serverId)).toMatchObject({ status: 'creating', failure_code: null });
      await admin.query(`UPDATE managed_servers SET status = 'deleting' WHERE id = $1`, [r.serverId]);
      await markDeleteFailed(ctxOf(r.who), r.serverId, 'hetzner_unauthorized');
      expect(await row(r.serverId)).toMatchObject({ status: 'failed', failure_code: 'hetzner_unauthorized' });
      await admin.query(`UPDATE managed_servers SET status = 'deleting', failure_code = NULL WHERE id = $1`, [r.serverId]);
      await markDeleteFailed(ctxOf(r.who), r.serverId, 'Not a word!');
      expect(await row(r.serverId)).toMatchObject({ status: 'failed', failure_code: 'delete_failed' });
      // Delete finishes what a failed run left (the runner is revoked and the server goes).
      expect((await call(r.who, 'DELETE', `/${r.serverId}?remove_projects=true`)).status).toBe(200);
      expect((await row(r.serverId)).status).toBe('deleted');
      const other = await rig();
      await admin.query(`UPDATE managed_servers SET status = 'deleting' WHERE id = $1`, [other.serverId]);
      await markDeleteFailed(ctxOf(r.who), other.serverId, 'hetzner_unauthorized'); // another account's row: untouched
      expect((await row(other.serverId)).status).toBe('deleting');
    });

    it('a server with no runner has no project to find, and the guard refuses a repo that is not on it', async () => {
      const who = await owner();
      const id = await create(who, 'm12-n');
      const repoId = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 42, 'team', 'acme', 'w')`, [repoId, who.accountId]);
      expect(await listServers(ctxOf(who), repoId)).toEqual([]);
      machineServerDeps.startServerDelete = async () => { throw new Error('must not start'); };
      await expect(startProjectServerDelete(ctxOf(who), { serverId: id, repoId, removalPr: false })).rejects.toMatchObject({ status: 409, code: 'project_not_on_server' });
    });
  });
});
