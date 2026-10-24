import type { Pool } from 'pg';
import { withdrawSubItemAsk } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT, writeSubItemApprovalReceipt } from '@fx/db/src/receiptWriter.js';
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
  | 'parent_not_approved' | 'respec_needs_approval' | 'no_spec' | 'no_anchor_run' | 'wrong_round';

const STATUS: Record<SubItemApprovalErrorCode, 403 | 404 | 409 | 422> = {
  session_required: 403, forbidden: 403, not_found: 404, invalid_key: 422,
  parent_not_approved: 409, respec_needs_approval: 409, no_spec: 409, no_anchor_run: 409, wrong_round: 409,
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
    return await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
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
      const isFix = input.key.startsWith('fix-');
      if (isFix) {
        const m = FIX_KEY_RE.exec(input.key);
        if (m === null) throw new SubItemApprovalError('invalid_key');
        const started = (await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM work_item_driver_events WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND kind = 'fix_round_started'`, [accountId, input.workItemId])).rows[0]!.n;
        if (Number(m[1]) !== Number(started) + 1) throw new SubItemApprovalError('wrong_round');
      }
      // The open ask for THIS key, when one exists, names the anchor run. Otherwise: for a fix round, the newest SUCCEEDED run of a verdict role (the
      // driver's own list); for a planned PR, the run that published the approved Spec.
      const asks = await client.query<{ id: string; run_id: string | null }>(
        `SELECT id, run_id FROM decision_asks WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND decision_type = 'launch_sub_item' AND sub_item_key = $3::text
            AND state IN ('open', 'overdue') ORDER BY raised_at DESC, id DESC`, [accountId, input.workItemId, input.key]);
      const askRun = asks.rows.find((a) => a.run_id !== null)?.run_id ?? null;
      const anchorId = askRun ?? (isFix
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
      for (const ask of asks.rows) if (await withdrawSubItemAsk(client, ask.id, input.key)) withdrawn += 1;
      return { receiptId: receipt.id, replayed: receipt.replayed, specVersionId: spec.id, withdrawnAsks: withdrawn };
    });
  } catch (err) {
    const message = (err as { message?: string } | null)?.message ?? '';
    if ((err as { code?: string } | null)?.code === '42501') {
      throw new SubItemApprovalError(/^receipt_session_required|^ask_session_required/.test(message) ? 'session_required' : 'forbidden');
    }
    throw err;
  }
}
