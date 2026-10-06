import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { readMemberRow, seedF2, type F2Fixture } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

type MemberRole = 'owner' | 'admin' | 'member';
type MemberKey = 'o1' | 'o2' | 'a1' | 'a2' | 'm1' | 'm2';

/**
 * D#64 criteria 8-10: invitations' per-command role-gated policies and
 * the has_open_invitation() owner-inviter recheck.
 */
describe('invitations role gate (D#64)', () => {
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

  interface InsertOutcome {
    id: string | null;
    error: { code?: string } | null;
  }

  async function attemptInsertInvitation(
    accountId: string,
    actorId: string,
    invitedBy: string | null,
    role: MemberRole,
    email?: string,
  ): Promise<InsertOutcome> {
    try {
      const id = await withTenant(appUserPool, accountId, actorId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
           RETURNING id`,
          [accountId, email ?? `${randomUUID()}@example.test`, role, `hash-${randomUUID()}`, invitedBy],
        );
        return rows[0]!.id;
      });
      return { id, error: null };
    } catch (err) {
      return { id: null, error: err as { code?: string } };
    }
  }

  function expectRefusedInsert(result: InsertOutcome): void {
    expect(result.error).toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect(result.id).toBeNull();
  }

  /**
   * Runs an UPDATE/DELETE and asserts the Spec's "R" outcome: raises
   * 42501, OR affects 0 rows (a USING-only rejection just filters the
   * row out silently -- it never throws). Both are "refused"; which one
   * happens depends on which half of the policy failed first.
   */
  async function attemptWrite(
    accountId: string,
    actorId: string,
    fn: (client: PoolClient) => Promise<{ rowCount: number | null }>,
  ): Promise<{ rowCount: number | null; error: { code?: string } | null }> {
    try {
      const rowCount = await withTenant(appUserPool, accountId, actorId, async (client) => {
        const result = await fn(client);
        return result.rowCount;
      });
      return { rowCount, error: null };
    } catch (err) {
      return { rowCount: null, error: err as { code?: string } };
    }
  }

  function expectRefusedWrite(result: { rowCount: number | null; error: { code?: string } | null }): void {
    if (result.error) {
      expect(result.error).toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } else {
      expect(result.rowCount).toBe(0);
    }
  }

  describe('criterion 8: invitations INSERT matrix (F2)', () => {
    const CASES: Array<{ actor: MemberKey; role: MemberRole; outcome: 'A' | 'R' }> = [
      { actor: 'm1', role: 'member', outcome: 'R' },
      { actor: 'm1', role: 'admin', outcome: 'R' },
      { actor: 'm1', role: 'owner', outcome: 'R' },
      { actor: 'a1', role: 'member', outcome: 'A' },
      { actor: 'a1', role: 'admin', outcome: 'A' },
      { actor: 'a1', role: 'owner', outcome: 'R' },
      { actor: 'o1', role: 'member', outcome: 'A' },
      { actor: 'o1', role: 'admin', outcome: 'A' },
      { actor: 'o1', role: 'owner', outcome: 'A' },
    ];

    it.each(CASES)('$actor inviting role=$role', async ({ actor, role, outcome }) => {
      const f2 = await seedF2(admin);
      const actorId = f2[actor];
      const result = await attemptInsertInvitation(f2.accountId, actorId, actorId, role);
      if (outcome === 'A') {
        expect(result.error).toBeNull();
        expect(result.id).toBeTruthy();
      } else {
        expectRefusedInsert(result);
      }
    });

    it('O1 with invited_by = O2 (a different real member) is refused', async () => {
      const f2 = await seedF2(admin);
      expectRefusedInsert(await attemptInsertInvitation(f2.accountId, f2.o1, f2.o2, 'member'));
    });

    it('O1 with invited_by = NULL is refused', async () => {
      const f2 = await seedF2(admin);
      expectRefusedInsert(await attemptInsertInvitation(f2.accountId, f2.o1, null, 'member'));
    });

    it('a session with no userId is refused for every role', async () => {
      const f2 = await seedF2(admin);
      for (const role of ['member', 'admin', 'owner'] as const) {
        let error: { code?: string } | null = null;
        try {
          await withTenant(appUserPool, f2.accountId, async (client) => {
            await client.query(
              `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
               VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
              [f2.accountId, `${randomUUID()}@example.test`, role, `hash-${randomUUID()}`, f2.o1],
            );
          });
        } catch (err) {
          error = err as { code?: string };
        }
        expect(error).toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });

  describe('criteria 9: invitations UPDATE/DELETE (F2 plus an invitee I with an open member invitation)', () => {
    async function seedOpenInviteFor(f2: F2Fixture): Promise<{ inviteeId: string; invitationId: string }> {
      const inviteeId = randomUUID();
      const email = `invitee-${inviteeId}@example.test`;
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [inviteeId, email]);
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'member', $3, $4, now() + interval '7 days')
         RETURNING id`,
        [f2.accountId, email, `hash-${randomUUID()}`, f2.o1],
      );
      return { inviteeId, invitationId: rows[0]!.id };
    }

    it('(a) the raw form of acceptInvitation: invitee inserts its own membership then sets accepted_at, in one transaction', async () => {
      const f2 = await seedF2(admin);
      const { inviteeId, invitationId } = await seedOpenInviteFor(f2);

      const rowCount = await withTenant(appUserPool, f2.accountId, inviteeId, async (client) => {
        await client.query(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
          [f2.accountId, inviteeId],
        );
        const result = await client.query(
          'UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL',
          [invitationId],
        );
        return result.rowCount;
      });
      expect(rowCount).toBe(1);

      const { rows } = await admin.query('SELECT accepted_at IS NOT NULL AS consumed FROM invitations WHERE id = $1', [
        invitationId,
      ]);
      expect(rows).toEqual([{ consumed: true }]);
    });

    it('(b) M1 setting accepted_at on an invitation not addressed to M1 is refused', async () => {
      const f2 = await seedF2(admin);
      const { invitationId } = await seedOpenInviteFor(f2);

      const result = await attemptWrite(f2.accountId, f2.m1, (client) =>
        client.query('UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL', [
          invitationId,
        ]),
      );
      expectRefusedWrite(result);

      const { rows } = await admin.query('SELECT accepted_at FROM invitations WHERE id = $1', [invitationId]);
      expect(rows).toEqual([{ accepted_at: null }]);
    });

    it.each(['o1', 'a1'] as const)('(c) %s setting accepted_at on an open invitation succeeds', async (actorKey) => {
      const f2 = await seedF2(admin);
      const { invitationId } = await seedOpenInviteFor(f2);
      const actorId = f2[actorKey];

      const rowCount = await withTenant(appUserPool, f2.accountId, actorId, async (client) => {
        const result = await client.query(
          'UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL',
          [invitationId],
        );
        return result.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('(d) O1 replaying accepted_at back to NULL on an ALREADY-accepted invitation is refused', async () => {
      const f2 = await seedF2(admin);
      const { invitationId } = await seedOpenInviteFor(f2);
      await admin.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [invitationId]);

      const result = await attemptWrite(f2.accountId, f2.o1, (client) =>
        client.query('UPDATE invitations SET accepted_at = NULL WHERE id = $1', [invitationId]),
      );
      expectRefusedWrite(result);

      const { rows } = await admin.query('SELECT accepted_at IS NOT NULL AS consumed FROM invitations WHERE id = $1', [
        invitationId,
      ]);
      expect(rows).toEqual([{ consumed: true }]);
    });

    it.each([
      ['role', "'owner'"],
      ['expires_at', "now() + interval '1 year'"],
      ['email', "'someone-else@example.test'"],
      ['invited_by', 'gen_random_uuid()'],
    ])('(e) O1 UPDATE SET %s = ... is rejected with 42501', async (column, valueSql) => {
      const f2 = await seedF2(admin);
      const { invitationId } = await seedOpenInviteFor(f2);
      const before = await admin.query('SELECT * FROM invitations WHERE id = $1', [invitationId]);

      await expect(
        withTenant(appUserPool, f2.accountId, f2.o1, async (client) => {
          await client.query(`UPDATE invitations SET ${column} = ${valueSql} WHERE id = $1`, [invitationId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      const after = await admin.query('SELECT * FROM invitations WHERE id = $1', [invitationId]);
      expect(after.rows).toEqual(before.rows);
    });

    it('(f) DELETE the open invitation: M1 refused, A1 and O1 allowed', async () => {
      const f2 = await seedF2(admin);

      const m1Attempt = await seedOpenInviteFor(f2);
      const m1Result = await attemptWrite(f2.accountId, f2.m1, (client) =>
        client.query('DELETE FROM invitations WHERE id = $1', [m1Attempt.invitationId]),
      );
      expectRefusedWrite(m1Result);
      expect((await admin.query('SELECT 1 FROM invitations WHERE id = $1', [m1Attempt.invitationId])).rows).toHaveLength(
        1,
      );

      const a1Attempt = await seedOpenInviteFor(f2);
      const a1Result = await withTenant(appUserPool, f2.accountId, f2.a1, async (client) => {
        const r = await client.query('DELETE FROM invitations WHERE id = $1', [a1Attempt.invitationId]);
        return r.rowCount;
      });
      expect(a1Result).toBe(1);

      const o1Attempt = await seedOpenInviteFor(f2);
      const o1Result = await withTenant(appUserPool, f2.accountId, f2.o1, async (client) => {
        const r = await client.query('DELETE FROM invitations WHERE id = $1', [o1Attempt.invitationId]);
        return r.rowCount;
      });
      expect(o1Result).toBe(1);
    });
  });

  describe('criterion 10: owner invitations need a current owner inviter (DB layer)', () => {
    it('(a) O1 issues an owner invite for J; O1 is then demoted; J cannot join as owner', async () => {
      const f2 = await seedF2(admin);
      const result = await attemptInsertInvitation(f2.accountId, f2.o1, f2.o1, 'owner');
      expect(result.error).toBeNull();
      const invitedEmail = await admin.query<{ email: string }>('SELECT email FROM invitations WHERE id = $1', [
        result.id,
      ]);

      const j = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [j, invitedEmail.rows[0]!.email]);

      // O2 remains owner, so demoting O1 doesn't trip the last-owner trigger.
      await admin.query(`UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2`, [
        f2.accountId,
        f2.o1,
      ]);

      await expect(
        withTenant(appUserPool, f2.accountId, j, async (client) => {
          await client.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
            f2.accountId,
            j,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      expect(await readMemberRow(admin, f2.accountId, j)).toBeNull();
    });

    it('(b) the same, with O1 still owner, succeeds', async () => {
      const f2 = await seedF2(admin);
      const result = await attemptInsertInvitation(f2.accountId, f2.o1, f2.o1, 'owner');
      expect(result.error).toBeNull();
      const invitedEmail = await admin.query<{ email: string }>('SELECT email FROM invitations WHERE id = $1', [
        result.id,
      ]);

      const j = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [j, invitedEmail.rows[0]!.email]);

      const rowCount = await withTenant(appUserPool, f2.accountId, j, async (client) => {
        const r = await client.query(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [f2.accountId, j],
        );
        return r.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('(c) a member invitation issued by A1, since demoted to member, still admits J -- only owner invitations are rechecked', async () => {
      const f2 = await seedF2(admin);
      const result = await attemptInsertInvitation(f2.accountId, f2.a1, f2.a1, 'member');
      expect(result.error).toBeNull();
      const invitedEmail = await admin.query<{ email: string }>('SELECT email FROM invitations WHERE id = $1', [
        result.id,
      ]);

      const j = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [j, invitedEmail.rows[0]!.email]);

      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [
        f2.accountId,
        f2.a1,
      ]);

      const rowCount = await withTenant(appUserPool, f2.accountId, j, async (client) => {
        const r = await client.query(
          `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`,
          [f2.accountId, j],
        );
        return r.rowCount;
      });
      expect(rowCount).toBe(1);
    });
  });
});
