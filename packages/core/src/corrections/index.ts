import type { Pool, PoolClient } from 'pg';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { ForbiddenError, NotFoundError } from '../tenancy/errors.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';

/** D#597 CC-1: what a person (or an agent's proposal) says about a work item in flight. Values mirror the CHECKs of migration 0780. */
export const CORRECTION_ORIGINS = ['person', 'agent'] as const;
export const CORRECTION_KINDS = ['question', 'run_note', 'spec_amend', 'new_item', 'pause', 'priority'] as const;
export const CORRECTION_STATUSES = ['proposed', 'accepted', 'rejected', 'applied', 'superseded'] as const;
export const CORRECTION_DECIDED_VIA = ['workspace', 'terminal', 'auto'] as const;
/** Characters (code points), the same unit the database CHECK counts. */
export const CORRECTION_BODY_MAX = 4000;

export type CorrectionOrigin = (typeof CORRECTION_ORIGINS)[number];
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];
export type CorrectionDecidedVia = (typeof CORRECTION_DECIDED_VIA)[number];
/** What a person's click can set. `applied` is stamped by delivery, never by a click. */
export type CorrectionDecision = 'accepted' | 'rejected' | 'superseded';
/** Where the click happened. 'auto' (a per-kind toggle) exists in the data model but is not open. */
export type CorrectionVia = 'workspace' | 'terminal';

export interface Correction {
  id: string;
  accountId: string;
  workItemId: string;
  origin: CorrectionOrigin;
  kind: CorrectionKind;
  body: string;
  status: CorrectionStatus;
  /** Null once the user is deleted. Render as "a former member", never as null. */
  createdBy: string | null;
  decidedBy: string | null;
  decidedVia: CorrectionDecidedVia | null;
  contentHash: string;
  appliedRunId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  appliedAt: Date | null;
  updatedAt: Date;
}

/** Maps to 422. */
export class CorrectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionInputError';
  }
}

export interface CorrectionCtx {
  pool: Pool;
  principal: { accountId: string; userId: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = `id, account_id, work_item_id, origin, kind, body, status, created_by, decided_by, decided_via, content_hash,
  applied_run_id, created_at, decided_at, applied_at, updated_at`;

interface Row {
  id: string;
  account_id: string;
  work_item_id: string;
  origin: CorrectionOrigin;
  kind: CorrectionKind;
  body: string;
  status: CorrectionStatus;
  created_by: string | null;
  decided_by: string | null;
  decided_via: CorrectionDecidedVia | null;
  content_hash: string;
  applied_run_id: string | null;
  created_at: Date;
  decided_at: Date | null;
  applied_at: Date | null;
  updated_at: Date;
}

function toCorrection(r: Row): Correction {
  return {
    id: r.id,
    accountId: r.account_id,
    workItemId: r.work_item_id,
    origin: r.origin,
    kind: r.kind,
    body: r.body,
    status: r.status,
    createdBy: r.created_by,
    decidedBy: r.decided_by,
    decidedVia: r.decided_via,
    contentHash: r.content_hash,
    appliedRunId: r.applied_run_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    appliedAt: r.applied_at,
    updatedAt: r.updated_at,
  };
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** The SQLSTATEs the three database functions raise, mapped to the errors a route already knows how to answer. */
function mapDbError(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === '42501') return new ForbiddenError('not allowed to do that to a correction');
  if (code === 'P0002' || code === '23503') return new NotFoundError('correction or work item not found');
  return err;
}

export interface CreateCorrectionInput {
  workItemId: string;
  kind: CorrectionKind;
  body: string;
  /** Defaults to 'person'. An agent's proposal is still only `proposed`; a person decides it. */
  origin?: CorrectionOrigin;
}

/**
 * Records a correction as `proposed`. Any active member may; deciding is a separate, owner-or-admin step. The text is kept as sent
 * (it is hashed, and a delivery step sanitises it where it is used), but it must be present and at most CORRECTION_BODY_MAX
 * characters. The audit row is written by the database function in the same transaction.
 */
export async function createCorrection(ctx: CorrectionCtx, input: CreateCorrectionInput): Promise<Correction> {
  const { accountId, userId } = ctx.principal;
  const origin = input.origin ?? 'person';
  if (!isOneOf(CORRECTION_KINDS, input.kind)) throw new CorrectionInputError('unknown correction kind');
  if (!isOneOf(CORRECTION_ORIGINS, origin)) throw new CorrectionInputError('unknown correction origin');
  if (typeof input.body !== 'string' || input.body.trim() === '') throw new CorrectionInputError('a correction needs some text');
  if (Array.from(input.body).length > CORRECTION_BODY_MAX) {
    throw new CorrectionInputError(`a correction is at most ${CORRECTION_BODY_MAX} characters`);
  }
  if (!UUID_RE.test(input.workItemId)) throw new NotFoundError(`work item ${input.workItemId} not found`);

  return withTenant(ctx.pool, accountId, userId, async (client: PoolClient) => {
    await assertActiveMembership(client, accountId, userId);
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT work_item_correction_create($1::uuid, $2::text, $3::text, $4::text) AS id',
        [input.workItemId, origin, input.kind, input.body],
      );
      const created = await client.query<Row>(`SELECT ${COLUMNS} FROM work_item_corrections WHERE id = $1::uuid`, [rows[0]!.id]);
      return toCorrection(created.rows[0]!);
    } catch (err) {
      throw mapDbError(err);
    }
  });
}

/** One correction by id, or NotFoundError (also for another account's id: RLS makes the two the same). */
export async function getCorrection(ctx: CorrectionCtx, id: string): Promise<Correction> {
  const { accountId, userId } = ctx.principal;
  if (!UUID_RE.test(id)) throw new NotFoundError(`correction ${id} not found`);
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM work_item_corrections WHERE id = $1::uuid`, [id]);
    if (rows[0] === undefined) throw new NotFoundError(`correction ${id} not found`);
    return toCorrection(rows[0]);
  });
}

/** A work item's corrections, oldest first (the history order). */
export async function listCorrections(ctx: CorrectionCtx, workItemId: string): Promise<Correction[]> {
  const { accountId, userId } = ctx.principal;
  if (!UUID_RE.test(workItemId)) throw new NotFoundError(`work item ${workItemId} not found`);
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<Row>(
      `SELECT ${COLUMNS} FROM work_item_corrections WHERE work_item_id = $1::uuid ORDER BY created_at, id`,
      [workItemId],
    );
    return rows.map(toCorrection);
  });
}

export type DecideCorrectionResult =
  | { outcome: 'decided'; correction: Correction }
  /** The correction had already left the state this step needs (accepted twice, rejected after applied, ...). Nothing changed. */
  | { outcome: 'already_decided'; correction: Correction };

/**
 * Accepts, rejects or supersedes a correction. Owner or admin only (checked here, and again by the database function as a floor).
 * Rejecting stays possible while a correction is `accepted` and not yet `applied`; once applied it is final. A second accept
 * changes 0 rows, writes no audit row and answers `already_decided`.
 */
export async function decideCorrection(
  ctx: CorrectionCtx,
  input: { id: string; to: CorrectionDecision; via: CorrectionVia },
): Promise<DecideCorrectionResult> {
  const { accountId, userId } = ctx.principal;
  if (!isOneOf(['accepted', 'rejected', 'superseded'] as const, input.to)) throw new CorrectionInputError('unknown decision');
  if (!isOneOf(['workspace', 'terminal'] as const, input.via)) throw new CorrectionInputError('decided_via must be workspace or terminal');
  if (!UUID_RE.test(input.id)) throw new NotFoundError(`correction ${input.id} not found`);

  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows: memberRows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, userId],
    );
    requireOwnerOrAdmin(memberRows[0]?.role ?? null);
    let outcome: string;
    try {
      const { rows } = await client.query<{ r: string }>('SELECT work_item_correction_decide($1::uuid, $2::text, $3::text) AS r', [
        input.id,
        input.to,
        input.via,
      ]);
      outcome = rows[0]!.r;
    } catch (err) {
      throw mapDbError(err);
    }
    const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM work_item_corrections WHERE id = $1::uuid`, [input.id]);
    const correction = toCorrection(rows[0]!);
    return outcome === 'decided' ? { outcome: 'decided', correction } : { outcome: 'already_decided', correction };
  });
}

/**
 * Stamps an accepted correction `applied`. Runs on the caller's own tenant transaction (the driver's, which has no user), so the
 * stamp commits or rolls back with the step that used the correction. A run note must name a run of the same item; any other
 * kind names none. Returns false, changing nothing, when the correction is not `accepted` (already applied, rejected, ...).
 */
export async function markCorrectionApplied(client: PoolClient, input: { id: string; runId: string | null }): Promise<boolean> {
  if (!UUID_RE.test(input.id)) throw new NotFoundError(`correction ${input.id} not found`);
  if (input.runId !== null && !UUID_RE.test(input.runId)) throw new CorrectionInputError('runId must be a UUID');
  try {
    const { rows } = await client.query<{ r: string }>('SELECT work_item_correction_mark_applied($1::uuid, $2::uuid) AS r', [
      input.id,
      input.runId,
    ]);
    return rows[0]!.r === 'applied';
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '22023') throw new CorrectionInputError('that correction cannot be applied by that run');
    throw mapDbError(err);
  }
}
