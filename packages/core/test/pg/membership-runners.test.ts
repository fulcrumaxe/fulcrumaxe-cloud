import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedF2, type F2Fixture } from '@fx/db/test/helpers/members.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { RunnerLeasesNotFailedError, removeMember, setMemberRole, type RunnerLeaseFailer } from '../../src/tenancy/membership.js';

/**
 * D#6 R2a, C11 section 4: the registrant's active runner ids are read BEFORE the role change; the runners are revoked in
 * the demotion's own transaction (migration 0712's trigger); and the worker fails their leases only AFTER the commit.
 */
describe('demoting or removing a member who registered runners (C11 section 4)', () => {
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
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });

  interface Call {
    runnerId: string;
    roleAtCall: string | undefined;
    revokedAtCall: boolean;
  }
  /** A failer that records, at the moment it is called, what the database already shows (from another connection). */
  function failer(f: F2Fixture, target: string): { calls: Call[]; fail: RunnerLeaseFailer } {
    const calls: Call[] = [];
    const fail: RunnerLeaseFailer = async ({ accountId, runnerId, reason }) => {
      expect(accountId).toBe(f.accountId);
      expect(reason).toBe('runner_revoked');
      const role = (await adminPool.query('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [f.accountId, target])).rows[0]?.role as string | undefined;
      const revoked = (await adminPool.query('SELECT revoked_at IS NOT NULL AS r FROM runners WHERE id = $1', [runnerId])).rows[0].r as boolean;
      calls.push({ runnerId, roleAtCall: role, revokedAtCall: revoked });
      return { complete: true };
    };
    return { calls, fail };
  }
  const revokedAt = async (id: string) => (await admin.query('SELECT revoked_at FROM runners WHERE id = $1', [id])).rows[0].revoked_at as Date | null;

  it('reads the ids first, revokes in the demotion, and fails the leases after it commits', async () => {
    const f = await seedF2(admin);
    const mine1 = await insertRunner(admin, f.accountId, f.a1);
    const mine2 = await insertRunner(admin, f.accountId, f.a1);
    const alreadyRevoked = await insertRunner(admin, f.accountId, f.a1);
    await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'revoked' WHERE id = $1`, [alreadyRevoked]);
    const someoneElses = await insertRunner(admin, f.accountId, f.a2);
    const { calls, fail } = failer(f, f.a1);

    await setMemberRole(appUserPool, f.accountId, f.o1, f.a1, 'member', { failRunnerLeases: fail });

    expect(calls.map((c) => c.runnerId).sort()).toEqual([mine1, mine2].sort());
    for (const c of calls) expect(c).toMatchObject({ roleAtCall: 'member', revokedAtCall: true });
    expect(await revokedAt(someoneElses)).toBeNull();
  });

  it('does the same for a removal', async () => {
    const f = await seedF2(admin);
    const runner = await insertRunner(admin, f.accountId, f.a1);
    const { calls, fail } = failer(f, f.a1);
    await removeMember(appUserPool, f.accountId, f.o1, f.a1, { failRunnerLeases: fail });
    expect(calls).toEqual([{ runnerId: runner, roleAtCall: undefined, revokedAtCall: true }]);
  });

  it('fails nothing for a rolled-back demotion, a promotion or a change that keeps admin rights', async () => {
    const f = await seedF2(admin);
    const adminRunner = await insertRunner(admin, f.accountId, f.a1);
    const ownerRunner = await insertRunner(admin, f.accountId, f.o2);
    const { calls, fail } = failer(f, f.a1);
    // An admin may not demote an owner, so this is refused before anything changes.
    await expect(setMemberRole(appUserPool, f.accountId, f.a1, f.o2, 'member', { failRunnerLeases: fail })).rejects.toThrow();
    // Admin to owner and owner to admin keep their rights: nothing is revoked.
    await setMemberRole(appUserPool, f.accountId, f.o1, f.a1, 'owner', { failRunnerLeases: fail });
    await setMemberRole(appUserPool, f.accountId, f.o1, f.o2, 'admin', { failRunnerLeases: fail });
    expect(calls).toEqual([]);
    expect(await revokedAt(adminRunner)).toBeNull();
    expect(await revokedAt(ownerRunner)).toBeNull();
  });

  it('reports a lease failure after the commit instead of hiding it, and still tries every runner', async () => {
    const f = await seedF2(admin);
    const r1 = await insertRunner(admin, f.accountId, f.a1);
    const r2 = await insertRunner(admin, f.accountId, f.a1);
    const tried: string[] = [];
    const fail: RunnerLeaseFailer = async ({ runnerId }) => {
      tried.push(runnerId);
      throw new Error('worker down');
    };
    const error = await setMemberRole(appUserPool, f.accountId, f.o1, f.a1, 'member', { failRunnerLeases: fail }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerLeasesNotFailedError);
    expect((error as RunnerLeasesNotFailedError).runnerIds.sort()).toEqual([r1, r2].sort());
    expect(tried.sort()).toEqual([r1, r2].sort());
    expect((await admin.query('SELECT role FROM account_members WHERE user_id = $1', [f.a1])).rows[0].role).toBe('member'); // the demotion stands
    expect(await revokedAt(r1)).not.toBeNull();
    // No failer supplied at all is the same loud outcome, not a silent skip.
    const g = await seedF2(admin);
    await insertRunner(admin, g.accountId, g.a1);
    await expect(setMemberRole(appUserPool, g.accountId, g.o1, g.a1, 'member', { failRunnerLeases: null })).rejects.toBeInstanceOf(RunnerLeasesNotFailedError);
  });
});
