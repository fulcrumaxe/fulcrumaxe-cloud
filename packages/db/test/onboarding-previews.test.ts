import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 H17c-1: the onboarding_previews table, its request definer and the daily compute read (0685). */
const HASH = 'h'.repeat(64);

describe('onboarding_previews (0685)', () => {
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

  interface Target { installationId: string; repoId: string; ghUserId: number; ghInstallationId: number; ghOwner: string }
  /** A repo on its own installation plus (by default) the installer record the request reads the GitHub user from. */
  async function seedTarget(r: SeedRefs, o: { kind?: string; installer?: boolean; deleted?: boolean } = {}): Promise<Target> {
    const kind = o.kind ?? 'team_readonly';
    const ghInstallationId = randInt();
    const t = { installationId: randomUUID(), repoId: randomUUID(), ghInstallationId, ghUserId: randInt(), ghOwner: `o${ghInstallationId}` };
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [t.installationId, r.accountId, t.ghInstallationId, kind]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner) VALUES ($1, $2, $3, $4, 'team', $5)`, [t.repoId, r.accountId, t.installationId, randInt(), t.ghOwner]);
    if (o.installer !== false) {
      await admin.query(
        `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at) VALUES ($1, $2, $3, ${o.deleted ? 'now()' : 'NULL'})`,
        [t.ghInstallationId, kind, t.ghUserId],
      );
    }
    return t;
  }
  const randInt = () => randomInt(1, 2_000_000_000);
  async function member(r: SeedRefs, role: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [r.accountId, id, role]);
    return id;
  }
  const requestAs = (r: SeedRefs, userId: string, repoId: string, key: string | null = null, hash = HASH, tokenId?: string) =>
    withTenant(appPool, r.accountId, userId, tokenId, async (c) => (await c.query('SELECT * FROM onboarding_preview_request($1, $2, $3)', [repoId, key, hash])).rows[0]);
  const previewRow = async (id: string) => (await admin.query('SELECT * FROM onboarding_previews WHERE id = $1', [id])).rows[0];
  /** A committed row through the superuser (exempt from the write guard). */
  async function seedPreview(r: SeedRefs, t: Target, over: Record<string, unknown> = {}): Promise<string> {
    const row = { account_id: r.accountId, installation_id: t.installationId, repo_id: t.repoId, gh_user_id: t.ghUserId, gh_installation_id: t.ghInstallationId, gh_owner: t.ghOwner, run_action_id: randomUUID(), ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query(`INSERT INTO onboarding_previews (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row));
    return rows[0].id;
  }

  describe('the table', () => {
    it.each([
      ['a model cap other than 20', { model_cap_usd: 21 }],
      ['a compute cap other than 1', { compute_cap_usd: 2 }],
      ['running without a run', { state: 'running' }],
      ['requested with a run', { run_id: randomUUID() }],
      ['void without a reason', { state: 'void' }],
      ['a malformed void reason', { state: 'void', void_reason: 'Bad Reason' }],
      ['an unknown state', { state: 'done' }],
      ['a void with a run but no start time (0690)', { state: 'void', void_reason: 'spend_refused', run_id: randomUUID() }],
      ['a void with a start time but no run (0690)', { state: 'void', void_reason: 'spend_refused', started_at: new Date() }],
    ])('rejects %s', async (_n, over) => {
      const t = await seedTarget(a);
      await expect(seedPreview(a, t, over)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('one live preview per GitHub user and per installation; a void one frees the slot, a started one does not', async () => {
      const t = await seedTarget(a);
      const first = await seedPreview(a, t);
      const sameUser = { ...(await seedTarget(a)), ghUserId: t.ghUserId };
      await expect(seedPreview(a, sameUser)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(seedPreview(a, { ...t, ghUserId: randInt() })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await admin.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'preview_unavailable' WHERE id = $1`, [first]);
      const second = await seedPreview(a, t);
      await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [second, randomUUID()]);
      await expect(seedPreview(a, t)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('the installation and repo must belong to the same account', async () => {
      const t = await seedTarget(a);
      const other = await seedTarget(b);
      await expect(seedPreview(a, { ...t, installationId: other.installationId })).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      await expect(seedPreview(a, { ...t, repoId: other.repoId })).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
  });

  describe('grants, RLS and the guard', () => {
    it('app_user sees only its tenant and cannot INSERT, UPDATE or DELETE (42501)', async () => {
      const mine = await seedPreview(a, await seedTarget(a));
      const theirs = await seedPreview(b, await seedTarget(b));
      const seen = await withTenant(appPool, a.accountId, (c) => c.query('SELECT id FROM onboarding_previews'));
      const ids = seen.rows.map((r: { id: string }) => r.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
      const t = await seedTarget(a);
      for (const sql of [
        `INSERT INTO onboarding_previews (account_id, installation_id, repo_id, gh_user_id, run_action_id) VALUES ('${a.accountId}', '${t.installationId}', '${t.repoId}', 1, gen_random_uuid())`,
        `UPDATE onboarding_previews SET state = 'void'`,
        `DELETE FROM onboarding_previews`,
      ]) {
        await expect(withTenant(appPool, a.accountId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('a direct platform_ops login cannot write, sees no unstarted row and never the GitHub user', async () => {
      const t = await seedTarget(a);
      const id = await seedPreview(a, t);
      const sql = `INSERT INTO onboarding_previews (account_id, installation_id, repo_id, gh_user_id, run_action_id) VALUES ('${a.accountId}', '${t.installationId}', '${t.repoId}', 1, gen_random_uuid())`;
      await expect(withTenant(opsPool, a.accountId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('SELECT gh_user_id FROM onboarding_previews')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await withTenant(opsPool, a.accountId, (c) => c.query('SELECT id FROM onboarding_previews WHERE id = $1', [id]))).rows).toHaveLength(0);
      const runId = randomUUID();
      await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [id, runId]);
      expect((await opsPool.query('SELECT id, account_id, run_id, state FROM onboarding_previews WHERE run_id = $1', [runId])).rows).toEqual([
        { id, account_id: a.accountId, run_id: runId, state: 'running' },
      ]);
    });

    it('the runner login starts or voids a requested preview under its lock, in its own tenant only', async () => {
      const id = await seedPreview(a, await seedTarget(a));
      const other = await seedPreview(b, await seedTarget(b));
      const runId = randomUUID();
      await withTenant(writerPool, a.accountId, async (c) => {
        expect((await c.query('SELECT state FROM onboarding_previews WHERE id = $1 FOR UPDATE', [id])).rows[0].state).toBe('requested');
        await c.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [id, runId]);
      });
      expect(await previewRow(id)).toMatchObject({ state: 'running', run_id: runId });
      const r = await withTenant(writerPool, a.accountId, (c) => c.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'x' WHERE id = $1`, [other]));
      expect(r.rowCount).toBe(0);
      expect((await previewRow(other)).state).toBe('requested');
    });

    it('the trigger refuses every other edge, and the writer has no grant on the identity columns', async () => {
      const id = await seedPreview(a, await seedTarget(a));
      await withTenant(writerPool, a.accountId, (c) => c.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'preview_capacity' WHERE id = $1`, [id]));
      const edge = (sql: string) => withTenant(writerPool, a.accountId, (c) => c.query(sql, [id]));
      await expect(edge(`UPDATE onboarding_previews SET state = 'running', run_id = gen_random_uuid(), started_at = now(), void_reason = NULL WHERE id = $1`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(edge(`UPDATE onboarding_previews SET gh_user_id = 7 WHERE id = $1`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(edge(`UPDATE onboarding_previews SET run_action_id = gen_random_uuid() WHERE id = $1`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(edge(`DELETE FROM onboarding_previews WHERE id = $1`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('void after a run (0690)', () => {
    it('the runner login moves running to void keeping the run link, which frees the slot', async () => {
      const t = await seedTarget(a);
      const id = await seedPreview(a, t);
      const runId = randomUUID();
      await withTenant(writerPool, a.accountId, (c) =>
        c.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [id, runId]),
      );
      await expect(seedPreview(a, t)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await withTenant(writerPool, a.accountId, (c) => c.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'spend_refused' WHERE id = $1`, [id]));
      expect(await previewRow(id)).toMatchObject({ state: 'void', run_id: runId, void_reason: 'spend_refused' });
      await seedPreview(a, t);
    });

    it('the guard allows no other edge out of running or void, and a void cannot drop or change its run link', async () => {
      const id = await seedPreview(a, await seedTarget(a));
      const runId = randomUUID();
      const edge = (sql: string, params: unknown[] = [id]) => withTenant(writerPool, a.accountId, (c) => c.query(sql, params));
      await edge(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [id, runId]);
      for (const sql of [
        `UPDATE onboarding_previews SET state = 'void', void_reason = 'x', run_id = gen_random_uuid() WHERE id = $1`,
        `UPDATE onboarding_previews SET state = 'void', void_reason = 'x', started_at = now() + interval '1 day' WHERE id = $1`,
        `UPDATE onboarding_previews SET state = 'void', void_reason = 'x', run_id = NULL, started_at = NULL WHERE id = $1`,
        `UPDATE onboarding_previews SET state = 'finished' WHERE id = $1`,
        `UPDATE onboarding_previews SET state = 'requested', run_id = NULL, started_at = NULL WHERE id = $1`,
      ]) {
        await expect(edge(sql)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      await edge(`UPDATE onboarding_previews SET state = 'void', void_reason = 'spend_refused' WHERE id = $1`);
      for (const sql of [
        `UPDATE onboarding_previews SET state = 'running', void_reason = NULL WHERE id = $1`,
        `UPDATE onboarding_previews SET state = 'requested', run_id = NULL, started_at = NULL, void_reason = NULL WHERE id = $1`,
        `UPDATE onboarding_previews SET run_id = NULL, started_at = NULL WHERE id = $1`,
      ]) {
        await expect(edge(sql)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });
  });

  describe('onboarding_preview_request', () => {
    it('inserts one requested preview and its run action, copying the GitHub user from the installer record, and audits once', async () => {
      const t = await seedTarget(a);
      const owner = a.userId;
      const res = await requestAs(a, owner, t.repoId, 'k-happy');
      expect(res).toMatchObject({ state: 'accepted', replayed: false });
      expect(await previewRow(res.preview_id)).toMatchObject({
        account_id: a.accountId, installation_id: t.installationId, repo_id: t.repoId, state: 'requested', run_id: null,
        gh_user_id: String(t.ghUserId), run_action_id: res.action_id, model_cap_usd: '20', compute_cap_usd: '1',
      });
      const action = (await admin.query('SELECT kind, target_id, requested_by, principal_kind FROM run_action_requests WHERE id = $1', [res.action_id])).rows[0];
      expect(action).toEqual({ kind: 'start_preview', target_id: res.preview_id, requested_by: `session:${owner}`, principal_kind: 'session' });
      const audit = await admin.query(`SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested' AND payload->>'action_id' = $2`, [a.accountId, res.action_id]);
      expect(audit.rowCount).toBe(1);
    });

    it('an admin may ask; a member may not; a non-member may not (42501) and nothing is written', async () => {
      const t = await seedTarget(a);
      const before = (await admin.query('SELECT count(*)::int n FROM onboarding_previews WHERE account_id = $1', [a.accountId])).rows[0].n;
      await expect(requestAs(a, await member(a, 'member'), t.repoId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(requestAs(a, randomUUID(), t.repoId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await admin.query('SELECT count(*)::int n FROM onboarding_previews WHERE account_id = $1', [a.accountId])).rows[0].n).toBe(before);
      const res = await requestAs(a, await member(a, 'admin'), t.repoId);
      expect(res.replayed).toBe(false);
    });

    it('run_action_request(start_preview) called directly: a plain member is 42501, an admin is accepted', async () => {
      const t = await seedTarget(a);
      const pid = await seedPreview(a, t);
      const direct = (userId: string, key: string) =>
        withTenant(appPool, a.accountId, userId, undefined, async (c) =>
          (await c.query(`SELECT * FROM run_action_request('start_preview', $1, $2, $3)`, [pid, key, HASH])).rows[0]);
      const actions = async () => (await admin.query(`SELECT count(*)::int n FROM run_action_requests WHERE account_id = $1 AND kind = 'start_preview' AND target_id = $2`, [a.accountId, pid])).rows[0].n;
      await expect(direct(await member(a, 'member'), 'k-direct-member')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await actions()).toBe(0);
      expect(await direct(await member(a, 'admin'), 'k-direct-admin')).toMatchObject({ state: 'accepted', replayed: false });
      expect(await actions()).toBe(1);
    });

    it('a token principal is refused even with a live token of the owner', async () => {
      const t = await seedTarget(a);
      const { rows } = await admin.query(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['runs:cancel'], now() + interval '1 day') RETURNING id`,
        [a.accountId, a.userId, randomUUID()],
      );
      await expect(requestAs(a, a.userId, t.repoId, null, HASH, rows[0].id)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('a replayed key returns the same ids and writes nothing; the same key with another hash is 22023', async () => {
      const t = await seedTarget(a);
      const first = await requestAs(a, a.userId, t.repoId, 'k-replay');
      const again = await requestAs(a, a.userId, t.repoId, 'k-replay');
      expect(again).toEqual({ ...first, replayed: true });
      await expect(requestAs(a, a.userId, t.repoId, 'k-replay', 'x'.repeat(64))).rejects.toMatchObject({ code: '22023' });
      expect((await admin.query('SELECT count(*)::int n FROM onboarding_previews WHERE repo_id = $1', [t.repoId])).rows[0].n).toBe(1);
    });

    it('a second live preview for the same installer or installation is 23505 and leaves no action behind', async () => {
      const t = await seedTarget(a);
      await requestAs(a, a.userId, t.repoId);
      const actions = async () => (await admin.query(`SELECT count(*)::int n FROM run_action_requests WHERE account_id = $1 AND kind = 'start_preview'`, [a.accountId])).rows[0].n;
      const before = await actions();
      await expect(requestAs(a, a.userId, t.repoId)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      expect(await actions()).toBe(before);
    });

    it.each([
      ['a team installation', { kind: 'team' }],
      ['a sitekit installation', { kind: 'sitekit' }],
      ['no installer record', { installer: false }],
      ['a deleted installer record', { deleted: true }],
    ])('refuses a repo on %s with P0002', async (_n, o) => {
      const t = await seedTarget(a, o);
      await expect(requestAs(a, a.userId, t.repoId)).rejects.toMatchObject({ code: 'P0002' });
      expect((await admin.query('SELECT count(*)::int n FROM onboarding_previews WHERE repo_id = $1', [t.repoId])).rows[0].n).toBe(0);
    });

    it('another account\'s repo and a random repo raise the same P0002 message', async () => {
      const theirs = await seedTarget(b);
      const messages = new Set<string>();
      for (const repo of [theirs.repoId, randomUUID()]) {
        const err = await requestAs(a, a.userId, repo).catch((e) => e);
        expect(err.code).toBe('P0002');
        messages.add(err.message);
      }
      expect(messages.size).toBe(1);
    });
  });

  describe('install limit columns (0695)', () => {
    it('both identity columns are required, positive and lower-case', async () => {
      const t = await seedTarget(a);
      await expect(seedPreview(a, t, { gh_owner: null })).rejects.toMatchObject({ code: '23502' });
      await expect(seedPreview(a, t, { gh_installation_id: null })).rejects.toMatchObject({ code: '23502' });
      await expect(seedPreview(a, t, { gh_installation_id: 0 })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(seedPreview(a, t, { gh_owner: 'Acme' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('a direct platform_ops login sees no unstarted row through the new columns, and still cannot read the GitHub user', async () => {
      const t = await seedTarget(a);
      const id = await seedPreview(a, t);
      const seen = await opsPool.query('SELECT gh_owner, gh_installation_id, created_at FROM onboarding_previews WHERE id = $1', [id]);
      expect(seen.rows).toHaveLength(0);
      expect((await withTenant(opsPool, a.accountId, (c) => c.query('SELECT gh_owner FROM onboarding_previews WHERE id = $1', [id]))).rows).toHaveLength(0);
      await expect(opsPool.query('SELECT gh_user_id FROM onboarding_previews')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('no tenant role gains a privilege: each non-owner role holds on the new columns what it holds on gh_user_id, and app_user sees only its tenant', async () => {
      const roles = (await admin.query(`SELECT rolname FROM pg_roles WHERE NOT rolsuper AND rolname <> 'platform_ops' AND rolname NOT LIKE 'pg\\_%'`)).rows.map((r: { rolname: string }) => r.rolname);
      expect(roles).toEqual(expect.arrayContaining(['app_user', 'agent_run_writer']));
      for (const role of roles) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const has = async (col: string) =>
            (await admin.query('SELECT has_column_privilege($1, $2, $3, $4) AS v', [role, 'onboarding_previews', col, priv])).rows[0].v;
          const base = await has('gh_user_id');
          expect(await has('gh_owner'), `${role} ${priv} gh_owner`).toBe(base);
          expect(await has('gh_installation_id'), `${role} ${priv} gh_installation_id`).toBe(base);
        }
      }
      const mine = await seedPreview(a, await seedTarget(a));
      const theirs = await seedPreview(b, await seedTarget(b));
      const seen = await withTenant(appPool, a.accountId, (c) => c.query('SELECT id, gh_owner FROM onboarding_previews'));
      expect(seen.rows.map((r: { id: string }) => r.id)).toContain(mine);
      expect(seen.rows.map((r: { id: string }) => r.id)).not.toContain(theirs);
      const id = await seedPreview(a, await seedTarget(a));
      for (const col of ['gh_owner', 'gh_installation_id']) {
        await expect(withTenant(writerPool, a.accountId, (c) => c.query(`UPDATE onboarding_previews SET ${col} = ${col} WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });

  describe('preview_daily_compute_usd', () => {
    async function reserve(r: SeedRefs, usd: number, o: { purpose?: string; budget?: string; state?: string; ageDays?: number } = {}) {
      await admin.query(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7::int))`,
        [r.accountId, r.runId, usd, o.state ?? 'open', o.budget ?? 'foreground_compute', o.purpose ?? 'preview', o.ageDays ?? 0],
      );
    }
    const total = async () => Number((await withTenant(appPool, a.accountId, (c) => c.query('SELECT preview_daily_compute_usd() AS v'))).rows[0].v);

    it('sums preview compute reservations of every account created today in any state, and nothing else', async () => {
      const before = await total();
      await reserve(a, 0.25);
      await reserve(b, 0.5, { state: 'settled', budget: 'background_compute' });
      await reserve(a, 1, { state: 'released' });
      await reserve(a, 3, { purpose: 'run' });
      await reserve(a, 3, { budget: 'model' });
      await reserve(a, 3, { ageDays: 2 });
      expect(Number(((await total()) - before).toFixed(4))).toBe(1.75);
    });

    it('a finished preview still counts: finalize releases the compute reservation, and the day total does not drop', async () => {
      const before = await total();
      await reserve(a, 1);
      expect(Number(((await total()) - before).toFixed(4))).toBe(1);
      // What a run's finalize does to a compute row (settleOrReleaseOpenRows -> releaseWith).
      await admin.query(`UPDATE spend_reservations SET state = 'released' WHERE account_id = $1 AND run_id = $2 AND purpose = 'preview' AND state = 'open'`, [a.accountId, a.runId]);
      expect(Number(((await total()) - before).toFixed(4))).toBe(1);
    });

    it('is executable by app_user and the runner, not PUBLIC; a platform_ops login reads no reservation row', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) owner, p.prosecdef, has_function_privilege('app_user', p.oid, 'EXECUTE') a,
                has_function_privilege('agent_run_writer', p.oid, 'EXECUTE') w, has_function_privilege('partner_user', p.oid, 'EXECUTE') pu
           FROM pg_proc p WHERE p.oid = 'preview_daily_compute_usd()'::regprocedure`,
      );
      expect(rows[0]).toEqual({ owner: 'platform_ops', prosecdef: true, a: true, w: true, pu: false });
      expect((await opsPool.query('SELECT usd_reserved FROM spend_reservations')).rows).toHaveLength(0);
      await expect(opsPool.query('SELECT id FROM spend_reservations')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // 0689 grants account_id and run_id (the daily total joins the ledger on them): the policy still shows a direct login no row.
      expect((await opsPool.query('SELECT account_id, run_id FROM spend_reservations')).rows).toHaveLength(0);
    });
  });
});
