import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { announceNewRunAction, type RunActionKind, type RunActionSignal } from '../runActions/index.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { ForbiddenError, NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { WORK_ITEM_PRIORITIES } from '../work-items/read.js';
import { setWorkItemPriorityIn } from '../work-items/priority.js';
import { operatorVerdict, readOperatorFacts, type OperatorVerdict } from '../work-items/operatorActions.js';
import {
  CorrectionInputError,
  decideCorrection,
  getCorrection,
  markCorrectionApplied,
  type Correction,
  type CorrectionCtx,
  type CorrectionVia,
} from './index.js';

/** The two bodies that are data rather than prose (D#597 CC-2a). Both are one JSON object with fixed keys, checked when the correction is made and again when it is accepted. */
export interface PriorityBody {
  priority: (typeof WORK_ITEM_PRIORITIES)[number];
}
export interface NewItemBody {
  title: string;
  kind: string;
  body: string;
}

function parseObject(body: string, keys: readonly string[]): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    // fx-swallow-ok: unparseable text is a refused correction body, not a crash
    throw new CorrectionInputError('this kind of correction needs a JSON body');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CorrectionInputError('this kind of correction needs a JSON object');
  const got = Object.keys(v);
  if (got.length !== keys.length || !keys.every((k) => got.includes(k))) throw new CorrectionInputError('unexpected fields in the correction body');
  return v as Record<string, unknown>;
}

export function parsePriorityBody(body: string): PriorityBody {
  const o = parseObject(body, ['priority']);
  if (!(WORK_ITEM_PRIORITIES as readonly unknown[]).includes(o.priority)) throw new CorrectionInputError('unknown priority');
  return { priority: o.priority as PriorityBody['priority'] };
}

export function parseNewItemBody(body: string, kinds: readonly string[]): NewItemBody {
  const o = parseObject(body, ['title', 'kind', 'body']);
  if (typeof o.title !== 'string' || o.title.length < 1 || o.title.length > 256) throw new CorrectionInputError('title must be 1 to 256 characters');
  if (typeof o.kind !== 'string' || !kinds.includes(o.kind)) throw new CorrectionInputError('unknown item kind');
  if (typeof o.body !== 'string') throw new CorrectionInputError('body must be text');
  return { title: o.title, kind: o.kind, body: o.body };
}

/** Throws CorrectionInputError when a correction of this kind and body could never be applied. */
export function checkBody(kind: string, body: string, itemKinds: readonly string[]): void {
  if (kind === 'priority') parsePriorityBody(body);
  if (kind === 'new_item') parseNewItemBody(body, itemKinds);
}

/** Maps to 409 `content_changed`. */
export class ContentChangedError extends Error {
  constructor() {
    super('content changed');
    this.name = 'ContentChangedError';
  }
}

/**
 * Maps to 409: a Spec amendment cannot be accepted now. `reason` is the operator table's own (`live` is `already_running`, the same refusal as
 * Re-spec; the rest are `action_not_available` or the table's other fixed codes). Nothing was decided.
 */
export class AmendRefusedError extends Error {
  constructor(public readonly verdict: Extract<OperatorVerdict, { ok: false }>) {
    super(verdict.message);
    this.name = 'AmendRefusedError';
  }
}

/** Maps to 503: pausing, and delivering a Spec amendment, need the run-action worker. Nothing was decided. */
export class PauseUnavailableError extends Error {
  constructor() {
    super('pause unavailable');
    this.name = 'PauseUnavailableError';
  }
}

/** Maps to 500 `apply_failed`. For question, pause and priority nothing was changed (the whole step rolled back and the correction is still `proposed`); for new_item the decision may be recorded without the item. */
export class ApplyFailedError extends Error {
  constructor() {
    super('apply failed');
    this.name = 'ApplyFailedError';
  }
}

export interface AcceptDeps {
  /** The run-action signal; null when no worker is registered. */
  signal: RunActionSignal | null;
  /** Creates the Discussion for a `new_item` correction, as the deciding person. */
  createItem: (item: NewItemBody) => Promise<void>;
  itemKinds: readonly string[];
}

export type DecisionResult =
  | { outcome: 'decided'; correction: Correction }
  | { outcome: 'already_decided'; correction: Correction };

export interface DecideInput {
  id: string;
  via: CorrectionVia;
  /** When given, it must equal the stored hash. */
  contentHash?: string;
}

function assertHash(c: Correction, given: string | undefined): void {
  if (given !== undefined && given !== c.contentHash) throw new ContentChangedError();
}

/** The caller is acting as a person: a person's user id on the transaction, and an owner or admin role. Never the userless driver path. */
async function requireDeciderIn(client: PoolClient, ctx: CorrectionCtx): Promise<MembershipRole> {
  const { accountId, userId } = ctx.principal;
  await assertActiveMembership(client, accountId, userId);
  const { rows } = await client.query<{ role: MembershipRole }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
  requireOwnerOrAdmin(rows[0]?.role ?? null);
  return rows[0]!.role;
}

/**
 * Whether an amendment can be delivered to the item now, asked of the same table Re-spec asks (the owner/admin role, an internal item with a repository and
 * an issue, no live run, and a stage a build starts from: Spec ready or Needs a person). The row is locked, as Re-spec's check does. The "file list is
 * missing" rule is Re-spec's own reason for existing, so it is set aside here: an amendment goes onto a Spec that has its list.
 */
async function assertAmendableIn(client: PoolClient, workItemId: string, role: MembershipRole): Promise<void> {
  const facts = await readOperatorFacts(client, workItemId, role, true);
  if (!facts) throw new NotFoundError('work item not found');
  const verdict = operatorVerdict('respec', { ...facts, spec_file_list_known: false });
  if (!verdict.ok) throw new AmendRefusedError(verdict);
}

/** The database decide function on the caller's transaction (it re-checks owner or admin and takes the row lock). */
async function decideIn(client: PoolClient, id: string, to: 'accepted' | 'rejected', via: CorrectionVia): Promise<'decided' | 'already_decided'> {
  const { rows } = await client.query<{ r: string }>('SELECT work_item_correction_decide($1::uuid, $2::text, $3::text) AS r', [id, to, via]);
  return rows[0]!.r === 'decided' ? 'decided' : 'already_decided';
}

function mapDecideError(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === '42501') return new ForbiddenError('not allowed to do that to a correction');
  if (code === 'P0002' || code === '23503') return new NotFoundError('correction not found');
  return err;
}

/** Rejects a correction. Owner or admin session only; the route refuses tokens. Rejecting never needs a worker. */
export async function rejectCorrection(ctx: CorrectionCtx, input: DecideInput): Promise<DecisionResult> {
  assertHash(await getCorrection(ctx, input.id), input.contentHash);
  return decideCorrection(ctx, { id: input.id, to: 'rejected', via: input.via });
}

/**
 * Accepts a correction and, for question, pause, priority and new_item, applies it through the existing writers and stamps it
 * `applied`. A run note stays `accepted` for the driver to attach to a run. A Spec amendment stays `accepted` until the amend run action publishes
 * the next Spec version (CC-2b); accepting it asks for that action in the same transaction as the decision. Everything that can be refused is
 * refused before anything is written.
 *
 * Question, pause and priority run decision, effect and stamp in ONE transaction: any failure rolls all of it back and the
 * correction is still `proposed`. For a pause the effect is the request for the halt (`cancel_work_item`); the worker marks the
 * item halted when it performs the request, and only a person's later resume clears it. A new_item cannot join the transaction
 * (the Discussions writer opens its own), so it is decided first, then created, then stamped; a failure between leaves it
 * `accepted`, which ApplyFailedError's callers report as such.
 */
export async function acceptCorrection(ctx: CorrectionCtx, input: DecideInput, deps: AcceptDeps): Promise<DecisionResult> {
  const { accountId, userId } = ctx.principal;
  const before = await getCorrection(ctx, input.id);
  assertHash(before, input.contentHash);
  if (before.status !== 'proposed') return { outcome: 'already_decided', correction: before };
  checkBody(before.kind, before.body, deps.itemKinds);
  if ((before.kind === 'pause' || before.kind === 'spec_amend') && deps.signal === null) throw new PauseUnavailableError();

  if (before.kind === 'new_item') {
    const decided = await decideCorrection(ctx, { id: input.id, to: 'accepted', via: input.via });
    if (decided.outcome !== 'decided') return decided;
    try {
      await deps.createItem(parseNewItemBody(before.body, deps.itemKinds));
      await withTenant(ctx.pool, accountId, userId, (client: PoolClient) => markCorrectionApplied(client, { id: before.id, runId: null }));
    } catch {
      // fx-swallow-ok: the caller gets a fixed answer; the row stays `accepted`, so it can still be rejected
      throw new ApplyFailedError();
    }
    return { outcome: 'decided', correction: await getCorrection(ctx, before.id) };
  }

  let announce: { actionId: string; kind: RunActionKind } | null = null;
  let outcome: 'decided' | 'already_decided';
  try {
    outcome = await withTenant(ctx.pool, accountId, userId, async (client: PoolClient) => {
      const role = await requireDeciderIn(client, ctx);
      // Refused BEFORE the decision, so a refusal leaves the correction `proposed` and writes nothing.
      if (before.kind === 'spec_amend') await assertAmendableIn(client, before.workItemId, role);
      const r = await decideIn(client, before.id, 'accepted', input.via);
      if (r !== 'decided') return r;
      if (before.kind === 'run_note') return r;
      if (before.kind === 'spec_amend') {
        // Delivered by the amend run action, which publishes the Spec version and then stamps this row `applied`. Until then it is `accepted`, and a
        // person may still reject it. Keyed by the correction, so a repeat is the same request.
        const requestHash = createHash('sha256').update(`amend_spec_work_item:${before.workItemId.toLowerCase()}`).digest('hex');
        const { rows } = await client.query<{ action_id: string; replayed: boolean }>(
          'SELECT action_id, replayed FROM run_action_request($1, $2, $3, $4)',
          ['amend_spec_work_item', before.workItemId, `correction:${before.id}`, requestHash],
        );
        if (!rows[0]!.replayed) announce = { actionId: rows[0]!.action_id, kind: 'amend_spec_work_item' };
        return r;
      }
      if (before.kind === 'pause') {
        const requestHash = createHash('sha256').update(`cancel_work_item:${before.workItemId.toLowerCase()}`).digest('hex');
        const { rows } = await client.query<{ action_id: string; replayed: boolean }>(
          'SELECT action_id, replayed FROM run_action_request($1, $2, $3, $4)',
          ['cancel_work_item', before.workItemId, `correction:${before.id}`, requestHash],
        );
        if (!rows[0]!.replayed) announce = { actionId: rows[0]!.action_id, kind: 'cancel_work_item' };
      } else if (before.kind === 'priority') {
        const { priority } = parsePriorityBody(before.body);
        await setWorkItemPriorityIn(client, ctx.principal, {
          workItemId: before.workItemId,
          priority: WORK_ITEM_PRIORITIES.indexOf(priority),
          attribution: { correctionId: before.id, via: before.origin === 'agent' ? 'assistant' : input.via },
        });
      }
      if (!(await markCorrectionApplied(client, { id: before.id, runId: null }))) throw new ApplyFailedError();
      return r;
    });
  } catch (err) {
    if (err instanceof ApplyFailedError || err instanceof AmendRefusedError) throw err;
    if (err instanceof ForbiddenError || err instanceof NotFoundError) throw mapDecideError(err);
    const mapped = mapDecideError(err);
    if (mapped !== err) throw mapped;
    // fx-swallow-ok: the step rolled back whole; the caller gets a fixed answer and the correction is still proposed
    throw new ApplyFailedError();
  }
  if (outcome !== 'decided') return { outcome: 'already_decided', correction: await getCorrection(ctx, before.id) };
  const done = announce as { actionId: string; kind: RunActionKind } | null;
  if (done && deps.signal) await announceNewRunAction({ signal: deps.signal }, { actionId: done.actionId, accountId, kind: done.kind });
  return { outcome: 'decided', correction: await getCorrection(ctx, before.id) };
}
