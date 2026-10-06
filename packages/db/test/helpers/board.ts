import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../../src/withTenant.js';
import { seedAccount, type SeedRefs } from './seed.js';

const hex = () => randomUUID().replace(/-/g, '').slice(0, 12);

export interface BoardWorld extends SeedRefs {
  fullName: string;
}

/** A maintainer account whose repo is named `<owner>/<name>`, with an enabled board and a titled work item. */
export async function seedMaintainer(admin: PoolClient, enabled = true, ttlHours = 72): Promise<BoardWorld> {
  const refs = await seedAccount(admin, randomUUID());
  const owner = `o${hex()}`;
  const name = `r-${hex()}`;
  await admin.query('UPDATE repos SET gh_repo_id = $1, gh_owner = $2, gh_name = $3 WHERE id = $4', [
    Math.floor(Math.random() * 1e12) + 10, owner, name, refs.repoId,
  ]);
  await admin.query(`UPDATE work_items SET title = 'Canary title' WHERE id = $1`, [refs.workItemId]);
  await admin.query('INSERT INTO board_repo_settings (account_id, repo_id, enabled, claim_ttl_hours) VALUES ($1, $2, $3, $4)', [
    refs.accountId, refs.repoId, enabled, ttlHours,
  ]);
  return { ...refs, fullName: `${owner}/${name}` };
}

export async function addListing(
  admin: PoolClient, m: SeedRefs, over: { visibility?: string; state?: string; itemKind?: string | null } = {},
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO board_listings (account_id, work_item_id, repo_id, visibility, state, spec_sha256, spec_snapshot, file_scope, item_kind)
     VALUES ($1, $2, $3, $4, $5, $6, 'the spec', ARRAY['src/'], $7) RETURNING id`,
    [m.accountId, m.workItemId, m.repoId, over.visibility ?? 'public', over.state ?? 'listed', 'a'.repeat(64),
     over.itemKind === undefined ? 'feature' : over.itemKind],
  );
  return rows[0].id;
}

/** A payer account whose seeded user is its owner; the user has a GitHub login. */
export async function seedPayer(admin: PoolClient): Promise<SeedRefs> {
  const refs = await seedAccount(admin, randomUUID());
  await admin.query('UPDATE users SET github_login = $1 WHERE id = $2', [`gh-${hex()}`, refs.userId]);
  return refs;
}

export async function addMember(admin: PoolClient, accountId: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
  const userId = randomUUID();
  await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
  await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
  return userId;
}

export const claim = (pool: Pool, payer: { accountId: string; userId: string }, listingId: string, model: number | string = 10, compute: number | string = 1) =>
  withTenant(pool, payer.accountId, payer.userId, async (c) =>
    (await c.query('SELECT * FROM claim_listing($1, $2::numeric, $3::numeric)', [listingId, model, compute])).rows[0] as { claim_id: string; expires_at: Date });

export const release = (pool: Pool, who: { accountId: string; userId: string }, claimId: string) =>
  withTenant(pool, who.accountId, who.userId, (c) => c.query('SELECT release_claim($1)', [claimId]));
/** The error a call raised, as {code, message}; fails the test if it did not raise. */
export async function raised(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const { code, message } = e as { code: string; message: string };
    return { code, message };
  }
  throw new Error('expected the call to raise');
}

/** Inserts a claim and its funding directly (superuser), for states the definers do not produce. */
type PairOver = { claimState?: string; fundingState?: string; expiresInHours?: number; claimRef?: string; listingRef?: string;
  claimantId?: string; fundingRefOnClaim?: string; fundingAccount?: string };
export async function insertClaimPair(admin: PoolClient, m: SeedRefs, payer: SeedRefs, listingId: string, over: PairOver = {}) {
  const claimId = randomUUID();
  const fundingId = randomUUID();
  await admin.query(
    `INSERT INTO claim_fundings (account_id, id, claim_ref, listing_ref, kind, cap_model_usd, cap_compute_usd, state)
     VALUES ($1, $2, $3, $4, 'self', 10, 1, $5)`,
    [over.fundingAccount ?? payer.accountId, fundingId, over.claimRef ?? claimId, over.listingRef ?? listingId, over.fundingState ?? 'active'],
  );
  await admin.query(
    `INSERT INTO task_claims (account_id, id, listing_id, claimant_user_id, claimant_was_member, payer_account_ref,
                              funding_ref, spec_sha256, state, expires_at)
     VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8, now() + make_interval(hours => $9::int))`,
    [m.accountId, claimId, listingId, over.claimantId ?? payer.userId, payer.accountId, over.fundingRefOnClaim ?? fundingId,
     'a'.repeat(64), over.claimState ?? 'active', over.expiresInHours ?? 24],
  );
  return { claimId, fundingId };
}
