import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { executePlanImport, type PlanSource } from '../src/plan/executeImport.js';
import { beginPlanImport } from '../src/plan/persist.js';
import { getProposal, ProposalRefusedError, rejectProposal, restoreProposal, type ProposalCtx } from '../src/plan/proposals.js';

/**
 * D#483 S5-f, acceptance A-S5-5 through the real import: reject one proposal "Not now" with a short date and another "Never";
 * after the date and a re-discovery the first is back in New with its "said not now on" stamp and the second is still rejected.
 * "Source still open" is the importer's own fact (the issue is in the import's list), so a closed issue does not come back.
 *
 * The clock: a date a day away cannot be waited for. The test moves the stored date two days back (an admin write to
 * resurface_after, the one column the clock is compared with), which is what the passing of that day does to the row.
 * What it cannot show: the definer reads now() from Postgres, so there is no injectable clock to cross the date at the second.
 */
type IssueSpec = { number: number; title: string; state: 'open' | 'closed' };
function source(issues: IssueSpec[]): PlanSource {
  return {
    async head() {
      return { defaultBranch: 'main', sha: 'f'.repeat(40) };
    },
    async file() {
      return null;
    },
    async pulls() {
      return { pulls: [], truncated: false };
    },
    async discussions() {
      return { discussions: [], specs: [], truncated: false };
    },
    async discussionComments() {
      return { comments: [] };
    },
    async issues() {
      return { issues, truncated: false };
    },
    async authorPermission() {
      return 'none';
    },
    evidence() {
      return { requests: [{ method: 'POST', path: '/graphql PlanRepoHead', status: 200 }], tokenPermissions: { metadata: 'read', contents: 'read', issues: 'read', discussions: 'read' } };
    },
  };
}

describe('rejection memory through the import (S5-f)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  async function setup() {
    const r = await seedAccount(admin, randomUUID());
    const repoId = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [repoId, r.accountId, r.installationId, Math.floor(Math.random() * 1e9) + 10, 'team']);
    const principal = { accountId: r.accountId, userId: r.userId };
    const ctx: ProposalCtx = { pool: appPool, principal };
    const importWith = async (issues: IssueSpec[]) => {
      const importId = await beginPlanImport(appPool, principal, repoId);
      const out = await executePlanImport({ pool: appPool, principal, repoId, importId, source: source(issues) });
      expect(out.state).toBe('succeeded');
    };
    const id = async (n: number) => (await admin.query('SELECT id FROM proposals WHERE repo_id = $1 AND dedupe_key = $2', [repoId, `gh:issue:${n}`])).rows[0].id as string;
    const view = (n: number) => id(n).then((pid) => getProposal(ctx, pid));
    /** The date passes: the stored date moves two days back, so a date that was a day ahead is now a day behind. */
    const aDayPasses = (pid: string) => admin.query(`UPDATE proposals SET resurface_after = resurface_after - interval '2 days' WHERE id = $1`, [pid]);
    return { r, repoId, ctx, importWith, id, view, aDayPasses, reject: rejectProposal, restore: restoreProposal };
  }
  const OPEN = (n: number): IssueSpec => ({ number: n, title: `Issue ${n}`, state: 'open' });

  it('A-S5-5: a Not now comes back after its date when its source is still open, with the stamp that says when; a Never stays and is not touched', async () => {
    const t = await setup();
    const workItems = async () => (await admin.query(`SELECT count(*)::int n FROM work_items WHERE account_id = $1`, [t.r.accountId])).rows[0].n as number;
    const itemsBefore = await workItems();
    await t.importWith([OPEN(1), OPEN(2)]);
    const tomorrow = new Date(Date.now() + 86_400_000);
    await t.reject(t.ctx, await t.id(1), { kind: 'not_now', resurfaceAfter: tomorrow, note: 'after the release' });
    await t.reject(t.ctx, await t.id(2), { kind: 'never', note: 'out of scope' });
    const said = (await t.view(1)).decided_at!;
    expect(await t.view(1)).toMatchObject({ state: 'rejected', reject_kind: 'not_now', resurface_after: tomorrow.toISOString(), resurfaced_at: null });

    // Before the date a re-discovery changes nothing.
    await t.importWith([OPEN(1), OPEN(2)]);
    expect(await t.view(1)).toMatchObject({ state: 'rejected', reject_kind: 'not_now' });

    await t.aDayPasses(await t.id(1));
    await t.aDayPasses(await t.id(2)); // a no-op for Never (no date): the clock has nothing to compare
    const before2 = await t.view(2);
    await t.importWith([OPEN(1), OPEN(2)]);

    const one = await t.view(1);
    expect(one).toMatchObject({ state: 'new', reject_kind: null, resurface_after: null, reject_note: null });
    expect(one.resurfaced_at).not.toBeNull();
    // "You said not now on <date>": the date of the person's own decision is kept on the row.
    expect(one.decided_at).toBe(said);
    const two = await t.view(2);
    expect(two).toMatchObject({ state: 'rejected', reject_kind: 'never', reject_note: 'out of scope', decided_at: before2.decided_at });
    expect(two.resurfaced_at).toBeNull();

    // One audit row for the one that came back, naming the import and carrying the note the CHECK no longer lets the row hold.
    const audit = (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'proposal.resurfaced'`, [t.r.accountId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'system:plan_import', payload: { proposal_id: one.id, repo_id: t.repoId, note: 'after the release' } });
    // Nothing was started by the import (E4): no work item, run or run request was made for the resurfaced row.
    expect(await workItems()).toBe(itemsBefore);
  });

  it('a Not now whose issue is closed at the date stays rejected; reopened later, the next import brings it back', async () => {
    const t = await setup();
    await t.importWith([OPEN(1)]);
    await t.reject(t.ctx, await t.id(1), { kind: 'not_now', resurfaceAfter: new Date(Date.now() + 86_400_000) });
    await t.aDayPasses(await t.id(1));
    await t.importWith([{ number: 1, title: 'Issue 1', state: 'closed' }]);
    expect(await t.view(1)).toMatchObject({ state: 'rejected', reject_kind: 'not_now', resurfaced_at: null });
    await t.importWith([]);
    expect((await t.view(1)).state).toBe('rejected');
    await t.importWith([OPEN(1)]);
    expect(await t.view(1)).toMatchObject({ state: 'new', reject_kind: null });
    expect((await t.view(1)).resurfaced_at).not.toBeNull();
  });

  it('a Not now with the default date (30 days) is not due now, and an import does not bring it back', async () => {
    const t = await setup();
    await t.importWith([OPEN(1)]);
    const p = await t.reject(t.ctx, await t.id(1), { kind: 'not_now' });
    const days = (new Date(p.resurface_after!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    await t.importWith([OPEN(1)]);
    expect((await t.view(1)).state).toBe('rejected');
  });

  it('a row rejected before 0844 (no kind) stays rejected through every import, and still restores', async () => {
    const t = await setup();
    await t.importWith([OPEN(1)]);
    const pid = await t.id(1);
    await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now() - interval '90 days', reject_note = 'old' WHERE id = $1`, [pid]);
    await t.importWith([OPEN(1)]);
    expect(await t.view(1)).toMatchObject({ state: 'rejected', reject_kind: null, resurface_after: null, resurfaced_at: null });
    expect(await t.restore(t.ctx, pid)).toMatchObject({ state: 'new', reject_kind: null, reject_note: null });
  });

  it('S5f-3 through the core: Move back to inbox works for both kinds and clears both fields; a resurfaced row can be rejected again', async () => {
    const t = await setup();
    await t.importWith([OPEN(1), OPEN(2), OPEN(3)]);
    for (const [n, kind] of [[1, 'not_now'], [2, 'never']] as const) {
      const pid = await t.id(n);
      await t.reject(t.ctx, pid, { kind, note: 'x' });
      expect(await t.restore(t.ctx, pid)).toMatchObject({ state: 'new', reject_kind: null, resurface_after: null, reject_note: null, decided_at: null });
    }
    // Reject 3 as Not now, let the day pass, bring it back, reject it again as Never: the new decision stands alone.
    const p3 = await t.id(3);
    await t.reject(t.ctx, p3, { kind: 'not_now', resurfaceAfter: new Date(Date.now() + 86_400_000) });
    await t.aDayPasses(p3);
    await t.importWith([OPEN(1), OPEN(2), OPEN(3)]);
    expect((await t.view(3)).resurfaced_at).not.toBeNull();
    expect(await t.reject(t.ctx, p3, { kind: 'never' })).toMatchObject({ state: 'rejected', reject_kind: 'never', resurfaced_at: null, resurface_after: null });
  });

  it('a date in the past or more than a year out is refused with invalid_resurface_date and nothing changes', async () => {
    const t = await setup();
    await t.importWith([OPEN(1)]);
    const pid = await t.id(1);
    for (const when of [new Date(Date.now() - 1000), new Date(Date.now() + 366 * 86_400_000)]) {
      await expect(t.reject(t.ctx, pid, { kind: 'not_now', resurfaceAfter: when })).rejects.toMatchObject({ constructor: ProposalRefusedError, code: 'invalid_resurface_date' });
    }
    expect((await t.view(1)).state).toBe('new');
  });
});
