import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import { MemoryInputError, repoScopeRef, type MemoryCtx } from '../src/memory/index.js';
import { decideMemoryBatch, markMemoryOpened } from '../src/memory/batch.js';

const NODE = 'R_kgDOQueue01';

/** D#601 MEM-4a1a: the opened state and the batch calls, against a real Postgres with row security forced. */
describe('memory batch and opened state (D#601 MEM-4a1a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;
  let bAdmin: string;
  let repoRef: string;
  let n = 0;

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  const ctx = (accountId: string, userId: string): MemoryCtx => ({ pool: appPool, principal: { accountId, userId }, liveSecrets: () => [] as string[] });
  const text = (what: string) => `${what} ${++n} ${randomUUID()}`;
  /** An agent or import proposal, written the way the pipeline does (no user in the session). */
  const proposal = (accountId: string, over: Partial<{ author: 'agent' | 'import' | 'runner_agent' | 'assistant'; prov: Record<string, string>; scope: 'repo' | 'item'; ref: string }> = {}): Promise<string> =>
    withTenant(appPool, accountId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT memory_propose($1, $2, 'fact', $3, NULL, $4, $5::jsonb) AS id`, [
        over.scope ?? 'repo',
        over.ref ?? repoRef,
        text('proposal'),
        over.author ?? 'import',
        JSON.stringify(over.prov ?? { source_path: 'CLAUDE.md', source_commit: 'abcdef0123456789' }),
      ]);
      return rows[0]!.id;
    });
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    bAdmin = await addMember(b.accountId, 'admin');
    const inst = (await admin.query<{ g: string }>(`SELECT gh_installation_id::text AS g FROM installations WHERE id = $1`, [a.installationId])).rows[0]!.g;
    await admin.query(`UPDATE repos SET gh_node_id = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1`, [a.repoId, NODE]);
    await admin.query(`UPDATE work_items SET title = 'Add the thing', gh_number = 42 WHERE id = $1`, [a.workItemId]);
    repoRef = repoScopeRef(NODE, inst);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  describe('markMemoryOpened', () => {
    it('a member may not open a repo card (Forbidden) and another account gets NotFound; an agent card needs no record', async () => {
      const imp = await proposal(a.accountId);
      await expect(markMemoryOpened(ctx(a.accountId, aMember), imp)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markMemoryOpened(ctx(b.accountId, bAdmin), imp)).rejects.toBeInstanceOf(NotFoundError);
      expect((await admin.query(`SELECT 1 FROM memory_entry_opens WHERE entry_id = $1`, [imp])).rowCount).toBe(0);
      expect(await markMemoryOpened(ctx(a.accountId, aAdmin), imp)).toEqual({ opened: true });
      const agent = await proposal(a.accountId, { author: 'agent', prov: {} });
      expect(await markMemoryOpened(ctx(a.accountId, aAdmin), agent)).toEqual({ opened: false });
    });
  });

  describe('the batch (section 2 acceptance 1 to 6)', () => {
    it('refuses 3 imports when 1 is unopened with must_open_first and the count, and nothing changes; opening all lets it through', async () => {
      const ids = [await proposal(a.accountId), await proposal(a.accountId), await proposal(a.accountId)];
      await markMemoryOpened(ctx(a.accountId, aAdmin), ids[0]!);
      await markMemoryOpened(ctx(a.accountId, aAdmin), ids[1]!);
      const err = (await decideMemoryBatch(ctx(a.accountId, aAdmin), { ids, to: 'approved' }).catch((e: unknown) => e)) as MemoryInputError;
      expect(err).toBeInstanceOf(MemoryInputError);
      expect(err).toMatchObject({ code: 'must_open_first', unopened: 1 });
      expect(err.message).toBe('1 of 3 cards have not been opened');
      expect((await admin.query(`SELECT status FROM memory_entries WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.status)).toEqual(['proposed', 'proposed', 'proposed']);
      await markMemoryOpened(ctx(a.accountId, aAdmin), ids[2]!);
      const done = await decideMemoryBatch(ctx(a.accountId, aAdmin), { ids, to: 'approved' });
      expect(done.decided).toBe(3);
      expect(done.entries.map((e) => e.status)).toEqual(['approved', 'approved', 'approved']);
    });
    it('refuses a mix of sources with mixed_sources, 21 ids, and a decision a batch does not make', async () => {
      const imp = await proposal(a.accountId);
      const agent = await proposal(a.accountId, { author: 'agent', prov: {} });
      await expect(decideMemoryBatch(ctx(a.accountId, aAdmin), { ids: [imp, agent], to: 'approved' })).rejects.toMatchObject({ code: 'mixed_sources' });
      await expect(decideMemoryBatch(ctx(a.accountId, aAdmin), { ids: Array.from({ length: 21 }, () => randomUUID()), to: 'approved' })).rejects.toMatchObject({ code: 'invalid_message' });
      await expect(decideMemoryBatch(ctx(a.accountId, aAdmin), { ids: [agent], to: 'retired' as never })).rejects.toMatchObject({ code: 'invalid_message' });
      await expect(decideMemoryBatch(ctx(a.accountId, aAdmin), { ids: [], to: 'approved' })).rejects.toMatchObject({ code: 'invalid_message' });
      await expect(decideMemoryBatch(ctx(a.accountId, aAdmin), { ids: ['nope'], to: 'approved' })).rejects.toBeInstanceOf(NotFoundError);
    });
    it('a member is Forbidden on a repo batch, and another account id is NotFound; an agent batch needs no open', async () => {
      const agent = await proposal(a.accountId, { author: 'agent', prov: {} });
      await expect(decideMemoryBatch(ctx(a.accountId, aMember), { ids: [agent], to: 'approved' })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideMemoryBatch(ctx(b.accountId, bAdmin), { ids: [agent], to: 'approved' })).rejects.toBeInstanceOf(NotFoundError);
      expect((await decideMemoryBatch(ctx(a.accountId, aAdmin), { ids: [agent], to: 'rejected' })).entries[0]!.status).toBe('rejected');
    });
  });

});
