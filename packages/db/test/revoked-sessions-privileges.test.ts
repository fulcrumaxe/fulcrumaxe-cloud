import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#37 WS-C2 fix round 1 (W2, CWE-732, correction C15a's acceptance_files:
 * "a privileges test in packages/db/test/"). This used to be two partial
 * checks inside packages/core/test/pg/identity.test.ts (app_user SELECT
 * and INSERT only, no UPDATE/DELETE, no PUBLIC check, and not in this
 * directory at all) plus one test that asserted platform_ops could NOT
 * DELETE -- itself the E1 deviation (CWE-770/400: an unprunable,
 * permanently growing table) locked in as though it were the spec. Both
 * the security review and the code review on PR #119 caught this.
 *
 * `revoked_sessions` is global (no `account_id`), the same shape as
 * `users` (0001_core.sql) -- there is nothing for a tenant_isolation-style
 * policy to gate on, so app_user and platform_ops are queried directly,
 * the same pattern packages/db/test/ledger-audit-log-privileges.test.ts
 * and packages/db/test/model-routing-privileges.test.ts already use for
 * their own platform-wide tables.
 *
 * Full matrix from 0609_revoked_sessions.sql: platform_ops gets SELECT,
 * INSERT, DELETE (no UPDATE -- nothing un-revokes or edits a revocation
 * record). app_user gets nothing at all, not even SELECT. PUBLIC gets
 * nothing either.
 */
describe('revoked_sessions privileges (D#37 WS-C2 fix round 1, correction C15a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let userId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);

    userId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `${userId}@example.test`,
    ]);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  describe('app_user: no grant at all', () => {
    it('app_user cannot SELECT from revoked_sessions', async () => {
      await expect(appUserPool.query('SELECT 1 FROM revoked_sessions LIMIT 1')).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    });

    it('app_user cannot INSERT into revoked_sessions', async () => {
      await expect(
        appUserPool.query(
          'INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval \'1 day\')',
          [randomUUID(), userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot UPDATE a revoked_sessions row', async () => {
      const sid = randomUUID();
      await admin.query(
        "INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [sid, userId],
      );
      await expect(
        appUserPool.query('UPDATE revoked_sessions SET revoked_at = now() WHERE session_id = $1', [sid]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot DELETE a revoked_sessions row', async () => {
      const sid = randomUUID();
      await admin.query(
        "INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [sid, userId],
      );
      await expect(
        appUserPool.query('DELETE FROM revoked_sessions WHERE session_id = $1', [sid]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Confirms the DELETE genuinely never happened.
      const { rows } = await admin.query('SELECT 1 FROM revoked_sessions WHERE session_id = $1', [sid]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('platform_ops: SELECT, INSERT, DELETE -- no UPDATE', () => {
    it('platform_ops can SELECT', async () => {
      const sid = randomUUID();
      await admin.query(
        "INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [sid, userId],
      );
      const { rows } = await platformOpsPool.query('SELECT 1 FROM revoked_sessions WHERE session_id = $1', [sid]);
      expect(rows).toHaveLength(1);
    });

    it('platform_ops can INSERT', async () => {
      const sid = randomUUID();
      await expect(
        platformOpsPool.query(
          "INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
          [sid, userId],
        ),
      ).resolves.toBeDefined();
    });

    /**
     * Fix round 1 (E1, CWE-770/400): this is the direct replacement for
     * the deleted "platform_ops cannot UPDATE or DELETE" test -- at head
     * 1714660624b15ac0c7c92c6f4a8b6477dd31a747 platform_ops has no
     * DELETE grant on this table (append-only by the pre-fix-round
     * design), so this assertion fails there with INSUFFICIENT_PRIVILEGE
     * instead of resolving.
     */
    it('platform_ops CAN DELETE (the E1 fix -- no longer append-only)', async () => {
      const sid = randomUUID();
      await admin.query(
        "INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [sid, userId],
      );
      await expect(
        platformOpsPool.query('DELETE FROM revoked_sessions WHERE session_id = $1', [sid]),
      ).resolves.toBeDefined();

      const { rows } = await admin.query('SELECT 1 FROM revoked_sessions WHERE session_id = $1', [sid]);
      expect(rows).toHaveLength(0);
    });

    it('platform_ops cannot UPDATE (no UPDATE grant -- nothing un-revokes or edits a revocation record)', async () => {
      const sid = randomUUID();
      await admin.query(
        "INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [sid, userId],
      );
      await expect(
        platformOpsPool.query('UPDATE revoked_sessions SET revoked_at = now() WHERE session_id = $1', [sid]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('grant matrix (has_table_privilege, declarative check independent of RLS)', () => {
    it('app_user: SELECT/INSERT/UPDATE/DELETE are all false', async () => {
      const { rows } = await admin.query<{ priv: string; has: boolean }>(
        `SELECT priv, has_table_privilege('app_user', 'revoked_sessions', priv) AS has
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv`,
      );
      const byPriv = new Map(rows.map((r) => [r.priv, r.has]));
      expect(byPriv.get('SELECT')).toBe(false);
      expect(byPriv.get('INSERT')).toBe(false);
      expect(byPriv.get('UPDATE')).toBe(false);
      expect(byPriv.get('DELETE')).toBe(false);
    });

    it('platform_ops: SELECT/INSERT/DELETE are true, UPDATE is false', async () => {
      const { rows } = await admin.query<{ priv: string; has: boolean }>(
        `SELECT priv, has_table_privilege('platform_ops', 'revoked_sessions', priv) AS has
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv`,
      );
      const byPriv = new Map(rows.map((r) => [r.priv, r.has]));
      expect(byPriv.get('SELECT')).toBe(true);
      expect(byPriv.get('INSERT')).toBe(true);
      expect(byPriv.get('UPDATE')).toBe(false);
      expect(byPriv.get('DELETE')).toBe(true);
    });

    /** PUBLIC holds no grant on this table -- a role with no explicit grant of its own must still fail closed, not inherit anything through PUBLIC. */
    it('PUBLIC: SELECT/INSERT/UPDATE/DELETE are all false', async () => {
      const { rows } = await admin.query<{ priv: string; has: boolean }>(
        `SELECT priv, has_table_privilege('public', 'revoked_sessions', priv) AS has
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv`,
      );
      const byPriv = new Map(rows.map((r) => [r.priv, r.has]));
      expect(byPriv.get('SELECT')).toBe(false);
      expect(byPriv.get('INSERT')).toBe(false);
      expect(byPriv.get('UPDATE')).toBe(false);
      expect(byPriv.get('DELETE')).toBe(false);
    });
  });
});
