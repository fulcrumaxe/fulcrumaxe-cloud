import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#598 P3a (migration 0821): work_items.stack_parent_id and the write-time refusals, for any account and any repo. */
describe('migration 0821: work item stack parent (D#598 P3a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let otherRepoId: string;

  async function insertItem(repoId: string | null = a.repoId, account = a.accountId): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`,
      [id, account, repoId],
    );
    return id;
  }

  function link(child: string, parent: string | null, account = a.accountId) {
    return withTenant(appUserPool, account, (c) =>
      c.query(`UPDATE work_items SET stack_parent_id = $3 WHERE account_id = $1 AND id = $2`, [account, child, parent]),
    );
  }

  async function parentOf(id: string): Promise<string | null> {
    const { rows } = await admin.query(`SELECT stack_parent_id FROM work_items WHERE id = $1`, [id]);
    return rows[0].stack_parent_id;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    otherRepoId = randomUUID();
    await admin.query(
      `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 77, 'team')`,
      [otherRepoId, a.accountId, a.installationId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('the column is nullable and a new item has no stack parent', async () => {
    const id = await insertItem();
    expect(await parentOf(id)).toBeNull();
    const { rows } = await admin.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'work_items' AND column_name = 'stack_parent_id'`,
    );
    expect(rows[0]).toEqual({ is_nullable: 'YES', column_default: null });
  });

  it('app_user can set and clear the link on a same-repo parent', async () => {
    const parent = await insertItem();
    const child = await insertItem();
    await link(child, parent);
    expect(await parentOf(child)).toBe(parent);
    await link(child, null);
    expect(await parentOf(child)).toBeNull();
  });

  it('parent_id (provenance) is untouched by a stack link', async () => {
    const parent = await insertItem();
    const child = await insertItem();
    await link(child, parent);
    const { rows } = await admin.query(`SELECT parent_id FROM work_items WHERE id = $1`, [child]);
    expect(rows[0].parent_id).toBeNull();
  });

  it('refuses an item stacked on itself, by the named constraint', async () => {
    const id = await insertItem();
    await expect(link(id, id)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, constraint: 'work_items_stack_not_self' });
  });

  it('refuses a parent in another repo of the same account', async () => {
    const parent = await insertItem(otherRepoId);
    const child = await insertItem();
    await expect(link(child, parent)).rejects.toMatchObject({
      code: PG_ERROR.CHECK_VIOLATION,
      constraint: 'work_items_stack_cross_repo',
    });
    expect(await parentOf(child)).toBeNull();
  });

  it('refuses a link when either item has no repo', async () => {
    const noRepo = await insertItem(null);
    const withRepo = await insertItem();
    await expect(link(withRepo, noRepo)).rejects.toMatchObject({ constraint: 'work_items_stack_cross_repo' });
    await expect(link(noRepo, withRepo)).rejects.toMatchObject({ constraint: 'work_items_stack_cross_repo' });
  });

  it('refuses a parent in another account (the composite FK)', async () => {
    const b = await seedAccount(admin, randomUUID());
    const foreign = await insertItem(b.repoId, b.accountId);
    const child = await insertItem();
    await expect(
      admin.query(`UPDATE work_items SET stack_parent_id = $2 WHERE id = $1`, [child, foreign]),
    ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    await expect(link(child, foreign)).rejects.toThrow();
    expect(await parentOf(child)).toBeNull();
  });

  it('refuses a 2-cycle and a 4-cycle by the named constraint, and leaves the chain as it was', async () => {
    const x = await insertItem();
    const y = await insertItem();
    await link(y, x);
    await expect(link(x, y)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, constraint: 'work_items_stack_cycle' });
    expect(await parentOf(x)).toBeNull();

    const p = await insertItem();
    const q = await insertItem();
    const r = await insertItem();
    const s = await insertItem();
    await link(q, p);
    await link(r, q);
    await link(s, r);
    await expect(link(p, s)).rejects.toMatchObject({ constraint: 'work_items_stack_cycle' });
    expect(await parentOf(p)).toBeNull();
  });

  it('a long chain is allowed, and a cycle through the middle of it is refused', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await insertItem());
    for (let i = 1; i < ids.length; i += 1) await link(ids[i]!, ids[i - 1]!);
    await expect(link(ids[2]!, ids[5]!)).rejects.toMatchObject({ constraint: 'work_items_stack_cycle' });
  });

  it('a direct insert with a cycle-free parent works and an insert pointing at a cross-repo parent is refused', async () => {
    const parent = await insertItem();
    const ok = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stack_parent_id) VALUES ($1, $2, $3, 'feature', 'internal', $4)`,
      [ok, a.accountId, a.repoId, parent],
    );
    expect(await parentOf(ok)).toBe(parent);
    await expect(
      admin.query(
        `INSERT INTO work_items (account_id, repo_id, kind, provenance, stack_parent_id) VALUES ($1, $2, 'feature', 'internal', $3)`,
        [a.accountId, otherRepoId, parent],
      ),
    ).rejects.toMatchObject({ constraint: 'work_items_stack_cross_repo' });
  });

  it('moving a parent to another repo while children are stacked on it is refused', async () => {
    const parent = await insertItem();
    const child = await insertItem();
    await link(child, parent);
    await expect(
      admin.query(`UPDATE work_items SET repo_id = $2 WHERE id = $1`, [parent, otherRepoId]),
    ).rejects.toMatchObject({ constraint: 'work_items_stack_cross_repo' });
    // Moving the child instead is refused the same way.
    await expect(
      admin.query(`UPDATE work_items SET repo_id = $2 WHERE id = $1`, [child, otherRepoId]),
    ).rejects.toMatchObject({ constraint: 'work_items_stack_cross_repo' });
    // Once the link is cleared the move is allowed.
    await link(child, null);
    await admin.query(`UPDATE work_items SET repo_id = $2 WHERE id = $1`, [parent, otherRepoId]);
    await admin.query(`UPDATE work_items SET repo_id = $2 WHERE id = $1`, [parent, a.repoId]);
  });

  it('deleting the parent clears the child link (the child next starts from main)', async () => {
    const parent = await insertItem();
    const child = await insertItem();
    await link(child, parent);
    await admin.query(`DELETE FROM work_items WHERE id = $1`, [parent]);
    expect(await parentOf(child)).toBeNull();
  });

  // Deterministic interleavings on two separate connections. A takes the per-account lock inside its open transaction; B must be
  // seen waiting on that advisory lock (not merely slow) before A commits, and B's answer must come from what A committed.
  async function waitForBlockedAdvisory(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await admin.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the second transaction never waited on the advisory lock');
  }

  async function twoConnections(): Promise<[PoolClient, PoolClient]> {
    const c1 = await adminPool.connect();
    const c2 = await adminPool.connect();
    await c1.query('BEGIN');
    await c2.query('BEGIN');
    return [c1, c2];
  }

  async function finish(...cs: PoolClient[]): Promise<void> {
    for (const c of cs) {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  const settle = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

  it('cycle: B (y -> x) blocks behind A (x -> y) and is refused as a cycle once A commits', async () => {
    const x = await insertItem();
    const y = await insertItem();
    const [ca, cb] = await twoConnections();
    try {
      await ca.query(`UPDATE work_items SET stack_parent_id = $2 WHERE id = $1`, [x, y]);
      let settled = false;
      const bResult = settle(cb.query(`UPDATE work_items SET stack_parent_id = $2 WHERE id = $1`, [y, x])).then((r) => {
        settled = true;
        return r;
      });
      await waitForBlockedAdvisory();
      expect(settled).toBe(false);
      await ca.query('COMMIT');
      expect(await bResult).toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, constraint: 'work_items_stack_cycle' });
    } finally {
      await finish(ca, cb);
    }
    expect(await parentOf(x)).toBe(y);
    expect(await parentOf(y)).toBeNull();
  });

  it('repo move first: A moves the parent to another repo, B (stack a child on it) blocks and is refused', async () => {
    const parent = await insertItem();
    const child = await insertItem();
    const [ca, cb] = await twoConnections();
    try {
      await ca.query(`UPDATE work_items SET repo_id = $2 WHERE id = $1`, [parent, otherRepoId]);
      const bResult = settle(cb.query(`UPDATE work_items SET stack_parent_id = $2 WHERE id = $1`, [child, parent]));
      await waitForBlockedAdvisory();
      await ca.query('COMMIT');
      expect(await bResult).toMatchObject({ constraint: 'work_items_stack_cross_repo' });
    } finally {
      await finish(ca, cb);
    }
    expect(await parentOf(child)).toBeNull();
  });

  it('link first: A stacks a child on the parent, B (move the parent to another repo) blocks and is refused', async () => {
    const parent = await insertItem();
    const child = await insertItem();
    const [ca, cb] = await twoConnections();
    try {
      await ca.query(`UPDATE work_items SET stack_parent_id = $2 WHERE id = $1`, [child, parent]);
      const bResult = settle(cb.query(`UPDATE work_items SET repo_id = $2 WHERE id = $1`, [parent, otherRepoId]));
      await waitForBlockedAdvisory();
      await ca.query('COMMIT');
      expect(await bResult).toMatchObject({ constraint: 'work_items_stack_cross_repo' });
    } finally {
      await finish(ca, cb);
    }
    expect(await parentOf(child)).toBe(parent);
    const { rows } = await admin.query(`SELECT repo_id FROM work_items WHERE id = ANY($1::uuid[])`, [[parent, child]]);
    expect(new Set(rows.map((r) => r.repo_id)).size).toBe(1);
  });

  it('app_user has a grant on exactly this column; platform_ops gained none', async () => {
    const { rows } = await admin.query(
      `SELECT has_column_privilege('app_user', 'public.work_items', 'stack_parent_id', 'UPDATE') AS app,
              has_column_privilege('platform_ops', 'public.work_items', 'stack_parent_id', 'UPDATE') AS ops`,
    );
    expect(rows[0]).toEqual({ app: true, ops: false });
  });

  it('a link in one tenant is invisible to another tenant', async () => {
    const parent = await insertItem();
    const child = await insertItem();
    await link(child, parent);
    const b = await seedAccount(admin, randomUUID());
    const { rows } = await withTenant(appUserPool, b.accountId, (c) =>
      c.query(`SELECT id FROM work_items WHERE stack_parent_id = $1`, [parent]),
    );
    expect(rows).toHaveLength(0);
  });
});
