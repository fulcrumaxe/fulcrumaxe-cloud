import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { addListing, claim, raised, release, seedMaintainer, seedPayer } from './helpers/board.js';

// D#70 BRD-1b, 0664: 1b-3 (uniform not-found, C-3) and 1b-4 (the public reader, C-4).
describe('migration 0664: board oracle and public listings', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await app.end();
  });

  const NOT_FOUND = { code: 'P0002', message: 'not_found' };

  describe('1b-3: not-found is one answer', () => {
    it('a random id, an unlisted listing, a private team listing, a disabled board and another claimant\'s claim all look the same', async () => {
      const m = await seedMaintainer(admin);
      const off = await seedMaintainer(admin, false);
      const p = await seedPayer(admin);
      const other = await seedPayer(admin);
      const own = await claim(app, other, await addListing(admin, m));
      const probes = [
        randomUUID(),
        await addListing(admin, m, { state: 'unlisted' }),
        await addListing(admin, m, { visibility: 'team' }),
        await addListing(admin, off),
        own.claim_id,
      ];
      for (const id of probes) {
        expect(await raised(claim(app, p, id)), `claim_listing ${id}`).toEqual(NOT_FOUND);
        expect(await raised(release(app, p, id)), `release_claim ${id}`).toEqual(NOT_FOUND);
      }
    });

    it('a team listing is visible to a member of the maintainer account only', async () => {
      const m = await seedMaintainer(admin);
      const listing = await addListing(admin, m, { visibility: 'team' });
      const outsider = await seedPayer(admin);
      expect(await raised(claim(app, outsider, listing))).toEqual(NOT_FOUND);
      const c = await claim(app, { accountId: m.accountId, userId: m.userId }, listing);
      expect((await admin.query('SELECT claimant_was_member FROM task_claims WHERE id = $1', [c.claim_id])).rows[0].claimant_was_member).toBe(true);
    });

    it('a session whose user is real but not a member of the account gets not-found, and my_claims is empty (C-3)', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const stranger = await seedPayer(admin);
      const c = await claim(app, p, await addListing(admin, m));
      const forged = { accountId: p.accountId, userId: stranger.userId };
      expect(await raised(claim(app, forged, await addListing(admin, m)))).toEqual(NOT_FOUND);
      expect(await raised(release(app, forged, c.claim_id))).toEqual(NOT_FOUND);
      expect((await withTenant(app, forged.accountId, forged.userId, (cl) => cl.query('SELECT * FROM my_claims()'))).rows).toEqual([]);
      // A user who is a member elsewhere, presented with an account they do not belong to.
      const wrongAccount = { accountId: stranger.accountId, userId: p.userId };
      expect(await raised(release(app, wrongAccount, c.claim_id))).toEqual(NOT_FOUND);
    });
  });

  describe('1b-4: board_public_listings (C-4)', () => {
    const list = (name: string) =>
      withTenant(app, randomUUID(), (c) => c.query('SELECT * FROM board_public_listings($1)', [name]));

    it('returns public, listed listings of an enabled board, in the fixed column list, with claim state, login, PR and attestation', async () => {
      const m = await seedMaintainer(admin);
      const p = await seedPayer(admin);
      const free = await addListing(admin, m);
      await addListing(admin, m, { visibility: 'team' });
      await addListing(admin, m, { state: 'unlisted' });
      const claimed = await claim(app, p, await addListing(admin, m, { itemKind: 'small' }));
      await admin.query(`UPDATE task_claims SET state = 'in_review', pr_number = 7 WHERE id = $1`, [claimed.claim_id]);
      const att = randomUUID();
      await admin.query(`INSERT INTO claim_attestations (account_id, id, claim_id, head_sha, base_sha, kid, envelope) VALUES ($1, $2, $3, 'h', 'b', 'k', '{}')`,
        [m.accountId, att, claimed.claim_id]);
      const { rows, fields } = await list(m.fullName);
      expect(fields.map((f) => f.name)).toEqual(['listing_id', 'full_name', 'title', 'spec_snapshot', 'file_scope', 'item_kind',
        'claim_state', 'claimant_login', 'pr_number', 'attestation_id']);
      expect(rows).toHaveLength(2);
      const login = (await admin.query('SELECT github_login FROM users WHERE id = $1', [p.userId])).rows[0].github_login;
      expect(rows.find((r) => r.listing_id === free)).toMatchObject({ full_name: m.fullName, title: 'Canary title', spec_snapshot: 'the spec',
        file_scope: ['src/'], claim_state: null, claimant_login: null, attestation_id: null });
      expect(rows.find((r) => r.item_kind === 'small')).toMatchObject({ claim_state: 'in_review', claimant_login: login, pr_number: '7', attestation_id: att });
      const text = JSON.stringify(rows);
      for (const secret of [m.accountId, p.accountId, p.userId]) expect(text).not.toContain(secret);
    });

    it('resolves the name case-insensitively: a mixed-case name returns the same rows', async () => {
      const m = await seedMaintainer(admin);
      await addListing(admin, m);
      const canonical = (await list(m.fullName)).rows;
      const [owner, name] = m.fullName.split('/');
      expect(canonical).toHaveLength(1);
      expect((await list(`${owner.toUpperCase()}/${name.toUpperCase()}`)).rows).toEqual(canonical);
      expect((await list(`${owner}/${name}x`)).rows).toEqual([]);
    });

    it('returns nothing for a disabled board, even when another account holds the same name', async () => {
      const off = await seedMaintainer(admin, false);
      await addListing(admin, off);
      expect((await list(off.fullName)).rows).toEqual([]);
      const on = await seedMaintainer(admin);
      await addListing(admin, on);
      const [owner, name] = off.fullName.split('/');
      await admin.query('UPDATE repos SET gh_owner = $1, gh_name = $2 WHERE id = $3', [owner, name, on.repoId]);
      expect((await list(off.fullName)).rows).toHaveLength(1);
    });

    it('returns nothing unless exactly one enabled repo matches the name', async () => {
      const a = await seedMaintainer(admin);
      const b = await seedMaintainer(admin);
      await addListing(admin, a);
      await addListing(admin, b);
      const [owner, name] = a.fullName.split('/');
      await admin.query('UPDATE repos SET gh_owner = $1, gh_name = $2 WHERE id = $3', [owner, name, b.repoId]);
      expect((await list(a.fullName)).rows).toEqual([]);
    });

    it('an active claim past its expiry shows as unclaimed, with no claimant', async () => {
      const m = await seedMaintainer(admin);
      const listing = await addListing(admin, m);
      const c = await claim(app, await seedPayer(admin), listing);
      await admin.query(`UPDATE task_claims SET expires_at = now() - interval '1 minute' WHERE id = $1`, [c.claim_id]);
      expect((await list(m.fullName)).rows[0]).toMatchObject({ claim_state: null, claimant_login: null });
    });
  });
  describe('a listing id held by two accounts fails closed (defence behind board_listings_id_key)', () => {
    it.each([['public'], ['team']])('a %s squat: not_found, and no claim or funding in either account', async (visibility) => {
      const a = await seedMaintainer(admin);
      const b = await seedMaintainer(admin);
      const payer = await seedPayer(admin);
      const listing = await addListing(admin, a, { visibility });
      // The public squat is claimed by a third party, the team squat by the squatter's own member.
      const caller = visibility === 'public' ? payer : { accountId: b.accountId, userId: b.userId };
      await admin.query('BEGIN');
      try {
        await admin.query('DROP INDEX board_listings_id_key');
        await admin.query(
          `INSERT INTO board_listings (account_id, id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope)
           VALUES ($1, $2, $3, $4, $5, 'x', 'b spec', ARRAY['a'])`, [b.accountId, listing, b.workItemId, b.repoId, visibility]);
        await admin.query('SAVEPOINT s');
        await admin.query('SET LOCAL ROLE app_user');
        await admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [caller.accountId, caller.userId]);
        expect(await raised(admin.query('SELECT * FROM claim_listing($1, 10, 1)', [listing]))).toEqual(NOT_FOUND);
        await admin.query('ROLLBACK TO SAVEPOINT s');
        await admin.query('RESET ROLE');
        const { rows } = await admin.query(
          `SELECT (SELECT count(*)::int FROM task_claims WHERE account_id = ANY($1)) AS claims,
                  (SELECT count(*)::int FROM claim_fundings WHERE account_id = ANY($1)) AS fundings`,
          [[a.accountId, b.accountId, payer.accountId]]);
        expect(rows[0]).toEqual({ claims: 0, fundings: 0 });
      } finally {
        await admin.query('ROLLBACK');
      }
    });
  });

  it('a direct platform_ops login reads no work_items.title, even for a public listed item', async () => {
    const m = await seedMaintainer(admin);
    await addListing(admin, m);
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      expect((await ops.query('SELECT title FROM work_items WHERE id = $1', [m.workItemId])).rows).toEqual([]);
    } finally {
      await ops.end();
    }
  });
});
