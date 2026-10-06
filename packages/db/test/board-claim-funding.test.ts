import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import type { SeedRefs } from './helpers/seed.js';
import { addListing, addMember, claim, insertClaimPair, seedMaintainer, seedPayer } from './helpers/board.js';

// D#70 BRD-1b, 0664: 1b-7 (both sides of the funding binding, C-1 b) and the funding half of 1b-8 (C-7).
describe('migration 0664: claim_funding_for_run', () => {
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

  /** The funding a platform_ops login gets for the maintainer's seeded run. */
  const fundingFor = async (runId: string) =>
    (await ops.query('SELECT * FROM claim_funding_for_run($1)', [runId])).rows;

  it('returns the payer, funding and caps for a claim made through claim_listing', async () => {
    const m = await seedMaintainer(admin);
    const p = await seedPayer(admin);
    const c = await claim(app, p, await addListing(admin, m), 12, 3);
    const rows = await fundingFor(m.runId);
    expect(rows).toEqual([{ funding_id: expect.any(String), payer_ref: p.accountId, claim_id: c.claim_id, cap_model_usd: '12.0000', cap_compute_usd: '3.0000' }]);
    expect((await admin.query('SELECT funding_ref FROM task_claims WHERE id = $1', [c.claim_id])).rows[0].funding_ref).toBe(rows[0].funding_id);
  });

  it('returns nothing for an unknown run and for a listed work item nobody claimed', async () => {
    const m = await seedMaintainer(admin);
    await addListing(admin, m);
    expect(await fundingFor(randomUUID())).toEqual([]);
    expect(await fundingFor(m.runId)).toEqual([]);
  });

  it('a claim in review still funds; the other states, and an active claim past expiry, do not', async () => {
    const cases: Array<[string, number, boolean]> = [['in_review', 24, true], ['active', 24, true], ['active', -1, false],
      ['merged', 24, false], ['released', 24, false], ['revoked', 24, false], ['expired', 24, false], ['failed', 24, false]];
    for (const [claimState, expiresInHours, funded] of cases) {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      await insertClaimPair(admin, m, p, await addListing(admin, m), { claimState, expiresInHours });
      expect((await fundingFor(m.runId)).length, `${claimState} ${expiresInHours}`).toBe(funded ? 1 : 0);
    }
  });

  describe('each broken link between the tenants fails closed', () => {
    const cases: Array<[string, (m: SeedRefs, p: SeedRefs, other: SeedRefs, listing: string) => Parameters<typeof insertClaimPair>[4]]> = [
      ['claim_ref names another claim', () => ({ claimRef: randomUUID() })],
      ['listing_ref names another listing', () => ({ listingRef: randomUUID() })],
      ['the funding is closed', () => ({ fundingState: 'closed' })],
      ['funding_ref names a funding in another account', (_m, _p, other) => ({ fundingAccount: other.accountId })],
    ];
    it.each(cases)('%s', async (_name, over) => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const other = await seedPayer(admin);
      const listing = await addListing(admin, m);
      await insertClaimPair(admin, m, p, listing, over(m, p, other, listing));
      expect(await fundingFor(m.runId)).toEqual([]);
    });

    it('funding_ref names another claim\'s funding (C-1 b)', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const victim = await seedPayer(admin);
      const otherListing = await addListing(admin, m);
      const theirs = await insertClaimPair(admin, m, victim, otherListing, { claimState: 'released' });
      await insertClaimPair(admin, m, p, await addListing(admin, m), { fundingRefOnClaim: theirs.fundingId });
      expect(await fundingFor(m.runId)).toEqual([]);
    });
  });

  describe('the payer can stop its own spend (C-7)', () => {
    it('a payer that is no longer active funds nothing', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      await claim(app, p, await addListing(admin, m));
      expect(await fundingFor(m.runId)).toHaveLength(1);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [p.accountId]);
      expect(await fundingFor(m.runId)).toEqual([]);
    });

    it('a claimant removed from the payer account, or demoted to member, funds nothing', async () => {
      for (const demote of [false, true]) {
        const m = await seedMaintainer(admin);
        const p = await seedPayer(admin);
        const claimant = await addMember(admin, p.accountId, 'admin');
        await claim(app, { accountId: p.accountId, userId: claimant }, await addListing(admin, m));
        expect(await fundingFor(m.runId)).toHaveLength(1);
        await admin.query(demote ? `UPDATE account_members SET role = 'member' WHERE user_id = $1` : 'DELETE FROM account_members WHERE user_id = $1', [claimant]);
        expect(await fundingFor(m.runId), demote ? 'demoted' : 'removed').toEqual([]);
      }
    });

    it('a claim revoked by a direct state-only update funds nothing', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const c = await claim(app, p, await addListing(admin, m));
      await ops.query(`UPDATE task_claims SET state = 'revoked', updated_at = now() WHERE id = $1`, [c.claim_id]);
      expect(await fundingFor(m.runId)).toEqual([]);
    });
  });
});
