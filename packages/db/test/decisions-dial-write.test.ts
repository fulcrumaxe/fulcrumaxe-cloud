import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writeDialSetting } from '../src/decisions.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

interface AuditPayload {
  actor: string;
  decision_type: string;
  repo_id: string;
  previous: string | null;
  new: string;
}

/**
 * DP2 item 6 / C8: a dial write by a plain member fails; the same write by
 * an owner (or admin) succeeds and produces an audit_log row naming the
 * actor and both the previous and new disposition.
 *
 * D#7 DP2 fix round (PR #54, code review needs-fix): `writeDialSetting`
 * used to take a free `changedBy` input field, so these tests used to be
 * able to pass ANY user id there regardless of who was actually calling.
 * That is exactly the impersonation hole the fix closes -- identity now
 * comes only from `ctx.principal`, so these tests call `withTenant`
 * themselves (as the real caller) and pass that SAME id as `ctx.principal`,
 * the only shape the new signature allows.
 */
describe('writeDialSetting: owner/admin only, append-only, audited', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let memberUserId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());

    // refs.userId is seeded as role 'owner' by seedAccount (test/helpers/seed.ts).
    // A second, plain 'member' user in the SAME account:
    memberUserId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      memberUserId,
      `${memberUserId}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
      refs.accountId,
      memberUserId,
    ]);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('a plain member cannot write a dial as themselves: rejected on privileges, no row and no audit trail written', async () => {
    await expect(
      writeDialSetting(
        { pool: appUserPool, principal: memberUserId },
        {
          accountId: refs.accountId,
          repoId: refs.repoId,
          decisionType: 'merge.fast-path',
          disposition: 'act',
        },
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

    const { rows: settingRows } = await admin.query(
      `SELECT 1 FROM decision_settings WHERE account_id = $1 AND decision_type = 'merge.fast-path'`,
      [refs.accountId],
    );
    expect(settingRows).toHaveLength(0);

    // The whole transaction rolled back -- the audit_log write inside
    // writeDialSetting() never ran either.
    const { rows: auditRows } = await admin.query(
      `SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'decision_dial_changed'`,
      [refs.accountId],
    );
    expect(auditRows).toHaveLength(0);
  });

  /**
   * D#7 DP2 fix round item (a): the impersonation attempt itself. A member
   * (a real, non-owner/admin account_members row) is the session's ACTUAL
   * identity (app.user_id), while the row attempted names a REAL admin of
   * the same account as `changed_by`. This is the exact shape
   * writeDialSetting()'s old free `changedBy` field would have let happen
   * end-to-end (INSERT + audit_log, both attributed to the admin instead of
   * the true caller). writeDialSetting() itself can no longer even express
   * this (there is no `changedBy` input any more, see WriteDialSettingInput),
   * so this drives the same two-statement shape writeDialSetting() uses
   * directly through withTenant() as the member, to prove the DB layer
   * alone -- not just the removed input field -- refuses it.
   */
  it('a member cannot write a dial naming a real admin as changed_by: refused, no decision_settings row and no audit_log row', async () => {
    const adminId = refs.userId; // seeded as 'owner' by seedAccount

    await expect(
      withTenant(appUserPool, refs.accountId, memberUserId, async (client) => {
        await client.query(
          `INSERT INTO decision_settings
             (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, 'merge.fast-path', 'act', 1, $3)`,
          [refs.accountId, refs.repoId, adminId],
        );
        await client.query(
          `INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`,
          [
            refs.accountId,
            adminId,
            'decision_dial_changed',
            JSON.stringify({ actor: adminId, decision_type: 'merge.fast-path', repo_id: refs.repoId }),
          ],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

    const { rows: settingRows } = await admin.query(
      `SELECT 1 FROM decision_settings WHERE account_id = $1 AND decision_type = 'merge.fast-path'`,
      [refs.accountId],
    );
    expect(settingRows).toHaveLength(0);

    const { rows: auditRows } = await admin.query(
      `SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'decision_dial_changed'`,
      [refs.accountId],
    );
    expect(auditRows).toHaveLength(0);
  });

  it('an owner CAN write a dial as themselves, and it produces an audit_log row naming the actor and both values', async () => {
    const written = await writeDialSetting(
      { pool: appUserPool, principal: refs.userId },
      {
        accountId: refs.accountId,
        repoId: refs.repoId,
        decisionType: 'merge.fast-path',
        disposition: 'act',
        preset: 'autonomous',
      },
    );
    expect(written.version).toBe(1);
    expect(written.disposition).toBe('act');
    expect(written.changedBy).toBe(refs.userId);

    const { rows } = await admin.query<{ actor: string; action: string; payload: AuditPayload }>(
      `SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action = 'decision_dial_changed'`,
      [refs.accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(refs.userId);
    expect(rows[0].payload.actor).toBe(refs.userId);
    expect(rows[0].payload.previous).toBeNull();
    expect(rows[0].payload.new).toBe('act');
  });

  it('a second owner write versions forward and the audit row names both the previous and new value', async () => {
    const written = await writeDialSetting(
      { pool: appUserPool, principal: refs.userId },
      {
        accountId: refs.accountId,
        repoId: refs.repoId,
        decisionType: 'merge.fast-path',
        disposition: 'ask',
      },
    );
    expect(written.version).toBe(2);
    expect(written.disposition).toBe('ask');

    const { rows } = await admin.query<{ payload: AuditPayload }>(
      `SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'decision_dial_changed' ORDER BY created_at DESC LIMIT 1`,
      [refs.accountId],
    );
    expect(rows[0].payload.previous).toBe('act');
    expect(rows[0].payload.new).toBe('ask');
  });

  it('an admin (not just an owner) can also write a dial as themselves, and audit_log.actor is the caller', async () => {
    const adminMemberUserId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      adminMemberUserId,
      `${adminMemberUserId}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      refs.accountId,
      adminMemberUserId,
    ]);

    const written = await writeDialSetting(
      { pool: appUserPool, principal: adminMemberUserId },
      {
        accountId: refs.accountId,
        repoId: refs.repoId,
        decisionType: 'agent.spawn',
        disposition: 'announce',
      },
    );
    expect(written).toMatchObject({ disposition: 'announce', version: 1, changedBy: adminMemberUserId });

    const { rows } = await admin.query<{ actor: string }>(
      `SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'decision_dial_changed'
       AND payload->>'decision_type' = 'agent.spawn'`,
      [refs.accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(adminMemberUserId);
  });

  /**
   * D#7 DP2 fix round item (c): pure RLS, no service layer, no privilege
   * gap -- BOTH identities involved are real admins of the same account.
   * app.user_id (the session, set the same way withTenant() sets it) names
   * one admin; changed_by on the INSERT names a DIFFERENT admin. The
   * owner_or_admin_insert policy's EXISTS check alone would pass for
   * EITHER identity here (both really are admins) -- this proves the
   * fix's `changed_by = app.user_id` conjunct is what refuses it, not the
   * membership/role check.
   */
  it('raw SQL as app_user: app.user_id and changed_by naming two DIFFERENT real admins is refused by RLS alone', async () => {
    const adminX = refs.userId; // seeded 'owner' by seedAccount -- owner counts as admin-tier here
    const adminY = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      adminY,
      `${adminY}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      refs.accountId,
      adminY,
    ]);

    await expect(
      withTenant(appUserPool, refs.accountId, adminX, async (client) => {
        await client.query(
          `INSERT INTO decision_settings
             (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, 'security.review', 'ask', 1, $3)`,
          [refs.accountId, refs.repoId, adminY],
        );
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

    const { rows } = await admin.query(
      `SELECT 1 FROM decision_settings WHERE account_id = $1 AND decision_type = 'security.review'`,
      [refs.accountId],
    );
    expect(rows).toHaveLength(0);
  });

  it('raw SQL as app_user: app.user_id matching changed_by, both the same real admin, is accepted by RLS alone', async () => {
    const adminX = refs.userId;

    await withTenant(appUserPool, refs.accountId, adminX, async (client) => {
      await client.query(
        `INSERT INTO decision_settings
           (account_id, repo_id, decision_type, disposition, version, changed_by)
         VALUES ($1, $2, 'cost.spend', 'ask', 1, $3)`,
        [refs.accountId, refs.repoId, adminX],
      );
    });

    const { rows } = await admin.query(
      `SELECT changed_by FROM decision_settings WHERE account_id = $1 AND decision_type = 'cost.spend'`,
      [refs.accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBe(adminX);
  });

  /**
   * D#7 DP2 fix round 3 (security review needs-fix on PR #54, SUGGESTION
   * item 5): a BEFORE INSERT trigger,
   * `decision_settings_enforce_next_version()`, now requires
   * `version = max(existing version for this key) + 1`, closing the raw-SQL
   * hole where an admin could jump straight to version 2147483647 and
   * permanently brick that key (the next real write fails on integer
   * overflow, with no UPDATE/DELETE available to app_user to recover). A
   * mismatch raises `check_violation` (23514) from the trigger itself, not
   * an RLS rejection -- see migrations/0400_decisions.sql's file header for
   * why this lives in a trigger rather than the owner_or_admin_insert
   * policy's WITH CHECK (a same-table subquery there hits Postgres'
   * "infinite recursion detected in policy", SQLSTATE 42P17).
   */
  describe('version = max+1 per key, enforced by a BEFORE INSERT trigger (fix round 3, SUGGESTION item 5)', () => {
    it('raw SQL as app_user: a fresh key must start at version 1 -- version 2147483647 for a never-written key is refused', async () => {
      const adminX = refs.userId;

      await expect(
        withTenant(appUserPool, refs.accountId, adminX, async (client) => {
          await client.query(
            `INSERT INTO decision_settings
               (account_id, repo_id, decision_type, disposition, version, changed_by)
             VALUES ($1, $2, 'security.review', 'ask', 2147483647, $3)`,
            [refs.accountId, refs.repoId, adminX],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

      const { rows } = await admin.query(
        `SELECT 1 FROM decision_settings WHERE account_id = $1 AND decision_type = 'security.review'`,
        [refs.accountId],
      );
      expect(rows).toHaveLength(0);
    });

    it('raw SQL as app_user: skipping ahead of the current max (writing version 3 when only version 1 exists) is refused', async () => {
      const adminX = refs.userId;

      await withTenant(appUserPool, refs.accountId, adminX, async (client) => {
        await client.query(
          `INSERT INTO decision_settings
             (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, 'archive.move', 'announce', 1, $3)`,
          [refs.accountId, refs.repoId, adminX],
        );
      });

      await expect(
        withTenant(appUserPool, refs.accountId, adminX, async (client) => {
          await client.query(
            `INSERT INTO decision_settings
               (account_id, repo_id, decision_type, disposition, version, changed_by)
             VALUES ($1, $2, 'archive.move', 'act', 3, $3)`,
            [refs.accountId, refs.repoId, adminX],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

      const { rows } = await admin.query<{ version: number }>(
        `SELECT version FROM decision_settings WHERE account_id = $1 AND decision_type = 'archive.move' ORDER BY version`,
        [refs.accountId],
      );
      expect(rows.map((r) => r.version)).toEqual([1]);

      // The correct next version (2) still succeeds -- proves the trigger
      // is checking "= max+1", not merely rejecting everything.
      await withTenant(appUserPool, refs.accountId, adminX, async (client) => {
        await client.query(
          `INSERT INTO decision_settings
             (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, 'archive.move', 'act', 2, $3)`,
          [refs.accountId, refs.repoId, adminX],
        );
      });

      const { rows: afterFix } = await admin.query<{ version: number }>(
        `SELECT version FROM decision_settings WHERE account_id = $1 AND decision_type = 'archive.move' ORDER BY version`,
        [refs.accountId],
      );
      expect(afterFix.map((r) => r.version)).toEqual([1, 2]);
    });

    it('raw SQL as app_user: re-inserting the same (already-written) version again is refused', async () => {
      const adminX = refs.userId;

      await withTenant(appUserPool, refs.accountId, adminX, async (client) => {
        await client.query(
          `INSERT INTO decision_settings
             (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, 'external.system', 'ask', 1, $3)`,
          [refs.accountId, refs.repoId, adminX],
        );
      });

      await expect(
        withTenant(appUserPool, refs.accountId, adminX, async (client) => {
          await client.query(
            `INSERT INTO decision_settings
               (account_id, repo_id, decision_type, disposition, version, changed_by)
             VALUES ($1, $2, 'external.system', 'ask', 1, $3)`,
            [refs.accountId, refs.repoId, adminX],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

      const { rows } = await admin.query(
        `SELECT 1 FROM decision_settings WHERE account_id = $1 AND decision_type = 'external.system'`,
        [refs.accountId],
      );
      expect(rows).toHaveLength(1);
    });

    it('writeDialSetting() itself still writes correct sequential versions end to end (unaffected by the new trigger)', async () => {
      const first = await writeDialSetting(
        { pool: appUserPool, principal: refs.userId },
        {
          accountId: refs.accountId,
          repoId: refs.repoId,
          decisionType: 'memory.write',
          disposition: 'ask',
        },
      );
      expect(first.version).toBe(1);

      const second = await writeDialSetting(
        { pool: appUserPool, principal: refs.userId },
        {
          accountId: refs.accountId,
          repoId: refs.repoId,
          decisionType: 'memory.write',
          disposition: 'act',
        },
      );
      expect(second.version).toBe(2);
    });
  });
});
