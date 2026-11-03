import type { Pool } from 'pg';
import { announceNewRunAction } from '../runActions/request.js';
import type { RunActionSignal } from '../runActions/signal.js';
import { markWorkPending } from '../pendingWork.js';
import { withTenant } from '../tenancy/withTenant.js';
import { keepBranchPushedByPerson, releaseManagedBranch, replaceBranchPushedByPerson } from './branchPushed.js';
import type { MarkedDone } from './store.js';

/**
 * D#598 P1g-3a: the person's answers to "someone pushed to the public branch", and the undo of Keep. The HTTP routes (session only, owner or admin) are the ONLY
 * callers: no worker, model or agent path may import this file or the three functions it wraps (a static test, `onlyPersonAnswers.test.ts`, holds that, R-597-1).
 * Each answer runs under the pressing person's tenant; the item's restart is announced after the transaction commits, as Mark done does.
 */
export interface BranchAnswerDeps {
  /** The app_user pool: every write is under the pressing person's tenant. */
  pool: Pool;
  /** The run-action kick for the restart. Absent in a deployment with no worker: the row is the durable signal and the sweep finds it. */
  signal?: RunActionSignal | null;
}

type Who = { accountId: string; userId: string; id: string };

async function announce(deps: BranchAnswerDeps, accountId: string, marked: MarkedDone): Promise<void> {
  if (!marked.changed || marked.restart === null || marked.restart.replayed) return;
  if (deps.signal) await announceNewRunAction({ signal: deps.signal }, { actionId: marked.restart.actionId, accountId, kind: 'advance_work_item' });
  else void markWorkPending('run-action-sweep');
}

/** Keep their version and stop pushing for this item. */
export async function keepBranch(deps: BranchAnswerDeps, input: Who): Promise<MarkedDone> {
  const marked = await withTenant(deps.pool, input.accountId, input.userId, undefined, (client) => keepBranchPushedByPerson(client, { id: input.id, userId: input.userId }));
  await announce(deps, input.accountId, marked);
  return marked;
}

/** Replace their version with the item's: `shownHead` is the head the person's page showed when they confirmed. */
export async function replaceBranch(deps: BranchAnswerDeps, input: Who & { shownHead: string }): Promise<MarkedDone> {
  const marked = await withTenant(deps.pool, input.accountId, input.userId, undefined, (client) => replaceBranchPushedByPerson(client, { id: input.id, userId: input.userId, shownHead: input.shownHead }));
  await announce(deps, input.accountId, marked);
  return marked;
}

/** The undo of Keep: the platform may update the branch again. Returns whether a "managed by a person" mark was cleared. */
export async function releaseBranch(deps: BranchAnswerDeps, input: { accountId: string; userId: string; workItemId: string }): Promise<boolean> {
  return withTenant(deps.pool, input.accountId, input.userId, undefined, (client) => releaseManagedBranch(client, { workItemId: input.workItemId, userId: input.userId }));
}
