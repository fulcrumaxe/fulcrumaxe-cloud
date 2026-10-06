import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#123 item 1 (CWE-732/269, #116): app_user has table-wide UPDATE on
 * work_items, so provenance can change from external to internal after
 * insert -- unsafe now that provenance controls auto-merge. C26 assigns
 * the fix to H13a (its own INSERT, body criterion 2, makes it the first
 * real writer). Migration:
 * packages/db/migrations/0613_work_items_provenance_set_once.sql, which
 * also grants platform_ops SELECT on installations/repos (H13a's own
 * webhook-time tenant resolution need) -- covered together here.
 *
 * Failing-first: before 0613 existed, `UPDATE work_items SET provenance
 * = 'internal'` as app_user succeeded (0001_core.sql's table-wide
 * GRANT), and platform_ops had no read access to either table at all.
 */
describe('migration 0613: provenance set-once + platform_ops installations/repos read (D#123 item 1, D#2 H13a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  it("as app_user, UPDATE work_items SET provenance='internal' on an external row fails with 42501, and leaves the row untouched", async () => {
    const workItemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'external')`, [
      workItemId,
      refs.accountId,
      refs.repoId,
    ]);
    await expect(
      withTenant(appUserPool, refs.accountId, (client) =>
        client.query(`UPDATE work_items SET provenance = 'internal' WHERE account_id = $1 AND id = $2`, [refs.accountId, workItemId]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    const { rows } = await admin.query(`SELECT provenance FROM work_items WHERE id = $1`, [workItemId]);
    expect(rows[0].provenance).toBe('external');
  });

  it('an UPDATE of any other column on the same row still succeeds as app_user (D#123 recipe)', async () => {
    const workItemId = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, state) VALUES ($1, $2, $3, 'bug', 'external', 'open')`,
      [workItemId, refs.accountId, refs.repoId],
    );
    await withTenant(appUserPool, refs.accountId, (client) =>
      client.query(`UPDATE work_items SET state = 'triaging' WHERE account_id = $1 AND id = $2`, [refs.accountId, workItemId]),
    );
    const { rows } = await admin.query(`SELECT provenance, state FROM work_items WHERE id = $1`, [workItemId]);
    expect(rows[0]).toMatchObject({ provenance: 'external', state: 'triaging' });
  });

  it('a multi-column UPDATE that ALSO touches provenance is refused wholesale', async () => {
    const workItemId = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, state) VALUES ($1, $2, $3, 'bug', 'external', 'open')`,
      [workItemId, refs.accountId, refs.repoId],
    );
    await expect(
      withTenant(appUserPool, refs.accountId, (client) =>
        client.query(`UPDATE work_items SET state = 'triaging', provenance = 'internal' WHERE account_id = $1 AND id = $2`, [
          refs.accountId,
          workItemId,
        ]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    const { rows } = await admin.query(`SELECT provenance, state FROM work_items WHERE id = $1`, [workItemId]);
    expect(rows[0]).toMatchObject({ provenance: 'external', state: 'open' });
  });

  it('INSERT is unaffected: app_user can still create a row with either provenance value', async () => {
    const internalId = randomUUID();
    const externalId = randomUUID();
    await withTenant(appUserPool, refs.accountId, (client) =>
      client.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`, [
        internalId,
        refs.accountId,
        refs.repoId,
      ]),
    );
    await withTenant(appUserPool, refs.accountId, (client) =>
      client.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'external')`, [
        externalId,
        refs.accountId,
        refs.repoId,
      ]),
    );
    const { rows } = await admin.query(`SELECT id, provenance FROM work_items WHERE id IN ($1, $2) ORDER BY provenance`, [
      internalId,
      externalId,
    ]);
    expect(rows).toEqual([
      { id: externalId, provenance: 'external' },
      { id: internalId, provenance: 'internal' },
    ]);
  });

  it('platform_ops can resolve gh_installation_id -> account_id and gh_repo_id -> repo_id (new SELECT grant)', async () => {
    // The seed gives each installation a random gh_installation_id (0655's unique index forbids a shared one).
    const { rows: seeded } = await admin.query(`SELECT gh_installation_id FROM installations WHERE id = $1`, [refs.installationId]);
    const { rows: installationRows } = await platformOpsPool.query(`SELECT account_id FROM installations WHERE gh_installation_id = $1`, [
      seeded[0].gh_installation_id,
    ]);
    expect(installationRows.some((r: { account_id: string }) => r.account_id === refs.accountId)).toBe(true);

    const { rows: repoRows } = await platformOpsPool.query(`SELECT id FROM repos WHERE account_id = $1 AND gh_repo_id = 1`, [
      refs.accountId,
    ]);
    expect(repoRows).toHaveLength(1);
    expect(repoRows[0].id).toBe(refs.repoId);
  });

  it('platform_ops still cannot write installations or repos (SELECT-only grant)', async () => {
    await expect(
      platformOpsPool.query(`UPDATE installations SET app_kind = 'sitekit' WHERE id = $1`, [refs.installationId]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(
      platformOpsPool.query(`UPDATE repos SET gh_repo_id = 999 WHERE id = $1`, [refs.repoId]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });
});
