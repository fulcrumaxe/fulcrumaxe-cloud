import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#3 K10: the site kit's one-time preview, its stamps and its own daily compute counter (1019). */
describe('site-kit preview (1019)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool, opsPool]) await p.end();
  });

  const randInt = () => randomInt(1, 2_000_000_000);
  interface Target { siteId: string; installationId: string; ghInstallationId: number; ghUserId: number }

  /** A site on its own sitekit installation, with the installer record the request reads the GitHub user from. */
  async function seedSite(r: SeedRefs, o: { ghUserId?: number; kind?: string } = {}): Promise<Target> {
    const t = { siteId: randomUUID(), installationId: randomUUID(), ghInstallationId: randInt(), ghUserId: o.ghUserId ?? randInt() };
    const repoId = randomUUID();
    const kind = o.kind ?? 'sitekit';
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [t.installationId, r.accountId, t.ghInstallationId, kind]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [repoId, r.accountId, t.installationId, randInt()]);
    await admin.query(`INSERT INTO sites (id, account_id, repo_id) VALUES ($1, $2, $3)`, [t.siteId, r.accountId, repoId]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, $3)`, [t.ghInstallationId, kind, t.ghUserId]);
    return t;
  }
  async function member(r: SeedRefs, role: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [r.accountId, id, role]);
    return id;
  }
  const requestAs = (userId: string, siteId: string, cap: number | null = 20, tokenId?: string) =>
    withTenant(appPool, a.accountId, userId, tokenId, async (c) => (await c.query('SELECT * FROM sitekit_preview_request($1, $2)', [siteId, cap])).rows[0]);
  const asWriter = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(writerPool, a.accountId, fn);
  const row = async (id: string) => (await admin.query('SELECT * FROM sitekit_previews WHERE id = $1', [id])).rows[0];

  describe('the request', () => {
    it('opens a requested preview and stamps the installer and the installation', async () => {
      const owner = await member(a, 'owner');
      const t = await seedSite(a);
      const got = await requestAs(owner, t.siteId);
      expect(got.state).toBe('requested');
      expect(await row(got.preview_id)).toMatchObject({ state: 'requested', model_cap_usd: '20', compute_cap_usd: '1' });
      const stamp = (await admin.query('SELECT gh_user_id, gh_installation_id FROM sitekit_preview_stamps WHERE preview_id = $1', [got.preview_id])).rows[0];
      expect({ u: Number(stamp.gh_user_id), i: Number(stamp.gh_installation_id) }).toEqual({ u: t.ghUserId, i: t.ghInstallationId });
    });

    it.each([null, 19, 40, 20.5])('refuses a model cap that was not confirmed exactly (%s) before writing anything', async (cap) => {
      const owner = await member(a, 'owner');
      const t = await seedSite(a);
      await expect(requestAs(owner, t.siteId, cap)).rejects.toMatchObject({ code: 'PX422' });
      expect((await admin.query('SELECT 1 FROM sitekit_preview_stamps WHERE gh_installation_id = $1', [t.ghInstallationId])).rowCount).toBe(0);
    });

    it('is for a session owner or admin only', async () => {
      const t = await seedSite(a);
      await expect(requestAs(await member(a, 'member'), t.siteId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(requestAs(await member(a, 'owner'), t.siteId, 20, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('does not find a missing site, a team installation, an installation without an installer, or a deleted installer', async () => {
      const owner = await member(a, 'owner');
      await expect(requestAs(owner, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.NO_DATA_FOUND });
      await expect(requestAs(owner, (await seedSite(a, { kind: 'team' })).siteId)).rejects.toMatchObject({ code: PG_ERROR.NO_DATA_FOUND });
      const gone = await seedSite(a);
      await admin.query('UPDATE installation_installers SET deleted_at = now() WHERE gh_installation_id = $1', [gone.ghInstallationId]);
      await expect(requestAs(owner, gone.siteId)).rejects.toMatchObject({ code: PG_ERROR.NO_DATA_FOUND });
    });

    it('a second preview for the same installation, or the same GitHub user, is refused as used', async () => {
      const owner = await member(a, 'owner');
      const t = await seedSite(a);
      await requestAs(owner, t.siteId);
      await expect(requestAs(owner, t.siteId)).rejects.toMatchObject({ code: 'PX409' });
      const sameUser = await seedSite(a, { ghUserId: t.ghUserId });
      await expect(requestAs(owner, sameUser.siteId)).rejects.toMatchObject({ code: 'PX409' });
    });

    it('the stamp survives an uninstall and a reinstall: the installation row is gone, a new one for the same user is still refused', async () => {
      const owner = await member(a, 'owner');
      const t = await seedSite(a);
      const first = await requestAs(owner, t.siteId);
      // Uninstall: the installer record is marked deleted and the installation (with its repo and site link) is removed.
      await admin.query('UPDATE installation_installers SET deleted_at = now() WHERE gh_installation_id = $1', [t.ghInstallationId]);
      await admin.query('UPDATE sites SET repo_id = NULL WHERE id = $1', [t.siteId]);
      await admin.query('DELETE FROM repos WHERE installation_id = $1', [t.installationId]);
      await admin.query('DELETE FROM installations WHERE id = $1', [t.installationId]);
      expect((await admin.query('SELECT 1 FROM sitekit_preview_stamps WHERE preview_id = $1', [first.preview_id])).rowCount).toBe(1);
      // Reinstall: GitHub gives a new installation id; the same person installs it again and the site is linked to its repo.
      const again = await seedSite(a, { ghUserId: t.ghUserId });
      await expect(requestAs(owner, again.siteId)).rejects.toMatchObject({ code: 'PX409' });
      expect((await admin.query('SELECT 1 FROM sitekit_preview_stamps WHERE gh_user_id = $1', [t.ghUserId])).rowCount).toBe(1);
    });

    it('a different person on a different installation is not blocked by someone else\'s stamp', async () => {
      const owner = await member(a, 'owner');
      await requestAs(owner, (await seedSite(a)).siteId);
      expect((await requestAs(owner, (await seedSite(a)).siteId)).state).toBe('requested');
    });
  });

  describe('moving a preview on', () => {
    async function requested(): Promise<{ id: string; t: Target }> {
      const t = await seedSite(a);
      return { id: (await requestAs(await member(a, 'owner'), t.siteId)).preview_id, t };
    }
    const finish = (id: string, state: string, reason: string | null = null) =>
      asWriter(async (c) => (await c.query('SELECT sitekit_preview_finish($1, $2, $3, 7, 2, 1, $4) AS ok', [id, state, reason, '<html></html>'])).rows[0].ok);
    const start = (id: string) => asWriter(async (c) => (await c.query('SELECT sitekit_preview_start($1) AS ok', [id])).rows[0].ok);

    it('requested, running, finished with the counts and the render; nothing moves it again', async () => {
      const { id } = await requested();
      expect(await finish(id, 'finished')).toBe(false);
      expect(await start(id)).toBe(true);
      expect(await start(id)).toBe(false);
      expect(await finish(id, 'finished')).toBe(true);
      expect(await row(id)).toMatchObject({ state: 'finished', claims_total: 7, claims_unverifiable: 2, blockers: 1, homepage_html: '<html></html>' });
      expect(await finish(id, 'failed', 'agent_failed')).toBe(false);
      expect(await finish(id, 'void', 'spend_refused')).toBe(false);
    });

    it('a request whose agent never started is void and hands its stamp back; one that started an agent and failed keeps it', async () => {
      const voided = await requested();
      expect(await finish(voided.id, 'void', 'spend_refused')).toBe(true);
      expect((await requestAs(await member(a, 'owner'), voided.t.siteId)).state).toBe('requested');

      const failed = await requested();
      await start(failed.id);
      expect(await finish(failed.id, 'failed', 'agent_failed')).toBe(true);
      expect(await row(failed.id)).toMatchObject({ state: 'failed', reason: 'agent_failed', claims_total: null });
      await expect(requestAs(await member(a, 'owner'), failed.t.siteId)).rejects.toMatchObject({ code: 'PX409' });
    });

    it('a running preview whose agent never started can be voided, and hands its stamp back', async () => {
      const { id, t } = await requested();
      await start(id);
      expect(await finish(id, 'void', 'clone_failed')).toBe(true);
      expect(await row(id)).toMatchObject({ state: 'void', started_at: null, reason: 'clone_failed' });
      expect((await requestAs(await member(a, 'owner'), t.siteId)).state).toBe('requested');
    });

    it('a malformed reason or an unknown state is refused', async () => {
      const { id } = await requested();
      await start(id);
      await expect(finish(id, 'failed', 'Bad Reason')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(finish(id, 'done')).rejects.toMatchObject({ code: '22023' });
    });

    it('another account cannot move or read the preview', async () => {
      const { id } = await requested();
      const other = await seedAccount(admin, randomUUID());
      expect(await withTenant(writerPool, other.accountId, async (c) => (await c.query('SELECT sitekit_preview_start($1) AS ok', [id])).rows[0].ok)).toBe(false);
      expect((await withTenant(appPool, other.accountId, (c) => c.query('SELECT 1 FROM sitekit_previews WHERE id = $1', [id]))).rowCount).toBe(0);
      expect((await withTenant(appPool, a.accountId, (c) => c.query('SELECT 1 FROM sitekit_previews WHERE id = $1', [id]))).rowCount).toBe(1);
    });

    it('app_user can read but not write the tables, and reads no stamp', async () => {
      const { id } = await requested();
      await expect(withTenant(appPool, a.accountId, (c) => c.query(`UPDATE sitekit_previews SET state = 'void' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(appPool, a.accountId, (c) => c.query('SELECT 1 FROM sitekit_preview_stamps'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('SELECT 1 FROM sitekit_preview_stamps')).resolves.toMatchObject({ rowCount: 0 });
    });
  });

  describe('the daily counter', () => {
    async function reserve(usd: number, o: { purpose: string; state?: string; budget?: string; ageDays?: number }) {
      await admin.query(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7::int))`,
        [a.accountId, a.runId, usd, o.state ?? 'open', o.budget ?? 'foreground_compute', o.purpose, o.ageDays ?? 0],
      );
    }
    // Each test starts from an empty counter: the reservations a test adds are removed again.
    afterEach(async () => {
      await admin.query(`DELETE FROM spend_reservations WHERE account_id = $1 AND purpose IN ('preview', 'sitekit_preview')`, [a.accountId]);
    });
    const sitekitTotal = async () => Number((await withTenant(appPool, a.accountId, (c) => c.query('SELECT sitekit_preview_daily_compute_usd() AS v'))).rows[0].v);
    const onboardingTotal = async () => Number((await withTenant(appPool, a.accountId, (c) => c.query('SELECT preview_daily_compute_usd() AS v'))).rows[0].v);

    it('counts only its own purpose, compute rows and today', async () => {
      const before = await sitekitTotal();
      await reserve(0.25, { purpose: 'sitekit_preview' });
      await reserve(0.5, { purpose: 'sitekit_preview', state: 'released', budget: 'background_compute' });
      await reserve(3, { purpose: 'preview' });
      await reserve(3, { purpose: 'sitekit_preview', budget: 'model' });
      await reserve(3, { purpose: 'sitekit_preview', ageDays: 2 });
      expect(Number(((await sitekitTotal()) - before).toFixed(4))).toBe(0.75);
    });

    it('a full day of sitekit_preview does not change what preview_daily_compute_usd() reads', async () => {
      const before = await onboardingTotal();
      await reserve(10, { purpose: 'sitekit_preview' });
      expect(await onboardingTotal()).toBe(before);
    });

    it('a full day of open onboarding preview reservations does not block a site-kit preview, and a full day of its own does, at the boundary', async () => {
      const owner = await member(a, 'owner');
      const sitekitBefore = await sitekitTotal();
      await reserve(10, { purpose: 'preview' });
      const first = await requestAs(owner, (await seedSite(a)).siteId);
      expect(first.state).toBe('requested');
      // Bring this counter to just under the limit: still allowed. Then to exactly the limit: refused with the capacity code.
      const now = await sitekitTotal();
      await reserve(Number((9.99 - now).toFixed(4)), { purpose: 'sitekit_preview' });
      expect((await requestAs(owner, (await seedSite(a)).siteId)).state).toBe('requested');
      await reserve(Number((10 - (await sitekitTotal())).toFixed(4)), { purpose: 'sitekit_preview' });
      expect(await sitekitTotal()).toBe(10);
      const t = await seedSite(a);
      await expect(requestAs(owner, t.siteId)).rejects.toMatchObject({ code: 'PX429' });
      expect((await admin.query('SELECT 1 FROM sitekit_preview_stamps WHERE gh_installation_id = $1', [t.ghInstallationId])).rowCount).toBe(0);
      expect(sitekitBefore).toBeLessThanOrEqual(10);
    });

    it('is executable by app_user and the runner, not PUBLIC, and a platform_ops login reads no reservation row', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) owner, p.prosecdef, has_function_privilege('app_user', p.oid, 'EXECUTE') a,
                has_function_privilege('agent_run_writer', p.oid, 'EXECUTE') w, has_function_privilege('partner_user', p.oid, 'EXECUTE') pu
           FROM pg_proc p WHERE p.oid = 'sitekit_preview_daily_compute_usd()'::regprocedure`,
      );
      expect(rows[0]).toEqual({ owner: 'platform_ops', prosecdef: true, a: true, w: true, pu: false });
      expect((await opsPool.query('SELECT account_id, run_id FROM spend_reservations')).rows).toHaveLength(0);
    });

    it('the purpose check names exactly run, preview and sitekit_preview', async () => {
      await expect(reserve(1, { purpose: 'other' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });
});
