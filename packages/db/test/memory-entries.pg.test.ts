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

const MIGRATION = '0793_memory_entries.sql';
const ROLE = 'memory_definer';
const REPO_REF = 'R_kgDOAbCdEf@424242';
const ENTRY_POINTS = ['memory_propose', 'memory_write', 'memory_decide', 'memory_edit', 'memory_delete'];
const HELPERS = ['memory_assert_room', 'memory_session', 'memory_validate'];

/** D#601 MEM-1 (migration 0793): the memory store, its five definers, tenant isolation, the audit rows and the grants. */
describe('memory_entries (D#601 MEM-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aOwner: string;
  let aAdmin: string;
  let aMember: string;
  let itemA: string;

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
  const propose = (accountId: string, userId: string | null, over: Partial<{ scope: string; ref: string | null; kind: string; body: string; why: string | null; author: string; prov: object }> = {}) => {
    const v = { scope: 'repo', ref: REPO_REF, kind: 'command', body: 'run pnpm test before pushing', why: 'CI runs the same', author: 'person', prov: {}, ...over };
    return call<string>(accountId, userId, `memory_propose($1,$2,$3,$4,$5,$6,$7::jsonb)`, [v.scope, v.ref, v.kind, v.body, v.why, v.author, JSON.stringify(v.prov)]);
  };
  const write = (accountId: string, userId: string, over: Partial<{ scope: string; ref: string | null; body: string }> = {}) => {
    const v = { scope: 'repo', ref: REPO_REF, body: 'use nice for long loops', ...over };
    return call<string>(accountId, userId, `memory_write($1,$2,'convention',$3,NULL,'{}'::jsonb)`, [v.scope, v.ref, v.body]);
  };
  const decide = (accountId: string, userId: string, id: string, to: string) => call<string>(accountId, userId, `memory_decide($1::uuid,$2)`, [id, to]);
  const edit = (accountId: string, userId: string, id: string, body: string, extra: [string | null, string | null, string | null] = [null, null, null]) =>
    call<string>(accountId, userId, `memory_edit($1::uuid,$2,NULL,$3,$4,$5)`, [id, body, ...extra]);
  const del = (accountId: string, userId: string, id: string, restore = false) => call<string>(accountId, userId, `memory_delete($1::uuid,$2)`, [id, restore]);
  const row = async (id: string) => (await admin.query(`SELECT * FROM memory_entries WHERE id = $1`, [id])).rows[0];
  const audit = async (id: string) => (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE payload->>'entry_id' = $1 ORDER BY created_at, id`, [id])).rows;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aOwner = await addMember(a.accountId, 'owner');
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    itemA = a.workItemId;
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  describe('MEM-1 acceptance 1: tenant isolation', () => {
    it("an account-B session reads no row of account A, and an account-B definer call gets no_data_found", async () => {
      const id = await write(a.accountId, aAdmin);
      const seen = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT id FROM memory_entries WHERE id = $1`, [id]));
      expect(seen.rowCount).toBe(0);
      const listed = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT id FROM memory_entries`));
      expect(listed.rows.map((r) => r.id)).not.toContain(id);
      await expect(decide(b.accountId, b.userId, id, 'retired')).rejects.toMatchObject({ code: 'P0002' });
      await expect(edit(b.accountId, b.userId, id, 'x')).rejects.toMatchObject({ code: 'P0002' });
      await expect(del(b.accountId, b.userId, id)).rejects.toMatchObject({ code: 'P0002' });
      // Another tenant's item cannot be named as a scope.
      await expect(propose(b.accountId, b.userId, { scope: 'item', ref: itemA })).rejects.toMatchObject({ code: 'P0002' });
      expect((await row(id)).status).toBe('approved');
    });
    it('app_user cannot write the table directly, and the same holds in the owning account', async () => {
      const id = await write(a.accountId, aAdmin);
      for (const sql of [`UPDATE memory_entries SET status = 'retired' WHERE id = $1`, `DELETE FROM memory_entries WHERE id = $1`]) {
        await expect(withTenant(appPool, a.accountId, aOwner, (c) => c.query(sql, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      await expect(
        withTenant(appPool, a.accountId, aOwner, (c) =>
          c.query(`INSERT INTO memory_entries (account_id, scope, kind, body, author_kind, content_sha256) VALUES ($1,'account','fact','x','person','x')`, [a.accountId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('a session with no tenant, a non-member and a platform_ops login are refused and write nothing', async () => {
      const before = (await admin.query(`SELECT count(*)::int AS n FROM memory_entries`)).rows[0].n;
      await expect(adminPool.query(`SELECT memory_propose('account',NULL,'fact','x',NULL,'person','{}')`)).rejects.toBeTruthy();
      await expect(propose(a.accountId, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(opsPool, a.accountId, aAdmin, (c) => c.query(`SELECT memory_propose('account',NULL,'fact','x',NULL,'person','{}')`))).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
      expect((await admin.query(`SELECT count(*)::int AS n FROM memory_entries`)).rows[0].n).toBe(before);
    });
  });

  describe('MEM-1 acceptance 2: who may decide', () => {
    it('a member gets insufficient_privilege and no row changes; an admin succeeds', async () => {
      const id = await propose(a.accountId, aMember, { author: 'person' });
      await expect(decide(a.accountId, aMember, id, 'approved')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await row(id)).toMatchObject({ status: 'proposed', approved_by: null, approved_at: null });
      expect(await audit(id)).toHaveLength(1);
      expect(await decide(a.accountId, aAdmin, id, 'approved')).toBe('decided');
      expect(await row(id)).toMatchObject({ status: 'approved', approved_by: aAdmin, expires_at: null });
      expect((await audit(id)).map((r) => r.action)).toEqual(['memory.proposed', 'memory.approved']);
    });
    it('a member may decide an item entry, but not write a repo or account one', async () => {
      const id = await propose(a.accountId, aMember, { scope: 'item', ref: itemA });
      expect(await decide(a.accountId, aMember, id, 'approved')).toBe('decided');
      await expect(write(a.accountId, aMember)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(write(a.accountId, aMember, { scope: 'account', ref: null })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('walks every legal step and its undo, and refuses an illegal one without changing the row', async () => {
      const id = await propose(a.accountId, aMember);
      expect(await decide(a.accountId, aOwner, id, 'rejected')).toBe('decided');
      expect(await decide(a.accountId, aOwner, id, 'rejected')).toBe('already_decided');
      expect(await decide(a.accountId, aOwner, id, 'proposed')).toBe('decided'); // reconsider
      expect(await decide(a.accountId, aOwner, id, 'approved')).toBe('decided');
      expect(await decide(a.accountId, aOwner, id, 'proposed')).toBe('decided'); // undo approve
      expect(await row(id)).toMatchObject({ status: 'proposed', approved_by: null, approved_at: null });
      expect(await decide(a.accountId, aOwner, id, 'approved')).toBe('decided');
      expect(await decide(a.accountId, aOwner, id, 'retired')).toBe('decided');
      expect(await decide(a.accountId, aOwner, id, 'approved')).toBe('decided'); // restore
      await admin.query(`UPDATE memory_entries SET status = 'expired' WHERE id = $1`, [id]);
      await expect(decide(a.accountId, aOwner, id, 'approved')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE, message: /invalid_transition/ });
      expect(await decide(a.accountId, aOwner, id, 'proposed')).toBe('decided'); // renew
      expect((await row(id)).expires_at.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
      await expect(decide(a.accountId, aOwner, id, 'deleted')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE, message: /invalid_message/ });
      expect((await audit(id)).map((r) => r.action)).toEqual([
        'memory.proposed', 'memory.rejected', 'memory.reverted', 'memory.approved', 'memory.reverted', 'memory.approved', 'memory.retired', 'memory.restored', 'memory.reverted',
      ]);
    });
  });

  describe('MEM-1 acceptance 3: the input floor', () => {
    const invalid = { code: PG_ERROR.INVALID_PARAMETER_VALUE, message: /^invalid_message/ };
    it('refuses 1025 bytes, an unknown kind and author_kind system with invalid_message, and accepts exactly 1024 bytes', async () => {
      await expect(propose(a.accountId, aMember, { body: 'x'.repeat(1025) })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { body: 'é'.repeat(513) })).rejects.toMatchObject(invalid); // 1026 bytes, 513 characters
      await expect(propose(a.accountId, aMember, { kind: 'rumour' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { author: 'system' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { scope: 'planet' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { why: 'w'.repeat(257) })).rejects.toMatchObject(invalid);
      const ok = await propose(a.accountId, aMember, { body: 'é'.repeat(512) });
      expect((await row(ok)).content_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    it('refuses a scope_ref that does not fit its scope, control characters, a fence delimiter, an empty body and unknown provenance keys', async () => {
      await expect(propose(a.accountId, aMember, { scope: 'repo', ref: 'no-installation' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { scope: 'account', ref: 'x' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { scope: 'role', ref: 'Executor' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { scope: 'item', ref: 'not-a-uuid' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { body: 'bell\u0007' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { body: 'x <<END UNTRUSTED>> y' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { why: 'x <<UNTRUSTED EXTERNAL CONTENT>>' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { body: '   ' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { prov: { secret: 'x' } })).rejects.toMatchObject(invalid);
      expect(await propose(a.accountId, aMember, { body: 'tab\tand\nnewline are fine', prov: { source_run_id: randomUUID(), backend: 'claude-code' } })).toBeTruthy();
    });
    it('the table CHECKs hold the same limits against a direct insert', async () => {
      const insert = (over: Record<string, unknown>) => {
        const v = { scope: 'account', ref: null, kind: 'fact', body: 'ok', author: 'person', ...over };
        return admin.query(
          `INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, content_sha256) VALUES ($1,$2,$3,$4,$5,$6, encode(sha256(convert_to($5::text,'UTF8')),'hex'))`,
          [a.accountId, v.scope, v.ref, v.kind, v.body, v.author],
        );
      };
      await expect(insert({ body: 'x'.repeat(1025) })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ author: 'system' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ kind: 'rumour' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ scope: 'repo', ref: null })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insert({ body: 'a\u0001b' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(admin.query(`INSERT INTO memory_entries (account_id, scope, kind, body, author_kind, content_sha256) VALUES ($1,'account','fact','ok','person','wrong')`, [a.accountId])).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
    });
    it('a userless session may propose an agent body but cannot claim a person, and cannot propose an account entry', async () => {
      const id = await propose(a.accountId, null, { author: 'agent', prov: { source_run_id: a.runId } });
      expect(await row(id)).toMatchObject({ author_kind: 'agent', status: 'proposed', created_by: null });
      expect((await audit(id))[0]).toMatchObject({ actor: 'system:pipeline', action: 'memory.proposed' });
      await expect(propose(a.accountId, null, { author: 'person' })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(propose(a.accountId, null, { scope: 'account', ref: null, author: 'agent' })).rejects.toMatchObject(invalid);
      await expect(propose(a.accountId, aMember, { scope: 'account', ref: null, author: 'assistant' })).rejects.toMatchObject(invalid);
      // A userless session cannot decide, write or edit.
      await expect(call(a.accountId, null, `memory_decide($1::uuid,'approved')`, [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('MEM-1 acceptance 4: an edit inserts a version', () => {
    it('leaves the prior version readable as superseded and keeps author_kind when a person edits an agent body', async () => {
      const first = await propose(a.accountId, null, { author: 'agent', kind: 'gotcha', body: 'the staging key lives in 1Password' });
      const second = await edit(a.accountId, aAdmin, first, 'the staging key lives in the vault');
      const old = await row(first);
      const cur = await row(second);
      expect(old).toMatchObject({ status: 'superseded', version: 1, author_kind: 'agent', body: 'the staging key lives in 1Password' });
      expect(cur).toMatchObject({ status: 'proposed', version: 2, supersedes_id: first, author_kind: 'agent', created_by: aAdmin, kind: 'gotcha' });
      expect(cur.content_sha256).not.toBe(old.content_sha256);
      // Both versions are readable through app_user.
      const seen = await withTenant(appPool, a.accountId, aMember, (c) => c.query(`SELECT id, status FROM memory_entries WHERE id = ANY($1::uuid[]) ORDER BY version`, [[first, second]]));
      expect(seen.rows).toEqual([{ id: first, status: 'superseded' }, { id: second, status: 'proposed' }]);
      expect((await audit(second)).map((r) => r.action)).toEqual(['memory.edited']);
    });
    it('an edit of a person entry stays a person entry, an approved entry stays approved, and the old version cannot be edited, decided or deleted again', async () => {
      const first = await write(a.accountId, aAdmin, { body: 'prefer small PRs' });
      const second = await edit(a.accountId, aOwner, first, 'prefer PRs under 500 lines');
      expect(await row(second)).toMatchObject({ status: 'approved', author_kind: 'person', approved_by: aOwner, version: 2 });
      await expect(edit(a.accountId, aOwner, first, 'again')).rejects.toMatchObject({ message: /invalid_transition/ });
      await expect(decide(a.accountId, aOwner, first, 'retired')).rejects.toMatchObject({ message: /invalid_transition/ });
      await expect(del(a.accountId, aOwner, first)).rejects.toMatchObject({ message: /invalid_transition/ });
      // Two concurrent edits of one row: the second reads the first's result and loses.
      const results = await Promise.allSettled([edit(a.accountId, aOwner, second, 'v3 left'), edit(a.accountId, aAdmin, second, 'v3 right')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [live] = (await admin.query(`SELECT count(*)::int AS n FROM memory_entries WHERE supersedes_id = $1`, [second])).rows;
      expect(live.n).toBe(1);
    });
    it('a member may edit their own proposal but nobody else, and an edit cannot make an agent body an account entry', async () => {
      const mine = await propose(a.accountId, aMember);
      expect(await edit(a.accountId, aMember, mine, 'run pnpm test, then push')).toBeTruthy();
      const theirs = await propose(a.accountId, aAdmin);
      await expect(edit(a.accountId, aMember, theirs, 'hijack')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const agent = await propose(a.accountId, null, { author: 'agent' });
      await expect(edit(a.accountId, aOwner, agent, 'x', [null, 'account', null])).rejects.toMatchObject({ message: /invalid_message/ });
    });
    it('"Change scope" inserts a new version in the new scope and keeps the old one in history', async () => {
      const first = await write(a.accountId, aAdmin, { body: 'tests live under test/' });
      const second = await edit(a.accountId, aAdmin, first, 'tests live under test/', [null, 'role', 'executor']);
      expect(await row(second)).toMatchObject({ scope: 'role', scope_ref: 'executor', version: 2, status: 'approved' });
      expect(await row(first)).toMatchObject({ scope: 'repo', status: 'superseded' });
    });
  });

  describe('delete and restore', () => {
    it('deletes softly, restores to the prior status inside 30 days, and refuses after', async () => {
      const id = await write(a.accountId, aAdmin);
      expect(await del(a.accountId, aAdmin, id)).toBe('deleted');
      expect(await del(a.accountId, aAdmin, id)).toBe('already_deleted');
      expect(await row(id)).toMatchObject({ status: 'deleted', prior_status: 'approved' });
      expect((await row(id)).deleted_at).toBeTruthy();
      expect(await del(a.accountId, aAdmin, id, true)).toBe('restored');
      expect(await row(id)).toMatchObject({ status: 'approved', prior_status: null, deleted_at: null });
      expect(await del(a.accountId, aAdmin, id, true)).toBe('not_deleted');
      await del(a.accountId, aAdmin, id);
      await admin.query(`UPDATE memory_entries SET deleted_at = now() - interval '31 days' WHERE id = $1`, [id]);
      await expect(del(a.accountId, aAdmin, id, true)).rejects.toMatchObject({ message: /invalid_transition/ });
      await admin.query(`UPDATE memory_entries SET deleted_at = now() - interval '29 days' WHERE id = $1`, [id]);
      expect(await del(a.accountId, aAdmin, id, true)).toBe('restored');
      expect((await audit(id)).map((r) => r.action)).toEqual(['memory.written', 'memory.deleted', 'memory.restored', 'memory.deleted', 'memory.restored']);
    });
    it('a member cannot delete a repo entry', async () => {
      const id = await write(a.accountId, aAdmin);
      await expect(del(a.accountId, aMember, id)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await row(id)).status).toBe('approved');
    });
  });

  describe('caps and full text', () => {
    it('refuses the 31st approved item entry and counts only approved rows', async () => {
      const item = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1,$2,$3,'bug','internal')`, [item, a.accountId, a.repoId]);
      for (let i = 0; i < 30; i++) await write(a.accountId, aMember, { scope: 'item', ref: item, body: `item fact ${i}` });
      await expect(write(a.accountId, aMember, { scope: 'item', ref: item, body: 'one too many' })).rejects.toMatchObject({ code: '54000', message: /memory_full/ });
      const pending = await propose(a.accountId, aMember, { scope: 'item', ref: item, body: 'pending is not counted' });
      await expect(decide(a.accountId, aMember, pending, 'approved')).rejects.toMatchObject({ code: '54000' });
      expect((await row(pending)).status).toBe('proposed');
    });
    it('two concurrent approvals at 49 of 50 take turns: the second waits for the first, then gets memory_full (CWE-362)', async () => {
      const ref = 'capcheck';
      const insertRows = (n: number, status: string) =>
        admin.query(
          `INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, status, expires_at, content_sha256)
           SELECT $1, 'role', $2, 'fact', 'b' || g, 'person', $3, CASE WHEN $3 = 'proposed' THEN now() + interval '14 days' END,
                  encode(sha256(convert_to('b' || g, 'UTF8')), 'hex') FROM generate_series(1, $4::int) g RETURNING id`,
          [a.accountId, ref, status, n],
        );
      await insertRows(49, 'approved');
      // distinct bodies for the two candidates so the sha CHECK holds
      const cand = async (body: string) => propose(a.accountId, aMember, { scope: 'role', ref, body });
      const [p1, p2] = [await cand('first candidate'), await cand('second candidate')];
      const open = async (user: string) => {
        const c = await appPool.connect();
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, user]);
        return c;
      };
      const c1 = await open(aAdmin);
      const c2 = await open(aOwner);
      try {
        expect((await c1.query(`SELECT memory_decide($1::uuid, 'approved') AS r`, [p1])).rows[0].r).toBe('decided');
        // c1 holds the scope lock until it commits, so c2's approval must still be waiting.
        let settled: 'ok' | 'err' | null = null;
        const second = c2.query(`SELECT memory_decide($1::uuid, 'approved') AS r`, [p2]).then(
          () => (settled = 'ok'),
          (e: { code?: string; message?: string }) => {
            settled = 'err';
            return e;
          },
        );
        await new Promise((r) => setTimeout(r, 600));
        expect(settled).toBeNull();
        await c1.query('COMMIT');
        const err = (await second) as { code?: string; message?: string };
        expect(err).toMatchObject({ code: '54000', message: expect.stringMatching(/memory_full/) });
      } finally {
        await c1.query('ROLLBACK').catch(() => {});
        await c2.query('ROLLBACK').catch(() => {});
        c1.release();
        c2.release();
      }
      const n = (await admin.query(`SELECT count(*)::int AS n FROM memory_entries WHERE account_id = $1 AND scope = 'role' AND scope_ref = $2 AND status = 'approved'`, [a.accountId, ref])).rows[0].n;
      expect(n).toBe(50);
      expect((await row(p2)).status).toBe('proposed');
    });
    it('ranks with ts_rank over the GIN-indexed tsvector, on real Postgres', async () => {
      const ref = 'R_kgDORank01@9';
      const hit = await write(a.accountId, aAdmin, { ref, body: 'database migrations must be numbered in order' });
      await write(a.accountId, aAdmin, { ref, body: 'colour palette tokens live in the design package' });
      const { rows } = await admin.query<{ id: string }>(
        `SELECT id FROM memory_entries WHERE account_id = $1 AND scope_ref = $2 AND body_tsv @@ plainto_tsquery('english', 'migration numbering') ORDER BY ts_rank(body_tsv, plainto_tsquery('english', 'migration numbering')) DESC`,
        [a.accountId, ref],
      );
      expect(rows.map((r) => r.id)).toEqual([hit]);
      const idx = await admin.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'memory_entries' AND indexname = 'memory_entries_tsv_idx'`);
      expect(idx.rows[0].indexdef).toMatch(/USING gin/);
    });
  });

  describe('audit', () => {
    it('writes no entry text into audit_log and only the fixed payload keys', async () => {
      const id = await propose(a.accountId, aMember, { body: 'a-very-distinctive-body-text' });
      const rows = await audit(id);
      expect(Object.keys(rows[0].payload).sort()).toEqual(['author_kind', 'entry_id', 'from_status', 'kind', 'scope', 'to_status', 'version']);
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE payload::text LIKE '%a-very-distinctive-body-text%'`)).rowCount).toBe(0);
    });
  });

  describe('grants', () => {
    const q = async (sql: string) => (await admin.query<{ can: boolean }>(sql)).rows[0]!.can;
    it('the role is NOLOGIN and unprivileged, has no member, is a member of nothing, and owns exactly the eight functions', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
      const owned = await admin.query<{ name: string }>(`SELECT p.proname AS name FROM pg_proc p WHERE p.proowner = $1::regrole ORDER BY 1`, [ROLE]);
      expect(owned.rows.map((r) => r.name)).toEqual([...ENTRY_POINTS, ...HELPERS].sort());
      expect(await q(`SELECT has_schema_privilege('${ROLE}', 'public', 'CREATE') AS can`)).toBe(false);
    });
    it('app_user reads and cannot write; platform_ops, partner_user and the run writer hold nothing; the definer never updates the text', async () => {
      expect(await q(`SELECT has_table_privilege('app_user','public.memory_entries','INSERT, UPDATE, DELETE, TRUNCATE') AS can`)).toBe(false);
      expect(await q(`SELECT has_any_column_privilege('app_user','public.memory_entries','INSERT, UPDATE') AS can`)).toBe(false);
      expect(await q(`SELECT has_column_privilege('app_user','public.memory_entries','body','SELECT') AS can`)).toBe(true);
      for (const who of ['platform_ops', 'partner_user', 'agent_run_writer']) {
        expect(await q(`SELECT has_any_column_privilege('${who}','public.memory_entries','SELECT, INSERT, UPDATE, REFERENCES') AS can`), who).toBe(false);
        expect(await q(`SELECT has_table_privilege('${who}','public.memory_entries','SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') AS can`), who).toBe(false);
      }
      for (const col of ['body', 'why', 'content_sha256', 'author_kind', 'scope', 'scope_ref', 'kind', 'account_id', 'created_by', 'version', 'supersedes_id', 'provenance', 'created_at']) {
        expect(await q(`SELECT has_column_privilege('${ROLE}','public.memory_entries','${col}','UPDATE') AS can`), `UPDATE ${col}`).toBe(false);
      }
      expect(await q(`SELECT has_table_privilege('${ROLE}','public.memory_entries','DELETE, TRUNCATE') AS can`)).toBe(false);
      expect(await q(`SELECT has_any_column_privilege('${ROLE}','public.work_items','INSERT, UPDATE') AS can`)).toBe(false);
    });
    it('the five entry points are definers owned by the role with a pinned search_path and EXECUTE for app_user alone; the helpers execute for nobody else', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
                COALESCE((SELECT bool_or(x.is_grantable) FROM aclexplode(p.proacl) x), false) AS grantable
           FROM pg_proc p WHERE p.proname LIKE 'memory\\_%' ORDER BY 1`,
      );
      expect(rows.map((r) => r.proname)).toEqual([...ENTRY_POINTS, ...HELPERS].sort());
      for (const r of rows) {
        expect(r.owner).toBe(ROLE);
        expect(r.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(r).toMatchObject({ ops: false, pub: false, grantable: false });
        const isEntry = ENTRY_POINTS.includes(r.proname);
        expect(r.prosecdef, r.proname).toBe(isEntry);
        expect(r.app, r.proname).toBe(isEntry);
      }
    });
    it('the table is row-secured and forced, with a tenant read for app_user and one policy per command for the definer', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.memory_entries'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const { rows } = await admin.query<{ roles: string[]; cmd: string }>(`SELECT roles::text[] AS roles, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'memory_entries'`);
      expect(rows.map((r) => `${r.cmd} ${r.roles.join(',')}`).sort()).toEqual([`INSERT ${ROLE}`, `SELECT ${ROLE}`, 'SELECT app_user', `UPDATE ${ROLE}`].sort());
    });
    it('the role may write audit_log only for the nine memory actions', async () => {
      const { rows } = await admin.query<{ with_check: string }>(`SELECT with_check FROM pg_policies WHERE tablename = 'audit_log' AND roles = ARRAY[$1]::name[]`, [ROLE]);
      expect(rows).toHaveLength(1);
      for (const s of ['proposed', 'written', 'approved', 'rejected', 'retired', 'reverted', 'edited', 'deleted', 'restored']) expect(rows[0]!.with_check).toContain(`memory.${s}`);
    });
  });
});

/**
 * C21 section 11 for this file too: platform_ops gains nothing. This migrates a throwaway cluster to everything EXCEPT 0793,
 * snapshots what platform_ops holds, applies 0793 on the same database and snapshots again. The snapshot is the table grants,
 * every column grant of every kind on the tables the new role touches, the row policies that name platform_ops, the functions it
 * owns and the roles it belongs to. All of it must be unchanged, and no memory function is owned by platform_ops.
 */
describe('migration 0793 gives platform_ops nothing', () => {
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
    memoryFunctionsOwnedByPlatformOps: string[];
  }
  const TABLES = `('work_items', 'account_members', 'accounts', 'audit_log', 'users')`;

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
      memoryFunctionsOwnedByPlatformOps: await q(`SELECT p.proname AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole AND p.proname LIKE 'memory\\_%' ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0793_ops_diff_test', tmpPrefix: 'fx-0793-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0793Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0793-diff-migrations-'));
    // Every migration numbered after this one is left out too: it was written against a database that has this file.
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name < MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies 0793 and anything after it
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
    expect(before.policies.length).toBeGreaterThan(0);
    expect(before.ownedFunctions.length).toBeGreaterThan(5);
  });

  it('platform_ops holds exactly what it held: table grants, column grants, row policies, owned functions and role memberships', () => {
    expect(after.tableGrants).toEqual(before.tableGrants);
    expect(after.columnGrants).toEqual(before.columnGrants);
    expect(after.policies).toEqual(before.policies);
    expect(after.ownedFunctions).toEqual(before.ownedFunctions);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.memoryFunctionsOwnedByPlatformOps).toEqual([]);
  });

  it('migration 0793 never names platform_ops in a GRANT, REVOKE or OWNER TO statement', () => {
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
});
