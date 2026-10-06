import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

// D#70 BRD-1a, 0657: table shape (1a-1, 1a-3, 1a-4, 1a-6, 1a-8, 1a-9), written as the superuser.
describe('migration 0657: contributor board schema', () => {
  let adminPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  /** A seeded account whose repo has a gh_repo_id of its own (seedAccount gives every repo the same one). */
  async function seedBoard(): Promise<SeedRefs & { listingId: string; ghRepoId: number }> {
    const refs = await seedAccount(admin, randomUUID());
    const ghRepoId = Math.floor(Math.random() * 1e12) + 10;
    await admin.query('UPDATE repos SET gh_repo_id = $1 WHERE id = $2', [ghRepoId, refs.repoId]);
    const listingId = randomUUID();
    await admin.query(
      `INSERT INTO board_listings (account_id, id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope)
       VALUES ($1, $2, $3, $4, 'public', $5, 'spec', ARRAY['src/'])`,
      [refs.accountId, listingId, refs.workItemId, refs.repoId, 'a'.repeat(64)],
    );
    return { ...refs, listingId, ghRepoId };
  }

  const insertFunding = async (accountId: string): Promise<string> => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO claim_fundings (account_id, id, claim_ref, listing_ref, kind, cap_model_usd, cap_compute_usd)
       VALUES ($1, $2, $3, $4, 'self', 10, 5)`,
      [accountId, id, randomUUID(), randomUUID()],
    );
    return id;
  };

  const insertClaim = (b: { accountId: string; userId: string; listingId: string }, state: string) =>
    admin.query(
      `INSERT INTO task_claims (account_id, listing_id, claimant_user_id, claimant_was_member, payer_account_ref,
                                funding_ref, spec_sha256, state, expires_at)
       VALUES ($1, $2, $3, true, $1, $4, $5, $6, now() + interval '72 hours')`,
      [b.accountId, b.listingId, b.userId, randomUUID(), 'a'.repeat(64), state],
    );

  it('1a-1: all five tables, the funding columns and env_digest exist', async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`,
      [['board_repo_settings', 'board_listings', 'task_claims', 'claim_attestations', 'claim_fundings']],
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'board_listings',
      'board_repo_settings',
      'claim_attestations',
      'claim_fundings',
      'task_claims',
    ]);
    const { rows: cols } = await admin.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
         AND ((table_name IN ('ledger', 'spend_reservations') AND column_name IN ('funding_id', 'claimed_run_ref'))
           OR (table_name = 'agent_runs' AND column_name = 'env_digest'))`,
    );
    expect(cols).toHaveLength(5);
  });

  describe('1a-3: payer-side row shape', () => {
    const cases: Array<[string, string, string]> = [
      ['spend_reservations', 'usd_reserved, state', "1, 'open'"],
      ['ledger', 'kind, source, usd', "'compute', 'sandbox', 1"],
    ];
    it.each(cases)(
      '%s: run_id with funding_id, funding_id alone and claimed_run_ref alone all fail; a well-formed funded row passes',
      async (table, cols, vals) => {
        const b = await seedBoard();
        const fundingId = await insertFunding(b.accountId);
        const ins = (extraCols: string, extra: unknown[]) =>
          admin.query(
            `INSERT INTO ${table} (account_id, ${cols}, ${extraCols})
             VALUES ($1, ${vals}, ${extra.map((_, i) => `$${i + 2}`).join(', ')})`,
            [b.accountId, ...extra],
          );
        await expect(ins('funding_id, claimed_run_ref, run_id', [fundingId, randomUUID(), b.runId])).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
        await expect(ins('funding_id', [fundingId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        await expect(ins('claimed_run_ref', [randomUUID()])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        await expect(ins('funding_id, claimed_run_ref', [fundingId, randomUUID()])).resolves.toBeDefined();
      },
    );
  });

  it('1a-4: a spend_reservations row in account B cannot name a claim_fundings row of account A', async () => {
    const a = await seedBoard();
    const b = await seedBoard();
    const fundingOfA = await insertFunding(a.accountId);
    await expect(
      admin.query(
        `INSERT INTO spend_reservations (account_id, usd_reserved, state, funding_id, claimed_run_ref) VALUES ($1, 1, 'open', $2, $3)`,
        [b.accountId, fundingOfA, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
  });

  it('1a-6: a second active or in_review claim on one listing fails; a new one after a release succeeds', async () => {
    const b = await seedBoard();
    await insertClaim(b, 'active');
    await expect(insertClaim(b, 'active')).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await expect(insertClaim(b, 'in_review')).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await admin.query(`UPDATE task_claims SET state = 'released' WHERE listing_id = $1`, [b.listingId]);
    await expect(insertClaim(b, 'active')).resolves.toBeDefined();
  });

  it('1a-8: claim_ttl_hours accepts 4 and 72, refuses 3 and 73, and defaults to 72', async () => {
    const b = await seedBoard();
    await admin.query('INSERT INTO board_repo_settings (account_id, repo_id) VALUES ($1, $2)', [b.accountId, b.repoId]);
    const set = (hours: number) =>
      admin.query('UPDATE board_repo_settings SET claim_ttl_hours = $1 WHERE account_id = $2', [hours, b.accountId]);
    const read = async () =>
      (await admin.query('SELECT claim_ttl_hours FROM board_repo_settings WHERE account_id = $1', [b.accountId])).rows[0]
        .claim_ttl_hours;
    expect(await read()).toBe(72);
    await expect(set(3)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(set(73)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await set(4);
    expect(await read()).toBe(4);
    await set(72);
    expect(await read()).toBe(72);
  });

  describe('1a-9: gh_repo_id', () => {
    it('two accounts with a repo of the same gh_repo_id cannot both enable a board; both can be disabled', async () => {
      const a = await seedBoard();
      const b = await seedBoard();
      await admin.query('UPDATE repos SET gh_repo_id = $1 WHERE id = $2', [a.ghRepoId, b.repoId]);
      const ins = (x: SeedRefs, enabled: boolean) =>
        admin.query('INSERT INTO board_repo_settings (account_id, repo_id, enabled) VALUES ($1, $2, $3)', [
          x.accountId,
          x.repoId,
          enabled,
        ]);
      await ins(a, true);
      await expect(ins(b, true)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(ins(b, false)).resolves.toBeDefined();
      await expect(
        admin.query('UPDATE board_repo_settings SET enabled = true WHERE account_id = $1', [b.accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('a wrong caller-supplied gh_repo_id is overwritten on INSERT and on UPDATE', async () => {
      const a = await seedBoard();
      await admin.query('INSERT INTO board_repo_settings (account_id, repo_id, gh_repo_id) VALUES ($1, $2, 999)', [
        a.accountId,
        a.repoId,
      ]);
      const read = async () =>
        Number(
          (await admin.query('SELECT gh_repo_id FROM board_repo_settings WHERE account_id = $1', [a.accountId])).rows[0]
            .gh_repo_id,
        );
      expect(await read()).toBe(a.ghRepoId);
      await admin.query('UPDATE board_repo_settings SET gh_repo_id = 1000 WHERE account_id = $1', [a.accountId]);
      expect(await read()).toBe(a.ghRepoId);
    });
  });
});
