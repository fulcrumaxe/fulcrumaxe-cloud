import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#597 CC-1 (migration 0780): the corrections table, its three definers, tenant isolation and the audit rows. */
describe('work_item_corrections (D#597 CC-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;
  let itemA: string;
  let itemB: string;

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  async function newItem(refs: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`, [
      id,
      refs.accountId,
      refs.repoId,
    ]);
    return id;
  }

  const create = (accountId: string, userId: string, item: string, kind = 'run_note', body = 'use the staging key', origin = 'person') =>
    withTenant(appPool, accountId, userId, async (c) => (await c.query<{ id: string }>(`SELECT work_item_correction_create($1::uuid,$2,$3,$4) AS id`, [item, origin, kind, body])).rows[0]!.id);
  const decide = (accountId: string, userId: string, id: string, to: string, via = 'workspace') =>
    withTenant(appPool, accountId, userId, async (c) => (await c.query<{ r: string }>(`SELECT work_item_correction_decide($1::uuid,$2,$3) AS r`, [id, to, via])).rows[0]!.r);
  const markApplied = (accountId: string, id: string, runId: string | null, userId?: string) =>
    (userId === undefined
      ? withTenant(appPool, accountId, async (c) => (await c.query<{ r: string }>(`SELECT work_item_correction_mark_applied($1::uuid,$2::uuid) AS r`, [id, runId])).rows[0]!.r)
      : withTenant(appPool, accountId, userId, async (c) => (await c.query<{ r: string }>(`SELECT work_item_correction_mark_applied($1::uuid,$2::uuid) AS r`, [id, runId])).rows[0]!.r));
  const row = async (id: string) => (await admin.query(`SELECT * FROM work_item_corrections WHERE id = $1`, [id])).rows[0];
  const audit = async (id: string) =>
    (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE payload->>'correction_id' = $1 ORDER BY created_at, id`, [id])).rows;
  const runFor = async (refs: SeedRefs, item: string) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor','local','running')`, [id, refs.accountId, item]);
    return id;
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    itemA = await newItem(a);
    itemB = await newItem(b);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  describe('CC-1 acceptance 1: cross-account isolation', () => {
    it("a user in account B reads 0 of account A's corrections and cannot write them", async () => {
      const id = await create(a.accountId, aMember, itemA);
      const seenByB = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT id FROM work_item_corrections WHERE id = $1`, [id]));
      expect(seenByB.rowCount).toBe(0);
      const listedByB = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT id FROM work_item_corrections`));
      expect(listedByB.rows.map((r) => r.id)).not.toContain(id);
      // Direct writes are refused outright for app_user, whatever the tenant.
      await expect(withTenant(appPool, b.accountId, b.userId, (c) => c.query(`UPDATE work_item_corrections SET status = 'accepted' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(appPool, b.accountId, b.userId, (c) => c.query(`DELETE FROM work_item_corrections WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appPool, a.accountId, a.userId, (c) =>
          c.query(`INSERT INTO work_item_corrections (account_id, work_item_id, origin, kind, body, content_hash) VALUES ($1,$2,'person','pause','x','x')`, [a.accountId, itemA]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // The functions refuse too: B's session cannot decide A's row (it is not visible), nor attach one to A's item.
      await expect(decide(b.accountId, b.userId, id, 'accepted')).rejects.toMatchObject({ code: 'P0002' });
      await expect(create(b.accountId, b.userId, itemA)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      expect((await row(id)).status).toBe('proposed');
      expect(await audit(id)).toHaveLength(1);
    });

    it('a session with no tenant, a non-member, and a platform_ops login are refused and write nothing', async () => {
      const before = (await admin.query(`SELECT count(*)::int AS n FROM work_item_corrections`)).rows[0].n;
      await expect(adminPool.query(`SELECT work_item_correction_create($1::uuid,'person','pause','x')`, [itemA])).rejects.toBeTruthy();
      await expect(create(a.accountId, randomUUID(), itemA)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(opsPool, a.accountId, aAdmin, (c) => c.query(`SELECT work_item_correction_create($1::uuid,'person','pause','x')`, [itemA])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await admin.query(`SELECT count(*)::int AS n FROM work_item_corrections`)).rows[0].n).toBe(before);
    });

    it('platform_ops holds nothing on the table: a read or a write from that login is refused', async () => {
      const id = await create(a.accountId, aMember, itemA);
      await expect(withTenant(opsPool, a.accountId, (c) => c.query(`SELECT id FROM work_item_corrections WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(opsPool, a.accountId, (c) => c.query(`UPDATE work_item_corrections SET status = 'accepted' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await row(id)).status).toBe('proposed');
    });
  });

  describe('CC-1 acceptance 2: the CHECKs', () => {
    const insert = (over: Record<string, unknown>) => {
      const v = { origin: 'person', kind: 'run_note', body: 'ok', status: 'proposed', via: null, ...over };
      return admin.query(
        `INSERT INTO work_item_corrections (account_id, work_item_id, origin, kind, body, status, decided_via, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7, encode(sha256(convert_to($5::text,'UTF8')),'hex'))`,
        [a.accountId, itemA, v.origin, v.kind, v.body, v.status, v.via],
      );
    };
    it('a body of 4,000 characters is kept and 4,001 is refused, by the table and by the function', async () => {
      await expect(insert({ body: 'x'.repeat(4000) })).resolves.toBeTruthy();
      await expect(insert({ body: 'x'.repeat(4001) })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      // Characters, not bytes: 4000 four-byte characters fit.
      await expect(insert({ body: '\u{1F600}'.repeat(4000) })).resolves.toBeTruthy();
      await expect(create(a.accountId, aMember, itemA, 'run_note', 'y'.repeat(4001))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
    it('every kind and status value outside its enum is refused', async () => {
      await expect(insert({ kind: 'approve' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ origin: 'system' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ status: 'done', via: 'workspace' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ status: 'accepted', via: 'carrier_pigeon' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(create(a.accountId, aMember, itemA, 'halt')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(create(a.accountId, aMember, itemA, 'pause', 'x', 'bot')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
    it('every valid kind is accepted', async () => {
      for (const kind of ['question', 'run_note', 'spec_amend', 'new_item', 'pause', 'priority']) {
        await expect(create(a.accountId, aMember, itemA, kind)).resolves.toMatch(/^[0-9a-f-]{36}$/);
      }
    });
    it('a decision stamp exists exactly when the status left proposed, and the hash must match the body', async () => {
      await expect(insert({ status: 'accepted', via: null })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ status: 'proposed', via: 'workspace' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(
        admin.query(`INSERT INTO work_item_corrections (account_id, work_item_id, origin, kind, body, content_hash) VALUES ($1,$2,'person','pause','x','not-the-hash')`, [a.accountId, itemA]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
    it('the stored hash is the SHA-256 of the stored body', async () => {
      const id = await create(a.accountId, aMember, itemA, 'spec_amend', 'add a note');
      const r = await row(id);
      expect(r.content_hash).toBe((await admin.query(`SELECT encode(sha256(convert_to($1::text,'UTF8')),'hex') AS h`, ['add a note'])).rows[0].h);
    });
  });

  describe('CC-1 acceptance 3: one audit row per status change', () => {
    it('writes exactly one row per change, with origin and decided_via as fixed fields, and never the text', async () => {
      const id = await create(a.accountId, aMember, itemA, 'run_note', 'SECRET-TEXT-DO-NOT-LOG', 'agent');
      expect(await decide(a.accountId, aAdmin, id, 'accepted', 'terminal')).toBe('decided');
      const run = await runFor(a, itemA);
      expect(await markApplied(a.accountId, id, run)).toBe('applied');
      const rows = await audit(id);
      expect(rows.map((r) => r.action)).toEqual(['work_item.correction_proposed', 'work_item.correction_accepted', 'work_item.correction_applied']);
      expect(rows.map((r) => [r.payload.from_status, r.payload.to_status])).toEqual([[null, 'proposed'], ['proposed', 'accepted'], ['accepted', 'applied']]);
      expect(rows.every((r) => r.payload.origin === 'agent')).toBe(true);
      expect(rows.map((r) => r.payload.decided_via)).toEqual([null, 'terminal', 'terminal']);
      expect(rows[2]!.payload.applied_run_id).toBe(run);
      expect(rows.map((r) => r.actor)).toEqual([aMember, aAdmin, 'system:driver']);
      for (const r of rows) {
        expect(Object.keys(r.payload).sort()).toEqual(['applied_run_id', 'correction_id', 'decided_via', 'from_status', 'kind', 'origin', 'to_status', 'work_item_id']);
        expect(JSON.stringify(r.payload)).not.toContain('SECRET-TEXT');
      }
    });
    it('reject and supersede each write one row, and a refused call writes none', async () => {
      const r1 = await create(a.accountId, aMember, itemA);
      expect(await decide(a.accountId, a.userId, r1, 'rejected')).toBe('decided');
      const r2 = await create(a.accountId, aMember, itemA);
      expect(await decide(a.accountId, a.userId, r2, 'superseded', 'terminal')).toBe('decided');
      expect((await audit(r1)).map((r) => r.action)).toEqual(['work_item.correction_proposed', 'work_item.correction_rejected']);
      expect((await audit(r2)).map((r) => r.action)).toEqual(['work_item.correction_proposed', 'work_item.correction_superseded']);
      await expect(decide(a.accountId, aMember, r1, 'accepted')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await audit(r1)).toHaveLength(2);
    });
    it("a member's own proposal is audited under the member and the row carries the member as created_by", async () => {
      const id = await create(a.accountId, aMember, itemA);
      expect((await row(id)).created_by).toBe(aMember);
      expect((await audit(id))[0]!.actor).toBe(aMember);
    });
  });

  describe('CC-1 acceptance 4: an accepted correction cannot be accepted again', () => {
    it('the second call changes 0 rows, writes no audit row and answers already_decided', async () => {
      const id = await create(a.accountId, aMember, itemA);
      expect(await decide(a.accountId, aAdmin, id, 'accepted')).toBe('decided');
      const first = await row(id);
      expect(await decide(a.accountId, a.userId, id, 'accepted', 'terminal')).toBe('already_decided');
      const second = await row(id);
      expect(second.decided_by).toBe(aAdmin);
      expect(second.decided_via).toBe('workspace');
      expect(second.updated_at).toEqual(first.updated_at);
      expect(await audit(id)).toHaveLength(2);
    });
    it('two accepts racing leave exactly one decision', async () => {
      const id = await create(a.accountId, aMember, itemA);
      const results = await Promise.all([decide(a.accountId, aAdmin, id, 'accepted'), decide(a.accountId, a.userId, id, 'accepted', 'terminal')]);
      expect(results.sort()).toEqual(['already_decided', 'decided']);
      expect((await audit(id)).filter((r) => r.action === 'work_item.correction_accepted')).toHaveLength(1);
    });
  });

  describe('states and the undo path', () => {
    it('rejecting an accepted correction before it is applied is allowed; after applied every decision is already_decided', async () => {
      const undone = await create(a.accountId, aMember, itemA);
      await decide(a.accountId, aAdmin, undone, 'accepted');
      expect(await decide(a.accountId, aAdmin, undone, 'rejected')).toBe('decided');
      expect((await row(undone)).status).toBe('rejected');
      expect(await markApplied(a.accountId, undone, await runFor(a, itemA))).toBe('not_accepted');

      const used = await create(a.accountId, aMember, itemA);
      await decide(a.accountId, aAdmin, used, 'accepted');
      const run = await runFor(a, itemA);
      expect(await markApplied(a.accountId, used, run)).toBe('applied');
      for (const to of ['accepted', 'rejected', 'superseded']) expect(await decide(a.accountId, aAdmin, used, to)).toBe('already_decided');
      const final = await row(used);
      expect(final.status).toBe('applied');
      expect(final.applied_run_id).toBe(run);
      expect(final.applied_at).not.toBeNull();
      // Applying twice changes nothing.
      expect(await markApplied(a.accountId, used, run)).toBe('not_accepted');
      expect(await audit(used)).toHaveLength(3);
    });
    it('a final correction (rejected, superseded) cannot be accepted', async () => {
      for (const to of ['rejected', 'superseded']) {
        const id = await create(a.accountId, aMember, itemA);
        await decide(a.accountId, aAdmin, id, to);
        expect(await decide(a.accountId, aAdmin, id, 'accepted')).toBe('already_decided');
        expect((await row(id)).status).toBe(to);
      }
    });
    it('a proposed correction cannot be applied', async () => {
      const id = await create(a.accountId, aMember, itemA);
      expect(await markApplied(a.accountId, id, await runFor(a, itemA))).toBe('not_accepted');
      expect((await row(id)).status).toBe('proposed');
    });
    it('a run note is applied only by a run of its own item; other kinds name no run', async () => {
      const note = await create(a.accountId, aMember, itemA, 'run_note');
      await decide(a.accountId, aAdmin, note, 'accepted');
      const otherItem = await newItem(a);
      await expect(markApplied(a.accountId, note, await runFor(a, otherItem))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(markApplied(a.accountId, note, null)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(markApplied(a.accountId, note, await runFor(b, itemB))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect((await row(note)).status).toBe('accepted');
      const pause = await create(a.accountId, aMember, itemA, 'pause');
      await decide(a.accountId, aAdmin, pause, 'accepted');
      await expect(markApplied(a.accountId, pause, await runFor(a, itemA))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await markApplied(a.accountId, pause, null)).toBe('applied');
    });
    it("another account's session cannot apply a correction", async () => {
      const id = await create(a.accountId, aMember, itemA);
      await decide(a.accountId, aAdmin, id, 'accepted');
      await expect(markApplied(b.accountId, id, null)).rejects.toMatchObject({ code: 'P0002' });
      expect((await row(id)).status).toBe('accepted');
    });
    it('a plain member, a non-member and a removed member cannot mark a correction applied, and the row stays accepted; an owner, an admin and the userless driver can', async () => {
      const note = await create(a.accountId, aMember, itemA, 'run_note');
      await decide(a.accountId, aAdmin, note, 'accepted');
      const run = await runFor(a, itemA);
      const removed = await addMember(a.accountId, 'admin');
      await admin.query(`DELETE FROM account_members WHERE user_id = $1`, [removed]);
      const audits = (await audit(note)).length;
      for (const who of [aMember, randomUUID(), removed, b.userId]) {
        await expect(markApplied(a.accountId, note, run, who)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      const r = await row(note);
      expect(r.status).toBe('accepted');
      expect(r.applied_run_id).toBeNull();
      expect((await audit(note)).length).toBe(audits);
      expect(await markApplied(a.accountId, note, run, aAdmin)).toBe('applied');
      for (const who of [a.userId, undefined]) {
        const n2 = await create(a.accountId, aMember, itemA, 'run_note');
        await decide(a.accountId, aAdmin, n2, 'accepted');
        expect(await markApplied(a.accountId, n2, await runFor(a, itemA), who)).toBe('applied');
      }
    });
    it('a run note is applied only by a run created at or after it was accepted', async () => {
      const early = await runFor(a, itemA);
      const note = await create(a.accountId, aMember, itemA, 'run_note');
      await decide(a.accountId, aAdmin, note, 'accepted');
      await expect(markApplied(a.accountId, note, early)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect((await row(note)).status).toBe('accepted');
      expect(await markApplied(a.accountId, note, await runFor(a, itemA))).toBe('applied');
    });
    it("'auto' and unknown decision values are refused and nothing changes", async () => {
      const id = await create(a.accountId, aMember, itemA);
      await expect(decide(a.accountId, aAdmin, id, 'accepted', 'auto')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(decide(a.accountId, aAdmin, id, 'applied')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(decide(a.accountId, aAdmin, id, 'proposed')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect((await row(id)).status).toBe('proposed');
    });
    it('a deleted user leaves the correction with a null created_by and the audit intact', async () => {
      const gone = await addMember(a.accountId, 'member');
      const id = await create(a.accountId, gone, itemA);
      await admin.query(`DELETE FROM account_members WHERE user_id = $1`, [gone]);
      await admin.query(`DELETE FROM users WHERE id = $1`, [gone]);
      expect((await row(id)).created_by).toBeNull();
      expect(await audit(id)).toHaveLength(1);
    });
    it('deleting the work item removes its corrections', async () => {
      const item = await newItem(a);
      const id = await create(a.accountId, aMember, item);
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [item]);
      expect(await row(id)).toBeUndefined();
    });
  });

  describe('grants', () => {
    const ROLE = 'work_item_correction_definer';
    it('the role is NOLOGIN and unprivileged, has no member, is a member of nothing, and owns exactly the three functions', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole ORDER BY 1`, [ROLE]);
      expect(owned.rows.map((r) => r.sig)).toEqual([
        'work_item_correction_create(uuid,text,text,text)',
        'work_item_correction_decide(uuid,text,text)',
        'work_item_correction_mark_applied(uuid,uuid)',
      ]);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });
    it('app_user reads and cannot write; platform_ops holds nothing; the definer reads no more than it needs; PUBLIC executes nothing', async () => {
      const q = async (sql: string) => (await admin.query<{ can: boolean }>(sql)).rows[0]!.can;
      expect(await q(`SELECT has_table_privilege('app_user','public.work_item_corrections','INSERT, UPDATE, DELETE, TRUNCATE') AS can`)).toBe(false);
      expect(await q(`SELECT has_any_column_privilege('app_user','public.work_item_corrections','INSERT, UPDATE') AS can`)).toBe(false);
      expect(await q(`SELECT has_column_privilege('app_user','public.work_item_corrections','body','SELECT') AS can`)).toBe(true);
      expect(await q(`SELECT has_any_column_privilege('platform_ops','public.work_item_corrections','SELECT, INSERT, UPDATE, REFERENCES') AS can`)).toBe(false);
      expect(await q(`SELECT has_table_privilege('platform_ops','public.work_item_corrections','SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') AS can`)).toBe(false);
      expect(await q(`SELECT has_any_column_privilege('partner_user','public.work_item_corrections','SELECT, INSERT, UPDATE') AS can`)).toBe(false);
      expect(await q(`SELECT has_any_column_privilege('agent_run_writer','public.work_item_corrections','SELECT, INSERT, UPDATE') AS can`)).toBe(false);
      // The definer never updates the text, the hash, the author or the item, and never reads the text back.
      for (const col of ['body', 'content_hash', 'origin', 'kind', 'account_id', 'work_item_id', 'created_by', 'created_at']) {
        expect(await q(`SELECT has_column_privilege('${ROLE}','public.work_item_corrections','${col}','UPDATE') AS can`), `UPDATE ${col}`).toBe(false);
      }
      expect(await q(`SELECT has_column_privilege('${ROLE}','public.work_item_corrections','body','SELECT') AS can`)).toBe(false);
      // The two reads the run-boundary rule needs: when the correction was accepted, and when the run was created.
      expect(await q(`SELECT has_column_privilege('${ROLE}','public.work_item_corrections','decided_at','SELECT') AS can`)).toBe(true);
      expect(await q(`SELECT has_column_privilege('${ROLE}','public.agent_runs','created_at','SELECT') AS can`)).toBe(true);
      expect(await q(`SELECT has_any_column_privilege('${ROLE}','public.agent_runs','INSERT, UPDATE') AS can`)).toBe(false);
      expect(await q(`SELECT has_table_privilege('${ROLE}','public.work_item_corrections','DELETE, TRUNCATE') AS can`)).toBe(false);
      const { rows } = await admin.query(
        `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
                COALESCE((SELECT bool_or(x.is_grantable) FROM aclexplode(p.proacl) x), false) AS grantable
           FROM pg_proc p WHERE p.proname LIKE 'work\_item\_correction\_%' ORDER BY 1`,
      );
      expect(rows.map((r) => r.proname)).toEqual(['work_item_correction_create', 'work_item_correction_decide', 'work_item_correction_mark_applied']);
      for (const r of rows) {
        expect(r).toMatchObject({ prosecdef: true, owner: ROLE, app: true, ops: false, pub: false, grantable: false });
        expect(r.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      }
    });
    it('the table is row-secured and forced, with a tenant read for app_user and one policy per write command for the definer', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.work_item_corrections'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const { rows } = await admin.query<{ roles: string[]; cmd: string }>(`SELECT roles::text[] AS roles, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_item_corrections'`);
      expect(rows.map((r) => `${r.cmd} ${r.roles.join(',')}`).sort()).toEqual(['INSERT ' + ROLE, 'SELECT ' + ROLE, 'SELECT app_user', 'UPDATE ' + ROLE].sort());
    });
    it('the role may write audit_log only for the five correction actions', async () => {
      const { rows } = await admin.query<{ with_check: string }>(`SELECT with_check FROM pg_policies WHERE tablename = 'audit_log' AND roles = ARRAY[$1]::name[]`, [ROLE]);
      expect(rows).toHaveLength(1);
      for (const s of ['proposed', 'accepted', 'rejected', 'superseded', 'applied']) expect(rows[0]!.with_check).toContain(`work_item.correction_${s}`);
    });
  });
});
