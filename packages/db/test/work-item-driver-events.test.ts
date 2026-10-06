import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/**
 * D#483 P3: work_item_driver_events, the stage driver's recorded decisions. A fixed vocabulary, no free text, append-only,
 * tenant-isolated, and a replayed step writes nothing twice.
 */
describe('work_item_driver_events (D#483 P3)', () => {
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

  const insert = (c: Pool | PoolClient, refs: SeedRefs, over: Record<string, unknown> = {}) => {
    const p = { kind: 'merge_gate', code: 'ready_human_merges', reasons: ['ci_not_green'], head: null, pr: null, round: null, run: null, key: randomUUID(), ...over };
    return c.query(
      `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, round, run_id, dedupe_key)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10) RETURNING id`,
      [refs.accountId, refs.workItemId, p.kind, p.code, p.reasons, p.head, p.pr, p.round, p.run, p.key],
    );
  };

  it('stores a gate outcome with its reason codes and the head it was for', async () => {
    const head = 'a'.repeat(40);
    await insert(admin, refsA, { head, pr: 7, round: 1, reasons: ['ci_not_green', 'auto_merge_not_allowed'] });
    const { rows } = await admin.query<{ reasons: string[]; head_sha: string }>('SELECT reasons, head_sha FROM work_item_driver_events WHERE account_id = $1 AND head_sha = $2', [refsA.accountId, head]);
    expect(rows[0]).toEqual({ reasons: ['ci_not_green', 'auto_merge_not_allowed'], head_sha: head });
  });

  it.each([
    ['an unknown kind', { kind: 'merge_gate_extra' }],
    ['a code with a space or capital', { code: 'Ready human' }],
    ['a code that starts with a digit', { code: '1abc' }],
    ['a reason with free text', { reasons: ['ci not green'] }],
    ['a reason with a comma', { reasons: ['a,b'] }],
    ['more than 20 reasons', { reasons: Array.from({ length: 21 }, (_v, i) => `r${i}`) }],
    ['a head that is not hex', { head: 'zz' + 'a'.repeat(38) }],
    ['a PR number of zero', { pr: 0 }],
    ['an empty dedupe key', { key: '' }],
  ])('refuses %s', async (_name, over) => {
    await expect(insert(admin, refsA, over)).rejects.toMatchObject({ code: expect.stringMatching(/^23514$/) });
  });

  it('a repeat of the same (item, kind, dedupe key) is refused by the unique constraint, which the writer turns into a no-op', async () => {
    const key = randomUUID();
    await insert(admin, refsA, { key });
    await expect(insert(admin, refsA, { key })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await insert(admin, refsA, { key, kind: 'review_status' });
  });

  it("created_at is the database's clock whatever the insert says", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, created_at) VALUES ($1, $2, 'stopped', $3, now() + interval '1 day') RETURNING id`,
      [refsA.accountId, refsA.workItemId, randomUUID()],
    );
    const r = await admin.query<{ future: boolean }>('SELECT created_at > now() + interval \'1 minute\' AS future FROM work_item_driver_events WHERE id = $1', [rows[0]!.id]);
    expect(r.rows[0]!.future).toBe(false);
  });

  it("a row for tenant B's work item under tenant A's account is refused by the foreign key", async () => {
    await expect(
      admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'stopped', $3)`, [refsA.accountId, refsB.workItemId, randomUUID()]),
    ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
  });

  it('deleting the run leaves the event and clears its run id; deleting the work item removes its events', async () => {
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [runId, refsA.accountId, refsA.workItemId]);
    const { rows } = await insert(admin, refsA, { kind: 'fix_round_started', code: null, reasons: [], run: runId });
    await admin.query('DELETE FROM agent_runs WHERE id = $1', [runId]);
    const after = await admin.query<{ run_id: string | null }>('SELECT run_id FROM work_item_driver_events WHERE id = $1', [rows[0].id]);
    expect(after.rows[0]!.run_id).toBeNull();

    const wi = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`, [wi, refsA.accountId, refsA.repoId]);
    await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'stopped', 'k')`, [refsA.accountId, wi]);
    await admin.query('DELETE FROM work_items WHERE id = $1', [wi]);
    const gone = await admin.query('SELECT 1 FROM work_item_driver_events WHERE work_item_id = $1', [wi]);
    expect(gone.rowCount).toBe(0);
  });

  describe('tenancy and grants', () => {
    it('app_user in tenant A reads and appends its own events and sees none of tenant B', async () => {
      await insert(admin, refsB, { kind: 'stopped', code: 'b_only' });
      const seen = await withTenant(appUserPool, refsA.accountId, async (c) => {
        await c.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', 'by_app_user', $3)`, [refsA.accountId, refsA.workItemId, randomUUID()]);
        return (await c.query<{ code: string | null; account_id: string }>('SELECT code, account_id FROM work_item_driver_events')).rows;
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((r) => r.account_id === refsA.accountId)).toBe(true);
      expect(seen.map((r) => r.code)).toContain('by_app_user');
      expect(seen.map((r) => r.code)).not.toContain('b_only');
    });

    it("app_user cannot write another tenant's events", async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, (c) => c.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'stopped', $3)`, [refsB.accountId, refsB.workItemId, randomUUID()])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the history is append-only: app_user can neither update nor delete a row', async () => {
      await expect(withTenant(appUserPool, refsA.accountId, (c) => c.query(`UPDATE work_item_driver_events SET code = 'x'`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(appUserPool, refsA.accountId, (c) => c.query('DELETE FROM work_item_driver_events'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('findRlsViolations returns [] on the migrated schema', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
    });
  });
});
