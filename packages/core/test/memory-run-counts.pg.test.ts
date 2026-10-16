import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { MEMORY_RUN_COUNT_MAX_IDS, memoryRunCounts } from '../src/memory/runCounts.js';
import { MemoryInputError, deleteMemory, editMemory, writeMemory } from '../src/memory/index.js';
import { getRunContext } from '../src/runs/contextPanel.js';

/** D#601 MEM-3r: "Used in N runs" over run_context_inputs (migration 0833), real Postgres with row security forced. */
describe('memoryRunCounts (D#601 MEM-3r)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let bAdmin: string;
  let n = 0;

  async function addAdmin(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [accountId, id]);
    return id;
  }
  const ctx = (accountId: string, userId: string) => ({ pool: appPool, principal: { accountId, userId }, liveSecrets: () => [] as string[] });
  const entry = async (accountId: string, userId: string) =>
    writeMemory(ctx(accountId, userId), { scope: 'account', scopeRef: null, kind: 'fact', body: `run counts fact ${++n} ${randomUUID()}` });
  const panelOf = (accountId: string, userId: string, runId: string) => getRunContext({ pool: appPool, principal: { accountId, userId } }, runId);
  /** A finished run with a ledger row (the panel needs one) that recalled the given entries. */
  async function runRecalling(accountId: string, entries: Array<{ id: string; version: number }>): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'production', 'succeeded')`, [id, accountId]);
    await admin.query(`INSERT INTO run_context_ledger (account_id, run_id, sections, tool_output_bytes, compactions, basis) VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb, 0, 'partial')`, [accountId, id]);
    if (entries.length > 0) {
      await admin.query(`INSERT INTO run_context_inputs (account_id, run_id, recalled_entry_ids, recalled_entry_versions) VALUES ($1, $2, $3::uuid[], $4::integer[])`, [
        accountId,
        id,
        entries.map((e) => e.id),
        entries.map((e) => e.version),
      ]);
    }
    return id;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addAdmin(a.accountId);
    bAdmin = await addAdmin(b.accountId);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('1. an entry recalled by 3 runs reports 3; one never recalled reports 0 as a number', async () => {
    const used = await entry(a.accountId, aAdmin);
    const unused = await entry(a.accountId, aAdmin);
    for (let i = 0; i < 3; i++) await runRecalling(a.accountId, [{ id: used.id, version: 1 }]);
    const r = await memoryRunCounts(ctx(a.accountId, aAdmin), [used.id, unused.id]);
    expect(r).toEqual({ [used.id]: 3, [unused.id]: 0 });
    expect(typeof r[unused.id]).toBe('number');
  });

  it('2. an edit does not reset the number: the lineage counts 2 whichever version is asked, and the first run still shows version 1', async () => {
    const v1 = await entry(a.accountId, aAdmin);
    const run1 = await runRecalling(a.accountId, [{ id: v1.id, version: 1 }]);
    const v2 = await editMemory(ctx(a.accountId, aAdmin), { id: v1.id, body: `edited ${randomUUID()}` });
    expect(v2.version).toBe(2);
    const v3 = await editMemory(ctx(a.accountId, aAdmin), { id: v2.id, body: `edited again ${randomUUID()}` });
    const run2 = await runRecalling(a.accountId, [{ id: v2.id, version: 2 }]);
    expect(await memoryRunCounts(ctx(a.accountId, aAdmin), [v1.id, v2.id, v3.id])).toEqual({ [v1.id]: 2, [v2.id]: 2, [v3.id]: 2 });
    expect((await panelOf(a.accountId, aAdmin, run1)).recalled_memory.map((m) => [m.id, m.version])).toEqual([[v1.id, 1]]);
    expect((await panelOf(a.accountId, aAdmin, run2)).recalled_memory.map((m) => [m.id, m.version])).toEqual([[v2.id, 2]]);
  });

  it('3. two entries recalled by one run each count that run once; two versions of one lineage in one run count it once', async () => {
    const x = await entry(a.accountId, aAdmin);
    const y = await entry(a.accountId, aAdmin);
    await runRecalling(a.accountId, [{ id: x.id, version: 1 }, { id: y.id, version: 1 }]);
    expect(await memoryRunCounts(ctx(a.accountId, aAdmin), [x.id, y.id])).toEqual({ [x.id]: 1, [y.id]: 1 });
    const z1 = await entry(a.accountId, aAdmin);
    const z2 = await editMemory(ctx(a.accountId, aAdmin), { id: z1.id, body: `z two ${randomUUID()}` });
    await runRecalling(a.accountId, [{ id: z1.id, version: 1 }, { id: z2.id, version: 2 }]);
    expect(await memoryRunCounts(ctx(a.accountId, aAdmin), [z1.id, z2.id])).toEqual({ [z1.id]: 1, [z2.id]: 1 });
  });

  it("4. another account's runs never count: B's numbers do not move when A's runs recall, and A's row naming B's id does not reach B", async () => {
    const mineB = await entry(b.accountId, bAdmin);
    const theirsA = await entry(a.accountId, aAdmin);
    const before = await memoryRunCounts(ctx(b.accountId, bAdmin), [mineB.id, theirsA.id]);
    await runRecalling(a.accountId, [{ id: theirsA.id, version: 1 }]);
    await runRecalling(a.accountId, [{ id: theirsA.id, version: 1 }]);
    expect(await memoryRunCounts(ctx(b.accountId, bAdmin), [mineB.id, theirsA.id])).toEqual(before);
    expect(before[theirsA.id]).toBe(0);
    await runRecalling(a.accountId, [{ id: mineB.id, version: 1 }]);
    expect((await memoryRunCounts(ctx(b.accountId, bAdmin), [mineB.id]))[mineB.id]).toBe(0);
    expect((await memoryRunCounts(ctx(a.accountId, aAdmin), [theirsA.id]))[theirsA.id]).toBe(2);
  });

  it('5. (C3) a purge recomputes over the surviving rows: the newest purged leaves v1 and v2 at 2 and its run reads "Deleted entry"; an older row with a successor cannot be purged', async () => {
    const c = ctx(a.accountId, aAdmin);
    const lineage = async () => {
      const v1 = await entry(a.accountId, aAdmin);
      const v2 = await editMemory(c, { id: v1.id, body: `v two ${randomUUID()}` });
      const v3 = await editMemory(c, { id: v2.id, body: `v three ${randomUUID()}` });
      const rA = await runRecalling(a.accountId, [{ id: v1.id, version: 1 }]);
      const rB = await runRecalling(a.accountId, [{ id: v2.id, version: 2 }]);
      const rC = await runRecalling(a.accountId, [{ id: v3.id, version: 3 }]);
      return { v1, v2, v3, rA, rB, rC };
    };
    const purge = async (id: string) => {
      await admin.query(`DELETE FROM memory_entries WHERE id = $1`, [id]);
    };
    // The newest (an approved head is deleted, then purged after 30 days) goes.
    const x = await lineage();
    expect(await memoryRunCounts(c, [x.v1.id, x.v2.id, x.v3.id])).toEqual({ [x.v1.id]: 3, [x.v2.id]: 3, [x.v3.id]: 3 });
    await deleteMemory(c, { id: x.v3.id });
    await admin.query(`UPDATE memory_entries SET deleted_at = now() - interval '31 days' WHERE id = $1`, [x.v3.id]);
    await purge(x.v3.id);
    const afterNewest = await memoryRunCounts(c, [x.v1.id, x.v2.id, x.v3.id]);
    expect(afterNewest[x.v1.id]).toBe(2);
    expect(afterNewest[x.v2.id]).toBe(2);
    expect(afterNewest[x.v3.id]).toBe(0);
    expect((await panelOf(a.accountId, aAdmin, x.rC)).recalled_memory).toEqual([{ id: x.v3.id, name: 'Deleted entry', version: 3 }]);
    // C3's second case (the oldest purged) cannot happen on the real schema: the ON DELETE SET NULL on supersedes_id would leave a version above 1
    // with no predecessor, which memory_entries_version_check refuses, so the database refuses to delete any row that has a successor and nothing
    // changes. Only the newest row of a lineage can be purged, so a lineage is never split. Asserted here so a later schema change shows up.
    const y = await lineage();
    for (const id of [y.v1.id, y.v2.id]) {
      await expect(purge(id)).rejects.toMatchObject({ code: '23514' });
    }
    expect(await memoryRunCounts(c, [y.v1.id, y.v2.id, y.v3.id])).toEqual({ [y.v1.id]: 3, [y.v2.id]: 3, [y.v3.id]: 3 });
  });

  it('6. the panel lists exactly the ids and versions in the run row, no name is null, and the count read agrees', async () => {
    const x = await entry(a.accountId, aAdmin);
    const y = await entry(a.accountId, aAdmin);
    const y2 = await editMemory(ctx(a.accountId, aAdmin), { id: y.id, body: `y two ${randomUUID()}` });
    const run = await runRecalling(a.accountId, [{ id: x.id, version: 1 }, { id: y2.id, version: 2 }]);
    const panel = await panelOf(a.accountId, aAdmin, run);
    const row = (await admin.query(`SELECT recalled_entry_ids, recalled_entry_versions FROM run_context_inputs WHERE run_id = $1`, [run])).rows[0];
    expect(panel.recalled_memory.map((m) => [m.id, m.version])).toEqual(row.recalled_entry_ids.map((id: string, i: number) => [id, row.recalled_entry_versions[i]]));
    for (const m of panel.recalled_memory) {
      expect(typeof m.name).toBe('string');
      expect(m.name).not.toMatch(/^(null|undefined)$/);
    }
    expect(Object.values(await memoryRunCounts(ctx(a.accountId, aAdmin), panel.recalled_memory.map((m) => m.id)))).toEqual([1, 1]);
  });

  it('8. refuses more than 200 ids and a malformed id, answers an empty list; the GIN index exists and nobody gains a grant', async () => {
    const c = ctx(a.accountId, aAdmin);
    const ids = Array.from({ length: MEMORY_RUN_COUNT_MAX_IDS + 1 }, () => randomUUID());
    await expect(memoryRunCounts(c, ids)).rejects.toBeInstanceOf(MemoryInputError);
    await expect(memoryRunCounts(c, ids)).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(memoryRunCounts(c, ['not-a-uuid'])).rejects.toMatchObject({ code: 'invalid_message' });
    expect(await memoryRunCounts(c, [])).toEqual({});
    expect(Object.keys(await memoryRunCounts(c, ids.slice(0, MEMORY_RUN_COUNT_MAX_IDS))).length).toBe(MEMORY_RUN_COUNT_MAX_IDS);
    const idx = await admin.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'run_context_inputs' AND indexname = 'run_context_inputs_recalled_idx'`);
    expect(idx.rows[0]?.indexdef).toMatch(/USING gin \(recalled_entry_ids\)/);
    const grants = await admin.query(`SELECT grantee, privilege_type FROM information_schema.table_privileges WHERE table_name = 'run_context_inputs' AND grantee IN ('memory_definer', 'platform_ops', 'PUBLIC')`);
    expect(grants.rows).toEqual([]);
  });
});
