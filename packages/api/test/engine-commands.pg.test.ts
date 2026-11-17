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
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const woken: string[] = [];
vi.mock('@fx/core/src/pendingWork.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fx/core/src/pendingWork.js')>()),
  markRunnerWork: vi.fn(async (accountId: string) => {
    woken.push(accountId);
  }),
}));

/**
 * [pg] EB-8a: the person's side of the engine command channel (issue, cancel, list) through the real handler, RLS, trigger and audit function.
 * The bridge tables this reads beside its own (settings, sessions, and the halt marker that migration 1031 adds) are built by their own rows; where one
 * is missing, a table of the Spec's shape stands in for it in a scratch schema that the pool lists before `public`. Where migration 1031 is present, the
 * halt tests use its real marker and trigger; where it is not, a stand-in trigger with the same name, event and error raises HX409 for the same four kinds.
 */
const SCRATCH = `eb8a_${Math.random().toString(36).slice(2, 10)}`;
const START_LIKE = ['start_day', 'resume_loop', 'request_spawn', 'set_dial'] as const;
const KIND_ARGS: Record<string, object> = {
  start_day: {},
  pause_loop: {},
  resume_loop: {},
  answer_ask: { ask_id: '0123456789abcdef', choice: 'approve' },
  set_dial: { dial_class: 'merge.standard', level: 2, ttl: 'for_today' },
  request_spawn: { role: 'executor', discussion: 842 },
  stop_agent: { agent_id: 'agent-7' },
};

interface Identity {
  accountId: string;
  userId: string;
}

describe('engine commands: issue, cancel, list [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let one: Pool;
  let plain: Pool;
  let platformOpsPool: Pool;
  let realHalt = false;
  let standInTrigger = false;

  async function call(identity: Identity | null, method: string, urlPath: string, body?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else if (identity) headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), bearer ? plain : one, platformOpsPool, ROUTES);
  }
  const code = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;

  async function member(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }

  /** An account with an owner, an admin and a member, one runner_local repo with a runner that covers it and a live engine session. */
  async function fixture(opts: { session?: boolean; operate?: boolean } = {}) {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const gh = Math.floor(Math.random() * 1e9) + 1e9;
    const repo = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'w', 'runner_local') RETURNING id`, [owner.accountId, gh])).rows[0]!.id;
    const runner = await insertRunner(admin, owner.accountId, owner.userId, { keepPlan: true });
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [runner, [repo]]);
    if (opts.operate !== false) await admin.query(`INSERT INTO ${SCRATCH}.engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)`, [owner.accountId]);
    if (opts.session !== false) await session(owner.accountId, repo, runner);
    return { owner, admin: await member(owner.accountId, 'admin'), member: await member(owner.accountId, 'member'), repo, runner, gh };
  }
  const session = (accountId: string, repo: string, runner: string, ago = '0 seconds') =>
    admin.query(
      `INSERT INTO ${SCRATCH}.engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, last_event_at, last_heartbeat_at) VALUES ($1, $2, $3, $4, $5, now() - $6::interval, now() - $6::interval)`,
      [randomUUID(), accountId, runner, repo, randomUUID(), ago],
    );
  const rows = async (accountId: string) => (await admin.query('SELECT * FROM engine_commands WHERE account_id = $1 ORDER BY command_seq', [accountId])).rows;
  const audits = async (accountId: string, action = 'engine_command.issued') => (await admin.query('SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2', [accountId, action])).rows;
  const path = (repo: string) => `/engine/repos/${repo}/commands`;
  const issue = (who: Identity | null, repo: string, kind: string, args: object = KIND_ARGS[kind] ?? {}) => call(who, 'POST', path(repo), { kind, args });

  /** Halts or un-halts a repo the way the marker does, in whichever table the halt trigger reads. */
  async function setHalted(accountId: string, repo: string, on: boolean): Promise<void> {
    if (realHalt) {
      await admin.query(
        `INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_action_id, halt_epoch) VALUES ($1, $2, ${on ? 'now()' : 'NULL'}, ${on ? 'gen_random_uuid()' : 'NULL'}, 4)
         ON CONFLICT (account_id, repo_id) DO UPDATE SET halted_at = EXCLUDED.halted_at, halt_action_id = EXCLUDED.halt_action_id, halt_epoch = 4`,
        [accountId, repo],
      );
    } else {
      await admin.query(`DELETE FROM ${SCRATCH}.engine_repo_controls WHERE repo_id = $1`, [repo]);
      await admin.query(`INSERT INTO ${SCRATCH}.engine_repo_controls (account_id, repo_id, halted_at, halt_epoch) VALUES ($1, $2, ${on ? 'now()' : 'NULL'}, 4)`, [accountId, repo]);
    }
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    await admin.query(`CREATE SCHEMA ${SCRATCH}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${SCRATCH} TO app_user`);
    plain = createPool(process.env.API_DATABASE_URL_APP_USER!);
    one = createPool(process.env.API_DATABASE_URL_APP_USER!, { options: `-c search_path=${SCRATCH},public` });
    await admin.query(`CREATE TABLE ${SCRATCH}.engine_bridge_settings (account_id uuid PRIMARY KEY, watch_enabled boolean NOT NULL DEFAULT false, operate_enabled boolean NOT NULL DEFAULT false)`);
    await admin.query(
      `CREATE TABLE ${SCRATCH}.engine_sessions (id uuid PRIMARY KEY, account_id uuid NOT NULL, runner_id uuid NOT NULL, repo_id uuid NOT NULL, engine_instance_id uuid NOT NULL, last_event_at timestamptz, last_heartbeat_at timestamptz)`,
    );
    realHalt = (await admin.query<{ p: boolean }>("SELECT to_regclass('public.engine_repo_controls') IS NOT NULL AS p")).rows[0]!.p;
    if (!realHalt) {
      await admin.query(`CREATE TABLE ${SCRATCH}.engine_repo_controls (account_id uuid, repo_id uuid PRIMARY KEY, halted_at timestamptz, halt_epoch integer NOT NULL DEFAULT 0)`);
      await admin.query(
        `CREATE FUNCTION ${SCRATCH}.refuse_halted() RETURNS trigger LANGUAGE plpgsql SET search_path = ${SCRATCH}, pg_catalog, public AS $$
         BEGIN
           IF NEW.kind IN ('start_day', 'resume_loop', 'request_spawn', 'set_dial') AND EXISTS (SELECT 1 FROM ${SCRATCH}.engine_repo_controls WHERE repo_id = NEW.repo_id AND halted_at IS NOT NULL) THEN
             RAISE EXCEPTION 'engine_halted' USING ERRCODE = 'HX409';
           END IF;
           RETURN NEW;
         END $$`,
      );
      await admin.query(`CREATE TRIGGER ${SCRATCH}_refuse_halted BEFORE INSERT ON engine_commands FOR EACH ROW EXECUTE FUNCTION ${SCRATCH}.refuse_halted()`);
      standInTrigger = true;
    }
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCRATCH} TO app_user`);
  });
  afterAll(async () => {
    if (standInTrigger) await admin.query(`DROP TRIGGER ${SCRATCH}_refuse_halted ON engine_commands`);
    await admin.query(`DROP SCHEMA ${SCRATCH} CASCADE`);
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), one.end(), plain.end(), platformOpsPool.end()]);
  });
  beforeEach(() => {
    woken.length = 0;
  });

  describe('issuing', () => {
    it.each(Object.keys(KIND_ARGS))('an owner sends %s: 201 pending, one row for the session\'s runner, one audit row, a wake', async (kind) => {
      const f = await fixture();
      const res = await issue(f.owner, f.repo, kind);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { command_id: string; state: string; expires_at: string };
      expect(body.state).toBe('pending');
      const [row] = await rows(f.owner.accountId);
      expect(row).toMatchObject({ id: body.command_id, runner_id: f.runner, repo_id: f.repo, kind, command_seq: '1', state: 'pending', issued_by: f.owner.userId });
      expect(row.args).toEqual(KIND_ARGS[kind]);
      expect(Date.parse(body.expires_at) - row.issued_at.getTime()).toBe(600_000);
      const log = await audits(f.owner.accountId);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actor: f.owner.userId, payload: { repo_id: f.repo, command_id: body.command_id, kind } });
      expect(woken).toEqual([f.owner.accountId]);
    });

    it('an admin may too; sequence numbers count up per runner and repo', async () => {
      const f = await fixture();
      for (let i = 0; i < 3; i++) expect((await issue(f.admin, f.repo, 'pause_loop')).status).toBe(201);
      expect((await rows(f.owner.accountId)).map((r) => r.command_seq)).toEqual(['1', '2', '3']);
    });

    it('simultaneous commands get distinct, increasing sequence numbers', async () => {
      const f = await fixture();
      const all = await Promise.all(Array.from({ length: 8 }, () => issue(f.owner, f.repo, 'pause_loop')));
      expect(all.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect((await rows(f.owner.accountId)).map((r) => Number(r.command_seq))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('the note travels in the args and stays out of the audit row', async () => {
      const f = await fixture();
      const res = await issue(f.owner, f.repo, 'answer_ask', { ask_id: '0123456789abcdef', choice: 'defer', note: 'hold until tests are green' });
      expect(res.status).toBe(201);
      expect((await rows(f.owner.accountId))[0].args.note).toBe('hold until tests are green');
      expect(JSON.stringify(await audits(f.owner.accountId))).not.toContain('tests');
    });

    it('a member, a token, a stranger and no one at all cannot, and nothing is written', async () => {
      const f = await fixture();
      const other = await fixture();
      expect((await issue(null, f.repo, 'start_day')).status).toBe(401);
      expect((await issue(f.member, f.repo, 'start_day')).status).toBe(403);
      const token = generateToken();
      await insertApiToken(plain, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(token), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
      const viaToken = await call(null, 'POST', path(f.repo), { kind: 'start_day', args: {} }, token);
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe('session_required');
      // Another account's owner meets a repo that is not theirs: 404, as for any repo that does not exist.
      expect((await issue(other.owner, f.repo, 'start_day')).status).toBe(404);
      expect(await rows(f.owner.accountId)).toEqual([]);
      expect(await rows(other.owner.accountId)).toEqual([]);
      expect(await audits(f.owner.accountId)).toEqual([]);
      expect(woken).toEqual([]);
    });

    it('a request signed the way a runner signs, with no session, is 401 on every route here', async () => {
      const f = await fixture();
      const headers = new Headers({ 'content-type': 'application/json', signature: 'sig1=:AAAA:', 'signature-input': 'sig1=("@method");keyid="x"', 'content-digest': 'sha-256=:AAAA:' });
      for (const [method, urlPath] of [['POST', path(f.repo)], ['GET', path(f.repo)], ['DELETE', `/engine/commands/${randomUUID()}`]] as const) {
        const res = await handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify({ kind: 'start_day', args: {} }) } : {}) }), one, platformOpsPool, ROUTES);
        expect(res.status, `${method} ${urlPath}`).toBe(401);
      }
      expect(await rows(f.owner.accountId)).toEqual([]);
    });

    it('the same Idempotency-Key sends one command, not two', async () => {
      const f = await fixture();
      const send = async () =>
        handleApiRequest(
          new Request(`http://localhost/api/v1${path(f.repo)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': 'once-please-0001', cookie: `${SESSION_COOKIE_NAME}=${await signSession(f.owner)}` },
            body: JSON.stringify({ kind: 'start_day', args: {} }),
          }),
          one,
          platformOpsPool,
          ROUTES,
        );
      const first = await send();
      const second = await send();
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(((await first.json()) as { command_id: string }).command_id).toBe(((await second.json()) as { command_id: string }).command_id);
      expect(await rows(f.owner.accountId)).toHaveLength(1);
    });

    it('operate off is 409 operate_off whichever switch is off, and no engine connected is 409 engine_not_connected', async () => {
      const off = await fixture({ operate: false });
      expect(await code(await issue(off.owner, off.repo, 'start_day'))).toBe('operate_off');
      await admin.query(`INSERT INTO ${SCRATCH}.engine_bridge_settings VALUES ($1, true, false)`, [off.owner.accountId]);
      expect((await issue(off.owner, off.repo, 'start_day')).status).toBe(409);
      await admin.query(`UPDATE ${SCRATCH}.engine_bridge_settings SET watch_enabled = false, operate_enabled = true WHERE account_id = $1`, [off.owner.accountId]);
      expect(await code(await issue(off.owner, off.repo, 'start_day'))).toBe('operate_off');

      const none = await fixture({ session: false });
      expect(await code(await issue(none.owner, none.repo, 'start_day'))).toBe('engine_not_connected');
      const stale = await fixture({ session: false });
      await session(stale.owner.accountId, stale.repo, stale.runner, '10 minutes');
      expect(await code(await issue(stale.owner, stale.repo, 'start_day'))).toBe('engine_not_connected');
      for (const f of [off, none, stale]) expect(await rows(f.owner.accountId)).toEqual([]);
    });

    it('a session on a revoked runner, a runner that no longer covers the repo, or a repo not run locally is not connected', async () => {
      const f = await fixture();
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [f.runner]);
      expect(await code(await issue(f.owner, f.repo, 'pause_loop'))).toBe('engine_not_connected');
      await admin.query('UPDATE runners SET revoked_at = NULL, allowed_repo_ids = $2::uuid[] WHERE id = $1', [f.runner, []]);
      expect(await code(await issue(f.owner, f.repo, 'pause_loop'))).toBe('engine_not_connected');
      await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [f.runner, [f.repo]]);
      expect((await issue(f.owner, f.repo, 'pause_loop')).status).toBe(201);
      await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [f.repo]);
      expect(await code(await issue(f.owner, f.repo, 'pause_loop'))).toBe('engine_not_connected');
    });

    it('the target is the live session\'s runner whatever the request says: a runner field is refused, and the most recent session wins', async () => {
      const f = await fixture();
      const second = await insertRunner(admin, f.owner.accountId, f.owner.userId, { keepPlan: true });
      await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [second, [f.repo]]);
      const res = await call(f.owner, 'POST', path(f.repo), { kind: 'pause_loop', args: {}, runner_id: second });
      expect(res.status).toBe(422);
      expect(await rows(f.owner.accountId)).toEqual([]);
      await session(f.owner.accountId, f.repo, second, '0 seconds');
      await admin.query(`UPDATE ${SCRATCH}.engine_sessions SET last_event_at = now() - interval '60 seconds', last_heartbeat_at = now() - interval '60 seconds' WHERE runner_id = $1`, [f.runner]);
      expect((await issue(f.owner, f.repo, 'pause_loop')).status).toBe(201);
      expect((await rows(f.owner.accountId))[0].runner_id).toBe(second);
    });

    it('closed bodies: an unknown kind, another kind\'s args, a stray key, a bad dial, role, note or id is 422 and writes nothing', async () => {
      const f = await fixture();
      const bad: Array<[string, unknown]> = [
        ['rm_rf', {}],
        ['start_day', { x: 1 }],
        ['pause_loop', { discussion: 1 }],
        ['answer_ask', { ask_id: 'xyz', choice: 'approve' }],
        ['answer_ask', { ask_id: '0123456789abcdef', choice: 'sure' }],
        ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'x'.repeat(501) }],
        ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'a\nb' }],
        ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'a‮b' }],
        ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'a​b' }],
        ['set_dial', { dial_class: 'cost.spend', level: 1, ttl: 'none' }],
        ['set_dial', { dial_class: 'intent.generate', level: 1, ttl: 'none' }],
        ['set_dial', { dial_class: 'agent.spawn', level: 0, ttl: 'none' }],
        ['request_spawn', { role: 'root', discussion: 1 }],
        ['request_spawn', { role: 'executor', discussion: -4 }],
        ['stop_agent', { agent_id: '../etc' }],
      ];
      for (const [kind, args] of bad) expect((await call(f.owner, 'POST', path(f.repo), { kind, args })).status, `${kind} ${JSON.stringify(args)}`).toBe(422);
      expect((await call(f.owner, 'POST', path(f.repo), { args: {} })).status).toBe(422);
      expect((await call(f.owner, 'POST', path(f.repo), { kind: 'start_day', args: {}, extra: 1 })).status).toBe(422);
      expect(await rows(f.owner.accountId)).toEqual([]);
    });

    it('an unknown or malformed repo id is 404', async () => {
      const f = await fixture();
      expect((await issue(f.owner, randomUUID(), 'start_day')).status).toBe(404);
      expect((await issue(f.owner, 'not-a-uuid', 'start_day')).status).toBe(404);
    });

    it('twenty waiting commands is the most, per runner and repo', async () => {
      const f = await fixture();
      for (let i = 0; i < 20; i++) expect((await issue(f.owner, f.repo, 'pause_loop')).status).toBe(201);
      const res = await issue(f.owner, f.repo, 'pause_loop');
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('too_many_pending');
      await admin.query("UPDATE engine_commands SET state = 'expired' WHERE account_id = $1 AND command_seq <= 5", [f.owner.accountId]);
      expect((await issue(f.owner, f.repo, 'pause_loop')).status).toBe(201);
    });

    it('the halt epoch at issue is the repo\'s epoch', async () => {
      const f = await fixture();
      await setHalted(f.owner.accountId, f.repo, false);
      expect((await issue(f.owner, f.repo, 'pause_loop')).status).toBe(201);
      expect((await rows(f.owner.accountId))[0].halt_epoch_at_issue).toBe(4);
    });

    it('when the audit row cannot be written the command is not stored and the answer is a 500', async () => {
      const f = await fixture();
      await admin.query("CREATE OR REPLACE FUNCTION eb8a_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'engine_command.issued' THEN RAISE EXCEPTION 'blocked'; END IF; RETURN NEW; END $$");
      await admin.query('CREATE TRIGGER eb8a_block_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION eb8a_block_audit()');
      try {
        expect((await issue(f.owner, f.repo, 'start_day')).status).toBe(500);
        expect(await rows(f.owner.accountId)).toEqual([]);
        expect(woken).toEqual([]);
      } finally {
        await admin.query('DROP TRIGGER eb8a_block_audit ON audit_log');
        await admin.query('DROP FUNCTION eb8a_block_audit()');
      }
    });
  });

  describe('a halted repo', () => {
    it.each(KIND_ARGS_ENTRIES())('%s while halted: %s', async (kind, refused) => {
      const f = await fixture();
      await setHalted(f.owner.accountId, f.repo, true);
      const res = await issue(f.owner, f.repo, kind);
      if (refused) {
        expect(res.status).toBe(409);
        expect(await code(res)).toBe('halted');
        expect(await rows(f.owner.accountId)).toEqual([]);
        expect(await audits(f.owner.accountId)).toEqual([]);
        expect(woken).toEqual([]);
      } else {
        expect(res.status).toBe(201);
        expect(await rows(f.owner.accountId)).toHaveLength(1);
      }
      await setHalted(f.owner.accountId, f.repo, false);
      expect((await issue(f.owner, f.repo, kind)).status).toBe(201);
    });
  });

  describe('cancelling', () => {
    const cancel = (who: Identity | null, id: string, bearer?: string) => call(who, 'DELETE', `/engine/commands/${id}`, undefined, bearer);
    const make = async (f: Awaited<ReturnType<typeof fixture>>) => ((await (await issue(f.owner, f.repo, 'pause_loop')).json()) as { command_id: string }).command_id;

    it('an owner or admin cancels a pending command, with one audit row', async () => {
      const f = await fixture();
      const a = await make(f);
      const b = await make(f);
      const res = await cancel(f.admin, a);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ command_id: a, state: 'cancelled' });
      expect((await cancel(f.owner, b)).status).toBe(200);
      expect((await rows(f.owner.accountId)).map((r) => r.state)).toEqual(['cancelled', 'cancelled']);
      const log = await audits(f.owner.accountId, 'engine_command.cancelled');
      expect(log).toHaveLength(2);
      expect(log[0]).toMatchObject({ actor: f.admin.userId, payload: { repo_id: f.repo, command_id: a, kind: 'pause_loop' } });
    });

    it('a delivered command is 409 already_delivered and stays as it is; so is an applied one', async () => {
      const f = await fixture();
      for (const state of ['delivered', 'applied']) {
        const id = await make(f);
        await admin.query(
          `UPDATE engine_commands SET state = $2, delivered_at = now(), acked_at = ${state === 'applied' ? 'now()' : 'NULL'} WHERE id = $1`,
          [id, state],
        );
        const res = await cancel(f.owner, id);
        expect(res.status).toBe(409);
        expect(await code(res)).toBe('already_delivered');
        expect((await rows(f.owner.accountId)).find((r) => r.id === id)!.state).toBe(state);
      }
      expect(await audits(f.owner.accountId, 'engine_command.cancelled')).toEqual([]);
    });

    it('an expired command and an already cancelled one are 409 with their own reason', async () => {
      const f = await fixture();
      const old = await make(f);
      await admin.query("UPDATE engine_commands SET issued_at = now() - interval '700 seconds', expires_at = now() - interval '100 seconds' WHERE id = $1", [old]);
      expect(await code(await cancel(f.owner, old))).toBe('expired');
      const again = await make(f);
      await cancel(f.owner, again);
      expect(await code(await cancel(f.owner, again))).toBe('already_cancelled');
      expect(await audits(f.owner.accountId, 'engine_command.cancelled')).toHaveLength(1);
    });

    it('a member, a token, another account, an unknown id and a malformed id cannot', async () => {
      const f = await fixture();
      const other = await fixture();
      const id = await make(f);
      expect((await cancel(null, id)).status).toBe(401);
      expect((await cancel(f.member, id)).status).toBe(403);
      const token = generateToken();
      await insertApiToken(plain, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(token), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
      expect((await cancel(null, id, token)).status).toBe(403);
      expect((await cancel(other.owner, id)).status).toBe(404);
      expect((await cancel(f.owner, randomUUID())).status).toBe(404);
      expect((await cancel(f.owner, 'not-a-uuid')).status).toBe(404);
      expect((await rows(f.owner.accountId))[0].state).toBe('pending');
      expect(await audits(f.owner.accountId, 'engine_command.cancelled')).toEqual([]);
    });
  });

  describe('listing', () => {
    const list = (who: Identity | null, repo: string, query = '', bearer?: string) => call(who, 'GET', `${path(repo)}${query}`, undefined, bearer);

    it('shows the latest commands with their state, newest first; the note only to an owner or admin', async () => {
      const f = await fixture();
      await issue(f.owner, f.repo, 'pause_loop');
      await issue(f.owner, f.repo, 'answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'looks fine' });
      const asOwner = (await (await list(f.owner, f.repo)).json()) as { commands: Array<Record<string, unknown>> };
      expect(asOwner.commands.map((c) => c.kind)).toEqual(['answer_ask', 'pause_loop']);
      expect(asOwner.commands[0]).toMatchObject({ state: 'pending', note: 'looks fine', args: { ask_id: '0123456789abcdef', choice: 'approve' }, refusal: null, issued_by: f.owner.userId });
      expect(asOwner.commands[0]!.args).not.toHaveProperty('note');
      for (const who of [f.admin]) expect(JSON.stringify(await (await list(who, f.repo)).json())).toContain('looks fine');
      const asMember = await (await list(f.member, f.repo)).json();
      expect(JSON.stringify(asMember)).not.toContain('looks fine');
      expect(JSON.stringify(asMember)).not.toContain('"note"');
      const token = generateToken();
      await insertApiToken(plain, { accountId: f.owner.accountId, createdBy: f.member.userId, tokenHash: hashToken(token), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
      const viaToken = await list(null, f.repo, '', token);
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe('session_required');
    });

    it('reads time: a pending command past its life is expired, a delivered one never acked long past its life is not_confirmed', async () => {
      const f = await fixture();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(((await (await issue(f.owner, f.repo, 'pause_loop')).json()) as { command_id: string }).command_id);
      await admin.query("UPDATE engine_commands SET issued_at = now() - interval '700 seconds', expires_at = now() - interval '100 seconds' WHERE id = $1", [ids[0]]);
      await admin.query("UPDATE engine_commands SET state = 'delivered', delivered_at = now(), issued_at = now() - interval '2000 seconds', expires_at = now() - interval '1400 seconds' WHERE id = $1", [ids[1]]);
      const body = (await (await list(f.owner, f.repo)).json()) as { commands: Array<{ id: string; state: string }> };
      const by = Object.fromEntries(body.commands.map((c) => [c.id, c.state]));
      expect(by[ids[0]!]).toBe('expired');
      expect(by[ids[1]!]).toBe('not_confirmed');
      expect(by[ids[2]!]).toBe('pending');
      // Nothing was stored: the read is derived.
      expect((await rows(f.owner.accountId)).map((r) => r.state)).toEqual(['pending', 'delivered', 'pending']);
    });

    it('limit: at most 50, and 20 when asked for 20', async () => {
      const f = await fixture();
      for (let i = 0; i < 24; i++) {
        await admin.query(
          `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state) VALUES ($1, $2, $3, $4, 'pause_loop', '{}', $5, now(), now() + interval '600 seconds', 'expired')`,
          [f.owner.accountId, f.runner, f.repo, i + 1, f.owner.userId],
        );
      }
      expect(((await (await list(f.owner, f.repo)).json()) as { commands: unknown[] }).commands).toHaveLength(24);
      expect(((await (await list(f.owner, f.repo, '?limit=20')).json()) as { commands: unknown[] }).commands).toHaveLength(20);
      expect(((await (await list(f.owner, f.repo, '?limit=500')).json()) as { commands: unknown[] }).commands.length).toBeLessThanOrEqual(50);
    });

    it('another account sees nothing and gets 404 for the repo; a stranger without a login gets 401', async () => {
      const f = await fixture();
      const other = await fixture();
      await issue(f.owner, f.repo, 'pause_loop');
      expect((await list(other.owner, f.repo)).status).toBe(404);
      expect(((await (await list(other.owner, other.repo)).json()) as { commands: unknown[] }).commands).toEqual([]);
      expect((await list(null, f.repo)).status).toBe(401);
    });

    it('every field is an id, an enum, a number or a timestamp, apart from a note owners and admins see', async () => {
      const f = await fixture();
      await issue(f.owner, f.repo, 'request_spawn');
      await issue(f.owner, f.repo, 'set_dial');
      const body = (await (await list(f.member, f.repo)).json()) as { commands: Array<Record<string, unknown>> };
      const strings: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === 'string') strings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(body);
      const ok = /^([0-9a-f-]{36}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z|[a-z_.-]{1,40})$/;
      for (const s of strings) expect(s, s).toMatch(ok);
    });
  });
});

function KIND_ARGS_ENTRIES(): Array<[string, boolean]> {
  return Object.keys(KIND_ARGS).map((k) => [k, (START_LIKE as readonly string[]).includes(k)]);
}
