import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF1 } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 H12 / PR #89, migration 0011: audit_write's allowlist grows two
 * entries -- 'role_settings.mode_changed' and 'role_settings.guard_changed'
 * -- for packages/core/src/role-settings/auditLog.ts's
 * writeRoleSettingsAuditLog, converted off a raw `INSERT INTO audit_log`
 * onto `audit_write` after D#76 (migration 0008) revoked app_user's
 * INSERT grant on audit_log outright. Every other allowlist entry and
 * every other audit_write behaviour is already covered by
 * audit-log-append-only.test.ts -- this file only exercises what 0011
 * changes.
 */
describe('audit_write: role-settings actions accepted after migration 0011', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it.each(['role_settings.mode_changed', 'role_settings.guard_changed'])(
    "'%s' is accepted: returns a uuid, and the row lands with the verified actor",
    async (action) => {
      const f1 = await seedF1(admin);
      const { rows } = await withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
        client.query<{ audit_write: string }>(`SELECT audit_write($1, $2::jsonb)`, [
          action,
          JSON.stringify({ repoId: 'r1', role: 'debater', mode: 'always' }),
        ]),
      );
      const id = rows[0]!.audit_write;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const { rows: adminRows } = await admin.query<{
        account_id: string;
        actor: string;
        action: string;
        payload: { repoId: string; role: string; mode: string };
      }>(`SELECT account_id, actor, action, payload FROM audit_log WHERE id = $1`, [id]);
      expect(adminRows).toHaveLength(1);
      const row = adminRows[0]!;
      expect(row.account_id).toBe(f1.accountId);
      expect(row.actor).toBe(f1.o1);
      expect(row.action).toBe(action);
      expect(row.payload).toEqual({ repoId: 'r1', role: 'debater', mode: 'always' });
    },
  );

  it('a member (not the owner) calling role_settings.guard_changed is stamped with the MEMBER as actor, not a forged one', async () => {
    const f1 = await seedF1(admin);
    const { rows } = await withTenant(appUserPool, f1.accountId, f1.m1, (client) =>
      client.query<{ audit_write: string }>(
        `SELECT audit_write('role_settings.guard_changed', jsonb_build_object('actor', $1::text))`,
        [f1.o1],
      ),
    );
    const id = rows[0]!.audit_write;
    const { rows: adminRows } = await admin.query<{ actor: string; payload: { actor: string } }>(
      `SELECT actor, payload FROM audit_log WHERE id = $1`,
      [id],
    );
    expect(adminRows[0]!.actor).toBe(f1.m1);
    expect(adminRows[0]!.payload.actor).toBe(f1.m1);
  });

  it("an action still NOT on the allowlist ('role_settings.bogus') is rejected: 22023, no row added", async () => {
    const f1 = await seedF1(admin);
    const before = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
      f1.accountId,
    ]);
    await expect(
      withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
        client.query(`SELECT audit_write('role_settings.bogus', NULL)`),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    const after = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
      f1.accountId,
    ]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('the pre-existing allowlist entries still work unchanged (decision_dial_changed)', async () => {
    const f1 = await seedF1(admin);
    const { rows } = await withTenant(appUserPool, f1.accountId, f1.o1, (client) =>
      client.query<{ audit_write: string }>(`SELECT audit_write('decision_dial_changed', NULL)`),
    );
    expect(rows[0]!.audit_write).toMatch(/^[0-9a-f-]{36}$/);
  });
});
