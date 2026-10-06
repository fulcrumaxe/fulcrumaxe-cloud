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
      });
      const expectedKeys = [
        'id', 'work_item_id', 'parent_run_id', 'role', 'status',
        'usd', 'tokens_in', 'tokens_out', 'created_at', 'updated_at',
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
