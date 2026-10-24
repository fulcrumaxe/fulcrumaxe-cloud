import type { Pool, PoolClient } from 'pg';
import { CATALOGUE, type CatalogueEntry, type DecisionClass, type PresetName } from '@fx/decisions';
import { resolveAskPolicyForWorkItem } from './decisionAskSettings.js';
import { RECEIPT_FENCE_END, RECEIPT_FENCE_START, type ReceiptQuotedInput } from './receiptWriter.js';
import { withTenant } from './withTenant.js';

/**
 * The TypeScript half of the decision-ask raiser (D#7 DP11a-2; the database
 * half is migrations/0666). `raiseAsk` takes a `withTenant` client on the
 * RECEIPT pool (a member of app_user and receipt_writer_invoker). The tenant
 * comes from the session inside the definer; the input has no account field.
 *
 * Checked here, before any query is sent: the decision is a CATALOGUE id of
 * the stated class, class 1 is never asked, option and proposed ids fit the
 * definer's id shape, the rationale is non-empty (the definer accepts an
 * empty one), untrusted quoted inputs are fenced `storedBody` text, and a
 * timeout may only proceed on the recommended option where the catalogue
 * entry's `timeoutOutcomes` allows it. Everything else that times out stops
 * and flags. With no explicit `policy`, the tuple is resolved from the
 * customer's ask settings and the preset (DP12a-1, resolveAskPolicy).
 */

export interface AskOption {
  id: string;
  label: string;
}

export type AskTimeoutOutcome = 'stop_and_flag' | 'proceed_recommended';

export interface AskPolicy {
  answerWindowMinutes: number;
  onTimeout: AskTimeoutOutcome;
}

/** The policy of a caller that passes an explicit one; the settings-resolved tuple replaces it when `policy` is omitted. */
export const DEFAULT_ASK_POLICY: AskPolicy = Object.freeze({ answerWindowMinutes: 1440, onTimeout: 'stop_and_flag' });

export interface RaiseAskInput {
  class: DecisionClass;
  decisionType: string;
  workItemId: string;
  runId?: string | null;
  options: readonly AskOption[];
  proposed: string;
  rationale: string;
  /** One entry per quoted input; the ask records each entry's trust class. */
  quotedInputs: readonly ReceiptQuotedInput[];
  policy?: AskPolicy;
  /** The active preset, used when `policy` is omitted. Defaults to the most cautious one. */
  preset?: PresetName;
  /**
   * The version of the customer's approval rules this ask was raised under (D#7 AAP-a4); 0, the default, is "no rule set". Stored on the ask
   * once and never changed. The definer refuses a version above the highest one of the item's scope.
   */
  ruleSetVersion?: number;
}

export type AskErrorCode =
  | 'ask_invalid_class'
  | 'ask_class1_never_asks'
  | 'ask_missing_decision_type'
  | 'ask_unknown_decision_type'
  | 'ask_decision_class_mismatch'
  | 'ask_missing_work_item'
  | 'ask_options_invalid'
  | 'ask_proposed_invalid'
  | 'ask_missing_rationale'
  | 'ask_missing_trust_classes'
  | 'ask_untrusted_input_not_stored_body'
  | 'ask_window_out_of_range'
  | 'ask_timeout_outcome_invalid'
  | 'ask_proceed_not_allowed'
  | 'ask_rule_set_version_invalid';

/** Thrown before any query is sent. `code` is the named error; branch on it, not on the message. */
export class AskRaiseError extends Error {
  constructor(readonly code: AskErrorCode) {
    super(code);
    this.name = 'AskRaiseError';
  }
}

const CLASSES: readonly string[] = ['automated_with_monitoring', 'human_over_the_loop', 'human_in_the_loop'];
/** The definer's option-id shape; 'deny' is reserved. */
const ASK_OPTION_ID = /^[a-z][a-z0-9_]{0,31}$/;
const RATIONALE_MAX_BYTES = 4096;
const LABEL_MAX = 200;

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isOptionId = (v: unknown): v is string => typeof v === 'string' && ASK_OPTION_ID.test(v) && v !== 'deny';

/** Exactly one fence, at the ends: the shape `sanitize()` produces. */
function isFenced(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  if (!body.startsWith(`${RECEIPT_FENCE_START}\n`) || !body.endsWith(`\n${RECEIPT_FENCE_END}`)) return false;
  const inner = body.slice(RECEIPT_FENCE_START.length + 1, body.length - RECEIPT_FENCE_END.length - 1);
  return !inner.includes(RECEIPT_FENCE_START) && !inner.includes(RECEIPT_FENCE_END);
}

function checkPolicy(policy: AskPolicy, entry: CatalogueEntry): void {
  if (!Number.isInteger(policy.answerWindowMinutes) || policy.answerWindowMinutes < 15 || policy.answerWindowMinutes > 20160) {
    throw new AskRaiseError('ask_window_out_of_range');
  }
  if (policy.onTimeout !== 'stop_and_flag' && policy.onTimeout !== 'proceed_recommended') {
    throw new AskRaiseError('ask_timeout_outcome_invalid');
  }
  if (policy.onTimeout === 'proceed_recommended' && !entry.timeoutOutcomes.includes('proceed_recommended')) {
    throw new AskRaiseError('ask_proceed_not_allowed');
  }
}

function validate(input: RaiseAskInput): { trust: string[]; entry: CatalogueEntry } {
  if (!CLASSES.includes(input.class)) throw new AskRaiseError('ask_invalid_class');
  if (input.class === 'automated_with_monitoring') throw new AskRaiseError('ask_class1_never_asks');
  if (!isText(input.decisionType)) throw new AskRaiseError('ask_missing_decision_type');
  const entry = CATALOGUE.find((e) => e.id === input.decisionType);
  if (!entry) throw new AskRaiseError('ask_unknown_decision_type');
  if (entry.class !== input.class) throw new AskRaiseError('ask_decision_class_mismatch');
  if (!isText(input.workItemId)) throw new AskRaiseError('ask_missing_work_item');

  const options = input.options as unknown;
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) throw new AskRaiseError('ask_options_invalid');
  const ids = new Set<string>();
  for (const o of options as AskOption[]) {
    const keys = o && typeof o === 'object' ? Object.keys(o).sort().join(',') : '';
    if (
      keys !== 'id,label' || !isOptionId(o.id) || typeof o.label !== 'string' ||
      o.label.length < 1 || o.label.length > LABEL_MAX
    ) {
      throw new AskRaiseError('ask_options_invalid');
    }
    ids.add(o.id);
  }
  if (ids.size !== options.length) throw new AskRaiseError('ask_options_invalid');
  if (!isOptionId(input.proposed) || !ids.has(input.proposed)) throw new AskRaiseError('ask_proposed_invalid');

  if (!isText(input.rationale) || Buffer.byteLength(input.rationale, 'utf8') > RATIONALE_MAX_BYTES) {
    throw new AskRaiseError('ask_missing_rationale');
  }

  const quoted = input.quotedInputs as unknown;
  if (!Array.isArray(quoted) || quoted.some((q) => q?.trust !== 'trusted' && q?.trust !== 'untrusted')) {
    throw new AskRaiseError('ask_missing_trust_classes');
  }
  for (const q of quoted as ReceiptQuotedInput[]) {
    if (q.trust === 'untrusted' && !isFenced(q.storedBody)) throw new AskRaiseError('ask_untrusted_input_not_stored_body');
  }

  const version = input.ruleSetVersion;
  if (version !== undefined && (!Number.isInteger(version) || version < 0 || version > 2_147_483_647)) throw new AskRaiseError('ask_rule_set_version_invalid');

  return { trust: (quoted as ReceiptQuotedInput[]).map((q) => q.trust), entry };
}

/** The tuple the customer's settings and preset resolve to, in this function's `onTimeout` naming. */
async function fromSettings(client: PoolClient, input: RaiseAskInput, entry: CatalogueEntry): Promise<AskPolicy> {
  const p = await resolveAskPolicyForWorkItem(client, { decisionType: entry.id, workItemId: input.workItemId, preset: input.preset ?? 'cautious' });
  return { answerWindowMinutes: p.answerWindowMinutes, onTimeout: p.timeoutOutcome };
}

/** Raises a pending ask through decision_ask_raise(); returns the ask id. */
export async function raiseAsk(client: PoolClient, input: RaiseAskInput): Promise<string> {
  const { trust, entry } = validate(input);
  const policy = input.policy ?? await fromSettings(client, input, entry);
  checkPolicy(policy, entry);
  const { rows } = await client.query<{ id: string }>(
    `SELECT decision_ask_raise($1::text, $2::text, $3::uuid, $4::uuid, $5::jsonb, $6::text,
                               $7::text, $8::jsonb, $9::integer, $10::text, $11::integer) AS id`,
    [input.class, input.decisionType, input.workItemId, input.runId ?? null,
      JSON.stringify(input.options.map((o) => ({ id: o.id, label: o.label }))), input.proposed,
      input.rationale, JSON.stringify(trust), policy.answerWindowMinutes, policy.onTimeout, input.ruleSetVersion ?? 0],
  );
  return rows[0]!.id;
}

export interface OpenAsk {
  id: string;
  repoId: string | null;
  workItemId: string;
  runId: string | null;
  decisionType: string;
  options: AskOption[];
  proposed: string;
  rationale: string;
  inputTrustClasses: string[];
  raisedAt: Date;
  answerDueAt: Date;
  timeoutOutcome: AskTimeoutOutcome;
  state: 'open' | 'overdue';
}

/** Keyset cursor: the last row's due time (as Postgres text, microsecond-exact) and id. */
export interface OpenAskCursor {
  answerDueAt: string;
  id: string;
}

export interface ListOpenAsksResult {
  asks: OpenAsk[];
  nextCursor: OpenAskCursor | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AskRow {
  id: string;
  repo_id: string | null;
  work_item_id: string;
  run_id: string | null;
  decision_type: string;
  options: AskOption[];
  proposed: string;
  rationale: string;
  input_trust_classes: string[];
  raised_at: Date;
  answer_due_at: Date;
  due_text: string;
  timeout_outcome: AskTimeoutOutcome;
  state: 'open' | 'overdue';
}

/**
 * Open and overdue asks for one tenant, soonest due first. RLS scopes the
 * read; the explicit account filter is a second, independent fence.
 */
export async function listOpenAsks(
  ctx: { pool: Pool; accountId: string },
  opts: { limit?: number; after?: OpenAskCursor } = {},
): Promise<ListOpenAsksResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('listOpenAsks: limit must be 1..200');
  const after = opts.after;
  if (after && (!isText(after.answerDueAt) || !UUID_RE.test(after.id))) throw new TypeError('listOpenAsks: bad cursor');

  const rows = await withTenant(ctx.pool, ctx.accountId, async (client) => {
    const res = await client.query<AskRow>(
      `SELECT id, repo_id, work_item_id, run_id, decision_type, options, proposed, rationale,
              input_trust_classes, raised_at, answer_due_at, answer_due_at::text AS due_text,
              timeout_outcome, state
         FROM decision_asks
        WHERE account_id = $1::uuid
          AND state IN ('open', 'overdue')
          AND ($2::timestamptz IS NULL OR (answer_due_at, id) > ($2::timestamptz, $3::uuid))
        ORDER BY answer_due_at, id
        LIMIT $4::integer`,
      [ctx.accountId, after?.answerDueAt ?? null, after?.id ?? null, limit + 1],
    );
    return res.rows;
  });

  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page[page.length - 1]! : null;
  return {
    asks: page.map((r) => ({
      id: r.id,
      repoId: r.repo_id,
      workItemId: r.work_item_id,
      runId: r.run_id,
      decisionType: r.decision_type,
      options: r.options,
      proposed: r.proposed,
      rationale: r.rationale,
      inputTrustClasses: r.input_trust_classes,
      raisedAt: r.raised_at,
      answerDueAt: r.answer_due_at,
      timeoutOutcome: r.timeout_outcome,
      state: r.state,
    })),
    nextCursor: last ? { answerDueAt: last.due_text, id: last.id } : null,
  };
}

/** The CATALOGUE class of a decision id, or null when the id is not in the catalogue. */
export function catalogueClassOf(decisionType: string): DecisionClass | null {
  return CATALOGUE.find((e) => e.id === decisionType)?.class ?? null;
}

/** The named exceptions decision_ask_answer() raises (migration 0797). */
export const ASK_ANSWER_EXCEPTIONS = [
  'ask_no_tenant', 'ask_session_required', 'ask_forbidden', 'ask_not_found',
  'ask_bad_choice', 'ask_no_run', 'ask_receipt_mismatch', 'ask_already_answered',
] as const;

/** Thrown by `answerAskIn`. `code` is the exception name; branch on it, not on the message. */
export class AskAnswerDefinerError extends Error {
  constructor(readonly code: (typeof ASK_ANSWER_EXCEPTIONS)[number]) {
    super(code);
    this.name = 'AskAnswerDefinerError';
  }
}

/**
 * Answers an ask through decision_ask_answer() on a receipt-pool `withTenant` client with the person's user
 * id set; the receipt was written earlier on the same client. The exception name is the text before the first
 * colon of the message, and only a listed name counts. A unique violation on the receipt link (a second ask
 * claiming the same receipt) is a receipt mismatch. Any other error passes through as it is.
 */
export async function answerAskIn(client: PoolClient, input: { askId: string; choice: string; receiptId: string }): Promise<void> {
  try {
    await client.query('SELECT decision_ask_answer($1::uuid, $2::text, $3::uuid)', [input.askId, input.choice, input.receiptId]);
  } catch (err) {
    const e = err as { code?: string; message?: string } | null;
    const name = e?.code === '23505' ? 'ask_receipt_mismatch' : /^([a-z_]+)(?::|$)/.exec(e?.message ?? '')?.[1];
    const known = ASK_ANSWER_EXCEPTIONS.find((n) => n === name);
    if (known !== undefined) throw new AskAnswerDefinerError(known);
    throw err;
  }
}

/** Why an ask was withdrawn (migration 0826). Stored on the row as `withdrawn_reason`. */
export const ASK_WITHDRAW_REASONS = ['item_closed', 'item_halted', 'superseded'] as const;
export type AskWithdrawReason = (typeof ASK_WITHDRAW_REASONS)[number];

export interface WithdrawnAsk {
  askId: string;
  reason: AskWithdrawReason;
}

/** The most one sweep moves; the definer refuses a limit outside 1..500. */
export const ASK_WITHDRAW_DEFAULT_LIMIT = 100;

/**
 * One sweep of `decision_ask_withdraw()` (migration 0826) on the RECEIPT pool: every open or overdue ask whose item is closed, merged,
 * halted, or has a newer executor run is moved to `withdrawn` with its reason, across tenants. It is for the worker's tick only: the
 * definer needs no session tenant, and nothing in the result is user text. Returns the asks that moved in this call, oldest first.
 */
export async function withdrawStaleAsks(pool: Pick<Pool, 'query'>, limit: number = ASK_WITHDRAW_DEFAULT_LIMIT): Promise<WithdrawnAsk[]> {
  const { rows } = await pool.query<{ o_ask_id: string; o_reason: string }>(
    'SELECT o_ask_id, o_reason FROM decision_ask_withdraw($1::integer)',
    [limit],
  );
  return rows.map((r) => {
    const reason = ASK_WITHDRAW_REASONS.find((x) => x === r.o_reason);
    if (reason === undefined) throw new Error('decision_ask_withdraw returned an unknown reason');
    return { askId: r.o_ask_id, reason };
  });
}

/**
 * D#7 DP4b-2 (R-7-DP4b-2): is this item waiting on an answer? Derived from current truth, never a stamp: the item has an `open` or `overdue` ask whose
 * run is the item's newest executor run. An ask on an older run (the item has moved on), or one that is answered, proceeded or withdrawn, is not a wait.
 * The one definition the worker's `advanceBuildFailed` check and the activity read both use. `client` must come from `withTenant`.
 */
export async function isItemWaitingOnAnswer(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<boolean> {
  const { rows } = await client.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM decision_asks a
        WHERE a.work_item_id = $1::uuid AND a.state IN ('open', 'overdue')
          AND a.run_id = (SELECT r.id FROM agent_runs r WHERE r.work_item_id = $1::uuid AND r.role = 'executor' ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
     ) AS waiting`,
    [workItemId],
  );
  return rows[0]?.waiting === true;
}

/** The most one reconcile enqueues; the definer refuses a limit outside 1..500. */
export const RESUME_RECONCILE_DEFAULT_LIMIT = 100;

export interface EnqueuedResume {
  actionId: string;
  askId: string;
}

/**
 * D#7 DP11c (DP-C9 section 5, criterion 7): one pass of `resume_decision_reconcile()` (migration 0860) on the RECEIPT pool. Every answered or
 * proceeded ask that has no `resume_decision` request, of any state, gets a system request. Across tenants, for the worker's tick only; nothing in
 * the result is user text. A repeat finds nothing new, and two passes at once cannot both enqueue the same ask (a unique index decides).
 */
export async function reconcileResumeRequests(pool: Pick<Pool, 'query'>, limit: number = RESUME_RECONCILE_DEFAULT_LIMIT): Promise<EnqueuedResume[]> {
  const { rows } = await pool.query<{ o_action_id: string; o_ask_id: string }>(
    'SELECT o_action_id, o_ask_id FROM resume_decision_reconcile($1::integer)',
    [limit],
  );
  return rows.map((r) => ({ actionId: r.o_action_id, askId: r.o_ask_id }));
}

/** The most one window-end sweep lists; the definer refuses a limit outside 1..500. */
export const ASK_DUE_DEFAULT_LIMIT = 100;

export interface DueAsk {
  askId: string;
  accountId: string;
}

/**
 * Which open asks are past their answer window at `now`, across tenants, soonest due first (migration 0853,
 * `decision_ask_due`). A read only: nothing is locked or moved here, the claim is `timeOutAskIn`'s. It is for the
 * worker's tick only, on the RECEIPT pool with no tenant set; nothing in the result is user text. The definer
 * refuses a `now` more than a minute ahead of the database clock.
 */
export async function listDueAsks(pool: Pick<Pool, 'query'>, now: Date, limit: number = ASK_DUE_DEFAULT_LIMIT): Promise<DueAsk[]> {
  const { rows } = await pool.query<{ o_ask_id: string; o_account_id: string }>(
    'SELECT o_ask_id, o_account_id FROM decision_ask_due($1::timestamptz, $2::integer)',
    [now, limit],
  );
  return rows.map((r) => ({ askId: r.o_ask_id, accountId: r.o_account_id }));
}

/** The named exceptions decision_ask_time_out() raises (migration 0853). */
export const ASK_TIMEOUT_EXCEPTIONS = [
  'ask_no_tenant', 'ask_sweep_system_only', 'ask_sweep_bad_time', 'ask_sweep_bad_outcome',
  'ask_receipt_mismatch', 'ask_sweep_not_proceedable', 'ask_no_run',
] as const;

/** Thrown by `timeOutAskIn`. `code` is the exception name; branch on it, not on the message. */
export class AskTimeoutDefinerError extends Error {
  constructor(readonly code: (typeof ASK_TIMEOUT_EXCEPTIONS)[number]) {
    super(code);
    this.name = 'AskTimeoutDefinerError';
  }
}

/**
 * Ends one ask's window through decision_ask_time_out() on a receipt-pool `withTenant` client with NO user or token set
 * (the system). Returns true when this call moved the ask; false when it moved nothing (the row is locked by an answer or
 * a withdrawal, is no longer open, or is not yet due), in which case the caller rolls back what it wrote for the ask.
 * `to: 'proceeded'` needs the policy receipt written earlier on the same client. A unique violation on the receipt link
 * is a receipt mismatch; any other error passes through as it is.
 */
export async function timeOutAskIn(
  client: PoolClient,
  input: { askId: string; now: Date; to: 'overdue' | 'proceeded'; receiptId?: string },
): Promise<boolean> {
  try {
    const { rows } = await client.query<{ moved: boolean }>(
      'SELECT decision_ask_time_out($1::uuid, $2::timestamptz, $3::text, $4::uuid) AS moved',
      [input.askId, input.now, input.to, input.receiptId ?? null],
    );
    return rows[0]!.moved;
  } catch (err) {
    const e = err as { code?: string; message?: string } | null;
    const name = e?.code === '23505' ? 'ask_receipt_mismatch' : /^([a-z_]+)(?::|$)/.exec(e?.message ?? '')?.[1];
    const known = ASK_TIMEOUT_EXCEPTIONS.find((n) => n === name);
    if (known !== undefined) throw new AskTimeoutDefinerError(known);
    throw err;
  }
}

/**
 * D#483 S5-b2a: closes ONE `launch_sub_item` ask of the session's tenant with the reason `superseded` (migration 0906), because a person's
 * Approve on the card decided the same question. The ask must carry the same sub-item key. True when it moved; false when it was already closed or is not such an ask. A token, a
 * plain member and a non-session caller are refused by the definer.
 */
export async function withdrawSubItemAsk(client: PoolClient, askId: string, key: string): Promise<boolean> {
  const { rows } = await client.query<{ moved: boolean }>('SELECT decision_ask_withdraw_by_id($1::uuid, $2::text) AS moved', [askId, key]);
  return rows[0]!.moved;
}
