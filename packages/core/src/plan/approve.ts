import type { PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { cleanWorkItemTitle } from '../work-items/title.js';
import { mapRefusal, ProposalRefusedError, readProposal, proposalTenant, UUID_RE, type ProposalCtx, type ProposalRow } from './proposals.js';

/**
 * D#483 S3-L2a: one-click approve (S3 Spec section 1).
 *
 * One click does, in this order:
 *   1. read the proposal (no row lock: app_user holds SELECT only, so the lock is the definer's) and refuse an
 *      internal-loop proposal before anything is written (E5);
 *   2. in ONE transaction: create the work item exactly as the issue webhook creates one (internal, at triaged, with the
 *      repo and, when issue-backed, the issue number) and call approve_proposal, which takes the next roadmap position;
 *      a refusal anywhere rolls the work item back, so a refused approve leaves nothing behind;
 *   3. after the commit, file the stage driver's `advance_work_item` for the new work item, when the repo has an active
 *      write-App (`team`) install and the proposal is product-owned. Every kind of proposal starts (D#483 S4-e): an
 *      issue-backed one is read from its issue, any other from the proposal's own title and summary. Otherwise the work
 *      item waits at Triaged and the answer says why (`no_write_install`).
 *
 * The start is separate from the approval on purpose: the run-action request has its own transaction and signal. If it
 * fails, the approval stands and the work item waits at Triaged; approving the same proposal again (a repeat) finds it
 * approved, still at triaged with no run, and files the start again. A start is never filed twice: the request is deduped
 * by the run-action definer (one live request per kind and target, and the idempotency key).
 *
 * D#483 S5-e1: the click also gives the item its spend envelope, in the same transaction. This package cannot price an estimate
 * (that is the pipeline's, and the pipeline depends on this package), so the caller passes a `PlanEnvelope`: it runs inside the
 * transaction before anything is approved, may refuse (nothing is written then), and returns the function that attaches the
 * envelope it wrote to each new work item. A repeat of an approved proposal creates no second envelope.
 */
export type NotStartedReason = 'no_write_install' | 'owned_by_internal_loop';

/** The current version of an envelope, as the approve routes show it. */
export interface EnvelopeAttachment {
  envelope_id: string;
  scope: 'item' | 'batch';
  version: number;
  amount_usd: number;
  estimate_usd: number | null;
  margin_pct: number | null;
}

/** What a planner may price from: the proposal facts that decide its category and prompt. */
export interface ProposalToApprove {
  id: string;
  repo_id: string;
  title: string;
  summary: string | null;
  category_hint: string | null;
}

/** Attaches the envelope the planner wrote to a work item (through the definer), and says what it attached. */
export type AttachEnvelope = (c: PoolClient, workItemId: string) => Promise<EnvelopeAttachment>;
/** Runs in the approval's transaction, before any proposal is approved, for the proposals that are about to be approved. A throw writes nothing. */
export type PlanEnvelope = (c: PoolClient, proposals: ProposalToApprove[]) => Promise<AttachEnvelope>;

export interface ApproveResult {
  proposal: ProposalRow;
  work_item_id: string;
  /** The item's envelope (written by this call, or the one a repeat finds); null for an item approved before envelopes existed. */
  envelope: EnvelopeAttachment | null;
  /** True when THIS call filed the start. A repeat of an approved proposal answers false unless it filed the start it found missing. */
  started: boolean;
  not_started_reason: NotStartedReason | null;
}

/** The caller's way to file `advance_work_item` for a work item (the run-action request plus its signal). */
export type RequestStart = (workItemId: string) => Promise<void>;

/** The approval would start work but the start cannot be filed here (no run-action signal registered). Nothing was written. */
export class StartUnavailableError extends Error {
  constructor() {
    super('start unavailable');
    this.name = 'StartUnavailableError';
  }
}

interface ProposalFacts {
  repo_id: string;
  owner_process: string;
  state: string;
  gh_number: number | null;
  title: string;
  summary: string | null;
  category_hint: string | null;
  work_item_id: string | null;
}

const FACTS_SQL = 'SELECT repo_id, owner_process, state, gh_number, title, summary, category_hint, work_item_id FROM proposals WHERE id = $1::uuid';

/** The current version of the envelope an item draws on, or null when it draws on none. */
export async function readItemEnvelope(c: PoolClient, workItemId: string): Promise<EnvelopeAttachment | null> {
  const { rows } = await c.query<EnvelopeAttachment>(
    `SELECT e.id AS envelope_id, e.scope, e.version, e.amount_usd::float8 AS amount_usd, e.estimate_usd::float8 AS estimate_usd, e.margin_pct::float8 AS margin_pct
       FROM work_items w JOIN approval_envelopes e ON e.account_id = w.account_id AND e.id = w.envelope_id
      WHERE w.id = $1::uuid AND e.scope IN ('item', 'batch') ORDER BY e.version DESC LIMIT 1`,
    [workItemId],
  );
  return rows[0] ?? null;
}

/** Why a start would not be filed, or null when it would. The conditions of Spec section 1 that remain after S4-e. */
async function notStartedReason(c: PoolClient, p: ProposalFacts): Promise<NotStartedReason | null> {
  if (p.owner_process !== 'product') return 'owned_by_internal_loop';
  const { rows } = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM repos r JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
                     WHERE r.id = $1::uuid AND i.app_kind = 'team') AS ok`,
    [p.repo_id],
  );
  return rows[0]?.ok ? null : 'no_write_install';
}

/**
 * The work item for a new approval. An issue that already has an OPEN work item in this repo (the webhook made one between
 * the import and the click) is reused rather than doubled, as the webhook path itself reuses it; otherwise a new one is made.
 */
async function workItemFor(c: PoolClient, p: ProposalFacts): Promise<string> {
  if (p.gh_number != null) {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM work_items WHERE repo_id = $1::uuid AND gh_number = $2 AND stage <> 'closed' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [p.repo_id, p.gh_number],
    );
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance, title)
     VALUES (current_setting('app.account_id')::uuid, $1::uuid, 'issue', $2, 'internal', $3) RETURNING id`,
    [p.repo_id, p.gh_number, cleanWorkItemTitle(p.title)],
  );
  return rows[0]!.id;
}

export async function approveProposal(ctx: ProposalCtx, id: string, requestStart: RequestStart | null, planEnvelope: PlanEnvelope | null = null): Promise<ApproveResult> {
  if (!UUID_RE.test(id)) throw new NotFoundError('proposal not found');
  const done = await proposalTenant(ctx, async (c) => {
    const { rows } = await c.query<ProposalFacts>(FACTS_SQL, [id]);
    const p = rows[0];
    if (!p) throw new NotFoundError('proposal not found');
    // E5/E7: refused before any write. The definer refuses it again, and the data (a CHECK) a third time.
    if (p.owner_process !== 'product') throw new ProposalRefusedError('owned_by_internal_loop');

    if (p.state === 'approved' && p.work_item_id) {
      // A repeat. Nothing is created (no second work item, no second envelope); the start is filed again only when it was never made (still triaged, no run).
      const reason = await notStartedReason(c, p);
      const { rows: w } = await c.query<{ stage: string; has_run: boolean }>(
        `SELECT w.stage, EXISTS (SELECT 1 FROM agent_runs r WHERE r.account_id = w.account_id AND r.work_item_id = w.id) AS has_run
           FROM work_items w WHERE w.id = $1::uuid`,
        [p.work_item_id],
      );
      const idle = w[0]?.stage === 'triaged' && w[0].has_run === false;
      if (reason === null && idle && !requestStart) throw new StartUnavailableError();
      return { proposal: await readProposal(c, id), workItemId: p.work_item_id, envelope: await readItemEnvelope(c, p.work_item_id), start: reason === null && idle, reason: reason === null ? null : reason };
    }
    if (p.state !== 'new') throw new ProposalRefusedError('not_new');

    const reason = await notStartedReason(c, p);
    // A start that cannot be filed refuses BEFORE the write, as the work item's own approve does.
    if (reason === null && !requestStart) throw new StartUnavailableError();
    // The planner runs before any write: a refusal (no estimate and no amount, a limit below the first run, over the account's budget) leaves nothing behind.
    const attach = planEnvelope ? await planEnvelope(c, [{ id, repo_id: p.repo_id, title: p.title, summary: p.summary, category_hint: p.category_hint }]) : null;
    const approved = await approveFresh(c, id, p, attach);
    return { ...approved, start: reason === null, reason };
  });

  if (done.start) await requestStart!(done.workItemId);
  return {
    proposal: done.proposal,
    work_item_id: done.workItemId,
    envelope: done.envelope,
    started: done.start,
    not_started_reason: done.start ? null : done.reason,
  };
}

/** Creates (or reuses) the work item, approves, and attaches the envelope: one proposal of a fresh approval. */
async function approveFresh(c: PoolClient, id: string, p: ProposalFacts, attach: AttachEnvelope | null): Promise<{ proposal: ProposalRow; workItemId: string; envelope: EnvelopeAttachment | null }> {
  const workItemId = await workItemFor(c, p);
  await c.query('SELECT * FROM approve_proposal($1::uuid, $2::uuid)', [id, workItemId]).catch(mapRefusal);
  const envelope = attach ? await attach(c, workItemId).catch(mapEnvelopeRefusal) : null;
  return { proposal: await readProposal(c, id), workItemId, envelope };
}

/** The envelope setter's refusals are the same kind of answer as the approve definer's: a 409 carrying the code. */
function mapEnvelopeRefusal(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (err instanceof Error && err.name === 'SetEnvelopeError' && typeof code === 'string') throw new ProposalRefusedError(code);
  throw err;
}

export interface ApproveBatchResult {
  items: Array<{ proposal: ProposalRow; work_item_id: string; envelope: EnvelopeAttachment | null; started: boolean; not_started_reason: NotStartedReason | null }>;
}

/**
 * D#483 S5-e1: approves a set of NEW proposals of one repository in ONE transaction, under whatever envelope the planner wrote for the set. All or nothing:
 * one proposal that is not new (or belongs to the internal loop, or to another repository) refuses the whole set and nothing is written. The starts are
 * filed after the commit, one per work item, exactly as a single approve files its own.
 */
export async function approveProposalBatch(ctx: ProposalCtx, repoId: string, ids: string[], requestStart: RequestStart | null, planEnvelope: PlanEnvelope): Promise<ApproveBatchResult> {
  if (!UUID_RE.test(repoId) || ids.length === 0 || new Set(ids).size !== ids.length || !ids.every((i) => UUID_RE.test(i))) throw new NotFoundError('proposal not found');
  const done = await proposalTenant(ctx, async (c) => {
    const facts: Array<ProposalFacts & { id: string }> = [];
    for (const id of ids) {
      const { rows } = await c.query<ProposalFacts>(FACTS_SQL, [id]);
      const p = rows[0];
      if (!p || p.repo_id !== repoId) throw new NotFoundError('proposal not found');
      if (p.owner_process !== 'product') throw new ProposalRefusedError('owned_by_internal_loop');
      if (p.state !== 'new') throw new ProposalRefusedError('not_new');
      facts.push({ ...p, id });
    }
    const reasons = new Map<string, NotStartedReason | null>();
    for (const p of facts) {
      const reason = await notStartedReason(c, p);
      if (reason === null && !requestStart) throw new StartUnavailableError();
      reasons.set(p.id, reason);
    }
    const attach = await planEnvelope(c, facts.map((p) => ({ id: p.id, repo_id: p.repo_id, title: p.title, summary: p.summary, category_hint: p.category_hint })));
    const out: Array<{ proposal: ProposalRow; workItemId: string; envelope: EnvelopeAttachment | null; reason: NotStartedReason | null }> = [];
    for (const p of facts) out.push({ ...(await approveFresh(c, p.id, p, attach)), reason: reasons.get(p.id) ?? null });
    return out;
  });

  const items: ApproveBatchResult['items'] = [];
  for (const d of done) {
    const start = d.reason === null;
    if (start) await requestStart!(d.workItemId);
    items.push({ proposal: d.proposal, work_item_id: d.workItemId, envelope: d.envelope, started: start, not_started_reason: start ? null : d.reason });
  }
  return { items };
}
