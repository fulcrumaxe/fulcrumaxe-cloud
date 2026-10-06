import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { withTenant } from '../src/withTenant.js';
import { addListing, claim, raised, seedMaintainer, seedPayer } from './helpers/board.js';

const DENIED = { code: PG_ERROR.INSUFFICIENT_PRIVILEGE };

// D#70 BRD-1b, 0664: 1b-11 (C3b), the merge-gating write hardening of the three claim tables.
describe('migration 0664: platform_ops write hardening (1b-11)', () => {
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

  async function world() {
    const m = await seedMaintainer(admin);
    const p = await seedPayer(admin);
    const c = await claim(app, p, await addListing(admin, m));
    const { rows: [t] } = await admin.query('SELECT * FROM task_claims WHERE id = $1', [c.claim_id]);
    return { m, p, claimId: c.claim_id as string, fundingId: t.funding_ref as string, listingId: t.listing_id as string };
  }

  it('item 1: platform_ops can UPDATE state and updated_at of a claim and a funding, and no other column', async () => {
    for (const table of ['task_claims', 'claim_fundings']) {
      const { rows } = await admin.query<{ column_name: string; ok: boolean }>(
        `SELECT column_name::text, has_column_privilege('platform_ops', $1, column_name::text, 'UPDATE') AS ok
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table],
      );
      expect(rows.filter((r) => r.ok).map((r) => r.column_name).sort(), table).toEqual(['state', 'updated_at']);
    }
  });

  describe('item 2: a direct platform_ops session writes nothing but a state-only update', () => {
    it('INSERT into each of the three tables fails, in any tenant, by the guard', async () => {
      const { m, p, claimId, listingId } = await world();
      const inserts: Array<[string, string, unknown[]]> = [
        ['task_claims', `INSERT INTO task_claims (account_id, listing_id, claimant_user_id, claimant_was_member, payer_account_ref, funding_ref, spec_sha256, expires_at)
                         VALUES ($1, $2, $3, false, $4, $5, 'x', now() + interval '1 day')`, [m.accountId, randomUUID(), p.userId, p.accountId, randomUUID()]],
        ['claim_fundings', `INSERT INTO claim_fundings (account_id, claim_ref, listing_ref, kind, cap_model_usd, cap_compute_usd) VALUES ($1, $2, $3, 'self', 1, 1)`,
          [p.accountId, claimId, listingId]],
        ['claim_attestations', `INSERT INTO claim_attestations (account_id, claim_id, head_sha, base_sha, kid, envelope) VALUES ($1, $2, 'h', 'b', 'k', '{}')`,
          [m.accountId, claimId]],
      ];
      for (const [table, sql, params] of inserts) {
        await expect(ops.query(sql, params), table).rejects.toMatchObject({ ...DENIED, message: expect.stringContaining('may not INSERT or UPDATE directly') });
      }
    });

    it('UPDATE of funding_ref, payer_account_ref or a raised cap fails; with the column grant widened, the identity freeze and the guard still refuse', async () => {
      const { p, claimId, fundingId } = await world();
      const identity: Array<[string, unknown[]]> = [
        ['UPDATE task_claims SET funding_ref = $1 WHERE id = $2', [randomUUID(), claimId]],
        ['UPDATE task_claims SET payer_account_ref = $1 WHERE id = $2', [randomUUID(), claimId]],
        ['UPDATE claim_fundings SET cap_model_usd = 9999 WHERE id = $1', [fundingId]],
        ['UPDATE claim_fundings SET cap_compute_usd = 9999 WHERE id = $1', [fundingId]],
      ];
      // Not identity columns: only the guard stands in the way once the grant is widened.
      const guarded: Array<[string, unknown[]]> = [
        [`UPDATE task_claims SET expires_at = now() + interval '900 days' WHERE id = $1`, [claimId]],
        ['UPDATE task_claims SET pr_number = 1 WHERE id = $1', [claimId]],
        [`UPDATE claim_fundings SET created_at = now() WHERE id = $1`, [fundingId]],
      ];
      for (const [sql, params] of [...identity, ...guarded]) await expect(ops.query(sql, params), sql).rejects.toMatchObject(DENIED);
      await admin.query('GRANT UPDATE ON task_claims, claim_fundings TO platform_ops');
      try {
        for (const [sql, params] of identity) {
          await expect(ops.query(sql, params), sql).rejects.toMatchObject({ ...DENIED, message: expect.stringContaining('set once') });
        }
        for (const [sql, params] of guarded) {
          await expect(ops.query(sql, params), sql).rejects.toMatchObject({ ...DENIED, message: expect.stringContaining('state and updated_at only') });
        }
      } finally {
        await admin.query('REVOKE UPDATE ON task_claims, claim_fundings FROM platform_ops');
        await admin.query('GRANT UPDATE (state, updated_at) ON task_claims, claim_fundings TO platform_ops');
      }
      const { rows: [f] } = await admin.query('SELECT cap_model_usd FROM claim_fundings WHERE id = $1', [fundingId]);
      expect(Number(f.cap_model_usd)).toBe(10);
      expect((await admin.query('SELECT payer_account_ref FROM task_claims WHERE id = $1', [claimId])).rows[0].payer_account_ref).toBe(p.accountId);
    });

    it('a state-only UPDATE succeeds, and may not leave a terminal state', async () => {
      const { claimId, fundingId } = await world();
      await ops.query(`UPDATE task_claims SET state = 'revoked', updated_at = now() WHERE id = $1`, [claimId]);
      await ops.query(`UPDATE claim_fundings SET state = 'closed', updated_at = now() WHERE id = $1`, [fundingId]);
      expect((await admin.query('SELECT state FROM task_claims WHERE id = $1', [claimId])).rows[0].state).toBe('revoked');
      await expect(ops.query(`UPDATE task_claims SET state = 'active' WHERE id = $1`, [claimId])).rejects.toMatchObject(DENIED);
      await expect(ops.query(`UPDATE claim_fundings SET state = 'active' WHERE id = $1`, [fundingId])).rejects.toMatchObject(DENIED);
    });

  });

  describe('item 3: identity columns are set once, for every role, the owner included', () => {
    const id = 'gen_random_uuid()';
    const claimCols = ['claimant_user_id', 'payer_account_ref', 'funding_ref', 'listing_id', 'id', 'account_id'].map((c) => [c, id]);
    const fundingCols = [['claim_ref', id], ['listing_ref', id], ['kind', `'sponsor'`], ['cap_model_usd', 'cap_model_usd + 1'],
      ['cap_compute_usd', 'cap_compute_usd + 1'], ['id', id], ['account_id', id]];
    it.each(claimCols)('task_claims.%s cannot change', async (col, expr) => {
      const { claimId } = await world();
      const e = await raised(admin.query(`UPDATE task_claims SET ${col} = ${expr} WHERE id = $1`, [claimId]));
      expect(e).toEqual({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: 'task_claims: identity columns are set once' });
    });
    it.each(fundingCols)('claim_fundings.%s cannot change', async (col, expr) => {
      const { fundingId } = await world();
      const e = await raised(admin.query(`UPDATE claim_fundings SET ${col} = ${expr} WHERE id = $1`, [fundingId]));
      expect(e).toEqual({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: 'claim_fundings: identity columns and caps are set once' });
    });
    it('state, expires_at and updated_at can still change', async () => {
      const { claimId, fundingId } = await world();
      await admin.query(`UPDATE task_claims SET state = 'in_review', pr_number = 3, expires_at = now() + interval '1 hour', updated_at = now() WHERE id = $1`, [claimId]);
      await admin.query(`UPDATE claim_fundings SET state = 'closed', updated_at = now() WHERE id = $1`, [fundingId]);
    });
  });
  describe('1b-12: a listing id is unique and app_user never chooses or changes it', () => {
    it('a second row with an existing id fails 23505, across accounts and within one', async () => {
      const a = await seedMaintainer(admin);
      const b = await seedMaintainer(admin);
      const listing = await addListing(admin, a);
      for (const m of [b, a]) {
        await expect(admin.query(
          `INSERT INTO board_listings (account_id, id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope)
           VALUES ($1, $2, $3, $4, 'public', 'x', 's', ARRAY['a'])`, [m.accountId, listing, m.workItemId, m.repoId]))
          .rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      }
    });

    it('as app_user: naming or updating id fails 42501; an insert without id and an update of state succeed', async () => {
      const m = await seedMaintainer(admin);
      const own = await addListing(admin, m);
      const inTenant = <T,>(fn: (c: PoolClient) => Promise<T>) => withTenant(app, m.accountId, m.userId, fn);
      const cols = 'account_id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope';
      const vals = `$1, $2, $3, 'public', 'x', 's', ARRAY['a']`;
      await expect(inTenant((c) => c.query(`INSERT INTO board_listings (id, ${cols}) VALUES (gen_random_uuid(), ${vals})`, [m.accountId, m.workItemId, m.repoId])))
        .rejects.toMatchObject(DENIED);
      for (const col of ['id', 'account_id', 'created_at']) {
        const value = col === 'created_at' ? 'now()' : 'gen_random_uuid()';
        await expect(inTenant((c) => c.query(`UPDATE board_listings SET ${col} = ${value} WHERE id = $1`, [own])), col).rejects.toMatchObject(DENIED);
      }
      const inserted = await inTenant((c) => c.query(`INSERT INTO board_listings (${cols}) VALUES (${vals}) RETURNING id`, [m.accountId, m.workItemId, m.repoId]));
      expect(inserted.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
      await inTenant((c) => c.query(`UPDATE board_listings SET state = 'unlisted' WHERE id = $1`, [own]));
    });
  });
});
