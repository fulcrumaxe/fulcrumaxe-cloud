import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0835_memory_entry_opens.sql';
const ROLE = 'memory_definer';
const REPO_REF = 'R_kgDOOpens1@515151';
const NEW_POINTS = ['memory_mark_opened', 'memory_decide_batch'];

/** D#601 MEM-4a1 (migration 0835): "opened once before batching", enforced by the database. Real Postgres, row security forced. */
describe('memory_entry_opens, memory_mark_opened and memory_decide_batch (D#601 MEM-4a1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aAdmin2: string;
  let aMember: string;
  let bAdmin: string;
  let n = 0;

  async function addMember(accountId: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  const call = <T>(accountId: string, userId: string | null, sql: string, params: unknown[]): Promise<T> => {
    const run = async (c: PoolClient) => (await c.query<{ r: T }>(`SELECT ${sql} AS r`, params)).rows[0]!.r;
    return userId === null ? withTenant(appPool, accountId, run) : withTenant(appPool, accountId, userId, run);
  };
  /** A proposal of the given kind, written the way the pipeline does it (no user), so an import or agent body can exist. */
  const propose = (accountId: string, over: Partial<{ scope: string; ref: string | null; author: string; prov: object; body: string }> = {}) => {
    const v = { scope: 'repo', ref: REPO_REF, author: 'import', prov: { source_path: 'CLAUDE.md' }, body: `opens fact ${++n} ${randomUUID()}`, ...over };
    return call<string>(accountId, null, `memory_propose($1,$2,'fact',$3,NULL,$4,$5::jsonb)`, [v.scope, v.ref, v.body, v.author, JSON.stringify(v.prov)]);
  };
  const open = (accountId: string, userId: string | null, id: string) => call<boolean>(accountId, userId, `memory_mark_opened($1::uuid)`, [id]);
  const batch = (accountId: string, userId: string | null, ids: string[], to = 'approved') => call<number>(accountId, userId, `memory_decide_batch($1::uuid[],$2)`, [ids, to]);
  const edit = (accountId: string, userId: string, id: string, body: string) => call<string>(accountId, userId, `memory_edit($1::uuid,$2,NULL,NULL,NULL,NULL)`, [id, body]);
  const statuses = async (ids: string[]) => (await admin.query<{ id: string; status: string }>(`SELECT id, status FROM memory_entries WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
  const statusOf = async (ids: string[]) => [...new Set((await statuses(ids)).map((r) => r.status))];
  const newItem = async (accountId: string): Promise<string> =>
    (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, provenance) VALUES ($1, 'internal') RETURNING id`, [accountId])).rows[0]!.id;
  const opens = async (entryId: string) => (await admin.query(`SELECT * FROM memory_entry_opens WHERE entry_id = $1`, [entryId])).rows;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aAdmin2 = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    bAdmin = await addMember(b.accountId, 'admin');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  describe('section 2 acceptance 1 and 2: an unopened card stops a batch, an edit clears the open', () => {
    it('refuses a batch of 3 imports when 1 was never opened (must_open_first, naming the count) and changes nothing', async () => {
      const ids = [await propose(a.accountId), await propose(a.accountId), await propose(a.accountId)];
      await open(a.accountId, aAdmin, ids[0]!);
      await open(a.accountId, aAdmin, ids[1]!);
      const before = (await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1`, [a.accountId])).rows[0].n;
      await expect(batch(a.accountId, aAdmin, ids)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE, message: expect.stringMatching(/^must_open_first: 1 of 3 cards have not been opened/) });
      expect(await statusOf(ids)).toEqual(['proposed']);
      expect((await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1`, [a.accountId])).rows[0].n).toBe(before);
      expect(await statusOf(ids)).toEqual(['proposed']);
    });
    it('after memory_mark_opened on all 3 the same batch succeeds, with one audit row each', async () => {
      const ids = [await propose(a.accountId), await propose(a.accountId), await propose(a.accountId)];
      for (const id of ids) expect(await open(a.accountId, aAdmin, id)).toBe(true);
      expect(await batch(a.accountId, aAdmin, ids)).toBe(3);
      expect(await statusOf(ids)).toEqual(['approved']);
      for (const id of ids) {
        const audit = await admin.query(`SELECT action FROM audit_log WHERE payload->>'entry_id' = $1 ORDER BY created_at, id`, [id]);
        expect(audit.rows.map((r) => r.action)).toEqual(['memory.proposed', 'memory.approved']);
      }
    });
    it('an edit makes a new version that is refused until it is opened, and the old open does not carry over', async () => {
      const ids = [await propose(a.accountId), await propose(a.accountId), await propose(a.accountId)];
      for (const id of ids) await open(a.accountId, aAdmin, id);
      const v2 = await edit(a.accountId, aAdmin, ids[0]!, 'the edited text of the first import');
      const next = [v2, ids[1]!, ids[2]!];
      await expect(batch(a.accountId, aAdmin, next)).rejects.toMatchObject({ message: expect.stringMatching(/^must_open_first: 1 of 3/) });
      expect(await statusOf(next)).toEqual(['proposed']);
      expect(await open(a.accountId, aAdmin, v2)).toBe(true);
      expect(await batch(a.accountId, aAdmin, next)).toBe(3);
      expect(await statusOf(next)).toEqual(['approved']);
    });
    it('the open is keyed to the content hash: a record that holds another hash does not count', async () => {
      const ids = [await propose(a.accountId), await propose(a.accountId)];
      for (const id of ids) await open(a.accountId, aAdmin, id);
      await admin.query(`UPDATE memory_entry_opens SET content_sha256 = repeat('0', 64) WHERE entry_id = $1`, [ids[1]]);
      await expect(batch(a.accountId, aAdmin, ids)).rejects.toMatchObject({ message: expect.stringMatching(/^must_open_first: 1 of 2/) });
      // Opening it again records the entry's real hash.
      expect(await open(a.accountId, aAdmin, ids[1]!)).toBe(true);
      expect(await batch(a.accountId, aAdmin, ids)).toBe(2);
    });
    it('runner-sourced proposals are gated the same way', async () => {
      const ids = [await propose(a.accountId, { author: 'runner_agent', prov: {} }), await propose(a.accountId, { author: 'runner_agent', prov: {} })];
      await expect(batch(a.accountId, aAdmin, ids)).rejects.toMatchObject({ message: expect.stringMatching(/^must_open_first: 2 of 2/) });
      for (const id of ids) await open(a.accountId, aAdmin, id);
      expect(await batch(a.accountId, aAdmin, ids, 'rejected')).toBe(2);
      expect(await statusOf(ids)).toEqual(['rejected']);
    });
  });

  describe('section 2 acceptance 3 and 4: agent batches, the cap, mixed sources', () => {
    it('a batch of agent-origin proposals needs no open record', async () => {
      const ids = [await propose(a.accountId, { author: 'agent', prov: {} }), await propose(a.accountId, { author: 'agent', prov: {} })];
      expect(await batch(a.accountId, aAdmin, ids)).toBe(2);
      expect(await statusOf(ids)).toEqual(['approved']);
    });
    it('refuses a batch of 21 ids, an empty one, one with a repeated id and a decision a batch does not make', async () => {
      const ids = await Promise.all(Array.from({ length: 21 }, () => propose(a.accountId, { author: 'agent', prov: {} })));
      await expect(batch(a.accountId, aAdmin, ids)).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_message: a batch holds at most 20/) });
      expect(await statusOf(ids)).toEqual(['proposed']);
      expect(await batch(a.accountId, aAdmin, ids.slice(0, 20))).toBe(20);
      const one = await propose(a.accountId, { author: 'agent', prov: {} });
      await expect(batch(a.accountId, aAdmin, [])).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_message/) });
      await expect(batch(a.accountId, aAdmin, [one, one])).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_message/) });
      await expect(batch(a.accountId, aAdmin, [one], 'retired')).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_message/) });
      expect(await statusOf([one])).toEqual(['proposed']);
    });
    it('refuses a batch that mixes import and agent, two kinds of origin, or two files, with mixed_sources, before any open is checked', async () => {
      const imp = await propose(a.accountId);
      const agent = await propose(a.accountId, { author: 'agent', prov: {} });
      const runner = await propose(a.accountId, { author: 'runner_agent', prov: {} });
      const other = await propose(a.accountId, { prov: { source_path: 'AGENTS.md' } });
      for (const ids of [[imp, agent], [imp, runner], [agent, runner], [imp, other]]) {
        await expect(batch(a.accountId, aAdmin, ids)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE, message: expect.stringMatching(/^mixed_sources:/) });
      }
      expect(await statusOf([imp, agent, runner, other])).toEqual(['proposed']);
    });
    it('is all or nothing: a full scope in the middle rolls the whole batch back', async () => {
      const item = await newItem(a.accountId);
      for (let i = 0; i < 29; i += 1) await call<string>(a.accountId, aAdmin, `memory_write('item',$1,'fact',$2,NULL,'{}'::jsonb)`, [item, `item fact ${i} ${randomUUID()}`]);
      const ids = [await propose(a.accountId, { scope: 'item', ref: item, author: 'agent', prov: {} }), await propose(a.accountId, { scope: 'item', ref: item, author: 'agent', prov: {} })];
      await expect(batch(a.accountId, aMember, ids)).rejects.toMatchObject({ code: '54000' });
      expect(await statusOf(ids)).toEqual(['proposed']);
      expect((await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE payload->>'entry_id' = ANY($1::text[]) AND action = 'memory.approved'`, [ids])).rows[0].n).toBe(0);
    });
  });

  describe('section 2 acceptance 5 and 6: rights and tenants', () => {
    it('a member without rights on a repo entry gets insufficient_privilege from both definers, and nothing changes', async () => {
      const id = await propose(a.accountId);
      await expect(open(a.accountId, aMember, id)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(batch(a.accountId, aMember, [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await statusOf([id])).toEqual(['proposed']);
      expect(await opens(id)).toHaveLength(0);
    });
    it('a member may open and batch ITEM entries, as with memory_decide', async () => {
      const ids = [await propose(a.accountId, { scope: 'item', ref: a.workItemId }), await propose(a.accountId, { scope: 'item', ref: a.workItemId })];
      for (const id of ids) expect(await open(a.accountId, aMember, id)).toBe(true);
      expect(await batch(a.accountId, aMember, ids)).toBe(2);
    });
    it("another account's id is no_data_found from both definers, and a batch that names one changes nothing", async () => {
      const mine = await propose(a.accountId, { author: 'agent', prov: {} });
      const theirs = await propose(b.accountId, { author: 'agent', prov: {} });
      await expect(open(b.accountId, bAdmin, mine)).rejects.toMatchObject({ code: 'P0002' });
      await expect(batch(b.accountId, bAdmin, [mine])).rejects.toMatchObject({ code: 'P0002' });
      await expect(batch(a.accountId, aAdmin, [mine, theirs])).rejects.toMatchObject({ code: 'P0002' });
      expect(await statusOf([mine, theirs])).toEqual(['proposed']);
    });
    it("user A's open record does not satisfy user B's batch", async () => {
      const ids = [await propose(a.accountId), await propose(a.accountId)];
      for (const id of ids) await open(a.accountId, aAdmin, id);
      await expect(batch(a.accountId, aAdmin2, ids)).rejects.toMatchObject({ message: expect.stringMatching(/^must_open_first: 2 of 2/) });
      for (const id of ids) await open(a.accountId, aAdmin2, id);
      expect(await batch(a.accountId, aAdmin2, ids)).toBe(2);
      expect((await opens(ids[0]!)).map((r) => r.user_id).sort()).toEqual([aAdmin, aAdmin2].sort());
    });
    it('a session with no user, and a platform_ops login, are refused by both definers', async () => {
      const id = await propose(a.accountId);
      await expect(open(a.accountId, null, id)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(batch(a.accountId, null, [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        await expect(withTenant(ops, a.accountId, aAdmin, (c) => c.query(`SELECT memory_mark_opened($1::uuid)`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(ops, a.accountId, aAdmin, (c) => c.query(`SELECT memory_decide_batch($1::uuid[], 'approved')`, [[id]]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        await ops.end();
      }
    });
  });

  describe('memory_mark_opened', () => {
    it('records a proposed import once per person and version, and a second call changes nothing but the time', async () => {
      const id = await propose(a.accountId);
      expect(await open(a.accountId, aAdmin, id)).toBe(true);
      const first = (await opens(id))[0];
      expect(first).toMatchObject({ account_id: a.accountId, entry_id: id, user_id: aAdmin });
      expect(first.content_sha256).toBe((await admin.query(`SELECT content_sha256 FROM memory_entries WHERE id = $1`, [id])).rows[0].content_sha256);
      expect(await open(a.accountId, aAdmin, id)).toBe(true);
      expect(await opens(id)).toHaveLength(1);
    });
    it('does nothing, and answers false, for an entry that is not a proposed import or runner proposal', async () => {
      const agent = await propose(a.accountId, { author: 'agent', prov: {} });
      const person = await call<string>(a.accountId, aAdmin, `memory_propose('repo',$1,'fact',$2,NULL,'person','{}'::jsonb)`, [REPO_REF, `a person proposal ${randomUUID()}`]);
      const approved = await propose(a.accountId);
      await open(a.accountId, aAdmin, approved);
      await batch(a.accountId, aAdmin, [approved]);
      const rejected = await propose(a.accountId);
      await call<string>(a.accountId, aAdmin, `memory_decide($1::uuid,'rejected')`, [rejected]);
      for (const id of [agent, person, rejected]) {
        expect(await open(a.accountId, aAdmin, id)).toBe(false);
        expect(await opens(id)).toHaveLength(0);
      }
      // The approved one keeps the record it already had; a call after the decision adds no row.
      expect(await open(a.accountId, aAdmin, approved)).toBe(false);
      expect(await opens(approved)).toHaveLength(1);
    });
    it('writes no audit row and changes no entry', async () => {
      const id = await propose(a.accountId);
      const before = await admin.query(`SELECT * FROM memory_entries WHERE id = $1`, [id]);
      const auditBefore = (await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1`, [a.accountId])).rows[0].n;
      await open(a.accountId, aAdmin, id);
      expect((await admin.query(`SELECT * FROM memory_entries WHERE id = $1`, [id])).rows[0]).toEqual(before.rows[0]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1`, [a.accountId])).rows[0].n).toBe(auditBefore);
    });
    it('the record goes with the entry', async () => {
      const id = await propose(a.accountId);
      await open(a.accountId, aAdmin, id);
      expect(await opens(id)).toHaveLength(1);
      await admin.query(`DELETE FROM memory_entries WHERE id = $1`, [id]);
      expect(await opens(id)).toHaveLength(0);
    });
  });

  describe('the table', () => {
    it('app_user reads only its own rows and cannot write; another account reads none', async () => {
      const id = await propose(a.accountId);
      await open(a.accountId, aAdmin, id);
      const mine = await withTenant(appPool, a.accountId, aAdmin, (c) => c.query(`SELECT user_id FROM memory_entry_opens WHERE entry_id = $1`, [id]));
      expect(mine.rows.map((r) => r.user_id)).toEqual([aAdmin]);
      const colleague = await withTenant(appPool, a.accountId, aAdmin2, (c) => c.query(`SELECT user_id FROM memory_entry_opens WHERE entry_id = $1`, [id]));
      expect(colleague.rowCount).toBe(0);
      const other = await withTenant(appPool, b.accountId, bAdmin, (c) => c.query(`SELECT user_id FROM memory_entry_opens WHERE entry_id = $1`, [id]));
      expect(other.rowCount).toBe(0);
      for (const sql of [
        `INSERT INTO memory_entry_opens (account_id, entry_id, user_id, content_sha256) VALUES ('${a.accountId}', '${id}', '${aAdmin2}', repeat('a', 64))`,
        `UPDATE memory_entry_opens SET opened_at = now()`,
        `DELETE FROM memory_entry_opens`,
      ]) {
        await expect(withTenant(appPool, a.accountId, aAdmin, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
    it('is row-secured and forced, with a read policy for app_user and three for the definer', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.memory_entry_opens'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const { rows } = await admin.query<{ roles: string[]; cmd: string }>(`SELECT roles::text[] AS roles, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'memory_entry_opens'`);
      expect(rows.map((r) => `${r.cmd} ${r.roles.join(',')}`).sort()).toEqual(['INSERT memory_definer', 'SELECT app_user', 'SELECT memory_definer', 'UPDATE memory_definer']);
    });
  });

  describe('memory_edit: the loser of an edit race gets conflict', () => {
    it('editing a version that already has a successor ends in unique_violation (23505), which the core layer maps to conflict', async () => {
      const id = await propose(a.accountId, { author: 'agent', prov: {} });
      await edit(a.accountId, aAdmin, id, 'the winner of the race');
      await expect(edit(a.accountId, aAdmin2, id, 'the loser of the race')).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      expect((await admin.query(`SELECT count(*)::int AS n FROM memory_entries WHERE supersedes_id = $1`, [id])).rows[0].n).toBe(1);
    });
  });

  describe('grants', () => {
    const q = async (sql: string) => (await admin.query<{ can: boolean }>(sql)).rows[0]!.can;
    it('the two new functions are definers owned by memory_definer, pinned, with EXECUTE for app_user alone', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
                COALESCE((SELECT bool_or(x.is_grantable) FROM aclexplode(p.proacl) x), false) AS grantable
           FROM pg_proc p WHERE p.proname = ANY($1::text[]) ORDER BY 1`,
        [NEW_POINTS],
      );
      expect(rows.map((r) => r.proname)).toEqual([...NEW_POINTS].sort());
      for (const r of rows) {
        expect(r).toMatchObject({ prosecdef: true, owner: ROLE, proconfig: ['search_path=pg_catalog, public, pg_temp'], app: true, ops: false, pub: false, grantable: false });
      }
    });
    it('the definer gains column privileges on the new table only: no delete, and no re-pointing of a row', async () => {
      expect(await q(`SELECT has_table_privilege('${ROLE}','public.memory_entry_opens','DELETE, TRUNCATE, TRIGGER') AS can`)).toBe(false);
      for (const col of ['account_id', 'entry_id', 'user_id']) expect(await q(`SELECT has_column_privilege('${ROLE}','public.memory_entry_opens','${col}','UPDATE') AS can`), col).toBe(false);
      for (const col of ['content_sha256', 'opened_at']) expect(await q(`SELECT has_column_privilege('${ROLE}','public.memory_entry_opens','${col}','UPDATE') AS can`), col).toBe(true);
      for (const who of ['platform_ops', 'partner_user', 'agent_run_writer']) {
        expect(await q(`SELECT has_any_column_privilege('${who}','public.memory_entry_opens','SELECT, INSERT, UPDATE, REFERENCES') AS can`), who).toBe(false);
      }
      // memory_entries itself gains nothing: the text, the hash and the author stay unwritable after insert.
      for (const col of ['body', 'content_sha256', 'author_kind', 'scope', 'scope_ref']) expect(await q(`SELECT has_column_privilege('${ROLE}','public.memory_entries','${col}','UPDATE') AS can`), col).toBe(false);
    });
    it('the migration role is not left a member of memory_definer, and the role keeps no CREATE on public', async () => {
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
      expect(await q(`SELECT has_schema_privilege('${ROLE}', 'public', 'CREATE') AS can`)).toBe(false);
    });
  });
});

/**
 * C21 section 11 for this file too: platform_ops gains nothing. This migrates a throwaway cluster to everything BEFORE 0835, snapshots what
 * platform_ops holds, applies 0835 on the same database and snapshots again. All of it must be unchanged.
 */
describe('migration 0835 gives platform_ops nothing', () => {
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
  const TABLES = `('memory_entries', 'memory_entry_opens', 'work_items', 'account_members', 'accounts', 'audit_log', 'users')`;

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

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0835_ops_diff_test', tmpPrefix: 'fx-0835-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0835Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0835-diff-migrations-'));
    // Every migration numbered after this one is left out too: it was written against a database that has this file.
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name < MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies 0835 and anything after it
    after = await snapshot();
  }, 120_000);

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

  it('migration 0835 never names platform_ops in a GRANT, REVOKE or OWNER TO statement', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const mentions = sql
      .split(';')
      .map((statement) => statement.trim().replace(/\s+/g, ' '))
      .filter((statement) => /\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement) && /\bplatform_ops\b/i.test(statement));
    expect(mentions).toEqual([]);
  });

  it('the migration only adds: it drops nothing and makes nothing NOT NULL (expand phase)', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
  });
});
