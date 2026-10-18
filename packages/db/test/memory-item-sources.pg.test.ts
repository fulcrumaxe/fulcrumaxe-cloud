import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { withTenant } from '../src/withTenant.js';
import { writeReceipt } from '../src/receiptWriter.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0880_memory_item_sources.sql';
const HASH = 'a'.repeat(64);
const INVOKER_LOGIN = 'fx_receipt_invoker_mem8a_test';
// A receipt's text. The promoted entry must hold none of it.
const CHOSEN = 'zq_unmistakable_choice';
const REJECTED = 'zq_unmistakable_alternative';
const DECISION_TYPE = 'test_strategy_choice';

/** D#601 MEM-8a (migration 0880): the record of item sources, the receipt promote path and the correction step. Real Postgres, row security forced. */
describe('MEM-8a: run_context_item_sources, memory_promote_receipt and applied -> superseded', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let receiptPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;
  let bAdmin: string;

  async function addMember(accountId: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  const newRun = async (refs: SeedRefs, itemId: string = refs.workItemId): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor','local','running')`, [id, refs.accountId, itemId]);
    return id;
  };
  const newItem = async (refs: SeedRefs): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`, [id, refs.accountId, refs.repoId]);
    return id;
  };
  const asTenant = <T>(accountId: string, userId: string | null, fn: (c: PoolClient) => Promise<T>, pool: Pool = appPool): Promise<T> =>
    userId === null ? withTenant(pool, accountId, fn) : withTenant(pool, accountId, userId, fn);
  const call = <T>(accountId: string, userId: string | null, sql: string, params: unknown[]): Promise<T> =>
    asTenant(accountId, userId, async (c) => (await c.query<{ r: T }>(`SELECT ${sql} AS r`, params)).rows[0]!.r);

  /** A source row written the way the build step does: in the account's own session. */
  const recordSource = (accountId: string, runId: string, kind = 'correction', sourceId: string = randomUUID(), hash = HASH, cut = false, rowAccount: string = accountId) =>
    asTenant(accountId, null, (c) =>
      c.query(`INSERT INTO run_context_item_sources (account_id, run_id, source_kind, source_id, content_sha256, cut) VALUES ($1,$2,$3,$4,$5,$6)`, [rowAccount, runId, kind, sourceId, hash, cut]),
    );
  const sourcesOf = async (runId: string) => (await admin.query(`SELECT * FROM run_context_item_sources WHERE run_id = $1`, [runId])).rows;

  /** A receipt made by the real writer, so its shape is the real one. */
  async function makeReceipt(refs: SeedRefs, userId: string): Promise<string> {
    const r = await asTenant(
      refs.accountId,
      userId,
      (c) =>
        writeReceipt(c, {
          class: 'human_over_the_loop',
          runId: refs.runId,
          workItemId: refs.workItemId,
          decisionType: DECISION_TYPE,
          chosen: CHOSEN,
          rejectedAlternative: REJECTED,
          dialVersion: 4,
          quotedInputs: [{ trust: 'trusted', storedBody: 'plain' }],
        }),
      receiptPool,
    );
    if (r.store !== 'decision_receipts') throw new Error('expected the durable store');
    return r.id;
  }
  const promote = (accountId: string, userId: string | null, receiptId: string, accountArg: string = accountId) =>
    call<string>(accountId, userId, `memory_promote_receipt($1::uuid,$2::uuid)`, [accountArg, receiptId]);
  const receiptHash = async (id: string) => (await admin.query<{ h: string }>(`SELECT md5(d::text) AS h FROM decision_receipts d WHERE id = $1`, [id])).rows[0]!.h;
  const entryOf = async (id: string) => (await admin.query(`SELECT * FROM memory_entries WHERE id = $1`, [id])).rows[0];
  const promoteAudit = async (receiptId: string) =>
    (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE action = 'memory.receipt_promoted' AND payload->>'receipt_id' = $1`, [receiptId])).rows;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    bAdmin = await addMember(b.accountId, 'admin');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), receiptPool.end()]);
  });

  describe('acceptance 1: run_context_item_sources', () => {
    it("an account-B session reads none of account A's rows, and an insert for a run of another account is refused", async () => {
      const run = await newRun(a);
      await recordSource(a.accountId, run);
      expect(await sourcesOf(run)).toHaveLength(1);
      const seenByB = await asTenant(b.accountId, bAdmin, (c) => c.query(`SELECT * FROM run_context_item_sources WHERE run_id = $1`, [run]));
      expect(seenByB.rows).toEqual([]);
      const seenByA = await asTenant(a.accountId, aMember, (c) => c.query(`SELECT * FROM run_context_item_sources WHERE run_id = $1`, [run]));
      expect(seenByA.rows).toHaveLength(1);
      // B writing a row that names A's account: row security refuses. B writing its own account with A's run: the composite key refuses.
      await expect(recordSource(b.accountId, run, 'correction', randomUUID(), HASH, false, a.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(recordSource(b.accountId, run)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      expect(await sourcesOf(run)).toHaveLength(1);
    });
    it('a seventh row for one run is refused, and the six that were stored stay', async () => {
      const run = await newRun(a);
      for (let i = 0; i < 6; i++) await recordSource(a.accountId, run, i === 5 ? 'handoff' : 'correction');
      await expect(recordSource(a.accountId, run)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await sourcesOf(run)).toHaveLength(6);
      // Another run has its own six.
      await recordSource(a.accountId, await newRun(a));
    });
    it('two concurrent inserts at five rows let exactly one through', async () => {
      const run = await newRun(a);
      for (let i = 0; i < 5; i++) await recordSource(a.accountId, run);
      const results = await Promise.allSettled([recordSource(a.accountId, run), recordSource(a.accountId, run)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await sourcesOf(run)).toHaveLength(6);
    });
    it('an unknown source_kind and a non-hex or wrong-length hash are refused; the same source twice is refused', async () => {
      const run = await newRun(a);
      await expect(recordSource(a.accountId, run, 'memory')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      for (const bad of ['g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '']) {
        await expect(recordSource(a.accountId, run, 'correction', randomUUID(), bad), bad).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      const id = randomUUID();
      await recordSource(a.accountId, run, 'handoff', id, HASH, true);
      await expect(recordSource(a.accountId, run, 'handoff', id)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      // The same id as a correction is a different source.
      await recordSource(a.accountId, run, 'correction', id);
      expect((await sourcesOf(run)).map((r) => [r.source_kind, r.cut]).sort()).toEqual([['correction', false], ['handoff', true]]);
    });
    it('the table has no text column: ids, one hash, a flag and a time, checked against information_schema', async () => {
      const { rows } = await admin.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'run_context_item_sources' ORDER BY column_name`,
      );
      expect(rows.map((r) => [r.column_name, r.data_type])).toEqual([
        ['account_id', 'uuid'],
        ['content_sha256', 'text'],
        ['cut', 'boolean'],
        ['recorded_at', 'timestamp with time zone'],
        ['run_id', 'uuid'],
        ['source_id', 'uuid'],
        ['source_kind', 'text'],
      ]);
      // The only text columns are the kind (a CHECKed pair) and the hash (a CHECKed 64-hex string): neither can carry a body.
      const checks = (await admin.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'run_context_item_sources'::regclass AND contype = 'c'`)).rows.map((r) => r.def).join(' ');
      expect(checks).toContain('source_kind');
      expect(checks).toContain('[0-9a-f]{64}');
    });
    it('nothing updates or deletes a row; the row goes with its run; platform_ops and the other logins hold nothing', async () => {
      const run = await newRun(a);
      await recordSource(a.accountId, run);
      await expect(asTenant(a.accountId, null, (c) => c.query(`UPDATE run_context_item_sources SET cut = true WHERE run_id = $1`, [run]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asTenant(a.accountId, null, (c) => c.query(`DELETE FROM run_context_item_sources WHERE run_id = $1`, [run]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      for (const who of ['platform_ops', 'partner_user', 'agent_run_writer']) {
        const { rows } = await admin.query(`SELECT has_any_column_privilege($1, 'public.run_context_item_sources', 'SELECT, INSERT, UPDATE, REFERENCES') AS can`, [who]);
        expect(rows[0].can, who).toBe(false);
      }
      await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [run]);
      expect(await sourcesOf(run)).toEqual([]);
    });
  });

  describe('acceptance 2: memory_promote_receipt', () => {
    it('a member gets insufficient_privilege and no row is written', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      await expect(promote(a.accountId, aMember, receipt)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE provenance->>'receipt_id' = $1`, [receipt])).rowCount).toBe(0);
      expect(await promoteAudit(receipt)).toEqual([]);
      // A session with no user is not a member either.
      await expect(promote(a.accountId, null, receipt)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('an admin gets an approved account entry that holds the fixed label and the reference, and no text of the receipt', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const before = await receiptHash(receipt);
      const id = await promote(a.accountId, aAdmin, receipt);
      const e = await entryOf(id);
      expect(e).toMatchObject({
        account_id: a.accountId,
        scope: 'account',
        scope_ref: null,
        kind: 'decision',
        author_kind: 'person',
        status: 'approved',
        version: 1,
        provenance: { receipt_id: receipt },
        approved_by: aAdmin,
        body: `Decision ${DECISION_TYPE} (receipt ${receipt.slice(0, 8)})`,
        why: null,
      });
      const full = (await admin.query<{ chosen: string; rejected_alternative: string }>(`SELECT chosen, rejected_alternative FROM decision_receipts WHERE id = $1`, [receipt])).rows[0]!;
      expect(full.chosen).toBe(CHOSEN);
      expect(e.body).not.toContain(CHOSEN);
      expect(e.body).not.toContain(REJECTED);
      expect(e.body).not.toContain(full.chosen);
      expect(e.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await receiptHash(receipt)).toBe(before);
    });
    it("a receipt of another account is no_data_found, and an account argument that is not the session's is refused", async () => {
      const bReceipt = await makeReceipt(b, bAdmin);
      await expect(promote(a.accountId, aAdmin, bReceipt)).rejects.toMatchObject({ code: 'P0002' });
      await expect(promote(a.accountId, aAdmin, randomUUID())).rejects.toMatchObject({ code: 'P0002' });
      await expect(promote(a.accountId, aAdmin, bReceipt, b.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(promote(b.accountId, bAdmin, bReceipt, a.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE provenance->>'receipt_id' = $1`, [bReceipt])).rowCount).toBe(0);
      // B's own admin can promote B's receipt, and the entry is B's.
      const id = await promote(b.accountId, bAdmin, bReceipt);
      expect((await entryOf(id)).account_id).toBe(b.accountId);
      // A's session cannot read it.
      const seen = await asTenant(a.accountId, aAdmin, (c) => c.query(`SELECT 1 FROM memory_entries WHERE id = $1`, [id]));
      expect(seen.rowCount).toBe(0);
    });
    it('a second promote of the same receipt gives already_promoted; exactly one audit row exists, with fixed keys and no text', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const id = await promote(a.accountId, aAdmin, receipt);
      await expect(promote(a.accountId, aAdmin, receipt)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE, message: expect.stringMatching(/^already_promoted:/) });
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE provenance->>'receipt_id' = $1`, [receipt])).rowCount).toBe(1);
      const rows = await promoteAudit(receipt);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: aAdmin, action: 'memory.receipt_promoted' });
      expect(Object.keys(rows[0]!.payload).sort()).toEqual(['author_kind', 'entry_id', 'from_status', 'kind', 'receipt_id', 'scope', 'to_status', 'version']);
      expect(rows[0]!.payload.entry_id).toBe(id);
      expect(JSON.stringify(rows[0])).not.toContain(CHOSEN);
      expect(JSON.stringify(rows[0])).not.toContain(REJECTED);
    });
    it('two concurrent promotes of one receipt: one wins, one is refused, one row exists', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const results = await Promise.allSettled([promote(a.accountId, aAdmin, receipt), promote(a.accountId, aAdmin, receipt)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE provenance->>'receipt_id' = $1 AND status = 'approved'`, [receipt])).rowCount).toBe(1);
    });
    it('the unique index is the arbiter behind the check: another live entry naming the receipt, seeded as the database owner, is a unique violation', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      await promote(a.accountId, aAdmin, receipt);
      const label = `Decision ${DECISION_TYPE} (receipt ${receipt.slice(0, 8)})`;
      await expect(
        admin.query(
          `INSERT INTO memory_entries (account_id, scope, kind, body, author_kind, status, provenance, content_sha256)
           VALUES ($1, 'account', 'decision', $2, 'person', 'rejected', $3::jsonb, encode(sha256(convert_to($2::text, 'UTF8')), 'hex'))`,
          [a.accountId, label, JSON.stringify({ receipt_id: receipt })],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });
    it("receipt_id is the promote path's key alone: propose and write refuse it, so a member cannot block a promote", async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const item = await newItem(a);
      const prov = JSON.stringify({ receipt_id: receipt });
      const invalid = { code: PG_ERROR.INVALID_PARAMETER_VALUE, message: expect.stringMatching(/^invalid_message:/) };
      await expect(call(a.accountId, aMember, `memory_propose('item', $1, 'fact', 'member text', NULL, 'person', $2::jsonb)`, [item, prov])).rejects.toMatchObject(invalid);
      await expect(call(a.accountId, aAdmin, `memory_write('account', NULL, 'decision', 'again', NULL, $1::jsonb)`, [prov])).rejects.toMatchObject(invalid);
      await expect(call(a.accountId, null, `memory_propose('item', $1, 'fact', 'agent text', NULL, 'agent', $2::jsonb)`, [item, prov])).rejects.toMatchObject(invalid);
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE provenance->>'receipt_id' = $1`, [receipt])).rowCount).toBe(0);
      // The promote still works afterwards.
      await promote(a.accountId, aAdmin, receipt);
    });
    it('a promoted entry cannot be edited (fails closed), whatever the new body, kind or scope; it can still be retired, deleted and promoted again', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const id = await promote(a.accountId, aAdmin, receipt);
      const invalid = { code: PG_ERROR.INVALID_PARAMETER_VALUE, message: expect.stringMatching(/^invalid_message:/) };
      await expect(call(a.accountId, aAdmin, `memory_edit($1::uuid,'PASTED FREE TEXT',NULL,'fact',NULL,NULL)`, [id])).rejects.toMatchObject(invalid);
      await expect(call(a.accountId, aAdmin, `memory_edit($1::uuid,'PASTED FREE TEXT',NULL,NULL,NULL,NULL)`, [id])).rejects.toMatchObject(invalid);
      await expect(call(a.accountId, aAdmin, `memory_edit($1::uuid,'PASTED FREE TEXT',NULL,'fact','item',$2)`, [id, await newItem(a)])).rejects.toMatchObject(invalid);
      expect(await entryOf(id)).toMatchObject({ status: 'approved', version: 1, body: `Decision ${DECISION_TYPE} (receipt ${receipt.slice(0, 8)})` });
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE supersedes_id = $1`, [id])).rowCount).toBe(0);
      expect(await call<string>(a.accountId, aAdmin, `memory_decide($1::uuid,'retired')`, [id])).toBe('decided');
      expect(await call<string>(a.accountId, aAdmin, `memory_delete($1::uuid, false)`, [id])).toBe('deleted');
      await promote(a.accountId, aAdmin, receipt);
    });
    it('the table CHECK ties receipt_id to the fixed-label decision / account / person shape, even for the database owner', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const label = `Decision ${DECISION_TYPE} (receipt ${receipt.slice(0, 8)})`;
      const insert = (over: Record<string, string>) => {
        const v = { scope: 'account', kind: 'decision', author: 'person', body: label, ...over };
        return admin.query(
          `INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, status, provenance, content_sha256)
           VALUES ($1, $2, CASE WHEN $2 = 'role' THEN 'builder' END, $3, $4, $5, 'approved', $6::jsonb, encode(sha256(convert_to($4::text, 'UTF8')), 'hex'))`,
          [a.accountId, v.scope, v.kind, v.body, v.author, JSON.stringify({ receipt_id: receipt })],
        );
      };
      await expect(insert({ body: 'PASTED FREE TEXT' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ kind: 'fact' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ scope: 'role' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ author: 'agent' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ body: `${label} and more` })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await insert({});
    });
    it('undo path: deleting the entry leaves the receipt untouched (row hash equal), promoting again is allowed, and a restore then meets the live one', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const before = await receiptHash(receipt);
      const first = await promote(a.accountId, aAdmin, receipt);
      expect(await call<string>(a.accountId, aAdmin, `memory_delete($1::uuid, false)`, [first])).toBe('deleted');
      expect(await receiptHash(receipt)).toBe(before);
      const second = await promote(a.accountId, aAdmin, receipt);
      expect(second).not.toBe(first);
      await expect(call(a.accountId, aAdmin, `memory_delete($1::uuid, true)`, [first])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      expect((await entryOf(first)).status).toBe('deleted');
      // Retiring the live one keeps the reference taken; deleting it frees it.
      expect(await call<string>(a.accountId, aAdmin, `memory_decide($1::uuid,'retired')`, [second])).toBe('decided');
      await expect(promote(a.accountId, aAdmin, receipt)).rejects.toMatchObject({ message: expect.stringMatching(/^already_promoted:/) });
      expect(await call<string>(a.accountId, aAdmin, `memory_delete($1::uuid, false)`, [second])).toBe('deleted');
      await promote(a.accountId, aAdmin, receipt);
      expect(await receiptHash(receipt)).toBe(before);
    });
    it('a receipt that is gone is no_data_found, and a stored entry for it is not touched by the receipt going', async () => {
      const receipt = await makeReceipt(a, aAdmin);
      const id = await promote(a.accountId, aAdmin, receipt);
      await admin.query(`DELETE FROM decision_receipts WHERE id = $1`, [receipt]);
      expect((await entryOf(id)).status).toBe('approved');
      await expect(promote(a.accountId, aAdmin, receipt)).rejects.toMatchObject({ code: 'P0002' });
    });
    it('the entry cap still applies: the 101st approved account entry is refused', async () => {
      const c = await seedAccount(admin, randomUUID());
      const cAdmin = await addMember(c.accountId, 'admin');
      const receipt = await makeReceipt(c, cAdmin);
      await admin.query(
        `INSERT INTO memory_entries (account_id, scope, kind, body, author_kind, status, content_sha256)
         SELECT $1, 'account', 'fact', 'filler ' || g, 'person', 'approved', encode(sha256(convert_to('filler ' || g, 'UTF8')), 'hex') FROM generate_series(1, 100) g`,
        [c.accountId],
      );
      await expect(promote(c.accountId, cAdmin, receipt)).rejects.toMatchObject({ code: '54000' });
    });
  });

  describe('acceptance 3: work_item_correction_decide, applied -> superseded', () => {
    const create = (accountId: string, userId: string, item: string, body = 'use the staging key') =>
      call<string>(accountId, userId, `work_item_correction_create($1::uuid,'person','run_note',$2)`, [item, body]);
    const decide = (accountId: string, userId: string, id: string, to: string) => call<string>(accountId, userId, `work_item_correction_decide($1::uuid,$2,'workspace')`, [id, to]);
    const row = async (id: string) => (await admin.query(`SELECT * FROM work_item_corrections WHERE id = $1`, [id])).rows[0];
    const audit = async (id: string) => (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE payload->>'correction_id' = $1 ORDER BY created_at, id`, [id])).rows;
    /** A note a run applied. */
    async function appliedNote(): Promise<{ id: string; run: string }> {
      const item = await newItem(a);
      const id = await create(a.accountId, aMember, item);
      await decide(a.accountId, aAdmin, id, 'accepted');
      const run = await newRun(a, item);
      expect(await call<string>(a.accountId, null, `work_item_correction_mark_applied($1::uuid,$2::uuid)`, [id, run])).toBe('applied');
      return { id, run };
    }

    it('an admin supersedes an applied note: the applied stamps are unchanged and one audit row names from_status applied', async () => {
      const { id, run } = await appliedNote();
      const before = await row(id);
      expect(await decide(a.accountId, aAdmin, id, 'superseded')).toBe('decided');
      const after = await row(id);
      expect(after).toMatchObject({ status: 'superseded', applied_run_id: run, body: before.body, content_hash: before.content_hash });
      expect(after.applied_at).toEqual(before.applied_at);
      const sup = (await audit(id)).filter((r) => r.action === 'work_item.correction_superseded');
      expect(sup).toHaveLength(1);
      expect(sup[0]!.payload).toMatchObject({ from_status: 'applied', to_status: 'superseded', applied_run_id: run, correction_id: id });
      expect(Object.keys(sup[0]!.payload).sort()).toEqual(['applied_run_id', 'correction_id', 'decided_via', 'from_status', 'kind', 'origin', 'to_status', 'work_item_id']);
      expect(JSON.stringify(sup[0])).not.toContain('staging key');
      // The earlier audit rows stay: proposed, accepted, applied, superseded.
      expect((await audit(id)).map((r) => r.action)).toEqual(['work_item.correction_proposed', 'work_item.correction_accepted', 'work_item.correction_applied', 'work_item.correction_superseded']);
    });
    it('a member is refused and the note stays applied; a second call answers already_decided and writes nothing', async () => {
      const { id } = await appliedNote();
      await expect(decide(a.accountId, aMember, id, 'superseded')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await row(id)).status).toBe('applied');
      expect(await decide(a.accountId, aAdmin, id, 'superseded')).toBe('decided');
      expect(await decide(a.accountId, aAdmin, id, 'superseded')).toBe('already_decided');
      expect((await audit(id)).filter((r) => r.action === 'work_item.correction_superseded')).toHaveLength(1);
    });
    it("an admin of another account cannot supersede it (no_data_found)", async () => {
      const { id } = await appliedNote();
      await expect(decide(b.accountId, bAdmin, id, 'superseded')).rejects.toMatchObject({ code: 'P0002' });
      expect((await row(id)).status).toBe('applied');
    });
    it('applied to accepted, rejected or proposed stays refused and changes nothing', async () => {
      const { id, run } = await appliedNote();
      const before = await row(id);
      expect(await decide(a.accountId, aAdmin, id, 'accepted')).toBe('already_decided');
      expect(await decide(a.accountId, aAdmin, id, 'rejected')).toBe('already_decided');
      await expect(decide(a.accountId, aAdmin, id, 'proposed')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(decide(a.accountId, aAdmin, id, 'applied')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await row(id)).toEqual(before);
      expect(before.applied_run_id).toBe(run);
      expect((await audit(id))).toHaveLength(3);
    });
    it('a superseded note stays superseded: it cannot be accepted or applied again', async () => {
      const { id, run } = await appliedNote();
      await decide(a.accountId, aAdmin, id, 'superseded');
      expect(await decide(a.accountId, aAdmin, id, 'accepted')).toBe('already_decided');
      expect(await decide(a.accountId, aAdmin, id, 'rejected')).toBe('already_decided');
      expect(await call<string>(a.accountId, null, `work_item_correction_mark_applied($1::uuid,$2::uuid)`, [id, run])).toBe('not_accepted');
      expect((await row(id)).status).toBe('superseded');
    });
    it('the body and content_hash are unwritable by every role, and the hash CHECK still ties them', async () => {
      const { id } = await appliedNote();
      for (const role of ['app_user', 'platform_ops', 'partner_user', 'agent_run_writer', 'work_item_correction_definer', 'memory_definer']) {
        for (const col of ['body', 'content_hash']) {
          const { rows } = await admin.query(`SELECT has_column_privilege($1, 'public.work_item_corrections', $2, 'UPDATE') AS can`, [role, col]);
          expect(rows[0].can, `${role}.${col}`).toBe(false);
        }
      }
      await expect(admin.query(`UPDATE work_item_corrections SET body = 'changed' WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(asTenant(a.accountId, aAdmin, (c) => c.query(`UPDATE work_item_corrections SET body = 'changed' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('the applied-shape CHECK allows the stamps on applied and superseded rows only', async () => {
      const item = await newItem(a);
      const id = await create(a.accountId, aMember, item);
      await expect(admin.query(`UPDATE work_item_corrections SET applied_at = now() WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await decide(a.accountId, aAdmin, id, 'accepted');
      await expect(admin.query(`UPDATE work_item_corrections SET applied_at = now() WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await decide(a.accountId, aAdmin, id, 'rejected');
      await expect(admin.query(`UPDATE work_item_corrections SET applied_run_id = $2 WHERE id = $1`, [id, await newRun(a, item)])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('acceptance 4: grants', () => {
    const q = async (sql: string, params: unknown[] = []) => (await admin.query<{ can: boolean }>(sql, params)).rows[0]!.can;
    it('memory_promote_receipt is a definer owned by memory_definer, pinned, with EXECUTE for app_user alone', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
                COALESCE((SELECT bool_or(x.is_grantable) FROM aclexplode(p.proacl) x), false) AS grantable
           FROM pg_proc p WHERE p.proname = 'memory_promote_receipt'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ prosecdef: true, owner: 'memory_definer', proconfig: ['search_path=pg_catalog, public, pg_temp'], app: true, ops: false, pub: false, grantable: false });
    });
    it("memory_definer's new reach is a read of three columns of decision_receipts: no write, no delete, no other column", async () => {
      for (const col of ['id', 'account_id', 'decision_type']) expect(await q(`SELECT has_column_privilege('memory_definer','public.decision_receipts',$1,'SELECT') AS can`, [col]), col).toBe(true);
      for (const col of ['chosen', 'rejected_alternative', 'actor']) expect(await q(`SELECT has_column_privilege('memory_definer','public.decision_receipts',$1,'SELECT') AS can`, [col]), col).toBe(false);
      expect(await q(`SELECT has_any_column_privilege('memory_definer','public.decision_receipts','INSERT, UPDATE, REFERENCES') AS can`)).toBe(false);
      expect(await q(`SELECT has_table_privilege('memory_definer','public.decision_receipts','DELETE, TRUNCATE, TRIGGER') AS can`)).toBe(false);
      for (const col of ['body', 'content_sha256', 'author_kind', 'scope', 'scope_ref']) expect(await q(`SELECT has_column_privilege('memory_definer','public.memory_entries',$1,'UPDATE') AS can`, [col]), col).toBe(false);
    });
    it('the two definers are not left with a member, and keep no CREATE on public', async () => {
      for (const role of ['memory_definer', 'work_item_correction_definer']) {
        expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [role])).rowCount, role).toBe(0);
        expect(await q(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS can`, [role]), role).toBe(false);
      }
    });
    it("work_item_correction_decide keeps its owner, its pin and its ACL (app_user alone)", async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub
           FROM pg_proc p WHERE p.proname = 'work_item_correction_decide'`,
      );
      expect(rows[0]).toMatchObject({ prosecdef: true, owner: 'work_item_correction_definer', proconfig: ['search_path=pg_catalog, public, pg_temp'], ops: false, pub: false });
    });
  });
});

/** C21 section 11: platform_ops gains nothing. Migrate a throwaway cluster to everything before 0880, snapshot, apply 0880, snapshot again. */
describe('migration 0880 gives platform_ops nothing', () => {
  let pg: EphemeralPostgres;
  let pool: Pool;
  let guard: PoolTeardownGuard | undefined;
  let beforeDir: string;
  let before: Snapshot;
  let after: Snapshot;

  interface Snapshot {
    tableGrants: string[];
    columnGrants: string[];
    policies: string[];
    ownedFunctions: string[];
    memberships: string[];
  }
  const TABLES = `('memory_entries', 'run_context_item_sources', 'work_item_corrections', 'decision_receipts', 'run_context_inputs', 'account_members', 'accounts', 'audit_log', 'users')`;

  async function snapshot(): Promise<Snapshot> {
    const q = async (sql: string) => (await pool.query<{ x: string }>(sql)).rows.map((r) => r.x);
    return {
      tableGrants: await q(`
        SELECT c.relname || ' ' || p.privilege_type AS x FROM pg_class c
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ${TABLES} AND has_table_privilege('platform_ops', c.oid, p.privilege_type)
         ORDER BY 1`),
      columnGrants: await q(`
        SELECT c.relname || '.' || a.attname || ' ' || p.privilege_type AS x FROM pg_class c
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ${TABLES} AND has_column_privilege('platform_ops', c.oid, a.attnum, p.privilege_type)
         ORDER BY 1`),
      policies: await q(`
        SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS x FROM pg_policies
         WHERE schemaname = 'public' AND tablename IN ${TABLES} AND 'platform_ops' = ANY(roles) ORDER BY 1`),
      ownedFunctions: await q(`SELECT p.oid::regprocedure::text AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole ORDER BY 1`),
      memberships: await q(`SELECT pg_get_userbyid(roleid) || ' ' || admin_option::text || ' ' || coalesce(inherit_option::text, '') || ' ' || coalesce(set_option::text, '') AS x FROM pg_auth_members WHERE member = 'platform_ops'::regrole ORDER BY 1`),
    };
  }
  const sqlWithoutComments = () =>
    readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0880_ops_diff_test', tmpPrefix: 'fx-0880-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0880Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0880-diff-migrations-'));
    // Every migration numbered after this one is left out too: it was written against a database that has this file.
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name < MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(beforeDir, MIGRATION));
    await runMigrations(pool, beforeDir);
    after = await snapshot();
  }, 180_000);

  afterAll(async () => {
    try {
      guard?.assertNoCheckedOutClients();
      await guard?.endAndWaitForSockets();
    } finally {
      pg?.cleanup();
      if (beforeDir) rmSync(beforeDir, { recursive: true, force: true });
    }
  });

  it('the snapshot is not empty, so an empty difference means something', () => {
    expect(before.tableGrants.length).toBeGreaterThan(0);
    expect(before.columnGrants.length).toBeGreaterThan(5);
    expect(before.ownedFunctions.length).toBeGreaterThan(5);
  });

  it('platform_ops holds exactly what it held: table grants, column grants, row policies, owned functions and role memberships', () => {
    expect(after.tableGrants).toEqual(before.tableGrants);
    expect(after.columnGrants).toEqual(before.columnGrants);
    expect(after.policies).toEqual(before.policies);
    expect(after.ownedFunctions).toEqual(before.ownedFunctions);
    expect(after.memberships).toEqual(before.memberships);
  });

  it('migration 0880 never names platform_ops in a GRANT, REVOKE or OWNER TO statement', () => {
    const mentions = sqlWithoutComments()
      .split(';')
      .map((statement) => statement.trim().replace(/\s+/g, ' '))
      .filter((statement) => /\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement) && /\bplatform_ops\b/i.test(statement));
    expect(mentions).toEqual([]);
  });

  it('the migration drops only the one CHECK it widens and the one policy it replaces, and makes nothing NOT NULL', () => {
    const sql = sqlWithoutComments();
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX)\b/i);
    expect(sql).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
    expect([...sql.matchAll(/\bDROP\s+CONSTRAINT\s+(\w+)/gi)].map((m) => m[1])).toEqual(['work_item_corrections_applied_shape']);
    expect([...sql.matchAll(/\bDROP\s+POLICY\s+(\w+)\s+ON\s+(\w+)/gi)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['memory_definer_audit audit_log']);
  });
});
