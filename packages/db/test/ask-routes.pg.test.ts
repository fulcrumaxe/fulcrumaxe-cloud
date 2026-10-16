import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  AskRouteError,
  appendAskRouteVersion,
  listAskRouteHistory,
  listCurrentAskRoutes,
  removeAskRoute,
  resolveCurrentAskRoute,
  restoreAskRoute,
  writeAskRoute,
  type AskRouteKey,
} from '../src/askRoutes.js';
import { planEscalation } from '@fx/decisions';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#7 AAP-b1: ask_routes (0836) and its writer. Append-only versions, owner or admin only, an audit row naming both routes, targets that
 * can answer, and a tombstone that returns a scope to the next one up.
 */
const ACTION = 'ask_route.changed';
const ALL = { type: 'all_owners_admins' } as const;
const level = (target: object = ALL, escalateAfterMinutes = 15) => ({ target, escalateAfterMinutes });

describe('ask_routes (0836)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let memberId: string;
  let adminUserId: string;

  const key = (over: Partial<AskRouteKey> = {}): AskRouteKey => ({
    accountId: refs.accountId,
    repoId: null,
    subject: 'decision',
    decisionType: '*',
    ...over,
  });
  const asOwner = { get pool() { return appUserPool; }, get principal() { return refs.userId; } };
  const route = (over: Record<string, unknown> = {}) => ({ levels: [level()], hours: [], repeat: 0, ...over });
  const write = (over: Partial<AskRouteKey> = {}, r: unknown = route()) => writeAskRoute(asOwner, { ...key(over), route: r });
  const auditRows = async (accountId = refs.accountId) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at`,
      [accountId, ACTION],
    )).rows;
  const rowCount = async (accountId = refs.accountId) =>
    Number((await admin.query(`SELECT count(*) AS n FROM ask_routes WHERE account_id = $1`, [accountId])).rows[0].n);
  const insertSql = `INSERT INTO ask_routes (account_id, repo_id, subject, decision_type, levels, hours, repeat, version, changed_by)
                     VALUES ($1, $2, 'decision', '*', $3::jsonb, '[]', 0, $4, $5)`;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
    memberId = randomUUID();
    adminUserId = randomUUID();
    for (const [id, role] of [[memberId, 'member'], [adminUserId, 'admin']] as const) {
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [refs.accountId, id, role]);
    }
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('shape, grants and RLS', () => {
    it('is a tenant table with forced RLS and no violation in the inventory', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.ask_routes'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('app_user holds SELECT and INSERT and neither UPDATE nor DELETE; no other app role writes it', async () => {
      const privs = async (role: string) =>
        (await admin.query<{ p: string; ok: boolean }>(
          `SELECT p, has_table_privilege($1, 'public.ask_routes', p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
          [role],
        )).rows.filter((r) => r.ok).map((r) => r.p);
      expect(await privs('app_user')).toEqual(['SELECT', 'INSERT']);
      for (const role of ['platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker']) {
        const p = await privs(role);
        for (const verb of ['UPDATE', 'DELETE', 'INSERT']) expect(p).not.toContain(verb);
      }
    });

    it('an UPDATE or DELETE from the app role is refused, even by an owner', async () => {
      await write();
      for (const sql of [`UPDATE ask_routes SET repeat = 1`, `DELETE FROM ask_routes`]) {
        await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(sql))).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
    });
  });

  describe('who may write', () => {
    it('an owner and an admin can write; a plain member cannot, and nothing is left behind', async () => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(writeAskRoute({ pool: appUserPool, principal: memberId }, { ...key(), route: route() })).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);
      await writeAskRoute({ pool: appUserPool, principal: adminUserId }, { ...key({ decisionType: 'test_strategy_choice' }), route: route() });
      expect((await auditRows()).length).toBe(before.audit + 1);
    });

    it('a member cannot name an admin as changed_by: the session user must be the writer', async () => {
      const before = await rowCount();
      await expect(
        withTenant(appUserPool, refs.accountId, memberId, (c) =>
          c.query(
            `INSERT INTO ask_routes (account_id, repo_id, subject, decision_type, levels, version, changed_by)
             VALUES ($1, NULL, 'decision', 'changed_by_probe', '[]', 1, $2)`,
            [refs.accountId, adminUserId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('cannot write into another account, and cannot read it', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(insertSql, [other.accountId, null, '[]', 1, refs.userId])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await writeAskRoute({ pool: appUserPool, principal: other.userId }, { ...key({ accountId: other.accountId }), route: route({ repeat: 2 }) });
      const seen = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listCurrentAskRoutes(c));
      expect(seen.every((r) => r.accountId === refs.accountId)).toBe(true);
      expect(seen.some((r) => r.repeat === 2)).toBe(false);
    });
  });

  describe('targets and limits (owner ruling 4)', () => {
    it('a plain member is refused as a target with target_not_answerer and nothing is written', async () => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(write({}, route({ levels: [level({ type: 'member', memberId })] }))).rejects.toMatchObject({ code: 'target_not_answerer' });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);
    });

    it('an owner and an admin are accepted as named targets', async () => {
      const v = await write({ decisionType: 'nonbreaking_refactor_approach' }, route({ levels: [level({ type: 'member', memberId: adminUserId }), level({ type: 'member', memberId: refs.userId })] }));
      expect(v.levels).toHaveLength(2);
    });

    it('the database refuses a plain member as a target even when the writer is bypassed', async () => {
      const levels = JSON.stringify([level({ type: 'member', memberId })]);
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(insertSql, [refs.accountId, refs.repoId, levels, 1, refs.userId])),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, message: 'ask_routes.target_not_answerer' });
    });

    it.each([
      ['five levels', JSON.stringify(Array.from({ length: 5 }, () => level()))],
      ['a delay of 4 minutes', JSON.stringify([level(ALL, 4)])],
      ['a delay over 7 days', JSON.stringify([level(ALL, 10081)])],
      ['a level with an unknown field', JSON.stringify([{ ...level(), extra: 1 }])],
      ['a target of an unknown type', JSON.stringify([level({ type: 'team' })])],
      ['levels that are not an array', '{}'],
    ])('the database refuses %s', async (_n, levels) => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(insertSql, [refs.accountId, refs.repoId, levels, 1, refs.userId])),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('the database refuses repeat 4, 15 windows, and a tombstone that carries hours or a repeat', async () => {
      const bad = (hours: string, repeat: number, levels = '[]') =>
        withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
          c.query(
            `INSERT INTO ask_routes (account_id, repo_id, subject, decision_type, levels, hours, repeat, version, changed_by)
             VALUES ($1, $2, 'decision', '*', $3::jsonb, $4::jsonb, $5, 1, $6)`,
            [refs.accountId, refs.repoId, levels, hours, repeat, refs.userId],
          ),
        );
      const one = JSON.stringify([level()]);
      await expect(bad('[]', 4, one)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad(JSON.stringify(Array.from({ length: 15 }, () => ({}))), 0, one)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad('[{}]', 0)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad('[]', 1)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it.each([
      ['an unknown decision type', { decisionType: 'made_up_type' }, 'ask_route_unknown_decision_type'],
      ['a class 1 type, which is never asked', { decisionType: 'dependency_patch_bump' }, 'ask_route_class1_never_asks'],
      ['a per-type action route', { subject: 'action' as const, decisionType: 'tool_call' }, 'ask_route_action_type_invalid'],
      ['a repo that is not a uuid', { repoId: 'nope' }, 'ask_route_repo_invalid'],
      ['an unknown subject', { subject: 'other' as never }, 'ask_route_subject_invalid'],
    ])('the writer refuses %s with %s before any write', async (_n, over, code) => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(write(over)).rejects.toMatchObject({ code });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);
    });

    it('the writer passes the pure validator codes through (time zone, repeat, tombstone settings)', async () => {
      await expect(write({}, route({ hours: [{ timeZone: 'Mars/Olympus', days: [1], start: '09:00', end: '10:00' }] }))).rejects.toBeInstanceOf(AskRouteError);
      await expect(write({}, route({ hours: [{ timeZone: 'Mars/Olympus', days: [1], start: '09:00', end: '10:00' }] }))).rejects.toMatchObject({ code: 'window_zone_invalid' });
      await expect(write({}, route({ repeat: 4 }))).rejects.toMatchObject({ code: 'repeat_out_of_range' });
      await expect(write({}, { levels: [], hours: [], repeat: 2 })).rejects.toMatchObject({ code: 'tombstone_has_settings' });
    });

    it('an action route is stored under the key *', async () => {
      const v = await write({ subject: 'action' });
      expect(v).toMatchObject({ subject: 'action', decisionType: '*' });
    });
  });

  describe('append-only versions, the audit row and the undo path', () => {
    it('versions forward per key; the audit row names the actor and both the previous and the new route', async () => {
      const k = { repoId: refs.repoId, decisionType: 'test_strategy_choice' };
      const hours = [{ timeZone: 'Europe/London', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:30' }];
      const v1 = await write(k, route({ repeat: 1 }));
      const v2 = await write(k, route({ levels: [level(ALL, 30), level({ type: 'member', memberId: adminUserId }, 60)], hours, repeat: 3 }));
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect(v2).toMatchObject({ changedBy: refs.userId, accountId: refs.accountId, repoId: refs.repoId, hours, repeat: 3 });
      const audits = (await auditRows()).filter((a) => a.payload.decision_type === 'test_strategy_choice' && a.payload.repo_id === refs.repoId);
      expect(audits).toHaveLength(2);
      expect(audits[0]!.payload).toMatchObject({ actor: refs.userId, subject: 'decision', version: 1, previous: { levels: [], hours: [], repeat: 0 }, new: { repeat: 1 } });
      expect(audits[1]!.payload).toMatchObject({ version: 2, previous: { repeat: 1 }, new: { repeat: 3, hours } });
    });

    it('the current route is the highest version; the history keeps every version', async () => {
      const k = { repoId: refs.repoId, decisionType: 'publish_release_artifact' };
      await write(k, route({ repeat: 1 }));
      await write(k, route({ repeat: 2 }));
      const current = (await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listCurrentAskRoutes(c))).filter(
        (r) => r.repoId === refs.repoId && r.decisionType === 'publish_release_artifact',
      );
      expect(current.map((r) => r.repeat)).toEqual([2]);
      const history = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listAskRouteHistory(c, refs.repoId, 'decision', 'publish_release_artifact'));
      expect(history.map((h) => h.repeat)).toEqual([1, 2]);
    });

    it('undo by restore: an earlier version becomes a new version, older rows are byte-identical, and the audit row says which', async () => {
      const k = { repoId: null, decisionType: 'external_paid_api_call' };
      await write(k, route({ repeat: 1 }));
      await write(k, route({ repeat: 3 }));
      const snapshot = JSON.stringify((await admin.query(`SELECT * FROM ask_routes WHERE account_id = $1 AND decision_type = 'external_paid_api_call' ORDER BY version`, [refs.accountId])).rows);
      const restored = await restoreAskRoute(asOwner, { ...key(k), version: 1 });
      expect(restored).toMatchObject({ version: 3, repeat: 1 });
      const after = (await admin.query(`SELECT * FROM ask_routes WHERE account_id = $1 AND decision_type = 'external_paid_api_call' ORDER BY version`, [refs.accountId])).rows;
      expect(JSON.stringify(after.slice(0, 2))).toBe(snapshot);
      const last = (await auditRows()).filter((a) => a.payload.decision_type === 'external_paid_api_call').at(-1)!;
      expect(last.payload).toMatchObject({ version: 3, restored_from_version: 1 });
      await expect(restoreAskRoute(asOwner, { ...key(k), version: 99 })).rejects.toMatchObject({ code: 'ask_route_version_unknown' });
    });

    it('restoring a version that names someone who has since lost the role is refused', async () => {
      const k = { repoId: null, decisionType: 'publish_deprecation_notice' };
      const demoted = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [demoted, `${demoted}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [refs.accountId, demoted]);
      await write(k, route({ levels: [level({ type: 'member', memberId: demoted })] }));
      await write(k, route());
      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, demoted]);
      await expect(restoreAskRoute(asOwner, { ...key(k), version: 1 })).rejects.toMatchObject({ code: 'target_not_answerer' });
    });

    it('two transactions taking the same version: the loser fails on the UNIQUE key once the winner commits', async () => {
      const insert = (c: PoolClient) => c.query(insertSql, [refs.accountId, refs.repoId, JSON.stringify([level()]), 1, refs.userId]);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let inserted!: () => void;
      const winnerIn = new Promise<void>((r) => { inserted = r; });
      const winner = withTenant(appUserPool, refs.accountId, refs.userId, async (c) => { await insert(c); inserted(); await gate; });
      await winnerIn;
      const loser = withTenant(appUserPool, refs.accountId, refs.userId, insert);
      setTimeout(release, 150);
      await expect(winner).resolves.toBeUndefined();
      await expect(loser).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('two writers racing for the first version of an account-wide key: exactly one wins, the loser gets ask_route_version_conflict', async () => {
      const k = key({ decisionType: 'start_after_reclassify' });
      let releaseA!: () => void;
      const gate = new Promise<void>((r) => { releaseA = r; });
      let aInserted!: () => void;
      const aReady = new Promise<void>((r) => { aInserted = r; });
      const a = withTenant(appUserPool, refs.accountId, refs.userId, async (c) => {
        const v = await appendAskRouteVersion(c, { ...k, route: route({ repeat: 1 }), changedBy: refs.userId });
        aInserted();
        await gate;
        return v;
      });
      await aReady;
      const bOutcome = writeAskRoute(asOwner, { ...k, route: route({ repeat: 2 }) }).then(() => 'won' as const, (e: unknown) => e);
      await new Promise((r) => setTimeout(r, 300));
      releaseA();
      expect((await a).version).toBe(1);
      expect(await bOutcome).toMatchObject({ code: 'ask_route_version_conflict' });
      const history = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listAskRouteHistory(c, null, 'decision', 'start_after_reclassify'));
      expect(history.map((h) => [h.version, h.repeat])).toEqual([[1, 1]]);
      expect((await auditRows()).filter((r) => r.payload.decision_type === 'start_after_reclassify')).toHaveLength(1);
    });

    it('the database refuses a skipped or reused version, for a repo key and for the account key', async () => {
      for (const repoId of [refs.repoId, null]) {
        await write({ repoId, decisionType: 'nonbreaking_refactor_approach' });
        for (const version of [99, 1]) {
          await expect(
            withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
              c.query(
                `INSERT INTO ask_routes (account_id, repo_id, subject, decision_type, levels, hours, repeat, version, changed_by)
                 VALUES ($1, $2, 'decision', 'nonbreaking_refactor_approach', '[]', '[]', 0, $3, $4)`,
                [refs.accountId, repoId, version, refs.userId],
              ),
            ),
          ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        }
      }
    });

    it('created_at is the database clock whatever an insert says', async () => {
      const { rows } = await withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
        c.query(
          `INSERT INTO ask_routes (account_id, repo_id, subject, decision_type, levels, version, changed_by, created_at)
           VALUES ($1, NULL, 'decision', 'created_at_probe', '[]', 1, $2, '2001-01-01') RETURNING created_at`,
          [refs.accountId, refs.userId],
        ),
      );
      expect(rows[0].created_at.getFullYear()).toBeGreaterThan(2020);
    });

    it('a repo that has route history cannot be hard-deleted (NO ACTION), by anyone', async () => {
      await write({ repoId: refs.repoId, decisionType: '*' });
      await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`DELETE FROM repos WHERE id = $1`, [refs.repoId]))).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    });
  });

  describe('removing a route (tombstone) and the lookup', () => {
    let t: SeedRefs;
    const asT = { get pool() { return appUserPool; }, get principal() { return t.userId; } };
    const lookup = (decisionType = 'test_strategy_choice') =>
      withTenant(appUserPool, t.accountId, t.userId, (c) => resolveCurrentAskRoute(c, { repoId: t.repoId, subject: 'decision', decisionType }));
    const tk = (over: Partial<AskRouteKey> = {}): AskRouteKey => ({ accountId: t.accountId, repoId: null, subject: 'decision', decisionType: '*', ...over });

    beforeAll(async () => {
      t = await seedAccount(admin, randomUUID());
    });

    it('with no row there is no route: the R5 default', async () => {
      expect(await lookup()).toBeNull();
    });

    it('walks repo + type, repo + *, account + type, account + *, and a tombstone falls to the next', async () => {
      await writeAskRoute(asT, { ...tk(), route: route({ repeat: 1 }) });
      expect((await lookup())!.repeat).toBe(1);
      await writeAskRoute(asT, { ...tk({ decisionType: 'test_strategy_choice' }), route: route({ repeat: 2 }) });
      expect((await lookup())!.repeat).toBe(2);
      await writeAskRoute(asT, { ...tk({ repoId: t.repoId }), route: route({ repeat: 3 }) });
      expect((await lookup())!.repeat).toBe(3);
      await writeAskRoute(asT, { ...tk({ repoId: t.repoId, decisionType: 'test_strategy_choice' }), route: route({ levels: [level(ALL, 5)], repeat: 0 }) });
      expect((await lookup())!.levels[0]!.escalateAfterMinutes).toBe(5);
      // Remove them one by one; each removal is a new version and the lookup drops a step.
      const removed = await removeAskRoute(asT, tk({ repoId: t.repoId, decisionType: 'test_strategy_choice' }));
      expect(removed).toMatchObject({ version: 2, levels: [], hours: [], repeat: 0 });
      expect((await lookup())!.repeat).toBe(3);
      await removeAskRoute(asT, tk({ repoId: t.repoId }));
      expect((await lookup())!.repeat).toBe(2);
      await removeAskRoute(asT, tk({ decisionType: 'test_strategy_choice' }));
      expect((await lookup())!.repeat).toBe(1);
      await removeAskRoute(asT, tk());
      expect(await lookup()).toBeNull();
    });

    it('a removed route is in the history as a version with no levels, and the plan equals the R5 default', async () => {
      const history = await withTenant(appUserPool, t.accountId, t.userId, (c) => listAskRouteHistory(c, null, 'decision', '*'));
      expect(history.map((h) => h.levels.length)).toEqual([1, 0]);
      const raised = new Date('2026-06-01T12:00:00Z');
      const due = new Date('2026-06-02T12:00:00Z');
      const members = [{ memberId: t.userId, role: 'owner' as const }];
      const plan = planEscalation(await lookup(), raised, due, raised, members);
      expect(plan.routed).toBe(false);
      expect(plan.steps.map((s) => s.kind)).toEqual(['default_raise', 'default_overdue']);
    });

    it('removing a member from the account does not break a route: that step falls back to all owners and admins', async () => {
      const gone = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [gone, `${gone}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [t.accountId, gone]);
      await writeAskRoute(asT, { ...tk({ decisionType: 'nonbreaking_refactor_approach' }), route: route({ levels: [level({ type: 'member', memberId: gone })] }) });
      await admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [t.accountId, gone]);
      const r = await lookup('nonbreaking_refactor_approach');
      const at = new Date('2026-06-01T12:00:00Z');
      const plan = planEscalation(r, at, new Date('2026-06-08T12:00:00Z'), at, [{ memberId: t.userId, role: 'owner' }]);
      expect(plan.steps.map((s) => [s.memberId, s.fellBack])).toEqual([[t.userId, true]]);
    });
  });

  describe('the audit allowlist', () => {
    // audit_write is replaced whole by every migration that adds an action, and the last file wins. This pins the full set, so a later
    // migration that forgets to carry one entry forward fails here instead of silently dropping it.
    const EXPECTED_ACTIONS = [
      'decision_dial_changed',
      'model_connection.connect',
      'model_connection.replace',
      'model_connection.remove',
      'role_settings.mode_changed',
      'role_settings.guard_changed',
      'role_settings.model_changed',
      'run_limits.changed',
      'decision_ask_setting.changed',
      'ask_route.changed',
    ];

    it('audit_write accepts every expected action', async () => {
      for (const action of EXPECTED_ACTIONS) {
        await withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write($1, '{}'::jsonb)`, [action]));
      }
    });

    it("the definition lists exactly the expected actions (an action added later is added here in the same PR)", async () => {
      const { rows } = await admin.query<{ def: string }>(`SELECT pg_get_functiondef('audit_write(text, jsonb)'::regprocedure) AS def`);
      const array = /ARRAY\[([^\]]*)\]/.exec(rows[0]!.def)?.[1] ?? '';
      const listed = [...array.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      expect([...listed].sort()).toEqual([...EXPECTED_ACTIONS].sort());
    });

    it('still refuses an unlisted action and a NULL one', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write('ask_route.deleted', '{}'::jsonb)`)),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write(NULL, '{}'::jsonb)`)),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });
});
