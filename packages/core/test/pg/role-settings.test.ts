import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { ROLE_NAMES } from '@fx/roles';
import { NotFoundError, ForbiddenError } from '../../src/tenancy/errors.js';
import { listRoleSettings } from '../../src/role-settings/list.js';
import { setRoleMode } from '../../src/role-settings/setMode.js';
import { setRoleModel } from '../../src/role-settings/setModel.js';
import { InvalidRoleSettingsInputError } from '../../src/role-settings/errors.js';
import type { RoleSettingsCtx } from '../../src/role-settings/types.js';

/**
 * D#2 H12 criteria 1, 2 and 3, plus sec-criteria A7. See the PR body for
 * the full criterion -> test map; this file covers `listRoleSettings`
 * and `setRoleMode`. Guard-toggle criterion 5 is in
 * role-settings-guard.test.ts; the H16 scheduler contract is in
 * role-settings-scheduler.test.ts.
 */
describe('role-settings: listRoleSettings and setRoleMode', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  function ctxFor(refs: SeedRefs): RoleSettingsCtx {
    return { pool: appUserPool, principal: { accountId: refs.accountId, userId: refs.userId } };
  }

  describe('criterion 1: lists all 26 roles', () => {
    it('returns exactly 26 entries, one per ROLE_NAMES, each with a non-empty allowedModes', async () => {
      const entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      expect(entries).toHaveLength(26);
      expect(new Set(entries.map((e) => e.role))).toEqual(new Set(ROLE_NAMES));
      for (const entry of entries) {
        expect(entry.allowedModes.length).toBeGreaterThan(0);
        expect(entry.allowedModes).toContain('off');
      }
    });

    it('a role with no role_settings row reports off, not the manifest defaultMode (presence carries the meaning)', async () => {
      const entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      // run-analyst and researcher default to weekly / always in the manifest; with no row they are off.
      expect(entries.find((e) => e.role === 'run-analyst')?.mode).toBe('off');
      expect(entries.find((e) => e.role === 'researcher')?.mode).toBe('off');
    });

    it('a role with a row reports that row\'s mode', async () => {
      await admin.query(
        `INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'mission-analyst', 'weekly')
         ON CONFLICT (repo_id, role) DO NOTHING`,
        [refsA.accountId, refsA.repoId],
      );
      const entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      expect(entries.find((e) => e.role === 'mission-analyst')?.mode).toBe('weekly');
    });

    it('account A requesting account B repo gets NotFoundError, never a permission error', async () => {
      await expect(listRoleSettings(ctxFor(refsA), refsB.repoId)).rejects.toThrow(NotFoundError);
    });

    it('a genuinely nonexistent repoId gets NotFoundError', async () => {
      await expect(listRoleSettings(ctxFor(refsA), randomUUID())).rejects.toThrow(NotFoundError);
    });
  });

  describe('criterion 2: cost line', () => {
    it('the text matches the exact wire format and carries the caveat as data', async () => {
      const entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      for (const entry of entries) {
        expect(entry.costLine.text).toMatch(/^expected spend on your model bill: \$\d+\.\d{2}\/month$/);
        expect(entry.costLine.caveat).toContain('may read low');
        expect(entry.costLine.monthlyUsd).toBeCloseTo(entry.costLine.runsPerMonth * entry.costLine.medianCostPerRunUsd, 2);
      }
    });

    it('seeds the median from the cost-analyst figures before the tenant has 10 of that role\'s own runs', async () => {
      const entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      const codeReviewer = entries.find((e) => e.role === 'code-reviewer')!;
      expect(codeReviewer.costLine.medianSource).toBe('seed');
      // code-reviewer's defaultModel is sonnet -> seed comes from the plan data (13 in the test data).
      expect(codeReviewer.costLine.medianCostPerRunUsd).toBe(13);
    });

    it('switches to the tenant\'s own ledger median once 10 of that role\'s runs exist', async () => {
      // 9 runs first: still seeded.
      for (let i = 1; i <= 9; i++) {
        const runId = randomUUID();
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, role, runtime, status, model) VALUES ($1, $2, 'security-reviewer', 'local', 'succeeded', 'opus-5')`,
          [runId, refsA.accountId],
        );
        await admin.query(
          `INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', $2, $3)`,
          [refsA.accountId, i, runId],
        );
      }
      let entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      let securityReviewer = entries.find((e) => e.role === 'security-reviewer')!;
      expect(securityReviewer.costLine.medianSource).toBe('seed');

      // 10th run tips it over.
      const runId10 = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, model) VALUES ($1, $2, 'security-reviewer', 'local', 'succeeded', 'opus-5')`,
        [runId10, refsA.accountId],
      );
      await admin.query(
        `INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', 10, $2)`,
        [refsA.accountId, runId10],
      );

      entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      securityReviewer = entries.find((e) => e.role === 'security-reviewer')!;
      expect(securityReviewer.costLine.medianSource).toBe('ledger');
      // median of 1..10 via percentile_cont(0.5) is 5.5 -- nowhere near the opus seed.
      expect(securityReviewer.costLine.medianCostPerRunUsd).toBe(5.5);
    });
  });

  describe('the cost line follows the model the role runs on', () => {
    const floorFor = (role: string) => (role === 'executor' ? ('sonnet-5' as const) : undefined);

    async function seedRuns(refs: SeedRefs, role: string, model: string | null, count: number, usd: number) {
      for (let i = 0; i < count; i++) {
        const runId = randomUUID();
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, role, runtime, status, model) VALUES ($1, $2, $3, 'local', 'succeeded', $4)`,
          [runId, refs.accountId, role, model],
        );
        await admin.query(
          `INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', $2, $3)`,
          [refs.accountId, usd, runId],
        );
      }
    }
    const lineOf = async (refs: SeedRefs, role: string, resolvers = {}) =>
      (await listRoleSettings(ctxFor(refs), refs.repoId, resolvers)).find((e) => e.role === role)!.costLine;

    it('a seed role: each model gives its own tier figure, and clearing goes back to the table model', async () => {
      const refs = await seedAccount(admin, randomUUID());
      const upsert = (model: string | null) =>
        admin.query(
          `INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, 'code-reviewer', 'always', $3)
           ON CONFLICT (repo_id, role) DO UPDATE SET model = EXCLUDED.model`,
          [refs.accountId, refs.repoId, model],
        );
      await upsert(null);
      const followed = await lineOf(refs, 'code-reviewer');
      await upsert('haiku-4.5');
      const haiku = await lineOf(refs, 'code-reviewer');
      await upsert('opus-5');
      const opus = await lineOf(refs, 'code-reviewer');
      expect([followed.medianCostPerRunUsd, haiku.medianCostPerRunUsd, opus.medianCostPerRunUsd]).toEqual([13, 3.5, 31]);
      expect(haiku.monthlyUsd).toBeCloseTo(haiku.runsPerMonth * 3.5, 2);
      expect(opus.monthlyUsd).toBeGreaterThan(followed.monthlyUsd);
      expect(followed.monthlyUsd).toBeGreaterThan(haiku.monthlyUsd);
      for (const line of [followed, haiku, opus]) expect(line.medianSource).toBe('seed');
    });

    it('with no override the model the live table gives the role is the one priced', async () => {
      const refs = await seedAccount(admin, randomUUID());
      const line = await lineOf(refs, 'code-reviewer', { routedModelFor: () => 'opus-5' as const });
      expect(line.medianCostPerRunUsd).toBe(31);
    });

    it('the floor holds: a model below it is priced at the floor', async () => {
      const refs = await seedAccount(admin, randomUUID());
      await admin.query(
        `INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, 'executor', 'always', NULL)
         ON CONFLICT (repo_id, role) DO UPDATE SET model = NULL`,
        [refs.accountId, refs.repoId],
      );
      const line = await lineOf(refs, 'executor', { routedModelFor: () => 'haiku-4.5' as const, floorFor });
      expect(line.medianCostPerRunUsd).toBe(13);
    });

    it('the ledger median counts only runs on the model in use; other models\' and unlabelled runs do not count', async () => {
      const refs = await seedAccount(admin, randomUUID());
      await seedRuns(refs, 'code-reviewer', 'sonnet-5', 10, 7);
      await seedRuns(refs, 'code-reviewer', 'opus-5', 4, 90);
      await seedRuns(refs, 'code-reviewer', null, 20, 90);
      // Follows the table (sonnet-5): its 10 runs count.
      const onSonnet = await lineOf(refs, 'code-reviewer');
      expect(onSonnet).toMatchObject({ medianSource: 'ledger', medianCostPerRunUsd: 7 });
      // Switch to opus-5: only 4 runs there, so back to the seed for opus.
      await admin.query(
        `INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, 'code-reviewer', 'always', 'opus-5')`,
        [refs.accountId, refs.repoId],
      );
      const onOpus = await lineOf(refs, 'code-reviewer');
      expect(onOpus).toMatchObject({ medianSource: 'seed', medianCostPerRunUsd: 31 });
      // Six more opus runs make ten, and then only those set the figure.
      await seedRuns(refs, 'code-reviewer', 'opus-5', 6, 20);
      expect(await lineOf(refs, 'code-reviewer')).toMatchObject({ medianSource: 'ledger', medianCostPerRunUsd: 20 });
    });
  });

  describe('criterion 3 + sec-criteria A7: setRoleMode', () => {
    it('an owner can change a mode; the change is reflected by listRoleSettings', async () => {
      await setRoleMode(ctxFor(refsA), { repoId: refsA.repoId, role: 'debater', mode: 'always' });
      const entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      expect(entries.find((e) => e.role === 'debater')?.mode).toBe('always');
    });

    it('writes exactly one audit_log row per change, with the role/mode/repo in the payload', async () => {
      const before = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
        refsA.accountId,
      ]);
      await setRoleMode(ctxFor(refsA), { repoId: refsA.repoId, role: 'quality-sweep', mode: 'weekly' });
      const after = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
        refsA.accountId,
      ]);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);

      const { rows } = await admin.query<{ action: string; payload: { role: string; mode: string } }>(
        `SELECT action, payload FROM audit_log WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [refsA.accountId],
      );
      expect(rows[0]!.action).toBe('role_settings.mode_changed');
      expect(rows[0]!.payload.role).toBe('quality-sweep');
      expect(rows[0]!.payload.mode).toBe('weekly');
    });

    it('a non-admin (member) gets ForbiddenError, and no row is written', async () => {
      const memberUserId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        memberUserId,
        `member-${memberUserId}@example.test`,
      ]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
        refsA.accountId,
        memberUserId,
      ]);
      const memberCtx: RoleSettingsCtx = {
        pool: appUserPool,
        principal: { accountId: refsA.accountId, userId: memberUserId },
      };

      await expect(setRoleMode(memberCtx, { repoId: refsA.repoId, role: 'debater', mode: 'off' })).rejects.toThrow(
        ForbiddenError,
      );

      const entries = await listRoleSettings(ctxFor(refsA), refsA.repoId);
      expect(entries.find((e) => e.role === 'debater')?.mode).toBe('always'); // unchanged from the earlier owner-made change
    });

    // Security review (PR #89, suggestion): requireOwnerOrAdmin now runs
    // before assertRepoExists (matching guardSettings' order), so a member
    // gets the SAME error -- ForbiddenError, never NotFoundError -- whether
    // the repo they named exists in their own account or not.
    it('a non-admin (member) gets the same ForbiddenError for a missing repo and an existing one', async () => {
      const memberUserId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        memberUserId,
        `member-order-${memberUserId}@example.test`,
      ]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
        refsA.accountId,
        memberUserId,
      ]);
      const memberCtx: RoleSettingsCtx = {
        pool: appUserPool,
        principal: { accountId: refsA.accountId, userId: memberUserId },
      };

      await expect(
        setRoleMode(memberCtx, { repoId: randomUUID(), role: 'debater', mode: 'off' }),
      ).rejects.toThrow(ForbiddenError);

      await expect(
        setRoleMode(memberCtx, { repoId: refsA.repoId, role: 'debater', mode: 'off' }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('an unknown role name is rejected before touching the database', async () => {
      await expect(
        setRoleMode(ctxFor(refsA), { repoId: refsA.repoId, role: 'not-a-real-role', mode: 'always' as never }),
      ).rejects.toThrow(InvalidRoleSettingsInputError);
    });

    it("a mode outside the role's allowedModes is rejected (executor allows only off/always, not weekly)", async () => {
      await expect(
        setRoleMode(ctxFor(refsA), { repoId: refsA.repoId, role: 'executor', mode: 'weekly' }),
      ).rejects.toThrow(InvalidRoleSettingsInputError);
    });

    it('account A cannot set a mode on account B\'s repo (NotFoundError)', async () => {
      await expect(
        setRoleMode(ctxFor(refsA), { repoId: refsB.repoId, role: 'debater', mode: 'always' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('H08-followup: setRoleModel creates a missing row as off, never as the manifest default', () => {
    const rowOf = async (repoId: string, role: string) =>
      (await admin.query<{ mode: string; model: string | null }>(
        'SELECT mode, model FROM role_settings WHERE repo_id = $1 AND role = $2',
        [repoId, role],
      )).rows;

    it('setting only a model on a role with no row inserts mode off (executor defaults to always)', async () => {
      const refs = await seedAccount(admin, randomUUID());
      await admin.query('DELETE FROM role_settings WHERE repo_id = $1', [refs.repoId]);
      await setRoleModel(ctxFor(refs), { repoId: refs.repoId, role: 'executor', model: 'opus-5' });
      expect(await rowOf(refs.repoId, 'executor')).toEqual([{ mode: 'off', model: 'opus-5' }]);
      expect((await listRoleSettings(ctxFor(refs), refs.repoId)).find((e) => e.role === 'executor')?.mode).toBe('off');
    });

    it('setting a model on a role that already has a row keeps that row\'s mode', async () => {
      const refs = await seedAccount(admin, randomUUID());
      await admin.query('DELETE FROM role_settings WHERE repo_id = $1', [refs.repoId]);
      await admin.query(
        `INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'executor', 'always')`,
        [refs.accountId, refs.repoId],
      );
      await setRoleModel(ctxFor(refs), { repoId: refs.repoId, role: 'executor', model: 'sonnet-5' });
      expect(await rowOf(refs.repoId, 'executor')).toEqual([{ mode: 'always', model: 'sonnet-5' }]);
    });
  });
});
