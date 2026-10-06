import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { ForbiddenError } from '../src/errors.js';
import {
  PLAN_PATH_KINDS,
  NOTICE_VERSIONS,
  UnknownPlanKindError,
  isKindEnabled,
  isKindEnabledWithClient,
  listKindSwitches,
  setKindEnabled,
  recordAcknowledgement,
  hasAcknowledgement,
  hasAcknowledgementWithClient,
} from '../src/index.js';
import { seedAccountWithMember } from './helpers/seed.js';

describe('KS part 1: kill switch store and notice acknowledgement', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });
  beforeEach(async () => {
    await admin.query(`UPDATE plan_kind_switches SET enabled = false, updated_by = 'test-reset'`);
    await admin.query('DELETE FROM plan_kind_switch_audit');
  });

  describe('switch store', () => {
    it('both switches ship OFF, and one row exists per kind', async () => {
      const all = await listKindSwitches(appUserPool);
      expect(all.map((s) => s.kind)).toEqual([...PLAN_PATH_KINDS]);
      expect(all.every((s) => s.enabled === false)).toBe(true);
      for (const kind of PLAN_PATH_KINDS) expect(await isKindEnabled(appUserPool, kind)).toBe(false);
    });

    it('a flip is visible at once to the app role, per kind, and is reversible', async () => {
      await setKindEnabled(platformOpsPool, 'chatgpt_oauth', true, 'ops:alice');
      expect(await isKindEnabled(appUserPool, 'chatgpt_oauth')).toBe(true);
      expect(await isKindEnabled(appUserPool, 'codex_access_token')).toBe(false);
      await setKindEnabled(platformOpsPool, 'chatgpt_oauth', false, 'ops:alice');
      expect(await isKindEnabled(appUserPool, 'chatgpt_oauth')).toBe(false);
    });

    it('an unknown kind reads as off and cannot be set', async () => {
      expect(await isKindEnabled(appUserPool, 'openai_api_key')).toBe(false);
      expect(await isKindEnabled(appUserPool, '')).toBe(false);
      await expect(setKindEnabled(platformOpsPool, 'openai_api_key', true, 'ops:alice')).rejects.toBeInstanceOf(
        UnknownPlanKindError,
      );
    });

    it('a missing row reads as off (fail closed)', async () => {
      await admin.query('BEGIN');
      try {
        await admin.query(`DELETE FROM plan_kind_switches WHERE kind = 'chatgpt_oauth'`);
        const { rows } = await admin.query(`SELECT enabled FROM plan_kind_switches WHERE kind = 'chatgpt_oauth'`);
        expect(rows).toHaveLength(0);
        expect(await isKindEnabledWithClient(admin, 'chatgpt_oauth')).toBe(false);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('only platform_ops may write: app_user gets permission denied, and the state does not move', async () => {
      await expect(setKindEnabled(appUserPool, 'chatgpt_oauth', true, 'tenant')).rejects.toMatchObject({ code: '42501' });
      await expect(
        appUserPool.query(`UPDATE plan_kind_switches SET enabled = true WHERE kind = 'chatgpt_oauth'`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(appUserPool.query(`INSERT INTO plan_kind_switches (kind) VALUES ('chatgpt_oauth')`)).rejects.toMatchObject({
        code: '42501',
      });
      expect(await isKindEnabled(appUserPool, 'chatgpt_oauth')).toBe(false);
    });

    it('platform_ops cannot add, remove or rename a kind', async () => {
      await expect(
        platformOpsPool.query(`INSERT INTO plan_kind_switches (kind) VALUES ('opencode')`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(platformOpsPool.query(`DELETE FROM plan_kind_switches`)).rejects.toMatchObject({ code: '42501' });
      await expect(platformOpsPool.query(`UPDATE plan_kind_switches SET kind = 'x'`)).rejects.toMatchObject({ code: '42501' });
    });

    it('actor is required and bounded', async () => {
      await expect(setKindEnabled(platformOpsPool, 'chatgpt_oauth', true, '')).rejects.toBeInstanceOf(TypeError);
      await expect(setKindEnabled(platformOpsPool, 'chatgpt_oauth', true, 'x'.repeat(201))).rejects.toBeInstanceOf(TypeError);
      await expect(setKindEnabled(platformOpsPool, 'chatgpt_oauth', 'yes' as unknown as boolean, 'a')).rejects.toBeInstanceOf(
        TypeError,
      );
    });
  });

  describe('audit on every flip', () => {
    it('each flip writes exactly one row with the previous state and the actor; a no-op flip writes none', async () => {
      const first = await setKindEnabled(platformOpsPool, 'codex_access_token', true, 'ops:alice');
      const noop = await setKindEnabled(platformOpsPool, 'codex_access_token', true, 'ops:bob');
      const off = await setKindEnabled(platformOpsPool, 'codex_access_token', false, 'ops:bob');
      expect([first.changed, noop.changed, off.changed]).toEqual([true, false, true]);
      const { rows } = await admin.query(
        `SELECT kind, previous_enabled, enabled, actor FROM plan_kind_switch_audit ORDER BY changed_at, id`,
      );
      expect(rows).toEqual([
        { kind: 'codex_access_token', previous_enabled: false, enabled: true, actor: 'ops:alice' },
        { kind: 'codex_access_token', previous_enabled: true, enabled: false, actor: 'ops:bob' },
      ]);
    });

    it('a hand-typed UPDATE by platform_ops is audited too (the trigger, not the helper, is the guarantee)', async () => {
      await platformOpsPool.query(
        `UPDATE plan_kind_switches SET enabled = true, updated_by = 'ops:psql' WHERE kind = 'chatgpt_oauth'`,
      );
      const { rows } = await admin.query(`SELECT actor, enabled FROM plan_kind_switch_audit`);
      expect(rows).toEqual([{ actor: 'ops:psql', enabled: true }]);
    });

    it('a hand-typed flip that leaves out updated_by is refused, and nothing moves or is audited', async () => {
      await setKindEnabled(platformOpsPool, 'chatgpt_oauth', true, 'ops:alice');
      await expect(
        platformOpsPool.query(`UPDATE plan_kind_switches SET enabled = false WHERE kind = 'chatgpt_oauth'`),
      ).rejects.toMatchObject({ code: '22023' });
      expect(await isKindEnabled(appUserPool, 'chatgpt_oauth')).toBe(true);
      const { rows } = await admin.query('SELECT actor FROM plan_kind_switch_audit');
      expect(rows).toEqual([{ actor: 'ops:alice' }]);
    });

    it('the mark of one update is not reused by a later update in the same transaction', async () => {
      const client = await platformOpsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE plan_kind_switches SET enabled = true, updated_by = 'ops:a' WHERE kind = 'chatgpt_oauth'`);
        await expect(client.query(`UPDATE plan_kind_switches SET enabled = false WHERE kind = 'chatgpt_oauth'`)).rejects.toMatchObject({
          code: '22023',
        });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('the same actor can flip twice in a row, and updated_at is set by the database', async () => {
      await setKindEnabled(platformOpsPool, 'chatgpt_oauth', true, 'ops:alice');
      await platformOpsPool.query(
        `UPDATE plan_kind_switches SET enabled = false, updated_by = 'ops:alice', updated_at = '2001-01-01' WHERE kind = 'chatgpt_oauth'`,
      );
      const { rows } = await admin.query(`SELECT updated_at FROM plan_kind_switches WHERE kind = 'chatgpt_oauth'`);
      expect(rows[0].updated_at.getFullYear()).toBeGreaterThan(2020);
      const audit = await admin.query('SELECT actor FROM plan_kind_switch_audit');
      expect(audit.rows).toHaveLength(2);
    });

    it('the audit row records the database login, which the caller cannot choose', async () => {
      await platformOpsPool.query(
        `UPDATE plan_kind_switches SET enabled = true, updated_by = 'ops:someone-else' WHERE kind = 'chatgpt_oauth'`,
      );
      const { rows } = await admin.query('SELECT actor, db_session_user FROM plan_kind_switch_audit');
      expect(rows).toEqual([{ actor: 'ops:someone-else', db_session_user: 'platform_ops' }]);
    });

    it('platform_ops cannot insert a forged or back-dated audit row (42501), and cannot call the trigger function', async () => {
      await expect(
        platformOpsPool.query(
          `INSERT INTO plan_kind_switch_audit (kind, previous_enabled, enabled, actor, db_session_user, changed_at)
           VALUES ('chatgpt_oauth', false, true, 'ops:forged', 'x', '2020-01-01')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(platformOpsPool.query(`SELECT plan_kind_switch_audit_trg()`)).rejects.toMatchObject({ code: '42501' });
      // The helper is callable by platform_ops (its trigger runs as the invoker) but only from inside the trigger.
      await expect(platformOpsPool.query(`SELECT plan_kind_switch_audit_write('chatgpt_oauth')`)).rejects.toMatchObject({ code: '42501' });
      await expect(appUserPool.query(`SELECT plan_kind_switch_audit_write('chatgpt_oauth')`)).rejects.toMatchObject({ code: '42501' });
      const { rows } = await admin.query('SELECT 1 FROM plan_kind_switch_audit');
      expect(rows).toHaveLength(0);
    });

    it('the audit helper is owned by the dedicated NOLOGIN writer role, which holds INSERT on the audit table only (plus its three-column read)', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'plan_kind_switch_audit_write'`,
      );
      expect(rows).toEqual([
        { owner: 'plan_kind_audit_writer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'] },
      ]);
      const role = await admin.query(
        `SELECT rolcanlogin, rolsuper, rolcreaterole, rolbypassrls, rolreplication, rolcreatedb FROM pg_roles WHERE rolname = 'plan_kind_audit_writer'`,
      );
      expect(role.rows).toEqual([
        { rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false, rolcreatedb: false },
      ]);
      const members = await admin.query(
        `SELECT 1 FROM pg_auth_members WHERE roleid = 'plan_kind_audit_writer'::regrole OR member = 'plan_kind_audit_writer'::regrole`,
      );
      expect(members.rows).toHaveLength(0);
      const grants = await admin.query(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'plan_kind_audit_writer'`,
      );
      expect(grants.rows).toEqual([{ table_name: 'plan_kind_switch_audit', privilege_type: 'INSERT' }]);
      const cols = await admin.query(
        `SELECT column_name, privilege_type FROM information_schema.role_column_grants
          WHERE grantee = 'plan_kind_audit_writer' AND table_name = 'plan_kind_switches' ORDER BY column_name`,
      );
      expect(cols.rows).toEqual([
        { column_name: 'enabled', privilege_type: 'SELECT' },
        { column_name: 'kind', privilege_type: 'SELECT' },
        { column_name: 'updated_by', privilege_type: 'SELECT' },
      ]);
      const trg = await admin.query(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef FROM pg_proc WHERE proname = 'plan_kind_switch_audit_trg'`,
      );
      expect(trg.rows).toEqual([{ owner: (await admin.query('SELECT current_user')).rows[0].current_user, prosecdef: false }]);
    });

    it('a rolled-back flip leaves neither the state nor an audit row', async () => {
      const client = await platformOpsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE plan_kind_switches SET enabled = true, updated_by = 'ops:x' WHERE kind = 'chatgpt_oauth'`);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await isKindEnabled(appUserPool, 'chatgpt_oauth')).toBe(false);
      const { rows } = await admin.query('SELECT 1 FROM plan_kind_switch_audit');
      expect(rows).toHaveLength(0);
    });

    it('platform_ops cannot edit or delete audit rows; app_user cannot read or write them', async () => {
      await setKindEnabled(platformOpsPool, 'chatgpt_oauth', true, 'ops:alice');
      await expect(platformOpsPool.query(`UPDATE plan_kind_switch_audit SET actor = 'x'`)).rejects.toMatchObject({ code: '42501' });
      await expect(platformOpsPool.query(`DELETE FROM plan_kind_switch_audit`)).rejects.toMatchObject({ code: '42501' });
      await expect(platformOpsPool.query(`TRUNCATE plan_kind_switch_audit`)).rejects.toMatchObject({ code: '42501' });
      await expect(appUserPool.query(`SELECT * FROM plan_kind_switch_audit`)).rejects.toMatchObject({ code: '42501' });
      await expect(
        appUserPool.query(`INSERT INTO plan_kind_switch_audit (kind, previous_enabled, enabled, actor, db_session_user) VALUES ('chatgpt_oauth', false, true, 'a', 'a')`),
      ).rejects.toMatchObject({ code: '42501' });
      const { rows } = await admin.query('SELECT 1 FROM plan_kind_switch_audit');
      expect(rows).toHaveLength(1);
    });
  });

  describe('notice acknowledgement', () => {
    it('records the current version with a server time, and is idempotent', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const connectionId = randomUUID();
      const before = Date.now();
      const a = await recordAcknowledgement({ pool: appUserPool, principal: t }, { connectionId, kind: 'chatgpt_oauth' });
      const b = await recordAcknowledgement({ pool: appUserPool, principal: t }, { connectionId, kind: 'chatgpt_oauth' });
      expect(a.notice_version).toBe(NOTICE_VERSIONS.chatgpt_oauth);
      expect(a.acknowledged_at.getTime()).toBeGreaterThanOrEqual(before - 5000);
      expect(b.acknowledged_at.getTime()).toBe(a.acknowledged_at.getTime());
      const { rows } = await admin.query(`SELECT acknowledged_by FROM plan_notice_acks WHERE connection_id = $1`, [connectionId]);
      expect(rows).toEqual([{ acknowledged_by: t.userId }]);
    });

    it('hasAcknowledgement is per connection and per kind', async () => {
      const t = await seedAccountWithMember(admin, 'admin');
      const c1 = randomUUID();
      await recordAcknowledgement({ pool: appUserPool, principal: t }, { connectionId: c1, kind: 'codex_access_token' });
      expect(await hasAcknowledgement(appUserPool, t.accountId, c1, 'codex_access_token')).toBe(true);
      expect(await hasAcknowledgement(appUserPool, t.accountId, c1, 'chatgpt_oauth')).toBe(false);
      expect(await hasAcknowledgement(appUserPool, t.accountId, randomUUID(), 'codex_access_token')).toBe(false);
      expect(await hasAcknowledgement(appUserPool, t.accountId, 'not-a-uuid', 'codex_access_token')).toBe(false);
      expect(await hasAcknowledgement(appUserPool, t.accountId, c1, 'openai_api_key')).toBe(false);
      const inClient = await withTenant(appUserPool, t.accountId, (c) => hasAcknowledgementWithClient(c, c1, 'codex_access_token'));
      expect(inClient).toBe(true);
    });

    it('the database bounds notice_version to the known versions, and every current version is allowed', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const ins = (v: string, kind = 'chatgpt_oauth') =>
        admin.query(
          `INSERT INTO plan_notice_acks (account_id, connection_id, kind, notice_version, acknowledged_by) VALUES ($1,$2,$3,$4,$5)`,
          [t.accountId, randomUUID(), kind, v, t.userId],
        );
      await expect(ins('v0')).rejects.toMatchObject({ code: '23514' });
      await expect(ins('v2')).rejects.toMatchObject({ code: '23514' });
      for (const k of PLAN_PATH_KINDS) await expect(ins(NOTICE_VERSIONS[k], k)).resolves.toBeDefined();
    });

    it('app_user cannot set acknowledged_at or id (the server clock holds)', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      await expect(
        withTenant(appUserPool, t.accountId, t.userId, (cl) =>
          cl.query(
            `INSERT INTO plan_notice_acks (account_id, connection_id, kind, notice_version, acknowledged_by, acknowledged_at) VALUES ($1,$2,'chatgpt_oauth','v1',$3,'1999-01-01')`,
            [t.accountId, randomUUID(), t.userId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(appUserPool, t.accountId, t.userId, (cl) =>
          cl.query(
            `INSERT INTO plan_notice_acks (id, account_id, connection_id, kind, notice_version, acknowledged_by) VALUES ($1,$2,$3,'chatgpt_oauth','v1',$4)`,
            [randomUUID(), t.accountId, randomUUID(), t.userId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('hasAcknowledgementWithClient scopes by account even for a client that bypasses RLS', async () => {
      const a = await seedAccountWithMember(admin, 'owner');
      const b = await seedAccountWithMember(admin, 'owner');
      const c = randomUUID();
      await recordAcknowledgement({ pool: appUserPool, principal: a }, { connectionId: c, kind: 'chatgpt_oauth' });
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('app.account_id', $1, true)`, [b.accountId]);
        expect(await hasAcknowledgementWithClient(admin, c, 'chatgpt_oauth')).toBe(false);
        await admin.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
        expect(await hasAcknowledgementWithClient(admin, c, 'chatgpt_oauth')).toBe(true);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('another tenant cannot see or use an acknowledgement', async () => {
      const a = await seedAccountWithMember(admin, 'owner');
      const b = await seedAccountWithMember(admin, 'owner');
      const c = randomUUID();
      await recordAcknowledgement({ pool: appUserPool, principal: a }, { connectionId: c, kind: 'chatgpt_oauth' });
      expect(await hasAcknowledgement(appUserPool, b.accountId, c, 'chatgpt_oauth')).toBe(false);
      const seen = await withTenant(appUserPool, b.accountId, async (cl) => (await cl.query('SELECT 1 FROM plan_notice_acks')).rows);
      expect(seen).toHaveLength(0);
    });

    it('a plain member cannot record one (and nothing is written)', async () => {
      const t = await seedAccountWithMember(admin, 'member');
      const c = randomUUID();
      await expect(
        recordAcknowledgement({ pool: appUserPool, principal: t }, { connectionId: c, kind: 'chatgpt_oauth' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const { rows } = await admin.query('SELECT 1 FROM plan_notice_acks WHERE connection_id = $1', [c]);
      expect(rows).toHaveLength(0);
    });

    it('the database also refuses forged rows: wrong account, another user, a member, a different user id', async () => {
      const a = await seedAccountWithMember(admin, 'owner');
      const other = await seedAccountWithMember(admin, 'owner');
      const member = await seedAccountWithMember(admin, 'member');
      const insert = (accountId: string, sessionAccount: string, sessionUser: string, by: string) =>
        withTenant(appUserPool, sessionAccount, sessionUser, (cl) =>
          cl.query(
            `INSERT INTO plan_notice_acks (account_id, connection_id, kind, notice_version, acknowledged_by) VALUES ($1,$2,'chatgpt_oauth','v1',$3)`,
            [accountId, randomUUID(), by],
          ),
        );
      await expect(insert(other.accountId, a.accountId, a.userId, a.userId)).rejects.toMatchObject({ code: '42501' });
      await expect(insert(a.accountId, a.accountId, a.userId, other.userId)).rejects.toMatchObject({ code: '42501' });
      await expect(insert(member.accountId, member.accountId, member.userId, member.userId)).rejects.toMatchObject({ code: '42501' });
    });

    it('rows are insert-only for the app role', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const c = randomUUID();
      await recordAcknowledgement({ pool: appUserPool, principal: t }, { connectionId: c, kind: 'chatgpt_oauth' });
      await expect(
        withTenant(appUserPool, t.accountId, t.userId, (cl) => cl.query(`UPDATE plan_notice_acks SET notice_version = 'v9'`)),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(appUserPool, t.accountId, t.userId, (cl) => cl.query(`DELETE FROM plan_notice_acks`)),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('an unknown kind or malformed connection id is rejected before any write', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      await expect(
        recordAcknowledgement({ pool: appUserPool, principal: t }, { connectionId: randomUUID(), kind: 'openai_api_key' }),
      ).rejects.toBeInstanceOf(UnknownPlanKindError);
      await expect(
        recordAcknowledgement({ pool: appUserPool, principal: t }, { connectionId: 'nope', kind: 'chatgpt_oauth' }),
      ).rejects.toBeInstanceOf(TypeError);
      const { rows } = await admin.query('SELECT 1 FROM plan_notice_acks WHERE account_id = $1', [t.accountId]);
      expect(rows).toHaveLength(0);
    });
  });
});
