import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../src/tenancy/errors.js';
import { loadPlanData } from '@fx/plan-data';
import { BACK_TO_DISCUSSION_REF_PREFIX, REQUEST_CHANGES_REF_PREFIX } from '../src/work-items/operatorActions.js';
import { OperatorRefusedError, RequestChangesNoteError, closeWorkItem, reopenWorkItem, requestChanges, sendBackToDiscussion, treatAsFeature, type OperatorMoveCtx } from '../src/work-items/operatorMoves.js';

/**
 * The writes behind Close, Back to discussion and Treat as a feature, against a real Postgres: one transaction each (the move or
 * the change and its audit row stand or fall together), the table consulted under the row lock, the tenant boundary, the
 * stage graph's own edges, and the audit row stamped by the definer.
 */
describe('operator moves (D#483)', () => {
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
    memberId: string;
  }
  async function tenant(): Promise<Tenant> {
    const refs = await seedAccount(admin, randomUUID());
    const memberId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [refs.accountId, memberId]);
    return { ...refs, memberId };
  }
  let n = 0;
  async function item(t: SeedRefs, o: { stage?: string; kind?: string; spec?: boolean; provenance?: string } = {}) {
    const id = randomUUID();
    const kind = o.kind ?? 'feature';
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, t.accountId, t.repoId, kind, o.provenance ?? 'internal', o.stage ?? 'needs_human', 900 + n++]);
    const discussion = randomUUID();
    await admin.query(`INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, $4, 't', $5, 'internal', 'user')`, [discussion, t.accountId, 700 + n, kind, id]);
    await admin.query(`UPDATE work_items SET discussion_id = $1 WHERE id = $2`, [discussion, id]);
    if (o.spec !== false) {
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')`, [t.accountId, id]);
    }
    return { id, discussion };
  }
  const ctx = (t: Tenant, who: 'owner' | 'member', role = who as string, key?: string): OperatorMoveCtx => ({
    pool: appUserPool,
    principal: { accountId: t.accountId, userId: who === 'owner' ? t.userId : t.memberId, role },
    idempotencyKey: key ?? null,
  });
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>(`SELECT stage FROM work_items WHERE id = $1`, [id])).rows[0]!.stage;
  const audits = async (t: SeedRefs) => (await admin.query<{ actor: string; action: string; payload: Record<string, unknown> }>(`SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'work_item.%' ORDER BY created_at`, [t.accountId])).rows;
  const moves = async (id: string) => (await admin.query<{ from_stage: string; to_stage: string; source: string; source_ref: string }>(`SELECT from_stage, to_stage, source, source_ref FROM work_item_transitions WHERE work_item_id = $1 ORDER BY created_at`, [id])).rows;

  it('Close: the stage, one control_plane transition and one audit row naming the person and the old stage, together', async () => {
    const t = await tenant();
    const { id } = await item(t, { stage: 'in_progress' });
    expect(await closeWorkItem(ctx(t, 'owner'), id)).toEqual({ workItemId: id, stage: 'closed' });
    expect(await stageOf(id)).toBe('closed');
    expect(await moves(id)).toEqual([expect.objectContaining({ from_stage: 'in_progress', to_stage: 'closed', source: 'control_plane' })]);
    expect(await audits(t)).toEqual([{ actor: t.userId, action: 'work_item.closed', payload: expect.objectContaining({ work_item_id: id, from_stage: 'in_progress' }) }]);
  });

  it('Reopen: closed -> triaged, one control_plane transition and one sent_back audit row carrying action reopen, together', async () => {
    const t = await tenant();
    const { id } = await item(t, { stage: 'closed' });
    expect(await reopenWorkItem(ctx(t, 'owner'), id)).toEqual({ workItemId: id, stage: 'triaged' });
    expect(await stageOf(id)).toBe('triaged');
    expect(await moves(id)).toEqual([expect.objectContaining({ from_stage: 'closed', to_stage: 'triaged', source: 'control_plane' })]);
    expect(await audits(t)).toEqual([{ actor: t.userId, action: 'work_item.sent_back', payload: expect.objectContaining({ work_item_id: id, from_stage: 'closed', to_stage: 'triaged', action: 'reopen' }) }]);
  });

  it('Reopen, atomically: when the audit row is refused the move is rolled back with it', async () => {
    const t = await tenant();
    const { id } = await item(t, { stage: 'closed' });
    await expect(reopenWorkItem(ctx(t, 'member', 'admin'), id)).rejects.toMatchObject({ code: '42501' });
    expect(await stageOf(id)).toBe('closed');
    expect(await moves(id)).toEqual([]);
    expect(await audits(t)).toEqual([]);
  });

  it.each(['triaged', 'needs_human', 'pr_opened', 'merged', 'closed_unmerged'])('Reopen at %s is refused by the table and writes nothing', async (stage) => {
    const t = await tenant();
    const { id } = await item(t, { stage });
    await expect(reopenWorkItem(ctx(t, 'owner'), id)).rejects.toBeInstanceOf(OperatorRefusedError);
    expect(await stageOf(id)).toBe(stage);
    expect(await moves(id)).toEqual([]);
    expect(await audits(t)).toEqual([]);
  });

  it('Close, atomically: when the audit row is refused (the caller is not really an owner or admin) the move is rolled back with it', async () => {
    const t = await tenant();
    const { id } = await item(t);
    // The caller claims to be an admin; the database knows better. The table lets it through, the audit definer does not.
    await expect(closeWorkItem(ctx(t, 'member', 'admin'), id)).rejects.toMatchObject({ code: '42501' });
    expect(await stageOf(id)).toBe('needs_human');
    expect(await moves(id)).toEqual([]);
    expect(await audits(t)).toEqual([]);
  });

  it.each(['pr_opened', 'changes_requested', 'review_passed', 'merged', 'closed_unmerged', 'closed'])('Close at %s is refused by the table and writes nothing', async (stage) => {
    const t = await tenant();
    const { id } = await item(t, { stage });
    await expect(closeWorkItem(ctx(t, 'owner'), id)).rejects.toBeInstanceOf(OperatorRefusedError);
    expect(await stageOf(id)).toBe(stage);
    expect(await moves(id)).toEqual([]);
    expect(await audits(t)).toEqual([]);
  });

  it('Back to discussion: needs_human -> discussing, the source starts with the prefix the panel counts, one audit row; the Spec stays', async () => {
    const t = await tenant();
    const { id } = await item(t);
    await sendBackToDiscussion(ctx(t, 'owner'), id);
    expect(await stageOf(id)).toBe('discussing');
    const [move] = await moves(id);
    expect(move).toMatchObject({ from_stage: 'needs_human', to_stage: 'discussing', source: 'control_plane' });
    expect(move!.source_ref.startsWith(BACK_TO_DISCUSSION_REF_PREFIX)).toBe(true);
    expect((await audits(t)).map((a) => a.action)).toEqual(['work_item.sent_back']);
    expect((await admin.query(`SELECT 1 FROM spec_versions WHERE work_item_id = $1`, [id])).rowCount).toBe(1);
  });

  it('a keyed repeat records the same source, so the transition is a duplicate, not a second move (the stage check refuses it first)', async () => {
    const t = await tenant();
    const { id } = await item(t);
    await sendBackToDiscussion(ctx(t, 'owner', 'owner', 'k1'), id);
    await expect(sendBackToDiscussion(ctx(t, 'owner', 'owner', 'k1'), id)).rejects.toBeInstanceOf(OperatorRefusedError);
    expect(await moves(id)).toHaveLength(1);
  });

  it.each([
    ['a bug (no panel)', { kind: 'bug' }],
    ['no Spec', { spec: false }],
    ['a different stage', { stage: 'discussing' }],
  ])('Back to discussion for %s is refused and writes nothing', async (_n, over) => {
    const t = await tenant();
    const { id } = await item(t, over);
    await expect(sendBackToDiscussion(ctx(t, 'owner'), id)).rejects.toBeInstanceOf(OperatorRefusedError);
    expect(await moves(id)).toEqual([]);
    expect(await audits(t)).toEqual([]);
  });

  it('Treat as a feature: the card and the discussion say feature, the audit row records old and new kind and who; the stage is unchanged', async () => {
    const t = await tenant();
    const { id, discussion } = await item(t, { stage: 'discussing', kind: 'project', spec: false });
    await treatAsFeature(ctx(t, 'owner'), id);
    expect((await admin.query(`SELECT kind FROM work_items WHERE id = $1`, [id])).rows[0].kind).toBe('feature');
    expect((await admin.query(`SELECT kind FROM discussions WHERE id = $1`, [discussion])).rows[0].kind).toBe('feature');
    expect(await stageOf(id)).toBe('discussing');
    expect(await audits(t)).toEqual([{ actor: t.userId, action: 'work_item.kind_changed', payload: expect.objectContaining({ work_item_id: id, discussion_id: discussion, from_kind: 'project', to_kind: 'feature' }) }]);
  });

  it('Treat as a feature, atomically: when the audit row is refused the kind change is rolled back with it', async () => {
    const t = await tenant();
    const { id, discussion } = await item(t, { stage: 'discussing', kind: 'project', spec: false });
    await expect(treatAsFeature(ctx(t, 'member', 'admin'), id)).rejects.toMatchObject({ code: '42501' });
    expect((await admin.query(`SELECT kind FROM work_items WHERE id = $1`, [id])).rows[0].kind).toBe('project');
    expect((await admin.query(`SELECT kind FROM discussions WHERE id = $1`, [discussion])).rows[0].kind).toBe('project');
  });

  it("another account's item, an unknown id and a malformed id are all NotFound, and nothing of the other account changes", async () => {
    const a = await tenant();
    const b = await tenant();
    const { id: theirs } = await item(b);
    for (const id of [theirs, randomUUID(), 'not-a-uuid']) {
      await expect(closeWorkItem(ctx(a, 'owner'), id), id).rejects.toBeInstanceOf(NotFoundError);
      await expect(sendBackToDiscussion(ctx(a, 'owner'), id), id).rejects.toBeInstanceOf(NotFoundError);
      await expect(treatAsFeature(ctx(a, 'owner'), id), id).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await stageOf(theirs)).toBe('needs_human');
    expect(await audits(b)).toEqual([]);
  });

  it('two presses at once: the row lock serialises them, one wins and the other is refused (no second move, no second audit row)', async () => {
    const t = await tenant();
    const { id } = await item(t, { stage: 'triaged' });
    const results = await Promise.allSettled([closeWorkItem(ctx(t, 'owner'), id), closeWorkItem(ctx(t, 'owner'), id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(OperatorRefusedError);
    expect(await moves(id)).toHaveLength(1);
    expect(await audits(t)).toHaveLength(1);
  });

  it('a live run refuses all three, under the lock', async () => {
    const t = await tenant();
    const { id } = await item(t, { stage: 'discussing', kind: 'project', spec: false });
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [randomUUID(), t.accountId, id]);
    await expect(treatAsFeature(ctx(t, 'owner'), id)).rejects.toMatchObject({ verdict: { reason: 'live' } });
    await expect(closeWorkItem(ctx(t, 'owner'), id)).rejects.toMatchObject({ verdict: { reason: 'live' } });
    expect(await audits(t)).toEqual([]);
  });

  describe('Request changes', () => {
    const notes = async (id: string) =>
      (await admin.query<{ id: string; kind: string; origin: string; status: string; body: string; created_by: string; decided_by: string; decided_via: string }>(`SELECT id, kind, origin, status, body, created_by, decided_by, decided_via FROM work_item_corrections WHERE work_item_id = $1 ORDER BY created_at`, [id])).rows;

    it.each(['pr_opened', 'review_passed', 'changes_requested'])('at %s: the note is an accepted run note of the person, and the move into Changes requested names it, in one transaction', async (stage) => {
      const t = await tenant();
      const { id } = await item(t, { stage });
      const out = await requestChanges(ctx(t, 'owner'), id, '  Fix the typo "recieve" in the comment.  ');
      expect(out).toEqual({ correctionId: expect.any(String), fromStage: stage });
      expect(await stageOf(id)).toBe('changes_requested');
      expect(await notes(id)).toEqual([{ id: out.correctionId, kind: 'run_note', origin: 'person', status: 'accepted', body: 'Fix the typo "recieve" in the comment.', created_by: t.userId, decided_by: t.userId, decided_via: 'workspace' }]);
      expect(await moves(id)).toEqual([expect.objectContaining({ from_stage: stage, to_stage: 'changes_requested', source: 'control_plane', source_ref: `${REQUEST_CHANGES_REF_PREFIX}${out.correctionId}` })]);
      const reviewer = (await admin.query<{ reviewer: string }>(`SELECT reviewer FROM work_item_transitions WHERE work_item_id = $1`, [id])).rows[0]!.reviewer;
      expect(reviewer).toBe('acceptance');
      expect((await admin.query(`SELECT action FROM audit_log WHERE account_id = $1 AND action LIKE 'work_item.correction_%' ORDER BY created_at`, [t.accountId])).rows.map((r) => r.action)).toEqual(['work_item.correction_proposed', 'work_item.correction_accepted']);
    });

    it('at Needs a person: only when it came there from an open pull request', async () => {
      const t = await tenant();
      const fromPr = await item(t, { stage: 'needs_human' });
      await admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'review_passed', 'needs_human', now(), 'control_plane', 'x')`, [t.accountId, fromPr.id]);
      await requestChanges(ctx(t, 'owner'), fromPr.id, 'rename it');
      expect(await stageOf(fromPr.id)).toBe('changes_requested');
      const fromBuild = await item(t, { stage: 'needs_human' });
      await admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'needs_human', now(), 'control_plane', 'y')`, [t.accountId, fromBuild.id]);
      await expect(requestChanges(ctx(t, 'owner'), fromBuild.id, 'rename it')).rejects.toMatchObject({ verdict: { reason: 'stage' } });
      expect(await notes(fromBuild.id)).toEqual([]);
    });

    it('refuses, writing nothing: a member, a stage with no pull request, no Spec, a live run, an empty or long note, and an item out of fix rounds', async () => {
      const t = await tenant();
      const open = await item(t, { stage: 'pr_opened' });
      await expect(requestChanges(ctx(t, 'member'), open.id, 'x')).rejects.toMatchObject({ verdict: { reason: 'role' } });
      await expect(requestChanges(ctx(t, 'owner'), open.id, '   ')).rejects.toBeInstanceOf(RequestChangesNoteError);
      await expect(requestChanges(ctx(t, 'owner'), open.id, 'é'.repeat(2001))).rejects.toBeInstanceOf(RequestChangesNoteError);
      const building = await item(t, { stage: 'in_progress' });
      await expect(requestChanges(ctx(t, 'owner'), building.id, 'x')).rejects.toMatchObject({ verdict: { reason: 'stage' } });
      const noSpec = await item(t, { stage: 'pr_opened', spec: false });
      await expect(requestChanges(ctx(t, 'owner'), noSpec.id, 'x')).rejects.toMatchObject({ verdict: { reason: 'state' } });
      const live = await item(t, { stage: 'review_passed' });
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'code-reviewer', 'local', 'running')`, [randomUUID(), t.accountId, live.id]);
      await expect(requestChanges(ctx(t, 'owner'), live.id, 'x')).rejects.toMatchObject({ verdict: { reason: 'live' } });
      const spent = await item(t, { stage: 'changes_requested' });
      for (let i = 0; i < loadPlanData().caps.maxFixRounds; i++) {
        await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'fix_round_started', $3)`, [t.accountId, spent.id, `r${i}`]);
      }
      await expect(requestChanges(ctx(t, 'owner'), spent.id, 'x')).rejects.toMatchObject({ verdict: { reason: 'rounds' } });
      for (const i of [open, building, noSpec, live, spent]) expect(await notes(i.id)).toEqual([]);
      expect(await stageOf(open.id)).toBe('pr_opened');
    });
  });
});
