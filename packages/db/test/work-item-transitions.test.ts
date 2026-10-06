import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/**
 * D#45 S1 criteria 4, 5 and 6: `work_item_transitions`' columns and
 * constraints, the no-forward-dated-stamps trigger, and its tenancy/grant
 * shape.
 */
describe('work_item_transitions (D#45 S1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let partnerUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await partnerUserPool.end();
    await platformOpsPool.end();
  });

  /** Inserts one valid transition row as admin (bypasses RLS), for account A's seeded work item. */
  async function seedTransition(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
    const id = randomUUID();
    const params = {
      id,
      account_id: refsA.accountId,
      work_item_id: refsA.workItemId,
      from_stage: 'triaged',
      to_stage: 'discussing',
      reviewer: null,
      at: new Date(),
      source: 'control_plane',
      source_ref: randomUUID(),
      run_id: null,
      ...overrides,
    };
    await admin.query(
      `INSERT INTO work_item_transitions
         (id, account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        params.id,
        params.account_id,
        params.work_item_id,
        params.from_stage,
        params.to_stage,
        params.reviewer,
        params.at,
        params.source,
        params.source_ref,
        params.run_id,
      ],
    );
    return id;
  }

  describe('columns and constraints (criterion 4)', () => {
    it('columns match the Spec exactly', async () => {
      const { rows } = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'work_item_transitions'
         ORDER BY ordinal_position`,
      );
      const byName = new Map(rows.map((r) => [r.column_name, r]));
      expect(new Set(rows.map((r) => r.column_name))).toEqual(
        new Set([
          'id',
          'account_id',
          'work_item_id',
          'from_stage',
          'to_stage',
          'reviewer',
          'at',
          'source',
          'source_ref',
          'run_id',
          'created_at',
        ]),
      );
      expect(byName.get('id')!.data_type).toBe('uuid');
      expect(byName.get('id')!.is_nullable).toBe('NO');
      expect(byName.get('account_id')!.data_type).toBe('uuid');
      expect(byName.get('account_id')!.is_nullable).toBe('NO');
      expect(byName.get('work_item_id')!.data_type).toBe('uuid');
      expect(byName.get('work_item_id')!.is_nullable).toBe('NO');
      expect(byName.get('from_stage')!.data_type).toBe('text');
      expect(byName.get('from_stage')!.is_nullable).toBe('NO');
      expect(byName.get('to_stage')!.data_type).toBe('text');
      expect(byName.get('to_stage')!.is_nullable).toBe('NO');
      expect(byName.get('reviewer')!.data_type).toBe('text');
      expect(byName.get('reviewer')!.is_nullable).toBe('YES');
      expect(byName.get('at')!.data_type).toBe('timestamp with time zone');
      expect(byName.get('at')!.is_nullable).toBe('NO');
      expect(byName.get('source')!.data_type).toBe('text');
      expect(byName.get('source')!.is_nullable).toBe('NO');
      expect(byName.get('source_ref')!.data_type).toBe('text');
      expect(byName.get('source_ref')!.is_nullable).toBe('NO');
      expect(byName.get('run_id')!.data_type).toBe('uuid');
      expect(byName.get('run_id')!.is_nullable).toBe('YES');
      expect(byName.get('created_at')!.data_type).toBe('timestamp with time zone');
      expect(byName.get('created_at')!.is_nullable).toBe('NO');
    });

    it('id is the primary key', async () => {
      const { rows } = await admin.query<{ column_name: string }>(
        `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'work_item_transitions'::regclass AND i.indisprimary`,
      );
      expect(rows.map((r) => r.column_name)).toEqual(['id']);
    });

    it('a UNIQUE (account_id, work_item_id, to_stage, source_ref) index/constraint exists', async () => {
      const { rows } = await admin.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'work_item_transitions'::regclass AND contype = 'u'`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('a second INSERT with the same (account_id, work_item_id, to_stage, source_ref) fails with 23505', async () => {
      const sourceRef = randomUUID();
      await seedTransition({ source_ref: sourceRef });
      await expect(seedTransition({ source_ref: sourceRef })).rejects.toMatchObject({
        code: PG_ERROR.UNIQUE_VIOLATION,
      });
    });

    it('an index on (account_id, work_item_id, at) exists', async () => {
      const { rows } = await admin.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'work_item_transitions' AND indexname = 'idx_work_item_transitions_account_work_item_at'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/\(account_id, work_item_id, at\)/);
    });

    describe('FKs', () => {
      it('(account_id, work_item_id) -> work_items ON DELETE CASCADE', async () => {
        const workItemId = randomUUID();
        await admin.query(
          `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`,
          [workItemId, refsA.accountId, refsA.repoId],
        );
        const transitionId = await seedTransition({ work_item_id: workItemId });
        await admin.query('DELETE FROM work_items WHERE id = $1', [workItemId]);
        const { rows } = await admin.query('SELECT id FROM work_item_transitions WHERE id = $1', [
          transitionId,
        ]);
        expect(rows).toHaveLength(0);
      });

      it('(account_id, run_id) -> agent_runs ON DELETE SET NULL (run_id)', async () => {
        const runId = randomUUID();
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`,
          [runId, refsA.accountId, refsA.workItemId],
        );
        const transitionId = await seedTransition({ run_id: runId, to_stage: 'spec_ready' });
        await admin.query('DELETE FROM agent_runs WHERE id = $1', [runId]);
        const { rows } = await admin.query<{ run_id: string | null }>(
          'SELECT run_id FROM work_item_transitions WHERE id = $1',
          [transitionId],
        );
        expect(rows[0]!.run_id).toBeNull();
      });

      it("a transition naming tenant B's work item from tenant A's account_id fails with 23503", async () => {
        await expect(
          seedTransition({ account_id: refsA.accountId, work_item_id: refsB.workItemId, to_stage: 'spec_ready' }),
        ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      });
    });

    describe('CHECKs (each with a failing INSERT, 23514)', () => {
      it('from_stage must be one of the 11 stages', async () => {
        await expect(seedTransition({ from_stage: 'bogus' })).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
      });

      it('to_stage must be one of the 11 stages', async () => {
        await expect(seedTransition({ to_stage: 'bogus' })).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
      });

      it("source must be 'webhook' or 'control_plane'", async () => {
        await expect(seedTransition({ source: 'bogus' })).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
      });

      it('source_ref length must be between 1 and 200', async () => {
        await expect(seedTransition({ source_ref: '' })).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
        await expect(seedTransition({ source_ref: 'x'.repeat(201) })).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
      });

      it("reviewer must be 'code', 'security' or 'acceptance'", async () => {
        await expect(
          seedTransition({ to_stage: 'changes_requested', reviewer: 'bogus' }),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });

      it('reviewer is required for changes_requested/review_passed, and forbidden otherwise', async () => {
        await expect(seedTransition({ to_stage: 'changes_requested', reviewer: null })).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
        await expect(seedTransition({ to_stage: 'spec_ready', reviewer: 'code' })).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
      });

      it("at <= created_at + interval '5 minutes' (created_at is real now(), stamped by the trigger)", async () => {
        await expect(
          seedTransition({ at: new Date(Date.now() + 6 * 60 * 1000) }),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });
  });

  describe('no forward-dated stamps (criterion 5)', () => {
    it('as the migration/admin role: created_at is forced to now(); at + created_at both a year out still fails 23514', async () => {
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await expect(
        admin.query(
          `INSERT INTO work_item_transitions
             (account_id, work_item_id, from_stage, to_stage, at, source, source_ref, created_at)
           VALUES ($1, $2, 'triaged', 'discussing', $3, 'control_plane', $4, $3)`,
          [refsA.accountId, refsA.workItemId, future, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('as the migration/admin role: at one day in the past succeeds, and created_at lands within 5s of now', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const id = randomUUID();
      await admin.query(
        `INSERT INTO work_item_transitions
           (id, account_id, work_item_id, from_stage, to_stage, at, source, source_ref)
         VALUES ($1, $2, $3, 'triaged', 'discussing', $4, 'control_plane', $5)`,
        [id, refsA.accountId, refsA.workItemId, past, randomUUID()],
      );
      const { rows } = await admin.query<{ created_at: Date }>(
        'SELECT created_at FROM work_item_transitions WHERE id = $1',
        [id],
      );
      expect(Math.abs(rows[0]!.created_at.getTime() - Date.now())).toBeLessThan(5000);
    });

    it('as app_user: at and created_at a year out both fails 23514', async () => {
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query(
            `INSERT INTO work_item_transitions
               (account_id, work_item_id, from_stage, to_stage, at, source, source_ref, created_at)
             VALUES ($1, $2, 'triaged', 'discussing', $3, 'control_plane', $4, $3)`,
            [refsA.accountId, refsA.workItemId, future, randomUUID()],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('as app_user: at one day in the past succeeds, and created_at lands within 5s of now', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sourceRef = randomUUID();
      await withTenant(appUserPool, refsA.accountId, (client) =>
        client.query(
          `INSERT INTO work_item_transitions
             (account_id, work_item_id, from_stage, to_stage, at, source, source_ref)
           VALUES ($1, $2, 'triaged', 'discussing', $3, 'control_plane', $4)`,
          [refsA.accountId, refsA.workItemId, past, sourceRef],
        ),
      );
      const { rows } = await admin.query<{ created_at: Date }>(
        'SELECT created_at FROM work_item_transitions WHERE account_id = $1 AND source_ref = $2',
        [refsA.accountId, sourceRef],
      );
      expect(Math.abs(rows[0]!.created_at.getTime() - Date.now())).toBeLessThan(5000);
    });
  });

  describe('tenancy and grants (criterion 6)', () => {
    it('RLS is enabled and forced', async () => {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'work_item_transitions'::regclass`,
      );
      expect(rows[0]!.relrowsecurity).toBe(true);
      expect(rows[0]!.relforcerowsecurity).toBe(true);
    });

    it("the tenant_isolation policy's USING/WITH CHECK are identical to work_items'", async () => {
      const { rows } = await admin.query<{ tablename: string; qual: string; with_check: string }>(
        `SELECT tablename, qual, with_check FROM pg_policies
         WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
           AND tablename IN ('work_items', 'work_item_transitions')`,
      );
      const byTable = new Map(rows.map((r) => [r.tablename, r]));
      const workItems = byTable.get('work_items');
      const transitions = byTable.get('work_item_transitions');
      expect(workItems).toBeDefined();
      expect(transitions).toBeDefined();
      expect(transitions!.qual).toBe(workItems!.qual);
      expect(transitions!.with_check).toBe(workItems!.with_check);
    });

    it('app_user holds exactly SELECT and INSERT', async () => {
      const { rows } = await admin.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'work_item_transitions' AND grantee = 'app_user'`,
      );
      expect(new Set(rows.map((r) => r.privilege_type))).toEqual(new Set(['SELECT', 'INSERT']));
    });

    it('UPDATE and DELETE as app_user fail with 42501', async () => {
      const id = await seedTransition({ to_stage: 'spec_ready' });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query(`UPDATE work_item_transitions SET reviewer = NULL WHERE id = $1`, [id]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query(`DELETE FROM work_item_transitions WHERE id = $1`, [id]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('SELECT as partner_user fails with 42501', async () => {
      const client = await partnerUserPool.connect();
      try {
        await expect(client.query('SELECT 1 FROM work_item_transitions')).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      } finally {
        client.release();
      }
    });

    it('SELECT as platform_ops fails with 42501', async () => {
      const client = await platformOpsPool.connect();
      try {
        await expect(client.query('SELECT 1 FROM work_item_transitions')).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      } finally {
        client.release();
      }
    });

    it("under withTenant(A), SELECT returns none of B's rows", async () => {
      await seedTransition({ to_stage: 'spec_ready' });
      await seedTransition({
        account_id: refsB.accountId,
        work_item_id: refsB.workItemId,
        to_stage: 'spec_ready',
      });
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rows } = await client.query<{ account_id: string }>(
          'SELECT account_id FROM work_item_transitions',
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.account_id).toBe(refsA.accountId);
        }
      });
    });

    it('under withTenant(A), an INSERT with account_id = B fails with 42501', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query(
            `INSERT INTO work_item_transitions
               (account_id, work_item_id, from_stage, to_stage, at, source, source_ref)
             VALUES ($1, $2, 'triaged', 'discussing', now(), 'control_plane', $3)`,
            [refsB.accountId, refsB.workItemId, randomUUID()],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('findRlsViolations returns [] on the migrated schema', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
    });
  });
});
