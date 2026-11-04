import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_VERSION } from '@fx/decisions';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writeMergeReceipt } from '../src/receiptWriter.js';
import { readMergeDial } from '../src/mergeDial.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] D#7 DW-R4 (migration 0983): merge_receipt_write, the one function the app login calls to leave the receipt behind a merge by policy. Everything
 * goes through the real logins (app_user, platform_ops) and the real definer; the facts it reads are written as the gate writes them.
 */
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

describe('migration 0983: merge_receipt_write [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let runId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [runId, A.accountId, A.workItemId, HEAD]);
  });

  const fact = (kind: string, code: string | null, reasons: string[], head = HEAD, a = A) =>
    admin.query(
      `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6, 7, $7)`,
      [a.accountId, a.workItemId, kind, code, reasons, head, `${kind}:${randomUUID()}`],
    );
  const merged = (head = HEAD) => fact('merged_by_gate', null, [], head);
  const hold = (reasons = ['auto_merge_not_allowed'], head = HEAD) => fact('merge_gate', 'ready_human_merges', reasons, head);
  const dial = (disposition: string, version: number, preset: string | null = null) =>
    admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'merge_after_reviews', $3, $4, $5, $6)`, [A.accountId, A.repoId, disposition, preset, version, A.userId]);
  const call = (client: PoolClient, args: { outcome?: string; chosen?: string; dialVersion?: number; head?: string; item?: string; run?: string } = {}) =>
    client.query<{ o_id: string; o_replayed: boolean }>('SELECT * FROM merge_receipt_write($1, $2, $3, $4, $5, $6, $7)', [
      args.item ?? A.workItemId, args.head ?? HEAD, args.run ?? runId, args.outcome ?? 'merged', args.chosen ?? 'act', args.dialVersion ?? 0, CATALOGUE_VERSION,
    ]);
  const asApp = <T>(fn: (c: PoolClient) => Promise<T>, accountId = A.accountId): Promise<T> => withTenant(appPool, accountId, fn);
  const refuse = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return 'no error';
  };
  const receipts = async () => (await admin.query(`SELECT * FROM decision_receipts WHERE account_id = $1 AND decision_type = 'merge_after_reviews' ORDER BY created_at`, [A.accountId])).rows;

  it('writes one class 2 receipt for a recorded merge: actor policy, the run, the item, the dial version, no reversal deadline', async () => {
    await merged();
    const out = await asApp((c) => call(c));
    expect(out.rows[0]!.o_replayed).toBe(false);
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.rows[0]!.o_id, class: 'human_over_the_loop', chosen: 'act', rejected_alternative: 'ask', dial_version: 0, actor: 'policy', run_id: runId, work_item_id: A.workItemId, catalogue_version: CATALOGUE_VERSION, reversal_free_until: null });
  });

  it('refuses a forged merge: no merged_by_gate fact, a fact at another head, or only a hold', async () => {
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002');
    await merged(OTHER_HEAD);
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002');
    await hold();
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002');
    expect(await receipts()).toHaveLength(0);
  });

  it('a merge the host queue made counts: the merged_via_queue fact at the head it records, and only that head; replay and eight concurrent calls leave one receipt; a forged head is refused', async () => {
    await fact('merged_via_queue', null, [], OTHER_HEAD);
    // The queue's fact records the head GitHub merged (OTHER_HEAD); the review run is on HEAD. A receipt is written at the fact's head, not at the head the run is on.
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002');
    const first = await asApp((c) => call(c, { head: OTHER_HEAD }));
    expect(first.rows[0]!.o_replayed).toBe(false);
    const raced = await Promise.all(Array.from({ length: 8 }, () => asApp((c) => call(c, { head: OTHER_HEAD }))));
    expect(new Set(raced.map((r) => r.rows[0]!.o_id))).toEqual(new Set([first.rows[0]!.o_id]));
    expect(await receipts()).toHaveLength(1);
    // Another account cannot use this item's queue fact.
    expect(await refuse(asApp((c) => call(c, { head: OTHER_HEAD }), B.accountId))).toBe('P0002');
    // A fact of another kind at a head is no merge there.
    await fact('merge_enqueued', 'queue', [], 'c'.repeat(40));
    expect(await refuse(asApp((c) => call(c, { head: 'c'.repeat(40) })))).toBe('P0002');
  });

  it('refuses across tenants: another account cannot write for this item, and this item\'s fact does not count for another account\'s item', async () => {
    await merged();
    expect(await refuse(asApp((c) => call(c), B.accountId))).toBe('P0002');
    // B has its own item and run but no fact at that head: refused, though A has one.
    const bRun = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [bRun, B.accountId, B.workItemId, HEAD]);
    expect(await refuse(asApp((c) => call(c, { item: B.workItemId, run: bRun }), B.accountId))).toBe('P0002');
    // A's run named for B's item: not that item's run.
    expect(await refuse(asApp((c) => call(c, { item: B.workItemId }), B.accountId))).toBe('22023');
    expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE decision_type = 'merge_after_reviews' AND account_id = ANY($1)`, [[A.accountId, B.accountId]])).rowCount).toBe(0);
  });

  it('a replay answers the first receipt; eight concurrent calls leave exactly one', async () => {
    await merged();
    const first = await asApp((c) => call(c));
    const again = await asApp((c) => call(c));
    expect(again.rows[0]).toEqual({ o_id: first.rows[0]!.o_id, o_replayed: true });
    const raced = await Promise.all(Array.from({ length: 8 }, () => asApp((c) => call(c))));
    expect(new Set(raced.map((r) => r.rows[0]!.o_id))).toEqual(new Set([first.rows[0]!.o_id]));
    expect(await receipts()).toHaveLength(1);

    // A fresh item and run, raced from the start: the lock, not the head start, makes it one.
    const run2 = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [run2, A.accountId, A.workItemId, OTHER_HEAD]);
    await merged(OTHER_HEAD);
    const race = await Promise.all(Array.from({ length: 8 }, () => asApp((c) => call(c, { head: OTHER_HEAD, run: run2 }))));
    expect(race.filter((r) => !r.rows[0]!.o_replayed)).toHaveLength(1);
    expect(await receipts()).toHaveLength(2);
  });

  it('refuses a session that carries a person or a token, and a platform_ops login', async () => {
    await merged();
    expect(await refuse(withTenant(appPool, A.accountId, A.userId, (c) => call(c)))).toBe('42501');
    expect(await refuse(withTenant(appPool, A.accountId, A.userId, randomUUID(), (c) => call(c)))).toBe('42501');
    expect(await refuse(withTenant(opsPool, A.accountId, (c) => call(c)))).toBe('42501');
    expect(await receipts()).toHaveLength(0);
  });

  it('checks the dial version it is given against the repository\'s own versions', async () => {
    await merged();
    await dial('announce', 1);
    await dial('ask', 2);
    await dial('ask', 3, 'default');
    expect(await refuse(asApp((c) => call(c, { chosen: 'announce', dialVersion: 9 })))).toBe('22023');
    expect(await refuse(asApp((c) => call(c, { chosen: 'act', dialVersion: 1 })))).toBe('22023');
    expect(await refuse(asApp((c) => call(c, { chosen: 'announce', dialVersion: 0 })))).toBe('22023');
    expect(await refuse(asApp((c) => call(c, { chosen: 'ask' })))).toBe('22023');
    expect(await receipts()).toHaveLength(0);
    const ok = await asApp((c) => call(c, { chosen: 'announce', dialVersion: 1 }));
    expect(ok.rows[0]!.o_replayed).toBe(false);
    expect((await receipts())[0]).toMatchObject({ chosen: 'announce', dial_version: 1 });
    // A "use the default" version is an act.
    const run3 = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [run3, A.accountId, A.workItemId, OTHER_HEAD]);
    await merged(OTHER_HEAD);
    expect((await asApp((c) => call(c, { head: OTHER_HEAD, run: run3, chosen: 'act', dialVersion: 3 }))).rows[0]!.o_replayed).toBe(false);
  });

  it('a hold is receipted only when the dial itself says ask, the gate left only that rule as the reason, once per held head, and never beside a merge', async () => {
    const hold1 = { outcome: 'ready', chosen: 'ask', dialVersion: 1 };
    await dial('ask', 1, 'cautious');
    expect(await refuse(asApp((c) => call(c, hold1)))).toBe('P0002');
    await hold(['auto_merge_not_allowed', 'ci_not_green']);
    expect(await refuse(asApp((c) => call(c, hold1)))).toBe('P0002');
    await hold();
    const first = await asApp((c) => call(c, hold1));
    expect(first.rows[0]!.o_replayed).toBe(false);
    expect((await asApp((c) => call(c, hold1))).rows[0]!.o_replayed).toBe(true);
    expect((await receipts())[0]).toMatchObject({ chosen: 'ask', rejected_alternative: 'act', actor: 'policy', dial_version: 1 });
    // The receipt that is there answers as a replay whatever the facts say now.
    await hold(['ci_not_green']);
    expect((await asApp((c) => call(c, hold1))).rows[0]!.o_replayed).toBe(true);
    // A NEW hold receipt needs the newest fact at that head to be the policy-only hold, and nothing merged there.
    const D = 'd'.repeat(40);
    const E = 'e'.repeat(40);
    const runD = randomUUID();
    const runE = randomUUID();
    for (const [r, h] of [[runD, D], [runE, E]] as const) {
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [r, A.accountId, A.workItemId, h]);
    }
    await hold(['auto_merge_not_allowed'], D);
    await hold(['ci_not_green'], D);
    expect(await refuse(asApp((c) => call(c, { ...hold1, head: D, run: runD })))).toBe('P0002');
    await hold(['auto_merge_not_allowed'], E);
    await merged(E);
    expect(await refuse(asApp((c) => call(c, { ...hold1, head: E, run: runE })))).toBe('P0002');
    // The merge's own receipt is separate from the hold's.
    await merged();
    expect((await asApp((c) => call(c))).rows[0]!.o_replayed).toBe(false);
    expect(await receipts()).toHaveLength(2);
  });

  it('a hold the role setting alone causes names no dial: version 0 and a dial that says act or announce are refused for a hold', async () => {
    await hold();
    expect(await refuse(asApp((c) => call(c, { outcome: 'ready', chosen: 'ask', dialVersion: 0 })))).toBe('22023');
    await dial('act', 1, 'autonomous');
    expect(await refuse(asApp((c) => call(c, { outcome: 'ready', chosen: 'ask', dialVersion: 1 })))).toBe('22023');
    await dial('announce', 2, 'balanced');
    expect(await refuse(asApp((c) => call(c, { outcome: 'ready', chosen: 'ask', dialVersion: 2 })))).toBe('22023');
    await dial('ask', 3, 'default');
    expect(await refuse(asApp((c) => call(c, { outcome: 'ready', chosen: 'ask', dialVersion: 3 })))).toBe('22023');
    expect(await receipts()).toHaveLength(0);
  });

  it('a hold first seen with other reasons and later held only by the dial is receipted (red then green), once per head, and a new head is a new hold', async () => {
    await dial('ask', 1, 'cautious');
    const hold1 = { outcome: 'ready', chosen: 'ask', dialVersion: 1 };
    await hold(['ci_not_green', 'auto_merge_not_allowed']);
    await hold();
    expect((await asApp((c) => call(c, hold1))).rows[0]!.o_replayed).toBe(false);
    await hold(['ci_not_green', 'auto_merge_not_allowed']);
    await hold();
    expect((await asApp((c) => call(c, hold1))).rows[0]!.o_replayed).toBe(true);
    const run2 = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [run2, A.accountId, A.workItemId, OTHER_HEAD]);
    await hold(['auto_merge_not_allowed'], OTHER_HEAD);
    expect((await asApp((c) => call(c, { ...hold1, head: OTHER_HEAD, run: run2 }))).rows[0]!.o_replayed).toBe(false);
    expect(await receipts()).toHaveLength(2);
  });

  it('one receipt per merge, keyed on the merge and not on the run: a second run on the same head, a late writer and the other fact kind all answer the first receipt', async () => {
    await merged();
    const first = await asApp((c) => call(c));
    const later = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [later, A.accountId, A.workItemId, HEAD]);
    expect((await asApp((c) => call(c, { run: later }))).rows[0]).toEqual({ o_id: first.rows[0]!.o_id, o_replayed: true });
    await fact('merged_via_queue', null, [], HEAD);
    expect((await asApp((c) => call(c, { run: later }))).rows[0]).toEqual({ o_id: first.rows[0]!.o_id, o_replayed: true });
    const raced = await Promise.all([runId, later].flatMap((run) => Array.from({ length: 4 }, () => asApp((c) => call(c, { run })))));
    expect(new Set(raced.map((r) => r.rows[0]!.o_id))).toEqual(new Set([first.rows[0]!.o_id]));
    expect(await receipts()).toHaveLength(1);
  });

  it('refuses a run that is not the work item\'s own: another item of the account, another account\'s run, and a run that does not exist', async () => {
    await merged();
    const other = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened')`, [other, A.accountId, A.repoId]);
    const otherRun = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [otherRun, A.accountId, other, HEAD]);
    expect(await refuse(asApp((c) => call(c, { run: otherRun })))).toBe('22023');
    const bRun = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [bRun, B.accountId, B.workItemId, HEAD]);
    expect(await refuse(asApp((c) => call(c, { run: bRun })))).toBe('22023');
    expect(await refuse(asApp((c) => call(c, { run: randomUUID() })))).toBe('22023');
    expect(await receipts()).toHaveLength(0);
  });

  it('the TypeScript writer and the dial read agree with the database: no row is act at version 0, then a row names its version', async () => {
    await merged();
    expect(await asApp((c) => readMergeDial(c, A.repoId))).toEqual({ disposition: 'act', version: 0 });
    await dial('announce', 1, 'balanced');
    const d = await asApp((c) => readMergeDial(c, A.repoId));
    expect(d).toEqual({ disposition: 'announce', version: 1 });
    const out = await asApp((c) => writeMergeReceipt(c, { workItemId: A.workItemId, headSha: HEAD, runId, outcome: 'merged', chosen: d.disposition as 'announce', dialVersion: d.version }));
    expect(out.replayed).toBe(false);
    expect((await receipts())[0]).toMatchObject({ chosen: 'announce', dial_version: 1, actor: 'policy' });
    expect((await admin.query(`SELECT decision_type FROM decision_receipts WHERE class = 'automated_with_monitoring'`)).rowCount).toBe(0);
  });

  it('the function and its owner have the narrow shape the migration promises', async () => {
    const role = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'merge_receipt_definer'`);
    expect(role.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'merge_receipt_definer'::regrole`)).rowCount).toBe(0);
    const memberOf = await admin.query<{ r: string }>(`SELECT pg_get_userbyid(roleid) AS r FROM pg_auth_members WHERE member = 'merge_receipt_definer'::regrole`);
    expect(memberOf.rows.map((r) => r.r)).toEqual(['receipt_writer_invoker']);
    expect((await admin.query(`SELECT has_table_privilege('merge_receipt_definer', 'decision_receipts', 'INSERT') AS ok`)).rows[0].ok).toBe(false);
    const fn = await admin.query<{ prosecdef: boolean; proconfig: string[]; owner: string; grantees: string[] }>(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              (SELECT coalesce(array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END), '{}') FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.oid = 'merge_receipt_write(uuid,text,uuid,text,text,integer,integer)'::regprocedure`,
    );
    expect(fn.rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'merge_receipt_definer', grantees: ['app_user'] });
    expect((await admin.query("SELECT has_function_privilege('platform_ops', 'merge_receipt_write(uuid,text,uuid,text,text,integer,integer)'::regprocedure, 'EXECUTE') AS ok")).rows[0].ok).toBe(false);
  });
});
