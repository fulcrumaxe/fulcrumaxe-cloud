import type { Pool } from 'pg';
import { AskAnswerDefinerError, answerAskIn, catalogueClassOf } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT, ReceiptWriteError, writeReceipt } from '@fx/db/src/receiptWriter.js';
import { emitDomainEvent } from '../domain-events/emit.js';
import { announceNewRunAction, type RunActionSignal } from '../runActions/index.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#7 DP11b (DP-C9): the answer service. One transaction on the RECEIPT pool, under `withTenant` with the
 * person's user id set, so the receipt's actor is that person. It writes no run-action request (DP11c's).
 */
export type AskAnswerErrorCode =
  | 'session_required' | 'forbidden' | 'not_found' | 'already_answered' | 'invalid_choice' | 'ask_no_run' | 'ask_receipt_mismatch';

/** `status` is the HTTP status a route answers with. Branch on `code`, never on the message. */
export class AskAnswerError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422, readonly code: AskAnswerErrorCode) {
    super(code);
    this.name = 'AskAnswerError';
  }
}

export interface AskAnswerCtx {
  /** The receipt pool. A token principal (`tokenId`) can never answer. */
  pool: Pool;
  principal: { accountId: string; userId: string; tokenId?: string };
  /** Kicks the resume request this answer makes (DP11c). Optional: the run-action sweep finds the request anyway. */
  signal?: RunActionSignal;
}
export interface AskAnswerInput {
  askId: string;
  /** One of the ask's option ids, or 'deny'. */
  choice: string;
}
export interface AskAnswerResult {
  askId: string;
  receiptId: string;
  answeredOption: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Each definer exception answers as the pre-check that comes first in answerAsk does. */
const DEFINER_ERRORS: Record<AskAnswerDefinerError['code'], ConstructorParameters<typeof AskAnswerError>> = {
  ask_no_tenant: [403, 'forbidden'],
  ask_session_required: [403, 'session_required'],
  ask_forbidden: [403, 'forbidden'],
  ask_not_found: [404, 'not_found'],
  ask_bad_choice: [422, 'invalid_choice'],
  ask_no_run: [409, 'ask_no_run'],
  ask_receipt_mismatch: [409, 'ask_receipt_mismatch'],
  ask_already_answered: [409, 'already_answered'],
};

interface AskRow {
  id: string;
  repo_id: string | null;
  work_item_id: string;
  run_id: string | null;
  decision_type: string;
  options: { id: string }[];
  proposed: string;
  state: string;
  rule_set_version: number;
}

export async function answerAsk(ctx: AskAnswerCtx, input: AskAnswerInput): Promise<AskAnswerResult> {
  const { accountId, userId, tokenId } = ctx.principal;
  const choice = input.choice;
  let resumeActionId: string | null = null;
  // 1. Principal checks.
  if (tokenId !== undefined) throw new AskAnswerError(403, 'session_required');
  try {
    const result = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
      const member = await client.query<{ role: string }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
      if (member.rows[0] === undefined) throw new AskAnswerError(403, 'session_required');
      if (member.rows[0].role !== 'owner' && member.rows[0].role !== 'admin') throw new AskAnswerError(403, 'forbidden');
      // 2. Read the ask through RLS: a missing, foreign or malformed id is the same 404.
      const found = typeof input.askId === 'string' && UUID_RE.test(input.askId)
        ? await client.query<AskRow>(
          `SELECT id, repo_id, work_item_id, run_id, decision_type, options, proposed, state, rule_set_version
             FROM decision_asks WHERE id = $1::uuid AND account_id = $2::uuid`, [input.askId, accountId])
        : { rows: [] as AskRow[] };
      const ask = found.rows[0];
      if (ask === undefined) throw new AskAnswerError(404, 'not_found');
      // 3-5. Only a pending ask; a choice of this ask's or 'deny'; a run to hang the receipt on (DP-C3 3b-2).
      if (ask.state !== 'open' && ask.state !== 'overdue') throw new AskAnswerError(409, 'already_answered');
      if (typeof choice !== 'string' || (choice !== 'deny' && !ask.options.some((o) => o.id === choice))) throw new AskAnswerError(422, 'invalid_choice');
      if (ask.run_id === null) throw new AskAnswerError(409, 'ask_no_run');
      // 6. The dial version in force now; 0 (the catalogue default) when there is no row or no repo.
      const dial = ask.repo_id === null ? null : await getCurrentDialSetting(client, ask.repo_id, ask.decision_type);
      // 7. The receipt: rejectedAlternative is the recommendation the person turned down, or 'deny' when they took it.
      const cls = catalogueClassOf(ask.decision_type);
      if (cls === null) throw new ReceiptWriteError('receipt_unknown_decision_type');
      const receipt = await writeReceipt(client, {
        class: cls,
        runId: ask.run_id,
        workItemId: ask.work_item_id,
        decisionType: ask.decision_type,
        chosen: choice,
        rejectedAlternative: choice === ask.proposed ? 'deny' : ask.proposed,
        dialVersion: dial?.version ?? DIAL_VERSION_CATALOGUE_DEFAULT,
        quotedInputs: [{ trust: 'trusted', storedBody: choice }],
        // The rule set the ask was raised under (a one-time stamp; 0 is none and writes the plain receipt).
        ruleSetVersion: ask.rule_set_version,
      });
      if (receipt.store !== 'decision_receipts') throw new AskAnswerError(409, 'ask_receipt_mismatch');
      // 8. The compare-and-set, linking the receipt in the same UPDATE.
      await answerAskIn(client, { askId: ask.id, choice, receiptId: receipt.id });
      // 8b. The resume request (DP11c), in this same transaction: the person's own request, one per ask, so a replay gets the same action.
      const resume = await client.query<{ action_id: string; replayed: boolean }>('SELECT action_id, replayed FROM run_action_request($1, $2, $3, $4)',
        ['resume_decision', ask.id, `ask:${ask.id}`, `resume:${ask.id}`]);
      if (!resume.rows[0]!.replayed) resumeActionId = resume.rows[0]!.action_id;
      // 9. The event goes to the outbox on this transaction, so it exists only if the answer commits. Ids only.
      await emitDomainEvent(client, {
        type: 'decision.ask_answered',
        accountId,
        subjectId: ask.id,
        payload: {
          ask_id: ask.id, work_item_id: ask.work_item_id, run_id: ask.run_id, receipt_id: receipt.id,
          decision_type: ask.decision_type, answered_option: choice,
        },
      });
      return { askId: ask.id, receiptId: receipt.id, answeredOption: choice };
    });
    if (resumeActionId !== null && ctx.signal) await announceNewRunAction({ signal: ctx.signal }, { actionId: resumeActionId, accountId, kind: 'resume_decision' });
    return result;
  } catch (err) {
    if (err instanceof AskAnswerDefinerError) throw new AskAnswerError(...DEFINER_ERRORS[err.code]);
    throw err;
  }
}
