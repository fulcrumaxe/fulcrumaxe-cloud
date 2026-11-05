import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { RepoPermission } from '@fx/trust';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { ENGINE_LOOP_MARKER, executePlanImport, MAX_LABEL_CHECKS, type PlanSource } from '../src/plan/executeImport.js';
import { PRODUCT_LABEL } from '../src/plan/ownerProcess.js';
import { setProposalOwnerFromLabel } from '../src/plan/ownerFromLabel.js';
import { beginPlanImport } from '../src/plan/persist.js';

/**
 * D#483: the product label through discovery (an import at level 3) and through the one definer that moves an owner (0992), against real
 * Postgres. The source is a fake PlanSource: what it answers for `labelActorPermission` is what the real source derives from the issue's events
 * and the permission route (that chain is exercised against the strict GitHub fake in packages/github/test/productLabel.pg.test.ts).
 */
type Labelled = { number: number; labels?: string[]; actor?: RepoPermission | null | 'throws' | 'budget'; /** What the read just before the write answers (the label may have been taken off since the first read). */ later?: RepoPermission | null | 'throws' | 'budget' };
function source(issues: Labelled[], opts: { loop: boolean; calls?: number[] }): PlanSource {
  return {
    async head() {
      return { defaultBranch: 'main', sha: 'f'.repeat(40) };
    },
    async file(path) {
      return opts.loop && path === ENGINE_LOOP_MARKER ? '{}' : null;
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
      return { issues: issues.map((i) => ({ number: i.number, title: `Issue ${i.number}`, state: 'open' as const, labels: i.labels ?? [] })), truncated: false };
    },
    async authorPermission() {
      return 'none';
    },
    async labelActorPermission(number) {
      const seen = opts.calls?.filter((c) => c === number).length ?? 0;
      opts.calls?.push(number);
      const found = issues.find((i) => i.number === number);
      const a = seen > 0 && found && 'later' in found ? found.later : found?.actor;
      if (a === 'throws') throw new Error('github down');
      if (a === 'budget') throw Object.assign(new Error('budget'), { code: 'request_budget_exceeded' });
      return a ?? null;
    },
    evidence() {
      return { requests: [{ method: 'POST', path: '/graphql PlanRepoHead', status: 200 }], tokenPermissions: { metadata: 'read', contents: 'read', issues: 'read', discussions: 'read' } };
    },
  };
}
const LABELLED = (n: number, actor: Labelled['actor']): Labelled => ({ number: n, labels: [PRODUCT_LABEL], actor });
const PLAIN = (n: number): Labelled => ({ number: n });

describe('the product label through discovery, and the owner definer (0992)', () => {
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
    const principal = { accountId: r.accountId, userId: r.userId };
    const importWith = async (issues: Labelled[], loop = true, calls?: number[]) => {
      const importId = await beginPlanImport(appPool, principal, r.repoId);
      const out = await executePlanImport({ pool: appPool, principal, repoId: r.repoId, importId, source: source(issues, { loop, calls }) });
      expect(out.state).toBe('succeeded');
      return out;
    };
    const row = async (n: number) => (await admin.query(`SELECT id, owner_process, state, verification, work_item_id FROM proposals WHERE repo_id = $1 AND dedupe_key = $2`, [r.repoId, `gh:issue:${n}`])).rows[0] as { id: string; owner_process: string; state: string; verification: string; work_item_id: string | null } | undefined;
    const audit = async () => (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action = 'proposal.owner_changed' ORDER BY created_at`, [r.accountId])).rows as Array<{ actor: string; action: string; payload: Record<string, unknown> }>;
    /** The verifier had checked it: stamps and a claim, which a hand-over must clear. */
    const checked = async (n: number) => {
      const p = (await row(n))!;
      await admin.query(`INSERT INTO proposal_claims (proposal_id, account_id, text, verdict, checked_sha, checked_at) VALUES ($1, $2, 'a claim', 'supported', $3, now())`, [p.id, r.accountId, 'a'.repeat(40)]);
      await admin.query(`UPDATE proposals SET verification = 'check_failed', verified_at = now(), verify_attempts = 2 WHERE id = $1`, [p.id]);
    };
    const tenantCall = <T>(fn: (c: PoolClient) => Promise<T>, accountId = r.accountId, userId = r.userId) => withTenant(appPool, accountId, userId, fn);
    return { r, importWith, row, audit, checked, tenantCall };
  }

  it('a label by a maintainer or an admin makes a new issue the product\'s in discovery; every other permission, an unreadable one and no actor leave it internal_loop', async () => {
    const t = await setup();
    await t.importWith([LABELLED(1, 'maintain'), LABELLED(2, 'admin'), LABELLED(3, 'write'), LABELLED(4, 'triage'), LABELLED(5, 'read'), LABELLED(6, 'none'), LABELLED(7, null), LABELLED(8, 'throws'), PLAIN(9)]);
    expect(await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(async (n) => (await t.row(n))!.owner_process))).toEqual(['product', 'product', 'internal_loop', 'internal_loop', 'internal_loop', 'internal_loop', 'internal_loop', 'internal_loop', 'internal_loop']);
    // A proposal created as the product's is not a hand-over: no audit row, nothing moved.
    expect(await t.audit()).toEqual([]);
  });

  it('only issues carrying the label cost an events read, and a repository without the engine loop costs none (everything is the product\'s there)', async () => {
    const t = await setup();
    const calls: number[] = [];
    await t.importWith([LABELLED(1, 'admin'), PLAIN(2), { number: 3, labels: ['bug'] }], true, calls);
    // One read to establish the actor, and one more just before the write.
    expect(calls).toEqual([1, 1]);
    const u = await setup();
    const none: number[] = [];
    await u.importWith([LABELLED(1, 'admin'), PLAIN(2)], false, none);
    expect(none).toEqual([]);
    expect((await u.row(2))!.owner_process).toBe('product');
  });

  it('a re-run of discovery flips an existing new internal_loop proposal (a webhook that was missed), re-queues its check, clears its claims, and audits the move', async () => {
    const t = await setup();
    await t.importWith([PLAIN(1)]);
    expect((await t.row(1))!.owner_process).toBe('internal_loop');
    await t.checked(1);
    await t.importWith([LABELLED(1, 'maintain')]);
    expect(await t.row(1)).toMatchObject({ owner_process: 'product', state: 'new', verification: 'pending' });
    const p = (await t.row(1))!;
    expect((await admin.query(`SELECT count(*)::int n FROM proposal_claims WHERE proposal_id = $1`, [p.id])).rows[0].n).toBe(0);
    expect(await t.audit()).toEqual([{ actor: 'policy:product_label', action: 'proposal.owner_changed', payload: { proposal_id: p.id, repo_id: t.r.repoId, gh_number: 1, from: 'internal_loop', to: 'product', permission: 'maintain' } }]);
    // The audit row names no login and no issue text.
    expect(JSON.stringify((await t.audit())[0]!.payload)).not.toMatch(/Issue 1|login/);
  });

  it('a later discovery never undoes a flip: the label gone or untrusted leaves a product proposal as it is, and a second pass with the label audits nothing new', async () => {
    const t = await setup();
    await t.importWith([PLAIN(1)]);
    await t.importWith([LABELLED(1, 'admin')]);
    await t.importWith([LABELLED(1, 'admin')]);
    expect((await t.audit()).length).toBe(1);
    await t.importWith([PLAIN(1)]);
    expect((await t.row(1))!.owner_process).toBe('product');
    await t.importWith([LABELLED(1, 'write')]);
    expect((await t.row(1))!.owner_process).toBe('product');
    await t.importWith([LABELLED(1, 'throws')]);
    expect((await t.row(1))!.owner_process).toBe('product');
  });

  it('flip then take back: the definer returns the owner to internal_loop while new; discovery then does not flip it again unless the label is applied again', async () => {
    const t = await setup();
    await t.importWith([PLAIN(1)]);
    await t.importWith([LABELLED(1, 'admin')]);
    expect(await t.tenantCall((c) => setProposalOwnerFromLabel(c, t.r.repoId, 1, 'internal_loop', 'admin'))).toBe(true);
    expect((await t.row(1))!.owner_process).toBe('internal_loop');
    await t.importWith([PLAIN(1)]);
    expect((await t.row(1))!.owner_process).toBe('internal_loop');
    expect((await t.audit()).map((a) => a.payload.to)).toEqual(['product', 'internal_loop']);
    // A replay of the same take-back changes nothing and audits nothing.
    expect(await t.tenantCall((c) => setProposalOwnerFromLabel(c, t.r.repoId, 1, 'internal_loop', 'admin'))).toBe(false);
    expect((await t.audit()).length).toBe(2);
  });

  it('once decided or started, the owner is not moved either way: approved stays product, rejected stays internal_loop, a work item or a work item link stops both directions', async () => {
    const t = await setup();
    await t.importWith([PLAIN(1), PLAIN(2), PLAIN(3), PLAIN(4)]);
    // 1 is rejected (a person's decision); 2 gets a work item with its number; 3 is linked to one; 4 is the control.
    await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now() WHERE repo_id = $1 AND dedupe_key = 'gh:issue:1'`, [t.r.repoId]);
    await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance, gh_number) VALUES ($1, $2, 'bug', 'internal', 2)`, [t.r.accountId, t.r.repoId]);
    await admin.query(`UPDATE proposals SET work_item_id = $3 WHERE repo_id = $1 AND dedupe_key = $2`, [t.r.repoId, 'gh:issue:3', t.r.workItemId]);
    const moved = async (n: number, to: 'product' | 'internal_loop') => t.tenantCall((c) => setProposalOwnerFromLabel(c, t.r.repoId, n, to, 'admin'));
    expect([await moved(1, 'product'), await moved(2, 'product'), await moved(3, 'product'), await moved(4, 'product')]).toEqual([false, false, false, true]);
    // Approved (which is product by 0723's own check): the take-back is refused as well.
    await admin.query(`UPDATE proposals SET state = 'approved', decided_at = now(), roadmap_position = 1 WHERE repo_id = $1 AND dedupe_key = 'gh:issue:4'`, [t.r.repoId]);
    expect(await moved(4, 'internal_loop')).toBe(false);
    expect((await t.row(4))!.owner_process).toBe('product');
    // Discovery with the label does not touch a rejected, started or linked proposal either.
    await t.importWith([LABELLED(1, 'admin'), LABELLED(2, 'admin'), LABELLED(3, 'admin')]);
    expect(await Promise.all([1, 2, 3].map(async (n) => (await t.row(n))!.owner_process))).toEqual(['internal_loop', 'internal_loop', 'internal_loop']);
  });

  it('a spent request budget on the events read ends the checks and marks the import partial; the issues it did not reach follow the repository default', async () => {
    const t = await setup();
    const out = await t.importWith([LABELLED(1, 'budget'), LABELLED(2, 'admin')]);
    expect(out).toMatchObject({ state: 'succeeded', truncated: true });
    expect((await t.row(2))!.owner_process).toBe('internal_loop');
  });

  it('the label gone, unreadable or a lesser actor at the read just before the write: a new issue is the repository default and an existing proposal is not handed over; a spent budget there says the import is partial', async () => {
    const t = await setup();
    await t.importWith([PLAIN(1), PLAIN(2), PLAIN(3), PLAIN(4)]);
    const out = await t.importWith([
      { ...LABELLED(1, 'admin'), later: null },
      { ...LABELLED(2, 'admin'), later: 'write' },
      { ...LABELLED(3, 'admin'), later: 'throws' },
      { ...LABELLED(4, 'admin'), later: 'budget' },
      { ...LABELLED(5, 'admin'), later: null },
      { ...LABELLED(6, 'admin'), later: 'maintain' },
    ], true, []);
    expect(await Promise.all([1, 2, 3, 4, 5, 6].map(async (n) => (await t.row(n))!.owner_process))).toEqual(['internal_loop', 'internal_loop', 'internal_loop', 'internal_loop', 'internal_loop', 'product']);
    expect(await t.audit()).toEqual([]);
    expect(out).toMatchObject({ truncated: true });
    // The fresh answer's permission is the one audited.
    const u = await setup();
    await u.importWith([PLAIN(1)]);
    await u.importWith([{ ...LABELLED(1, 'admin'), later: 'maintain' }], true, []);
    expect((await u.audit())[0]!.payload).toMatchObject({ permission: 'maintain' });
  });

  it('at most MAX_LABEL_CHECKS issues are read in one import; past it the import says it is partial', async () => {
    const t = await setup();
    const calls: number[] = [];
    const many = Array.from({ length: MAX_LABEL_CHECKS + 2 }, (_, i) => LABELLED(i + 1, 'admin'));
    const out = await t.importWith(many, true, calls);
    expect(calls).toHaveLength(2 * MAX_LABEL_CHECKS);
    expect(out).toMatchObject({ truncated: true });
  });

  describe('the definer itself (RLS, principals, arguments, grants)', () => {
    it('another tenant cannot move this tenant\'s proposal: its session sees no such row and answers nothing, and the audit gets nothing', async () => {
      const a = await setup();
      const b = await setup();
      await a.importWith([PLAIN(1)]);
      const stranger = await b.tenantCall((c) => setProposalOwnerFromLabel(c, a.r.repoId, 1, 'product', 'admin'), b.r.accountId, b.r.userId);
      expect(stranger).toBe(false);
      expect((await a.row(1))!.owner_process).toBe('internal_loop');
      expect(await a.audit()).toEqual([]);
      expect(await b.audit()).toEqual([]);
    });

    it('refuses a token principal, a session with no tenant, and arguments that are not a hand-over by maintain or admin', async () => {
      const t = await setup();
      await t.importWith([PLAIN(1)]);
      const call = (c: PoolClient, args: unknown[]) => c.query('SELECT proposal_owner_from_label($1::uuid, $2::int, $3::text, $4::text)', args);
      await expect(withTenant(appPool, t.r.accountId, t.r.userId, randomUUID(), (c) => call(c, [t.r.repoId, 1, 'product', 'admin']))).rejects.toThrow(/tenant session/);
      const bare = await appPool.connect();
      try {
        await expect(call(bare, [t.r.repoId, 1, 'product', 'admin'])).rejects.toThrow(/tenant session/);
      } finally {
        bare.release();
      }
      for (const args of [[t.r.repoId, 1, 'product', 'write'], [t.r.repoId, 1, 'nobody', 'admin'], [t.r.repoId, 0, 'product', 'admin'], [null, 1, 'product', 'admin']]) {
        await expect(t.tenantCall((c) => call(c, args))).rejects.toThrow(/invalid argument/);
      }
      expect((await t.row(1))!.owner_process).toBe('internal_loop');
    });

    it('nobody can write the owner any other way: app_user holds no UPDATE on it, and the import role is still refused a change', async () => {
      const t = await setup();
      await t.importWith([PLAIN(1)]);
      await expect(t.tenantCall((c) => c.query(`UPDATE proposals SET owner_process = 'product' WHERE repo_id = $1`, [t.r.repoId]))).rejects.toThrow(/permission denied/);
      await expect(
        t.tenantCall(async (c) => {
          await c.query('SET LOCAL ROLE plan_importer');
          await c.query(`UPDATE proposals SET owner_process = 'product' WHERE repo_id = $1`, [t.r.repoId]);
        }),
      ).rejects.toThrow(/may not change the owner/);
      expect((await t.row(1))!.owner_process).toBe('internal_loop');
    });

    it('moves nothing for an issue with no proposal, a Discussion\'s proposal, or a proposal from another source', async () => {
      const t = await setup();
      await t.importWith([PLAIN(1)]);
      await admin.query(`UPDATE proposals SET sources = ARRAY['github_discussion'] WHERE repo_id = $1 AND dedupe_key = 'gh:issue:1'`, [t.r.repoId]);
      expect(await t.tenantCall((c) => setProposalOwnerFromLabel(c, t.r.repoId, 1, 'product', 'admin'))).toBe(false);
      expect(await t.tenantCall((c) => setProposalOwnerFromLabel(c, t.r.repoId, 99, 'product', 'admin'))).toBe(false);
    });
  });
});
