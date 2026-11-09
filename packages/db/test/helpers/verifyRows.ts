import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SeedRefs } from './seed.js';

/**
 * A verify row for an account's seeded repository, written as the superuser (`admin`), for a test that needs a deploy order to name a real row (migration 1005 made that a
 * foreign key). The row's work item is a fresh merged one; the row is pending with no journeys. Returns the row id.
 */
export async function seedVerifyRow(admin: Pick<PoolClient, 'query'>, who: Pick<SeedRefs, 'accountId' | 'repoId'>, over: { mergeSha?: string; prNumber?: number } = {}): Promise<string> {
  const item = randomUUID();
  await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [item, who.accountId, who.repoId]);
  const batch = await admin.query<{ id: string }>(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [who.accountId, who.repoId]);
  const row = await admin.query<{ id: string }>(
    `INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys) VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb) RETURNING id`,
    [who.accountId, who.repoId, batch.rows[0]!.id, item, over.prNumber ?? 1, over.mergeSha ?? randomUUID().replaceAll('-', '') + 'abcdef01'],
  );
  return row.rows[0]!.id;
}
