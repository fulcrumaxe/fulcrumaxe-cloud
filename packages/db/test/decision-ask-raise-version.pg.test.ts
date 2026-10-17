import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { raiseAsk } from '../src/decisionAsks.js';
import { writeReceipt } from '../src/receiptWriter.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#7 AAP-a4 (0864): the rule-set version on asks and receipts, on real Postgres as the real roles. */
const INVOKER_LOGIN = 'fx_ask_version_invoker_test';
const OPTIONS = [{ id: 'raise_limit', label: 'Raise the limit' }, { id: 'stop_item', label: 'Stop this item' }];

describe('the rule-set version on asks and receipts (0864)', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let invokerPool: Pool;
  let refs: SeedRefs;

  const addRules = (accountId: string, userId: string, repoId: string | null) =>
    admin.query(
      `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
       VALUES ($1, $2, (SELECT COALESCE(MAX(version), 0) + 1 FROM action_rules WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2), '{"rules":[]}', 0,
               encode(sha256(convert_to('{"rules": []}', 'UTF8')), 'hex'), $3)`,
      [accountId, repoId, userId],
    );
  const raise = (version: number | undefined, t: SeedRefs = refs) =>
    withTenant(invokerPool, t.accountId, (c) =>
      raiseAsk(c, {
        class: 'human_in_the_loop', decisionType: 'spend_past_envelope', workItemId: t.workItemId, runId: t.runId,
        options: OPTIONS, proposed: 'raise_limit', rationale: 'because', quotedInputs: [], ...(version === undefined ? {} : { ruleSetVersion: version }),
      }),
    );
  const readAsk = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    refs = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await invokerPool.end();
    await adminPool.end();
  });

  it('a raise with no version stores 0; with version 7 (seven account sets written) it stores 7', async () => {
    expect((await readAsk(await raise(undefined))).rule_set_version).toBe(0);
    for (let i = 0; i < 7; i += 1) await addRules(refs.accountId, refs.userId, null);
    expect((await readAsk(await raise(7))).rule_set_version).toBe(7);
  });

  it('refuses a version above the highest of the scope (22023), and a negative one, in the definer', async () => {
    await expect(raise(8)).rejects.toMatchObject({ code: '22023' });
    const a = await seedAccount(admin, randomUUID());
    await expect(raise(1, a)).rejects.toMatchObject({ code: '22023' });
    await expect(withTenant(invokerPool, a.accountId, (c) => c.query(`SELECT decision_ask_raise('human_in_the_loop','spend_past_envelope',$1::uuid,$2::uuid,$3::jsonb,'raise_limit','r','[]'::jsonb,60,'stop_and_flag',-1)`, [a.workItemId, a.runId, JSON.stringify(OPTIONS)]))).rejects.toMatchObject({ code: '22023' });
  });

  it('the scope is the item\'s: a repo set is the one a version is checked against', async () => {
    const a = await seedAccount(admin, randomUUID());
    await addRules(a.accountId, a.userId, null);
    await addRules(a.accountId, a.userId, null);
    await addRules(a.accountId, a.userId, a.repoId);
    await expect(raise(2, a)).rejects.toMatchObject({ code: '22023' }); // the repo set (version 1) applies, not the account's 2
    expect((await readAsk(await raise(1, a))).rule_set_version).toBe(1);
  });

  it('a rule-set change after the raise does not change a waiting ask\'s stored version', async () => {
    const id = await raise(7);
    await addRules(refs.accountId, refs.userId, null);
    expect((await readAsk(id)).rule_set_version).toBe(7);
    const appUser = createPool(process.env.DATABASE_URL_APP_USER!);
    try {
      await expect(withTenant(appUser, refs.accountId, (c) => c.query(`UPDATE decision_asks SET rule_set_version = 1 WHERE id = $1`, [id]))).rejects.toMatchObject({ code: '42501' });
    } finally {
      await appUser.end();
    }
  });

  it('the receipt written for a version-7 ask carries 7; a rule id needs a version; the plain receipt carries none', async () => {
    const base = { class: 'human_in_the_loop' as const, runId: refs.runId, workItemId: refs.workItemId, decisionType: 'spend_past_envelope', chosen: 'deny', rejectedAlternative: 'raise_limit', dialVersion: 0, quotedInputs: [] };
    const ruled = await withTenant(invokerPool, refs.accountId, (c) => writeReceipt(c, { ...base, ruleSetVersion: 7, ruleId: 'cap-it' }));
    if (ruled.store !== 'decision_receipts') throw new Error('expected a durable receipt');
    expect((await admin.query(`SELECT actor, rule_set_version, rule_id FROM decision_receipts WHERE id = $1`, [ruled.id])).rows[0]).toEqual({ actor: 'policy', rule_set_version: 7, rule_id: 'cap-it' });
    const plain = await withTenant(invokerPool, refs.accountId, (c) => writeReceipt(c, base));
    if (plain.store !== 'decision_receipts') throw new Error('expected a durable receipt');
    expect((await admin.query(`SELECT rule_set_version, rule_id FROM decision_receipts WHERE id = $1`, [plain.id])).rows[0]).toEqual({ rule_set_version: null, rule_id: null });
    await expect(withTenant(invokerPool, refs.accountId, (c) => writeReceipt(c, { ...base, ruleId: 'x' }))).rejects.toMatchObject({ code: 'receipt_rule_invalid' });
    await expect(withTenant(invokerPool, refs.accountId, (c) => writeReceipt(c, { ...base, ruleSetVersion: 99 }))).rejects.toMatchObject({ code: '22023' });
  });

  it('envelope_pause_asks holds exactly one of ask_id and receipt_id', async () => {
    const insert = (askId: string | null, receiptId: string | null, v: number) =>
      admin.query(`INSERT INTO envelope_pause_asks (account_id, work_item_id, envelope_id, envelope_version, ask_id, receipt_id) VALUES ($1, $2, $3, $4, $5, $6)`, [refs.accountId, refs.workItemId, randomUUID(), v, askId, receiptId]);
    await expect(insert(null, null, 1)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(randomUUID(), randomUUID(), 1)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(null, randomUUID(), 1)).resolves.toBeDefined();
    await expect(insert(randomUUID(), null, 1)).resolves.toBeDefined();
  });
});
