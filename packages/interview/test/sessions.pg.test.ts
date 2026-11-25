import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedF2, type F2Fixture } from '@fx/db/test/helpers/members.js';
import {
  InterviewLimitError,
  InterviewValidationError,
  NotFoundError,
  PAID_BOUNDS,
  SessionNotActiveError,
  StaleRevError,
  UNPAID_BOUNDS,
  abandonSession,
  answerQuestion,
  clearAnswer,
  editAnswer,
  getCapsState,
  getSession,
  listSessions,
  markNotSure,
  skipQuestion,
  startSession,
  type InterviewCtx,
  type ManifestView,
} from '../src/index.js';

/** A pinned fixture manifest, as a structural lookup: the service never imports the private templates package. */
const PRD: ManifestView = {
  id: 'prd',
  version: '1',
  sections: [
    { id: 'problem', questions: [{ id: 'q_problem', max_bytes: 4096 }, { id: 'q_short', max_bytes: 10 }] },
    { id: 'users', questions: [{ id: 'q_users', max_bytes: 8192 }] },
  ],
};
const manifests = (id: string, version: string) => (id === PRD.id && version === PRD.version ? PRD : undefined);
const P = { sectionId: 'problem', questionId: 'q_problem' };

describe('interview sessions service [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: F2Fixture;
  let B: F2Fixture;

  const ctx = (f: F2Fixture, userId: string): InterviewCtx => ({ pool: appPool, principal: { accountId: f.accountId, userId }, manifests });
  const wipe = () => admin.query('DELETE FROM interview_sessions WHERE account_id = ANY($1)', [[A.accountId, B.accountId]]);
  const begin = (f: F2Fixture, user: string) => startSession(ctx(f, user), { manifestId: 'prd', manifestVersion: '1' });
  const setPaid = (f: F2Fixture, paid: boolean) => admin.query('UPDATE accounts SET hosted_plan_paid = $2 WHERE id = $1', [f.accountId, paid]);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedF2(admin);
    B = await seedF2(admin);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  describe('start and read', () => {
    it('starts an active session at rev 1 with the manifest pinned and nothing answered', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      expect(s).toMatchObject({ status: 'active', rev: 1, manifestId: 'prd', manifestVersion: '1', answers: {}, createdBy: A.m1, accountId: A.accountId, spentUsd: 0, turnCount: 0 });
    });

    it('refuses an unknown manifest before touching the database', async () => {
      await wipe();
      await expect(startSession(ctx(A, A.m1), { manifestId: 'prd', manifestVersion: '9' })).rejects.toMatchObject({ code: 'unknown_manifest' });
      expect((await admin.query('SELECT 1 FROM interview_sessions WHERE account_id = $1', [A.accountId])).rowCount).toBe(0);
    });

    it('answers 404 (NotFoundError) to another member and to another account, never a refusal; an owner or admin can read it', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      await expect(getSession(ctx(A, A.m2), s.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getSession(ctx(B, B.o1), s.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await getSession(ctx(A, A.a1), s.id)).id).toBe(s.id);
      expect((await getSession(ctx(A, A.m1), s.id)).id).toBe(s.id);
    });

    it('lists the caller\'s own sessions; scope visible adds the account\'s for an owner or admin only; a second account\'s are never listed', async () => {
      await wipe();
      await setPaid(A, true);
      const mine = await begin(A, A.m1);
      const theirs = await begin(A, A.m2);
      await begin(B, B.m1);
      expect((await listSessions(ctx(A, A.m1))).map((s) => s.id)).toEqual([mine.id]);
      expect((await listSessions(ctx(A, A.a1))).map((s) => s.id)).toEqual([]);
      expect((await listSessions(ctx(A, A.a1), { scope: 'visible' })).map((s) => s.id).sort()).toEqual([mine.id, theirs.id].sort());
      expect((await listSessions(ctx(A, A.m1), { scope: 'visible' })).map((s) => s.id)).toEqual([mine.id]);
      await abandonSession(ctx(A, A.m1), { sessionId: mine.id, rev: mine.rev });
      expect(await listSessions(ctx(A, A.m1), { liveOnly: true })).toEqual([]);
    });

    it('a repo of another account is refused as not found', async () => {
      await wipe();
      const foreignRepo = (await admin.query<{ id: string }>('SELECT id FROM repos WHERE account_id = $1 LIMIT 1', [B.accountId])).rows[0]?.id ?? randomUUID();
      await expect(startSession(ctx(A, A.m1), { manifestId: 'prd', manifestVersion: '1', repoId: foreignRepo })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('answer, edit, skip, not sure, clear', () => {
    it('answers a question, moves rev by one, and keeps the text verbatim with its source', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      const t = await answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: s.rev, ...P, text: '  A real problem.\n## not a heading  ' });
      expect(t.rev).toBe(2);
      expect(t.answers.problem!.q_problem).toMatchObject({ status: 'answered', text: '  A real problem.\n## not a heading  ', source: 'user' });
      expect((await getSession(ctx(A, A.m1), s.id)).rev).toBe(2);
    });

    it('answering twice is refused; editing replaces it; editing an unanswered question is refused', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      await expect(editAnswer(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P, text: 'x' })).rejects.toMatchObject({ code: 'not_answered' });
      const a = await answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P, text: 'first' });
      await expect(answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: a.rev, ...P, text: 'again' })).rejects.toMatchObject({ code: 'already_answered' });
      const e = await editAnswer(ctx(A, A.m1), { sessionId: s.id, rev: a.rev, ...P, text: 'second', source: 'upload' });
      expect(e.answers.problem!.q_problem).toMatchObject({ text: 'second', source: 'upload' });
      expect(e.rev).toBe(3);
    });

    it('skip and not-sure record a state with no text, and either can be replaced by an answer; clear puts the question back to unasked', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      const k = await skipQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P });
      expect(k.answers.problem!.q_problem).toMatchObject({ status: 'skipped' });
      expect(k.answers.problem!.q_problem).not.toHaveProperty('text');
      const n = await markNotSure(ctx(A, A.m1), { sessionId: s.id, rev: k.rev, ...P });
      expect(n.answers.problem!.q_problem!.status).toBe('not_sure');
      const a = await answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: n.rev, ...P, text: 'now I know' });
      expect(a.answers.problem!.q_problem!.status).toBe('answered');
      const c = await clearAnswer(ctx(A, A.m1), { sessionId: s.id, rev: a.rev, ...P });
      expect(c.answers).toEqual({});
      expect(c.rev).toBe(a.rev + 1);
    });

    it('refuses an unknown section or question, empty text, NUL, an answer over its limit, and stores nothing', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      const w = (over: object) => answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P, text: 'ok', ...over });
      await expect(w({ sectionId: 'nope' })).rejects.toMatchObject({ code: 'unknown_question' });
      await expect(w({ sectionId: 'users' })).rejects.toMatchObject({ code: 'unknown_question' });
      await expect(w({ text: '  \n ' })).rejects.toMatchObject({ code: 'empty_answer' });
      await expect(w({ text: 'a\u0000b' })).rejects.toMatchObject({ code: 'invalid_text' });
      await expect(w({ questionId: 'q_short', text: 'x'.repeat(11) })).rejects.toMatchObject({ code: 'answer_too_large' });
      await expect(w({ questionId: 'q_short', text: 'é'.repeat(6) })).rejects.toMatchObject({ code: 'answer_too_large' });
      await expect(w({ sectionId: 'users', questionId: 'q_users', text: 'x'.repeat(8 * 1024 + 1) })).rejects.toBeInstanceOf(InterviewValidationError);
      await expect(w({ sectionId: 'users', questionId: 'q_users', text: 'x'.repeat(8 * 1024) })).resolves.toMatchObject({ rev: 2 });
      expect((await getSession(ctx(A, A.m1), s.id)).rev).toBe(2);
    });

    it('refuses a write that would take the whole document over 64 KiB, and keeps the old one', async () => {
      await wipe();
      let s = await begin(A, A.m1);
      const big = { ...PRD, sections: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, questions: [{ id: `q${i}`, max_bytes: 8192 }] })) };
      const c = { ...ctx(A, A.m1), manifests: () => big };
      let failure: unknown;
      for (let i = 0; i < 9 && !failure; i++) {
        try {
          s = await answerQuestion(c, { sessionId: s.id, rev: s.rev, sectionId: `s${i}`, questionId: `q${i}`, text: 'x'.repeat(8192) });
        } catch (e) {
          failure = e;
        }
      }
      expect(failure).toMatchObject({ code: 'document_too_large' });
      expect((await getSession(ctx(A, A.m1), s.id)).rev).toBe(s.rev);
    });
  });

  describe('rev', () => {
    it('a write naming an old rev is a 409 stale_rev carrying the current rev, and changes nothing', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      const a = await answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P, text: 'from the laptop' });
      const stale = answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, sectionId: 'users', questionId: 'q_users', text: 'from the phone' });
      await expect(stale).rejects.toBeInstanceOf(StaleRevError);
      await expect(stale).rejects.toMatchObject({ code: 'stale_rev', currentRev: a.rev });
      const now = await getSession(ctx(A, A.m1), s.id);
      expect(now.answers).toEqual(a.answers);
      // Every write kind carries the guard.
      for (const op of [skipQuestion, markNotSure, clearAnswer]) await expect(op(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P })).rejects.toBeInstanceOf(StaleRevError);
      await expect(editAnswer(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P, text: 'z' })).rejects.toBeInstanceOf(StaleRevError);
      await expect(abandonSession(ctx(A, A.m1), { sessionId: s.id, rev: 1 })).rejects.toBeInstanceOf(StaleRevError);
    });

    it('two writers racing on one rev: exactly one wins and the other is stale', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      const run = (qs: string, qq: string) => answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, sectionId: qs, questionId: qq, text: qq });
      const r = await Promise.allSettled([run('problem', 'q_problem'), run('users', 'q_users')]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(StaleRevError);
      expect((await getSession(ctx(A, A.m1), s.id)).rev).toBe(2);
    });

    it('a write that loses the race between its read and its update is stale, and the winner\'s answer survives', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      let fired = false;
      // Runs a complete competing write right before this one's UPDATE statement, on a different connection.
      const racing = {
        connect: async () => {
          const c = await appPool.connect();
          const query = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
          (c as unknown as { query: unknown }).query = async (...a: unknown[]) => {
            if (!fired && typeof a[0] === 'string' && a[0].startsWith('UPDATE interview_sessions')) {
              fired = true;
              await answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, sectionId: 'users', questionId: 'q_users', text: 'the winner' });
            }
            return query(...a);
          };
          return c;
        },
      } as unknown as Pool;
      await expect(answerQuestion({ ...ctx(A, A.m1), pool: racing }, { sessionId: s.id, rev: 1, ...P, text: 'the loser' })).rejects.toMatchObject({ code: 'stale_rev', currentRev: 2 });
      const now = await getSession(ctx(A, A.m1), s.id);
      expect(now.answers).toEqual({ users: { q_users: expect.objectContaining({ text: 'the winner' }) } });
    });

    it('a counter written by the turn service does not make the person\'s screen stale', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      await admin.query('UPDATE interview_sessions SET spent_usd = 0.1, turn_count = 1 WHERE id = $1', [s.id]);
      await expect(answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P, text: 'still fine' })).resolves.toMatchObject({ rev: 2, spentUsd: 0.1, turnCount: 1 });
    });
  });

  describe('who may write', () => {
    it('an owner or admin can read another member\'s session but a write is a 404, and another member\'s is too', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      for (const who of [A.a1, A.o1, A.m2]) {
        await expect(answerQuestion(ctx(A, who), { sessionId: s.id, rev: 1, ...P, text: 'mine now' })).rejects.toBeInstanceOf(NotFoundError);
        await expect(abandonSession(ctx(A, who), { sessionId: s.id, rev: 1 })).rejects.toBeInstanceOf(NotFoundError);
      }
      await expect(answerQuestion(ctx(B, B.o1), { sessionId: s.id, rev: 1, ...P, text: 'cross tenant' })).rejects.toBeInstanceOf(NotFoundError);
      expect((await getSession(ctx(A, A.m1), s.id)).rev).toBe(1);
    });

    it('a user id that is not a member of the account cannot start or read', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      await expect(begin(A, B.m1)).rejects.toMatchObject({ name: 'ForbiddenError' });
      await expect(getSession(ctx(A, B.m1), s.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('the service names account and person itself (read through the RLS-bypassing admin connection)', () => {
    const open = (f: F2Fixture, userId: string): InterviewCtx => ({ pool: adminPool, principal: { accountId: f.accountId, userId }, manifests });

    it('a foreign account id finds no session, and writes find none either', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      await expect(getSession(open(B, B.m1), s.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(answerQuestion(open(B, B.m1), { sessionId: s.id, rev: 1, ...P, text: 'x' })).rejects.toBeInstanceOf(NotFoundError);
      expect(await listSessions(open(B, B.o1), { scope: 'visible' })).toEqual([]);
      expect((await getSession(open(A, A.m1), s.id)).rev).toBe(1);
    });

    it('another person of the same account cannot write, and the same account\'s other sessions do not leak into a mine-list', async () => {
      await wipe();
      await setPaid(A, true);
      const mine = await begin(A, A.m1);
      const other = await begin(A, A.m2);
      await expect(answerQuestion(open(A, A.m2), { sessionId: mine.id, rev: 1, ...P, text: 'x' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(skipQuestion(open(A, A.a1), { sessionId: mine.id, rev: 1, ...P })).rejects.toBeInstanceOf(NotFoundError);
      expect((await listSessions(open(A, A.m2))).map((r) => r.id)).toEqual([other.id]);
    });
  });

  describe('abandoned, finished and capped', () => {
    it('abandon makes the session read-only: every write is session_not_active and nothing moves', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      const done = await abandonSession(ctx(A, A.m1), { sessionId: s.id, rev: 1 });
      expect(done).toMatchObject({ status: 'abandoned', rev: 2, answers: {} });
      for (const op of [answerQuestion, editAnswer]) await expect(op(ctx(A, A.m1), { sessionId: s.id, rev: 2, ...P, text: 'late' })).rejects.toBeInstanceOf(SessionNotActiveError);
      for (const op of [skipQuestion, markNotSure, clearAnswer]) await expect(op(ctx(A, A.m1), { sessionId: s.id, rev: 2, ...P })).rejects.toBeInstanceOf(SessionNotActiveError);
      await expect(abandonSession(ctx(A, A.m1), { sessionId: s.id, rev: 2 })).rejects.toMatchObject({ code: 'session_not_active', status: 'abandoned' });
      expect(await getSession(ctx(A, A.m1), s.id)).toMatchObject({ status: 'abandoned', rev: 2 });
    });

    it('a finished session is read-only too, and cannot be abandoned', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      await admin.query(`UPDATE interview_sessions SET status = 'finished', finished_at = now() WHERE id = $1`, [s.id]);
      const rev = (await getSession(ctx(A, A.m1), s.id)).rev;
      await expect(answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev, ...P, text: 'late' })).rejects.toMatchObject({ code: 'session_not_active', status: 'finished' });
      await expect(abandonSession(ctx(A, A.m1), { sessionId: s.id, rev })).rejects.toMatchObject({ code: 'session_not_active', status: 'finished' });
    });

    it('a capped session keeps its draft and still accepts edits, and can be abandoned', async () => {
      await wipe();
      const s = await begin(A, A.m1);
      const a = await answerQuestion(ctx(A, A.m1), { sessionId: s.id, rev: 1, ...P, text: 'before the cap' });
      await admin.query(`UPDATE interview_sessions SET status = 'capped' WHERE id = $1`, [s.id]);
      const rev = (await getSession(ctx(A, A.m1), s.id)).rev;
      expect(rev).toBe(a.rev + 1);
      const e = await editAnswer(ctx(A, A.m1), { sessionId: s.id, rev, ...P, text: 'after the cap' });
      expect(e).toMatchObject({ status: 'capped' });
      expect(e.answers.problem!.q_problem!.text).toBe('after the cap');
      expect(await abandonSession(ctx(A, A.m1), { sessionId: s.id, rev: e.rev })).toMatchObject({ status: 'abandoned' });
    });

    it('abandoning frees the place under the bound, but not the day\'s start', async () => {
      await wipe();
      await setPaid(A, false);
      const s = await begin(A, A.m1);
      await begin(A, A.m2);
      await expect(begin(A, A.a1)).rejects.toMatchObject({ bound: 'active_per_account' });
      await abandonSession(ctx(A, A.m1), { sessionId: s.id, rev: 1 });
      await expect(begin(A, A.a1)).resolves.toMatchObject({ status: 'active' });
      expect((await getCapsState(ctx(A, A.a1))).startsLast24h).toBe(3);
    });
  });

  describe('caps state and the bounds', () => {
    it('limits.ts and the database agree at every boundary, for an unpaid and a paid account', async () => {
      const users = [A.m1, A.m2, A.a1, A.a2, A.o1, A.o2];
      for (const paid of [false, true]) {
        await wipe();
        await setPaid(A, paid);
        const b = paid ? PAID_BOUNDS : UNPAID_BOUNDS;
        // Live sessions per user: exactly activePerUser start, the next is refused with that bound.
        const per = b.activePerAccount === null ? b.activePerUser : Math.min(b.activePerUser, b.activePerAccount);
        for (let i = 0; i < per; i++) await begin(A, A.m1);
        const st = await getCapsState(ctx(A, A.m1));
        expect(st).toMatchObject({ hostedPlanPaid: paid, bounds: b, activeForUser: per, blockedBy: b.activePerAccount !== null && per >= b.activePerAccount ? 'active_per_account' : 'active_per_user' });
        await expect(begin(A, A.m1)).rejects.toBeInstanceOf(InterviewLimitError);
        // Starts per day: fill the day with abandoned starts up to one under, then the last start passes and the next is refused.
        await wipe();
        for (let i = 0; i < b.startsPerDay - 1; i++) {
          await admin.query(`INSERT INTO interview_sessions (account_id, created_by, manifest_id, manifest_version, status, started_at) VALUES ($1, $2, 'prd', '1', 'abandoned', now() - ($3 || ' minutes')::interval)`, [A.accountId, users[i % users.length], String(i + 1)]);
        }
        await begin(A, A.o2);
        await expect(begin(A, A.o1)).rejects.toMatchObject({ bound: 'starts_per_day' });
        expect((await getCapsState(ctx(A, A.o1))).blockedBy).toBe('starts_per_day');
      }
    });

    it('reports the counts of the caller\'s own account only', async () => {
      await wipe();
      await setPaid(A, true);
      await setPaid(B, true);
      await begin(A, A.m1);
      await begin(A, A.m2);
      await begin(B, B.m1);
      expect(await getCapsState(ctx(A, A.m1))).toMatchObject({ activeInAccount: 2, activeForUser: 1, startsLast24h: 2, blockedBy: null });
      expect(await getCapsState(ctx(B, B.m1))).toMatchObject({ activeInAccount: 1, activeForUser: 1, startsLast24h: 1 });
    });
  });
});
