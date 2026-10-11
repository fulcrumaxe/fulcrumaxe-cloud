import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#31 API-6a-1 criteria 1 to 3: the run_action_requests table, its grants and the definers (0658). */
const WRITERS = [
  'run_action_claim(uuid, int)',
  'run_action_list_due(int, int)',
  'run_action_settle(uuid, text, jsonb, text, int)',
  'run_action_purge(interval, int)',
  'run_action_perform_principal(uuid)',
  'run_action_requeue_progress(uuid)',
];
const HASH = 'h'.repeat(64);

describe('run_action_requests (0658)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool, opsPool]) await p.end();
  });

  /** A committed row through the superuser (exempt from the write guard), for shape and state tests. */
  async function seedRow(over: Record<string, unknown> = {}, acct = a.accountId): Promise<string> {
    const row = { kind: 'cancel_run', target_id: randomUUID(), requested_by: `session:${a.userId}`, principal_kind: 'session', request_hash: HASH, ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query(
      `INSERT INTO run_action_requests (account_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [acct, ...Object.values(row)],
    );
    return rows[0].id;
  }
  const request = (r: SeedRefs, kind: string, target: string, key: string | null = null, hash = HASH, tokenId?: string) =>
    withTenant(appPool, r.accountId, r.userId, tokenId, async (c) => (await c.query('SELECT * FROM run_action_request($1, $2, $3, $4)', [kind, target, key, hash])).rows[0]);
  const rowCount = async (acct: string) => (await admin.query('SELECT count(*)::int n FROM run_action_requests WHERE account_id = $1', [acct])).rows[0].n;
  const auditCount = async (acct: string) => (await admin.query(`SELECT count(*)::int n FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested'`, [acct])).rows[0].n;
  async function mintToken(r: SeedRefs, scopes: string[], over = ''): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at ${over ? ', revoked_at' : ''})
       VALUES ($1, $2, $3, 'fxat_x', $4, now() + interval '1 day' ${over ? ', now()' : ''}) RETURNING id`,
      [r.accountId, r.userId, randomUUID(), scopes],
    );
    return rows[0].id;
  }
  const claim = (id: string, lease = 30) =>
    writerPool.query('SELECT id, state, attempts, claimed_until FROM run_action_claim($1, $2)', [id, lease]).then((r) => r.rows[0]);
  const settle = (id: string, state: string, code: string | null = null, retry = 0) =>
    writerPool.query('SELECT run_action_settle($1, $2, $3, $4, $5)', [id, state, null, code, retry]);
  const stateOf = async (id: string) => (await admin.query('SELECT state, attempts, finished_at FROM run_action_requests WHERE id = $1', [id])).rows[0];

  describe('criterion 1: the table', () => {
    it.each([
      ['done without finished_at', { state: 'done' }],
      ['accepted with finished_at', { finished_at: new Date() }],
      ['claimed without claimed_until', { state: 'claimed' }],
      ['accepted with claimed_until', { claimed_until: new Date() }],
      ['a malformed error_code', { error_code: 'Bad Code' }],
      ['an unknown kind', { kind: 'nuke' }],
    ])('rejects %s', async (_n, over) => {
      await expect(seedRow(over)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('the idempotency unique holds per (account, requester, key) and NULL keys never collide', async () => {
      await seedRow({ idempotency_key: 'k1' });
      await expect(seedRow({ idempotency_key: 'k1' })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await seedRow({ idempotency_key: 'k1', requested_by: 'session:someone-else' });
      await seedRow();
      await seedRow();
    });

    it('at most one live row per (account, kind, target); a terminal row frees the slot', async () => {
      const target = randomUUID();
      const first = await seedRow({ target_id: target });
      await expect(seedRow({ target_id: target })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await seedRow({ target_id: target, kind: 'cancel_work_item' });
      await admin.query(`UPDATE run_action_requests SET state = 'done', finished_at = now() WHERE id = $1`, [first]);
      await seedRow({ target_id: target });
    });
  });

  describe('criterion 2: grants, RLS and the platform_ops guard', () => {
    it('app_user sees only its tenant and cannot INSERT, UPDATE or DELETE (42501)', async () => {
      const mine = await seedRow();
      const theirs = await seedRow({}, b.accountId);
      const seen = await withTenant(appPool, a.accountId, (c) => c.query('SELECT id FROM run_action_requests'));
      const ids = seen.rows.map((r: { id: string }) => r.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
      for (const sql of [
        `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash) VALUES ('${a.accountId}', 'cancel_run', gen_random_uuid(), 'x', 'session', 'h')`,
        `UPDATE run_action_requests SET state = 'done'`,
        `DELETE FROM run_action_requests`,
      ]) {
        await expect(withTenant(appPool, a.accountId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('a direct platform_ops login cannot INSERT, and cannot see or change a row', async () => {
      const id = await seedRow();
      await expect(
        withTenant(opsPool, a.accountId, (c) =>
          c.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash) VALUES ($1, 'cancel_run', gen_random_uuid(), 'x', 'session', 'h')`, [a.accountId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const upd = await withTenant(opsPool, a.accountId, (c) => c.query(`UPDATE run_action_requests SET state = 'failed' WHERE id = $1`, [id]));
      expect(upd.rowCount).toBe(0);
      expect((await stateOf(id)).state).toBe('accepted');
    });

    it('the trigger alone refuses a platform_ops session even with RLS off', async () => {
      const id = await seedRow();
      await admin.query('BEGIN');
      try {
        await admin.query('ALTER TABLE run_action_requests DISABLE ROW LEVEL SECURITY');
        await admin.query('SET LOCAL SESSION AUTHORIZATION platform_ops');
        await expect(admin.query(`UPDATE run_action_requests SET state = 'failed' WHERE id = $1`, [id])).rejects.toThrow(/platform_ops may not write/);
      } finally {
        await admin.query('ROLLBACK');
      }
    });
  });

  describe('criterion 3: definer ACLs', () => {
    it('the writer functions (0682 adds the perform-principal definer): only agent_run_writer may EXECUTE; PUBLIC, owner and every other role may not', async () => {
      await admin.query('DROP ROLE IF EXISTS fx_ra_fresh');
      await admin.query('CREATE ROLE fx_ra_fresh');
      for (const fn of WRITERS) {
        const { rows } = await admin.query(
          `SELECT p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig,
                  (SELECT array_agg(CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END) FROM aclexplode(p.proacl) g)::text[] grantees,
                  ${['app_user', 'platform_ops', 'partner_user', 'fx_ra_fresh', 'agent_run_writer'].map((r) => `has_function_privilege('${r}', p.oid, 'EXECUTE') AS "${r}"`).join(', ')}
             FROM pg_proc p WHERE p.oid = '${fn}'::regprocedure`,
        );
        expect(rows[0]).toMatchObject({
          prosecdef: true, owner: 'platform_ops', proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['agent_run_writer'],
          app_user: false, platform_ops: false, partner_user: false, fx_ra_fresh: false, agent_run_writer: true,
        });
      }
      await admin.query('DROP ROLE fx_ra_fresh');
    });

    it('the request definer is executable by app_user only, and app_user cannot call a writer function', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) owner, has_function_privilege('app_user', p.oid, 'EXECUTE') a,
                has_function_privilege('agent_run_writer', p.oid, 'EXECUTE') w, has_function_privilege('partner_user', p.oid, 'EXECUTE') pu
           FROM pg_proc p WHERE p.oid = 'run_action_request(text, uuid, text, text)'::regprocedure`,
      );
      expect(rows[0]).toEqual({ owner: 'platform_ops', a: true, w: false, pu: false });
      await expect(withTenant(appPool, a.accountId, (c) => c.query('SELECT run_action_claim(gen_random_uuid(), 30)'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('a platform_ops session is refused by the function even if a grant slipped', async () => {
      await admin.query('GRANT EXECUTE ON FUNCTION run_action_claim(uuid, int) TO platform_ops');
      try {
        await expect(opsPool.query('SELECT run_action_claim(gen_random_uuid(), 30)')).rejects.toThrow(/refused for a platform_ops login/);
      } finally {
        await admin.query('REVOKE EXECUTE ON FUNCTION run_action_claim(uuid, int) FROM platform_ops');
      }
    });
  });

  describe('0682: run_action_perform_principal is refused to app_user and to a platform_ops login', () => {
    it('42501 for both, even with EXECUTE granted to platform_ops', async () => {
      await expect(withTenant(appPool, a.accountId, (c) => c.query('SELECT * FROM run_action_perform_principal(gen_random_uuid())'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query('GRANT EXECUTE ON FUNCTION run_action_perform_principal(uuid) TO platform_ops');
      try {
        await expect(opsPool.query('SELECT * FROM run_action_perform_principal(gen_random_uuid())')).rejects.toThrow(/refused for a platform_ops login/);
      } finally {
        await admin.query('REVOKE EXECUTE ON FUNCTION run_action_perform_principal(uuid) FROM platform_ops');
      }
    });
  });

  describe('0682: a terminal settle writes its events and audit row in the same transaction', () => {
    const OUTCOME = 'OUTCOME-SECRET';
    const keys = (o: object) => Object.keys(o).sort();
    const events = async (id: string, acct = a.accountId) =>
      (await admin.query('SELECT type, payload FROM domain_events WHERE account_id = $1 AND subject_id = $2 ORDER BY seq', [acct, id])).rows;
    const audits = async (id: string, acct = a.accountId) =>
      (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'run_action.settled' AND payload->>'action_id' = $2`, [acct, id])).rows;
    const settleWith = (id: string, state: string, code: string | null = null) =>
      writerPool.query('SELECT run_action_settle($1, $2, $3, $4, 0)', [id, state, JSON.stringify({ leak: OUTCOME }), code]);

    it('done: one settled event and one audit row (actor token:<id>), ids and enums only; a repeat writes nothing', async () => {
      const tok = await mintToken(a, ['runs:cancel']);
      const target = randomUUID();
      const id = await seedRow({ target_id: target, requested_by: `token:${tok}`, principal_kind: 'token', idempotency_key: 'idem-secret-key' });
      await claim(id);
      await settleWith(id, 'done');
      await settleWith(id, 'done');
      const ev = await events(id);
      expect(ev.map((e: { type: string }) => e.type)).toEqual(['run_action.settled']);
      expect(ev[0].payload).toEqual({ actionId: id, kind: 'cancel_run', targetId: target, state: 'done' });
      const au = await audits(id);
      expect(au).toHaveLength(1);
      expect(au[0].actor).toBe(`token:${tok}`);
      expect(keys(au[0].payload)).toEqual(['action_id', 'error_code', 'kind', 'state', 'target_id']);
      for (const text of [JSON.stringify(ev), JSON.stringify(au[0].payload)]) {
        for (const secret of [OUTCOME, tok, HASH, 'idem-secret-key', 'requested_by', 'outcome']) expect(text).not.toContain(secret);
      }
    });

    it('refused writes settled only; failed writes settled and failed (with the error code)', async () => {
      const refused = await seedRow();
      await claim(refused);
      await settleWith(refused, 'refused', 'principal_not_authorised');
      expect((await events(refused)).map((e: { type: string }) => e.type)).toEqual(['run_action.settled']);
      const failed = await seedRow();
      await claim(failed);
      await settleWith(failed, 'failed', 'boom');
      const ev = await events(failed);
      expect(ev.map((e: { type: string }) => e.type)).toEqual(['run_action.settled', 'run_action.failed']);
      expect(ev[0].payload.state).toBe('failed');
      expect(ev[1].payload).toEqual({ actionId: failed, kind: 'cancel_run', targetId: expect.any(String), errorCode: 'boom' });
      expect(keys(ev[1].payload)).toEqual(['actionId', 'errorCode', 'kind', 'targetId']);
    });

    it('accepted re-queues write nothing; the fifth attempt flips to failed and writes settled and failed', async () => {
      const id = await seedRow();
      for (let i = 1; i <= 4; i++) {
        await claim(id);
        await settle(id, 'accepted', 'boom');
        expect(await events(id)).toEqual([]);
        expect(await audits(id)).toEqual([]);
      }
      await claim(id);
      await settle(id, 'accepted', 'boom');
      const ev = await events(id);
      expect(ev.map((e: { type: string; payload: { state?: string } }) => [e.type, e.payload.state])).toEqual([['run_action.settled', 'failed'], ['run_action.failed', undefined]]);
      expect(ev[1].payload.errorCode).toBe('boom');
      expect((await audits(id))[0].payload.state).toBe('failed');
    });

    it.each([
      ['domain_events', `NEW.type LIKE 'run_action.%'`],
      ['audit_log', `NEW.action = 'run_action.settled'`],
    ])('if the %s insert fails the settle fails and the row is still claimed', async (table, when) => {
      const c = await seedAccount(admin, randomUUID());
      const id = await seedRow({}, c.accountId);
      await claim(id);
      await admin.query(`CREATE FUNCTION fx_ra_inject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
      await admin.query(`CREATE TRIGGER fx_ra_inject BEFORE INSERT ON ${table} FOR EACH ROW WHEN (NEW.account_id = '${c.accountId}' AND ${when}) EXECUTE FUNCTION fx_ra_inject()`);
      try {
        await expect(settleWith(id, 'done')).rejects.toThrow(/injected failure/);
        expect((await stateOf(id)).state).toBe('claimed');
      } finally {
        await admin.query(`DROP TRIGGER fx_ra_inject ON ${table}`);
        await admin.query('DROP FUNCTION fx_ra_inject()');
      }
      await settleWith(id, 'done');
      expect((await stateOf(id)).state).toBe('done');
    });
  });

  describe('criterion 3: run_action_request', () => {
    it('a session request inserts one row and one audit row; a replay writes nothing', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const first = await request(acct, 'cancel_run', acct.runId, 'key-1');
      expect(first).toMatchObject({ state: 'accepted', replayed: false });
      const again = await request(acct, 'cancel_run', acct.runId, 'key-1');
      expect(again).toMatchObject({ action_id: first.action_id, replayed: true });
      expect(await rowCount(acct.accountId)).toBe(1);
      const { rows } = await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested'`, [acct.accountId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe(`session:${acct.userId}`);
      expect(rows[0].payload).toEqual({ action_id: first.action_id, kind: 'cancel_run', target_id: acct.runId, principal_kind: 'session' });
    });

    it('the same key with another hash is 22023; a second live request for the target returns the live id from anyone', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const first = await request(acct, 'cancel_work_item', acct.workItemId, 'k');
      await expect(request(acct, 'cancel_work_item', acct.workItemId, 'k', 'other')).rejects.toMatchObject({ code: '22023' });
      const tok = await mintToken(acct, ['runs:cancel']);
      expect(await request(acct, 'cancel_work_item', acct.workItemId, null, HASH, tok)).toMatchObject({ action_id: first.action_id, replayed: true });
      expect(await request(acct, 'cancel_work_item', acct.workItemId)).toMatchObject({ action_id: first.action_id, replayed: true });
      expect(await rowCount(acct.accountId)).toBe(1);
      expect(await auditCount(acct.accountId)).toBe(1);
    });

    it('a token needs runs:cancel and a cancel kind, is audited as token:<id>, and must be live', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const good = await mintToken(acct, ['runs:cancel']);
      const readOnly = await mintToken(acct, ['read']);
      const revoked = await mintToken(acct, ['runs:cancel'], 'revoked');
      await expect(request(acct, 'cancel_run', acct.runId, null, HASH, readOnly)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(request(acct, 'cancel_run', acct.runId, null, HASH, revoked)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(request(acct, 'retry_run', acct.runId, null, HASH, good)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(request(acct, 'cancel_run', acct.runId, null, HASH, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount(acct.accountId)).toBe(0);
      await request(acct, 'cancel_run', acct.runId, null, HASH, good);
      const { rows } = await admin.query('SELECT requested_by, principal_kind FROM run_action_requests WHERE account_id = $1', [acct.accountId]);
      expect(rows).toEqual([{ requested_by: `token:${good}`, principal_kind: 'token' }]);
      expect((await admin.query(`SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested'`, [acct.accountId])).rows[0].actor).toBe(`token:${good}`);
    });

    it('a non-member session, a closed account and an unknown kind are refused', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const stranger = withTenant(appPool, acct.accountId, randomUUID(), async (c) => c.query('SELECT * FROM run_action_request($1, $2, NULL, $3)', ['cancel_run', acct.runId, HASH]));
      await expect(stranger).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(request(acct, 'nuke', acct.runId)).rejects.toMatchObject({ code: '22023' });
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [acct.accountId]);
      await expect(request(acct, 'cancel_run', acct.runId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('missing, other-account and random targets raise the same P0002 message; a work item is not a run', async () => {
      const messages = new Set<string>();
      for (const [kind, target] of [['cancel_run', randomUUID()], ['cancel_run', b.runId], ['cancel_work_item', b.workItemId], ['cancel_run', a.workItemId]] as const) {
        const err = await request(a, kind, target).catch((e) => e);
        expect(err.code).toBe('P0002');
        messages.add(err.message);
      }
      expect(messages.size).toBe(1);
    });

    it('a failing audit insert leaves no request row behind', async () => {
      const acct = await seedAccount(admin, randomUUID());
      await admin.query(`CREATE FUNCTION fx_ra_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`);
      await admin.query(`CREATE TRIGGER fx_ra_fail BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'run_action.requested') EXECUTE FUNCTION fx_ra_fail()`);
      try {
        await expect(request(acct, 'cancel_run', acct.runId)).rejects.toThrow(/audit down/);
        expect(await rowCount(acct.accountId)).toBe(0);
      } finally {
        await admin.query('DROP TRIGGER fx_ra_fail ON audit_log; DROP FUNCTION fx_ra_fail()');
      }
    });
  });

  describe('criterion 3: the lease state machine', () => {
    it('claim moves accepted to claimed once; a backoff row and a settled row return NULL; done twice is a no-op', async () => {
      const id = await seedRow();
      expect(await claim(id)).toMatchObject({ state: 'claimed', attempts: 1 });
      expect(await claim(id)).toMatchObject({ id: null });
      await settle(id, 'done');
      const done = await stateOf(id);
      await settle(id, 'done');
      expect(await stateOf(id)).toEqual(done);
      expect(await claim(id)).toMatchObject({ id: null });
      await expect(settle(id, 'failed')).rejects.toMatchObject({ code: '55000' });
      const later = await seedRow({ not_before: new Date(Date.now() + 60_000) });
      expect(await claim(later)).toMatchObject({ id: null });
    });

    it('retry sets not_before and clears the lease; the fifth failed attempt ends in failed', async () => {
      const id = await seedRow();
      for (let i = 1; i <= 4; i++) {
        expect(await claim(id)).toMatchObject({ attempts: i });
        await settle(id, 'accepted', 'boom', 0);
        expect((await stateOf(id)).state).toBe('accepted');
      }
      await claim(id);
      await settle(id, 'accepted', 'boom', 0);
      expect(await stateOf(id)).toMatchObject({ state: 'failed', attempts: 5 });
      const backoff = await seedRow();
      await claim(backoff);
      await settle(backoff, 'accepted', null, 600);
      const { rows } = await admin.query('SELECT not_before > now() AS later, claimed_until FROM run_action_requests WHERE id = $1', [backoff]);
      expect(rows[0]).toEqual({ later: true, claimed_until: null });
    });

    it('list_due lists old accepted rows and expired leases, never a fresh, leased or finished one, and writes nothing', async () => {
      const old = await seedRow();
      await admin.query(`UPDATE run_action_requests SET created_at = now() - interval '5 minutes' WHERE id = $1`, [old]);
      const expired = await seedRow({ state: 'claimed', claimed_until: new Date(Date.now() - 1000), attempts: 1 });
      const leased = await seedRow({ state: 'claimed', claimed_until: new Date(Date.now() + 60_000) });
      const fresh = await seedRow();
      const delayed = await seedRow({ not_before: new Date(Date.now() + 600_000) });
      const finished = [];
      for (const state of ['done', 'refused', 'failed']) finished.push(await seedRow({ state, finished_at: new Date() }));
      await admin.query(`UPDATE run_action_requests SET created_at = now() - interval '5 minutes' WHERE id = ANY($1)`, [[delayed, ...finished]]);
      const ids = [old, expired, leased, fresh, delayed, ...finished];
      const snapshot = async () => (await admin.query('SELECT * FROM run_action_requests WHERE id = ANY($1) ORDER BY id', [ids])).rows;
      const before = await snapshot();
      const { rows } = await writerPool.query('SELECT run_action_list_due($1, $2) AS id', [60, 1000]);
      const got = rows.map((r: { id: string }) => r.id);
      expect(got).toEqual(expect.arrayContaining([old, expired]));
      for (const not of [leased, fresh, delayed, ...finished]) expect(got).not.toContain(not);
      expect(await snapshot()).toEqual(before);
    });

    it('list_due refuses a bad age or limit', async () => {
      for (const args of [[-1, 10], [0, 0], [0, 1001]]) {
        await expect(writerPool.query('SELECT run_action_list_due($1, $2)', args)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
    });

    it('two concurrent claims of one row give exactly one winner (50 iterations)', async () => {
      for (let i = 0; i < 50; i++) {
        const id = await seedRow();
        const won = await Promise.all([claim(id), claim(id)]);
        expect(won.filter((r) => r.id !== null)).toHaveLength(1);
      }
    });

    it('purge deletes only terminal rows older than the cut-off, at most the limit', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const oldDone = await seedRow({ state: 'done', finished_at: new Date(Date.now() - 100 * 86400_000) }, acct.accountId);
      const oldFailed = await seedRow({ state: 'failed', finished_at: new Date(Date.now() - 100 * 86400_000) }, acct.accountId);
      const recent = await seedRow({ state: 'done', finished_at: new Date() }, acct.accountId);
      const live = await seedRow({}, acct.accountId);
      await admin.query(`UPDATE run_action_requests SET created_at = now() - interval '200 days' WHERE id = $1`, [live]);
      const stuck = await seedRow({ state: 'claimed', claimed_until: new Date(Date.now() - 1000) }, acct.accountId);
      const purge = (limit: number) => writerPool.query(`SELECT run_action_purge(interval '90 days', $1) AS n`, [limit]).then((r) => r.rows[0].n);
      expect(await purge(1)).toBe(1);
      expect(await purge(1000)).toBeGreaterThanOrEqual(1);
      const left = (await admin.query('SELECT id FROM run_action_requests WHERE account_id = $1', [acct.accountId])).rows.map((r: { id: string }) => r.id);
      expect(left.sort()).toEqual([recent, live, stuck].sort());
      expect(left).not.toContain(oldDone);
      expect(left).not.toContain(oldFailed);
    });
  });

  describe('0685: a start_preview target is an onboarding_previews row of the account', () => {
    async function seedPreview(r: SeedRefs, state = 'requested'): Promise<string> {
      const inst = randomUUID();
      const repo = randomUUID();
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team_readonly')`, [inst, r.accountId]);
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 1, 'team')`, [repo, r.accountId, inst]);
      const cols = state === 'void' ? ', void_reason' : state === 'requested' ? '' : ', run_id, started_at';
      const vals = state === 'void' ? ", 'x'" : state === 'requested' ? '' : ', gen_random_uuid(), now()';
      const { rows } = await admin.query(
        `INSERT INTO onboarding_previews (account_id, installation_id, repo_id, gh_user_id, gh_installation_id, gh_owner, run_action_id, state${cols})
         VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, floor(random() * 2000000000)::bigint + 1, gen_random_uuid()::text, gen_random_uuid(), '${state}'${vals}) RETURNING id`,
        [r.accountId, inst, repo],
      );
      return rows[0].id;
    }

    it('a requested preview of the account is accepted; a second request for it returns the live action', async () => {
      const id = await seedPreview(a);
      const first = await request(a, 'start_preview', id, 'sp-1');
      expect(first).toMatchObject({ state: 'accepted', replayed: false });
      expect(await request(a, 'start_preview', id, 'sp-2')).toMatchObject({ action_id: first.action_id, replayed: true });
    });

    it("another account's preview, a started or void one, a work item and a random id all raise P0002 with one message", async () => {
      const messages = new Set<string>();
      const targets = [await seedPreview(b), await seedPreview(a, 'running'), await seedPreview(a, 'void'), a.workItemId, randomUUID()];
      for (const target of targets) {
        const err = await request(a, 'start_preview', target).catch((e) => e);
        expect(err.code).toBe('P0002');
        messages.add(err.message);
      }
      expect(messages.size).toBe(1);
    });

    it('a preview id is not a work item for the work-item kinds', async () => {
      const id = await seedPreview(a);
      await expect(request(a, 'cancel_work_item', id)).rejects.toMatchObject({ code: 'P0002' });
      await expect(request(a, 'continue_work_item', id)).rejects.toMatchObject({ code: 'P0002' });
    });

    it('a token is still refused a start_preview even with runs:cancel', async () => {
      const tok = await mintToken(a, ['runs:cancel']);
      await expect(request(a, 'start_preview', await seedPreview(a), null, HASH, tok)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('0769: respec_work_item (D#6 R4d-5b)', () => {
    it('the CHECK accepts the new kind and still refuses an unknown one', async () => {
      await expect(seedRow({ kind: 'respec_work_item' })).resolves.toEqual(expect.any(String));
      await expect(seedRow({ kind: 'respec_work_items' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('an owner session requests it for a work item of the account: accepted, audited, a second request returns the live action', async () => {
      const before = await auditCount(a.accountId);
      const first = await request(a, 'respec_work_item', a.workItemId, 'rs-1');
      expect(first).toMatchObject({ state: 'accepted', replayed: false });
      expect(await auditCount(a.accountId)).toBe(before + 1);
      const { rows } = await admin.query('SELECT kind, target_id, principal_kind FROM run_action_requests WHERE id = $1', [first.action_id]);
      expect(rows[0]).toEqual({ kind: 'respec_work_item', target_id: a.workItemId, principal_kind: 'session' });
      expect(await request(a, 'respec_work_item', a.workItemId, 'rs-2')).toMatchObject({ action_id: first.action_id, replayed: true });
    });

    it("another account's work item, a random id and a run id all raise P0002; a token is refused whatever its scope; a plain member is refused and an admin accepted", async () => {
      for (const target of [b.workItemId, randomUUID(), a.runId]) await expect(request(a, 'respec_work_item', target)).rejects.toMatchObject({ code: 'P0002' });
      const tok = await mintToken(a, ['runs:cancel', 'read']);
      await expect(request(a, 'respec_work_item', a.workItemId, null, HASH, tok)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const m = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [m.accountId, m.userId]);
      await expect(request(m, 'respec_work_item', m.workItemId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query("UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2", [m.accountId, m.userId]);
      await expect(request(m, 'respec_work_item', m.workItemId)).resolves.toMatchObject({ state: 'accepted' });
    });
  });

  describe('0791: amend_spec_work_item (D#597 CC-2b)', () => {
    it('the CHECK accepts the new kind and still refuses an unknown one', async () => {
      await expect(seedRow({ kind: 'amend_spec_work_item' })).resolves.toEqual(expect.any(String));
      await expect(seedRow({ kind: 'amend_spec_work_items' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('an owner session requests it for a work item of the account: accepted, audited, a second request returns the live action', async () => {
      const before = await auditCount(a.accountId);
      const first = await request(a, 'amend_spec_work_item', a.workItemId, 'as-1');
      expect(first).toMatchObject({ state: 'accepted', replayed: false });
      expect(await auditCount(a.accountId)).toBe(before + 1);
      const { rows } = await admin.query('SELECT kind, target_id, principal_kind FROM run_action_requests WHERE id = $1', [first.action_id]);
      expect(rows[0]).toEqual({ kind: 'amend_spec_work_item', target_id: a.workItemId, principal_kind: 'session' });
      expect(await request(a, 'amend_spec_work_item', a.workItemId, 'as-2')).toMatchObject({ action_id: first.action_id, replayed: true });
    });

    it("another account's work item, a random id and a run id all raise P0002; a token is refused whatever its scope; a plain member is refused and an admin accepted", async () => {
      for (const target of [b.workItemId, randomUUID(), a.runId]) await expect(request(a, 'amend_spec_work_item', target)).rejects.toMatchObject({ code: 'P0002' });
      const tok = await mintToken(a, ['runs:cancel', 'read']);
      await expect(request(a, 'amend_spec_work_item', a.workItemId, null, HASH, tok)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const m = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [m.accountId, m.userId]);
      await expect(request(m, 'amend_spec_work_item', m.workItemId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query("UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2", [m.accountId, m.userId]);
      await expect(request(m, 'amend_spec_work_item', m.workItemId)).resolves.toMatchObject({ state: 'accepted' });
    });
  });

  describe('0708: advance_work_item', () => {
    it('the CHECK accepts the new kind and still refuses an unknown one', async () => {
      await expect(seedRow({ kind: 'advance_work_item' })).resolves.toEqual(expect.any(String));
      await expect(seedRow({ kind: 'advance_work_items' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('an owner session requests it for a work item of the account: accepted, audited, and a second request returns the live action', async () => {
      const before = await auditCount(a.accountId);
      const first = await request(a, 'advance_work_item', a.workItemId, 'adv-1');
      expect(first).toMatchObject({ state: 'accepted', replayed: false });
      expect(await auditCount(a.accountId)).toBe(before + 1);
      const { rows } = await admin.query('SELECT kind, target_id, principal_kind FROM run_action_requests WHERE id = $1', [first.action_id]);
      expect(rows[0]).toEqual({ kind: 'advance_work_item', target_id: a.workItemId, principal_kind: 'session' });
      expect(await request(a, 'advance_work_item', a.workItemId, 'adv-2')).toMatchObject({ action_id: first.action_id, replayed: true });
      expect(await request(a, 'advance_work_item', a.workItemId, 'adv-1')).toMatchObject({ action_id: first.action_id, replayed: true });
      expect(await auditCount(a.accountId)).toBe(before + 1);
    });

    it("another account's work item, a random id and a run id all raise P0002", async () => {
      for (const target of [b.workItemId, randomUUID(), a.runId]) {
        await expect(request(a, 'advance_work_item', target)).rejects.toMatchObject({ code: 'P0002' });
      }
    });

    it('a token is refused it whatever its scope', async () => {
      const tok = await mintToken(a, ['runs:cancel', 'read']);
      await expect(request(a, 'advance_work_item', a.workItemId, null, HASH, tok)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('a plain member session is refused it; an admin is accepted', async () => {
      const m = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [m.accountId, m.userId]);
      await expect(request(m, 'advance_work_item', m.workItemId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query("UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2", [m.accountId, m.userId]);
      await expect(request(m, 'advance_work_item', m.workItemId)).resolves.toMatchObject({ state: 'accepted' });
    });

    it('the other kinds are unchanged: continue_work_item still takes a work item, and the ACL is the same', async () => {
      await expect(request(a, 'continue_work_item', a.workItemId)).resolves.toMatchObject({ state: 'accepted' });
      const { rows } = await admin.query(
        `SELECT has_function_privilege('app_user', 'run_action_request(text, uuid, text, text)', 'EXECUTE') AS app,
                has_function_privilege('public', 'run_action_request(text, uuid, text, text)', 'EXECUTE') AS pub,
                pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p WHERE p.proname = 'run_action_request'`,
      );
      expect(rows).toEqual([{ app: true, pub: false, owner: 'platform_ops' }]);
    });
  });

  describe('0686: run_action_requeue_progress', () => {
    const requeue = (id: string) => writerPool.query('SELECT run_action_requeue_progress($1) AS r', [id]).then((r) => r.rows[0].r as string);
    const rowOf = async (id: string) => (await admin.query('SELECT * FROM run_action_requests WHERE id = $1', [id])).rows[0];
    const future = () => new Date(Date.now() + 60_000);
    const writes = async (acct: string) => ({
      events: (await admin.query('SELECT count(*)::int n FROM domain_events WHERE account_id = $1', [acct])).rows[0].n,
      audits: (await admin.query('SELECT count(*)::int n FROM audit_log WHERE account_id = $1', [acct])).rows[0].n,
    });

    it('P6: a live cancel_work_item claim goes back to accepted, due now, with its attempt given back; no event and no audit row', async () => {
      const c = await seedAccount(admin, randomUUID());
      const id = await seedRow({ kind: 'cancel_work_item' }, c.accountId);
      expect(await claim(id)).toMatchObject({ attempts: 1 });
      const before = await writes(c.accountId);
      expect(await requeue(id)).toBe('requeued');
      expect(await writes(c.accountId)).toEqual(before);
      const row = await rowOf(id);
      expect(row).toMatchObject({ state: 'accepted', attempts: 0, progress_pages: 1, claimed_until: null, finished_at: null });
      expect(row.not_before.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await claim(id)).toMatchObject({ attempts: 1 }); // claimable again at once
    });

    it('the attempt given back never goes below 0', async () => {
      const id = await seedRow({ kind: 'cancel_work_item', state: 'claimed', claimed_until: future(), attempts: 0 });
      expect(await requeue(id)).toBe('requeued');
      expect(await rowOf(id)).toMatchObject({ attempts: 0, progress_pages: 1 });
    });

    it.each([
      ['an accepted row', { kind: 'cancel_work_item' }],
      ['an expired lease', { kind: 'cancel_work_item', state: 'claimed', claimed_until: new Date(Date.now() - 1000), attempts: 1 }],
      ['a done row', { kind: 'cancel_work_item', state: 'done', finished_at: new Date() }],
      ['a refused row', { kind: 'cancel_work_item', state: 'refused', finished_at: new Date() }],
      ['a failed row', { kind: 'cancel_work_item', state: 'failed', finished_at: new Date() }],
      ['a cancel_run row with a live lease', { kind: 'cancel_run', state: 'claimed', claimed_until: future(), attempts: 1 }],
    ])('P4: %s is refused with 55000 and nothing is written', async (_n, over) => {
      const c = await seedAccount(admin, randomUUID());
      const id = await seedRow(over, c.accountId);
      const [rowBefore, writesBefore] = [await rowOf(id), await writes(c.accountId)];
      await expect(requeue(id)).rejects.toMatchObject({ code: '55000' });
      expect(await rowOf(id)).toEqual(rowBefore);
      expect(await writes(c.accountId)).toEqual(writesBefore);
    });

    it('an unknown id is P0002', async () => {
      await expect(requeue(randomUUID())).rejects.toMatchObject({ code: 'P0002' });
    });

    it('P3: the cap is 100 pages: the 100th re-queues, the 101st changes nothing and says cap_reached', async () => {
      const id = await seedRow({ kind: 'cancel_work_item', state: 'claimed', claimed_until: future(), attempts: 1, progress_pages: 99 });
      expect(await requeue(id)).toBe('requeued');
      expect(await rowOf(id)).toMatchObject({ state: 'accepted', progress_pages: 100 });
      await claim(id);
      const before = await rowOf(id);
      expect(await requeue(id)).toBe('cap_reached');
      expect(await rowOf(id)).toEqual(before);
    });

    it('progress_pages cannot go negative', async () => {
      await expect(seedRow({ progress_pages: -1 })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('P5: a real call is refused for app_user (42501), a fresh role, partner_user and a platform_ops login; the column is not writable by app_user', async () => {
      const id = await seedRow({ kind: 'cancel_work_item', state: 'claimed', claimed_until: future(), attempts: 1 });
      await expect(withTenant(appPool, a.accountId, (c) => c.query('SELECT run_action_requeue_progress($1)', [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query('DROP ROLE IF EXISTS fx_ra_fresh2');
      await admin.query('CREATE ROLE fx_ra_fresh2');
      try {
        for (const role of ['fx_ra_fresh2', 'partner_user']) {
          await admin.query(`SET ROLE ${role}`);
          try {
            await expect(admin.query('SELECT run_action_requeue_progress($1)', [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
          } finally {
            await admin.query('RESET ROLE');
          }
        }
      } finally {
        await admin.query('DROP ROLE fx_ra_fresh2');
      }
      await admin.query('GRANT EXECUTE ON FUNCTION run_action_requeue_progress(uuid) TO platform_ops');
      try {
        await expect(opsPool.query('SELECT run_action_requeue_progress($1)', [id])).rejects.toThrow(/refused for a platform_ops login/);
      } finally {
        await admin.query('REVOKE EXECUTE ON FUNCTION run_action_requeue_progress(uuid) FROM platform_ops');
      }
      await expect(withTenant(appPool, a.accountId, (c) => c.query('UPDATE run_action_requests SET progress_pages = 5 WHERE id = $1', [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowOf(id)).toMatchObject({ state: 'claimed', progress_pages: 0 });
    });
  });
});
