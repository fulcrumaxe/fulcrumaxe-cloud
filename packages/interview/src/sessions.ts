import type { PoolClient } from 'pg';
import { withTenant } from '@fx/db/src/withTenant.js';
import { ForbiddenError } from '@fx/core/src/tenancy/errors.js';
import { MAX_ANSWER_BYTES, boundsFor, type SessionBounds } from './limits.js';
import {
  InterviewLimitError,
  InterviewValidationError,
  NotFoundError,
  SessionNotActiveError,
  StaleRevError,
  type AnswerDoc,
  type AnswerEntry,
  type AnswerSource,
  type InterviewCtx,
  type InterviewSession,
  type LimitBound,
  type ManifestView,
} from './types.js';

const COLS = `id, account_id, created_by, status, manifest_id, manifest_version, repo_id, answers, followups, rev, spent_usd, turn_count,
  project_discussion_id, started_at, finished_at, updated_at`;

interface Row {
  id: string;
  account_id: string;
  created_by: string;
  status: InterviewSession['status'];
  manifest_id: string;
  manifest_version: string;
  repo_id: string | null;
  answers: AnswerDoc;
  followups: Record<string, unknown>;
  rev: number;
  spent_usd: string;
  turn_count: number;
  project_discussion_id: string | null;
  started_at: Date;
  finished_at: Date | null;
  updated_at: Date;
}

function toSession(r: Row): InterviewSession {
  return {
    id: r.id,
    accountId: r.account_id,
    createdBy: r.created_by,
    status: r.status,
    manifestId: r.manifest_id,
    manifestVersion: r.manifest_version,
    repoId: r.repo_id,
    answers: r.answers,
    followups: r.followups,
    rev: r.rev,
    spentUsd: Number(r.spent_usd),
    turnCount: r.turn_count,
    projectDiscussionId: r.project_discussion_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;

/** Every read names the account itself, on top of row security. */
async function load(client: PoolClient, ctx: InterviewCtx, id: string, mineOnly: boolean): Promise<InterviewSession | null> {
  const { accountId, userId } = ctx.principal;
  const { rows } = await client.query<Row>(
    `SELECT ${COLS} FROM interview_sessions WHERE id = $1 AND account_id = $2 AND ($3::boolean IS FALSE OR created_by = $4)`,
    [id, accountId, mineOnly, userId],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

/** Starts an interview. The pinned manifest must exist; the bounds are applied inside the database under an account lock. */
export async function startSession(ctx: InterviewCtx, input: { manifestId: string; manifestVersion: string; repoId?: string | null }): Promise<InterviewSession> {
  if (!ctx.manifests(input.manifestId, input.manifestVersion)) throw new InterviewValidationError('unknown_manifest');
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    let id: string;
    try {
      const { rows } = await client.query<{ id: string }>('SELECT interview_session_start($1, $2, $3) AS id', [input.manifestId, input.manifestVersion, input.repoId ?? null]);
      id = rows[0]!.id;
    } catch (e) {
      if (pgCode(e) === 'IV429') throw new InterviewLimitError((e as { detail: string }).detail as LimitBound);
      if (pgCode(e) === '23503') throw new NotFoundError('interview: no such repo');
      if (pgCode(e) === '42501') throw new ForbiddenError('interview: not a member of this account');
      throw e;
    }
    return (await load(client, ctx, id, true))!;
  });
}

/** A session the caller can see (their own, or any of the account's for an owner or admin). Anyone else gets NotFoundError, never a refusal. */
export async function getSession(ctx: InterviewCtx, id: string): Promise<InterviewSession> {
  const s = await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, (client) => load(client, ctx, id, false));
  if (!s) throw new NotFoundError(`interview_sessions: no session ${id}`);
  return s;
}

/** The caller's own sessions, newest first. `visible` adds, for an owner or admin, the account's other sessions. */
export async function listSessions(ctx: InterviewCtx, opts: { scope?: 'mine' | 'visible'; liveOnly?: boolean } = {}): Promise<InterviewSession[]> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT ${COLS} FROM interview_sessions
        WHERE account_id = $1 AND ($2::boolean OR created_by = $3) AND (NOT $4::boolean OR status IN ('active', 'capped'))
        ORDER BY started_at DESC, id`,
      [accountId, opts.scope === 'visible', userId, opts.liveOnly === true],
    );
    return rows.map(toSession);
  });
}

type Op = { kind: 'answer' | 'edit'; text: string; source?: AnswerSource } | { kind: 'skip' | 'not_sure' | 'clear' };

function checkText(text: string, maxBytes: number): void {
  if (text.trim() === '') throw new InterviewValidationError('empty_answer');
  if (text.includes('\u0000')) throw new InterviewValidationError('invalid_text');
  if (Buffer.byteLength(text, 'utf8') > Math.min(MAX_ANSWER_BYTES, maxBytes)) throw new InterviewValidationError('answer_too_large');
}

function apply(doc: AnswerDoc, manifest: ManifestView, sectionId: string, questionId: string, op: Op): AnswerDoc {
  const question = manifest.sections.find((s) => s.id === sectionId)?.questions.find((q) => q.id === questionId);
  if (!question) throw new InterviewValidationError('unknown_question');
  const current = doc[sectionId]?.[questionId];
  const at = new Date().toISOString();
  let next: AnswerEntry | null;
  switch (op.kind) {
    case 'answer':
    case 'edit':
      if (op.kind === 'answer' && current?.status === 'answered') throw new InterviewValidationError('already_answered');
      if (op.kind === 'edit' && current?.status !== 'answered') throw new InterviewValidationError('not_answered');
      checkText(op.text, question.max_bytes);
      next = { status: 'answered', text: op.text, source: op.source ?? 'user', at };
      break;
    case 'skip':
      next = { status: 'skipped', source: 'user', at };
      break;
    case 'not_sure':
      next = { status: 'not_sure', source: 'user', at };
      break;
    case 'clear':
      next = null;
      break;
  }
  const section = { ...(doc[sectionId] ?? {}) };
  if (next) section[questionId] = next;
  else delete section[questionId];
  const out = { ...doc };
  if (Object.keys(section).length > 0) out[sectionId] = section;
  else delete out[sectionId];
  return out;
}

/**
 * One rev-guarded write to the caller's own live session. The caller names the rev it read: a different one is a StaleRevError and nothing is
 * stored. Another member's session is a NotFoundError even for an owner or admin, who may read it but not write it.
 */
async function write(ctx: InterviewCtx, input: { sessionId: string; rev: number; sectionId: string; questionId: string }, op: Op): Promise<InterviewSession> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const s = await load(client, ctx, input.sessionId, true);
    if (!s) throw new NotFoundError(`interview_sessions: no session ${input.sessionId}`);
    if (s.status !== 'active' && s.status !== 'capped') throw new SessionNotActiveError(s.status);
    if (s.rev !== input.rev) throw new StaleRevError(s.rev);
    const manifest = ctx.manifests(s.manifestId, s.manifestVersion);
    if (!manifest) throw new InterviewValidationError('unknown_manifest');
    const next = apply(s.answers, manifest, input.sectionId, input.questionId, op);
    try {
      // The rev in the predicate closes the window between the read and this write: a concurrent writer moves it and this matches no row.
      const { rows } = await client.query<Row>(
        `UPDATE interview_sessions SET answers = $3::jsonb WHERE id = $1 AND account_id = $2 AND rev = $4 AND created_by = $5 RETURNING ${COLS}`,
        [s.id, accountId, JSON.stringify(next), input.rev, userId],
      );
      if (rows[0]) return toSession(rows[0]);
    } catch (e) {
      if (pgCode(e) === '23514') throw new InterviewValidationError('document_too_large');
      throw e;
    }
    const again = await load(client, ctx, s.id, true);
    if (!again) throw new NotFoundError(`interview_sessions: no session ${s.id}`);
    if (again.status !== 'active' && again.status !== 'capped') throw new SessionNotActiveError(again.status);
    throw new StaleRevError(again.rev);
  });
}

type Target = { sessionId: string; rev: number; sectionId: string; questionId: string };
export const answerQuestion = (ctx: InterviewCtx, t: Target & { text: string; source?: AnswerSource }) => write(ctx, t, { kind: 'answer', text: t.text, source: t.source });
export const editAnswer = (ctx: InterviewCtx, t: Target & { text: string; source?: AnswerSource }) => write(ctx, t, { kind: 'edit', text: t.text, source: t.source });
export const skipQuestion = (ctx: InterviewCtx, t: Target) => write(ctx, t, { kind: 'skip' });
export const markNotSure = (ctx: InterviewCtx, t: Target) => write(ctx, t, { kind: 'not_sure' });
/** Puts a question back to unasked: the undo of answering, skipping or marking it not sure. */
export const clearAnswer = (ctx: InterviewCtx, t: Target) => write(ctx, t, { kind: 'clear' });

/** Walks away from an interview. The row stays, read-only, and still counts toward the day's starts. */
export async function abandonSession(ctx: InterviewCtx, input: { sessionId: string; rev: number }): Promise<InterviewSession> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    let outcome: string;
    try {
      outcome = (await client.query<{ r: string }>('SELECT interview_session_abandon($1, $2) AS r', [input.sessionId, input.rev])).rows[0]!.r;
    } catch (e) {
      if (pgCode(e) === '42501') throw new ForbiddenError('interview: not a member of this account');
      throw e;
    }
    const s = await load(client, ctx, input.sessionId, true);
    if (outcome === 'ok') return s!;
    if (outcome === 'not_active') throw new SessionNotActiveError(s!.status);
    if (outcome === 'stale_rev') throw new StaleRevError(s!.rev);
    throw new NotFoundError(`interview_sessions: no session ${input.sessionId}`);
  });
}

export interface CapsState {
  hostedPlanPaid: boolean;
  bounds: SessionBounds;
  activeInAccount: number;
  activeForUser: number;
  startsLast24h: number;
  /** The bound a start would hit now, or null when one may start. Checked in the database's order. */
  blockedBy: LimitBound | null;
}

/** Where the caller and their account stand against the session bounds. Counts come from the database, which sees the whole account. */
export async function getCapsState(ctx: InterviewCtx): Promise<CapsState> {
  const { accountId, userId } = ctx.principal;
  const r = await withTenant(ctx.pool, accountId, userId, async (client) => {
    try {
      return (await client.query<{ hosted_plan_paid: boolean; active_account: number; active_user: number; starts_24h: number }>('SELECT * FROM interview_session_counts()')).rows[0]!;
    } catch (e) {
      if (pgCode(e) === '42501') throw new ForbiddenError('interview: not a member of this account');
      throw e;
    }
  });
  const bounds = boundsFor(r.hosted_plan_paid);
  const blockedBy: LimitBound | null =
    bounds.activePerAccount !== null && r.active_account >= bounds.activePerAccount
      ? 'active_per_account'
      : r.active_user >= bounds.activePerUser
        ? 'active_per_user'
        : r.starts_24h >= bounds.startsPerDay
          ? 'starts_per_day'
          : null;
  return { hostedPlanPaid: r.hosted_plan_paid, bounds, activeInAccount: r.active_account, activeForUser: r.active_user, startsLast24h: r.starts_24h, blockedBy };
}
