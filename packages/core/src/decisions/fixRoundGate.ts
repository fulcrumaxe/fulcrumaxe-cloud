import type { Pool, PoolClient } from 'pg';
import type { PresetName } from '@fx/decisions';
import { sanitize } from '@fx/trust';
import { catalogueClassOf, keySubItemAsk, raiseAsk, withdrawSubItemAsk } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT, writeSubItemApprovalReceipt, writeSubItemPolicyReceipt } from '@fx/db/src/receiptWriter.js';
import { resolveSubItemLaunch } from '../autonomy/resolveSubItemLaunch.js';
import { VERDICT_ROLES } from '../work-items/verdictRoles.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#483 S5-b2a part 2 (R3 of the D#7 dial wiring): the driver's gate in front of a REVIEW fix round. Check-fix rounds are not gated yet (a follow-up row).
 *
 * One transaction on the RECEIPT pool, under `withTenant` (tenant on every query). The round has ONE number everywhere: the item's `fix_round_started` events + 1,
 * and the sub-item key is `fix-<that number>`. The order is fixed, and anything this file does not recognise ends in an ask or a stop, never a start:
 *
 *   1. An item with no person approval row, or with no Spec, is not gated (it was approved before the rows existed, or has nothing to re-approve): TL ruling 1(b), 2.
 *   2. A receipt keyed (item, `fix-N`, the current Spec version) means this round was already decided: go on. Only KEYED receipts count, whoever wrote them.
 *   3. An item that is not internal, or that the engine loop owns, never starts (blocked). A Spec the approval does not name (`respec_needs_approval`,
 *      `spec_version_unknown`) is blocked too: the card says "approve again", and a sub-item ask could not be answered.
 *   4. `resolveSubItemLaunch` decides with the repo's `launch_sub_item` dial: no row is Balanced (owner ruling 10-25); a row this file cannot read is Cautious.
 *      act/announce write ONE policy receipt (keyed, so a replay writes nothing) and go on; ask raises ONE ask (keyed, a live-ask unique index backs it) and the round
 *      waits; anything else is blocked.
 *   5. After a person HELD the ask for this key, a person-filed advance is the answer: it records a person receipt for the key, closes the live asks for it, and goes on.
 *      An unattended re-entry asks again. Steps 1-4 always run in a TENANT-ONLY transaction (the policy receipt definer refuses a session with a person); only step 5's
 *      receipt uses the person's session, in a transaction of its own.
 *
 * A CHECK fix round (D#483 S5-b2a part 3) goes through the same steps. It has no `fix_round_started` event, so its key names the FAILED run it would resume:
 * `check-<first 12 hex of that run's id>`. One failed run, one key, one approval; the next failed check is another run and asks again. Its anchor for the receipt is that run.
 * A failed run that is not this item's executor run, or did not fail its check, is never gated for (blocked, fail closed).
 *
 * The parent envelope is enforced by the reservation the round makes when it starts (the existing spending-limit pause), not here: the resolver is given room.
 */
export interface FixGateCtx {
  pool: Pool;
  accountId: string;
}
export interface FixGateInput {
  workItemId: string;
  /** The signed-in person whose click filed this advance, or null for an unattended re-entry. */
  personUserId: string | null;
  /** Set for a CHECK fix round: the failed (`check_failed`) executor run it would resume. Absent: a review fix round. */
  checkFailedRunId?: string;
}
export type FixGateHow = 'not_gated' | 'already_decided' | 'policy_receipt' | 'person_answer';
export type FixGateResult =
  | { proceed: true; how: FixGateHow; key: string | null; announce: boolean }
  | { proceed: false; reason: 'asked' | 'blocked'; key: string | null; blockedBy: string | null; askId: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The sub-item key of a check fix round: the first 12 hex of the failed run's id (lowercase, no dashes). Fits the database's `[a-z0-9-]{1,32}`. */
export const checkKeyOf = (failedRunId: string): string => `check-${failedRunId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
export const CHECK_KEY_RE = /^check-[0-9a-f]{12}$/;

export const FIX_ASK_START = 'fix_start';
export const FIX_ASK_HOLD = 'fix_hold';

const PRESET_OF_DISPOSITION: Readonly<Record<string, PresetName>> = { ask: 'cautious', announce: 'balanced', act: 'autonomous' };
/** No dial row is Balanced (owner ruling 10-25). A row this build cannot read is Cautious: only the ABSENCE of a row is Balanced. */
export const presetOf = (disposition: string | null | undefined): PresetName => (disposition === null || disposition === undefined ? 'balanced' : Object.hasOwn(PRESET_OF_DISPOSITION, disposition) ? PRESET_OF_DISPOSITION[disposition]! : 'cautious');
const go = (how: FixGateHow, key: string | null, announce = false): FixGateResult => ({ proceed: true, how, key, announce });
const stop = (reason: 'asked' | 'blocked', key: string | null, blockedBy: string | null, askId: string | null = null): FixGateResult => ({ proceed: false, reason, key, blockedBy, askId });

const askRationale = (title: string | null, key: string): string =>
  sanitize(`${title ? `"${title.slice(0, 200)}": ` : ''}Your setting asks before ${CHECK_KEY_RE.test(key) ? 'a check fix round' : `a fix round (${key.replace('fix-', 'round ')})`} starts. Nothing starts until you answer: start the round, or hold it.`);

export async function gateFixRound(ctx: FixGateCtx, input: FixGateInput): Promise<FixGateResult> {
  if (input.checkFailedRunId !== undefined && !UUID_RE.test(input.checkFailedRunId)) return stop('blocked', null, 'fix_launch_unreadable');
  const run = (client: PoolClient): Promise<Decided> => decide(client, ctx.accountId, input);
  let decided: Decided;
  try {
    decided = await withTenant(ctx.pool, ctx.accountId, run);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // A racing raise lost on the live-ask index: its transaction is gone, so the winner's ask is the one that stands.
    if (code === '23505') {
      try {
        decided = await withTenant(ctx.pool, ctx.accountId, run);
      } catch (again) { // fx-swallow-ok: logged with its code; the round is blocked, never started
        log('fix_gate.unreadable', again);
        return stop('blocked', null, 'fix_launch_unreadable');
      }
    } else {
      // Never swallowed: a refusal here is a defect (the decision session has no person), so it is logged with its code and the step fails.
      if (code === '42501') log('fix_gate.refused', err);
      throw err;
    }
  }
  if (!('answer' in decided)) return decided;
  // The after-hold answer: a person's receipt for the key, in the person's own session, and the live asks for the key closed.
  const { answer } = decided;
  try {
    return await withTenant(ctx.pool, ctx.accountId, answer.userId, undefined, async (client) => {
      await writeSubItemApprovalReceipt(client, { runId: answer.anchor, workItemId: input.workItemId, key: answer.key, specVersionId: answer.specId, dialVersion: answer.dialVersion });
      for (const askId of answer.liveAsks) await withdrawSubItemAsk(client, askId, answer.key);
      return go('person_answer', answer.key);
    });
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42501') {
      log('fix_gate.person_refused', err);
      return stop('blocked', answer.key, 'fix_launch_forbidden');
    }
    throw err;
  }
}

/** A fixed line with the error's code and never its text (a message can carry customer text). */
function log(event: string, err: unknown): void {
  console.warn(JSON.stringify({ event, code: (err as { code?: string } | null)?.code ?? null }));
}

type Decided = FixGateResult | { answer: { userId: string; anchor: string; specId: string; key: string; dialVersion: number; liveAsks: string[] } };

async function decide(client: PoolClient, accountId: string, input: FixGateInput): Promise<Decided> {
  const { workItemId } = input;
  const row = (await client.query<{ repo_id: string | null; provenance: string; title: string | null }>(
    'SELECT repo_id, provenance, title FROM work_items WHERE id = $1::uuid AND account_id = $2::uuid', [workItemId, accountId])).rows[0];
  if (row === undefined) return stop('blocked', null, 'fix_launch_unreadable');
  // The proposal's owner is read on its own (`workItemOrigin` stays the one path that joins a proposal to its item for provenance).
  const owner = await client.query<{ owner_process: string }>('SELECT owner_process FROM proposals WHERE account_id = $1::uuid AND work_item_id = $2::uuid LIMIT 1', [accountId, workItemId]);
  const item = { ...row, owner_process: owner.rows[0]?.owner_process ?? null };

  const spec = (await client.query<{ id: string; version: number }>(
    'SELECT id, version FROM spec_versions WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND erased_at IS NULL ORDER BY version DESC LIMIT 1', [accountId, workItemId])).rows[0];
  const approval = (await client.query<{ id: string; spec_version_id: string | null; version: number | null }>(
    `SELECT a.id, a.spec_version_id, s.version FROM work_item_approvals a
       LEFT JOIN spec_versions s ON s.account_id = a.account_id AND s.id = a.spec_version_id
      WHERE a.account_id = $1::uuid AND a.work_item_id = $2::uuid ORDER BY a.created_at DESC, a.id DESC LIMIT 1`, [accountId, workItemId])).rows[0];
  if (approval === undefined || spec === undefined) return go('not_gated', null);

  let key: string;
  if (input.checkFailedRunId !== undefined) {
    // A check fix round resumes one FAILED run of this item: it must be this item's NEWEST executor run (as approveSubItem requires), failed on its check. A stale id is not current: blocked, nothing written, no ask.
    const failed = await client.query(
      `SELECT 1 FROM agent_runs ar WHERE ar.account_id = $1::uuid AND ar.id = $2::uuid AND ar.work_item_id = $3::uuid AND ar.role = 'executor' AND ar.status = 'failed'
          AND ar.id = (SELECT n.id FROM agent_runs n WHERE n.account_id = ar.account_id AND n.work_item_id = ar.work_item_id AND n.role = 'executor' ORDER BY n.created_at DESC, n.id DESC LIMIT 1)
          AND EXISTS (SELECT 1 FROM run_events e WHERE e.account_id = ar.account_id AND e.run_id = ar.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed' AND e.payload->>'failureReason' = 'check_failed')`,
      [accountId, input.checkFailedRunId, workItemId]);
    if (failed.rowCount !== 1) return stop('blocked', null, 'fix_launch_unreadable');
    key = checkKeyOf(input.checkFailedRunId);
  } else {
    const started = (await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM work_item_driver_events WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND kind = 'fix_round_started'`, [accountId, workItemId])).rows[0]!.n;
    key = `fix-${Number(started) + 1}`;
  }

  const receipt = await client.query<{ id: string }>(
    `SELECT id FROM decision_receipts WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND decision_type = 'launch_sub_item'
        AND sub_item_key = $3::text AND spec_version_id = $4::uuid AND ($5::uuid IS NULL OR run_id = $5::uuid) LIMIT 1`, [accountId, workItemId, key, spec.id, input.checkFailedRunId ?? null]);
  if (receipt.rows[0] !== undefined) return go('already_decided', key);

  if (item.provenance !== 'internal') return stop('blocked', key, 'untrusted_work_creation');
  if (item.owner_process !== null && item.owner_process !== 'product') return stop('blocked', key, 'owned_by_internal_loop');

  const dial = item.repo_id === null ? null : await getCurrentDialSetting(client, item.repo_id, 'launch_sub_item');
  const preset = presetOf(dial?.disposition);
  const dialVersion = dial?.version ?? DIAL_VERSION_CATALOGUE_DEFAULT;

  // A review fix round hangs on the newest verdict run; a check fix round has no review yet, so it hangs on the failed run it resumes.
  const anchor = input.checkFailedRunId ?? (await client.query<{ id: string }>(
    `SELECT id FROM agent_runs WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND role = ANY($3::text[]) AND status = 'succeeded'
      ORDER BY COALESCE(ended_at, created_at) DESC, id DESC LIMIT 1`, [accountId, workItemId, VERDICT_ROLES])).rows[0]?.id;

  // 5. A person's advance after a hold on this key is the answer. Decided here, written by gateFixRound in the person's own session.
  if (input.personUserId !== null && anchor !== undefined && approval.spec_version_id === spec.id) {
    const held = await client.query(
      `SELECT 1 FROM decision_asks WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND decision_type = 'launch_sub_item' AND sub_item_key = $3::text
          AND state = 'answered' AND answered_option = $4::text LIMIT 1`, [accountId, workItemId, key, FIX_ASK_HOLD]);
    if (held.rowCount === 1) {
      const live = await client.query<{ id: string }>(
        `SELECT id FROM decision_asks WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND decision_type = 'launch_sub_item' AND sub_item_key = $3::text
            AND state IN ('open', 'overdue')`, [accountId, workItemId, key]);
      return { answer: { userId: input.personUserId, anchor, specId: spec.id, key, dialVersion, liveAsks: live.rows.map((r) => r.id) } };
    }
  }

  const decision = resolveSubItemLaunch({
    preset,
    parent: {
      ownerProcess: 'product', engineLoopRepo: false, provenance: 'internal', hasPersonApproval: true,
      approvedSpecVersion: approval.version, currentSpecVersion: spec.version,
      envelopeRemainingUsd: 0,
    },
    sub: { kind: 'fix_round', key: null, category: null },
    approvedSpecKeys: [],
    firstRunReservationUsd: 0,
    asNewItem: { verification: 'verified', freePreview: false, hasWriteInstall: true },
  });
  if (decision.reason === 'respec_needs_approval' || decision.reason === 'spec_version_unknown' || decision.reason === 'parent_not_approved') return stop('blocked', key, decision.reason);
  if (decision.outcome === 'act' || decision.outcome === 'announce') {
    if (anchor === undefined) return stop('blocked', key, 'no_anchor_run');
    const w = await writeSubItemPolicyReceipt(client, {
      runId: anchor, workItemId, key, specVersionId: spec.id, approvalId: approval.id, chosen: decision.outcome === 'announce' ? 'announce' : 'launch', dialVersion,
    });
    return go('policy_receipt', key, decision.outcome === 'announce' && !w.replayed);
  }
  if (decision.outcome !== 'ask') return stop('blocked', key, decision.reason);

  // Ask. One live ask per key: a replay finds it.
  const open = await client.query<{ id: string }>(
    `SELECT id FROM decision_asks WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND decision_type = 'launch_sub_item' AND sub_item_key = $3::text
        AND state IN ('open', 'overdue') LIMIT 1`, [accountId, workItemId, key]);
  if (open.rows[0] !== undefined) return stop('asked', key, null, open.rows[0].id);
  if (anchor === undefined) return stop('blocked', key, 'no_anchor_run');
  const cls = catalogueClassOf('launch_sub_item');
  if (cls === null || cls === 'automated_with_monitoring') return stop('blocked', key, 'fix_launch_unreadable');
  const rationale = askRationale(item.title, key);
  const askId = await raiseAsk(client, {
    class: cls, decisionType: 'launch_sub_item', workItemId, runId: anchor,
    options: [{ id: FIX_ASK_START, label: CHECK_KEY_RE.test(key) ? 'Start the check fix round' : 'Start the fix round' }, { id: FIX_ASK_HOLD, label: 'Hold it for now' }],
    proposed: FIX_ASK_START, rationale, quotedInputs: [{ trust: 'untrusted', storedBody: rationale }], preset,
  });
  if (!(await keySubItemAsk(client, askId, key))) throw new Error('fixRoundGate: the new ask could not be keyed');
  return stop('asked', key, null, askId);
}
