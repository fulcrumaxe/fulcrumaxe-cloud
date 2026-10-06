import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { listReceiptsForWorkItem } from '../src/decisions.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#7 DP2 fix round 3 (security review needs-fix on PR #54, MUST items 1
 * and 2, PR 54 review comment):
 * `decision_settings.repo_id` used to CASCADE from `repos`, and
 * `decision_receipts.work_item_id` used to SET NULL from `work_items`.
 * `app_user` holds plain DELETE on both `repos` and `work_items`
 * (0001_core.sql's `tenant_isolation` policy), checked only against
 * account_id -- no role distinction at all. That meant a plain MEMBER
 * could wipe a repo's whole dial history, or rewrite a receipt's
 * work_item_id to NULL, by deleting the parent row directly: no
 * owner/admin check (decision_settings' own INSERT policy is irrelevant
 * to a DELETE on a different table) and no audit_log entry.
 *
 * Both FKs are now `ON DELETE RESTRICT`. This is a referential action on
 * the constraint itself, not a role-scoped RLS policy, so it blocks the
 * delete for EVERY app_user session -- member, admin, and owner alike --
 * for as long as any dependent row exists. Each MUST item below is
 * therefore tested twice: once as a member (the reviewer's original
 * probe shape) and once as the account's owner, to confirm this isn't
 * merely piggybacking on the member's lack of privilege elsewhere.
 */
describe('decision_settings / decision_receipts FK RESTRICT (fix round 3, MUST items 1 and 2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let memberUserId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());

    memberUserId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      memberUserId,
      `${memberUserId}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
      refs.accountId,
      memberUserId,
    ]);

    // Dial history for refs.repoId, and a receipt for refs.workItemId --
    // written directly by the admin connection (bypasses RLS: this is
    // fixture setup, not the check under test).
    await admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
       VALUES ($1, $2, 'merge.fast-path', 'ask', 1, $3)`,
      [refs.accountId, refs.repoId, refs.userId],
    );
    await admin.query(
      `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class, chosen)
       VALUES ($1, $2, $3, 'merge.fast-path', 'human_over_the_loop', 'original-value')`,
      [refs.accountId, refs.runId, refs.workItemId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('MUST item 1: repos -> decision_settings', () => {
    it('a MEMBER deleting a repo with dial history fails, and every decision_settings row survives', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, memberUserId, async (client) => {
          await client.query(`DELETE FROM repos WHERE id = $1`, [refs.repoId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });

      const { rows: repoRows } = await admin.query(`SELECT 1 FROM repos WHERE id = $1`, [refs.repoId]);
      expect(repoRows).toHaveLength(1);

      const { rows: settingRows } = await admin.query<{ version: number }>(
        `SELECT version FROM decision_settings WHERE account_id = $1 AND repo_id = $2`,
        [refs.accountId, refs.repoId],
      );
      expect(settingRows).toHaveLength(1);
      expect(settingRows[0].version).toBe(1);
    });

    it('an OWNER deleting the same repo also fails -- RESTRICT is a referential action, not a role-scoped policy', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
          await client.query(`DELETE FROM repos WHERE id = $1`, [refs.repoId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });

      const { rows: repoRows } = await admin.query(`SELECT 1 FROM repos WHERE id = $1`, [refs.repoId]);
      expect(repoRows).toHaveLength(1);

      const { rows: settingRows } = await admin.query(
        `SELECT 1 FROM decision_settings WHERE account_id = $1 AND repo_id = $2`,
        [refs.accountId, refs.repoId],
      );
      expect(settingRows).toHaveLength(1);
    });
  });

  describe('MUST item 2: work_items -> decision_receipts', () => {
    it("a MEMBER deleting a work item with a receipt fails; the receipt keeps its work_item_id, and listReceiptsForWorkItem still finds it", async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, memberUserId, async (client) => {
          await client.query(`DELETE FROM work_items WHERE id = $1`, [refs.workItemId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });

      const { rows: wiRows } = await admin.query(`SELECT 1 FROM work_items WHERE id = $1`, [
        refs.workItemId,
      ]);
      expect(wiRows).toHaveLength(1);

      const { rows: receiptRows } = await admin.query<{
        work_item_id: string | null;
        chosen: string | null;
      }>(`SELECT work_item_id, chosen FROM decision_receipts WHERE account_id = $1 AND work_item_id = $2`, [
        refs.accountId,
        refs.workItemId,
      ]);
      expect(receiptRows).toHaveLength(1);
      expect(receiptRows[0].work_item_id).toBe(refs.workItemId);
      expect(receiptRows[0].chosen).toBe('original-value');

      await withTenant(appUserPool, refs.accountId, async (client) => {
        const found = await listReceiptsForWorkItem(client, refs.workItemId);
        expect(found).toHaveLength(1);
        expect(found[0].workItemId).toBe(refs.workItemId);
        expect(found[0].chosen).toBe('original-value');
      });
    });

    it('an OWNER deleting the same work item also fails', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, async (client) => {
          await client.query(`DELETE FROM work_items WHERE id = $1`, [refs.workItemId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });

      const { rows: receiptRows } = await admin.query(
        `SELECT work_item_id FROM decision_receipts WHERE account_id = $1 AND work_item_id = $2`,
        [refs.accountId, refs.workItemId],
      );
      expect(receiptRows).toHaveLength(1);
    });
  });
});
