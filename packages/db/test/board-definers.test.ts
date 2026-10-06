import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { addListing, addMember, claim, insertClaimPair, raised, release, seedMaintainer, seedPayer } from './helpers/board.js';

const FUNCTIONS = ['board_cap_defaults()', 'claim_listing(uuid,numeric,numeric)', 'release_claim(uuid)', 'my_claims()',
  'claim_funding_for_run(uuid)', 'board_public_listings(text)'];
const APP_USER_EXECUTES = FUNCTIONS.filter((f) => !f.startsWith('claim_funding_for_run'));

// D#70 BRD-1b, 0664: 1b-1 (privileges), 1b-2 (no id parameters), 1b-5 (atomic claim), 1b-6 (caps),
// 1b-8 (release rules) and 1b-9 (claim limits).
describe('migration 0664: board definers', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;
  let ops: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.DATABASE_URL_APP_USER!);
    ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, app, ops]) await p.end();
  });

  const counts = async (m: string, p: string) => ({
    claims: (await admin.query('SELECT count(*)::int n FROM task_claims WHERE account_id = $1', [m])).rows[0].n,
    fundings: (await admin.query('SELECT count(*)::int n FROM claim_fundings WHERE account_id = $1', [p])).rows[0].n,
    audit: (await admin.query(`SELECT count(*)::int n FROM audit_log WHERE account_id IN ($1, $2) AND action LIKE 'board.%'`, [m, p])).rows[0].n,
  });

  describe('1b-1: function privileges (C-2)', () => {
    it('no function is executable by PUBLIC, partner_user or a fresh role; app_user gets exactly the four routes and the defaults', async () => {
      await admin.query('CREATE ROLE board_fresh_role NOLOGIN');
      try {
        const { rows } = await admin.query(
          `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                  has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
                  has_function_privilege('partner_user', p.oid, 'EXECUTE') AS partner,
                  has_function_privilege('board_fresh_role', p.oid, 'EXECUTE') AS fresh,
                  EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) ORDER BY 1`,
          [['board_cap_defaults', 'claim_listing', 'release_claim', 'my_claims', 'claim_funding_for_run', 'board_public_listings',
            'board_claims_write_guard', 'board_claims_identity_immutable']],
        );
        expect(rows).toHaveLength(8);
        for (const r of rows) {
          expect(r, r.sig).toMatchObject({ partner: false, fresh: false, public_: false });
          expect(r.app_user, r.sig).toBe(APP_USER_EXECUTES.includes(r.sig));
        }
        for (const f of FUNCTIONS.filter((x) => x !== 'board_cap_defaults()')) {
          const r = rows.find((x) => x.sig === f)!;
          expect(r.owner, f).toBe('platform_ops');
          expect(r.proconfig, f).toEqual(['search_path=pg_catalog, public, pg_temp']);
        }
      } finally {
        await admin.query('DROP ROLE board_fresh_role');
      }
    });

    it('an app_user call of claim_funding_for_run fails with a privilege error', async () => {
      const m = await seedMaintainer(admin);
      await expect(withTenant(app, m.accountId, m.userId, (c) => c.query('SELECT * FROM claim_funding_for_run($1)', [m.runId])))
        .rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the migration has one REVOKE ALL ... FROM PUBLIC per function it creates', () => {
      const sql = readFileSync(new URL('../migrations/0664_contributor_board_definers.sql', import.meta.url), 'utf8')
        .split('\n').filter((l) => !l.startsWith('--')).join('\n');
      const created = [...sql.matchAll(/^CREATE FUNCTION (\w+)\(/gm)].map((x) => x[1]);
      expect(created).toHaveLength(8);
      for (const name of created) {
        expect([...sql.matchAll(new RegExp(`^REVOKE ALL ON FUNCTION ${name}\\([^)]*\\) FROM PUBLIC;`, 'gm'))], name).toHaveLength(1);
      }
    });
  });

  it('1b-2: no parameter or output name of the functions names a user or an account', async () => {
    const { rows } = await admin.query<{ proname: string; names: string[] | null }>(
      `SELECT proname, proargnames AS names FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname = ANY(ARRAY['board_cap_defaults', 'claim_listing', 'release_claim', 'my_claims', 'claim_funding_for_run', 'board_public_listings'])`,
    );
    expect(rows).toHaveLength(6);
    const all = rows.flatMap((r) => r.names ?? []);
    expect(all).toContain('cap_model_usd');
    expect(all.filter((n) => /user|account/i.test(n))).toEqual([]);
  });

  describe('1b-5: the claim is atomic across both tenants (C-5)', () => {
    it('inserts the claim, a self funding and one audit row per side, with expires_at from the repo ttl', async () => {
      const m = await seedMaintainer(admin, true, 4);
      const p = await seedPayer(admin);
      const listing = await addListing(admin, m);
      const c = await claim(app, p, listing, 12.5, 2);
      const { rows: [t] } = await admin.query(`SELECT * FROM task_claims WHERE id = $1`, [c.claim_id]);
      expect(t).toMatchObject({ account_id: m.accountId, payer_account_ref: p.accountId, claimant_user_id: p.userId, state: 'active', spec_sha256: 'a'.repeat(64), claimant_was_member: false });
      const { rows: [f] } = await admin.query(`SELECT * FROM claim_fundings WHERE id = $1`, [t.funding_ref]);
      expect(f).toMatchObject({ account_id: p.accountId, claim_ref: c.claim_id, listing_ref: listing, kind: 'self', state: 'active' });
      expect(Number(f.cap_model_usd)).toBe(12.5);
      const hours = (t.expires_at.getTime() - t.created_at.getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(4, 1);
      const { rows: audit } = await admin.query(`SELECT account_id, actor, payload FROM audit_log WHERE action LIKE 'board.claim_%' AND payload->>'claim_id' = $1`, [c.claim_id]);
      expect(audit.map((a) => a.account_id).sort()).toEqual([m.accountId, p.accountId].sort());
      expect(audit.every((a) => a.actor === p.userId)).toBe(true);
      // The maintainer's row says nothing about the payer or the caps.
      expect(JSON.stringify(audit.find((a) => a.account_id === m.accountId).payload)).not.toMatch(/cap_|funding|payer/);
    });

    it('a failure injected on the funding insert leaves no claim and no audit row', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const listing = await addListing(admin, m);
      await admin.query(`CREATE FUNCTION board_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
      await admin.query('CREATE TRIGGER board_test_boom BEFORE INSERT ON claim_fundings FOR EACH ROW EXECUTE FUNCTION board_test_boom()');
      try {
        expect((await raised(claim(app, p, listing))).message).toBe('boom');
      } finally {
        await admin.query('DROP TRIGGER board_test_boom ON claim_fundings');
        await admin.query('DROP FUNCTION board_test_boom()');
      }
      expect(await counts(m.accountId, p.accountId)).toEqual({ claims: 0, fundings: 0, audit: 0 });
    });

    it('20 concurrent claims of one listing give exactly one active claim', async () => {
      const m = await seedMaintainer(admin);
      const listing = await addListing(admin, m);
      const payers = [];
      for (let i = 0; i < 20; i++) payers.push(await seedPayer(admin));
      const results = await Promise.allSettled(payers.map((p) => claim(app, p, listing)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const errs = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason.message);
      expect(new Set(errs)).toEqual(new Set(['already_claimed']));
      const { rows } = await admin.query(`SELECT count(*)::int n FROM task_claims WHERE listing_id = $1 AND state IN ('active', 'in_review')`, [listing]);
      expect(rows[0].n).toBe(1);
    });

    it('claim_listing waits for a lock on the listing row', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const listing = await addListing(admin, m);
      const holder = await adminPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM board_listings WHERE id = $1 FOR NO KEY UPDATE', [listing]);
        const pending = claim(app, p, listing);
        let waiting = 0;
        for (let i = 0; i < 100 && !waiting; i++) {
          waiting = (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%claim_listing%'`)).rows[0].n;
          if (!waiting) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waiting).toBe(1);
        await holder.query('COMMIT');
        await pending;
      } finally {
        holder.release();
      }
    });

    it('a claim past expires_at is expired by the next claim, which succeeds and closes the old funding', async () => {
      const m = await seedMaintainer(admin);
      const p1 = await seedPayer(admin);
      const p2 = await seedPayer(admin);
      const listing = await addListing(admin, m);
      const old = await insertClaimPair(admin, m, p1, listing, { expiresInHours: -1 });
      await claim(app, p2, listing);
      expect((await admin.query('SELECT state FROM task_claims WHERE id = $1', [old.claimId])).rows[0].state).toBe('expired');
      expect((await admin.query('SELECT state FROM claim_fundings WHERE id = $1', [old.fundingId])).rows[0].state).toBe('closed');
    });
  });

  describe('1b-6: caps are checked in the definer (C-6)', () => {
    const bad = ['0', '-1', '250.0001', 'NaN', 'Infinity', '-Infinity'];
    it('the defaults are $250 feature, $60 small, $5 compute', async () => {
      const { rows: [d] } = await admin.query('SELECT * FROM board_cap_defaults()');
      expect(d).toMatchObject({ model_feature_usd: '250', model_small_usd: '60', compute_usd: '5', max_active_per_claimant: 3, max_active_per_payer: 10 });
    });
    it.each(bad.map((v) => [v]))('cap_model_usd %s is invalid_cap and stores nothing', async (v) => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      expect((await raised(claim(app, p, await addListing(admin, m), v, 1))).message).toBe('invalid_cap');
      expect(await counts(m.accountId, p.accountId)).toEqual({ claims: 0, fundings: 0, audit: 0 });
    });
    it.each([...bad.slice(0, 2), '5.0001', 'NaN', 'Infinity', '-Infinity'].map((v) => [v]))('cap_compute_usd %s is invalid_cap', async (v) => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      expect((await raised(claim(app, p, await addListing(admin, m), 10, v))).message).toBe('invalid_cap');
    });
    it('the ceiling is the item kind: 250 passes on a feature, 60.0001 fails on a small; both caps at their maximum pass', async () => {
      const m = await seedMaintainer(admin);
      await claim(app, await seedPayer(admin), await addListing(admin, m, { itemKind: 'feature' }), 250, 5);
      const small = await addListing(admin, m, { itemKind: 'small' });
      expect((await raised(claim(app, await seedPayer(admin), small, '60.0001', 1))).message).toBe('invalid_cap');
      await claim(app, await seedPayer(admin), small, 60, 5);
    });
  });

  describe('1b-8: release rules (C-7)', () => {
    it('the claimant releases: claim released, funding closed, audit row on each side; a second release is refused', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const c = await claim(app, p, await addListing(admin, m));
      await release(app, p, c.claim_id);
      const { rows: [t] } = await admin.query('SELECT state, funding_ref FROM task_claims WHERE id = $1', [c.claim_id]);
      expect(t.state).toBe('released');
      expect((await admin.query('SELECT state FROM claim_fundings WHERE id = $1', [t.funding_ref])).rows[0].state).toBe('closed');
      expect((await admin.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'board.claim_released' AND payload->>'claim_id' = $1`, [c.claim_id])).rows[0].n).toBe(2);
      expect((await raised(release(app, p, c.claim_id))).message).toBe('claim_not_active');
    });

    it('an owner or admin of the payer account releases in that account; a member and a stranger get not-found', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const adminUser = await addMember(admin, p.accountId, 'admin');
      const memberUser = await addMember(admin, p.accountId, 'member');
      const stranger = await seedPayer(admin);
      const listing = await addListing(admin, m);
      const c = await claim(app, p, listing);
      for (const who of [{ accountId: p.accountId, userId: memberUser }, stranger,
        // the payer's admin, but in a session for another account they belong to: not the payer's context
        { accountId: m.accountId, userId: m.userId }]) {
        const e = await raised(release(app, who, c.claim_id));
        expect(e, JSON.stringify(who)).toEqual({ code: 'P0002', message: 'not_found' });
      }
      await release(app, { accountId: p.accountId, userId: adminUser }, c.claim_id);
      expect((await admin.query('SELECT state FROM task_claims WHERE id = $1', [c.claim_id])).rows[0].state).toBe('released');
    });

    it('my_claims lists only the caller\'s claims, in a fixed column list with no maintainer account id; a non-member session gets none', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const other = await seedPayer(admin);
      const c = await claim(app, p, await addListing(admin, m));
      await claim(app, other, await addListing(admin, m));
      const mine = await withTenant(app, p.accountId, p.userId, (cl) => cl.query('SELECT * FROM my_claims()'));
      expect(mine.rows.map((r) => r.claim_id)).toEqual([c.claim_id]);
      expect(mine.fields.map((f) => f.name)).toEqual(['claim_id', 'listing_id', 'state', 'pr_number', 'spec_sha256', 'expires_at', 'merged_at', 'created_at']);
      const notMember = await withTenant(app, p.accountId, other.userId, (cl) => cl.query('SELECT * FROM my_claims()'));
      expect(notMember.rows).toEqual([]);
    });
  });

  describe('1b-9: claim controls under the listing lock', () => {
    it('claim_limit: a claimant with 3 active claims cannot take a 4th', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      for (let i = 0; i < 3; i++) await insertClaimPair(admin, m, p, await addListing(admin, m));
      expect((await raised(claim(app, p, await addListing(admin, m)))).message).toBe('claim_limit');
    });

    it('payer_claim_limit: a payer with 10 active claims refuses a member who has none', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const second = await addMember(admin, p.accountId, 'owner');
      for (let i = 0; i < 10; i++) await insertClaimPair(admin, m, p, await addListing(admin, m));
      expect((await raised(claim(app, { accountId: p.accountId, userId: second }, await addListing(admin, m)))).message).toBe('payer_claim_limit');
    });

    it('reclaim_cooldown: 24 h after a release or an expiry, and not after that', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const listing = await addListing(admin, m);
      const first = await claim(app, p, listing);
      await release(app, p, first.claim_id);
      expect((await raised(claim(app, p, listing))).message).toBe('reclaim_cooldown');
      await admin.query(`UPDATE task_claims SET updated_at = now() - interval '25 hours' WHERE id = $1`, [first.claim_id]);
      const second = await claim(app, p, listing);
      await admin.query(`UPDATE task_claims SET state = 'expired', expires_at = now() - interval '1 hour' WHERE id = $1`, [second.claim_id]);
      expect((await raised(claim(app, p, listing))).message).toBe('reclaim_cooldown');
      await admin.query(`UPDATE task_claims SET expires_at = now() - interval '25 hours' WHERE id = $1`, [second.claim_id]);
      await claim(app, p, listing);
    });

    it('a member of the payer account who is not an owner or admin, and an inactive payer, cannot claim', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const listing = await addListing(admin, m);
      const member = await addMember(admin, p.accountId, 'member');
      expect(await raised(claim(app, { accountId: p.accountId, userId: member }, listing))).toEqual({ code: 'P0002', message: 'not_found' });
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [p.accountId]);
      expect((await raised(claim(app, p, listing))).message).toBe('payer_not_active');
    });
  });

  it('a platform_ops login cannot use the definer as a way round the write guard', async () => {
    const m = await seedMaintainer(admin);
    const p = await seedPayer(admin);
    const listing = await addListing(admin, m);
    const c = await ops.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [p.accountId, p.userId]);
      await expect(c.query('SELECT * FROM claim_listing($1, 10, 1)', [listing])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(await counts(m.accountId, p.accountId)).toEqual({ claims: 0, fundings: 0, audit: 0 });
  });
});
