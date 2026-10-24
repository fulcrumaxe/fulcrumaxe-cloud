import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../src/tenancy/errors.js';
import { decideMemory, deleteMemory, editMemory, proposeMemory, writeMemory } from '../src/memory/index.js';
import { memoryHistory, memoryHistoryActor } from '../src/memory/history.js';

/** D#601 MEM-4b1: an entry's permanent history, read from its audit rows on real Postgres, across edits, the sweeps and the 30 day purge. */
describe('memoryHistory (D#601 MEM-4b1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
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
  const steps = (h: Awaited<ReturnType<typeof memoryHistory>>) => h.map((e) => `${e.action} ${e.fromStatus ?? '-'}>${e.toStatus ?? '-'} v${e.version}`);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addAdmin(a.accountId);
    bAdmin = await addAdmin(b.accountId);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  it('lists every step of the whole version chain, oldest first, whichever version is asked, with who did it and no text', async () => {
    const c = ctx(a.accountId, aAdmin);
    const v1 = await proposeMemory(c, { scope: 'account', scopeRef: null, kind: 'fact', body: `history body ${++n}` });
    await decideMemory(c, { id: v1.id, to: 'approved' });
    await decideMemory(c, { id: v1.id, to: 'proposed' }); // Undo of Approve
    const v2 = await editMemory(c, { id: v1.id, body: `history body ${++n} edited` });
    await decideMemory(c, { id: v2.id, to: 'approved' });
    const expected = ['memory.proposed ->proposed v1', 'memory.approved proposed>approved v1', 'memory.reverted approved>proposed v1', 'memory.edited proposed>proposed v2', 'memory.approved proposed>approved v2'];
    expect(steps(await memoryHistory(c, v1.id))).toEqual(expected);
    expect(steps(await memoryHistory(c, v2.id))).toEqual(expected);
    const h = await memoryHistory(c, v2.id);
    expect(h.every((e) => e.actor.kind === 'person' && e.actor.userId === aAdmin)).toBe(true);
    expect(h.map((e) => e.entryId)).toEqual([v1.id, v1.id, v1.id, v2.id, v2.id]);
    expect(JSON.stringify(h)).not.toContain('history body');
  });

  it('shows the sweeps as the system, and stays readable after the 30 day purge removed the entry', async () => {
    const c = ctx(a.accountId, aAdmin);
    const proposal = await proposeMemory(c, { scope: 'account', scopeRef: null, kind: 'fact', body: `history body ${++n}` });
    await admin.query(`UPDATE memory_entries SET expires_at = now() - interval '1 second' WHERE id = $1`, [proposal.id]);
    await opsPool.query(`SELECT memory_sweep_expire(1000)`);
    expect((await memoryHistory(c, proposal.id)).at(-1)).toMatchObject({ action: 'memory.expired', fromStatus: 'proposed', toStatus: 'expired', actor: { kind: 'system', source: 'memory_sweep' } });

    const doomed = await writeMemory(c, { scope: 'account', scopeRef: null, kind: 'fact', body: `history body ${++n}` });
    await deleteMemory(c, { id: doomed.id });
    await admin.query(`UPDATE memory_entries SET deleted_at = now() - interval '31 days' WHERE id = $1`, [doomed.id]);
    await opsPool.query(`SELECT memory_sweep_purge(1000)`);
    expect((await admin.query(`SELECT 1 FROM memory_entries WHERE id = $1`, [doomed.id])).rowCount).toBe(0);
    expect(steps(await memoryHistory(c, doomed.id))).toEqual(['memory.written ->approved v1', 'memory.deleted approved>deleted v1', 'memory.purged deleted>- v1']);
  });

  it("another account's entry and an unknown or malformed id are all NotFound", async () => {
    const theirs = await writeMemory(ctx(b.accountId, bAdmin), { scope: 'account', scopeRef: null, kind: 'fact', body: `history body ${++n}` });
    for (const id of [theirs.id, randomUUID(), 'not-a-uuid']) {
      await expect(memoryHistory(ctx(a.accountId, aAdmin), id)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await memoryHistory(ctx(b.accountId, bAdmin), theirs.id)).toHaveLength(1);
  });

  it('never passes an actor text through: a user id, the two system sources, and anything else is unknown', () => {
    const user = randomUUID();
    expect(memoryHistoryActor(user)).toEqual({ kind: 'person', userId: user });
    expect(memoryHistoryActor('system:pipeline')).toEqual({ kind: 'system', source: 'pipeline' });
    expect(memoryHistoryActor('system:memory_sweep')).toEqual({ kind: 'system', source: 'memory_sweep' });
    for (const other of [null, '', 'system:other', '<script>']) expect(memoryHistoryActor(other)).toEqual({ kind: 'unknown' });
  });
});
