import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { reconcileResumeRequests } from '../src/decisionAsks.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP11c (DP-C9 section 5, criteria 1, 6 and 7), migration 0860: the `resume_decision` run action. The request definer takes an ASK of this
 * tenant in state 'answered' for a session owner or admin and nobody else; one resume per ask across principals; the system reconcile is executable by the
 * receipt invoker only and makes system requests for answered or proceeded asks that have none; the perform-side principal allows 'system' for this kind only.
 * "As the invoker" is a LOGIN that is a member of app_user and receipt_writer_invoker (the stand-in for the production receipt login).
 */
const INVOKER_LOGIN = 'fx_resume_invoker_test';
const OPTIONS = [{ id: 'apply', label: 'Apply the change' }, { id: 'skip', label: 'Skip it' }];
const TYPE = 'test_strategy_choice';

describe('resume_decision (0860)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let writerPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let memberUser: string;
  let adminUser: string;

  async function addUser(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  async function seedItem(t: SeedRefs): Promise<{ itemId: string; runId: string }> {
    const itemId = randomUUID();
    const runId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress')`, [itemId, t.accountId, t.repoId]);
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'succeeded')`, [runId, t.accountId, itemId]);
    return { itemId, runId };
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER ?? process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
    memberUser = await addUser(refs.accountId, 'member');
    adminUser = await addUser(refs.accountId, 'admin');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), invokerPool.end(), writerPool.end()]);
  });

  /** A raised ask on a fresh item with a run, optionally already moved to a state. */
  async function ask(t: SeedRefs = refs, state: 'open' | 'answered' | 'proceeded' | 'withdrawn' | 'overdue' = 'answered', o: { age?: string; noRun?: boolean } = {}): Promise<{ id: string; itemId: string; runId: string }> {
    const { itemId, runId } = await seedItem(t);
    const id = (await withTenant(invokerPool, t.accountId, async (c) =>
      (await c.query<{ id: string }>(
        `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, $3::uuid, $4::jsonb, 'apply', 'because', '["trusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`,
        [TYPE, itemId, o.noRun ? null : runId, JSON.stringify(OPTIONS)])).rows[0]!.id));
    if (state === 'answered') {
      await admin.query(`UPDATE decision_asks SET state = 'answered', answered_option = 'skip', answered_by = $2, answered_at = now() - $3::interval WHERE id = $1`, [id, t.userId, o.age ?? '0 seconds']);
    } else if (state === 'proceeded') {
      await admin.query(`UPDATE decision_asks SET state = 'proceeded', answered_option = proposed, answered_at = now() - $2::interval WHERE id = $1`, [id, o.age ?? '0 seconds']);
    } else if (state !== 'open') {
      await admin.query(`UPDATE decision_asks SET state = $2 WHERE id = $1`, [id, state]);
    }
    return { id, itemId, runId };
  }
  /** Calls run_action_request as `user` of `t` (optionally with a token set), on the invoker login. */
  async function request(askId: string, as: { t?: SeedRefs; user?: string; token?: string; key?: string | null; hash?: string; pool?: Pool } = {}) {
    const t = as.t ?? refs;
    const user = as.user ?? t.userId;
    const run = async (c: PoolClient) =>
      (await c.query<{ action_id: string; state: string; replayed: boolean }>('SELECT * FROM run_action_request($1, $2, $3, $4)', ['resume_decision', askId, as.key === undefined ? `ask:${askId}` : as.key, as.hash ?? `resume:${askId}`])).rows[0]!;
    const pool = as.pool ?? invokerPool;
    return as.token ? withTenant(pool, t.accountId, user, as.token, run) : withTenant(pool, t.accountId, user, run);
  }
  const requestsFor = async (askId: string) => (await admin.query(`SELECT * FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1`, [askId])).rows;

  describe('the table', () => {
    it('accepts the new kind and the system principal, ties system to the literal requester and to this kind, and requires an epoch exactly for this kind', async () => {
      const a = await ask();
      const base = (cols: string, vals: unknown[]) => admin.query(`INSERT INTO run_action_requests (account_id, target_id, request_hash, ${cols}) VALUES ($1, $2, 'h', ${vals.map((_, i) => `$${i + 3}`).join(', ')})`, [refs.accountId, a.id, ...vals]);
      await expect(base('kind, requested_by, principal_kind, resume_halt_epoch', ['resume_decision', 'system', 'system', 0])).resolves.toBeDefined();
      const b = await ask();
      const other2 = (cols: string, vals: unknown[]) => admin.query(`INSERT INTO run_action_requests (account_id, target_id, request_hash, ${cols}) VALUES ($1, $2, 'h', ${vals.map((_, i) => `$${i + 3}`).join(', ')})`, [refs.accountId, b.id, ...vals]);
      // system with another kind, system with a person's requester, a person's principal with the literal, a resume without an epoch, an epoch on another kind
      await expect(other2('kind, requested_by, principal_kind', ['cancel_work_item', 'system', 'system'])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(other2('kind, requested_by, principal_kind, resume_halt_epoch', ['resume_decision', `session:${refs.userId}`, 'system', 0])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(other2('kind, requested_by, principal_kind, resume_halt_epoch', ['resume_decision', 'system', 'session', 0])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(other2('kind, requested_by, principal_kind', ['resume_decision', `session:${refs.userId}`, 'session'])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(other2('kind, requested_by, principal_kind, resume_halt_epoch', ['cancel_work_item', `session:${refs.userId}`, 'session', 0])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('allows one resume request per ask whatever its state or requester (the unique index), and none for the next ask', async () => {
      const a = await ask();
      await admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, resume_halt_epoch, state, finished_at) VALUES ($1, 'resume_decision', $2, 'system', 'system', 'h', 0, 'done', now())`, [refs.accountId, a.id]);
      await expect(admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, resume_halt_epoch) VALUES ($1, 'resume_decision', $2, $3, 'session', 'h', 0)`, [refs.accountId, a.id, `session:${refs.userId}`])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });
  });

  describe('run_action_request for resume_decision', () => {
    it('a session owner or admin makes one for an answered ask of their tenant, with the item\'s halt epoch and an audit row; a repeat is the same action', async () => {
      const a = await ask();
      await admin.query(`UPDATE work_items SET halt_epoch = 3 WHERE id = $1`, [a.itemId]);
      const first = await request(a.id);
      expect(first).toMatchObject({ state: 'accepted', replayed: false });
      expect(await request(a.id)).toMatchObject({ action_id: first.action_id, replayed: true });
      // another requester, another key: still the one resume
      expect(await request(a.id, { user: adminUser, key: 'another' })).toMatchObject({ action_id: first.action_id, replayed: true });
      const rows = await requestsFor(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requested_by: `session:${refs.userId}`, principal_kind: 'session', resume_halt_epoch: 3, state: 'accepted' });
      const audit = await admin.query(`SELECT actor, payload FROM audit_log WHERE action = 'run_action.requested' AND payload->>'action_id' = $1`, [first.action_id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].payload).toMatchObject({ kind: 'resume_decision', target_id: a.id, principal_kind: 'session' });
    });

    it('a repeat after the first request finished is still the first request (no second resume)', async () => {
      const a = await ask();
      const first = await request(a.id);
      await admin.query(`UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '1 minute' WHERE id = $1`, [first.action_id]);
      await admin.query(`UPDATE run_action_requests SET state = 'done', claimed_until = NULL, finished_at = now() WHERE id = $1`, [first.action_id]);
      expect(await request(a.id, { user: adminUser, key: 'later' })).toMatchObject({ action_id: first.action_id, state: 'done', replayed: true });
    });

    it('a token never makes one (not an unknown one, and not a live one with the cancel scope), and neither does a member who is not owner or admin', async () => {
      const a = await ask();
      await expect(request(a.id, { token: randomUUID() })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const live = (await admin.query<{ id: string }>(`INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', $4, now() + interval '1 day') RETURNING id`, [refs.accountId, refs.userId, randomUUID(), ['runs:cancel']])).rows[0]!.id;
      await expect(request(a.id, { token: live })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(request(a.id, { user: memberUser })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await requestsFor(a.id)).toEqual([]);
    });

    it('the target must be an answered ask of this tenant: an open, overdue, proceeded or withdrawn ask, another tenant\'s ask, a work item id and an unknown id are all not found', async () => {
      const wrong = [await ask(refs, 'open'), await ask(refs, 'overdue'), await ask(refs, 'proceeded'), await ask(refs, 'withdrawn'), await ask(other, 'answered')];
      for (const w of wrong) await expect(request(w.id)).rejects.toMatchObject({ code: 'P0002' });
      await expect(request(wrong[0]!.itemId)).rejects.toMatchObject({ code: 'P0002' });
      await expect(request(randomUUID())).rejects.toMatchObject({ code: 'P0002' });
      for (const w of wrong) expect(await requestsFor(w.id)).toEqual([]);
    });

    it('a reused key with another hash is refused, and plain app_user (no invoker role) may call it too (the answer runs on the invoker login)', async () => {
      const a = await ask();
      await request(a.id, { key: 'k1' });
      await expect(request(a.id, { key: 'k1', hash: 'different' })).rejects.toMatchObject({ code: '22023' });
      const b = await ask();
      await expect(request(b.id, { pool: appUserPool })).resolves.toMatchObject({ state: 'accepted' });
    });
  });

  describe('resume_decision_reconcile (the system path)', () => {
    it('is owned by platform_ops, security definer, a pinned search_path, EXECUTE for receipt_writer_invoker only (never app_user, PUBLIC or the run writer)', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                   FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname = 'resume_decision_reconcile'`,
      );
      expect(rows).toEqual([{ owner: 'platform_ops', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['receipt_writer_invoker'] }]);
    });

    it('plain app_user and the run writer cannot call it', async () => {
      await expect(reconcileResumeRequests(appUserPool, 10)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(reconcileResumeRequests(writerPool, 10)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('makes one system request for each answered or proceeded ask that has none, with the epoch, an audit row and requested_by system; a re-run makes nothing', async () => {
      const [ans, pro] = [await ask(refs, 'answered'), await ask(refs, 'proceeded')];
      await admin.query(`UPDATE work_items SET halt_epoch = 2 WHERE id = $1`, [pro.itemId]);
      const made = await reconcileResumeRequests(invokerPool, 500);
      expect(made.map((m) => m.askId)).toEqual(expect.arrayContaining([ans.id, pro.id]));
      for (const x of [ans, pro]) {
        const rows = await requestsFor(x.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ requested_by: 'system', principal_kind: 'system', state: 'accepted', idempotency_key: `ask:${x.id}` });
        const audit = await admin.query(`SELECT 1 FROM audit_log WHERE actor = 'system' AND action = 'run_action.requested' AND payload->>'target_id' = $1`, [x.id]);
        expect(audit.rows).toHaveLength(1);
      }
      expect((await requestsFor(pro.id))[0]).toMatchObject({ resume_halt_epoch: 2 });
      expect((await reconcileResumeRequests(invokerPool, 500)).map((m) => m.askId)).not.toEqual(expect.arrayContaining([ans.id]));
      expect(await requestsFor(ans.id)).toHaveLength(1);
    });

    it('an answer plus the reconcile is exactly one resume: the session\'s request counts, whatever its state', async () => {
      const a = await ask();
      const first = await request(a.id);
      await reconcileResumeRequests(invokerPool, 500);
      expect((await requestsFor(a.id)).map((r) => r.id)).toEqual([first.action_id]);
      await admin.query(`UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '1 minute' WHERE id = $1`, [first.action_id]);
      await admin.query(`UPDATE run_action_requests SET state = 'refused', claimed_until = NULL, finished_at = now(), error_code = 'x' WHERE id = $1`, [first.action_id]);
      await reconcileResumeRequests(invokerPool, 500);
      expect(await requestsFor(a.id)).toHaveLength(1);
    });

    it('never makes one for an open, overdue or withdrawn ask, an ask with no run, an ask answered over 30 days ago, or an account that is not active', async () => {
      const skipped = [await ask(refs, 'open'), await ask(refs, 'overdue'), await ask(refs, 'withdrawn'), await ask(refs, 'answered', { age: '31 days' }), await ask(refs, 'proceeded', { age: '31 days' })];
      const norun = await ask(refs, 'open', { noRun: true });
      const inactive = await seedAccount(admin, randomUUID());
      const dead = await ask(inactive, 'answered');
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [inactive.accountId]);
      await reconcileResumeRequests(invokerPool, 500);
      for (const s of [...skipped, norun, dead]) expect(await requestsFor(s.id), s.id).toEqual([]);
    });

    it('two passes at once enqueue each ask once', async () => {
      const asks = await Promise.all([ask(), ask(), ask()]);
      await Promise.all([reconcileResumeRequests(invokerPool, 500), reconcileResumeRequests(invokerPool, 500), reconcileResumeRequests(invokerPool, 500)]);
      for (const a of asks) expect(await requestsFor(a.id)).toHaveLength(1);
    });

    it('refuses a limit outside 1..500', async () => {
      for (const n of [0, 501, -1]) await expect(reconcileResumeRequests(invokerPool, n)).rejects.toMatchObject({ code: '22023' });
    });
  });

  describe('run_action_perform_principal', () => {
    async function claimed(askId: string): Promise<string> {
      const rows = await requestsFor(askId);
      await admin.query(`UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes' WHERE id = $1`, [rows[0].id]);
      return rows[0].id;
    }
    const principal = async (id: string) => (await writerPool.query('SELECT * FROM run_action_perform_principal($1::uuid)', [id])).rows[0];

    it('a session request is allowed for its person; a system request is allowed with no user; a request of another kind with a system principal cannot exist', async () => {
      const [s, y] = [await ask(), await ask()];
      await request(s.id);
      await reconcileResumeRequests(invokerPool, 500);
      expect(await principal(await claimed(s.id))).toMatchObject({ allowed: true, kind: 'resume_decision', principal_kind: 'session', user_id: refs.userId });
      expect(await principal(await claimed(y.id))).toMatchObject({ allowed: true, kind: 'resume_decision', principal_kind: 'system', user_id: null, token_id: null });
    });

    it('a system request for an inactive account is not allowed', async () => {
      const t = await seedAccount(admin, randomUUID());
      const a = await ask(t);
      await reconcileResumeRequests(invokerPool, 500);
      const id = await claimed(a.id);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [t.accountId]);
      expect(await principal(id)).toMatchObject({ allowed: false });
    });
  });

  describe('what migration 0860 gives platform_ops, pinned exactly', () => {
    const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows.map((r) => r.x as string);
    const columnPrivileges = (table: string, privilege: string) =>
      q(
        `SELECT a.attname AS x FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = $1 AND has_column_privilege('platform_ops', c.oid, a.attnum, $2) ORDER BY 1`,
        [table, privilege],
      );
    const tablePrivileges = (table: string) =>
      q(
        `SELECT p.privilege_type AS x FROM pg_class c CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege_type)
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = $1 AND has_table_privilege('platform_ops', c.oid, p.privilege_type) ORDER BY 1`,
        [table],
      );
    const policy = async (table: string, name: string) =>
      (await admin.query(`SELECT cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`, [table, name])).rows;

    it('decision_asks: six columns, SELECT only, no table-wide privilege, and one read policy with exactly this text', async () => {
      expect(await columnPrivileges('decision_asks', 'SELECT')).toEqual(['account_id', 'answered_at', 'id', 'run_id', 'state', 'work_item_id']);
      for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES']) expect(await columnPrivileges('decision_asks', privilege), privilege).toEqual([]);
      expect(await tablePrivileges('decision_asks')).toEqual([]);
      expect(await q(`SELECT policyname AS x FROM pg_policies WHERE schemaname = 'public' AND tablename = 'decision_asks' AND 'platform_ops' = ANY(roles) ORDER BY 1`)).toEqual(['platform_ops_resume_select']);
      expect(await policy('decision_asks', 'platform_ops_resume_select')).toEqual([
        {
          cmd: 'SELECT',
          roles: '{platform_ops}',
          qual: "((SESSION_USER <> 'platform_ops'::name) AND ((account_id = (NULLIF(current_setting('app.account_id'::text, true), ''::text))::uuid) OR (state = ANY (ARRAY['answered'::text, 'proceeded'::text]))))",
          with_check: null,
        },
      ]);
    });

    it('work_items: halt_epoch is SELECT only (no INSERT, UPDATE or REFERENCES), and the reconcile read policy has exactly this text', async () => {
      const halt = async (privilege: string) => (await columnPrivileges('work_items', privilege)).filter((c) => c === 'halt_epoch');
      expect(await halt('SELECT')).toEqual(['halt_epoch']);
      for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES']) expect(await halt(privilege), privilege).toEqual([]);
      // every column platform_ops can reach on this table, for any privilege: the columns other migrations opened, and this one's single addition
      expect(await columnPrivileges('work_items', 'SELECT')).toEqual(['account_id', 'halt_epoch', 'id', 'stage', 'title']);
      for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES']) expect(await columnPrivileges('work_items', privilege), privilege).toEqual([]);
      expect(await policy('work_items', 'platform_ops_resume_reconcile')).toEqual([
        {
          cmd: 'SELECT',
          roles: '{platform_ops}',
          qual:
            "((SESSION_USER <> 'platform_ops'::name) AND (EXISTS ( SELECT 1\n   FROM decision_asks a\n  WHERE ((a.account_id = work_items.account_id) AND (a.work_item_id = work_items.id) AND (a.state = ANY (ARRAY['answered'::text, 'proceeded'::text]))))))",
          with_check: null,
        },
      ]);
    });

    it('run_action_requests: the INSERT columns are the seven it had plus resume_halt_epoch, the system-resume INSERT policy has exactly this text, and nothing else moved', async () => {
      expect(await columnPrivileges('run_action_requests', 'INSERT')).toEqual(['account_id', 'idempotency_key', 'kind', 'principal_kind', 'request_hash', 'requested_by', 'resume_halt_epoch', 'target_id']);
      expect(await columnPrivileges('run_action_requests', 'UPDATE')).toEqual(['attempts', 'claimed_until', 'error_code', 'finished_at', 'not_before', 'outcome', 'progress_pages', 'state', 'updated_at']);
      expect(await tablePrivileges('run_action_requests')).toEqual(['DELETE', 'SELECT']);
      expect(await policy('run_action_requests', 'platform_ops_insert_system_resume')).toEqual([
        {
          cmd: 'INSERT',
          roles: '{platform_ops}',
          qual: null,
          with_check:
            "((SESSION_USER <> 'platform_ops'::name) AND (kind = 'resume_decision'::text) AND (principal_kind = 'system'::text) AND (requested_by = 'system'::text) AND ( SELECT account_is_active(run_action_requests.account_id) AS account_is_active))",
        },
      ]);
    });

    it('the two definers 0860 adds are platform_ops-owned security definers with a pinned search_path; the reconcile runs for the receipt invoker alone and the deferral for the run writer alone', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                   FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname IN ('resume_decision_reconcile', 'run_action_defer_resume') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { proname: 'resume_decision_reconcile', owner: 'platform_ops', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['receipt_writer_invoker'] },
        { proname: 'run_action_defer_resume', owner: 'platform_ops', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['agent_run_writer'] },
      ]);
    });
  });

  describe('run_action_defer_resume (a resume waiting on something that clears by itself)', () => {
    /** A resume request in a live claim, `createdAgo` old and on its third attempt; or (another kind) a request that must not be deferrable. */
    async function claimedRequest(kind = 'resume_decision', createdAgo = '0 seconds'): Promise<string> {
      if (kind !== 'resume_decision') {
        const b = await seedItem(refs);
        const other = await admin.query(
          `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state, claimed_until, attempts) VALUES ($1, $2, $3, $4, 'session', 'h', 'claimed', now() + interval '5 minutes', 2) RETURNING id`,
          [refs.accountId, kind, b.itemId, `session:${refs.userId}`],
        );
        return other.rows[0].id as string;
      }
      const a = await ask();
      await reconcileResumeRequests(invokerPool, 500);
      const id = (await requestsFor(a.id))[0].id as string;
      await admin.query(`UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = 3, created_at = now() - $2::interval WHERE id = $1`, [id, createdAgo]);
      return id;
    }
    const defer = async (id: string, seconds = 900, pool: Pool = writerPool) => (await pool.query(`SELECT run_action_defer_resume($1::uuid, $2::int) AS r`, [id, seconds])).rows[0].r as string;
    const row = async (id: string) => (await admin.query(`SELECT state, attempts, claimed_until, not_before, error_code FROM run_action_requests WHERE id = $1`, [id])).rows[0];

    it('puts a live resume claim back to accepted, due after the delay, and gives the attempt back', async () => {
      const id = await claimedRequest();
      expect(await defer(id, 900)).toBe('deferred');
      const r = await row(id);
      expect(r).toMatchObject({ state: 'accepted', attempts: 2, claimed_until: null });
      expect(new Date(r.not_before).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      // not claimable until due
      expect((await writerPool.query(`SELECT * FROM run_action_claim($1::uuid, 60)`, [id])).rows[0].id).toBeNull();
    });

    it('does it for as long as the request is under 14 days old, and stops after, changing nothing', async () => {
      const young = await claimedRequest('resume_decision', '13 days 23 hours');
      expect(await defer(young)).toBe('deferred');
      const old = await claimedRequest('resume_decision', '14 days 1 hour');
      expect(await defer(old)).toBe('expired');
      expect(await row(old)).toMatchObject({ state: 'claimed', attempts: 3 });
    });

    it('refuses a request that is not a live claim, a request of another kind, a bad delay and an unknown id', async () => {
      const notClaimed = await claimedRequest();
      await admin.query(`UPDATE run_action_requests SET state = 'accepted', claimed_until = NULL WHERE id = $1`, [notClaimed]);
      await expect(defer(notClaimed)).rejects.toMatchObject({ code: '55000' });
      const lapsed = await claimedRequest();
      await admin.query(`UPDATE run_action_requests SET claimed_until = now() - interval '1 second' WHERE id = $1`, [lapsed]);
      await expect(defer(lapsed)).rejects.toMatchObject({ code: '55000' });
      await expect(defer(await claimedRequest('cancel_work_item'))).rejects.toMatchObject({ code: '55000' });
      const live = await claimedRequest();
      for (const bad of [0, -1, 3601]) await expect(defer(live, bad), String(bad)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(defer(randomUUID())).rejects.toMatchObject({ code: 'P0002' });
    });

    it('is callable by the run writer alone: not by app_user or the receipt invoker', async () => {
      const id = await claimedRequest();
      await expect(defer(id, 900, appUserPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(defer(id, 900, invokerPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await row(id)).toMatchObject({ state: 'claimed' });
    });
  });

  describe('the driver fact for a refused resume', () => {
    it('work_item_driver_events accepts resume_refused with a fixed code and still refuses an unknown kind', async () => {
      const a = await ask();
      await expect(
        withTenant(writerPool, refs.accountId, (c) =>
          c.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, run_id, dedupe_key) VALUES ($1, $2, 'resume_refused', 'prompt_not_retained', $3, 'ask:test')`, [refs.accountId, a.itemId, a.runId]),
        ),
      ).resolves.toBeDefined();
      await expect(admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'not_a_kind', 'x')`, [refs.accountId, a.itemId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });
});
