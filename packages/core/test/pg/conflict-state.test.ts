import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { recordDriverEvent } from '../../src/work-items/driverEvents.js';
import { readConflictState } from '../../src/work-items/mergeReadiness.js';

/** D#519 MQ4-d: what the card is told about a merge-conflict fix round, read from real rows through the app role. Derived on each read, never stored. */
describe('readConflictState', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  const head = 'a'.repeat(40);
  const OF = 2;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });
  beforeEach(async () => {
    refs = await seedAccount(admin, randomUUID());
  });

  const read = () => withTenant(appUserPool, refs.accountId, (c) => readConflictState(c, refs.accountId, refs.workItemId, OF));
  const entry = async (state: string, fields: { workKind?: string; reason?: string; rounds?: number } = {}) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO merge_queue_entries (account_id, repo_id, work_item_id, pr_number, head_sha, approved_at, state, work_kind, reason, conflict_rounds)
         VALUES ($1, $2, $3, 7, $4, now(), $5, $6, $7, $8) RETURNING id`,
        [refs.accountId, refs.repoId, refs.workItemId, head, state, fields.workKind ?? null, fields.reason ?? null, fields.rounds ?? 0],
      )
    ).rows[0]!.id;
  const round = (entryId: string, n: number, files: string[], baseRef = 'main') =>
    admin.query(
      `INSERT INTO merge_conflict_rounds (account_id, repo_id, work_item_id, entry_id, round, from_sha, base_sha, base_ref, conflict_files) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[])`,
      [refs.accountId, refs.repoId, refs.workItemId, entryId, n, head, 'b'.repeat(40), baseRef, files],
    );
  const stopEvent = (rounds: number, why: string, detail?: { conflictFiles?: string[]; baseRef?: string | null }) =>
    withTenant(appUserPool, refs.accountId, (c) =>
      recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'stopped', dedupeKey: `conflict:${head}:${rounds}:${why}`, code: 'merge_conflict', reasons: [why], headSha: head, prNumber: 7, round: rounds, ...(detail ? { detail } : {}) }),
    );

  it('nothing to say without an entry, or for an entry that is not in a conflict', async () => {
    expect(await read()).toBeNull();
    await entry('queued');
    expect(await read()).toBeNull();
  });

  it('C6-d4: a running round is told with its round row, and the next read after the entry leaves awaiting_work says nothing', async () => {
    const id = await entry('awaiting_work', { workKind: 'conflict', rounds: 1 });
    await round(id, 1, ['src/a.ts']);
    expect(await read()).toEqual({ conflict_round: { running: true, attempt: 1, of: OF, base_ref: 'main' } });
    await admin.query(`UPDATE merge_queue_entries SET state = 'queued', work_kind = NULL, work_run_id = NULL WHERE id = $1`, [id]);
    expect(await read()).toBeNull();
  });

  it('a delta review is not a conflict round', async () => {
    await entry('awaiting_work', { workKind: 'delta_review' });
    expect(await read()).toBeNull();
  });

  it('a stop after the rounds were tried says how many, with the newest round\'s files and branch', async () => {
    const id = await entry('stopped', { reason: 'merge_conflict', rounds: 2 });
    await round(id, 1, ['old.ts']);
    await round(id, 2, ['src/a.ts', 'src/b.ts'], 'release/1.x');
    await stopEvent(2, 'rounds_exhausted', { baseRef: 'release/1.x' });
    expect(await read()).toEqual({ conflict_stop: { kind: 'attempts_spent', attempts: 2, files: ['src/a.ts', 'src/b.ts'], base_ref: 'release/1.x' } });
  });

  it('a foreign-commits stop carries the files and branch from the event detail', async () => {
    await entry('stopped', { reason: 'merge_conflict' });
    await stopEvent(0, 'foreign_commits', { conflictFiles: ['src/a.ts'], baseRef: 'main' });
    expect(await read()).toEqual({ conflict_stop: { kind: 'foreign_commits', attempts: 0, files: ['src/a.ts'], base_ref: 'main' } });
  });

  it('a stop where no round ran is the direct kind, with the branch only when it was recorded', async () => {
    await entry('stopped', { reason: 'merge_conflict' });
    expect(await read()).toEqual({ conflict_stop: { kind: 'direct', attempts: 0, files: [], base_ref: null } });
    await stopEvent(0, 'identity_unread', { baseRef: 'main' });
    expect(await read()).toEqual({ conflict_stop: { kind: 'direct', attempts: 0, files: [], base_ref: 'main' } });
  });

  describe('an old stop is never read as this stop', () => {
    const FOREIGN = { kind: 'foreign_commits', attempts: 0, files: ['src/a.ts'], base_ref: 'main' };
    const age = () => admin.query(`UPDATE work_item_driver_events SET created_at = now() - interval '1 hour' WHERE work_item_id = $1`, [refs.workItemId]);

    it('stopped, requeued at the same head, stopped again with no new event: the first stop\'s files are not shown (direct)', async () => {
      const id = await entry('stopped', { reason: 'merge_conflict' });
      await stopEvent(0, 'foreign_commits', { conflictFiles: ['src/a.ts'], baseRef: 'main' });
      expect(await read()).toEqual({ conflict_stop: FOREIGN });
      // The same entry row goes back to the queue and stops again, at the same head and round count, and this stop wrote no event.
      await admin.query(`UPDATE merge_queue_entries SET state = 'queued', reason = NULL WHERE id = $1`, [id]);
      await age();
      await admin.query(`UPDATE merge_queue_entries SET state = 'stopped', reason = 'merge_conflict' WHERE id = $1`, [id]);
      expect(await read()).toEqual({ conflict_stop: { kind: 'direct', attempts: 0, files: [], base_ref: null } });
    });

    it('an event just before or just after the entry\'s stop belongs to it (the stop is recorded on either side of the entry\'s move)', async () => {
      const id = await entry('stopped', { reason: 'merge_conflict' });
      await stopEvent(0, 'foreign_commits', { conflictFiles: ['src/a.ts'], baseRef: 'main' });
      await admin.query(`UPDATE work_item_driver_events SET created_at = now() - interval '30 seconds' WHERE work_item_id = $1`, [refs.workItemId]);
      expect(await read()).toEqual({ conflict_stop: FOREIGN });
      await admin.query(`UPDATE work_item_driver_events SET created_at = now() + interval '30 seconds' WHERE work_item_id = $1`, [refs.workItemId]);
      expect(await read()).toEqual({ conflict_stop: FOREIGN });
      await admin.query(`UPDATE work_item_driver_events SET created_at = now() - interval '5 minutes' WHERE work_item_id = $1`, [refs.workItemId]);
      expect(await read()).toEqual({ conflict_stop: { kind: 'direct', attempts: 0, files: [], base_ref: null } });
      await admin.query(`UPDATE work_item_driver_events SET created_at = now() + interval '5 minutes' WHERE work_item_id = $1`, [refs.workItemId]);
      expect(await read()).toEqual({ conflict_stop: { kind: 'direct', attempts: 0, files: [], base_ref: null } });
      expect(id).toBeTruthy();
    });

    it('an event at another round count is excluded', async () => {
      const id = await entry('stopped', { reason: 'merge_conflict', rounds: 2 });
      await round(id, 1, ['src/a.ts']);
      await round(id, 2, ['src/b.ts']);
      await stopEvent(1, 'foreign_commits', { conflictFiles: ['src/a.ts'], baseRef: 'main' });
      expect(await read()).toEqual({ conflict_stop: { kind: 'attempts_spent', attempts: 2, files: ['src/b.ts'], base_ref: 'main' } });
    });

    it('an event for another pull request is excluded', async () => {
      await entry('stopped', { reason: 'merge_conflict' });
      await withTenant(appUserPool, refs.accountId, (c) =>
        recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'stopped', dedupeKey: 'other-pr', code: 'merge_conflict', reasons: ['foreign_commits'], headSha: head, prNumber: 8, round: 0, detail: { conflictFiles: ['src/a.ts'], baseRef: 'main' } }),
      );
      expect(await read()).toEqual({ conflict_stop: { kind: 'direct', attempts: 0, files: [], base_ref: null } });
    });
  });

  it('another stop reason is not a merge conflict', async () => {
    await entry('stopped', { reason: 'ci_not_green' });
    expect(await read()).toBeNull();
  });
});
