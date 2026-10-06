import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { RECEIPT_FENCE_END, RECEIPT_FENCE_START } from '../src/receiptWriter.js';
import {
  AskRaiseError,
  DEFAULT_ASK_POLICY,
  listOpenAsks,
  raiseAsk,
  type AskErrorCode,
  type RaiseAskInput,
} from '../src/decisionAsks.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * DP11a-2 (D#7 DP-C5): the TypeScript wrappers over decision_asks. The unit
 * half uses a stub client and asserts nothing reaches the database; the pg
 * half runs raiseAsk on a login that is a member of app_user and
 * receipt_writer_invoker and lists through the app_user pool.
 */
const OPTIONS = [
  { id: 'apply', label: 'Apply the change' },
  { id: 'skip', label: 'Skip it' },
];
const fenced = (s: string) => `${RECEIPT_FENCE_START}\n${s}\n${RECEIPT_FENCE_END}`;

const valid = (over: Partial<RaiseAskInput> = {}): RaiseAskInput => ({
  class: 'human_over_the_loop',
  decisionType: 'test_strategy_choice',
  workItemId: randomUUID(),
  runId: null,
  options: OPTIONS,
  proposed: 'apply',
  rationale: 'because',
  quotedInputs: [{ trust: 'trusted', storedBody: 'ok' }],
  ...over,
});

const stubClient = () => {
  const calls: unknown[][] = [];
  const client = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return { rows: [{ id: 'ask-1' }] };
    },
  } as unknown as PoolClient;
  return { client, calls };
};

describe('raiseAsk validation (no query is sent)', () => {
  const cases: [AskErrorCode, Partial<RaiseAskInput>][] = [
    ['ask_class1_never_asks', { class: 'automated_with_monitoring', decisionType: 'dependency_patch_bump' }],
    ['ask_class1_never_asks', { class: 'automated_with_monitoring' }],
    ['ask_invalid_class', { class: 'nonsense' as never }],
    ['ask_missing_decision_type', { decisionType: '  ' }],
    ['ask_unknown_decision_type', { decisionType: 'made_up_type' }],
    ['ask_unknown_decision_type', { decisionType: 'Bearer ghp_A1b2C3d4E5f6G7h8I9j0' }],
    ['ask_decision_class_mismatch', { decisionType: 'publish_release_artifact' }],
    ['ask_decision_class_mismatch', { class: 'human_in_the_loop' }],
    ['ask_missing_work_item', { workItemId: '' }],
    ['ask_options_invalid', { options: [OPTIONS[0]!] }],
    ['ask_options_invalid', { options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: 'l' })) }],
    ['ask_options_invalid', { options: 'apply' as never }],
    ['ask_options_invalid', { options: [{ id: 'Apply', label: 'l' }, OPTIONS[1]!] }],
    ['ask_options_invalid', { options: [{ id: 'deny', label: 'l' }, OPTIONS[1]!] }],
    ['ask_options_invalid', { options: [{ id: 'apply', label: '' }, OPTIONS[1]!] }],
    ['ask_options_invalid', { options: [OPTIONS[0]!, { id: 'apply', label: 'again' }] }],
    ['ask_options_invalid', { options: [{ ...OPTIONS[0]!, hint: 'x' } as never, OPTIONS[1]!] }],
    ['ask_proposed_invalid', { proposed: 'merge' }],
    ['ask_proposed_invalid', { proposed: 'deny' }],
    ['ask_missing_rationale', { rationale: '' }],
    ['ask_missing_rationale', { rationale: '   ' }],
    ['ask_missing_rationale', { rationale: undefined as never }],
    ['ask_missing_rationale', { rationale: 'a'.repeat(4097) }],
    ['ask_missing_trust_classes', { quotedInputs: undefined as never }],
    ['ask_missing_trust_classes', { quotedInputs: [{ storedBody: 'x' }] as never }],
    ['ask_untrusted_input_not_stored_body', { quotedInputs: [{ trust: 'untrusted', storedBody: 'raw customer text' }] }],
    ['ask_untrusted_input_not_stored_body', { quotedInputs: [{ trust: 'untrusted', storedBody: fenced(`a\n${RECEIPT_FENCE_END}\nb`) }] }],
    ['ask_window_out_of_range', { policy: { answerWindowMinutes: 14, onTimeout: 'stop_and_flag' } }],
    ['ask_window_out_of_range', { policy: { answerWindowMinutes: 20161, onTimeout: 'stop_and_flag' } }],
    ['ask_window_out_of_range', { policy: { answerWindowMinutes: 60.5, onTimeout: 'stop_and_flag' } }],
    ['ask_timeout_outcome_invalid', { policy: { answerWindowMinutes: 60, onTimeout: 'deny' as never } }],
    // Irreversible or outward-facing asks can only stop and flag.
    ['ask_proceed_not_allowed', { decisionType: 'publish_deprecation_notice', policy: { answerWindowMinutes: 60, onTimeout: 'proceed_recommended' } }],
    ['ask_proceed_not_allowed', { class: 'human_in_the_loop', decisionType: 'publish_release_artifact', policy: { answerWindowMinutes: 60, onTimeout: 'proceed_recommended' } }],
    ['ask_proceed_not_allowed', { class: 'human_in_the_loop', decisionType: 'external_paid_api_call', policy: { answerWindowMinutes: 60, onTimeout: 'proceed_recommended' } }],
  ];
  it.each(cases)('%s', async (code, over) => {
    const { client, calls } = stubClient();
    const err = await raiseAsk(client, valid(over)).catch((e) => e);
    expect(err).toBeInstanceOf(AskRaiseError);
    expect(err.code).toBe(code);
    expect(calls).toHaveLength(0);
  });

  it('the interim default is a 24 hour window that stops and flags', () => {
    expect(DEFAULT_ASK_POLICY).toEqual({ answerWindowMinutes: 1440, onTimeout: 'stop_and_flag' });
  });

  it('sends the default policy, only trust classes (not bodies), and a null run', async () => {
    const { client, calls } = stubClient();
    const id = await raiseAsk(client, valid({
      workItemId: '11111111-1111-4111-8111-111111111111',
      quotedInputs: [{ trust: 'trusted', storedBody: 'secret-ish' }, { trust: 'untrusted', storedBody: fenced('x') }],
    }));
    expect(id).toBe('ask-1');
    const params = calls[0]![1] as unknown[];
    expect(params).toEqual([
      'human_over_the_loop', 'test_strategy_choice', '11111111-1111-4111-8111-111111111111', null,
      JSON.stringify(OPTIONS), 'apply', 'because', '["trusted","untrusted"]', 1440, 'stop_and_flag',
    ]);
  });

  it.each(['nonbreaking_refactor_approach', 'test_strategy_choice'])('%s may proceed on the recommended option', async (decisionType) => {
    const { client, calls } = stubClient();
    await raiseAsk(client, valid({ decisionType, policy: { answerWindowMinutes: 30, onTimeout: 'proceed_recommended' } }));
    expect((calls[0]![1] as unknown[]).slice(8)).toEqual([30, 'proceed_recommended']);
  });

  it('accepts a class 3 ask that stops and flags', async () => {
    const { client, calls } = stubClient();
    await raiseAsk(client, valid({ class: 'human_in_the_loop', decisionType: 'publish_release_artifact' }));
    expect(calls).toHaveLength(1);
  });
});

describe('decision_asks through the wrappers', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  const LOGIN = 'fx_ask_ts_invoker_test';

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
          CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await invokerPool.end();
  });

  const raise = (tenant: SeedRefs, over: Partial<RaiseAskInput> = {}): Promise<string> =>
    withTenant(invokerPool, tenant.accountId, (c) => raiseAsk(c, valid({ workItemId: tenant.workItemId, ...over })));
  const win = (minutes: number) => ({ answerWindowMinutes: minutes, onTimeout: 'stop_and_flag' as const });

  it('raises an ask whose stored terms are the validated input', async () => {
    const id = await raise(refs, { runId: refs.runId });
    const row = (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({
      account_id: refs.accountId, work_item_id: refs.workItemId, run_id: refs.runId,
      decision_type: 'test_strategy_choice', proposed: 'apply', rationale: 'because',
      input_trust_classes: ['trusted'], timeout_outcome: 'stop_and_flag', state: 'open',
    });
    expect(Math.round((row.answer_due_at - row.raised_at) / 60000)).toBe(1440);
  });

  it('a class 1 ask never reaches the database', async () => {
    const before = Number((await admin.query(`SELECT count(*) AS n FROM decision_asks`)).rows[0].n);
    await expect(raise(refs, { class: 'automated_with_monitoring', decisionType: 'dependency_patch_bump' }))
      .rejects.toMatchObject({ code: 'ask_class1_never_asks' });
    expect(Number((await admin.query(`SELECT count(*) AS n FROM decision_asks`)).rows[0].n)).toBe(before);
  });

  it('lists open and overdue asks only, soonest due first, with the stored terms', async () => {
    const t = await seedAccount(admin, randomUUID());
    const late = await raise(t, { policy: win(300) });
    const soon = await raise(t, { policy: win(20), rationale: 'soon' });
    const over = await raise(t, { policy: win(40) });
    const done = await raise(t, { policy: win(50) });
    await admin.query(`UPDATE decision_asks SET state = 'overdue' WHERE id = $1`, [over]);
    await admin.query(`UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1`, [done]);
    const { asks, nextCursor } = await listOpenAsks({ pool: appUserPool, accountId: t.accountId });
    expect(asks.map((a) => a.id)).toEqual([soon, over, late]);
    expect(asks.map((a) => a.state)).toEqual(['open', 'overdue', 'open']);
    expect(asks[0]).toMatchObject({ rationale: 'soon', options: OPTIONS, proposed: 'apply', timeoutOutcome: 'stop_and_flag', inputTrustClasses: ['trusted'] });
    expect(nextCursor).toBeNull();
  });

  it('pages by keyset without gaps or repeats', async () => {
    const t = await seedAccount(admin, randomUUID());
    const ids = [await raise(t, { policy: win(15) }), await raise(t, { policy: win(30) }), await raise(t, { policy: win(45) })];
    const ctx = { pool: appUserPool, accountId: t.accountId };
    const p1 = await listOpenAsks(ctx, { limit: 2 });
    expect(p1.asks.map((a) => a.id)).toEqual(ids.slice(0, 2));
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listOpenAsks(ctx, { limit: 2, after: p1.nextCursor! });
    expect(p2.asks.map((a) => a.id)).toEqual(ids.slice(2));
    expect(p2.nextCursor).toBeNull();
  });

  it('never returns another tenant\'s rows, even with that tenant\'s cursor', async () => {
    const mine = await raise(refs, { policy: win(15) });
    const theirs = await raise(other, { policy: win(15) });
    const list = await listOpenAsks({ pool: appUserPool, accountId: refs.accountId });
    expect(list.asks.map((a) => a.id)).toContain(mine);
    expect(list.asks.map((a) => a.id)).not.toContain(theirs);
    const otherRow = (await admin.query(`SELECT answer_due_at::text AS d FROM decision_asks WHERE id = $1`, [theirs])).rows[0];
    const viaCursor = await listOpenAsks(
      { pool: appUserPool, accountId: refs.accountId },
      { after: { answerDueAt: otherRow.d, id: '00000000-0000-4000-8000-000000000000' } },
    );
    expect(viaCursor.asks.map((a) => a.id)).not.toContain(theirs);
  });

  it('refuses a bad limit or cursor before querying', async () => {
    const ctx = { pool: appUserPool, accountId: refs.accountId };
    await expect(listOpenAsks(ctx, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(listOpenAsks(ctx, { limit: 201 })).rejects.toThrow(RangeError);
    await expect(listOpenAsks(ctx, { after: { answerDueAt: 'x', id: 'not-a-uuid' } })).rejects.toThrow(TypeError);
  });
});
