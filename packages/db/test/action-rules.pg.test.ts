import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  ActionRulesError,
  appendRuleSet,
  currentActionRules,
  listActionRulesHistory,
  resolveActionRules,
  rollbackRuleSet,
  writeActionRules,
} from '../src/actionRules.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#7 AAP-a2: action_rules (0847), its writer, and the audit door audit_write_action_rules. Append-only versions, owner or admin only,
 * an audit row naming both versions and both hashes. Real Postgres throughout: the trigger, the CHECKs, RLS and the concurrency claims are
 * the database's, so nothing here stubs an answer.
 */
const ACTION = 'action_rules.changed';

const rule = (id: string, outcome: 'approve' | 'deny' | 'ask' = 'ask', tool = 'run'): unknown => ({
  id,
  outcome,
  when: { op: 'equals', field: '/request/tool', value: tool },
});
const set = (...rules: unknown[]) => ({ rules });

describe('action_rules (0847)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let memberId: string;
  let adminUserId: string;

  const asOwner = { get pool() { return appUserPool; }, get principal() { return refs.userId; } };
  const write = (rules: unknown, repoId: string | null = null) => writeActionRules(asOwner, { accountId: refs.accountId, repoId, rules });
  const auditRows = async (accountId = refs.accountId) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at, id`,
      [accountId, ACTION],
    )).rows;
  const rowCount = async (accountId = refs.accountId) =>
    Number((await admin.query(`SELECT count(*) AS n FROM action_rules WHERE account_id = $1`, [accountId])).rows[0].n);
  const tenant = <T>(accountId: string, userId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(appUserPool, accountId, userId, fn);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
    memberId = randomUUID();
    adminUserId = randomUUID();
    for (const [id, role, name] of [[memberId, 'member', 'Mia Member'], [adminUserId, 'admin', 'Ada Admin']] as const) {
      await admin.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [id, `${id}@example.test`, name]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [refs.accountId, id, role]);
    }
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('shape, grants and RLS (AC1, AC2)', () => {
    it('is a tenant table with forced RLS and no violation in the inventory', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.action_rules'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('app_user holds SELECT and INSERT and neither UPDATE nor DELETE; no other app role writes it', async () => {
      const privs = async (role: string) =>
        (await admin.query<{ p: string; ok: boolean }>(
          `SELECT p, has_table_privilege($1, 'public.action_rules', p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
          [role],
        )).rows.filter((r) => r.ok).map((r) => r.p);
      expect(await privs('app_user')).toEqual(['SELECT', 'INSERT']);
      for (const role of ['platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker']) {
        expect(await privs(role), role).toEqual([]);
      }
    });

    it('an UPDATE or DELETE from the app role fails on privileges, even for an owner', async () => {
      await write(set(rule('r1')));
      for (const sql of [`UPDATE action_rules SET rule_count = 0`, `DELETE FROM action_rules`]) {
        await expect(tenant(refs.accountId, refs.userId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('cannot write into another account, and cannot read it', async () => {
      await write(set(rule('mine')));
      await expect(
        tenant(refs.accountId, refs.userId, (c) =>
          c.query(
            `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
             VALUES ($1, NULL, 1, '{"rules":[]}', 0, encode(sha256(convert_to('{"rules": []}', 'UTF8')), 'hex'), $2)`,
            [other.accountId, refs.userId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const seen = await tenant(other.accountId, other.userId, (c) => c.query(`SELECT * FROM action_rules`));
      expect(seen.rows).toEqual([]);
      expect(await tenant(other.accountId, other.userId, (c) => currentActionRules(c, null))).toBeNull();
    });
  });

  describe('who may write (AC3)', () => {
    it('an owner and an admin can write; a plain member cannot, and nothing is left behind', async () => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(writeActionRules({ pool: appUserPool, principal: memberId }, { accountId: refs.accountId, repoId: null, rules: set() })).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);
      await writeActionRules({ pool: appUserPool, principal: adminUserId }, { accountId: refs.accountId, repoId: null, rules: set(rule('by-admin')) });
      expect((await auditRows()).length).toBe(before.audit + 1);
    });

    it('the table policy alone refuses a plain member inserting as themselves, before any audit call', async () => {
      const before = await rowCount();
      await expect(
        tenant(refs.accountId, memberId, (c) =>
          c.query(
            `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
             VALUES ($1, NULL, (SELECT COALESCE(MAX(version), 0) + 1 FROM action_rules WHERE account_id = $1 AND repo_id IS NULL), '{"rules":[]}', 0,
                     encode(sha256(convert_to('{"rules": []}', 'UTF8')), 'hex'), $2)`,
            [refs.accountId, memberId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('a member cannot name an admin as changed_by: the session user must be the writer', async () => {
      const before = await rowCount();
      await expect(
        tenant(refs.accountId, memberId, (c) =>
          c.query(
            `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
             VALUES ($1, NULL, (SELECT COALESCE(MAX(version), 0) + 1 FROM action_rules WHERE account_id = $1 AND repo_id IS NULL), '{"rules":[]}', 0, encode(sha256(convert_to('{"rules": []}', 'UTF8')), 'hex'), $2)`,
            [refs.accountId, adminUserId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('the audit row names the actor, the previous and new versions, and both hashes', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const w = (rules: unknown) => writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules });
      const v1 = await w(set(rule('a')));
      const v2 = await w(set(rule('a'), rule('b', 'deny', 'rm')));
      const rows = await auditRows(acct.accountId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        actor: acct.userId,
        payload: { previous_version: null, new_version: 1, previous_rules_sha256: null, new_rules_sha256: v1.rulesSha256, restored_from_version: null },
      });
      expect(rows[1]).toMatchObject({
        actor: acct.userId,
        payload: { previous_version: 1, new_version: 2, previous_rules_sha256: v1.rulesSha256, new_rules_sha256: v2.rulesSha256 },
      });
      expect(v1.rulesSha256).not.toBe(v2.rulesSha256);
    });

    it('a caller cannot forge the actor or the account in the audit payload', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const v = await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules: set() });
      await tenant(acct.accountId, acct.userId, (c) =>
        c.query(`SELECT audit_write_action_rules($1, $2::jsonb)`, [
          ACTION,
          JSON.stringify({ actor: memberId, account_id: other.accountId, k: 1, repo_id: null, new_version: v.version, new_rules_sha256: v.rulesSha256 }),
        ]),
      );
      const row = (await auditRows(acct.accountId)).at(-1);
      expect(row!.actor).toBe(acct.userId);
      expect(row!.payload).toMatchObject({ actor: acct.userId, account_id: acct.accountId, k: 1 });
    });
  });

  describe('audit_write_action_rules is a closed door', () => {
    const call = (accountId: string, userId: string, action: string | null, payload: unknown = { n: 1 }) =>
      tenant(accountId, userId, (c) => c.query(`SELECT audit_write_action_rules($1::text, $2::jsonb)`, [action, JSON.stringify(payload)]));

    it('refuses every action but action_rules.changed (and a NULL one), writing nothing', async () => {
      const acct = await seedAccount(admin, randomUUID());
      // A real version row, written without an audit row, so the only thing under test is the action name.
      await admin.query(
        `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
         VALUES ($1, NULL, 1, '{"rules": []}', 0, encode(sha256(convert_to('{"rules": []}', 'UTF8')), 'hex'), $2)`,
        [acct.accountId, acct.userId],
      );
      const real = { repo_id: null, new_version: 1, new_rules_sha256: (await admin.query<{ h: string }>(`SELECT rules_sha256 AS h FROM action_rules WHERE account_id = $1`, [acct.accountId])).rows[0]!.h };
      for (const action of ['decision_dial_changed', 'action_rules.deleted', 'ACTION_RULES.CHANGED', '', 'action_rules.changed ', null]) {
        await expect(call(acct.accountId, acct.userId, action, real), String(action)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      expect(await auditRows(acct.accountId)).toEqual([]);
      await call(acct.accountId, acct.userId, ACTION, real);
      expect(await auditRows(acct.accountId)).toHaveLength(1);
    });

    it('refuses a plain member, a non-object payload and an oversize payload', async () => {
      await expect(call(refs.accountId, memberId, ACTION)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(call(refs.accountId, refs.userId, ACTION, [1])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(call(refs.accountId, refs.userId, ACTION, { big: 'x'.repeat(70_000) })).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });

    it('is SECURITY DEFINER with a pinned search path, owned by its own role, platform_ops gains nothing, EXECUTE for app_user only; audit_write is untouched', async () => {
      const { rows } = await admin.query<{ secdef: boolean; owner: string; config: string[] | null }>(
        `SELECT p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = 'public.audit_write_action_rules(text, jsonb)'::regprocedure`,
      );
      expect(rows[0]!.secdef).toBe(true);
      expect(rows[0]!.owner).toBe('action_rules_auditor');
      expect(rows[0]!.config).toEqual(['search_path=pg_catalog, public, pg_temp']);
      const exec = async (role: string) =>
        (await admin.query<{ ok: boolean }>(`SELECT has_function_privilege($1, 'public.audit_write_action_rules(text, jsonb)', 'EXECUTE') AS ok`, [role])).rows[0]!.ok;
      expect(await exec('app_user')).toBe(true);
      expect(await exec('public')).toBe(false);
      expect(await exec('platform_ops')).toBe(false);
      expect(await exec('partner_user')).toBe(false);
      const role = (await admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'action_rules_auditor'`)).rows[0];
      expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
      // audit_write's own allowlist did not gain the new action.
      await expect(
        tenant(refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write($1, '{}'::jsonb)`, [ACTION])),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });

  describe('versions (AC4)', () => {
    it('versions forward per scope: account and repo count separately', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const w = (rules: unknown, repoId: string | null) => writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId, rules });
      expect((await w(set(), null)).version).toBe(1);
      expect((await w(set(), null)).version).toBe(2);
      expect((await w(set(), acct.repoId)).version).toBe(1);
      expect((await w(set(), null)).version).toBe(3);
      expect((await w(set(), acct.repoId)).version).toBe(2);
    });

    it('two concurrent appends on real Postgres take two different versions and never a duplicate', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const w = (id: string, repoId: string | null) =>
        writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId, rules: set(rule(id)) });
      for (const repoId of [null, acct.repoId]) {
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => w(`c${i}`, repoId)));
        expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
        const { rows } = await admin.query(
          `SELECT version, count(*) AS n FROM action_rules WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid GROUP BY version HAVING count(*) > 1`,
          [acct.accountId, repoId],
        );
        expect(rows).toEqual([]);
        expect(await auditRows(acct.accountId)).toHaveLength(repoId === null ? 6 : 12);
      }
    });

    it('the database itself refuses a skipped or reused version, for a repo scope and for the account scope', async () => {
      const acct = await seedAccount(admin, randomUUID());
      await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules: set() });
      await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: acct.repoId, rules: set() });
      const insert = (repoId: string | null, version: number) =>
        tenant(acct.accountId, acct.userId, (c) =>
          c.query(
            `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
             VALUES ($1, $2, $3, '{"rules":[]}', 0, encode(sha256(convert_to('{"rules": []}', 'UTF8')), 'hex'), $4)`,
            [acct.accountId, repoId, version, acct.userId],
          ),
        );
      for (const repoId of [null, acct.repoId]) {
        await expect(insert(repoId, 1)).rejects.toMatchObject({ code: expect.stringMatching(/^(23505|23514)$/) });
        await expect(insert(repoId, 3)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it('the writer maps a lost version race to action_rules_version_conflict', async () => {
      const acct = await seedAccount(admin, randomUUID());
      // Bypass the writer's lock by inserting a row on a second connection, then insert the same version through a stale view.
      await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules: set() });
      const err = await tenant(acct.accountId, acct.userId, async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`action_rules:${acct.accountId}:`]);
        // A direct insert of version 1 again is what a writer that read a stale "previous" would send.
        return c
          .query(
            `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
             VALUES ($1, NULL, 1, '{"rules":[]}', 0, encode(sha256(convert_to('{"rules": []}', 'UTF8')), 'hex'), $2)`,
            [acct.accountId, acct.userId],
          )
          .then(() => null, (e: unknown) => e);
      });
      expect(err).toMatchObject({ code: expect.stringMatching(/^(23505|23514)$/) });
      expect(new ActionRulesError('action_rules_version_conflict').code).toBe('action_rules_version_conflict');
    });
  });

  describe('limits and checks (AC5)', () => {
    it('an invalid set is refused with the validator code and nothing is inserted or audited', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const w = (rules: unknown) => writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules });
      const cases: [unknown, string][] = [
        [{ rules: [{ id: 'x', outcome: 'ask', when: { op: 'regex', field: '/request/tool', value: 'a' } }] }, 'regex_operator'],
        [{ rules: [{ id: 'x', outcome: 'ask', when: { op: 'equals', field: '/request/agent_reasoning', value: 'a' } }] }, 'field_forbidden'],
        [{ rules: [{ id: 'x', outcome: 'ask', when: { op: 'equals', field: '/request/context/a', value: 'a' } }] }, 'field_forbidden'],
        [{ rules: Array.from({ length: 201 }, (_, i) => rule(`r${i}`)) }, 'too_many_rules'],
        [{ rules: [], extra: 1 }, 'unknown_key'],
        ['nope', 'not_an_object'],
      ];
      for (const [bad, code] of cases) {
        const err = await w(bad).then(() => null, (e: unknown) => e);
        expect(err, code).toBeInstanceOf(ActionRulesError);
        expect((err as ActionRulesError).code).toBe('action_rules_invalid');
        expect((err as ActionRulesError).errors.map((e) => e.code)).toContain(code);
      }
      expect(await rowCount(acct.accountId)).toBe(0);
      expect(await auditRows(acct.accountId)).toEqual([]);
    });

    it('a malformed repo id is refused before the database is touched', async () => {
      await expect(write(set(), 'not-a-uuid')).rejects.toMatchObject({ code: 'action_rules_repo_invalid' });
    });

    it('rule_count is checked against the stored rules, the hash against their text, the size at 256 KiB, and at most 200 rules', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const raw = (rules: string, count: number, sha?: string) =>
        admin.query(
          `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
           VALUES ($1, NULL, 1, $2::jsonb, $3, COALESCE($4, encode(sha256(convert_to(($2::jsonb)::text, 'UTF8')), 'hex')), $5)`,
          [acct.accountId, rules, count, sha ?? null, acct.userId],
        );
      await expect(raw('{"rules":[{"a":1}]}', 0)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw('{"rules":[]}', 0, 'a'.repeat(64))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw('{"rules":[]}', 0, 'xyz')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw('{"not":"rules"}', 0)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw('[]', 0)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw(JSON.stringify({ rules: Array.from({ length: 201 }, () => 1) }), 201)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw(JSON.stringify({ rules: [{ pad: 'x'.repeat(262_200) }] }), 1)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await rowCount(acct.accountId)).toBe(0);
      await raw('{"rules": []}', 0);
      expect(await rowCount(acct.accountId)).toBe(1);
    });

    it("the stored hash is the SHA-256 of the stored rules' canonical text", async () => {
      const v = await write(set(rule('h')));
      const { rows } = await admin.query<{ t: string }>(`SELECT rules::text AS t FROM action_rules WHERE id = $1`, [v.id]);
      expect(v.rulesSha256).toBe(createHash('sha256').update(rows[0]!.t).digest('hex'));
    });
  });

  describe('resolution (AC6)', () => {
    it('no row anywhere is the empty set, so every call asks', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const r = await tenant(acct.accountId, acct.userId, (c) => resolveActionRules(c, acct.repoId));
      expect(r).toEqual({ rules: { rules: [] }, scope: 'none', version: 0 });
    });

    it('a repo-scoped set overrides the account set, even an empty one; a repo without its own inherits', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`,
        [acct.accountId, Math.floor(Math.random() * 1e9)],
      );
      const repoB = rows[0]!.id;
      const w = (rules: unknown, repoId: string | null) => writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId, rules });
      await w(set(rule('acct-rule', 'approve')), null);
      const resolve = (repoId: string | null) => tenant(acct.accountId, acct.userId, (c) => resolveActionRules(c, repoId));
      expect(await resolve(acct.repoId)).toMatchObject({ scope: 'account', version: 1, rules: set(rule('acct-rule', 'approve')) });
      await w(set(rule('repo-rule', 'deny')), acct.repoId);
      expect(await resolve(acct.repoId)).toMatchObject({ scope: 'repo', version: 1, rules: set(rule('repo-rule', 'deny')) });
      expect(await resolve(repoB)).toMatchObject({ scope: 'account', version: 1 });
      await w(set(), acct.repoId);
      expect(await resolve(acct.repoId)).toMatchObject({ scope: 'repo', version: 2, rules: set() });
      expect(await resolve(null)).toMatchObject({ scope: 'account', version: 1 });
    });
  });

  describe('undo (AC7)', () => {
    it('rollback inserts a new version with the earlier rules and restored_from_version; older rows stay byte-identical', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const principal = { pool: appUserPool, principal: acct.userId };
      const w = (rules: unknown) => writeActionRules(principal, { accountId: acct.accountId, repoId: null, rules });
      await w(set(rule('one')));
      await w(set(rule('two'), rule('three', 'deny', 'rm')));
      await w(set());
      const snapshot = async () =>
        (await admin.query(`SELECT id, version, rules::text AS rules, rule_count, rules_sha256, restored_from_version, changed_by, created_at FROM action_rules WHERE account_id = $1 ORDER BY version`, [acct.accountId])).rows;
      const before = await snapshot();
      const restored = await tenant(acct.accountId, acct.userId, (c) =>
        rollbackRuleSet(c, { accountId: acct.accountId, repoId: null, toVersion: 2, changedBy: acct.userId }),
      );
      expect(restored).toMatchObject({ version: 4, restoredFromVersion: 2, ruleCount: 2 });
      expect(restored.rulesSha256).toBe(before[1]!.rules_sha256);
      expect(restored.rules).toEqual(set(rule('two'), rule('three', 'deny', 'rm')));
      expect((await snapshot()).slice(0, 3)).toEqual(before);
      const audit = (await auditRows(acct.accountId)).at(-1)!;
      expect(audit.payload).toMatchObject({ previous_version: 3, new_version: 4, restored_from_version: 2 });
    });

    it('delete-all is a new empty version, and the rules before it can be restored', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const principal = { pool: appUserPool, principal: acct.userId };
      await writeActionRules(principal, { accountId: acct.accountId, repoId: null, rules: set(rule('keep')) });
      const empty = await writeActionRules(principal, { accountId: acct.accountId, repoId: null, rules: set() });
      expect(empty).toMatchObject({ version: 2, ruleCount: 0 });
      expect((await tenant(acct.accountId, acct.userId, (c) => resolveActionRules(c, null))).rules).toEqual(set());
      await tenant(acct.accountId, acct.userId, (c) => rollbackRuleSet(c, { accountId: acct.accountId, repoId: null, toVersion: 1, changedBy: acct.userId }));
      expect((await tenant(acct.accountId, acct.userId, (c) => resolveActionRules(c, null))).rules).toEqual(set(rule('keep')));
      expect(await rowCount(acct.accountId)).toBe(3);
    });

    it('rollback of a version the scope never had is refused (a repo version is not reachable from the account scope)', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const principal = { pool: appUserPool, principal: acct.userId };
      await writeActionRules(principal, { accountId: acct.accountId, repoId: acct.repoId, rules: set(rule('repo-only')) });
      const attempt = (repoId: string | null, toVersion: number) =>
        tenant(acct.accountId, acct.userId, (c) => rollbackRuleSet(c, { accountId: acct.accountId, repoId, toVersion, changedBy: acct.userId }));
      await expect(attempt(null, 1)).rejects.toMatchObject({ code: 'action_rules_version_not_found' });
      await expect(attempt(acct.repoId, 7)).rejects.toMatchObject({ code: 'action_rules_version_not_found' });
      expect(await rowCount(acct.accountId)).toBe(1);
    });

    it('a plain member cannot roll back', async () => {
      const before = await rowCount();
      await expect(
        tenant(refs.accountId, memberId, (c) => rollbackRuleSet(c, { accountId: refs.accountId, repoId: null, toVersion: 1, changedBy: memberId })),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('history lists newest first with the author as a name, and a nameless author reads as a team member, never an id', async () => {
      const acct = await seedAccount(admin, randomUUID());
      await admin.query(`UPDATE users SET name = NULL, github_login = NULL WHERE id = $1`, [acct.userId]);
      await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules: set() });
      const named = randomUUID();
      await admin.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Nora Named')`, [named, `${named}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [acct.accountId, named]);
      await writeActionRules({ pool: appUserPool, principal: named }, { accountId: acct.accountId, repoId: null, rules: set(rule('n')) });
      const history = await tenant(acct.accountId, acct.userId, (c) => listActionRulesHistory(c, null));
      expect(history.map((h) => [h.version, h.changedByName])).toEqual([[2, 'Nora Named'], [1, 'A team member']]);
      expect(JSON.stringify(history)).not.toContain(acct.userId);
    });
  });

  describe('fix round: composite FK, rollback re-validation, unstorable strings, races, constraints', () => {
    const rawInsert = (c: PoolClient, accountId: string, repoId: string | null, version: number, restoredFrom: number | null, changedBy: string, rules = '{"rules": []}') =>
      c.query(
        `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, restored_from_version, changed_by)
         VALUES ($1, $2, $3, $4::jsonb, jsonb_array_length($4::jsonb -> 'rules'), encode(sha256(convert_to(($4::jsonb)::text, 'UTF8')), 'hex'), $5, $6)`,
        [accountId, repoId, version, rules, restoredFrom, changedBy],
      );

    it("the composite (account_id, repo_id) FK refuses a row of one account naming another account's repo", async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const before = await rowCount(a.accountId);
      await expect(tenant(a.accountId, a.userId, (c) => rawInsert(c, a.accountId, b.repoId, 1, null, a.userId))).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
      await expect(rawInsert(admin, a.accountId, b.repoId, 1, null, a.userId)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      await expect(writeActionRules({ pool: appUserPool, principal: a.userId }, { accountId: a.accountId, repoId: b.repoId, rules: set() })).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
      expect(await rowCount(a.accountId)).toBe(before);
      await rawInsert(admin, a.accountId, a.repoId, 1, null, a.userId); // its own repo is fine
    });

    it('rollback to a stored version that no longer validates is refused: nothing inserted, nothing audited', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const principal = { pool: appUserPool, principal: acct.userId };
      await writeActionRules(principal, { accountId: acct.accountId, repoId: null, rules: set(rule('ok')) });
      // A row the validator now refuses (a regex operator), stored as an older release might have allowed.
      await rawInsert(admin, acct.accountId, null, 2, null, acct.userId, JSON.stringify(set({ id: 'old', outcome: 'ask', when: { op: 'regex', field: '/request/tool', value: 'a.*' } })));
      await writeActionRules(principal, { accountId: acct.accountId, repoId: null, rules: set(rule('latest')) });
      const rows = await rowCount(acct.accountId);
      const audits = (await auditRows(acct.accountId)).length;
      const err = await tenant(acct.accountId, acct.userId, (c) =>
        rollbackRuleSet(c, { accountId: acct.accountId, repoId: null, toVersion: 2, changedBy: acct.userId }),
      ).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ActionRulesError);
      expect((err as ActionRulesError).code).toBe('action_rules_invalid');
      expect((err as ActionRulesError).errors.map((e) => e.code)).toContain('regex_operator');
      expect(await rowCount(acct.accountId)).toBe(rows);
      expect((await auditRows(acct.accountId)).length).toBe(audits);
    });

    it('a NUL character or a lone surrogate in a rule value is refused by the writer as invalid input, before Postgres sees it', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const principal = { pool: appUserPool, principal: acct.userId };
      const withValue = (value: string) => set({ id: 'u', outcome: 'ask', when: { op: 'equals', field: '/request/tool', value } });
      for (const bad of ['a\u0000b', '\u0000', 'x\ud800y', '\udc00', 'tail\ud83d']) {
        const err = await writeActionRules(principal, { accountId: acct.accountId, repoId: null, rules: withValue(bad) }).then(() => null, (e: unknown) => e);
        expect(err, JSON.stringify(bad)).toBeInstanceOf(ActionRulesError);
        expect((err as ActionRulesError).code).toBe('action_rules_invalid');
        expect((err as ActionRulesError).errors).toEqual([{ code: 'value_invalid', path: '/rules/0/when/value' }]);
      }
      // A valid surrogate pair and ordinary non-ASCII text are fine.
      await writeActionRules(principal, { accountId: acct.accountId, repoId: null, rules: withValue('café 😀') });
      expect(await rowCount(acct.accountId)).toBe(1);
      expect(await auditRows(acct.accountId)).toHaveLength(1);
    });

    it('a lost version race (a writer that skipped the lock committed first) is action_rules_version_conflict, and leaves nothing behind', async () => {
      const acct = await seedAccount(admin, randomUUID());
      await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules: set() });
      const err = await withTenant(appUserPool, acct.accountId, acct.userId, async (client) => {
        const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        let raced = false;
        const racing = new Proxy(client, {
          get(target, prop) {
            if (prop !== 'query') return Reflect.get(target, prop) as unknown;
            return async (...args: unknown[]) => {
              if (!raced && typeof args[0] === 'string' && args[0].includes('INSERT INTO action_rules')) {
                raced = true;
                // The rival commits version 2 on its own connection between our read of "previous" and our insert.
                await rawInsert(admin, acct.accountId, null, 2, null, acct.userId);
              }
              return realQuery(...args);
            };
          },
        });
        return appendRuleSet(racing, { accountId: acct.accountId, repoId: null, rules: set(rule('late')), changedBy: acct.userId }).then(() => null, (e: unknown) => e);
      });
      expect(err).toBeInstanceOf(ActionRulesError);
      expect((err as ActionRulesError).code).toBe('action_rules_version_conflict');
      expect(await rowCount(acct.accountId)).toBe(2);
      expect(await auditRows(acct.accountId)).toHaveLength(1);
    });

    it('the account-scope UNIQUE index (NULL repo) refuses a duplicate version even with the trigger out of the way', async () => {
      const acct = await seedAccount(admin, randomUUID());
      await admin.query('BEGIN');
      try {
        await admin.query(`ALTER TABLE action_rules DISABLE TRIGGER action_rules_enforce_next_version`);
        await rawInsert(admin, acct.accountId, null, 1, null, acct.userId);
        await expect(rawInsert(admin, acct.accountId, null, 1, null, acct.userId)).rejects.toMatchObject({
          code: PG_ERROR.UNIQUE_VIOLATION,
          constraint: 'action_rules_account_scope',
        });
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('restored_from_version must be an earlier version than the row itself', async () => {
      const acct = await seedAccount(admin, randomUUID());
      await rawInsert(admin, acct.accountId, null, 1, null, acct.userId);
      await expect(rawInsert(admin, acct.accountId, null, 2, 2, acct.userId)).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'action_rules_restored_is_earlier',
      });
      await expect(rawInsert(admin, acct.accountId, null, 2, 5, acct.userId)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await rawInsert(admin, acct.accountId, null, 2, 1, acct.userId);
    });
  });

  describe('the audit door checks its payload against the table', () => {
    it('refuses a payload that names a version, hash, scope or author that is not a row the caller wrote, and writes no audit row', async () => {
      const acct = await seedAccount(admin, randomUUID());
      const adminId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [adminId, `${adminId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [acct.accountId, adminId]);
      const v1 = await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules: set(rule('one')) });
      const v2 = await writeActionRules({ pool: appUserPool, principal: acct.userId }, { accountId: acct.accountId, repoId: null, rules: set(rule('two')) });
      const base = { repo_id: null, previous_version: 1, previous_rules_sha256: v1.rulesSha256, new_version: 2, new_rules_sha256: v2.rulesSha256 };
      const call = (userId: string, payload: unknown) =>
        tenant(acct.accountId, userId, (c) => c.query(`SELECT audit_write_action_rules('action_rules.changed', $1::jsonb)`, [JSON.stringify(payload)]));
      const audits = () => auditRows(acct.accountId).then((r) => r.length);
      const before = await audits();
      const bad: [string, unknown][] = [
        ['a version that does not exist', { ...base, new_version: 99 }],
        ['a hash that is not that version', { ...base, new_rules_sha256: v1.rulesSha256 }],
        ['an invented hash', { ...base, new_rules_sha256: 'f'.repeat(64) }],
        ['the other scope', { ...base, repo_id: acct.repoId }],
        ['a previous version with the wrong hash', { ...base, previous_rules_sha256: 'e'.repeat(64) }],
        ['no new_version', { repo_id: null, new_rules_sha256: v2.rulesSha256 }],
        ['a string version', { ...base, new_version: '2' }],
        ['an empty payload', {}],
      ];
      for (const [label, payload] of bad) {
        await expect(call(acct.userId, payload), label).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      // Someone else's row: the admin did not write version 2, so cannot claim it.
      await expect(call(adminId, base)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await audits()).toBe(before);
      await call(acct.userId, base);
      expect(await audits()).toBe(before + 1);
    });

    it("cannot be pointed at another account's row", async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const vb = await writeActionRules({ pool: appUserPool, principal: b.userId }, { accountId: b.accountId, repoId: null, rules: set(rule('b')) });
      await expect(
        tenant(a.accountId, a.userId, (c) =>
          c.query(`SELECT audit_write_action_rules('action_rules.changed', $1::jsonb)`, [JSON.stringify({ repo_id: null, new_version: vb.version, new_rules_sha256: vb.rulesSha256 })]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });

    it("the role's own audit_log policy admits only the action_rules.changed action for the account in context", async () => {
      const acct = await seedAccount(admin, randomUUID());
      const insert = async (action: string, accountId = acct.accountId) => {
        await admin.query('BEGIN');
        try {
          await admin.query(`SET LOCAL ROLE action_rules_auditor`);
          await admin.query(`SELECT set_config('app.account_id', $1, true)`, [acct.accountId]);
          await admin.query(`INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1, 'x', $2, '{}', now())`, [accountId, action]);
        } finally {
          await admin.query('ROLLBACK');
        }
      };
      await insert('action_rules.changed');
      await expect(insert('decision_dial_changed')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(insert('action_rules.changed', other.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  it('a repo that has rule history cannot be hard-deleted (NO ACTION), by anyone', async () => {
    await write(set(rule('pinned')), refs.repoId);
    await expect(tenant(refs.accountId, refs.userId, (c) => c.query(`DELETE FROM repos WHERE id = $1`, [refs.repoId]))).rejects.toMatchObject({
      code: PG_ERROR.FOREIGN_KEY_VIOLATION,
    });
  });
});
