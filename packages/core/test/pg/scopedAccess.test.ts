import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../../src/tenancy/errors.js';
import { AGENT_RUN_COLUMNS, getTenantRowOrNotFound, type ScopedTable } from '../../src/tenancy/scopedAccess.js';

/**
 * H06 pass/fail item 3 (CWE-639): "a route handler test where account
 * A's session requests B's work_items, agent_runs, run_events stream or
 * settings gets 404 for each (not 403, which would leak existence)."
 *
 * The literal HTTP routes for these four resources belong to H09/H11
 * (work_items, agent_runs, run_events) and H12 (role_settings --
 * "settings" here) -- none of which exist yet. What H06 owns is the
 * generic, reusable data-access primitive every one of those routes will
 * call (getTenantRowOrNotFound), and every one of those tables already
 * exists in H02's schema, seeded here exactly as @fx/db's own test suite
 * seeds them. This proves the CWE-639 property at the layer H06 actually
 * controls: NotFoundError, uniformly, never a permission error that would
 * confirm the row exists on someone else's account.
 */
describe('CWE-639: cross-account row access returns NotFoundError, never a permission error', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  const cases: { table: ScopedTable; idOf: (refs: SeedRefs) => string }[] = [
    { table: 'work_items', idOf: (r) => r.workItemId },
    { table: 'agent_runs', idOf: (r) => r.runId },
  ];

  it.each(cases)(
    "account A requesting account B's own %s row gets NotFoundError",
    async ({ table, idOf }) => {
      await expect(
        getTenantRowOrNotFound(appUserPool, refsA.accountId, refsA.userId, table, idOf(refsB)),
      ).rejects.toThrow(NotFoundError);
    },
  );

  it("account A requesting account B's role_settings row gets NotFoundError", async () => {
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM role_settings WHERE account_id = $1',
      [refsB.accountId],
    );
    const roleSettingsId = rows[0]!.id;
    await expect(
      getTenantRowOrNotFound(appUserPool, refsA.accountId, refsA.userId, 'role_settings', roleSettingsId),
    ).rejects.toThrow(NotFoundError);
  });

  it("account A requesting account B's run_events row gets NotFoundError", async () => {
    const { rows } = await admin.query<{ id: string }>('SELECT id FROM run_events WHERE account_id = $1', [
      refsB.accountId,
    ]);
    const runEventId = rows[0]!.id;
    await expect(
      getTenantRowOrNotFound(appUserPool, refsA.accountId, refsA.userId, 'run_events', runEventId),
    ).rejects.toThrow(NotFoundError);
  });

  it('the agent_runs row never carries the outside meter tag or key reference, and the column list is the table less those two', async () => {
    await admin.query(`UPDATE agent_runs SET gateway_report_tag = $2, om_key_ref = $3 WHERE id = $1`, [refsA.runId, 'fxr_' + 'a'.repeat(26), 'b'.repeat(64)]);
    const row = await getTenantRowOrNotFound<Record<string, unknown>>(appUserPool, refsA.accountId, refsA.userId, 'agent_runs', refsA.runId);
    expect(row.id).toBe(refsA.runId);
    expect(Object.keys(row)).not.toContain('gateway_report_tag');
    expect(Object.keys(row)).not.toContain('om_key_ref');
    expect(JSON.stringify(row)).not.toMatch(/fxr_a{26}|b{64}/);
    const cols = (await admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_runs'`)).rows.map((r) => r.column_name);
    const listed = AGENT_RUN_COLUMNS.split(',').map((c) => c.trim());
    expect([...listed].sort()).toEqual(cols.filter((c) => c !== 'gateway_report_tag' && c !== 'om_key_ref').sort());
  });

  it('a genuinely nonexistent id also gets NotFoundError (same error as the cross-account case)', async () => {
    await expect(
      getTenantRowOrNotFound(appUserPool, refsA.accountId, refsA.userId, 'work_items', randomUUID()),
    ).rejects.toThrow(NotFoundError);
  });

  it("account A CAN fetch its OWN row (the check isn't just rejecting everything)", async () => {
    const row = await getTenantRowOrNotFound<{ id: string }>(
      appUserPool,
      refsA.accountId,
      refsA.userId,
      'work_items',
      refsA.workItemId,
    );
    expect(row.id).toBe(refsA.workItemId);
  });

  /**
   * Security fix round item 1 (CWE-613/CWE-639): the session cookie
   * lasts 30 days and cannot be revoked server-side, and every RLS
   * policy checks only app.account_id -- so, before this fix, a removed
   * member's still-valid old session kept full read access. This proves
   * removeMember's effect is enforced at the data-access layer itself,
   * independent of whatever route eventually calls it.
   */
  it("a member removed from the account gets NotFoundError on their still-valid old session", async () => {
    const refsC = await seedAccount(admin, randomUUID());

    // Confirm access works before removal -- proves the NotFoundError
    // below comes from removing membership, not some unrelated mistake.
    const before = await getTenantRowOrNotFound<{ id: string }>(
      appUserPool,
      refsC.accountId,
      refsC.userId,
      'work_items',
      refsC.workItemId,
    );
    expect(before.id).toBe(refsC.workItemId);

    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [
      refsC.accountId,
      refsC.userId,
    ]);

    // refsC.userId's accountId/userId pair is otherwise unchanged --
    // exactly what a 30-day-old session cookie still carries after
    // removeMember() has run server-side.
    await expect(
      getTenantRowOrNotFound(appUserPool, refsC.accountId, refsC.userId, 'work_items', refsC.workItemId),
    ).rejects.toThrow(NotFoundError);
  });
});
