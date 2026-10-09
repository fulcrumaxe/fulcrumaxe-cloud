import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { getWorkItem, listWorkItems } from '../src/work-items/read.js';

/** D#31 API-3a criteria 1-3, corrected by C10 (`stage` is D#45's `work_items.stage`): against a real Postgres cluster under `withTenant`/RLS. */
describe('work-items/read (D#31 API-3a, corrected by C10)', () => {
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

  async function insertWorkItem(
    refs: SeedRefs,
    opts: {
      ghNumber?: number | null;
      stage?: string;
      provenance?: 'internal' | 'external';
      createdAt: Date;
    },
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage, created_at, updated_at)
       VALUES ($1, $2, $3, 'feature', $4, $5, $6, $7, $7)`,
      [
        id,
        refs.accountId,
        refs.repoId,
        opts.ghNumber ?? null,
        opts.provenance ?? 'internal',
        opts.stage ?? 'triaged',
        opts.createdAt,
      ],
    );
    return id;
  }

  async function insertRunFor(accountId: string, workItemId: string, usd: number | null): Promise<void> {
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, usd)
       VALUES ($1, $2, $3, 'build', 'local', 'succeeded', $4)`,
      [randomUUID(), accountId, workItemId, usd],
    );
  }

  describe('getWorkItem', () => {
    it('returns exactly the Spec fields: issue_number from gh_number, stage passthrough, provenance via parseProvenance', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const id = await insertWorkItem(refsA, {
        ghNumber: 42,
        stage: 'in_progress',
        provenance: 'external',
        createdAt,
      });
      const dto = await getWorkItem({ pool: appUserPool, principal: refsA }, id);
      expect(dto).toEqual({
        id,
        repo_id: refsA.repoId,
        kind: 'feature',
        issue_number: 42,
        stage: 'in_progress',
        provenance: 'external',
        priority: 'normal',
        queue_rank: null,
        cost_usd: 0,
        own_plan_api_equivalent_usd: 0,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
      });
      expect(Object.keys(dto).sort()).toEqual(
        ['id', 'repo_id', 'kind', 'issue_number', 'stage', 'provenance', 'priority', 'queue_rank', 'cost_usd', 'own_plan_api_equivalent_usd', 'created_at', 'updated_at'].sort(),
      );
    });

    it('cost_usd sums every run under the work item, and ignores runs with a null usd', async () => {
      const id = await insertWorkItem(refsA, { createdAt: new Date() });
      await insertRunFor(refsA.accountId, id, 1.5);
      await insertRunFor(refsA.accountId, id, 2.25);
      await insertRunFor(refsA.accountId, id, null);
      const dto = await getWorkItem({ pool: appUserPool, principal: refsA }, id);
      expect(dto.cost_usd).toBe(3.75);
    });

    it('a work item with no gh_number DTO-maps issue_number to null', async () => {
      const id = await insertWorkItem(refsA, { ghNumber: null, createdAt: new Date() });
      const dto = await getWorkItem({ pool: appUserPool, principal: refsA }, id);
      expect(dto.issue_number).toBeNull();
    });

    it("(CWE-639) B's own work item id, from A's principal -> NotFoundError", async () => {
      await expect(
        getWorkItem({ pool: appUserPool, principal: refsA }, refsB.workItemId),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });

    it('a random, well-formed uuid that does not exist -> NotFoundError', async () => {
      await expect(
        getWorkItem({ pool: appUserPool, principal: refsA }, randomUUID()),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });

    it('(CWE-755) a malformed id -> NotFoundError before ever reaching Postgres', async () => {
      await expect(
        getWorkItem({ pool: appUserPool, principal: refsA }, 'not-a-uuid'),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });
  });

  describe('listWorkItems', () => {
    it('filters by repo_id and by stage', async () => {
      const otherRepoId = randomUUID();
      await admin.query(
        `INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, 9999, 'team')`,
        [otherRepoId, refsA.accountId],
      );
      const now = Date.now();
      const matchId = await insertWorkItem(refsA, { stage: 'pr_opened', createdAt: new Date(now) });
      await insertWorkItem(refsA, { stage: 'triaged', createdAt: new Date(now - 1000) });
      const otherRepoWorkItemId = await insertWorkItem(
        { ...refsA, repoId: otherRepoId },
        { stage: 'pr_opened', createdAt: new Date(now - 2000) },
      );

      const byRepo = await listWorkItems(
        { pool: appUserPool, principal: refsA },
        { repoId: refsA.repoId, limit: 50 },
      );
      expect(byRepo.data.every((w) => w.repo_id === refsA.repoId)).toBe(true);
      expect(byRepo.data.some((w) => w.id === otherRepoWorkItemId)).toBe(false);

      const byStage = await listWorkItems(
        { pool: appUserPool, principal: refsA },
        { repoId: refsA.repoId, stage: 'pr_opened', limit: 50 },
      );
      expect(byStage.data.map((w) => w.id)).toContain(matchId);
      expect(byStage.data.every((w) => w.stage === 'pr_opened')).toBe(true);
    });

    it("D#483: a webhook row retired as superseded is absent from the list (every sort and filter) while its root is present, and getWorkItem still returns it", async () => {
      const now = Date.now();
      const retired = await insertWorkItem(refsA, { stage: 'triaged', createdAt: new Date(now) });
      const root = await insertWorkItem(refsA, { stage: 'discussing', createdAt: new Date(now - 1000) });
      const humanClosed = await insertWorkItem(refsA, { stage: 'closed', createdAt: new Date(now - 2000) });
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [retired]);
      const t = (item: string, ref: string) =>
        admin.query(
          `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`,
          [refsA.accountId, item, ref],
        );
      await t(retired, `superseded:${root}`);
      await t(humanClosed, 'closed-by-a-person');
      for (const input of [{ limit: 50 }, { limit: 50, sort: 'queue' as const }, { limit: 50, stage: 'closed' as const }, { limit: 50, repoId: refsA.repoId }]) {
        const ids = (await listWorkItems({ pool: appUserPool, principal: refsA }, input)).data.map((w) => w.id);
        expect(ids, JSON.stringify(input)).not.toContain(retired);
      }
      const all = (await listWorkItems({ pool: appUserPool, principal: refsA }, { limit: 50 })).data.map((w) => w.id);
      expect(all).toContain(root);
      expect(all).toContain(humanClosed); // an ordinary closed item is still work
      const got = await getWorkItem({ pool: appUserPool, principal: refsA }, retired);
      expect(got).toMatchObject({ id: retired, stage: 'closed' });
    });

    it('pages through rows that share the same created_at with no duplicate and no gap', async () => {
      const repoId = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, 8888, 'team')`, [
        repoId,
        refsA.accountId,
      ]);
      const sameInstant = new Date('2026-03-03T00:00:00.000Z');
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        ids.push(await insertWorkItem({ ...refsA, repoId }, { createdAt: sameInstant }));
      }

      const seen: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listWorkItems(
          { pool: appUserPool, principal: refsA },
          { repoId, limit: 3, cursor },
        );
        seen.push(...page.data.map((w) => w.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(ids.length);
    });

    /**
     * D#31 C12 (API-3c): closes the #138 round-2 recheck's should-fix (d) --
     * `work-items/read.ts` carries the identical µs-precision `created_at_cursor`
     * fix as `runs/read.ts`, but only `runs-read.test.ts` had a dedicated
     * same-millisecond/µs-precision regression test. Mirrors that test exactly.
     * A JS `Date` can't carry sub-millisecond precision, so these go in as SQL
     * text literals.
     */
    it('pages through rows that share a millisecond but differ only in microseconds, with no gap', async () => {
      const repoId = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, 7777, 'team')`, [
        repoId,
        refsA.accountId,
      ]);
      const microTimestamps = [
        '2026-04-04T00:00:00.123111Z',
        '2026-04-04T00:00:00.123555Z',
        '2026-04-04T00:00:00.123999Z',
      ];
      const ids: string[] = [];
      for (const ts of microTimestamps) {
        const id = randomUUID();
        await admin.query(
          `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, created_at, updated_at)
           VALUES ($1, $2, $3, 'feature', 'internal', 'triaged', $4::timestamptz, $4::timestamptz)`,
          [id, refsA.accountId, repoId, ts],
        );
        ids.push(id);
      }

      const seen: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listWorkItems(
          { pool: appUserPool, principal: refsA },
          { repoId, limit: 2, cursor },
        );
        seen.push(...page.data.map((w) => w.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(ids.length);
    });
  });
});
