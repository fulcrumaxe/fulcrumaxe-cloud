import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

// D#70 BRD-1a, 0657: C-1 grants, C-2 function privileges, 1a-7 append-only attestations.
describe('migration 0657: board grants and append-only attestations', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refs: SeedRefs;
  let claimId: string;
  let attestationId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
    const listingId = randomUUID();
    claimId = randomUUID();
    attestationId = randomUUID();
    await admin.query(
      `INSERT INTO board_listings (account_id, id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope)
       VALUES ($1, $2, $3, $4, 'team', 'x', 's', ARRAY['a'])`,
      [refs.accountId, listingId, refs.workItemId, refs.repoId],
    );
    await admin.query(
      `INSERT INTO task_claims (account_id, id, listing_id, claimant_user_id, claimant_was_member, payer_account_ref,
                                funding_ref, spec_sha256, expires_at)
       VALUES ($1, $2, $3, $4, true, $1, $5, 'x', now() + interval '1 day')`,
      [refs.accountId, claimId, listingId, refs.userId, randomUUID()],
    );
    await admin.query(
      `INSERT INTO claim_attestations (account_id, id, claim_id, head_sha, base_sha, kid, envelope) VALUES ($1, $2, $3, 'h', 'b', 'k', '{}')`,
      [refs.accountId, attestationId, claimId],
    );
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  it('C-1: app_user holds SELECT and nothing else on the three claim tables', async () => {
    for (const table of ['task_claims', 'claim_fundings', 'claim_attestations']) {
      const { rows } = await admin.query<{ p: string; ok: boolean }>(
        `SELECT p, has_table_privilege('app_user', $1, p) AS ok
           FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p`,
        [table],
      );
      expect(rows.filter((r) => r.ok).map((r) => r.p), table).toEqual(['SELECT']);
    }
  });

  it('C-2: the two trigger functions are not executable by PUBLIC, app_user or partner_user', async () => {
    const { rows } = await admin.query<{ proname: string; app_user: boolean; partner_user: boolean; public_: boolean }>(
      `SELECT p.proname,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
              has_function_privilege('partner_user', p.oid, 'EXECUTE') AS partner_user,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('board_repo_settings_set_gh_repo_id', 'claim_attestations_append_only')
        ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['board_repo_settings_set_gh_repo_id', 'claim_attestations_append_only']);
    for (const r of rows) expect(r, r.proname).toMatchObject({ app_user: false, partner_user: false, public_: false });
  });

  describe('1a-7: claim_attestations is append-only', () => {
    it('as app_user, UPDATE and DELETE fail 42501 and the row is unchanged', async () => {
      for (const sql of [
        `UPDATE claim_attestations SET kid = 'z' WHERE id = $1`,
        `DELETE FROM claim_attestations WHERE id = $1`,
      ]) {
        await expect(
          withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(sql, [attestationId])),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('in a direct platform_ops session, UPDATE and DELETE fail', async () => {
      for (const sql of [
        `UPDATE claim_attestations SET kid = 'z' WHERE id = $1`,
        `DELETE FROM claim_attestations WHERE id = $1`,
      ]) {
        await expect(platformOpsPool.query(sql, [attestationId])).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
    });

    it('the trigger refuses UPDATE and DELETE even for the table owner, which holds every grant', async () => {
      for (const sql of [
        `UPDATE claim_attestations SET kid = 'z' WHERE id = $1`,
        `DELETE FROM claim_attestations WHERE id = $1`,
      ]) {
        await expect(admin.query(sql, [attestationId]), sql).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          message: expect.stringContaining('append-only'),
        });
      }
      const { rows } = await admin.query('SELECT kid FROM claim_attestations WHERE id = $1', [attestationId]);
      expect(rows).toEqual([{ kid: 'k' }]);
    });
  });
});
