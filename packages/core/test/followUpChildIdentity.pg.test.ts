import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { addSpec, plannedFixture, row } from '@fx/db/test/helpers/plannedChildren.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { approveSubItem, SubItemApprovalError } from '../src/decisions/approveSubItem.js';
import { gateFixRound } from '../src/decisions/fixRoundGate.js';
import { findPlannedChild, gateChildLaunch, prepareChildLaunch, readChildLaunch, ChildLaunchRefusal, type ChildLaunchDeps } from '../src/decisions/childLaunch.js';
import { resolveBuildIdentity, type BuildPurpose } from '../src/work-items/buildIdentity.js';
import { hasLivePlannedChildSql, readsOwnSpecSql, specOfItemSql } from '../src/work-items/stages.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * [pg] D#483 S5-b2d-2b-0 (C29-0-1 to -3, -6): the code consumers of a follow-up child's identity, on the real schema. The child is made by the real 0962 definer
 * (a person's "make it an item"), with the key the database derives; the Spec versions, approval and runs are fixtures.
 */
const LOGIN = 'fx_follow_up_identity_core_test';
const PARENT_NUMBER = 41;

describe('a follow-up child\'s identity and Spec [pg]', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let receiptPool: Pool;
  let owner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    owner = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [owner, `${owner}@example.test`]);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), receiptPool.end()]);
  });

  interface Fu { t: SeedRefs; parent: string; child: string; key: string; followUp: string; parentSpec: string; childSpec: string; approval: string }
  /** An approved parent (issue 41, Spec v1) with one follow-up child made by the real definer and its own short Spec. */
  async function fu(o: { childSpec?: boolean } = {}): Promise<Fu> {
    const t = await seedAccount(admin, randomUUID());
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [t.accountId, owner]);
    const parent = (await admin.query<{ id: string }>(
      `INSERT INTO work_items (account_id, repo_id, kind, provenance, title, gh_number) VALUES ($1, $2, 'feature', 'internal', 'parent', $3) RETURNING id`, [t.accountId, t.repoId, PARENT_NUMBER])).rows[0]!.id;
    const parentSpec = await addSpec(admin, t, parent, 1);
    const approval = await withTenant(appPool, t.accountId, owner, async (c) => (await c.query<{ o_approval_id: string }>(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [parent])).rows[0]!.o_approval_id);
    const followUp = (await admin.query<{ id: string }>(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'code-reviewer', 'Add a retry', 'why', $3, 'child') RETURNING id`,
      [t.accountId, parent, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')])).rows[0]!.id;
    const child = await withTenant(appPool, t.accountId, owner, async (c) => (await c.query<{ o_child_id: string }>(`SELECT * FROM follow_up_child_create($1)`, [followUp])).rows[0]!.o_child_id);
    const key = (await admin.query<{ planned_pr_key: string }>(`SELECT planned_pr_key FROM work_items WHERE id = $1`, [child])).rows[0]!.planned_pr_key;
    const childSpec = o.childSpec === false ? '' : await addSpec(admin, t, child, 1);
    return { t, parent, child, key, followUp, parentSpec, childSpec, approval };
  }
  const ask = (f: { t: SeedRefs }, id: string, purpose: BuildPurpose) => withTenant(appPool, f.t.accountId, (c) => resolveBuildIdentity(c, f.t.accountId, id, purpose));
  const hex12 = (id: string) => id.replace(/-/g, '').slice(0, 12);

  describe('C29-0-2: resolveBuildIdentity', () => {
    it('start answers the root\'s number, fx/<root#>-fu-<hex>, the child\'s own newest Spec and the child as the Spec owner; observe reads the same branch', async () => {
      const f = await fu();
      expect(f.key).toBe(`fu-${hex12(f.followUp)}`);
      const own2 = await addSpec(admin, f.t, f.child, 2);
      const want = { issueNumber: PARENT_NUMBER, branch: `fx/${PARENT_NUMBER}-${f.key}`, specVersionId: own2, specOwnerId: f.child, isChild: true };
      expect(await ask(f, f.child, 'start')).toEqual({ ok: true, identity: want });
      expect(await ask(f, f.child, 'observe')).toEqual({ ok: true, identity: want });
    });

    it('closed, re-specced and orphaned parents, and a follow-up row that no longer names the child, are refused with the planned child\'s codes', async () => {
      const closed = await fu();
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [closed.parent]);
      expect(await ask(closed, closed.child, 'start')).toEqual({ ok: false, reason: 'parent_closed', isChild: true });

      const respec = await fu();
      await addSpec(admin, respec.t, respec.parent, 2);
      expect(await ask(respec, respec.child, 'start')).toEqual({ ok: false, reason: 'respec_needs_approval', isChild: true });

      const orphan = await fu();
      await admin.query(`UPDATE work_item_follow_ups SET child_id = NULL WHERE id = $1`, [orphan.followUp]);
      expect(await ask(orphan, orphan.child, 'start')).toEqual({ ok: false, reason: 'child_orphaned', isChild: true });

      const gone = await fu();
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [gone.parent]);
      const afterDelete = await ask(gone, gone.child, 'start');
      expect(afterDelete.ok).toBe(false);
    });

    it('a follow-up child with no Spec yet is still a child (version null, the child as owner)', async () => {
      const f = await fu({ childSpec: false });
      expect(await ask(f, f.child, 'start')).toEqual({ ok: true, identity: { issueNumber: PARENT_NUMBER, branch: `fx/${PARENT_NUMBER}-${f.key}`, specVersionId: null, specOwnerId: f.child, isChild: true } });
    });
  });

  describe('C29-0-1: the one Spec selector', () => {
    const specsOf = async (item: string): Promise<string[]> =>
      (await admin.query<{ id: string }>(`SELECT s.id FROM work_items w, spec_versions s WHERE w.id = $1 AND s.account_id = w.account_id AND ${specOfItemSql('s', 'w')} ORDER BY s.version`, [item])).rows.map((r) => r.id);

    it('a follow-up child reads its own Spec versions and never the parent\'s; a planned child reads only the parent version it is pinned to, and none when the pin is gone', async () => {
      const f = await fu();
      const own2 = await addSpec(admin, f.t, f.child, 2);
      expect(await specsOf(f.child)).toEqual([f.childSpec, own2]);
      expect(await specsOf(f.parent)).toEqual([f.parentSpec]);

      const p = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
      await addSpec(admin, p.t, p.parent, 2, [row('api'), row('ui')]);
      expect(await specsOf(p.kids.api!)).toEqual([p.specV1]);
      // a planned child whose pin was cleared fails closed: it never reads a Spec written on the child itself
      await admin.query(`UPDATE work_items SET planned_pr_spec_version_id = NULL WHERE id = $1`, [p.kids.api!]);
      await addSpec(admin, p.t, p.kids.api!, 1);
      expect(await specsOf(p.kids.api!)).toEqual([]);
    });
  });

  describe('C29-0-3: live children and the split count', () => {
    const live = async (parent: string) => (await admin.query<{ live: boolean }>(`SELECT ${hasLivePlannedChildSql('w')} AS live FROM work_items w WHERE w.id = $1`, [parent])).rows[0]!.live;

    it('a live follow-up child does not block its parent\'s rebuild; a live planned child still does', async () => {
      const f = await fu();
      expect(await live(f.parent)).toBe(false);
      const p = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
      expect(await live(p.parent)).toBe(true);
    });

    it('the split count reads a follow-up child\'s own stored table (two or more rows) and a planned child\'s reads none', async () => {
      const f = await fu({ childSpec: false });
      await addSpec(admin, f.t, f.child, 1, [row('a'), row('b')]);
      const count = async (item: string) => (await admin.query<{ n: number | null }>(
        `SELECT (SELECT jsonb_array_length(s.frontmatter -> 'planned_prs') FROM spec_versions s WHERE ${readsOwnSpecSql('w')} AND s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1) AS n
           FROM work_items w WHERE w.id = $1`, [item])).rows[0]!.n;
      expect(await count(f.child)).toBe(2);
      const p = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
      expect(await count(p.kids.api!)).toBeNull();
    });
  });

  describe('C29-0-4: the key space', () => {
    it('findPlannedChild never answers a follow-up child, and a fu- key that names none is refused before any receipt (the follow-up launch is in followUpLaunch.pg.test.ts)', async () => {
      const f = await fu();
      await withTenant(appPool, f.t.accountId, (c) => findPlannedChild(c, f.t.accountId, f.parent, f.key).then((id) => expect(id).toBeNull()));
      const ctx = { pool: receiptPool, principal: { accountId: f.t.accountId, userId: owner } };
      await expect(approveSubItem(ctx, { workItemId: f.parent, key: 'fu-000000000000' })).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(approveSubItem(ctx, { workItemId: f.parent, key: 'fu-000000000000' })).rejects.toBeInstanceOf(SubItemApprovalError);
    });
  });

  describe('the planned launch entry points never read a follow-up child (readChild)', () => {
    const deps: ChildLaunchDeps = { buildSupported: true, room: async () => ({ fits: true, remainingUsd: 100, priceUsd: 1 }) };
    const counts = async (f: Fu) => [
      (await admin.query('SELECT count(*)::int AS n FROM run_action_requests WHERE account_id = $1', [f.t.accountId])).rows[0].n,
      (await admin.query('SELECT count(*)::int AS n FROM decision_receipts WHERE account_id = $1', [f.t.accountId])).rows[0].n,
      (await admin.query('SELECT count(*)::int AS n FROM decision_asks WHERE account_id = $1', [f.t.accountId])).rows[0].n,
    ];

    it('the card read, the prepare and the gate answer as for a missing child, and write nothing', async () => {
      const f = await fu();
      const before = await counts(f);
      const run = <T>(fn: (c: import('pg').PoolClient) => Promise<T>) => withTenant(appPool, f.t.accountId, owner, fn);
      expect(await run((c) => readChildLaunch(c, { accountId: f.t.accountId, childId: f.child, person: true, deps }))).toEqual({ code: null, sentence: null, offers: null, warning: null, started: false });
      const refused = await run((c) => prepareChildLaunch(c, { accountId: f.t.accountId, childId: f.child, deps }).then(() => null, (e) => e));
      expect(refused).toBeInstanceOf(ChildLaunchRefusal);
      expect(refused.code).toBe('child_orphaned');
      expect(await run((c) => gateChildLaunch(c, { accountId: f.t.accountId, childId: f.child, deps }))).toEqual({ outcome: 'not_ready' });
      expect(await counts(f)).toEqual(before);
    });
  });

  describe('C29-0-6: a fix round on a follow-up child', () => {
    const rounds = async (f: Fu) => {
      const run = async (role: string) => (await admin.query<{ id: string }>(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, $3, 'production', 'succeeded', $4) RETURNING id`, [f.t.accountId, f.child, role, f.childSpec])).rows[0]!.id;
      await run('executor');
      return run('code-reviewer');
    };
    const receiptsOf = async (id: string) => (await admin.query(`SELECT work_item_id, sub_item_key, spec_version_id, approval_id, run_id FROM decision_receipts WHERE work_item_id = $1`, [id])).rows;

    it('a person\'s Approve is held to the child\'s own newest Spec, never the parent\'s', async () => {
      const f = await fu();
      const review = await rounds(f);
      await approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: owner } }, { workItemId: f.child, key: 'fix-1' });
      expect(await receiptsOf(f.child)).toMatchObject([{ work_item_id: f.child, sub_item_key: 'fix-1', spec_version_id: f.childSpec, run_id: review }]);
      // a newer own version is what the next one names
      const own2 = await addSpec(admin, f.t, f.child, 2);
      await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'fix_round_started', 'r1')`, [f.t.accountId, f.child]);
      await approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: owner } }, { workItemId: f.child, key: 'fix-2' });
      expect((await receiptsOf(f.child)).find((r) => r.sub_item_key === 'fix-2')).toMatchObject({ spec_version_id: own2 });
    });

    it('the dial\'s policy receipt names the child, its own Spec and the parent\'s newest approval, and the database accepts it', async () => {
      const f = await fu();
      const review = await rounds(f);
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'launch_sub_item', 'act', 'balanced', 1, $3)`, [f.t.accountId, f.t.repoId, f.t.userId]);
      const out = await gateFixRound({ pool: receiptPool, accountId: f.t.accountId }, { workItemId: f.child, personUserId: null });
      expect(out).toMatchObject({ proceed: true, how: 'policy_receipt', key: 'fix-1' });
      expect(await receiptsOf(f.child)).toMatchObject([{ work_item_id: f.child, sub_item_key: 'fix-1', spec_version_id: f.childSpec, approval_id: f.approval, run_id: review }]);
    });
  });
});
