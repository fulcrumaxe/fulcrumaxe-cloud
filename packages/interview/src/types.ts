import type { Pool } from 'pg';
import { NotFoundError } from '@fx/core/src/tenancy/errors.js';

export { NotFoundError };

export type SessionStatus = 'active' | 'capped' | 'finished' | 'abandoned';
export type AnswerSource = 'user' | 'upload' | 'repo_signal';

/** One question's state. `text` is present exactly when `status` is 'answered'. The shape the PRD renderer takes, plus when it was written. */
export interface AnswerEntry {
  status: 'answered' | 'skipped' | 'not_sure';
  text?: string;
  source: AnswerSource;
  at: string;
}
/** `{ [sectionId]: { [questionId]: AnswerEntry } }`, as the Spec lays it out. */
export type AnswerDoc = Record<string, Record<string, AnswerEntry>>;

export interface InterviewSession {
  id: string;
  accountId: string;
  createdBy: string;
  status: SessionStatus;
  manifestId: string;
  manifestVersion: string;
  repoId: string | null;
  answers: AnswerDoc;
  followups: Record<string, unknown>;
  rev: number;
  spentUsd: number;
  turnCount: number;
  projectDiscussionId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
}

/**
 * What the service needs of a template: its sections and question ids and the byte limit of each. A structural type on purpose.
 * The templates package is private and the public tree cannot import it, so the caller (the API composition root, which has both)
 * passes a lookup that returns a manifest or undefined. A real manifest satisfies this shape as it is.
 */
export interface ManifestView {
  id: string;
  version: string;
  sections: ReadonlyArray<{ id: string; questions: ReadonlyArray<{ id: string; max_bytes: number }> }>;
}
export type ManifestLookup = (id: string, version: string) => ManifestView | undefined;

export interface InterviewCtx {
  pool: Pool;
  principal: { accountId: string; userId: string };
  manifests: ManifestLookup;
}

/** The write named a rev that is no longer the row's. 409 `stale_rev`; the caller reloads. */
export class StaleRevError extends Error {
  readonly code = 'stale_rev';
  constructor(readonly currentRev: number) {
    super('stale_rev');
    this.name = 'StaleRevError';
  }
}

/** The session is finished or abandoned. Read-only from then on. */
export class SessionNotActiveError extends Error {
  readonly code = 'session_not_active';
  constructor(readonly status: SessionStatus) {
    super(`session_not_active: ${status}`);
    this.name = 'SessionNotActiveError';
  }
}

export type LimitBound = 'active_per_account' | 'active_per_user' | 'starts_per_day';
/** A session bound refused the start; `bound` names which. */
export class InterviewLimitError extends Error {
  readonly code = 'interview_limit';
  constructor(readonly bound: LimitBound) {
    super(`interview_limit: ${bound}`);
    this.name = 'InterviewLimitError';
  }
}

export type ValidationCode =
  | 'unknown_manifest'
  | 'unknown_question'
  | 'empty_answer'
  | 'invalid_text'
  | 'answer_too_large'
  | 'already_answered'
  | 'not_answered'
  | 'document_too_large';
/** The write was refused for its content; nothing was stored. */
export class InterviewValidationError extends Error {
  constructor(readonly code: ValidationCode, message?: string) {
    super(message ?? code);
    this.name = 'InterviewValidationError';
  }
}
