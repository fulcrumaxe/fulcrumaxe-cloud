import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import { WORK_ITEM_STAGES } from '../src/work-items/stages.js';
import { compareQueueOrder } from '../src/work-items/queueOrder.js';
import {
  NotReorderableError,
  QueueRankRangeError,
  setWorkItemPriority,
  toQueueRank,
  type PriorityMove,
} from '../src/work-items/priority.js';

/** D#2 H26b against a real Postgres cluster: role gate, tenant binding, ordering, atomicity. */
describe('setWorkItemPriority (D#2 H26b)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

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

  interface Tenant extends SeedRefs {
    adminId: string;
    memberId: string;
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }

  async function tenant(): Promise<Tenant> {
    const refs = await seedAccount(admin, randomUUID());
    return { ...refs, adminId: await addMember(refs.accountId, 'admin'), memberId: await addMember(refs.accountId, 'member') };
  }

  async function item(t: SeedRefs, opts: { priority?: number; rank?: string | number | null; stage?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, priority, queue_rank, stage)
       VALUES ($1, $2, $3, 'bug', 'internal', $4, $5, $6)`,
      [id, t.accountId, t.repoId, opts.priority ?? 2, opts.rank ?? null, opts.stage ?? 'triaged'],
    );
    return id;
  }

  const as = (t: Tenant, who: 'owner' | 'admin' | 'member') => ({
    pool: appUserPool,
    principal: { accountId: t.accountId, userId: who === 'owner' ? t.userId : who === 'admin' ? t.adminId : t.memberId },
  });

  async function row(id: string) {
    const { rows } = await admin.query<{ priority: number; queue_rank: string | null; stage: string }>(
      `SELECT priority, queue_rank, stage FROM work_items WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function audits(t: SeedRefs) {
    const { rows } = await admin.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.priority_changed' ORDER BY created_at`,
      [t.accountId],
    );
    return rows;
  }

  async function events(t: SeedRefs) {
    const { rows } = await admin.query<{ subject_id: string; payload: Record<string, unknown> }>(
      `SELECT subject_id, payload FROM domain_events WHERE account_id = $1 AND type = 'work_item.priority_changed'`,
      [t.accountId],
    );
    return rows;
  }

  /** The queue order of one priority bucket as the database holds it, using the shipped comparator. */
  async function order(t: SeedRefs, priority: number): Promise<string[]> {
    const { rows } = await admin.query<{ id: string; priority: number; queue_rank: string | null; created_at: Date }>(
      `SELECT id, priority, queue_rank, created_at FROM work_items WHERE account_id = $1 AND priority = $2 AND id <> $3`,
      [t.accountId, priority, t.workItemId],
    );
    return rows
      .map((r) => ({ id: r.id, priority: r.priority, queueRank: toQueueRank(r.queue_rank), createdAt: r.created_at }))
      .sort(compareQueueOrder)
      .map((r) => r.id);
  }

  describe('the role gate lives in the service', () => {
    it('an owner session and an admin (as a token principal would arrive) both change it, with one audit row and one event each', async () => {
      const t = await tenant();
      const a = await item(t);
      const b = await item(t);
      expect(await setWorkItemPriority(as(t, 'owner'), { workItemId: a, priority: 0 })).toMatchObject({ priority: 0, changed: true });
      // A token principal carries its creator's current role and is the same shape as a session's.
      expect(await setWorkItemPriority(as(t, 'admin'), { workItemId: b, priority: 1 })).toMatchObject({ priority: 1, changed: true });
      expect((await row(a)).priority).toBe(0);
      expect((await row(b)).priority).toBe(1);
      const log = await audits(t);
      expect(log.map((r) => r.actor)).toEqual([t.userId, t.adminId]);
      expect(log[0]!.payload).toMatchObject({
        work_item_id: a,
        before: { priority: 2, queue_rank: null },
        after: { priority: 0, queue_rank: null },
      });
      expect((await events(t)).map((e) => e.subject_id).sort()).toEqual([a, b].sort());
    });

    it('a member, session or token, gets a ForbiddenError and nothing changes', async () => {
      const t = await tenant();
      const a = await item(t);
      for (let i = 0; i < 2; i++) {
        await expect(setWorkItemPriority(as(t, 'member'), { workItemId: a, priority: 0 })).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect(await row(a)).toMatchObject({ priority: 2, queue_rank: null });
      expect(await audits(t)).toHaveLength(0);
      expect(await events(t)).toHaveLength(0);
    });

    it('a non-member of the account is a NotFoundError', async () => {
      const t = await tenant();
      const a = await item(t);
      const stranger = { pool: appUserPool, principal: { accountId: t.accountId, userId: randomUUID() } };
      await expect(setWorkItemPriority(stranger, { workItemId: a, priority: 0 })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('tenant binding', () => {
    it("another tenant's item is a NotFoundError, and neither tenant gets a row or event", async () => {
      const t1 = await tenant();
      const t2 = await tenant();
      const other = await item(t2);
      await expect(setWorkItemPriority(as(t1, 'owner'), { workItemId: other, priority: 0 })).rejects.toBeInstanceOf(NotFoundError);
      await expect(setWorkItemPriority(as(t1, 'owner'), { workItemId: randomUUID(), priority: 0 })).rejects.toBeInstanceOf(NotFoundError);
      await expect(setWorkItemPriority(as(t1, 'owner'), { workItemId: 'nope', priority: 0 })).rejects.toBeInstanceOf(NotFoundError);
      expect(await row(other)).toMatchObject({ priority: 2 });
      for (const t of [t1, t2]) {
        expect(await audits(t)).toHaveLength(0);
        expect(await events(t)).toHaveLength(0);
      }
    });

    it("a move before another tenant's item is refused and renumbers nothing there", async () => {
      const t1 = await tenant();
      const t2 = await tenant();
      const mine = await item(t1);
      const theirs = await item(t2, { rank: 5 });
      await expect(setWorkItemPriority(as(t1, 'owner'), { workItemId: mine, move: { before: theirs } })).rejects.toThrow();
      expect(await row(theirs)).toMatchObject({ queue_rank: '5' });
      expect(await row(mine)).toMatchObject({ queue_rank: null });
    });
  });

  describe('terminal stages (one row per stage)', () => {
    it.each(WORK_ITEM_STAGES.map((s) => [s]))('%s', async (stage) => {
      const t = await tenant();
      const id = await item(t, { stage });
      const terminal = ['merged', 'closed_unmerged', 'closed'].includes(stage);
      const run = setWorkItemPriority(as(t, 'owner'), { workItemId: id, priority: 1 });
      if (terminal) {
        await expect(run).rejects.toBeInstanceOf(NotReorderableError);
        expect((await row(id)).priority).toBe(2);
        expect(await audits(t)).toHaveLength(0);
      } else {
        await expect(run).resolves.toMatchObject({ priority: 1 });
        expect((await row(id)).priority).toBe(1);
      }
    });

    it('a reopened item (closed -> triaged) is reorderable again', async () => {
      const t = await tenant();
      const id = await item(t, { stage: 'closed' });
      await expect(setWorkItemPriority(as(t, 'owner'), { workItemId: id, priority: 0 })).rejects.toBeInstanceOf(NotReorderableError);
      await admin.query(`UPDATE work_items SET stage = 'triaged' WHERE id = $1`, [id]);
      await expect(setWorkItemPriority(as(t, 'owner'), { workItemId: id, priority: 0 })).resolves.toMatchObject({ priority: 0 });
    });
  });

  describe('moves', () => {
    async function four(t: SeedRefs) {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await item(t, { rank: (i + 1) * 1024 }));
      return ids as [string, string, string, string];
    }
    const move = (t: Tenant, workItemId: string, m: PriorityMove) => setWorkItemPriority(as(t, 'owner'), { workItemId, move: m });

    it('top, up, down and before reorder the bucket', async () => {
      const t = await tenant();
      const [a, b, c, d] = await four(t);
      await move(t, d, 'top');
      expect(await order(t, 2)).toEqual([d, a, b, c]);
      await move(t, c, 'up');
      expect(await order(t, 2)).toEqual([d, a, c, b]);
      await move(t, d, 'down');
      expect(await order(t, 2)).toEqual([a, d, c, b]);
      await move(t, b, { before: d });
      expect(await order(t, 2)).toEqual([a, b, d, c]);
    });

    it('a move that changes nothing writes no audit row and no event', async () => {
      const t = await tenant();
      const [a] = await four(t);
      expect(await move(t, a, 'top')).toMatchObject({ changed: false });
      expect(await move(t, a, 'up')).toMatchObject({ changed: false });
      expect(await audits(t)).toHaveLength(0);
      expect(await events(t)).toHaveLength(0);
    });

    it('takes the middle of a gap and touches only one row while there is room', async () => {
      const t = await tenant();
      const [a, b, c] = await four(t);
      const res = await move(t, c, { before: b });
      expect(res.queueRank).toBe(1536);
      expect((await audits(t))[0]!.payload.renumbered).toBe(0);
      expect(await row(a)).toMatchObject({ queue_rank: '1024' });
    });

    it('renumbers the bucket in gaps of 1,024 when a gap runs out', async () => {
      const t = await tenant();
      const a = await item(t, { rank: 1 });
      const b = await item(t, { rank: 2 });
      const c = await item(t, { rank: 3 });
      await move(t, c, { before: b });
      expect(await order(t, 2)).toEqual([a, c, b]);
      expect([(await row(a)).queue_rank, (await row(c)).queue_rank, (await row(b)).queue_rank]).toEqual(['1024', '2048', '3072']);
      expect((await audits(t))[0]!.payload.renumbered).toBe(3); // a, b and the account's unranked seeded item
    });

    it('ranks 9 and 10 compare as numbers, so a move between them is not mis-ordered', async () => {
      const t = await tenant();
      const nine = await item(t, { rank: 9 });
      const ten = await item(t, { rank: 10 });
      const z = await item(t, { rank: 20 });
      await move(t, z, { before: ten });
      expect(await order(t, 2)).toEqual([nine, z, ten]);
      const t2 = await tenant();
      const p = await item(t2, { rank: 9 });
      const q = await item(t2, { rank: 10 });
      const r = await item(t2, { rank: 100 });
      await move(t2, r, 'top');
      expect(await order(t2, 2)).toEqual([r, p, q]);
    });

    it('fails loudly on a stored rank above the safe-integer limit and changes nothing', async () => {
      const t = await tenant();
      const big = await item(t, { rank: '9007199254740993' });
      const other = await item(t, { rank: 5 });
      await expect(move(t, other, 'top')).rejects.toBeInstanceOf(QueueRankRangeError);
      expect(await row(big)).toMatchObject({ queue_rank: '9007199254740993' });
      expect(await row(other)).toMatchObject({ queue_rank: '5' });
      expect(await audits(t)).toHaveLength(0);
    });

    it('a priority change clears the rank; with a move it lands where asked in the new bucket', async () => {
      const t = await tenant();
      const a = await item(t, { rank: 4096 });
      const low = await item(t, { priority: 3, rank: 1024 });
      await setWorkItemPriority(as(t, 'owner'), { workItemId: a, priority: 3 });
      expect(await row(a)).toMatchObject({ priority: 3, queue_rank: null });
      await setWorkItemPriority(as(t, 'owner'), { workItemId: a, priority: 3, move: 'top' });
      expect(await order(t, 3)).toEqual([a, low]);
      const b = await item(t);
      await setWorkItemPriority(as(t, 'owner'), { workItemId: b, priority: 3, move: { before: low } });
      expect(await order(t, 3)).toEqual([a, b, low]);
    });

    it('a rank can go ahead of unranked items and behind a ranked one', async () => {
      const t = await tenant();
      const ranked = await item(t, { rank: 1024 });
      const u1 = await item(t);
      const u2 = await item(t);
      await move(t, u2, { before: u1 });
      expect(await order(t, 2)).toEqual([ranked, u2, u1]);
    });

    it('a priority-4 or unknown move is refused before anything is written', async () => {
      const t = await tenant();
      const a = await item(t);
      await expect(move(t, a, { before: randomUUID() })).rejects.toThrow(/before must name/);
      expect(await audits(t)).toHaveLength(0);
    });
  });

  describe('atomicity: the change, its audit row and its event commit together', () => {
    async function withTrigger<T>(table: 'audit_log' | 'domain_events', column: string, value: string, fn: () => Promise<T>): Promise<T> {
      const name = `h26b_fail_${table}`;
      await admin.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN IF NEW.${column} = '${value}' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $f$`,
      );
      await admin.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      try {
        return await fn();
      } finally {
        await admin.query(`DROP TRIGGER ${name} ON ${table}`);
        await admin.query(`DROP FUNCTION ${name}()`);
      }
    }

    it('a domain event that fails to write rolls back the update and the audit row', async () => {
      const t = await tenant();
      const a = await item(t, { rank: 7 });
      await withTrigger('domain_events', 'type', 'work_item.priority_changed', async () => {
        await expect(setWorkItemPriority(as(t, 'owner'), { workItemId: a, priority: 0 })).rejects.toThrow(/forced failure/);
      });
      expect(await row(a)).toMatchObject({ priority: 2, queue_rank: '7' });
      expect(await audits(t)).toHaveLength(0);
      expect(await events(t)).toHaveLength(0);
    });

    it('a forced audit failure rolls back the update (and writes no event)', async () => {
      const t = await tenant();
      const a = await item(t, { rank: 7 });
      const b = await item(t, { rank: 8 });
      await withTrigger('audit_log', 'action', 'work_item.priority_changed', async () => {
        await expect(setWorkItemPriority(as(t, 'owner'), { workItemId: a, move: { before: b } })).rejects.toThrow(/forced failure/);
        await expect(setWorkItemPriority(as(t, 'owner'), { workItemId: b, priority: 0 })).rejects.toThrow(/forced failure/);
      });
      expect(await row(a)).toMatchObject({ priority: 2, queue_rank: '7' });
      expect(await row(b)).toMatchObject({ priority: 2, queue_rank: '8' });
      expect(await audits(t)).toHaveLength(0);
      expect(await events(t)).toHaveLength(0);
    });

    it('a renumbering that then fails to audit leaves every peer rank untouched', async () => {
      const t = await tenant();
      const a = await item(t, { rank: 1 });
      const b = await item(t, { rank: 2 });
      const c = await item(t, { rank: 3 });
      await withTrigger('audit_log', 'action', 'work_item.priority_changed', async () => {
        await expect(setWorkItemPriority(as(t, 'owner'), { workItemId: c, move: { before: b } })).rejects.toThrow(/forced failure/);
      });
      expect([(await row(a)).queue_rank, (await row(b)).queue_rank, (await row(c)).queue_rank]).toEqual(['1', '2', '3']);
    });
  });
});
