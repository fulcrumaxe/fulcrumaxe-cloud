import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordStage, type RecordStageInput } from '../src/work-items/recordStage.js';
import { WorkItemHaltedError } from '../src/work-items/stages.js';
import { closeWorkItem, reopenWorkItem, sendBackToDiscussion, type OperatorMoveCtx } from '../src/work-items/operatorMoves.js';

/**
 * DP8 / DP-C6 criteria 6 and 10 against a real Postgres: a halted item is left only by a person. `recordStage` refuses an
 * automatic control-plane move out of the halt; a move INTO needs_human, a webhook fact and a person's move are exempt.
 */
describe('recordStage and a customer halt (DP-C6)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let refs: SeedRefs;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  let n = 0;
  /** An item at `stage`, halted unless told otherwise. */
  async function item(stage: string, halted = true): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, refs.accountId, refs.repoId, stage, 3000 + n++]);
    if (halted) await admin.query('UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1', [id, randomUUID()]);
    return id;
  }
  const state = async (id: string) => (await admin.query('SELECT stage, halted_at IS NOT NULL AS halted FROM work_items WHERE id = $1', [id])).rows[0] as { stage: string; halted: boolean };
  const transitions = async (id: string) => (await admin.query('SELECT to_stage, source FROM work_item_transitions WHERE work_item_id = $1 ORDER BY created_at', [id])).rows;
  const record = (input: Partial<RecordStageInput> & Pick<RecordStageInput, 'workItemId' | 'toStage'>) =>
    withTenant(appPool, refs.accountId, (client) => recordStage(client, { at: new Date(), source: 'control_plane', sourceRef: `t:${randomUUID()}`, ...input }));
  const ctx = (): OperatorMoveCtx => ({ pool: appPool, principal: { accountId: refs.accountId, userId: refs.userId, role: 'owner' }, idempotencyKey: null });

  it('6: an automatic move out of the halt is refused for every target, writes no transition and leaves the stage', async () => {
    for (const [from, to, reviewer] of [
      ['review_passed', 'changes_requested', 'code'],
      ['changes_requested', 'review_passed', 'code'],
      ['in_progress', 'pr_opened', undefined],
      ['spec_ready', 'in_progress', undefined],
    ] as const) {
      const id = await item(from);
      await expect(record({ workItemId: id, toStage: to, ...(reviewer ? { reviewer } : {}) })).rejects.toBeInstanceOf(WorkItemHaltedError);
      expect(await state(id)).toEqual({ stage: from, halted: true });
      expect(await transitions(id)).toEqual([]);
    }
  });

  it('10: the exemptions hold: into needs_human, a webhook fact and a person are recorded while halted, and the marker stays', async () => {
    const park = await item('in_progress');
    await record({ workItemId: park, toStage: 'needs_human' });
    expect(await state(park)).toEqual({ stage: 'needs_human', halted: true });

    for (const [from, to] of [['in_progress', 'pr_opened'], ['pr_opened', 'merged'], ['pr_opened', 'closed_unmerged']] as const) {
      const id = await item(from);
      await record({ workItemId: id, toStage: to, source: 'webhook' });
      expect(await state(id)).toEqual({ stage: to, halted: true });
    }

    const person = await item('review_passed');
    await record({ workItemId: person, toStage: 'changes_requested', reviewer: 'code', actor: 'person' });
    expect(await state(person)).toEqual({ stage: 'changes_requested', halted: true });
  });

  it('a replay of a transition recorded before the halt is still a duplicate, not a refusal', async () => {
    const id = await item('in_progress', false);
    const ref = `t:${randomUUID()}`;
    await record({ workItemId: id, toStage: 'pr_opened', sourceRef: ref });
    await admin.query('UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1', [id, randomUUID()]);
    expect(await record({ workItemId: id, toStage: 'pr_opened', sourceRef: ref })).toEqual({ recorded: false, reason: 'duplicate' });
  });

  it('10: Close, Reopen and Back to discussion are a person\'s moves and work on a halted item; none clears the marker', async () => {
    const closing = await item('needs_human');
    await closeWorkItem(ctx(), closing);
    expect(await state(closing)).toEqual({ stage: 'closed', halted: true });
    await reopenWorkItem(ctx(), closing);
    expect(await state(closing)).toEqual({ stage: 'triaged', halted: true });

    const back = await item('needs_human');
    const discussion = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [discussion, refs.accountId, 9000 + n, back]);
    await admin.query('UPDATE work_items SET discussion_id = $1 WHERE id = $2', [discussion, back]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 's', encode(sha256(convert_to('s', 'UTF8')), 'hex'), 'system')", [refs.accountId, back]);
    await sendBackToDiscussion(ctx(), back);
    expect(await state(back)).toEqual({ stage: 'discussing', halted: true });
  });

  it('an item that is not halted moves exactly as before', async () => {
    const id = await item('in_progress', false);
    await record({ workItemId: id, toStage: 'pr_opened' });
    expect(await state(id)).toEqual({ stage: 'pr_opened', halted: false });
  });
});
