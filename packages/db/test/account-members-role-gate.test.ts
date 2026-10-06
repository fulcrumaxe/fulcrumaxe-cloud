import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { guardPoolTeardown } from './support/pool-teardown.js';
import { withTenant } from '../src/withTenant.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { setMemberRole } from '../../core/src/tenancy/membership.js';
import { provisionEphemeralPostgres } from './support/ephemeral-pg.js';
import {
  countOwners,
  readMemberRow,
  seedF1,
  seedF2,
  seedOutsideOwner,
  type F2Fixture,
  type MemberRole,
} from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

type MemberKey = 'o1' | 'o2' | 'a1' | 'a2' | 'm1' | 'm2';
type Outcome = 'A' | 'R' | 'L';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('account_members role gate (D#64)', () => {
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

  /** Attempts one UPDATE ... SET role = $newRole as `actorId`, never throwing -- callers classify the outcome themselves. */
  async function attemptUpdateRole(
    accountId: string,
    actorId: string,
    targetId: string,
    newRole: MemberRole,
  ): Promise<{ rowCount: number | null; error: { code?: string } | null }> {
    try {
      const rowCount = await withTenant(appUserPool, accountId, actorId, async (client) => {
        const result = await client.query(
          'UPDATE account_members SET role = $1 WHERE account_id = $2 AND user_id = $3',
          [newRole, accountId, targetId],
        );
        return result.rowCount;
      });
      return { rowCount, error: null };
    } catch (err) {
      return { rowCount: null, error: err as { code?: string } };
    }
  }

  /** Attempts one DELETE as `actorId`, never throwing. */
  async function attemptDelete(
    accountId: string,
    actorId: string,
    targetId: string,
  ): Promise<{ rowCount: number | null; error: { code?: string } | null }> {
    try {
      const rowCount = await withTenant(appUserPool, accountId, actorId, async (client) => {
        const result = await client.query(
          'DELETE FROM account_members WHERE account_id = $1 AND user_id = $2',
          [accountId, targetId],
        );
        return result.rowCount;
      });
      return { rowCount, error: null };
    } catch (err) {
      return { rowCount: null, error: err as { code?: string } };
    }
  }

  function expectRefused(result: { rowCount: number | null; error: { code?: string } | null }): void {
    if (result.error) {
      expect(result.error).toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } else {
      expect(result.rowCount).toBe(0);
    }
  }

  function expectLastOwner(result: { rowCount: number | null; error: { code?: string } | null }): void {
    expect(result.error).toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, message: expect.stringContaining('last owner') });
  }

  /**
   * D#64 criterion 1's "exactly one new migration, applied cleanly" has two
   * halves. This permanent half never references a git ref -- the old
   * `git diff --name-status origin/main -- packages/db/migrations/` shape
   * failed in CI ('fatal: bad revision origin/main', a shallow/ref-less
   * checkout) and would fail PERMANENTLY on main after merge, since a diff
   * against main is empty once this branch lands. The "new file vs main"
   * half is PR-shape evidence instead: verified from the PR diff and pasted
   * into the PR comment, not asserted by a test that runs after merge too.
   */
  describe('criterion 1: exactly one new migration file, applied cleanly', () => {
    it('0005_account_members_role_gate.sql exists in packages/db/migrations/', () => {
      const files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
      expect(files).toContain('0005_account_members_role_gate.sql');
    });

    it('no two migration files share a numeric prefix', () => {
      const files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
      const byPrefix = new Map<string, string[]>();
      for (const f of files) {
        const m = f.match(/^(\d+)_/);
        if (!m) continue;
        const prefix = m[1]!;
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
      }
      const duplicates = [...byPrefix.entries()].filter(([, matches]) => matches.length > 1);
      expect(duplicates).toEqual([]);
    });

    it('the full migration chain applies cleanly on a fresh ephemeral Postgres', async () => {
      const expectedFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      const provisioned = await provisionEphemeralPostgres({
        database: 'fx_db_criterion1',
        tmpPrefix: 'fx-db-criterion1-pg-',
      });
      try {
        const pool = createPool(provisioned.url);
        const guard = guardPoolTeardown(pool, 'criterion1Pool');
        try {
          const result = await runMigrations(pool);
          expect(result.applied).toEqual(expectedFiles);

          const { rows } = await pool.query<{ filename: string }>(
            'SELECT filename FROM schema_migrations ORDER BY filename',
          );
          expect(rows.map((r) => r.filename)).toEqual(expectedFiles);
        } finally {
          // D#219 follow-up: wait for the sockets to close before the
          // cluster stops, or the server's 57P01 lands on an unlistened socket.
          await guard.endAndWaitForSockets();
        }
      } finally {
        provisioned.cleanup();
      }
    });
  });

  describe('criterion 2: UPDATE matrix (F2, 36 cells)', () => {
    const ROWS: Array<{ actor: MemberKey; target: MemberKey; outcomes: [Outcome, Outcome, Outcome] }> = [
      // outcomes order: [-> owner, -> admin, -> member]
      { actor: 'm1', target: 'm1', outcomes: ['R', 'R', 'R'] },
      { actor: 'm1', target: 'm2', outcomes: ['R', 'R', 'R'] },
      { actor: 'm1', target: 'a2', outcomes: ['R', 'R', 'R'] },
      { actor: 'm1', target: 'o1', outcomes: ['R', 'R', 'R'] },
      { actor: 'a1', target: 'a1', outcomes: ['R', 'A', 'A'] },
      { actor: 'a1', target: 'm2', outcomes: ['R', 'A', 'A'] },
      { actor: 'a1', target: 'a2', outcomes: ['R', 'A', 'A'] },
      { actor: 'a1', target: 'o1', outcomes: ['R', 'R', 'R'] },
      { actor: 'o1', target: 'o1', outcomes: ['A', 'A', 'A'] },
      { actor: 'o1', target: 'm2', outcomes: ['A', 'A', 'A'] },
      { actor: 'o1', target: 'a2', outcomes: ['A', 'A', 'A'] },
      { actor: 'o1', target: 'o2', outcomes: ['A', 'A', 'A'] },
    ];
    const NEW_ROLES: MemberRole[] = ['owner', 'admin', 'member'];

    const CASES = ROWS.flatMap((row) =>
      NEW_ROLES.map((newRole, i) => ({
        actor: row.actor,
        target: row.target,
        newRole,
        outcome: row.outcomes[i]!,
      })),
    );

    it.each(CASES)('$actor $target -> $newRole', async ({ actor, target, newRole, outcome }) => {
      const f2 = await seedF2(admin);
      const actorId = f2[actor];
      const targetId = f2[target];
      const before = await readMemberRow(admin, f2.accountId, targetId);

      const result = await attemptUpdateRole(f2.accountId, actorId, targetId, newRole);

      if (outcome === 'A') {
        expect(result.error).toBeNull();
        expect(result.rowCount).toBe(1);
        const after = await readMemberRow(admin, f2.accountId, targetId);
        expect(after?.role).toBe(newRole);
      } else {
        expectRefused(result);
        const after = await readMemberRow(admin, f2.accountId, targetId);
        expect(after).toEqual(before);
      }
    });

    it('F1: sole owner demoting themselves to admin is a last-owner refusal', async () => {
      const f1 = await seedF1(admin);
      const before = await readMemberRow(admin, f1.accountId, f1.o1);
      const result = await attemptUpdateRole(f1.accountId, f1.o1, f1.o1, 'admin');
      expectLastOwner(result);
      const after = await readMemberRow(admin, f1.accountId, f1.o1);
      expect(after).toEqual(before);
    });

    it('F1: sole owner demoting themselves to member is a last-owner refusal', async () => {
      const f1 = await seedF1(admin);
      const before = await readMemberRow(admin, f1.accountId, f1.o1);
      const result = await attemptUpdateRole(f1.accountId, f1.o1, f1.o1, 'member');
      expectLastOwner(result);
      const after = await readMemberRow(admin, f1.accountId, f1.o1);
      expect(after).toEqual(before);
    });
  });

  describe('criterion 3: DELETE matrix (F2, 12 cells, plus F1 and a bulk case)', () => {
    const CASES: Array<{ actor: MemberKey; target: MemberKey; outcome: Outcome }> = [
      { actor: 'm1', target: 'm1', outcome: 'A' }, // leave
      { actor: 'm1', target: 'm2', outcome: 'R' },
      { actor: 'm1', target: 'a2', outcome: 'R' },
      { actor: 'm1', target: 'o1', outcome: 'R' },
      { actor: 'a1', target: 'a1', outcome: 'A' }, // leave
      { actor: 'a1', target: 'm2', outcome: 'A' },
      { actor: 'a1', target: 'a2', outcome: 'A' },
      { actor: 'a1', target: 'o1', outcome: 'R' },
      { actor: 'o1', target: 'o1', outcome: 'A' }, // O2 remains
      { actor: 'o1', target: 'm2', outcome: 'A' },
      { actor: 'o1', target: 'a2', outcome: 'A' },
      { actor: 'o1', target: 'o2', outcome: 'A' },
    ];

    it.each(CASES)('DELETE $actor $target', async ({ actor, target, outcome }) => {
      const f2 = await seedF2(admin);
      const actorId = f2[actor];
      const targetId = f2[target];
      const before = await readMemberRow(admin, f2.accountId, targetId);

      const result = await attemptDelete(f2.accountId, actorId, targetId);

      if (outcome === 'A') {
        expect(result.error).toBeNull();
        expect(result.rowCount).toBe(1);
        const after = await readMemberRow(admin, f2.accountId, targetId);
        expect(after).toBeNull();
      } else {
        expectRefused(result);
        const after = await readMemberRow(admin, f2.accountId, targetId);
        expect(after).toEqual(before);
      }
    });

    it('F1: deleting the sole owner is a last-owner refusal', async () => {
      const f1 = await seedF1(admin);
      const result = await attemptDelete(f1.accountId, f1.o1, f1.o1);
      expectLastOwner(result);
      expect(await readMemberRow(admin, f1.accountId, f1.o1)).not.toBeNull();
    });

    it('F2 bulk DELETE: O1 deletes every owner row in one statement -- last-owner refusal, both owner rows survive', async () => {
      const f2 = await seedF2(admin);
      const result = await attemptDelete2(f2);
      expectLastOwner(result);
      expect(await countOwners(admin, f2.accountId)).toBe(2);
      expect((await readMemberRow(admin, f2.accountId, f2.o1))?.role).toBe('owner');
      expect((await readMemberRow(admin, f2.accountId, f2.o2))?.role).toBe('owner');

      async function attemptDelete2(fixture: F2Fixture) {
        try {
          await withTenant(appUserPool, fixture.accountId, fixture.o1, async (client) => {
            await client.query(
              `DELETE FROM account_members WHERE account_id = $1 AND role = 'owner'`,
              [fixture.accountId],
            );
          });
          return { rowCount: null, error: null };
        } catch (err) {
          return { rowCount: null, error: err as { code?: string } };
        }
      }
    });

    it('F2 bulk UPDATE: O1 demotes every owner row in one statement -- last-owner refusal, both owner rows survive', async () => {
      const f2 = await seedF2(admin);
      let error: { code?: string } | null = null;
      try {
        await withTenant(appUserPool, f2.accountId, f2.o1, async (client) => {
          await client.query(
            `UPDATE account_members SET role = 'member' WHERE account_id = $1 AND role = 'owner'`,
            [f2.accountId],
          );
        });
      } catch (err) {
        error = err as { code?: string };
      }
      expectLastOwner({ rowCount: null, error });
      expect(await countOwners(admin, f2.accountId)).toBe(2);
      expect((await readMemberRow(admin, f2.accountId, f2.o1))?.role).toBe('owner');
      expect((await readMemberRow(admin, f2.accountId, f2.o2))?.role).toBe('owner');
    });
  });

  describe('criterion 4: sessions with no verified identity (F2)', () => {
    let f2: F2Fixture;
    let outsider: { accountId: string; userId: string };

    beforeAll(async () => {
      f2 = await seedF2(admin);
      outsider = await seedOutsideOwner(admin);
    });

    /** Same shape as attemptUpdateRole/attemptDelete, but via the 3-arg withTenant (no userId set at all). */
    async function attemptUpdateNoUserId(
      accountId: string,
      targetId: string,
      newRole: MemberRole,
    ): Promise<{ rowCount: number | null; error: { code?: string } | null }> {
      try {
        const rowCount = await withTenant(appUserPool, accountId, async (client) => {
          const result = await client.query(
            'UPDATE account_members SET role = $1 WHERE account_id = $2 AND user_id = $3',
            [newRole, accountId, targetId],
          );
          return result.rowCount;
        });
        return { rowCount, error: null };
      } catch (err) {
        return { rowCount: null, error: err as { code?: string } };
      }
    }

    async function attemptDeleteNoUserId(
      accountId: string,
      targetId: string,
    ): Promise<{ rowCount: number | null; error: { code?: string } | null }> {
      try {
        const rowCount = await withTenant(appUserPool, accountId, async (client) => {
          const result = await client.query(
            'DELETE FROM account_members WHERE account_id = $1 AND user_id = $2',
            [accountId, targetId],
          );
          return result.rowCount;
        });
        return { rowCount, error: null };
      } catch (err) {
        return { rowCount: null, error: err as { code?: string } };
      }
    }

    it('(a) withTenant with no userId: UPDATE O1 -> member, UPDATE M2 -> admin, and DELETE M2 are all refused', async () => {
      const beforeO1 = await readMemberRow(admin, f2.accountId, f2.o1);
      const beforeM2 = await readMemberRow(admin, f2.accountId, f2.m2);

      expectRefused(await attemptUpdateNoUserId(f2.accountId, f2.o1, 'member'));
      expectRefused(await attemptUpdateNoUserId(f2.accountId, f2.m2, 'admin'));
      expectRefused(await attemptDeleteNoUserId(f2.accountId, f2.m2));

      expect(await readMemberRow(admin, f2.accountId, f2.o1)).toEqual(beforeO1);
      expect(await readMemberRow(admin, f2.accountId, f2.m2)).toEqual(beforeM2);
    });

    it('(b) app.user_id = a random uuid that is not a user: all three refused', async () => {
      const ghost = randomUUID();
      expectRefused(await attemptUpdateRole(f2.accountId, ghost, f2.o1, 'member'));
      expectRefused(await attemptUpdateRole(f2.accountId, ghost, f2.m2, 'admin'));
      expectRefused(await attemptDelete(f2.accountId, ghost, f2.m2));
    });

    it('(c) app.user_id = X (a real owner of a DIFFERENT account) with app.account_id = F2: all three refused', async () => {
      expectRefused(await attemptUpdateRole(f2.accountId, outsider.userId, f2.o1, 'member'));
      expectRefused(await attemptUpdateRole(f2.accountId, outsider.userId, f2.m2, 'admin'));
      expectRefused(await attemptDelete(f2.accountId, outsider.userId, f2.m2));
    });
  });

  describe('criterion 5: column privilege (F2, as O1)', () => {
    let f2: F2Fixture;

    beforeAll(async () => {
      f2 = await seedF2(admin);
    });

    it.each([
      ['user_id', () => f2.m2],
      ['created_at', () => new Date().toISOString()],
      ['id', () => randomUUID()],
      ['account_id', () => randomUUID()],
    ])('SET %s is rejected with 42501, row unchanged', async (column, valueFn) => {
      const before = await readMemberRow(admin, f2.accountId, f2.a2);
      await expect(
        withTenant(appUserPool, f2.accountId, f2.o1, async (client) => {
          await client.query(`UPDATE account_members SET ${column} = $1 WHERE account_id = $2 AND user_id = $3`, [
            valueFn(),
            f2.accountId,
            f2.a2,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await readMemberRow(admin, f2.accountId, f2.a2)).toEqual(before);
    });

    it('has_column_privilege: role=true, user_id/account_id/id/created_at=false', async () => {
      const { rows } = await admin.query<{ column: string; has: boolean }>(
        `SELECT unnest(ARRAY['role','user_id','account_id','id','created_at']) AS column,
                has_column_privilege('app_user', 'account_members', unnest(ARRAY['role','user_id','account_id','id','created_at']), 'UPDATE') AS has`,
      );
      const byColumn = Object.fromEntries(rows.map((r) => [r.column, r.has]));
      expect(byColumn).toEqual({
        role: true,
        user_id: false,
        account_id: false,
        id: false,
        created_at: false,
      });
    });
  });

  describe('criterion 6: concurrency (real connections, deterministic interleaving, F2 with only O1/O2 as owners)', () => {
    async function rawClient(): Promise<PoolClient> {
      return appUserPool.connect();
    }

    /**
     * `isolationLevel` is omitted for the existing READ COMMITTED cases
     * (a plain `BEGIN`) and passed by the REPEATABLE READ / SERIALIZABLE
     * races added below (PR #75 review, MUST 1) -- it's a fixed TS union,
     * not caller-supplied text, so interpolating it into the BEGIN
     * statement carries no injection risk.
     */
    async function beginAs(
      client: PoolClient,
      accountId: string,
      userId: string,
      isolationLevel?: 'REPEATABLE READ' | 'SERIALIZABLE',
    ): Promise<void> {
      await client.query(isolationLevel ? `BEGIN ISOLATION LEVEL ${isolationLevel}` : 'BEGIN');
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    }

    /**
     * Polls pg_locks (via the admin connection) for a NOT-granted advisory
     * lock request matching key (`k1`, `k2`) -- i.e. some OTHER backend is
     * currently blocked waiting to acquire it. Unlike an uncontested row
     * lock (never surfaced in pg_locks at all -- verified directly
     * against this cluster), a genuine WAITER always shows up with
     * `granted = false`, which is what makes this a real synchronization
     * point rather than a guess. Used only by case (c) -- see its own
     * comment for why.
     */
    async function waitForAdvisoryWaiter(k1: number, k2: number, timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { rows } = await admin.query<{ pid: number }>(
          `SELECT pid FROM pg_locks
           WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted = false`,
          [k1, k2],
        );
        if (rows.length > 0) return;
        if (Date.now() > deadline) {
          throw new Error('timed out waiting for T1 to block on the pre-empted advisory lock');
        }
        await delay(10);
      }
    }

    it('(a) T1 deletes own row, T2 (other owner) blocks, then fails after T1 commits', async () => {
      const f2 = await seedF2(admin);
      const c1 = await rawClient();
      const c2 = await rawClient();
      try {
        await beginAs(c1, f2.accountId, f2.o1);
        await beginAs(c2, f2.accountId, f2.o2);

        const t1 = await c1.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [
          f2.accountId,
          f2.o1,
        ]);
        expect(t1.rowCount).toBe(1);

        let t2Settled = false;
        const t2 = c2
          .query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [f2.accountId, f2.o2])
          .then(() => {
            t2Settled = true;
          })
          .catch((err) => {
            t2Settled = true;
            return err;
          });

        await delay(300);
        expect(t2Settled).toBe(false);

        await c1.query('COMMIT');

        const t2Error = await t2;
        expect(t2Settled).toBe(true);
        expect(t2Error).toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

        expect(await countOwners(admin, f2.accountId)).toBe(1);
        expect((await readMemberRow(admin, f2.accountId, f2.o2))?.role).toBe('owner');
      } finally {
        // Unconditional, ahead of release() -- an assertion failure above
        // must never leave a transaction open on a connection the pool
        // will hand to a LATER test (D#64 fix-round: this is exactly what
        // produced the "current transaction is aborted" 25P02 failure in
        // an earlier version of this test).
        await c1.query('ROLLBACK').catch(() => {});
        await c2.query('ROLLBACK').catch(() => {});
        c1.release();
        c2.release();
      }
    });

    it('(b) cross-demotes: T1 (O1) demotes O2, T2 (O2) demotes O1 -- T2 blocks, then fails', async () => {
      const f2 = await seedF2(admin);
      const c1 = await rawClient();
      const c2 = await rawClient();
      try {
        await beginAs(c1, f2.accountId, f2.o1);
        await beginAs(c2, f2.accountId, f2.o2);

        const t1 = await c1.query(
          `UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
          [f2.accountId, f2.o2],
        );
        expect(t1.rowCount).toBe(1);

        let t2Settled = false;
        const t2 = c2
          .query(`UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`, [
            f2.accountId,
            f2.o1,
          ])
          .then(() => {
            t2Settled = true;
          })
          .catch((err) => {
            t2Settled = true;
            return err;
          });

        await delay(300);
        expect(t2Settled).toBe(false);

        await c1.query('COMMIT');

        const t2Error = await t2;
        expect(t2Settled).toBe(true);
        expect(t2Error).toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

        expect(await countOwners(admin, f2.accountId)).toBe(1);
        expect((await readMemberRow(admin, f2.accountId, f2.o1))?.role).toBe('owner');
      } finally {
        await c1.query('ROLLBACK').catch(() => {});
        await c2.query('ROLLBACK').catch(() => {});
        c1.release();
        c2.release();
      }
    });

    /**
     * setMemberRole's own transaction (BEGIN, two role lookups,
     * lockOwnerRows' FOR UPDATE, the role UPDATE, COMMIT) is entirely
     * local queries and can complete in low single-digit milliseconds --
     * far too fast to reliably "catch in the act" from outside with any
     * wall-clock delay or lock-existence poll (an UNCONTESTED row lock
     * isn't even surfaced in pg_locks; verified directly against this
     * cluster). A naive race lets T2 win outright often enough to flip
     * the whole scenario -- T2's DELETE would succeed immediately
     * (O1 is still 'owner' at that instant, so O2 leaving alone is fine),
     * and T1 would then be the one left blocking on T2's own uncommitted
     * DELETE.
     *
     * Fix: pre-empt the migration's OWN per-account advisory lock (the
     * exact `pg_advisory_xact_lock(hashtext('account_members_keep_an_owner'),
     * hashtext(account_id))` call account_members_keep_an_owner() makes)
     * from a THIRD, test-controlled connection, before T1 ever starts.
     * T1 (setMemberRole) can then freely reach and acquire
     * lockOwnerRows' row lock on O2's row -- nothing is contending for
     * THAT yet -- but its subsequent UPDATE fires the trigger, which
     * blocks taking the SAME advisory lock this connection already
     * holds. T1 is now deterministically stuck holding the row lock,
     * without having released it, for exactly as long as this test
     * wants. T2's DELETE of that same row then blocks for a real,
     * guaranteed reason (a live row lock T1 already holds), which
     * pg_locks DOES show reliably (a WAITING advisory-lock request is
     * always visible, unlike an uncontested tuple lock) -- so waiting
     * for T1 to become the advisory lock's WAITER is itself the
     * deterministic synchronization point, not a guess.
     */
    it('(c) T1 runs setMemberRole (O1 self -> member) through membership.ts while T2 raw-DELETEs O2 -- T2 blocks, then fails', async () => {
      const f2 = await seedF2(admin);

      const lockHolder = await adminPool.connect();
      const {
        rows: [{ k1, k2 }],
      } = await lockHolder.query<{ k1: number; k2: number }>(
        `SELECT hashtext('account_members_keep_an_owner') AS k1, hashtext($1::text) AS k2`,
        [f2.accountId],
      );
      await lockHolder.query('BEGIN');
      await lockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

      const c2 = await rawClient();
      let t1: ReturnType<typeof setMemberRole> | undefined;
      try {
        t1 = setMemberRole(appUserPool, f2.accountId, f2.o1, f2.o1, 'member', { failRunnerLeases: null });

        // Wait until T1's own connection shows up as a WAITER for the
        // advisory lock lockHolder is holding -- proof T1 has already
        // taken lockOwnerRows' row lock and is now stuck inside the
        // trigger, not a guess.
        await waitForAdvisoryWaiter(k1, k2);

        await beginAs(c2, f2.accountId, f2.o2);
        let t2Settled = false;
        let t2Error: { code?: string } | undefined;
        const t2 = c2
          .query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [f2.accountId, f2.o2])
          .then(() => {
            t2Settled = true;
          })
          .catch((err) => {
            t2Settled = true;
            t2Error = err;
          });

        await delay(300);
        expect(t2Settled).toBe(false);

        // Release the advisory lock -- T1's trigger unblocks, finishes,
        // commits (demoting O1) -- THEN T2's DELETE (still blocked on
        // the row lock T1 was holding) finally gets to run, against the
        // now-current data.
        await lockHolder.query('COMMIT');

        await t1;
        await t2;

        expect(t2Settled).toBe(true);
        expect(t2Error).toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

        expect(await countOwners(admin, f2.accountId)).toBe(1);
        expect((await readMemberRow(admin, f2.accountId, f2.o2))?.role).toBe('owner');
        expect((await readMemberRow(admin, f2.accountId, f2.o1))?.role).toBe('member');
      } finally {
        await t1?.catch(() => {});
        await lockHolder.query('ROLLBACK').catch(() => {});
        lockHolder.release();
        await c2.query('ROLLBACK').catch(() => {});
        c2.release();
      }
    });

    /**
     * PR #75 review, MUST 1 (CWE-362): the pre-fix trigger's owner count
     * was a plain `SELECT count(*)`, correct only under READ COMMITTED.
     * Under REPEATABLE READ / SERIALIZABLE, T2's snapshot is taken at its
     * FIRST statement (before T1 ever runs), so once T2 unblocks from the
     * advisory lock it would still see T1's soon-to-be-removed owner as
     * present, and its own change would be wrongly allowed through --
     * reproduced by the reviewer with two real connections: both owners'
     * rows gone, an account with zero owners no app_user can repair.
     *
     * The fix (row-locking the counted rows with `FOR UPDATE`) turns that
     * into a hard failure instead: Postgres itself raises `40001 could
     * not serialize access due to concurrent update/delete` when a
     * REPEATABLE READ / SERIALIZABLE transaction's `FOR UPDATE` target
     * was changed by another, since-committed transaction -- BEFORE the
     * trigger's own count/raise logic even runs. That's a DIFFERENT
     * SQLSTATE than the READ COMMITTED cases above (23514, raised by
     * this trigger's own RAISE EXCEPTION) -- both are "the second
     * transaction is rejected", but for different reasons, which is why
     * this suite asserts the isolation-specific code rather than either
     * one loosely.
     *
     * Same T1/T2 shape and same deterministic-blocking technique as (a)
     * and (b) above (T1 commits mid-test, T2's promise is asserted
     * unsettled beforehand) -- only the isolation level, the pair of
     * statements, and the expected SQLSTATE vary per case.
     */
    describe('REPEATABLE READ / SERIALIZABLE: T2 fails with a serialization error, not a stale-snapshot pass-through', () => {
      async function raceUnderIsolation(
        iso: 'REPEATABLE READ' | 'SERIALIZABLE',
        t1Sql: (f2: F2Fixture) => { text: string; values: unknown[] },
        t2Sql: (f2: F2Fixture) => { text: string; values: unknown[] },
        survivingOwnerKey: 'o1' | 'o2',
      ): Promise<void> {
        const f2 = await seedF2(admin);
        const c1 = await rawClient();
        const c2 = await rawClient();
        try {
          await beginAs(c1, f2.accountId, f2.o1, iso);
          await beginAs(c2, f2.accountId, f2.o2, iso);

          const q1 = t1Sql(f2);
          const t1 = await c1.query(q1.text, q1.values);
          expect(t1.rowCount).toBe(1);

          let t2Settled = false;
          let t2Error: { code?: string } | undefined;
          const q2 = t2Sql(f2);
          const t2 = c2
            .query(q2.text, q2.values)
            .then(() => {
              t2Settled = true;
            })
            .catch((err) => {
              t2Settled = true;
              t2Error = err as { code?: string };
            });

          await delay(300);
          expect(t2Settled).toBe(false);

          await c1.query('COMMIT');

          await t2;
          expect(t2Settled).toBe(true);
          expect(t2Error).toMatchObject({ code: PG_ERROR.SERIALIZATION_FAILURE });

          expect(await countOwners(admin, f2.accountId)).toBe(1);
          expect((await readMemberRow(admin, f2.accountId, f2[survivingOwnerKey]))?.role).toBe('owner');
        } finally {
          await c1.query('ROLLBACK').catch(() => {});
          await c2.query('ROLLBACK').catch(() => {});
          c1.release();
          c2.release();
        }
      }

      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
        it(`${iso}: both owners leave at once -- T2 fails with ${PG_ERROR.SERIALIZATION_FAILURE}, 1 owner remains`, async () => {
          await raceUnderIsolation(
            iso,
            (f2) => ({
              text: 'DELETE FROM account_members WHERE account_id = $1 AND user_id = $2',
              values: [f2.accountId, f2.o1],
            }),
            (f2) => ({
              text: 'DELETE FROM account_members WHERE account_id = $1 AND user_id = $2',
              values: [f2.accountId, f2.o2],
            }),
            'o2',
          );
        });

        it(`${iso}: cross-demote (O1 demotes O2, O2 demotes O1) -- T2 fails with ${PG_ERROR.SERIALIZATION_FAILURE}, 1 owner remains`, async () => {
          await raceUnderIsolation(
            iso,
            (f2) => ({
              text: `UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
              values: [f2.accountId, f2.o2],
            }),
            (f2) => ({
              text: `UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
              values: [f2.accountId, f2.o1],
            }),
            'o1',
          );
        });

        it(`${iso}: O1 self-demotes while O2 leaves -- T2 fails with ${PG_ERROR.SERIALIZATION_FAILURE}, 1 owner remains`, async () => {
          await raceUnderIsolation(
            iso,
            (f2) => ({
              text: `UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`,
              values: [f2.accountId, f2.o1],
            }),
            (f2) => ({
              text: 'DELETE FROM account_members WHERE account_id = $1 AND user_id = $2',
              values: [f2.accountId, f2.o2],
            }),
            'o2',
          );
        });
      }
    });
  });

  describe('criterion 7: lifecycle paths are unaffected (exempt roles)', () => {
    // 7a (createAccountForNewOwner), 7d (listMemberships) and the
    // unrelated-identity checks are exercised, unchanged, by
    // packages/core/test/pg/identity.test.ts -- see that file. Only the
    // NEW platform_ops trigger-exemption behaviour (7b, 7c) is asserted
    // here.

    it('7b: platform_ops DELETE on an F1 sole owner row succeeds (rowCount 1)', async () => {
      const f1 = await seedF1(admin);
      const result = await platformOpsPool.query(
        'DELETE FROM account_members WHERE account_id = $1 AND user_id = $2',
        [f1.accountId, f1.o1],
      );
      expect(result.rowCount).toBe(1);
    });

    it('7c: platform_ops DELETE FROM users on an F1 sole owner cascades to account_members', async () => {
      const f1 = await seedF1(admin);
      await platformOpsPool.query('DELETE FROM users WHERE id = $1', [f1.o1]);
      const { rows } = await admin.query('SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2', [
        f1.accountId,
        f1.o1,
      ]);
      expect(rows).toEqual([]);
    });
  });

  describe('criterion 11: escalation chains are closed end to end (raw SQL, F2)', () => {
    it('(a) the #54 probe: M1 self-promote to admin is refused, role unchanged', async () => {
      const f2 = await seedF2(admin);
      const result = await attemptUpdateRole(f2.accountId, f2.m1, f2.m1, 'admin');
      expectRefused(result);
      expect((await readMemberRow(admin, f2.accountId, f2.m1))?.role).toBe('member');
    });

    it('(b) M1 cannot insert an owner invitation for a second identity it controls, and that identity cannot join as owner', async () => {
      const f2 = await seedF2(admin);
      // The second identity (M1b) is deliberately NOT a member yet -- it's
      // the identity M1 is trying to smuggle IN as owner via an
      // invitation M1 has no business issuing.
      const secondIdentity = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        secondIdentity,
        `${secondIdentity}@example.test`,
      ]);

      await expect(
        withTenant(appUserPool, f2.accountId, f2.m1, async (client) => {
          await client.query(
            `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, 'owner', $3, $4, now() + interval '7 days')`,
            [f2.accountId, `${secondIdentity}@example.test`, `hash-${randomUUID()}`, f2.m1],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // No invitation was written, so the join is refused too.
      await expect(
        withTenant(appUserPool, f2.accountId, secondIdentity, async (client) => {
          await client.query(
            `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
            [f2.accountId, secondIdentity],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('(c) M1 leaves, then (still no membership) cannot invite itself as owner or member', async () => {
      const f2 = await seedF2(admin);
      const leave = await attemptDelete(f2.accountId, f2.m1, f2.m1);
      expect(leave.error).toBeNull();
      expect(leave.rowCount).toBe(1);

      await expect(
        withTenant(appUserPool, f2.accountId, f2.m1, async (client) => {
          await client.query(
            `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, (SELECT email FROM users WHERE id = $2), 'owner', $3, $2, now() + interval '7 days')`,
            [f2.accountId, f2.m1, `hash-${randomUUID()}`],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      await expect(
        withTenant(appUserPool, f2.accountId, f2.m1, async (client) => {
          await client.query(
            `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, (SELECT email FROM users WHERE id = $2), 'member', $3, $2, now() + interval '7 days')`,
            [f2.accountId, f2.m1, `hash-${randomUUID()}`],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('(d) A1 cannot promote itself to owner, demote O1, delete O1, or invite A1b as owner', async () => {
      const f2 = await seedF2(admin);
      expectRefused(await attemptUpdateRole(f2.accountId, f2.a1, f2.a1, 'owner'));
      expectRefused(await attemptUpdateRole(f2.accountId, f2.a1, f2.o1, 'admin'));
      expectRefused(await attemptDelete(f2.accountId, f2.a1, f2.o1));

      const a1b = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [a1b, `${a1b}@example.test`]);
      await expect(
        withTenant(appUserPool, f2.accountId, f2.a1, async (client) => {
          await client.query(
            `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, 'owner', $3, $4, now() + interval '7 days')`,
            [f2.accountId, `${a1b}@example.test`, `hash-${randomUUID()}`, f2.a1],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      expect((await readMemberRow(admin, f2.accountId, f2.o1))?.role).toBe('owner');
    });

    it('(e) A1 cannot swap M2 to a different user_id (no identity swap)', async () => {
      const f2 = await seedF2(admin);
      const before = await readMemberRow(admin, f2.accountId, f2.m2);
      await expect(
        withTenant(appUserPool, f2.accountId, f2.a1, async (client) => {
          await client.query('UPDATE account_members SET user_id = $1 WHERE account_id = $2 AND user_id = $3', [
            randomUUID(),
            f2.accountId,
            f2.m2,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await readMemberRow(admin, f2.accountId, f2.m2)).toEqual(before);
    });
  });

  describe('criterion 14: the definer-function guards', () => {
    it('current_member_role / current_member_user_id / current_member_email each reference account_members, take no args, are SECURITY DEFINER owned by guard_definer (0721, not platform_ops), and are not EXECUTE-able by PUBLIC', async () => {
      const { rows } = await admin.query<{
        proname: string;
        prosrc: string;
        pronargs: number;
        prosecdef: boolean;
        owner: string;
      }>(
        `SELECT p.proname, p.prosrc, p.pronargs, p.prosecdef, r.rolname AS owner
         FROM pg_proc p
         JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname IN ('current_member_role', 'current_member_user_id', 'current_member_email')
         ORDER BY p.proname`,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.prosrc).toContain('account_members');
        expect(row.pronargs).toBe(0);
        expect(row.prosecdef).toBe(true);
        expect(row.owner).toBe('guard_definer');
      }

      const { rows: privRows } = await admin.query<{ proname: string; has: boolean }>(
        `SELECT proname, has_function_privilege('public', oid, 'EXECUTE') AS has
         FROM pg_proc
         WHERE proname IN ('current_member_role', 'current_member_user_id', 'current_member_email')`,
      );
      for (const row of privRows) {
        expect(row.has).toBe(false);
      }
    });
  });

  describe('criterion 17: cost stays per-query (InitPlan, not SubPlan)', () => {
    it('EXPLAIN (COSTS OFF) UPDATE ... shows the role helper under InitPlan', async () => {
      const f2 = await seedF2(admin);
      const plan = await withTenant(appUserPool, f2.accountId, f2.o1, async (client) => {
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`,
          [f2.accountId, f2.m2],
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('InitPlan');
      expect(plan).not.toContain('SubPlan');
    });
  });
});
