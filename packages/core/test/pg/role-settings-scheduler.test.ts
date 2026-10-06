import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { isRoleRunnable, listSkippedForBudget } from '../../src/role-settings/scheduler.js';
import type { RoleSchedulerCtx } from '../../src/role-settings/types.js';

/**
 * D#2 H12 re-brief (D#31 comment 18492898/18494573): "Deliver the
 * service-level contract H16 will call ... isRoleRunnable(ctx, repoId,
 * role) and listSkippedForBudget." H16 itself is not built -- these
 * tests only exercise what H12 owns: the `off` gate, and reading back
 * whatever `skipped_budget` run_events rows already exist.
 */
describe('role-settings scheduler contract (H16 dependency)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  function ctx(): RoleSchedulerCtx {
    return { pool: appUserPool };
  }

  describe('isRoleRunnable', () => {
    it('a role in off is never runnable', async () => {
      await admin.query(
        `INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'debater', 'off')`,
        [refs.accountId, refs.repoId],
      );
      expect(await isRoleRunnable(ctx(), refs.accountId, refs.repoId, 'debater')).toBe(false);
    });

    it('a role set to a non-off mode is runnable', async () => {
      await admin.query(
        `INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'ux-designer', 'always')`,
        [refs.accountId, refs.repoId],
      );
      expect(await isRoleRunnable(ctx(), refs.accountId, refs.repoId, 'ux-designer')).toBe(true);
    });

    it('a role with no row is not runnable, whatever its manifest defaultMode (researcher defaults to always, quality-sweep to off)', async () => {
      expect(await isRoleRunnable(ctx(), refs.accountId, refs.repoId, 'quality-sweep')).toBe(false);
      expect(await isRoleRunnable(ctx(), refs.accountId, refs.repoId, 'researcher')).toBe(false);
    });

    it('a role with no row whose manifest default is weekly is still not runnable (mission-analyst)', async () => {
      expect(await isRoleRunnable(ctx(), refs.accountId, refs.repoId, 'mission-analyst')).toBe(false);
    });

    it('a role name outside the manifest with no row is not runnable', async () => {
      expect(await isRoleRunnable(ctx(), refs.accountId, refs.repoId, 'not-a-role')).toBe(false);
    });
  });

  describe('listSkippedForBudget', () => {
    it('returns nothing when no skipped_budget run_events exist yet', async () => {
      const skipped = await listSkippedForBudget(ctx(), refs.accountId);
      expect(skipped).toEqual([]);
    });

    it('reads back a skipped_budget run_event, naming the role that was skipped', async () => {
      // H16 does not exist yet to write this shape; this proves the READ
      // side against a row built to satisfy today's schema (run_events.
      // run_id is NOT NULL, FK'd to agent_runs -- see scheduler.ts's own
      // doc comment on the open question of how H16 will represent a
      // skipped-before-it-started run within that constraint). The run row's
      // status is any value agent_runs_status_known (0642) allows; the read
      // side keys on the run_event, not the status.
      const runId = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'analytics-engineer', 'local', 'cancelled')`,
        [runId, refs.accountId],
      );
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind) VALUES ($1, $2, 1, 'skipped_budget')`, [
        refs.accountId,
        runId,
      ]);

      const skipped = await listSkippedForBudget(ctx(), refs.accountId);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.role).toBe('analytics-engineer');
      expect(skipped[0]!.skippedAt).toBeInstanceOf(Date);
    });
  });
});
