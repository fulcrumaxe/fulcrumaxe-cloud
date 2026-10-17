import type { Pool, PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { recordStage } from '../work-items/recordStage.js';
import { IllegalStageTransitionError, WorkItemHaltedError } from '../work-items/stages.js';
import {
  MAX_VERIFY_ATTEMPTS,
  buildEvidenceUrl,
  inboxSection,
  verificationsInSection,
  verifyRetry,
  type EvidenceKind,
  type InboxSection,
  type Verification,
} from './proposalVerification.js';

/**
 * D#483 S3-L2a: the proposal inbox reads and decisions.
 *
 * Every decision goes through the SECURITY DEFINER functions of 0723 and 0753 (reject_proposal, restore_proposal,
 * withdraw_approval; approve is in approve.ts), which check the caller (an owner or admin session, or a token with
 * work_items:write), the state and the owner of the item (E5) and lock the row themselves. This module maps their
 * refusals to stable codes and runs the extra write of a withdrawal (closing the work item) in the same transaction.
 *
 * Derived or stamped: a proposal's decision (approved, rejected, who, when, the note) is a stamp the definers write.
 * Everything else a row shows is read fresh: the task and milestone from the plan tables, and an approved row's work item
 * stage from the work item. Nothing here copies a stage onto the proposal.
 */
export interface ProposalCtx {
  pool: Pool;
  principal: { accountId: string; userId: string; tokenId?: string | undefined };
}

export type ProposalState = 'new' | 'approved' | 'rejected' | 'withdrawn';
export type ProposalOwner = 'product' | 'internal_loop';
/** D#483 S5-f: what a rejection remembers. A rejected row decided before 0844 has no kind (null) and behaves as `never`. */
export type RejectKind = 'not_now' | 'never';

export interface ProposalRow {
  id: string;
  repo_id: string;
  dedupe_key: string;
  sources: string[];
  gh_number: number | null;
  discussion_number: number | null;
  task_key: string | null;
  milestone_key: string | null;
  /** The milestone's title from the imported plan, or null when the proposal has no task (or the plan was removed). */
  milestone_title: string | null;
  title: string;
  summary: string | null;
  category_hint: string | null;
  estimate_usd: number | null;
  provenance: 'internal' | 'external';
  owner_process: ProposalOwner;
  state: ProposalState;
  /** When the decision was made. A resurfaced "Not now" keeps it, so the card can say "You said not now on <date>". */
  decided_at: string | null;
  reject_note: string | null;
  /** `not_now` or `never` while the proposal is rejected; null otherwise (and on a row rejected before 0844). */
  reject_kind: RejectKind | null;
  /** When a "Not now" may come back; set exactly when `reject_kind` is `not_now`. */
  resurface_after: string | null;
  /** When a "Not now" came back to the inbox (state is then `new`, or later `withdrawn` or `approved`); null if it never did. */
  resurfaced_at: string | null;
  roadmap_position: number | null;
  work_item_id: string | null;
  /** The work item's live stage (read from the work item, never copied), or null when there is no work item. */
  work_item_stage: string | null;
  created_at: string;
  updated_at: string;
  /** D#483 S4-i: what the verifier last saw. `pending` until the first check; `verified_at` and `verified_sha` are null until then. */
  verification: Verification;
  verified_at: string | null;
  verified_sha: string | null;
  verify_attempts: number;
  /** The retry cap (MAX_VERIFY_ATTEMPTS), so a reader never hard-codes 3. */
  verify_attempts_max: number;
  /** True only when the last check failed and another try is coming. */
  verify_retry: boolean;
  /** Derived on each read: null unless the proposal is `new` and product-owned. */
  inbox_section: InboxSection | null;
  claim_counts: ClaimCounts;
  evidence_count: number;
}

export interface ClaimCounts {
  supported: number;
  refuted: number;
  unverifiable: number;
  pending: number;
}

export type ClaimVerdict = keyof ClaimCounts;
export type RefuteCode = 'cite_not_found' | 'cite_mismatch' | 'contradicted';

export interface ProposalClaim {
  id: string;
  text: string;
  verdict: ClaimVerdict;
  refute_code: RefuteCode | null;
  checked_sha: string | null;
  checked_at: string | null;
}

export interface ProposalEvidence {
  id: string;
  kind: EvidenceKind;
  ref: string;
  excerpt: string;
  commit_sha: string | null;
  /** Built by the server from the repository row, the parsed ref and the commit; null when it cannot be built safely. */
  url: string | null;
  created_at: string;
}

/** The detail route's shape: the row plus the full claim and evidence lists. The list route carries counts only. */
export interface ProposalDetail extends ProposalRow {
  claims: ProposalClaim[];
  evidence: ProposalEvidence[];
}

/** A refusal the decision functions raise, carried as its stable code. The API answers it 409 (400 for `invalid_cursor`). */
export class ProposalRefusedError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ProposalRefusedError';
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The messages the definers raise with SQLSTATE 55000 (object_not_in_prerequisite_state). 0723 and 0753 define them. */
export const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'not_new',
  'not_rejected',
  'not_approved',
  'work_started',
  'owned_by_internal_loop',
  'repo_not_connected',
  'work_item_wrong_repo',
  'work_item_wrong_stage',
]);
/** The definer's 22023 for a "Not now" date that is not in the future or is more than 365 days out. */
export const INVALID_RESURFACE_DATE = 'invalid_resurface_date';
export const PROPOSAL_PAGE_SIZE = 50;
const CURSOR_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)\|([0-9a-f-]{36})$/i;

export const PROPOSAL_COLUMNS = `p.id, p.repo_id, p.dedupe_key, p.sources, p.gh_number, p.discussion_number,
  t.task_key, t.milestone_key, m.title AS milestone_title, p.title, p.summary, p.category_hint, p.estimate_usd::float8 AS estimate_usd, p.provenance,
  p.owner_process, p.state, p.decided_at, p.reject_note, p.reject_kind, p.resurface_after, p.resurfaced_at, p.roadmap_position, p.work_item_id, w.stage AS work_item_stage,
  p.created_at, p.updated_at, p.verification, p.verified_at, p.verified_sha, p.verify_attempts,
  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;
export const PROPOSAL_FROM = `FROM proposals p
  LEFT JOIN plan_tasks t ON t.id = p.plan_task_id AND t.account_id = p.account_id
  LEFT JOIN plan_milestones m ON m.repo_id = t.repo_id AND m.key = t.milestone_key
  LEFT JOIN work_items w ON w.id = p.work_item_id AND w.account_id = p.account_id`;

function iso(v: unknown): string | null {
  return v == null ? null : new Date(v as string).toISOString();
}

export function toProposalRow(r: Record<string, unknown>): ProposalRow {
  const { cursor_ts: _cursor, ...rest } = r;
  void _cursor;
  return {
    ...(rest as unknown as ProposalRow),
    decided_at: iso(r.decided_at),
    resurface_after: iso(r.resurface_after),
    resurfaced_at: iso(r.resurfaced_at),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    verified_at: iso(r.verified_at),
    verify_attempts_max: MAX_VERIFY_ATTEMPTS,
    verify_retry: verifyRetry(r as { verification: Verification; verify_attempts: number }),
    inbox_section: inboxSection(r as { state: string; owner_process: string; verification: Verification }),
    claim_counts: { supported: 0, refuted: 0, unverifiable: 0, pending: 0 },
    evidence_count: 0,
  };
}

/** Fills `claim_counts` and `evidence_count` for a page of rows with ONE grouped statement, whatever the page size. */
async function attachCounts(c: PoolClient, rows: ProposalRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { rows: counts } = await c.query<{ proposal_id: string; k: string; v: string; n: number }>(
    `SELECT proposal_id, 'claim' AS k, verdict AS v, count(*)::int AS n FROM proposal_claims WHERE proposal_id = ANY($1::uuid[]) GROUP BY proposal_id, verdict
     UNION ALL
     SELECT proposal_id, 'evidence' AS k, kind AS v, count(*)::int AS n FROM proposal_evidence WHERE proposal_id = ANY($1::uuid[]) GROUP BY proposal_id, kind`,
    [rows.map((r) => r.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const x of counts) {
    const row = byId.get(x.proposal_id);
    if (!row) continue;
    if (x.k === 'evidence') row.evidence_count += x.n;
    else if (x.v in row.claim_counts) row.claim_counts[x.v as ClaimVerdict] += x.n;
  }
}

export function proposalTenant<T>(ctx: ProposalCtx, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = ctx.principal;
  return withTenant(ctx.pool, p.accountId, p.userId, p.tokenId, fn);
}

/** Maps the definers' raised codes (SQLSTATE 55000 with the code as the message) to a refusal; "no such proposal" to not found. */
export function mapRefusal(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e?.code === '55000' && e.message && REFUSAL_CODES.has(e.message)) throw new ProposalRefusedError(e.message);
  if (e?.code === '22023' && e.message === INVALID_RESURFACE_DATE) throw new ProposalRefusedError(INVALID_RESURFACE_DATE);
  if (e?.code === 'P0002') throw new NotFoundError('proposal not found');
  throw err;
}

export async function readProposal(c: PoolClient, id: string): Promise<ProposalRow> {
  const { rows } = await c.query(`SELECT ${PROPOSAL_COLUMNS} ${PROPOSAL_FROM} WHERE p.id = $1::uuid`, [id]);
  if (!rows[0]) throw new NotFoundError('proposal not found');
  const row = toProposalRow(rows[0]);
  await attachCounts(c, [row]);
  return row;
}

export interface ListProposalsFilter {
  repoId?: string;
  state?: ProposalState;
  owner?: ProposalOwner;
  /** D#483 S4-i: an Inbox section. Only with `state: 'new'` (else `invalid_filter`); it also means product-owned. */
  section?: InboxSection;
  cursor?: string;
  limit?: number;
}

/**
 * A page of proposals, newest first, filtered by repo, state and owner. The cursor is the last row's `created_at|id`, the
 * timestamp to the microsecond (a millisecond cursor would skip rows created within the same millisecond).
 */
export async function listProposals(ctx: ProposalCtx, f: ListProposalsFilter): Promise<{ proposals: ProposalRow[]; next_cursor: string | null }> {
  if (f.repoId !== undefined && !UUID_RE.test(f.repoId)) throw new NotFoundError(`repos ${f.repoId} not found`);
  const limit = Math.min(Math.max(f.limit ?? PROPOSAL_PAGE_SIZE, 1), PROPOSAL_PAGE_SIZE);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.repoId) {
    args.push(f.repoId);
    where.push(`p.repo_id = $${args.length}::uuid`);
  }
  if (f.state) {
    args.push(f.state);
    where.push(`p.state = $${args.length}`);
  }
  if (f.owner) {
    args.push(f.owner);
    where.push(`p.owner_process = $${args.length}`);
  }
  if (f.section !== undefined) {
    if (f.state !== 'new') throw new ProposalRefusedError('invalid_filter');
    const members = verificationsInSection(f.section);
    if (members.length === 0) throw new ProposalRefusedError('invalid_filter');
    args.push(members);
    where.push(`p.owner_process = 'product' AND p.verification = ANY($${args.length}::text[])`);
  }
  if (f.cursor !== undefined) {
    const m = CURSOR_RE.exec(f.cursor);
    if (!m || !UUID_RE.test(m[2]!) || Number.isNaN(Date.parse(m[1]!))) throw new ProposalRefusedError('invalid_cursor');
    args.push(m[1], m[2]);
    where.push(`(p.created_at, p.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
  }
  args.push(limit + 1);
  const sql = `SELECT ${PROPOSAL_COLUMNS} ${PROPOSAL_FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_at DESC, p.id DESC LIMIT $${args.length}`;
  return proposalTenant(ctx, async (c) => {
    if (f.repoId) {
      const repo = await c.query('SELECT 1 FROM repos WHERE id = $1::uuid', [f.repoId]);
      if (repo.rowCount === 0) throw new NotFoundError(`repos ${f.repoId} not found`);
    }
    const { rows } = await c.query(sql, args);
    const page = rows.slice(0, limit);
    const out = page.map(toProposalRow);
    await attachCounts(c, out);
    const last = page[page.length - 1] as { cursor_ts: string; id: string } | undefined;
    return { proposals: out, next_cursor: rows.length > limit && last ? `${last.cursor_ts}|${last.id}` : null };
  });
}

const CLAIM_ORDER = `CASE verdict WHEN 'refuted' THEN 0 WHEN 'unverifiable' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END`;

/**
 * The proposal with its claims and evidence (D#483 S4-i). Both lists are read in the same tenant transaction as the row, as
 * app_user under the tables' own RLS, so another account's id is a 404 and an inactive account reads empty lists. Excerpts and
 * claim text are returned exactly as stored. The links are built here from the repository row (see buildEvidenceUrl).
 */
export async function getProposal(ctx: ProposalCtx, id: string): Promise<ProposalDetail> {
  if (!UUID_RE.test(id)) throw new NotFoundError('proposal not found');
  return proposalTenant(ctx, async (c) => {
    const row = await readProposal(c, id);
    const claims = await c.query(
      `SELECT id, text, verdict, refute_code, checked_sha, checked_at FROM proposal_claims WHERE proposal_id = $1::uuid
       ORDER BY ${CLAIM_ORDER}, text COLLATE "C", id`,
      [id],
    );
    const evidence = await c.query(
      `SELECT id, kind, ref, excerpt, commit_sha, created_at FROM proposal_evidence WHERE proposal_id = $1::uuid ORDER BY created_at, id`,
      [id],
    );
    const repo = await c.query<{ gh_owner: string | null; gh_name: string | null }>('SELECT gh_owner, gh_name FROM repos WHERE id = $1::uuid', [row.repo_id]);
    const owner = { owner: repo.rows[0]?.gh_owner ?? null, name: repo.rows[0]?.gh_name ?? null };
    return {
      ...row,
      claims: claims.rows.map((r) => ({ ...(r as ProposalClaim), checked_at: iso(r.checked_at) })),
      evidence: evidence.rows.map((r) => ({
        ...(r as Omit<ProposalEvidence, 'url' | 'created_at'> & { created_at: unknown }),
        url: buildEvidenceUrl({ kind: r.kind as EvidenceKind, ref: r.ref as string, commit_sha: r.commit_sha as string | null }, owner),
        created_at: iso(r.created_at)!,
      })),
    };
  });
}

export interface RejectInput {
  /** Up to 500 characters. */
  note?: string | null;
  /** "Not now" comes back after `resurfaceAfter`; "Never" stays rejected and keeps absorbing duplicates of the same idea. */
  kind: RejectKind;
  /** Only with `not_now`: a future date at most 365 days away. Omitted, it is 30 days from now. */
  resurfaceAfter?: Date | null;
}

/** `new` to `rejected` with a kind (D#483 S5-f), an optional note of up to 500 characters and, for "Not now", the date it may come back. */
export async function rejectProposal(ctx: ProposalCtx, id: string, input: RejectInput): Promise<ProposalRow> {
  if (!UUID_RE.test(id)) throw new NotFoundError('proposal not found');
  const date = input.kind === 'not_now' && input.resurfaceAfter ? input.resurfaceAfter.toISOString() : null;
  return proposalTenant(ctx, async (c) => {
    await c.query('SELECT * FROM reject_proposal($1::uuid, $2, $3, $4::timestamptz)', [id, input.note ?? null, input.kind, date]).catch(mapRefusal);
    return readProposal(c, id);
  });
}

/** `rejected` to `new` ("Move back to inbox", either kind): the decision stamp, the note, the kind and the date are cleared. */
export async function restoreProposal(ctx: ProposalCtx, id: string): Promise<ProposalRow> {
  if (!UUID_RE.test(id)) throw new NotFoundError('proposal not found');
  return proposalTenant(ctx, async (c) => {
    await c.query('SELECT * FROM restore_proposal($1::uuid)', [id]).catch(mapRefusal);
    return readProposal(c, id);
  });
}

/**
 * `approved` to `new`, only while the work item is at triaged and has no run. The definer checks that and clears the
 * approval; the work item then moves triaged to closed (a legal edge) through the one stage writer, in the SAME transaction.
 * If the item moved on between the definer's read and the stage write, nothing is written and the answer is `work_started`.
 */
export async function withdrawApproval(ctx: ProposalCtx, id: string): Promise<ProposalRow> {
  if (!UUID_RE.test(id)) throw new NotFoundError('proposal not found');
  return proposalTenant(ctx, async (c) => {
    const { rows } = await c.query<{ work_item_id: string | null }>('SELECT * FROM withdraw_approval($1::uuid)', [id]).catch(mapRefusal);
    const workItemId = rows[0]?.work_item_id ?? null;
    if (workItemId) {
      try {
        await recordStage(c, { workItemId, toStage: 'closed', at: new Date(), source: 'control_plane', sourceRef: `withdraw:${id}`, actor: 'person' });
      } catch (err) {
        // A person's move is never refused for a halt (actor 'person'); if it ever is, the item is not idle, so the answer is the same.
        if (err instanceof IllegalStageTransitionError || err instanceof WorkItemHaltedError) throw new ProposalRefusedError('work_started');
        throw err;
      }
    }
    return readProposal(c, id);
  });
}
