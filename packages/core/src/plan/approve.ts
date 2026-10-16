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
 *   3. after the commit, file the stage driver's `advance_work_item` for the new work item, but only when the proposal is
 *      issue-backed, the repo has an active write-App (`team`) install, and the proposal is product-owned. Otherwise the
 *      work item waits at Triaged and the answer says why (`not_issue_backed`, `no_write_install`).
 *
 * The start is separate from the approval on purpose: the run-action request has its own transaction and signal. If it
 * fails, the approval stands and the work item waits at Triaged; approving the same proposal again (a repeat) finds it
 * approved, still at triaged with no run, and files the start again. A start is never filed twice: the request is deduped
 * by the run-action definer (one live request per kind and target, and the idempotency key).
 */
export type NotStartedReason = 'no_write_install' | 'not_issue_backed' | 'owned_by_internal_loop';

export interface ApproveResult {
  proposal: ProposalRow;
  work_item_id: string;
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
  work_item_id: string | null;
}

/** Why a start would not be filed, or null when it would. The three conditions of Spec section 1, in the order it lists them. */
async function notStartedReason(c: PoolClient, p: ProposalFacts): Promise<NotStartedReason | null> {
  if (p.owner_process !== 'product') return 'owned_by_internal_loop';
  if (p.gh_number == null) return 'not_issue_backed';
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

export async function approveProposal(ctx: ProposalCtx, id: string, requestStart: RequestStart | null): Promise<ApproveResult> {
  if (!UUID_RE.test(id)) throw new NotFoundError('proposal not found');
  const done = await proposalTenant(ctx, async (c) => {
    const { rows } = await c.query<ProposalFacts>(
      'SELECT repo_id, owner_process, state, gh_number, title, work_item_id FROM proposals WHERE id = $1::uuid',
      [id],
    );
    const p = rows[0];
    if (!p) throw new NotFoundError('proposal not found');
    // E5/E7: refused before any write. The definer refuses it again, and the data (a CHECK) a third time.
    if (p.owner_process !== 'product') throw new ProposalRefusedError('owned_by_internal_loop');

    if (p.state === 'approved' && p.work_item_id) {
      // A repeat. Nothing is created; the start is filed again only when it was never made (still triaged, no run).
      const reason = await notStartedReason(c, p);
      const { rows: w } = await c.query<{ stage: string; has_run: boolean }>(
        `SELECT w.stage, EXISTS (SELECT 1 FROM agent_runs r WHERE r.account_id = w.account_id AND r.work_item_id = w.id) AS has_run
           FROM work_items w WHERE w.id = $1::uuid`,
        [p.work_item_id],
      );
      const idle = w[0]?.stage === 'triaged' && w[0].has_run === false;
      if (reason === null && idle && !requestStart) throw new StartUnavailableError();
      return { proposal: await readProposal(c, id), workItemId: p.work_item_id, start: reason === null && idle, reason: reason === null ? null : reason };
    }
    if (p.state !== 'new') throw new ProposalRefusedError('not_new');

    const reason = await notStartedReason(c, p);
    // A start that cannot be filed refuses BEFORE the write, as the work item's own approve does.
    if (reason === null && !requestStart) throw new StartUnavailableError();
    const workItemId = await workItemFor(c, p);
    await c.query('SELECT * FROM approve_proposal($1::uuid, $2::uuid)', [id, workItemId]).catch(mapRefusal);
    return { proposal: await readProposal(c, id), workItemId, start: reason === null, reason };
  });

  if (done.start) await requestStart!(done.workItemId);
  return {
    proposal: done.proposal,
    work_item_id: done.workItemId,
    started: done.start,
    not_started_reason: done.start ? null : done.reason,
  };
}
