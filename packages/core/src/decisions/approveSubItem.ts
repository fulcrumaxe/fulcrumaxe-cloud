import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withdrawSubItemAsk } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT, writeSubItemApprovalReceipt } from '@fx/db/src/receiptWriter.js';
import { CHECK_KEY_RE, checkKeyOf } from './fixRoundGate.js';
import { ChildLaunchRefusal, fileChildLaunch, findPlannedChild, prepareChildLaunch, type ChildLaunchCode, type ChildLaunchDeps } from './childLaunch.js';
import { withTenant } from '../tenancy/withTenant.js';
import { VERDICT_ROLES } from '../work-items/verdictRoles.js';

/**
 * D#483 S5-b2a part 1: a person's Approve on one sub-item of an approved parent (a fix round, later a planned PR). One transaction on the
 * RECEIPT pool, under `withTenant` with the person's user id set, so the receipt's actor is that person:
 *
 *   - the `launch_sub_item` receipt, keyed (work item, key, the item's current Spec version), so a re-spec makes it stop counting;
 *   - the matching open ask on the same anchor run, closed with the reason `superseded`, so the decision never stays open in two places.
 *
 * It decides nothing about WHETHER the sub-item may launch: that is `resolveSubItemLaunch`, which the driver calls (part 2). Which items the
 * gate covers is the driver's rule too: only an item with an approval row AND a Spec version (an item approved before `work_item_approvals`
 * has no row and behaves as it did). This function only refuses an approval that could not matter: the parent has no person approval, or a
 * newer Spec than its latest approval names (the person re-approves the parent first).
 */
export type SubItemApprovalErrorCode =
  | 'session_required' | 'forbidden' | 'not_found' | 'invalid_key'
  | 'parent_not_approved' | 'respec_needs_approval' | 'no_spec' | 'no_anchor_run' | 'wrong_round'
  // A planned PR key (D#483 S5-b2c-1): why the child does not start. `child_build_unsupported` is the pairing guard: nothing starts until the build can build a child.
  | 'child_build_unsupported' | 'child_orphaned' | 'parent_closed' | 'key_not_in_approved_spec' | 'parent_no_envelope' | 'parent_envelope_reached' | 'child_closed';

const STATUS: Record<SubItemApprovalErrorCode, 403 | 404 | 409 | 422> = {
  session_required: 403, forbidden: 403, not_found: 404, invalid_key: 422,
  parent_not_approved: 409, respec_needs_approval: 409, no_spec: 409, no_anchor_run: 409, wrong_round: 409,
  child_build_unsupported: 409, child_orphaned: 409, parent_closed: 409, key_not_in_approved_spec: 409, parent_no_envelope: 409, parent_envelope_reached: 409, child_closed: 409,
};

/** `status` is the HTTP status a route answers with. Branch on `code`, never on the message. */
export class SubItemApprovalError extends Error {
  readonly status: 403 | 404 | 409 | 422;
  constructor(readonly code: SubItemApprovalErrorCode) {
    super(code);
    this.name = 'SubItemApprovalError';
    this.status = STATUS[code];
  }
}

export interface SubItemApprovalCtx {
  /** The receipt pool. A token principal (`tokenId`) can never approve. */
  pool: Pool;
  principal: { accountId: string; userId: string; tokenId?: string };
  /** The planned PR launch's outside pieces (the build's readiness and the envelope's room). Absent: an Approve on a planned PR key answers `child_build_unsupported`. */
  child?: ChildLaunchDeps;
}
export interface SubItemApprovalInput {
  workItemId: string;
  /** `fix-<round>` for a fix round; a planned PR's key otherwise. */
  key: string;
}
export interface SubItemApprovalResult {
  receiptId: string;
  replayed: boolean;
  specVersionId: string;
  /** How many open asks this approval closed. */
  withdrawnAsks: number;
  /** The advance request this approval filed to re-enter a workflow that was waiting on the ask (null when none was waiting, or it was already filed). */
  advanceActionId: string | null;
  /** For a planned PR key: the child this approval launched (null when it was already started, or the key is not a planned PR's). */
  childLaunchedId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9-]{1,32}$/;
const FIX_KEY_RE = /^fix-([1-9][0-9]{0,2})$/;

export async function approveSubItem(ctx: SubItemApprovalCtx, input: SubItemApprovalInput): Promise<SubItemApprovalResult> {
  const { accountId, userId, tokenId } = ctx.principal;
  if (tokenId !== undefined) throw new SubItemApprovalError('session_required');
  if (typeof input.key !== 'string' || !KEY_RE.test(input.key)) throw new SubItemApprovalError('invalid_key');
  if (typeof input.workItemId !== 'string' || !UUID_RE.test(input.workItemId)) throw new SubItemApprovalError('not_found');
  try {
    return await withTenant(ctx.pool, accountId, userId, tokenId, (client) => approveSubItemIn(client, { accountId, userId }, input, ctx.child));
  } catch (err) {
    const message = (err as { message?: string } | null)?.message ?? '';
    if ((err as { code?: string } | null)?.code === '42501') {
      throw new SubItemApprovalError(/^receipt_session_required|^ask_session_required/.test(message) ? 'session_required' : 'forbidden');
    }
    throw err;
  }
}

/**
 * The approval inside a transaction the caller owns (`withTenant` on the receipt pool with the person's user id set): the card's Approve and the answer to a
 * `launch_sub_item` ask in Needs you both run exactly this, so the two can never disagree.
 */
export async function approveSubItemIn(client: PoolClient, who: { accountId: string; userId: string }, input: SubItemApprovalInput, childDeps?: ChildLaunchDeps): Promise<SubItemApprovalResult> {
  const { accountId, userId } = who;
  const member = await client.query<{ role: string }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
  if (member.rows[0] === undefined) throw new SubItemApprovalError('session_required');
  if (member.rows[0].role !== 'owner' && member.rows[0].role !== 'admin') throw new SubItemApprovalError('forbidden');
  const item = (await client.query<{ repo_id: string | null }>('SELECT repo_id FROM work_items WHERE id = $1::uuid AND account_id = $2::uuid', [input.workItemId, accountId])).rows[0];
  if (item === undefined) throw new SubItemApprovalError('not_found');
  const spec = (await client.query<{ id: string }>(
    'SELECT id FROM spec_versions WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND erased_at IS NULL ORDER BY version DESC LIMIT 1', [accountId, input.workItemId])).rows[0];
  if (spec === undefined) throw new SubItemApprovalError('no_spec');
  const approval = (await client.query<{ spec_version_id: string | null }>(
    'SELECT spec_version_id FROM work_item_approvals WHERE account_id = $1::uuid AND work_item_id = $2::uuid ORDER BY created_at DESC, id DESC LIMIT 1', [accountId, input.workItemId])).rows[0];
  if (approval === undefined) throw new SubItemApprovalError('parent_not_approved');
  if (approval.spec_version_id !== spec.id) throw new SubItemApprovalError('respec_needs_approval');
  // A fix round is approved only for the NEXT round (rounds started + 1): an approval for any other number would hang on an unrelated run and
  // later count when that round arrives.
  // A planned PR key names a child of this parent (migration 0919). Its launch is checked before anything is written: any refusal here throws, and the whole
  // approval (the receipt included) rolls back, so a refused Approve leaves nothing. Check 5 (a sibling that has not merged) is not a block for a person.
  const childId = input.key.startsWith('fix-') || input.key.startsWith('check-') ? null : await findPlannedChild(client, accountId, input.workItemId, input.key);
  let childPlan: { launch: boolean } | null = null;
  if (childId !== null) {
    try {
      childPlan = await prepareChildLaunch(client, { accountId, childId, deps: childDeps });
    } catch (err) {
      if (err instanceof ChildLaunchRefusal) throw new SubItemApprovalError(err.code as ChildLaunchCode & SubItemApprovalErrorCode);
      throw err;
    }
  }
  const isFix = input.key.startsWith('fix-');
  if (isFix) {
    const m = FIX_KEY_RE.exec(input.key);
    if (m === null) throw new SubItemApprovalError('invalid_key');
    const started = (await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM work_item_driver_events WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND kind = 'fix_round_started'`, [accountId, input.workItemId])).rows[0]!.n;
    if (Number(m[1]) !== Number(started) + 1) throw new SubItemApprovalError('wrong_round');
  }
  // A check fix round is approved only for the failed run it would resume, and only while that run is still the item's newest executor run (a round started or a
  // later run makes the key stale). That run is the receipt's anchor: a check fix round has no review yet.
  const isCheck = input.key.startsWith('check-');
  let checkRun: string | null = null;
  if (isCheck) {
    if (!CHECK_KEY_RE.test(input.key)) throw new SubItemApprovalError('invalid_key');
    const newest = (await client.query<{ id: string; failed: boolean }>(
      `SELECT ar.id, (ar.status = 'failed' AND EXISTS (SELECT 1 FROM run_events e WHERE e.account_id = ar.account_id AND e.run_id = ar.id AND e.kind = 'run.status_changed'
                AND e.payload->>'to' = 'failed' AND e.payload->>'failureReason' = 'check_failed')) AS failed
         FROM agent_runs ar WHERE ar.account_id = $1::uuid AND ar.work_item_id = $2::uuid AND ar.role = 'executor' ORDER BY ar.created_at DESC, ar.id DESC LIMIT 1`, [accountId, input.workItemId])).rows[0];
    if (newest === undefined || !newest.failed || checkKeyOf(newest.id) !== input.key) throw new SubItemApprovalError('wrong_round');
    checkRun = newest.id;
  }
  // The open ask for THIS key, when one exists, names the anchor run. Otherwise: for a fix round, the newest SUCCEEDED run of a verdict role (the
  // driver's own list); for a planned PR, the run that published the approved Spec.
  const asks = await client.query<{ id: string; run_id: string | null }>(
    `SELECT id, run_id FROM decision_asks WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND decision_type = 'launch_sub_item' AND sub_item_key = $3::text
        AND state IN ('open', 'overdue') ORDER BY raised_at DESC, id DESC`, [accountId, input.workItemId, input.key]);
  const askRun = asks.rows.find((a) => a.run_id !== null)?.run_id ?? null;
  const anchorId = checkRun ?? askRun ?? (isFix
    ? (await client.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND role = ANY($3::text[]) AND status = 'succeeded'
        ORDER BY COALESCE(ended_at, created_at) DESC, id DESC LIMIT 1`, [accountId, input.workItemId, VERDICT_ROLES])).rows[0]?.id
    : (await client.query<{ id: string }>(
      'SELECT id FROM agent_runs WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND spec_version_id = $3::uuid ORDER BY created_at DESC, id DESC LIMIT 1',
      [accountId, input.workItemId, spec.id])).rows[0]?.id);
  if (anchorId === undefined || anchorId === null) throw new SubItemApprovalError('no_anchor_run');
  const dial = item.repo_id === null ? null : await getCurrentDialSetting(client, item.repo_id, 'launch_sub_item');
  const receipt = await writeSubItemApprovalReceipt(client, {
    runId: anchorId, workItemId: input.workItemId, key: input.key, specVersionId: spec.id, dialVersion: dial?.version ?? DIAL_VERSION_CATALOGUE_DEFAULT,
  });
  let withdrawn = 0;
  let advanceActionId: string | null = null;
  for (const ask of asks.rows) {
    if (!(await withdrawSubItemAsk(client, ask.id, input.key))) continue;
    withdrawn += 1;
    // A workflow ended waiting on this ask: ONE advance re-enters it (keyed by the ask, so a replay finds the same request). An approval nobody was waiting for files none.
    if ((isFix || isCheck) && advanceActionId === null) {
      const req = await client.query<{ action_id: string; replayed: boolean }>('SELECT action_id, replayed FROM run_action_request($1, $2, $3, $4)',
        ['advance_work_item', input.workItemId, `subitem:${ask.id}`, createHash('sha256').update(`advance_work_item:${input.workItemId}`).digest('hex')]);
      if (!req.rows[0]!.replayed) advanceActionId = req.rows[0]!.action_id;
    }
  }
  // A planned PR: the child draws on its parent's envelope and starts, filed in the person's own name (a person's click, never the dial's).
  let childLaunchedId: string | null = null;
  if (childId !== null && childPlan?.launch === true) {
    advanceActionId = await fileChildLaunch(client, { accountId, childId });
    childLaunchedId = childId;
  }
  return { receiptId: receipt.id, replayed: receipt.replayed, specVersionId: spec.id, withdrawnAsks: withdrawn, advanceActionId, childLaunchedId };
}
