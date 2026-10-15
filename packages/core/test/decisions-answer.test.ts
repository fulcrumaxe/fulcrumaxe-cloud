import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ASK_ANSWER_EXCEPTIONS, AskAnswerDefinerError, answerAskIn } from '@fx/db/src/decisionAsks.js';
import { AskAnswerError, answerAsk } from '../src/decisions/index.js';

/** DP11b (D#7 DP-C9): the parts of the answer service that need no database. */
describe('answerAsk without a database (DP11b)', () => {
  it('a token is refused before the pool is touched', async () => {
    const pool = new Proxy({}, { get: () => { throw new Error('the pool must not be used'); } }) as unknown as Pool;
    const principal = { accountId: randomId(1), userId: randomId(2), tokenId: randomId(3) };
    const err = await answerAsk({ pool, principal }, { askId: randomId(4), choice: 'skip' }).catch((e) => e);
    expect(err).toBeInstanceOf(AskAnswerError);
    expect(err).toMatchObject({ status: 403, code: 'session_required' });
  });

  describe('the definer\'s exception is told by its leading name, not by the rest of the message', () => {
    const failing = (message: string, code?: string) => ({ query: async () => { throw Object.assign(new Error(message), { code }); } }) as never;
    const call = (c: never) => answerAskIn(c, { askId: 'a', choice: 'b', receiptId: 'c' }).catch((e) => e);

    it.each(ASK_ANSWER_EXCEPTIONS)('%s', async (name) => {
      const err = await call(failing(`${name}: some words`));
      expect(err).toBeInstanceOf(AskAnswerDefinerError);
      expect(err.code).toBe(name);
    });

    it('a unique violation on the receipt link is a receipt mismatch', async () => {
      expect((await call(failing('duplicate key value violates unique constraint', '23505'))).code).toBe('ask_receipt_mismatch');
    });

    it('a name inside the message, or an unlisted name, is not taken as one', async () => {
      for (const message of ['boom: ask_already_answered', 'ask_unknown: x', 'permission denied for function decision_ask_answer']) {
        const err = await call(failing(message, '42501'));
        expect(err).not.toBeInstanceOf(AskAnswerDefinerError);
        expect(err.message).toBe(message);
      }
    });
  });

  describe('migration 0797 (DP-C9 criterion 6)', () => {
    const code = readFileSync(fileURLToPath(new URL('../../db/migrations/0797_decision_ask_answer.sql', import.meta.url)), 'utf8').replace(/--.*$/gm, '');

    it('does not touch run_action_requests, its CHECKs or run_action_request()', () => {
      expect(code).not.toMatch(/run_action_request|resume_decision/i);
    });

    it('revokes PUBLIC, grants the invoker only, and pins the search_path', () => {
      expect(code).not.toMatch(/TO\s+(app_user|PUBLIC)\b/i);
      expect(code).toMatch(/REVOKE ALL ON FUNCTION decision_ask_answer\(uuid, text, uuid\) FROM PUBLIC/);
      expect(code).toMatch(/GRANT EXECUTE ON FUNCTION decision_ask_answer\(uuid, text, uuid\) TO receipt_writer_invoker/);
      expect(code).toMatch(/SET search_path = pg_catalog, public, pg_temp/);
    });
  });
});

function randomId(n: number): string {
  return `${n}`.repeat(8) + '-1111-4111-8111-' + `${n}`.repeat(12);
}
