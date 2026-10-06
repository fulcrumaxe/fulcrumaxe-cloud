import type { Pool, PoolClient } from 'pg';
import { CATALOGUE, type DecisionClass } from '@fx/decisions';
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
 * timeout may only proceed on the recommended option for the two class-2
 * refactor/test entries. Everything else that times out stops and flags.
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

/** Interim default until DP12a-1 adds per-account timeout outcomes. */
export const DEFAULT_ASK_POLICY: AskPolicy = Object.freeze({ answerWindowMinutes: 1440, onTimeout: 'stop_and_flag' });

/** Class-2 entries that are internal and reversible before build: the only ones that may proceed on timeout. */
const PROCEEDABLE: readonly string[] = ['nonbreaking_refactor_approach', 'test_strategy_choice'];

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
  | 'ask_proceed_not_allowed';

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

function validate(input: RaiseAskInput): { trust: string[]; policy: AskPolicy } {
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

  const policy = input.policy ?? DEFAULT_ASK_POLICY;
  if (!Number.isInteger(policy.answerWindowMinutes) || policy.answerWindowMinutes < 15 || policy.answerWindowMinutes > 20160) {
    throw new AskRaiseError('ask_window_out_of_range');
  }
  if (policy.onTimeout !== 'stop_and_flag' && policy.onTimeout !== 'proceed_recommended') {
    throw new AskRaiseError('ask_timeout_outcome_invalid');
  }
  if (policy.onTimeout === 'proceed_recommended' && !PROCEEDABLE.includes(input.decisionType)) {
    throw new AskRaiseError('ask_proceed_not_allowed');
  }
  return { trust: (quoted as ReceiptQuotedInput[]).map((q) => q.trust), policy };
}

/** Raises a pending ask through decision_ask_raise(); returns the ask id. */
export async function raiseAsk(client: PoolClient, input: RaiseAskInput): Promise<string> {
  const { trust, policy } = validate(input);
  const { rows } = await client.query<{ id: string }>(
    `SELECT decision_ask_raise($1::text, $2::text, $3::uuid, $4::uuid, $5::jsonb, $6::text,
                               $7::text, $8::jsonb, $9::integer, $10::text) AS id`,
    [input.class, input.decisionType, input.workItemId, input.runId ?? null,
      JSON.stringify(input.options.map((o) => ({ id: o.id, label: o.label }))), input.proposed,
      input.rationale, JSON.stringify(trust), policy.answerWindowMinutes, policy.onTimeout],
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
