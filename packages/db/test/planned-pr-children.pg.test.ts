import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#483 S5-b2b (migration 0919) with the real roles: a person's approval of a Spec that carries a Planned PRs table creates one child work item per row,
 * from the approved version only, once, inside the tenant, and a table that cannot be read creates nothing and refuses the approval.
 */
const row = (key: string, title = `Title of ${key}`, depends_on: string[] = []) => ({ key, title, depends_on });
const TABLE = [row('api'), row('ui', 'The screen', ['api']), row('docs')];

describe('migration 0919: planned PR children [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  async function person(t: SeedRefs, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [t.accountId, id, role]);
    return id;
  }
  async function item(t: SeedRefs, provenance = 'internal'): Promise<string> {
    return (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'feature', $3, 'Parent') RETURNING id`, [t.accountId, t.repoId, provenance])).rows[0]!.id;
  }
  async function spec(t: SeedRefs, workItemId: string, version: number, planned?: unknown): Promise<string> {
    const body = `Spec v${version} ${randomUUID()}`;
    const frontmatter = planned === undefined ? {} : { planned_prs: planned };
    return (await admin.query<{ id: string }>(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, $3, $4, $5, 'agent', $6::jsonb) RETURNING id`,
      [t.accountId, workItemId, version, body, createHash('sha256').update(body).digest('hex'), JSON.stringify(frontmatter)],
    )).rows[0]!.id;
  }
  const approve = (t: SeedRefs, userId: string, workItemId: string, source = 'work_item_approve', tokenId?: string) =>
    withTenant(appPool, t.accountId, userId, tokenId, async (c) => (await c.query('SELECT * FROM work_item_approval_record($1, $2)', [workItemId, source])).rows[0]);
  const children = async (parent: string) =>
    (await admin.query('SELECT * FROM work_items WHERE parent_id = $1 AND planned_pr_key IS NOT NULL ORDER BY planned_pr_key', [parent])).rows;
  const approvalCount = async (w: string) => Number((await admin.query('SELECT count(*) AS n FROM work_item_approvals WHERE work_item_id = $1', [w])).rows[0].n);

  it('creates one child per row, from the approved version, copying the parent repo, kind and provenance', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const v1 = await spec(t, w, 1, TABLE);
    const r = await approve(t, t.userId, w);
    expect(r.o_spec_version_id).toBe(v1);
    const kids = await children(w);
    expect(kids.map((k) => k.planned_pr_key)).toEqual(['api', 'docs', 'ui']);
    for (const k of kids) {
      expect(k).toMatchObject({ account_id: t.accountId, parent_id: w, repo_id: t.repoId, kind: 'feature', provenance: 'internal', stage: 'triaged', planned_pr_spec_version_id: v1, gh_number: null, discussion_id: null });
    }
    expect(kids.find((k) => k.planned_pr_key === 'ui')!.title).toBe('The screen');
    expect((await admin.query('SELECT count(*) AS n FROM agent_runs WHERE work_item_id = ANY($1)', [kids.map((k) => k.id)])).rows[0].n).toBe('0');
  });

  it('an external parent has external children', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t, 'external');
    await spec(t, w, 1, TABLE);
    await approve(t, t.userId, w);
    expect((await children(w)).map((k) => k.provenance)).toEqual(['external', 'external', 'external']);
  });

  it('a Spec with no table, an empty table or a single row stays one item', async () => {
    const t = await seedAccount(admin, randomUUID());
    for (const planned of [undefined, [], [row('only')]]) {
      const w = await item(t);
      await spec(t, w, 1, planned);
      await approve(t, t.userId, w);
      expect(await children(w)).toHaveLength(0);
      expect(await approvalCount(w)).toBe(1);
    }
  });

  it('a repeated approval and two approvals at once leave exactly one child per key', async () => {
    const t = await seedAccount(admin, randomUUID());
    const other = await person(t, 'admin');
    const w = await item(t);
    await spec(t, w, 1, TABLE);
    expect((await approve(t, t.userId, w)).o_replayed).toBe(false);
    expect((await approve(t, t.userId, w)).o_replayed).toBe(true);
    expect(await children(w)).toHaveLength(3);
    const w2 = await item(t);
    await spec(t, w2, 1, TABLE);
    await Promise.all([approve(t, t.userId, w2), approve(t, other, w2), approve(t, t.userId, w2), approve(t, other, w2)]);
    expect((await children(w2)).map((k) => k.planned_pr_key)).toEqual(['api', 'docs', 'ui']);
  });

  it('children come only from the approved version: a newer version without a table creates none, and a re-approval adds only keys that do not exist yet', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const v1 = await spec(t, w, 1, [row('a'), row('b')]);
    await approve(t, t.userId, w);
    expect((await children(w)).map((k) => k.planned_pr_key)).toEqual(['a', 'b']);
    const v2 = await spec(t, w, 2, [row('b'), row('c')]);
    await approve(t, t.userId, w, 'reapprove_after_respec');
    const kids = await children(w);
    expect(kids.map((k) => [k.planned_pr_key, k.planned_pr_spec_version_id])).toEqual([['a', v1], ['b', v1], ['c', v2]]);

    const w2 = await item(t);
    await spec(t, w2, 1, [row('x'), row('y')]);
    await spec(t, w2, 2);
    await approve(t, t.userId, w2);
    expect(await children(w2)).toHaveLength(0);
  });

  it('creates nothing for a proposal approval, a token, a plain member, or another tenant', async () => {
    const t = await seedAccount(admin, randomUUID());
    const u = await seedAccount(admin, randomUUID());
    const member = await person(t, 'member');
    const creator = await person(t, 'admin');
    const tok = (await admin.query<{ id: string }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['read', 'work_items:write'], now() + interval '1 day') RETURNING id`,
      [t.accountId, creator, randomUUID()],
    )).rows[0]!.id;
    const w = await item(t);
    await spec(t, w, 1, TABLE);
    await expect(approve(t, member, w)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(approve(t, creator, w, 'work_item_approve', tok)).rejects.toThrow(/person_required/);
    await expect(approve(u, u.userId, w)).rejects.toThrow(/work item not found/);
    await expect(withTenant(appPool, t.accountId, t.userId, (c) => c.query(`SELECT * FROM work_item_approval_for_proposal($1, $2)`, [w, t.userId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect(await children(w)).toHaveLength(0);
    expect(await approvalCount(w)).toBe(0);
    // The function itself is not callable by the web tier.
    await expect(withTenant(appPool, t.accountId, t.userId, (c) => c.query('SELECT planned_pr_children_create($1, $2)', [w, randomUUID()]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a table the data cannot accept refuses the approval and creates nothing: no approval row, no partial set', async () => {
    const t = await seedAccount(admin, randomUUID());
    const long = 'x'.repeat(121);
    const bad: Array<[string, unknown]> = [
      ['not an array', { api: 1 }],
      ['reserved fix- key', [row('fix-1'), row('ok')]],
      ['reserved check- key', [row('check-abc'), row('ok')]],
      ['upper-case key', [row('Api'), row('ok')]],
      ['key over 32', [row('a'.repeat(33)), row('ok')]],
      ['duplicate keys', [row('same'), row('same')]],
      ['missing title', [{ key: 'a' }, row('b')]],
      ['title over 120', [row('a', long), row('b')]],
      ['pipe in title', [row('a', 'a | b'), row('b')]],
      ['backtick in title', [row('a', 'use `x`'), row('b')]],
      ['newline in title', [row('a', 'two\nlines'), row('b')]],
      ['tab in title', [row('a', 'a\tb'), row('b')]],
      ['non-object row', ['a', row('b')]],
      ['13 rows', Array.from({ length: 13 }, (_, i) => row(`k${i}`))],
    ];
    for (const [why, planned] of bad) {
      const w = await item(t);
      await spec(t, w, 1, planned);
      await expect(approve(t, t.userId, w), why).rejects.toThrow(/planned_prs_invalid/);
      expect(await children(w), why).toHaveLength(0);
      expect(await approvalCount(w), why).toBe(0);
    }
  });

  it('refuses a Spec version that is not the parent\'s or is erased', async () => {
    const t = await seedAccount(admin, randomUUID());
    const w = await item(t);
    const w2 = await item(t);
    const foreign = await spec(t, w2, 1, TABLE);
    const erased = await spec(t, w, 1, TABLE);
    await admin.query('UPDATE spec_versions SET erased_at = now() WHERE id = $1', [erased]);
    for (const version of [foreign, erased]) {
      await expect(callAsDefinerIn(t, (c) => c.query('SELECT planned_pr_children_create($1, $2)', [w, version]))).rejects.toThrow(/not this work item/);
    }
    expect(await children(w)).toHaveLength(0);
  });

  describe('the table guards', () => {
    it('the web tier cannot set or change a planned PR key, and the database allows one child per key', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const v = await spec(t, w, 1, TABLE);
      const ins = (c: { query: PoolClient['query'] }) =>
        c.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance, parent_id, planned_pr_key, planned_pr_spec_version_id) VALUES ($1, $2, 'feature', 'internal', $3, 'forged', $4)`, [t.accountId, t.repoId, w, v]);
      await expect(withTenant(appPool, t.accountId, t.userId, ins)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(ins(admin)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await approve(t, t.userId, w);
      const kid = (await children(w))[0]!;
      await expect(withTenant(appPool, t.accountId, t.userId, (c) => c.query(`UPDATE work_items SET planned_pr_key = 'other' WHERE id = $1`, [kid.id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(admin.query(`UPDATE work_items SET planned_pr_key = 'other' WHERE id = $1`, [kid.id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(callAsDefinerIn(t, (c) => c.query(
        `INSERT INTO work_items (account_id, repo_id, kind, provenance, parent_id, planned_pr_key, planned_pr_spec_version_id) VALUES ($1, $2, 'feature', 'internal', $3, $4, $5)`,
        [t.accountId, t.repoId, w, kid.planned_pr_key, v]))).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('the key and the pattern are checked by the table, whatever writes', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const v = await spec(t, w, 1);
      for (const key of ['fix-1', 'check-ab', 'Up', '', 'a'.repeat(33)]) {
        await expect(callAsDefinerIn(t, (c) => c.query(
          `INSERT INTO work_items (account_id, repo_id, kind, provenance, parent_id, planned_pr_key, planned_pr_spec_version_id) VALUES ($1, $2, 'feature', 'internal', $3, $4, $5)`,
          [t.accountId, t.repoId, w, key, v])), key).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it('deleting the parent leaves its children (parent link cleared) and deleting a Spec version clears the pin', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      await spec(t, w, 1, TABLE);
      await approve(t, t.userId, w);
      const ids = (await children(w)).map((k) => k.id);
      await admin.query('DELETE FROM work_items WHERE id = $1', [w]);
      const left = (await admin.query('SELECT parent_id, planned_pr_spec_version_id FROM work_items WHERE id = ANY($1)', [ids])).rows;
      expect(left).toHaveLength(3);
      expect(left.every((r) => r.parent_id === null && r.planned_pr_spec_version_id === null)).toBe(true);
    });
  });

  /** Runs `fn` in a rolled-back transaction as the definer role, in the tenant (how the approval function reaches the table). */
  async function callAsDefinerIn<T>(t: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('app.account_id', $1, true)`, [t.accountId]);
      await admin.query('SET LOCAL ROLE work_item_approval_definer');
      return await fn(admin);
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  /** Re-creates `fname` with one piece of its text replaced, in a transaction that is rolled back; runs `scenario` inside it. */
  async function mutated<T>(sig: string, from: string, to: string, scenario: () => Promise<T>): Promise<T> {
    const { rows } = await admin.query<{ def: string }>(`SELECT pg_get_functiondef('${sig}'::regprocedure) AS def`);
    const def = rows[0]!.def.replace(from, () => to);
    expect(def).not.toBe(rows[0]!.def);
    await admin.query('BEGIN');
    try {
      await admin.query(def);
      return await scenario();
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  /** Inside a transaction `mutated` opened on the admin connection: act as the web tier for this tenant and person. */
  async function asApp(t: SeedRefs, userId: string): Promise<void> {
    await admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [t.accountId, userId]);
    await admin.query('SET LOCAL ROLE app_user');
  }
  async function asDefiner(t: SeedRefs): Promise<void> {
    await admin.query(`SELECT set_config('app.account_id', $1, true)`, [t.accountId]);
    await admin.query('SET LOCAL ROLE work_item_approval_definer');
  }
  const createdBy = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].n as number;
  const approveInTxn = async (t: SeedRefs, w: string) => {
    await asApp(t, t.userId);
    await admin.query(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [w]);
    return (await admin.query('SELECT count(*)::int AS n FROM work_items WHERE parent_id = $1', [w])).rows[0].n as number;
  };

  describe('mutation proofs: each guard is what stops the bad case', () => {
    it('without ON CONFLICT, a second creation raises a unique violation; with it, the set is left as it is', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const v = await spec(t, w, 1, TABLE);
      const twice = async () => {
        await asDefiner(t);
        await admin.query('SELECT planned_pr_children_create($1, $2)', [w, v]);
        await admin.query('SELECT planned_pr_children_create($1, $2)', [w, v]);
      };
      await expect(mutated('planned_pr_children_create(uuid,uuid)', 'ON CONFLICT (account_id, parent_id, planned_pr_key) WHERE planned_pr_key IS NOT NULL DO NOTHING', '', twice)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      const second = await callAsDefinerIn(t, async (c) => {
        await c.query('SELECT planned_pr_children_create($1, $2)', [w, v]);
        return (await c.query('SELECT planned_pr_children_create($1, $2) AS n', [w, v])).rows[0].n;
      });
      expect(second).toBe(0);
    });

    it("without the item check, another item's Spec version creates children under this item", async () => {
      const t = await seedAccount(admin, randomUUID());
      const mine = await item(t);
      const theirs = await item(t);
      const v = await spec(t, theirs, 1, TABLE);
      const attempt = async () => {
        await asDefiner(t);
        return createdBy('SELECT planned_pr_children_create($1, $2) AS n', [mine, v]);
      };
      expect(await mutated('planned_pr_children_create(uuid,uuid)', 's.work_item_id = p_parent AND ', '', attempt)).toBe(3);
      await expect(callAsDefinerIn(t, (c) => c.query('SELECT planned_pr_children_create($1, $2)', [mine, v]))).rejects.toThrow(/not this work item/);
    });

    it('without the erased check, an erased Spec version still creates children', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const v = await spec(t, w, 1, TABLE);
      await admin.query('UPDATE spec_versions SET erased_at = now() WHERE id = $1', [v]);
      const attempt = async () => {
        await asDefiner(t);
        return createdBy('SELECT planned_pr_children_create($1, $2) AS n', [w, v]);
      };
      expect(await mutated('planned_pr_children_create(uuid,uuid)', ' AND s.erased_at IS NULL', '', attempt)).toBe(3);
      await expect(callAsDefinerIn(t, (c) => c.query('SELECT planned_pr_children_create($1, $2)', [w, v]))).rejects.toThrow(/not this work item/);
    });

    it("without the row check in the function, only the table's own pattern stops a reserved key (a different error)", async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      await spec(t, w, 1, [row('fix-1'), row('ok')]);
      await expect(mutated('planned_pr_children_create(uuid,uuid)', `(e ->> 'key') !~ '^(fix|check)-'`, `(e ->> 'key') !~ '^$'`, () => approveInTxn(t, w))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(approve(t, t.userId, w)).rejects.toThrow(/planned_prs_invalid/);
      expect(await children(w)).toHaveLength(0);
    });

    it('without the row count check, 13 rows are created', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const v = await spec(t, w, 1, Array.from({ length: 13 }, (_, i) => row(`k${i}`)));
      const attempt = async () => {
        await asDefiner(t);
        return createdBy('SELECT planned_pr_children_create($1, $2) AS n', [w, v]);
      };
      expect(await mutated('planned_pr_children_create(uuid,uuid)', 'IF n > 12', 'IF false', attempt)).toBe(13);
    });

    it('without the call in the approval writer, no child is created (and with it, three are)', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      await spec(t, w, 1, TABLE);
      expect(await mutated('work_item_approval_insert(uuid,uuid,text,boolean)', 'PERFORM public.planned_pr_children_create(p_work_item_id, cur);', 'NULL;', () => approveInTxn(t, w))).toBe(0);
      await admin.query('BEGIN');
      try {
        expect(await approveInTxn(t, w)).toBe(3);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('without the trigger test, the web tier can forge a planned PR key', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const v = await spec(t, w, 1, TABLE);
      const insertForged = `INSERT INTO work_items (account_id, repo_id, kind, provenance, parent_id, planned_pr_key, planned_pr_spec_version_id) VALUES ($1, $2, 'feature', 'internal', $3, 'forged', $4)`;
      const forge = async () => {
        await asApp(t, t.userId);
        return admin.query(insertForged, [t.accountId, t.repoId, w, v]);
      };
      expect((await mutated('work_items_planned_pr_guard()', `current_user <> 'work_item_approval_definer'`, 'false', forge)).rowCount).toBe(1);
      await expect(withTenant(appPool, t.accountId, t.userId, (c) => c.query(insertForged, [t.accountId, t.repoId, w, v]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });
});
