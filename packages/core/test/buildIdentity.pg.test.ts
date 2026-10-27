import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { addSpec, plannedFixture, reapprove, row, TABLE, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { branchFor, childBranchFor, resolveBuildIdentity, type BuildIdentityResult, type BuildPurpose } from '../src/work-items/buildIdentity.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * [pg] D#483 S5-b2c-3, acceptance 1 to 3: the build identity of an item, on the real schema. The fixtures are made by the real definers (the approval, the children), as the
 * product makes them. Every refusal is derived from the rows as they are when it is asked.
 */
describe('resolveBuildIdentity (D#483 S5-b2c-3)', () => {
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

  const PARENT_NUMBER = 41;
  const ask = (f: PlannedFixture, itemId: string, purpose: BuildPurpose): Promise<BuildIdentityResult> =>
    withTenant(appPool, f.t.accountId, (c) => resolveBuildIdentity(c, f.t.accountId, itemId, purpose));
  async function planned(o: { parentNumber?: number | null } = {}): Promise<PlannedFixture> {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query('UPDATE work_items SET gh_number = $2 WHERE id = $1', [f.parent, o.parentNumber === undefined ? PARENT_NUMBER : o.parentNumber]);
    return f;
  }
  /** The child has run: an executor run that did not end cancelled. */
  const startChild = async (f: PlannedFixture, key: string, binding?: string) => {
    const run = (await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, 'executor', 'production', 'succeeded', $3) RETURNING id`,
      [f.t.accountId, f.kids[key], f.specV1])).rows[0]!.id;
    if (binding !== undefined) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'child.binding', $3::jsonb)`, [f.t.accountId, run, JSON.stringify({ branch: binding })]);
    }
    return run;
  };

  describe('S5b2c3-1: the identity', () => {
    it('a top-level item is its own number, fx/issue-<n>, and the version its newest approval names', async () => {
      const t = await seedAccount(admin, randomUUID());
      const item = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, gh_number) VALUES ($1, $2, 'issue', 'internal', 'T', 77) RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
      const v1 = await addSpec(admin, t, item, 1);
      await withTenant(appPool, t.accountId, t.userId, (c) => c.query(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [item]));
      const v2 = await addSpec(admin, t, item, 2);
      await withTenant(appPool, t.accountId, t.userId, (c) => c.query(`SELECT * FROM work_item_approval_record($1, 'reapprove_after_respec')`, [item]));
      expect(v1).not.toBe(v2);
      for (const purpose of ['start', 'observe'] as const) {
        const r = await withTenant(appPool, t.accountId, (c) => resolveBuildIdentity(c, t.accountId, item, purpose));
        expect(r).toEqual({ ok: true, identity: { issueNumber: 77, branch: 'fx/issue-77', specVersionId: v2, isChild: false } });
      }
      expect(branchFor(77)).toBe('fx/issue-77');
    });

    it('a top-level item with no approval has no version to name, and one with no number is no_issue_link', async () => {
      const t = await seedAccount(admin, randomUUID());
      const numbered = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, gh_number) VALUES ($1, $2, 'issue', 'internal', 'T', 5) RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
      const bare = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'T') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
      expect(await withTenant(appPool, t.accountId, (c) => resolveBuildIdentity(c, t.accountId, numbered, 'start'))).toEqual({ ok: true, identity: { issueNumber: 5, branch: 'fx/issue-5', specVersionId: null, isChild: false } });
      for (const purpose of ['start', 'observe'] as const) {
        expect(await withTenant(appPool, t.accountId, (c) => resolveBuildIdentity(c, t.accountId, bare, purpose))).toEqual({ ok: false, reason: 'no_issue_link', isChild: false });
      }
      expect(await withTenant(appPool, t.accountId, (c) => resolveBuildIdentity(c, t.accountId, randomUUID(), 'start'))).toEqual({ ok: false, reason: 'not_found', isChild: false });
    });

    it('a child is its parent\'s number, fx/<parent#>-<key> and its pinned version; its own gh_number is never read', async () => {
      const f = await planned();
      for (const purpose of ['start', 'observe'] as const) {
        expect(await ask(f, f.kids.api!, purpose)).toEqual({ ok: true, identity: { issueNumber: PARENT_NUMBER, branch: 'fx/41-api', specVersionId: f.specV1, isChild: true } });
      }
      expect(childBranchFor(41, 'api')).toBe('fx/41-api');
    });

    it('a child whose parent has no number is no_issue_link', async () => {
      const f = await planned({ parentNumber: null });
      for (const purpose of ['start', 'observe'] as const) expect(await ask(f, f.kids.api!, purpose)).toEqual({ ok: false, reason: 'no_issue_link', isChild: true });
    });

    it('0922: a child row with a gh_number of its own is rejected by the database', async () => {
      const f = await planned();
      await expect(admin.query('UPDATE work_items SET gh_number = 9 WHERE id = $1', [f.kids.api])).rejects.toMatchObject({ code: '23514', constraint: 'work_items_planned_pr_child_no_issue_number' });
      // the parent's own number and every other item's stay free
      await expect(admin.query('UPDATE work_items SET gh_number = 42 WHERE id = $1', [f.parent])).resolves.toBeDefined();
    });
  });

  describe('S5b2c3-2: purpose start re-runs the launch checks', () => {
    const cases: Array<{ code: string; arrange: (f: PlannedFixture) => Promise<void> }> = [
      { code: 'child_orphaned', arrange: async (f) => void (await admin.query('DELETE FROM work_items WHERE id = $1', [f.parent])) },
      { code: 'parent_closed', arrange: async (f) => void (await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [f.parent])) },
      { code: 'respec_needs_approval', arrange: async (f) => void (await addSpec(admin, f.t, f.parent, 2, TABLE)) },
      // not started: the parent was approved again on a version that has the key, but the child still has the old pin until the approval moves it. Here the pin is behind the approval.
      { code: 'key_not_in_approved_spec', arrange: async (f) => { await addSpec(admin, f.t, f.parent, 2, [row('docs'), row('other')]); await reapprove(appPool, f); } },
    ];
    for (const c of cases) {
      it(`${c.code}`, async () => {
        const f = await planned();
        await c.arrange(f);
        expect(await ask(f, f.kids.api!, 'start')).toEqual({ ok: false, reason: c.code, isChild: true });
      });
    }

    it('a child that never ran (a cancelled run does not count) follows the approval to the new version, so the strict form never sees a pin behind it while its key is in the table', async () => {
      const f = await planned();
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'production', 'cancelled')`, [f.t.accountId, f.kids.api]);
      const v2 = await addSpec(admin, f.t, f.parent, 2, TABLE);
      await reapprove(appPool, f);
      expect(await ask(f, f.kids.api!, 'start')).toEqual({ ok: true, identity: { issueNumber: PARENT_NUMBER, branch: 'fx/41-api', specVersionId: v2, isChild: true } });
    });

    it('a started child whose key left the approved version is key_not_in_approved_spec; one whose key is still in a newer approved version passes and keeps its pin (R11)', async () => {
      const f = await planned();
      await startChild(f, 'api');
      await startChild(f, 'docs');
      await addSpec(admin, f.t, f.parent, 2, [row('api', 'The API'), row('other', 'Other')]);
      await reapprove(appPool, f);
      // api is in v2's table: it keeps its pinned v1 and passes
      expect(await ask(f, f.kids.api!, 'start')).toEqual({ ok: true, identity: { issueNumber: PARENT_NUMBER, branch: 'fx/41-api', specVersionId: f.specV1, isChild: true } });
      // docs left the table: refused, and Close is what the card offers
      expect(await ask(f, f.kids.docs!, 'start')).toEqual({ ok: false, reason: 'key_not_in_approved_spec', isChild: true });
      // a re-spec that is not approved again stops a started child too
      await addSpec(admin, f.t, f.parent, 3, [row('api', 'The API')]);
      expect(await ask(f, f.kids.api!, 'start')).toEqual({ ok: false, reason: 'respec_needs_approval', isChild: true });
    });

    it('a top-level item has no launch check: a parent that is closed or re-specced does not matter to it', async () => {
      const f = await planned();
      await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [f.parent]);
      expect((await ask(f, f.parent, 'start')).ok).toBe(true);
    });
  });

  describe('S5b2c3-3: purpose observe runs no launch check', () => {
    it('an orphan with a recorded child.binding returns that branch; one without a record is child_orphaned', async () => {
      const f = await planned();
      await startChild(f, 'api', 'fx/41-api');
      await admin.query('DELETE FROM work_items WHERE id = $1', [f.parent]);
      // the parent's Spec versions went with it, so the pin is gone; the branch is what was recorded
      expect(await ask(f, f.kids.api!, 'observe')).toEqual({ ok: true, identity: { issueNumber: 41, branch: 'fx/41-api', specVersionId: null, isChild: true } });
      expect(await ask(f, f.kids.api!, 'start')).toEqual({ ok: false, reason: 'child_orphaned', isChild: true });
      expect(await ask(f, f.kids.ui!, 'observe')).toEqual({ ok: false, reason: 'child_orphaned', isChild: true });
    });

    it('a closed parent or a re-spec that is not approved again does not stop an observer', async () => {
      const f = await planned();
      await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [f.parent]);
      await addSpec(admin, f.t, f.parent, 2, TABLE);
      expect(await ask(f, f.kids.api!, 'observe')).toEqual({ ok: true, identity: { issueNumber: PARENT_NUMBER, branch: 'fx/41-api', specVersionId: f.specV1, isChild: true } });
    });

    it('a recorded branch is read only when it is exactly this child\'s: another key, a leading zero or a sibling\'s branch is ignored', async () => {
      const f = await planned();
      await startChild(f, 'api', 'fx/41-ui');
      await admin.query('DELETE FROM work_items WHERE id = $1', [f.parent]);
      expect(await ask(f, f.kids.api!, 'observe')).toEqual({ ok: false, reason: 'child_orphaned', isChild: true });
    });

    it('the newest executor run that recorded a branch wins', async () => {
      const f = await planned();
      await startChild(f, 'api', 'fx/40-api');
      await new Promise((r) => setTimeout(r, 15));
      await startChild(f, 'api', 'fx/41-api');
      expect(await ask(f, f.kids.api!, 'observe')).toMatchObject({ ok: true, identity: { branch: 'fx/41-api', issueNumber: 41 } });
    });
  });
});
