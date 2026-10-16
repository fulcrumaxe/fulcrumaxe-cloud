import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

/** D#600 CX-3a: the repository map cache (migration 0807). Real Postgres, row security forced. */
describe('migration 0807: repo_context_maps', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;

  const put = (accountId: string, repoId: string, sha = SHA, body = 'commit: aaaaaaaaaaaa') =>
    withTenant(appPool, accountId, randomUUID(), (c) =>
      c.query(
        `INSERT INTO repo_context_maps (account_id, repo_id, commit_sha, map_version, body, body_sha256) VALUES ($1, $2, $3, '1', $4, $5)
         ON CONFLICT (account_id, repo_id) DO UPDATE SET commit_sha = EXCLUDED.commit_sha, body = EXCLUDED.body, body_sha256 = EXCLUDED.body_sha256`,
        [accountId, repoId, sha, body, HASH],
      ),
    );
  const count = (repoId: string) => admin.query('SELECT 1 FROM repo_context_maps WHERE repo_id = $1', [repoId]).then((r) => r.rowCount);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('keeps one row per repository: a map for another commit replaces the first', async () => {
    await put(a.accountId, a.repoId, SHA);
    await put(a.accountId, a.repoId, 'c'.repeat(40), 'commit: cccccccccccc');
    const rows = await admin.query('SELECT commit_sha, body FROM repo_context_maps WHERE repo_id = $1', [a.repoId]);
    expect(rows.rows).toEqual([{ commit_sha: 'c'.repeat(40), body: 'commit: cccccccccccc' }]);
  });

  it('AC (RLS): an account-B session reads no row of account A, cannot write one for A, and cannot delete it', async () => {
    await put(a.accountId, a.repoId);
    const seen = await withTenant(appPool, b.accountId, randomUUID(), (c) => c.query('SELECT 1 FROM repo_context_maps'));
    expect(seen.rowCount).toBe(0);
    await expect(put(b.accountId, a.repoId)).rejects.toMatchObject({ code: '23503' });
    await expect(withTenant(appPool, b.accountId, randomUUID(), (c) => c.query('INSERT INTO repo_context_maps (account_id, repo_id, commit_sha, map_version, body, body_sha256) VALUES ($1, $2, $3, $4, $5, $6)', [a.accountId, a.repoId, SHA, '1', 'x', HASH]))).rejects.toMatchObject({ code: '42501' });
    const del = await withTenant(appPool, b.accountId, randomUUID(), (c) => c.query('DELETE FROM repo_context_maps WHERE repo_id = $1', [a.repoId]));
    expect(del.rowCount).toBe(0);
    expect(await count(a.repoId)).toBe(1);
    // Account A reads and deletes its own.
    expect((await withTenant(appPool, a.accountId, randomUUID(), (c) => c.query('SELECT 1 FROM repo_context_maps'))).rowCount).toBe(1);
  });

  it('refuses a body over 8192 bytes, an empty body, a malformed commit or hash, and a version that is not digits', async () => {
    const insert = (sha: string, ver: string, body: string, hash = HASH) =>
      admin.query('INSERT INTO repo_context_maps (account_id, repo_id, commit_sha, map_version, body, body_sha256) VALUES ($1, $2, $3, $4, $5, $6)', [a.accountId, a.repoId, sha, ver, body, hash]);
    await admin.query('DELETE FROM repo_context_maps WHERE repo_id = $1', [a.repoId]);
    await expect(insert(SHA, '1', 'x'.repeat(8193))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(SHA, '1', '')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('nope', '1', 'x')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(SHA, 'v1', 'x')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(SHA, '1', 'x', 'short')).rejects.toMatchObject({ code: '23514' });
    await insert(SHA, '1', 'x'.repeat(8192)); // exactly the cap is fine
    expect(await count(a.repoId)).toBe(1);
  });

  it('is deleted with its repository, and platform_ops can read and write nothing in it', async () => {
    await put(b.accountId, b.repoId);
    expect(await count(b.repoId)).toBe(1);
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query('SELECT 1 FROM repo_context_maps')).rejects.toMatchObject({ code: '42501' });
      await expect(ops.query('DELETE FROM repo_context_maps')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
    await admin.query('DELETE FROM repos WHERE id = $1', [b.repoId]);
    expect(await count(b.repoId)).toBe(0);
  });
});
