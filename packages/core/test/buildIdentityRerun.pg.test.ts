import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { plannedFixture, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { BUILD_BRANCH_KIND, resolveBuildIdentity, sandboxRunBranch, startBuildBranch, type BuildPurpose } from '../src/work-items/buildIdentity.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * [pg] SANDBOX-RERUN-BRANCH-a, criterion 4 (the resolver) and the unit facts of the naming rule. `observe` returns the branch of the newest executor run that recorded one, else the fixed name;
 * `start` for a fix round or a check-fix round returns the same; a record that is not this item's own is never read. Rows are written the way the run's create transaction writes them.
 */
describe('the build identity after a sandbox re-run (SANDBOX-RERUN-BRANCH-a)', () => {
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

  let clock = 0;
  /** An executor run of `itemId`, newer than every run made before it. */
  async function run(accountId: string, itemId: string, record?: { kind?: string; branch: string | ((runId: string) => string) }, role = 'executor'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, $4, 'production', 'succeeded', now() + make_interval(secs => $5))`, [id, accountId, itemId, role, ++clock]);
    if (record) {
      const branch = typeof record.branch === 'function' ? record.branch(id) : record.branch;
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, $3, $4::jsonb)`, [accountId, id, record.kind ?? BUILD_BRANCH_KIND, JSON.stringify({ branch })]);
    }
    return id;
  }
  const ask = (accountId: string, itemId: string, purpose: BuildPurpose) => withTenant(appPool, accountId, (c) => resolveBuildIdentity(c, accountId, itemId, purpose));
  const branchOf = async (accountId: string, itemId: string, purpose: BuildPurpose): Promise<string> => {
    const r = await ask(accountId, itemId, purpose);
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r.identity.branch;
  };

  async function top(number = 77): Promise<{ t: SeedRefs; item: string }> {
    const t = await seedAccount(admin, randomUUID());
    const item = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, gh_number) VALUES ($1, $2, 'issue', 'internal', 'T', $3) RETURNING id`, [t.accountId, t.repoId, number])).rows[0]!.id;
    return { t, item };
  }

  it('the run branch is the run id, lower-case, with generation 1; startBuildBranch is the fixed name unless a rebuild passes its run id', () => {
    const id = '0A1B2C3D-0000-4000-8000-00000000ABCD';
    expect(sandboxRunBranch(id)).toBe('fx/0a1b2c3d-0000-4000-8000-00000000abcd-g1');
    expect(startBuildBranch({ issueNumber: 77 }, null, null)).toBe('fx/issue-77');
    expect(startBuildBranch({ issueNumber: 41 }, 'api', null)).toBe('fx/41-api');
    expect(startBuildBranch({ issueNumber: 77 }, null, id)).toBe(sandboxRunBranch(id));
    expect(startBuildBranch({ issueNumber: 41 }, 'api', id)).toBe(sandboxRunBranch(id));
  });

  describe('a top-level item', () => {
    it('no events at all, or only a fixed-name run, is fx/issue-<n> exactly as before', async () => {
      const { t, item } = await top();
      for (const purpose of ['start', 'observe'] as const) expect(await branchOf(t.accountId, item, purpose)).toBe('fx/issue-77');
      await run(t.accountId, item);
      await run(t.accountId, item, { branch: 'fx/issue-77' });
      for (const purpose of ['start', 'observe'] as const) expect(await ask(t.accountId, item, purpose)).toMatchObject({ ok: true, identity: { issueNumber: 77, branch: 'fx/issue-77' } });
    });

    it('the newest run that recorded a branch wins, for observe and for a start (a fix or check-fix round); a newer run with no record does not hide it', async () => {
      const { t, item } = await top();
      await run(t.accountId, item, { branch: 'fx/issue-77' });
      const second = await run(t.accountId, item, { branch: (id) => sandboxRunBranch(id) });
      await run(t.accountId, item); // a later round of the item that recorded nothing
      for (const purpose of ['start', 'observe'] as const) expect(await branchOf(t.accountId, item, purpose)).toBe(sandboxRunBranch(second));
      const third = await run(t.accountId, item, { branch: (id) => sandboxRunBranch(id) });
      for (const purpose of ['start', 'observe'] as const) expect(await branchOf(t.accountId, item, purpose)).toBe(sandboxRunBranch(third));
    });

    it('a record that is not this item\'s own is not read: another number, a malformed uuid, another run\'s id, another generation, another kind of event, a run of another role', async () => {
      const { t, item } = await top();
      const first = await run(t.accountId, item, { branch: 'fx/issue-77' });
      const stray = [
        { branch: 'fx/issue-78' },
        { branch: 'fx/not-a-uuid-g1' },
        { branch: `fx/${first}-g1` }, // the first run's branch, written by a later run
        { branch: (id: string) => `fx/${id}-g2` },
        { branch: (id: string) => sandboxRunBranch(id), kind: 'something.else' },
      ];
      for (const record of stray) await run(t.accountId, item, record);
      await run(t.accountId, item, { branch: (id) => sandboxRunBranch(id) }, 'reviewer');
      for (const purpose of ['start', 'observe'] as const) expect(await branchOf(t.accountId, item, purpose)).toBe('fx/issue-77');
    });

    it('a record for the item\'s fixed name is read only for the item\'s own number', async () => {
      const { t, item } = await top(5);
      await run(t.accountId, item, { branch: 'fx/issue-77' });
      expect(await branchOf(t.accountId, item, 'observe')).toBe('fx/issue-5');
    });
  });

  describe('a planned PR child', () => {
    const planned = async (): Promise<PlannedFixture> => {
      const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
      await admin.query('UPDATE work_items SET gh_number = 41 WHERE id = $1', [f.parent]);
      return f;
    };

    it('no events, or a fixed child.binding, is fx/<parent#>-<key>', async () => {
      const f = await planned();
      for (const purpose of ['start', 'observe'] as const) expect(await branchOf(f.t.accountId, f.kids.api!, purpose)).toBe('fx/41-api');
      await run(f.t.accountId, f.kids.api!, { kind: 'child.binding', branch: 'fx/41-api' });
      await run(f.t.accountId, f.kids.api!, { branch: 'fx/41-api' });
      for (const purpose of ['start', 'observe'] as const) expect(await branchOf(f.t.accountId, f.kids.api!, purpose)).toBe('fx/41-api');
    });

    it('a rebuilt child resolves to its newest run branch; another child\'s record and another key are not read', async () => {
      const f = await planned();
      await run(f.t.accountId, f.kids.api!, { kind: 'child.binding', branch: 'fx/41-api' });
      const second = await run(f.t.accountId, f.kids.api!, { branch: (id) => sandboxRunBranch(id) });
      for (const purpose of ['start', 'observe'] as const) expect(await branchOf(f.t.accountId, f.kids.api!, purpose)).toBe(sandboxRunBranch(second));
      // The sibling has its own runs: its branch does not leak into this child, and a record that names another key is skipped.
      await run(f.t.accountId, f.kids.ui!, { branch: (id) => sandboxRunBranch(id) });
      await run(f.t.accountId, f.kids.docs!, { branch: 'fx/41-api' });
      await run(f.t.accountId, f.kids.docs!, { kind: 'child.binding', branch: 'fx/41-ui' });
      expect(await branchOf(f.t.accountId, f.kids.api!, 'observe')).toBe(sandboxRunBranch(second));
      expect(await branchOf(f.t.accountId, f.kids.docs!, 'observe')).toBe('fx/41-docs');
    });

    it('the issue number of a run-branch child is its parent\'s; an orphan whose newest record is a run branch has no number to give (child_orphaned)', async () => {
      const f = await planned();
      await run(f.t.accountId, f.kids.api!, { branch: (id) => sandboxRunBranch(id) });
      expect(await ask(f.t.accountId, f.kids.api!, 'observe')).toMatchObject({ ok: true, identity: { issueNumber: 41, isChild: true } });
      await admin.query('DELETE FROM work_items WHERE id = $1', [f.parent]);
      expect(await ask(f.t.accountId, f.kids.api!, 'observe')).toEqual({ ok: false, reason: 'child_orphaned', isChild: true });
    });
  });
});
