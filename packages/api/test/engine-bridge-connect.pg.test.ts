import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { bridgePhase, bridgePlan } from '@fx/db/src/engineBridgeConnect.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const woken: string[] = [];
vi.mock('@fx/core/src/pendingWork.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fx/core/src/pendingWork.js')>()),
  markRunnerWork: vi.fn(async (accountId: string) => {
    woken.push(accountId);
  }),
}));

/**
 * [pg] D#845 ON-BR-2: Connect and Disconnect, the person's side, through the real handler, RLS and audit function (criteria 2, 5, 6, 8 and 10). Nothing here sets up
 * an engine session or the operate switch: a Connect must work without either. The runner's answers are written as the admin role, the way the runner's own ack route would.
 */
const KEY_ROOT = '/work/acme/site';

interface View {
  phase: string;
  plan: string;
  runners: Array<{ id: string; name: string; online: boolean; protocol_ok: boolean }>;
  connected: { runner_id: string; runner_name: string; root_tail: string | null; root: string | null; reported_at: string } | null;
  command: { id: string; kind: string; state: string; result: string | null; root_tail: string | null; candidates: string[] } | null;
}

interface Identity {
  accountId: string;
  userId: string;
}

describe('engine bridge connect: the routes [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let one: Pool;
  let plain: Pool;
  let platformOpsPool: Pool;

  async function call(identity: Identity | null, method: string, urlPath: string, body?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else if (identity) headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), bearer ? plain : one, platformOpsPool, ROUTES);
  }
  const code = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;
  const path = (repo: string) => `/engine/repos/${repo}/bridge`;
  const connect = (who: Identity | null, repo: string, body: object = {}) => call(who, 'POST', path(repo), body);
  const disconnect = (who: Identity | null, repo: string) => call(who, 'DELETE', path(repo));
  const view = async (who: Identity, repo: string) => (await (await call(who, 'GET', path(repo))).json()) as View;

  async function member(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }
  async function runnerFor(accountId: string, userId: string, repo: string, o: { protocol?: number; online?: boolean; name?: string } = {}): Promise<string> {
    const id = await insertRunner(admin, accountId, userId, { keepPlan: true });
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[], protocol_version = $3, last_seen_at = $4 WHERE id = $1', [id, [repo], o.protocol ?? 24, o.online === false ? new Date(Date.now() - 3 * 3600_000) : new Date()]);
    if (o.name !== undefined) await admin.query('INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)', [id, accountId, o.name]);
    return id;
  }

  /** An account with an owner, an admin and a member, one runner_local repo and one online runner at protocol 24: no operate switch, no engine session. */
  async function fixture(o: { runner?: boolean } = {}) {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const gh = Math.floor(Math.random() * 1e9) + 1e9;
    const repo = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'w', 'runner_local') RETURNING id`, [owner.accountId, gh])).rows[0]!.id;
    const runner = o.runner === false ? '' : await runnerFor(owner.accountId, owner.userId, repo, { name: 'Studio laptop' });
    return { owner, admin: await member(owner.accountId, 'admin'), member: await member(owner.accountId, 'member'), repo, runner, gh };
  }
  const rows = async (accountId: string) => (await admin.query('SELECT * FROM engine_commands WHERE account_id = $1 ORDER BY issued_at, command_seq', [accountId])).rows;
  const audits = async (accountId: string, action = 'engine_command.issued') => (await admin.query('SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2', [accountId, action])).rows;
  /** The runner answers the newest command: the state and result the ack route would store. */
  async function answer(commandId: string, state: 'applied' | 'refused', result: object | null, refusal: string | null = null): Promise<void> {
    await admin.query(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1`, [commandId]);
    await admin.query(`UPDATE engine_commands SET state = $2, acked_at = now(), refusal = $3, ack_result = $4::jsonb WHERE id = $1`, [commandId, state, refusal, result === null ? null : JSON.stringify(result)]);
  }
  const reported = (accountId: string, runner: string, repo: string, root: string | null, ago = '0 seconds') =>
    admin.query(`INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root, reported_at) VALUES ($1, $2, $3, $4, now() - $5::interval)`, [accountId, runner, repo, root, ago]);

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    plain = createPool(process.env.API_DATABASE_URL_APP_USER!);
    one = createPool(process.env.API_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), one.end(), plain.end(), platformOpsPool.end()]);
  });
  beforeEach(() => {
    woken.length = 0;
  });

  describe('Connect', () => {
    it('sends one bridge_enable to the one online runner, with no operate switch and no engine session; one audit row without a path; a wake', async () => {
      const f = await fixture();
      expect((await admin.query('SELECT 1 FROM engine_bridge_settings WHERE account_id = $1', [f.owner.accountId])).rowCount).toBe(0);
      const res = await connect(f.owner, f.repo);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { command_id: string; state: string; expires_at: string; runner_id: string };
      expect(body).toMatchObject({ state: 'pending', runner_id: f.runner });
      const [row] = await rows(f.owner.accountId);
      expect(row).toMatchObject({ id: body.command_id, runner_id: f.runner, repo_id: f.repo, kind: 'bridge_enable', args: {}, command_seq: '1', state: 'pending', issued_by: f.owner.userId });
      expect(Date.parse(body.expires_at) - row.issued_at.getTime()).toBe(600_000);
      const log = await audits(f.owner.accountId);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actor: f.owner.userId, payload: { repo_id: f.repo, command_id: body.command_id, kind: 'bridge_enable' } });
      expect(woken).toEqual([f.owner.accountId]);
    });

    it('an admin may; a member, a token, no session and a stranger may not, and nothing is written', async () => {
      const f = await fixture();
      const other = await fixture();
      expect((await connect(null, f.repo)).status).toBe(401);
      expect((await connect(f.member, f.repo)).status).toBe(403);
      const token = generateToken();
      await insertApiToken(plain, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(token), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
      const viaToken = await call(null, 'POST', path(f.repo), {}, token);
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe('session_required');
      expect((await call(null, 'DELETE', path(f.repo), undefined, token)).status).toBe(403);
      expect((await connect(other.owner, f.repo)).status).toBe(404);
      expect(await rows(f.owner.accountId)).toHaveLength(0);
      expect((await connect(f.admin, f.repo)).status).toBe(201);
    });

    it('404 for a repo that is not the account\'s, and for a runner id that is not a paired runner of the account', async () => {
      const f = await fixture();
      const other = await fixture();
      expect((await connect(f.owner, randomUUID())).status).toBe(404);
      expect((await connect(f.owner, f.repo, { runner_id: other.runner })).status).toBe(404);
      expect((await connect(f.owner, f.repo, { runner_id: randomUUID() })).status).toBe(404);
      // A runner of this account that is not paired with the repo is as unknown as another account's.
      const stray = await insertRunner(admin, f.owner.accountId, f.owner.userId, { keepPlan: true });
      await admin.query('UPDATE runners SET protocol_version = 24, last_seen_at = now() WHERE id = $1', [stray]);
      expect((await connect(f.owner, f.repo, { runner_id: stray })).status).toBe(404);
      expect(await rows(f.owner.accountId)).toHaveLength(0);
      expect(await rows(other.owner.accountId)).toHaveLength(0);
    });

    it('with no runner paired, none online, or only older ones, it says which and sends nothing', async () => {
      const none = await fixture({ runner: false });
      const r0 = await connect(none.owner, none.repo);
      expect([r0.status, await code(r0)]).toEqual([409, 'no_runner_online']);
      const offline = await fixture({ runner: false });
      await runnerFor(offline.owner.accountId, offline.owner.userId, offline.repo, { online: false });
      const r1 = await connect(offline.owner, offline.repo);
      expect([r1.status, await code(r1)]).toEqual([409, 'no_runner_online']);
      const old = await fixture({ runner: false });
      await runnerFor(old.owner.accountId, old.owner.userId, old.repo, { protocol: 23 });
      const r2 = await connect(old.owner, old.repo);
      expect([r2.status, await code(r2)]).toEqual([409, 'runner_too_old']);
      for (const f of [none, offline, old]) expect(await rows(f.owner.accountId)).toHaveLength(0);
    });

    it('with several online runners it asks which; the chosen one gets it, a chosen one that is old or offline does not', async () => {
      const f = await fixture();
      const second = await runnerFor(f.owner.accountId, f.owner.userId, f.repo, { name: 'Desk machine' });
      const oldOne = await runnerFor(f.owner.accountId, f.owner.userId, f.repo, { protocol: 22 });
      const away = await runnerFor(f.owner.accountId, f.owner.userId, f.repo, { online: false });
      const ask = await connect(f.owner, f.repo);
      expect([ask.status, await code(ask)]).toEqual([409, 'runner_choice_needed']);
      for (const [id, why] of [[oldOne, 'runner_too_old'], [away, 'no_runner_online']] as const) {
        const res = await connect(f.owner, f.repo, { runner_id: id });
        expect([res.status, await code(res)], why).toEqual([409, why]);
      }
      expect(await rows(f.owner.accountId)).toHaveLength(0);
      const res = await connect(f.owner, f.repo, { runner_id: second });
      expect(res.status).toBe(201);
      expect((await rows(f.owner.accountId))[0]!.runner_id).toBe(second);
    });

    it('409 bridge_pending while one is undelivered, so a double click sends one; it is free again once delivered', async () => {
      const f = await fixture();
      // A slow insert keeps the first click's transaction open long enough that the others check while it is, which is what a real double click does on a busy database.
      await admin.query(`CREATE FUNCTION onbr2_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$`);
      await admin.query('CREATE TRIGGER onbr2_slow_insert BEFORE INSERT ON engine_commands FOR EACH ROW EXECUTE FUNCTION onbr2_slow_insert()');
      let many: Response[];
      try {
        many = await Promise.all(Array.from({ length: 8 }, () => connect(f.owner, f.repo)));
      } finally {
        await admin.query('DROP TRIGGER onbr2_slow_insert ON engine_commands');
        await admin.query('DROP FUNCTION onbr2_slow_insert()');
      }
      expect(many.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
      for (const refused of many.filter((r) => r.status === 409)) expect(await code(refused)).toBe('bridge_pending');
      const all = await rows(f.owner.accountId);
      expect(all).toHaveLength(1);
      await admin.query(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1`, [all[0]!.id]);
      expect((await connect(f.owner, f.repo)).status).toBe(201);
    });

    it('429 after 5 bridge commands in 10 minutes, with Retry-After; another account is not held; the old ones age out', async () => {
      const f = await fixture();
      const other = await fixture();
      for (let i = 0; i < 5; i++) {
        const res = await connect(f.owner, f.repo);
        expect(res.status, `command ${i + 1}`).toBe(201);
        await admin.query(`UPDATE engine_commands SET state = 'cancelled' WHERE account_id = $1 AND state = 'pending'`, [f.owner.accountId]);
      }
      const sixth = await connect(f.owner, f.repo);
      expect(sixth.status).toBe(429);
      expect(await code(sixth)).toBe('rate_limited');
      expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await rows(f.owner.accountId)).toHaveLength(5);
      expect((await connect(other.owner, other.repo)).status).toBe(201);
      // A disconnect counts as one of the five.
      await admin.query(`UPDATE engine_commands SET issued_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE account_id = $1`, [f.owner.accountId]);
      expect((await connect(f.owner, f.repo)).status).toBe(201);
    });

    it('a repo_root is accepted only if that runner offered it for this repo in the last 10 minutes; a typed path is 400 root_not_offered', async () => {
      const f = await fixture();
      const typed = await connect(f.owner, f.repo, { repo_root: KEY_ROOT });
      expect([typed.status, await code(typed)]).toEqual([400, 'root_not_offered']);
      expect((await connect(f.owner, f.repo, { repo_root: 'relative/path' })).status).toBe(422);
      expect((await connect(f.owner, f.repo, { repo_root: '/work/../etc' })).status).toBe(422);
      expect((await rows(f.owner.accountId))).toHaveLength(0);
      // The runner offers two folders.
      const first = (await (await connect(f.owner, f.repo)).json()) as { command_id: string };
      await answer(first.command_id, 'refused', { result: 'ambiguous', candidates: [KEY_ROOT, '/work/other/site'] }, 'checkout_ambiguous');
      for (const picked of [KEY_ROOT, '/work/other/site']) {
        const res = await connect(f.owner, f.repo, { repo_root: picked });
        expect(res.status, picked).toBe(201);
        await admin.query(`UPDATE engine_commands SET state = 'cancelled' WHERE account_id = $1 AND state = 'pending'`, [f.owner.accountId]);
      }
      expect((await rows(f.owner.accountId)).at(-1)!.args).toEqual({ repo_root: '/work/other/site' });
      // A folder it never offered, another runner's offer, another repo's offer, and a stale offer are all refused.
      const never = await connect(f.owner, f.repo, { repo_root: '/work/never/offered' });
      expect(await code(never)).toBe('root_not_offered');
      await admin.query(`UPDATE engine_commands SET acked_at = now() - interval '11 minutes' WHERE id = $1`, [first.command_id]);
      const stale = await connect(f.owner, f.repo, { repo_root: KEY_ROOT });
      expect(await code(stale)).toBe('root_not_offered');
    });

    it('an offer made for another repo or by another runner does not count', async () => {
      const f = await fixture();
      const second = await runnerFor(f.owner.accountId, f.owner.userId, f.repo);
      const repo2 = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'x', 'runner_local') RETURNING id`, [f.owner.accountId, Math.floor(Math.random() * 1e9) + 3e9])).rows[0]!.id;
      await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = ANY ($1::uuid[])', [[f.runner, second], [f.repo, repo2]]);
      // Offered by the first runner for repo 2.
      const c2 = (await (await connect(f.owner, repo2, { runner_id: f.runner })).json()) as { command_id: string };
      await answer(c2.command_id, 'refused', { result: 'ambiguous', candidates: [KEY_ROOT, '/work/b/site'] }, 'checkout_ambiguous');
      const wrongRepo = await connect(f.owner, f.repo, { runner_id: f.runner, repo_root: KEY_ROOT });
      expect(await code(wrongRepo)).toBe('root_not_offered');
      const wrongRunner = await connect(f.owner, repo2, { runner_id: second, repo_root: KEY_ROOT });
      expect(await code(wrongRunner)).toBe('root_not_offered');
      expect((await connect(f.owner, repo2, { runner_id: f.runner, repo_root: KEY_ROOT })).status).toBe(201);
    });
  });

  describe('Disconnect', () => {
    it('goes to the runner that reports the repo, even offline, and queues; the repo reads disconnecting until the ack', async () => {
      const f = await fixture();
      await reported(f.owner.accountId, f.runner, f.repo, KEY_ROOT);
      expect((await view(f.owner, f.repo)).phase).toBe('connected');
      await admin.query('UPDATE runners SET last_seen_at = now() - interval \'3 hours\' WHERE id = $1', [f.runner]);
      const res = await disconnect(f.owner, f.repo);
      expect(res.status).toBe(201);
      const [row] = await rows(f.owner.accountId);
      expect(row).toMatchObject({ kind: 'bridge_disable', runner_id: f.runner, args: {}, state: 'pending' });
      expect((await audits(f.owner.accountId))[0]!.payload).toMatchObject({ kind: 'bridge_disable' });
      const v = await view(f.owner, f.repo);
      expect(v.phase).toBe('disconnecting');
      expect(v.connected).not.toBeNull();
      // The runner comes back, takes it, removes its report and acks.
      await answer(row.id, 'applied', null);
      await admin.query('DELETE FROM engine_runner_bridges WHERE repo_id = $1', [f.repo]);
      expect((await view(f.owner, f.repo)).phase).toBe('idle');
    });

    it('409 bridge_not_connected when no runner reports the repo; 409 bridge_pending while one waits; roles and tenants as for Connect', async () => {
      const f = await fixture();
      const other = await fixture();
      const none = await disconnect(f.owner, f.repo);
      expect([none.status, await code(none)]).toEqual([409, 'bridge_not_connected']);
      await reported(f.owner.accountId, f.runner, f.repo, KEY_ROOT);
      expect((await disconnect(f.member, f.repo)).status).toBe(403);
      expect((await disconnect(other.owner, f.repo)).status).toBe(404);
      expect((await disconnect(f.admin, f.repo)).status).toBe(201);
      const again = await disconnect(f.owner, f.repo);
      expect([again.status, await code(again)]).toEqual([409, 'bridge_pending']);
      expect((await connect(f.owner, f.repo)).status).toBe(409);
    });

    it('a disconnect that expired unanswered reads "disconnect_failed", never connected; Disconnect works again, and a report that drops the repo ends it', async () => {
      const f = await fixture();
      await reported(f.owner.accountId, f.runner, f.repo, KEY_ROOT);
      expect((await disconnect(f.owner, f.repo)).status).toBe(201);
      await admin.query(`UPDATE engine_commands SET issued_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE account_id = $1`, [f.owner.accountId]);
      const v = await view(f.owner, f.repo);
      expect(v.phase).toBe('disconnect_failed');
      expect(v.connected).not.toBeNull();
      expect((await disconnect(f.owner, f.repo)).status).toBe(201);
      expect((await view(f.owner, f.repo)).phase).toBe('disconnecting');
      await admin.query(`UPDATE engine_commands SET state = 'cancelled' WHERE account_id = $1 AND state = 'pending'`, [f.owner.accountId]);
      await admin.query('DELETE FROM engine_runner_bridges WHERE repo_id = $1', [f.repo]);
      expect((await view(f.owner, f.repo)).phase).toBe('idle');
    });

    it('a disconnect the runner refused reads disconnect_refused with its reason, not connected; pressing Disconnect again is allowed', async () => {
      const f = await fixture();
      await reported(f.owner.accountId, f.runner, f.repo, KEY_ROOT);
      const first = (await (await disconnect(f.owner, f.repo)).json()) as { command_id: string };
      await answer(first.command_id, 'refused', null, 'bridge_failed');
      const v = await view(f.owner, f.repo);
      expect(v.phase).toBe('disconnect_refused');
      expect(v.command).toMatchObject({ kind: 'bridge_disable', state: 'refused' });
      expect(((await (await call(f.owner, 'GET', path(f.repo))).json()) as { command: { refusal: string } }).command.refusal).toBe('bridge_failed');
      expect((await disconnect(f.owner, f.repo)).status).toBe(201);
    });

    it('a report that is more than 24 hours old, or a revoked runner\'s, is not "connected"', async () => {
      const f = await fixture();
      await reported(f.owner.accountId, f.runner, f.repo, KEY_ROOT, '25 hours');
      expect((await view(f.owner, f.repo)).connected).toBeNull();
      expect((await disconnect(f.owner, f.repo)).status).toBe(409);
      await admin.query('UPDATE engine_runner_bridges SET reported_at = now()');
      expect((await view(f.owner, f.repo)).phase).toBe('connected');
      await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1`, [f.runner]);
      expect((await view(f.owner, f.repo)).connected).toBeNull();
    });
  });

  describe('the view', () => {
    it('a member sees the runner names and the last two parts, never a path; an owner sees both', async () => {
      const f = await fixture();
      await reported(f.owner.accountId, f.runner, f.repo, '/home/me/work/acme/site');
      const asMember = await view(f.member, f.repo);
      expect(asMember.connected).toMatchObject({ runner_name: 'Studio laptop', root_tail: 'acme/site', root: null });
      expect(JSON.stringify(asMember)).not.toContain('/home/me');
      const asOwner = await view(f.owner, f.repo);
      expect(asOwner.connected!.root).toBe('/home/me/work/acme/site');
      expect(asOwner).toMatchObject({ phase: 'connected', plan: 'send', runners: [{ name: 'Studio laptop', online: true, protocol_ok: true }] });
    });

    it('offered folders reach an owner or admin only, and a path never carries more than its two parts to a member', async () => {
      const f = await fixture();
      const c = (await (await connect(f.owner, f.repo)).json()) as { command_id: string };
      await answer(c.command_id, 'refused', { result: 'ambiguous', candidates: ['/home/me/a/site', '/home/me/b/site'] }, 'checkout_ambiguous');
      const asOwner = await view(f.owner, f.repo);
      expect(asOwner).toMatchObject({ phase: 'ambiguous', command: { result: 'ambiguous', candidates: ['/home/me/a/site', '/home/me/b/site'] } });
      const asMember = await view(f.member, f.repo);
      expect(asMember.phase).toBe('ambiguous');
      expect(asMember.command!.candidates).toEqual([]);
      expect(JSON.stringify(asMember)).not.toContain('/home/me');
      // And the older command list never carries a bridge command at all.
      const list = await call(f.member, 'GET', `/engine/repos/${f.repo}/commands`);
      expect(((await list.json()) as { commands: unknown[] }).commands).toEqual([]);
    });

    it('copies the runner skipped as unsafe come back as information only: an owner sees them in `skipped`, never in the pickable candidates, a member sees none, and none can be sent as a folder', async () => {
      const f = await fixture();
      const c = (await (await connect(f.owner, f.repo)).json()) as { command_id: string };
      await answer(c.command_id, 'refused', { result: 'not_found', skipped: ['/home/me/shared/site'] }, 'checkout_not_found');
      const asOwner = (await view(f.owner, f.repo)) as unknown as { command: { candidates: string[]; skipped: string[] } };
      expect(asOwner.command).toMatchObject({ candidates: [], skipped: ['/home/me/shared/site'] });
      const asMember = (await view(f.member, f.repo)) as unknown as { command: { skipped: string[] } };
      expect(asMember.command.skipped).toEqual([]);
      expect(JSON.stringify(asMember)).not.toContain('/home/me');
      const picked = await connect(f.owner, f.repo, { repo_root: '/home/me/shared/site' });
      expect([picked.status, await code(picked)]).toEqual([400, 'root_not_offered']);
    });

    it('ON-BR-4: a not_found from a capped search reads back `incomplete: true` to an owner and to a member (it is no folder), an uncapped one and any other answer read false, and the phase stays not_found', async () => {
      const f = await fixture();
      const c = (await (await connect(f.owner, f.repo)).json()) as { command_id: string };
      await answer(c.command_id, 'refused', { result: 'not_found', incomplete: true }, 'checkout_not_found');
      for (const who of [f.owner, f.member]) {
        const v = (await view(who, f.repo)) as unknown as { phase: string; command: { incomplete: boolean; candidates: string[]; skipped: string[] } };
        expect(v.phase).toBe('not_found');
        expect(v.command).toMatchObject({ incomplete: true, candidates: [], skipped: [] });
      }
      const g = await fixture();
      const c2 = (await (await connect(g.owner, g.repo)).json()) as { command_id: string };
      await answer(c2.command_id, 'refused', { result: 'not_found' }, 'checkout_not_found');
      expect(((await view(g.owner, g.repo)) as unknown as { command: { incomplete: boolean } }).command.incomplete).toBe(false);
      const h = await fixture();
      const c3 = (await (await connect(h.owner, h.repo)).json()) as { command_id: string };
      await answer(c3.command_id, 'refused', { result: 'ambiguous', candidates: ['/home/me/a/site', '/home/me/b/site'] }, 'checkout_ambiguous');
      expect(((await view(h.owner, h.repo)) as unknown as { command: { incomplete: boolean } }).command.incomplete).toBe(false);
    });

    it('404 for a repo that is not the account\'s; a token is refused', async () => {
      const f = await fixture();
      const other = await fixture();
      expect((await call(other.owner, 'GET', path(f.repo))).status).toBe(404);
      const token = generateToken();
      await insertApiToken(plain, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(token), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
      expect((await call(null, 'GET', path(f.repo), undefined, token)).status).toBe(403);
    });

    it('cancel works on a pending bridge command through the existing route, and the screen goes back to idle', async () => {
      const f = await fixture();
      const c = (await (await connect(f.owner, f.repo)).json()) as { command_id: string };
      expect((await view(f.owner, f.repo)).phase).toBe('connecting');
      expect((await call(f.owner, 'DELETE', `/engine/commands/${c.command_id}`)).status).toBe(200);
      expect((await view(f.owner, f.repo)).phase).toBe('idle');
    });
  });

  describe('what the screen derives', () => {
    const cmd = (over: Record<string, unknown>) => ({ id: 'x', kind: 'bridge_enable', runner_id: 'r', state: 'applied', refusal: null, result: null, root_tail: null, candidates: [], issued_at: new Date(), expires_at: new Date(), delivered_at: null, acked_at: new Date(), ...over }) as never;
    const now = new Date();
    it('phases', () => {
      expect(bridgePhase({ connected: false, command: null, now })).toBe('idle');
      expect(bridgePhase({ connected: true, command: null, now })).toBe('connected');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'pending', acked_at: null }), now })).toBe('connecting');
      expect(bridgePhase({ connected: true, command: cmd({ kind: 'bridge_disable', state: 'delivered', acked_at: null }), now })).toBe('disconnecting');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'refused', result: 'not_found', refusal: 'checkout_not_found' }), now })).toBe('not_found');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'refused', result: 'ambiguous' }), now })).toBe('ambiguous');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'refused', result: 'refused', refusal: 'checkout_incomplete' }), now })).toBe('incomplete');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'refused', result: 'refused', refusal: 'state_dir_missing' }), now })).toBe('refused');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'not_confirmed', acked_at: null }), now })).toBe('not_confirmed');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'expired', acked_at: null }), now })).toBe('expired');
      expect(bridgePhase({ connected: false, command: cmd({ state: 'refused', result: 'ambiguous', acked_at: new Date(now.getTime() - 11 * 60_000) }), now })).toBe('idle');
      // A connect that was acked while a report says connected is connected; a disconnect that was applied leaves the repo idle.
      expect(bridgePhase({ connected: true, command: cmd({ state: 'applied', result: 'connected' }), now })).toBe('connected');
      expect(bridgePhase({ connected: false, command: cmd({ kind: 'bridge_disable', state: 'applied' }), now })).toBe('idle');
      // Ruling 8: a disconnect that ran out unanswered does not read connected as if nothing was asked.
      const lapsed = (over: Record<string, unknown>) => cmd({ kind: 'bridge_disable', acked_at: null, expires_at: new Date(now.getTime() - 1000), ...over });
      expect(bridgePhase({ connected: true, command: lapsed({ state: 'expired' }), now })).toBe('disconnect_failed');
      expect(bridgePhase({ connected: true, command: lapsed({ state: 'not_confirmed' }), now })).toBe('disconnect_failed');
      expect(bridgePhase({ connected: true, command: lapsed({ state: 'delivered' }), now })).toBe('disconnect_failed');
      expect(bridgePhase({ connected: true, command: lapsed({ state: 'delivered', expires_at: new Date(now.getTime() + 60_000) }), now })).toBe('disconnecting');
      // It ends when the report no longer lists the repo, and a newer command takes over.
      expect(bridgePhase({ connected: false, command: lapsed({ state: 'expired' }), now })).toBe('idle');
      expect(bridgePhase({ connected: true, command: cmd({ state: 'pending', acked_at: null }), now })).toBe('connecting');
      expect(bridgePhase({ connected: true, command: cmd({ kind: 'bridge_disable', state: 'refused', refusal: 'bridge_failed' }), now })).toBe('disconnect_refused');
    });
    it('plans', () => {
      const r = (over: object) => ({ id: 'a', name: 'n', has_name: true, last_seen_at: null, online: true, protocol_ok: true, ...over });
      expect(bridgePlan([])).toBe('no_runner');
      expect(bridgePlan([r({})])).toBe('send');
      expect(bridgePlan([r({}), r({ id: 'b' })])).toBe('choose');
      expect(bridgePlan([r({ online: false })])).toBe('offline');
      expect(bridgePlan([r({ protocol_ok: false })])).toBe('old');
      expect(bridgePlan([r({ protocol_ok: false }), r({ online: false })])).toBe('old');
      expect(bridgePlan([r({ protocol_ok: false }), r({})])).toBe('send');
    });
  });
});
