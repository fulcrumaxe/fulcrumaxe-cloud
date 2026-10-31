import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { raiseAskMarked } from '@fx/core/src/decisions/raiseAskMarked.js';
import { answerAsk } from '@fx/core/src/decisions/index.js';
import { raiseStartAsk } from '@fx/core/src/decisions/startGate.js';
import { SWEEP_REAL_CLOCK, sweepOverdueAsks } from '@fx/core/src/decisions/sweepOverdue.js';
import { sanitizeWebhookPayload } from '@fx/webhooks';
import { AccountPoller, type AccountEventRow } from '../src/sse/poller.js';
import { ManualClock } from './helpers/manual-clock.js';
import { eventually } from './helpers/sse.js';

/**
 * [pg] D#7 DP12b-2: decision.ask_raised, decision.ask_answered and decision.ask_overdue all land in domain_events and reach the account stream through
 * the SSE poller, for the subscriber's own account only. The question and option text carries a marker that must appear in no payload, and the
 * webhook allowlist keeps every id and enum of each payload.
 */
const INVOKER_LOGIN = 'fx_ask_events_stream_test';
const MARK = 'QUESTION-OPTION-TEXT';
const OPTIONS = [{ id: 'apply', label: `${MARK} apply` }, { id: 'skip', label: `${MARK} skip` }];

describe('decision.ask_* events reach the account stream', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let receiptPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.API_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  const raise = (t: SeedRefs, onTimeout: 'stop_and_flag' | 'proceed_recommended' = 'stop_and_flag') =>
    withTenant(receiptPool, t.accountId, (c) =>
      raiseAskMarked(c, {
        class: 'human_over_the_loop', decisionType: 'test_strategy_choice', workItemId: t.workItemId, runId: t.runId, options: OPTIONS, proposed: 'apply',
        rationale: 'because', quotedInputs: [{ trust: 'trusted', storedBody: 'x' }], policy: { answerWindowMinutes: 60, onTimeout },
      }));
  /** The window ended two days ago. The guard freezes both columns, so it is bypassed for this one admin statement only. */
  async function makeDue(id: string): Promise<void> {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      await admin.query(`UPDATE decision_asks SET raised_at = raised_at - interval '2 days', answer_due_at = answer_due_at - interval '2 days' WHERE id = $1`, [id]);
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
  }
  async function subscribe(accountId: string) {
    const clock = new ManualClock(Date.now());
    const poller = new AccountPoller({ pool: appUserPool, platformOpsPool, clock });
    clock.track(poller);
    const rows: AccountEventRow[] = [];
    poller.subscribe(accountId, 0n, { onEvents: (r) => rows.push(...r), onFail: () => undefined });
    await clock.advance(0);
    return { rows, clock };
  }

  it('raised, answered and overdue each arrive once on their own account\'s stream; the other account sees none; payloads are ids and enums', async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const mine = await subscribe(a.accountId);
    const theirs = await subscribe(b.accountId);

    const answeredId = await raise(a);
    await answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId } }, { askId: answeredId, choice: 'skip' });
    // A second ask on a fresh item times out into overdue.
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress')`, [itemId, a.accountId, a.repoId]);
    const overdueId = await withTenant(receiptPool, a.accountId, (c) =>
      raiseAskMarked(c, {
        class: 'human_over_the_loop', decisionType: 'test_strategy_choice', workItemId: itemId, options: OPTIONS, proposed: 'apply',
        rationale: 'because', quotedInputs: [{ trust: 'trusted', storedBody: 'x' }], policy: { answerWindowMinutes: 60, onTimeout: 'stop_and_flag' },
      }));
    await makeDue(overdueId);
    expect((await sweepOverdueAsks(receiptPool, SWEEP_REAL_CLOCK)).overdue).toBeGreaterThanOrEqual(1);

    await mine.clock.advance(2000);
    await eventually(() => ['decision.ask_raised', 'decision.ask_answered', 'decision.ask_overdue'].every((t) => mine.rows.some((r) => r.type === t)));
    const of = (type: string, subject: string) => mine.rows.filter((r) => r.type === type && r.subjectId === subject);
    expect(of('decision.ask_raised', answeredId).length).toBe(1);
    expect(of('decision.ask_raised', overdueId).length).toBe(1);
    expect(of('decision.ask_answered', answeredId).length).toBe(1);
    expect(of('decision.ask_overdue', overdueId).length).toBe(1);

    const raised = of('decision.ask_raised', answeredId)[0]!.payload as Record<string, unknown>;
    expect(raised).toEqual({ askId: answeredId, workItemId: a.workItemId, runId: a.runId, decisionType: 'test_strategy_choice', timeoutOutcome: 'stop_and_flag' });
    for (const r of mine.rows.filter((x) => x.type.startsWith('decision.ask_'))) {
      expect(JSON.stringify(r.payload)).not.toContain(MARK);
      // Every key survives the webhook allowlist: nothing the producers write is dropped except an absent (null) run id, and nothing outside it is written.
      expect(sanitizeWebhookPayload(r.payload as Record<string, unknown>)).toEqual(Object.fromEntries(Object.entries(r.payload as object).filter(([, v]) => v !== null)));
    }
    await theirs.clock.advance(2000);
    expect(theirs.rows.filter((r) => r.type.startsWith('decision.ask_'))).toEqual([]);
  });

  it('a start-gate answer (an ask with no run) carries camelCase ids and enums that survive the webhook allowlist and reach the stream', async () => {
    const t = await seedAccount(admin, randomUUID());
    const wi = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const mine = await subscribe(t.accountId);
    const { askId } = await raiseStartAsk({ pool: receiptPool, accountId: t.accountId }, { workItemId: wi, decisionType: 'start_work_small', preset: 'cautious' });
    const res = await answerAsk({ pool: receiptPool, principal: { accountId: t.accountId, userId: t.userId } }, { askId: askId!, choice: 'hold' });
    await mine.clock.advance(2000);
    await eventually(() => mine.rows.some((r) => r.type === 'decision.ask_answered' && r.subjectId === askId));
    const ev = mine.rows.find((r) => r.type === 'decision.ask_answered' && r.subjectId === askId)!.payload as Record<string, unknown>;
    expect(ev).toEqual({ askId, workItemId: wi, runId: null, receiptId: res.receiptId, decisionType: 'start_work_small', answeredOption: 'hold' });
    // Every key the start path writes survives the allowlist (the null run id is the one value it drops).
    expect(sanitizeWebhookPayload(ev)).toEqual({ askId, workItemId: wi, receiptId: res.receiptId, decisionType: 'start_work_small', answeredOption: 'hold' });
  });

  it('a raised ask has exactly one raised event', async () => {
    const t = await seedAccount(admin, randomUUID());
    const id = await raise(t);
    const n = (await admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type = 'decision.ask_raised' AND subject_id = $2`, [t.accountId, id])).rows[0].n;
    expect(n).toBe(1);
  });
});
