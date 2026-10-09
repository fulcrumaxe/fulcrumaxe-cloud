import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { getRun, listRuns } from '../src/runs/read.js';

/** D#31 API-3a criteria 1-3: `getRun`/`listRuns` against a real Postgres cluster under `withTenant`/RLS. */
describe('runs/read (D#31 API-3a)', () => {
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

  async function insertRun(
    refs: SeedRefs,
    opts: {
      role?: string;
      status?: string;
      usd?: number | null;
      tokensIn?: number | null;
      tokensOut?: number | null;
      createdAt: Date;
    },
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs
         (id, account_id, work_item_id, role, runtime, status, usd, tokens_in, tokens_out, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'local', $5, $6, $7, $8, $9, $9)`,
      [
        id,
        refs.accountId,
        refs.workItemId,
        opts.role ?? 'build',
        opts.status ?? 'succeeded',
        opts.usd ?? null,
        opts.tokensIn ?? null,
        opts.tokensOut ?? null,
        opts.createdAt,
      ],
    );
    return id;
  }

  /** D#6 R2b-4a follow-up: who approved a run to use their plan, and whether the claim or a click did it, from stored facts. */
  describe('approval marker', () => {
    /** The receipt the claim's auto-approve definer writes with approved_by (the only writer of this decision type). */
    async function autoReceipt(refs: SeedRefs, runId: string): Promise<void> {
      await admin.query(
        `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, actor)
         VALUES ($1, $2, $3, 'runner_run_on_member_plan', 'human_over_the_loop', 'announce', 'ask', 'policy')`,
        [refs.accountId, runId, refs.workItemId],
      );
    }

    async function approvedRun(refs: SeedRefs, approver: string | null, opts: { auto?: boolean; createdAt?: Date } = {}): Promise<string> {
      const id = await insertRun(refs, { status: 'pending', createdAt: opts.createdAt ?? new Date() });
      if (approver !== null) {
        await admin.query('UPDATE agent_runs SET approved_by = $2 WHERE id = $1', [id, approver]);
        if (opts.auto) await autoReceipt(refs, id);
      }
      return id;
    }

    it('a run nobody approved has approved_by null and approval null', async () => {
      const id = await approvedRun(refsA, null);
      const dto = await getRun({ pool: appUserPool, principal: refsA }, id);
      expect(dto.approved_by).toBeNull();
      expect(dto.approval).toBeNull();
    });

    it("names the approver and reads 'auto' only when the claim's receipt exists, 'manual' for a click", async () => {
      await admin.query("UPDATE users SET name = 'Ada Admin' WHERE id = $1", [refsA.userId]);
      const manual = await approvedRun(refsA, refsA.userId);
      const auto = await approvedRun(refsA, refsA.userId, { auto: true });
      const m = await getRun({ pool: appUserPool, principal: refsA }, manual);
      const a = await getRun({ pool: appUserPool, principal: refsA }, auto);
      expect(m).toMatchObject({ approved_by: { id: refsA.userId, name: 'Ada Admin' }, approval: 'manual' });
      expect(a).toMatchObject({ approved_by: { id: refsA.userId, name: 'Ada Admin' }, approval: 'auto' });
    });

    it('an auto receipt for another run, or an approved run with no receipt at all, does not make a run auto', async () => {
      const other = await approvedRun(refsA, refsA.userId, { auto: true });
      const legacy = await insertRun(refsA, { status: 'pending', createdAt: new Date() });
      await admin.query('UPDATE agent_runs SET approved_by = $2 WHERE id = $1', [legacy, refsA.userId]);
      expect((await getRun({ pool: appUserPool, principal: refsA }, legacy)).approval).toBe('manual');
      expect((await getRun({ pool: appUserPool, principal: refsA }, other)).approval).toBe('auto');
    });

    it('a receipt of another decision type, or a stray audit row, does not make a run auto', async () => {
      const id = await approvedRun(refsA, refsA.userId);
      await admin.query(
        "INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class, chosen, actor) VALUES ($1, $2, $3, 'some_other_decision', 'human_over_the_loop', 'announce', 'policy')",
        [refsA.accountId, id, refsA.workItemId],
      );
      await admin.query("INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, $2, 'runner.run_auto_approved', $3::jsonb)", [refsA.accountId, refsA.userId, JSON.stringify({ run_id: id })]);
      expect((await getRun({ pool: appUserPool, principal: refsA }, id)).approval).toBe('manual');
    });

    it('does not depend on the current dial: the marker is the same after the dial is lowered to ask', async () => {
      const auto = await approvedRun(refsA, refsA.userId, { auto: true });
      await admin.query(
        "INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'runner_run_on_member_plan', 'ask', 1, $3)",
        [refsA.accountId, refsA.repoId, refsA.userId],
      );
      expect((await getRun({ pool: appUserPool, principal: refsA }, auto)).approval).toBe('auto');
    });

    it('shows the fallback name, never null or an id, for an approver with no name and no GitHub login', async () => {
      await admin.query('UPDATE users SET name = NULL, github_login = NULL WHERE id = $1', [refsA.userId]);
      const id = await approvedRun(refsA, refsA.userId);
      expect((await getRun({ pool: appUserPool, principal: refsA }, id)).approved_by).toEqual({ id: refsA.userId, name: 'A team member' });
    });

    it("another account's auto-approved run is invisible and its receipt cannot colour mine; the list carries the marker per run", async () => {
      const theirs = await approvedRun(refsB, refsB.userId, { auto: true });
      const mine = await approvedRun(refsA, refsA.userId, { createdAt: new Date('2030-01-01T00:00:00.000Z') });
      const auto = await approvedRun(refsA, refsA.userId, { auto: true, createdAt: new Date('2030-01-02T00:00:00.000Z') });
      await expect(getRun({ pool: appUserPool, principal: refsA }, theirs)).rejects.toThrow();
      expect((await getRun({ pool: appUserPool, principal: refsB }, theirs)).approval).toBe('auto');
      const list = await listRuns({ pool: appUserPool, principal: refsA }, { limit: 2 });
      expect(list.data.map((r) => [r.id, r.approval])).toEqual([[auto, 'auto'], [mine, 'manual']]);
    });
  });

  describe('getRun', () => {
    it('returns the run DTO with exactly the Spec fields, numeric fields converted from pg strings', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const id = await insertRun(refsA, { status: 'succeeded', usd: 1.25, tokensIn: 1000, tokensOut: 200, createdAt });
      const dto = await getRun({ pool: appUserPool, principal: refsA }, id);
      expect(dto).toEqual({
        id,
        work_item_id: refsA.workItemId,
        parent_run_id: null,
        role: 'build',
        status: 'succeeded',
        usd: 1.25,
        tokens_in: 1000,
        tokens_out: 200,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        approved_by: null,
        approval: null,
      });
      const expectedKeys = [
        'id', 'work_item_id', 'parent_run_id', 'role', 'status',
        'usd', 'tokens_in', 'tokens_out', 'created_at', 'updated_at',
        'approved_by', 'approval',
      ];
      expect(Object.keys(dto).sort()).toEqual(expectedKeys.sort());
    });

    it('a run with null usd/tokens_in/tokens_out DTO-maps those fields to null, not 0', async () => {
      const id = await insertRun(refsA, { status: 'pending', createdAt: new Date() });
      const dto = await getRun({ pool: appUserPool, principal: refsA }, id);
      expect(dto.usd).toBeNull();
      expect(dto.tokens_in).toBeNull();
      expect(dto.tokens_out).toBeNull();
    });

    it("(CWE-639) B's own run id, from A's principal -> NotFoundError, never a raw pg error", async () => {
      await expect(getRun({ pool: appUserPool, principal: refsA }, refsB.runId)).rejects.toMatchObject({
        name: 'NotFoundError',
      });
    });

    it('a random, well-formed uuid that does not exist -> NotFoundError', async () => {
      await expect(getRun({ pool: appUserPool, principal: refsA }, randomUUID())).rejects.toMatchObject({
        name: 'NotFoundError',
      });
    });

    it('(CWE-755) a malformed id -> NotFoundError before ever reaching Postgres, not a 22P02 crash', async () => {
      await expect(
        getRun({ pool: appUserPool, principal: refsA }, "not-a-uuid' OR '1'='1"),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });
  });

  describe('listRuns', () => {
    it('filters by work_item_id and by status', async () => {
      const otherWorkItemId = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [
        otherWorkItemId,
        refsA.accountId,
        refsA.repoId,
      ]);
      const now = Date.now();
      const matchId = await insertRun(refsA, { status: 'running', createdAt: new Date(now) });
      await insertRun(refsA, { status: 'succeeded', createdAt: new Date(now - 1000) });
      const otherWorkItemRunId = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'build', 'local', 'running', $4, $4)`,
        [otherWorkItemRunId, refsA.accountId, otherWorkItemId, new Date(now - 2000)],
      );

      const byWorkItem = await listRuns(
        { pool: appUserPool, principal: refsA },
        { workItemId: refsA.workItemId, limit: 50 },
      );
      expect(byWorkItem.data.every((r) => r.work_item_id === refsA.workItemId)).toBe(true);
      expect(byWorkItem.data.some((r) => r.id === otherWorkItemRunId)).toBe(false);

      const byStatus = await listRuns(
        { pool: appUserPool, principal: refsA },
        { status: 'running', workItemId: refsA.workItemId, limit: 50 },
      );
      expect(byStatus.data.map((r) => r.id)).toContain(matchId);
      expect(byStatus.data.every((r) => r.status === 'running')).toBe(true);
    });

    it('pages through rows that share the same created_at with no duplicate and no gap', async () => {
      const workItemId = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [
        workItemId,
        refsA.accountId,
        refsA.repoId,
      ]);
      const sameInstant = new Date('2026-02-02T00:00:00.000Z');
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const id = randomUUID();
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'local', 'succeeded', $5, $5)`,
          [id, refsA.accountId, workItemId, `tie-${i}`, sameInstant],
        );
        ids.push(id);
      }

      const seen: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listRuns(
          { pool: appUserPool, principal: refsA },
          { workItemId, limit: 3, cursor },
        );
        seen.push(...page.data.map((r) => r.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(ids.length);
    });

    /**
     * Deferred follow-up for fix round 1's microsecond-precision fix
     * (rows sharing a millisecond used to drop, because the cursor
     * round-tripped through a JS `Date`). The fix already shipped and was
     * verified live; this is the dedicated automated coverage that didn't
     * fit under the size cap at the time. A JS `Date` can't carry
     * sub-millisecond precision, so these go in as SQL text literals.
     */
    it('pages through rows that share a millisecond but differ only in microseconds, with no gap', async () => {
      const workItemId = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [
        workItemId,
        refsA.accountId,
        refsA.repoId,
      ]);
      const microTimestamps = [
        '2026-03-03T00:00:00.123111Z',
        '2026-03-03T00:00:00.123555Z',
        '2026-03-03T00:00:00.123999Z',
      ];
      const ids: string[] = [];
      for (const [i, ts] of microTimestamps.entries()) {
        const id = randomUUID();
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'local', 'succeeded', $5::timestamptz, $5::timestamptz)`,
          [id, refsA.accountId, workItemId, `us-${i}`, ts],
        );
        ids.push(id);
      }

      const seen: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listRuns(
          { pool: appUserPool, principal: refsA },
          { workItemId, limit: 2, cursor },
        );
        seen.push(...page.data.map((r) => r.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(ids.length);
    });
  });
});
