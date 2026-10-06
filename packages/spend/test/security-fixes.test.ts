import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant } from '../src/pg.js';
import { reserve } from '../src/reserve.js';
import { seedAccount, seedModelConnectionOk, seedRun } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2605 H05: security review needs-fix round 3, migrations/
 * 0003_spend_security_fixes.sql. Three findings, each proved directly
 * against a real Postgres rather than asserted through packages/spend's
 * own TypeScript wrapper, since all three are database-enforced.
 */
describe('security review round 3 fixes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let accountId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.SPEND_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.SPEND_DATABASE_URL_APP_USER!);
    accountId = randomUUID();
    await seedAccount(admin, accountId);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('E4: model_connections table-wide INSERT can no longer self-attest a validated key', () => {
    it('a tenant INSERT that tries to set status = ok is rejected outright', async () => {
      await expect(
        withTenant(appUserPool, accountId, async (client) => {
          await client.query(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, 'ok')`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), `fp-${randomUUID()}`],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('a tenant INSERT that tries to set last_validated_at is rejected outright', async () => {
      await expect(
        withTenant(appUserPool, accountId, async (client) => {
          await client.query(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, last_validated_at)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, now())`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), `fp-${randomUUID()}`],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('an ordinary tenant INSERT that leaves status/last_validated_at/last_error_code at their defaults still succeeds, and lands unvalidated', async () => {
      const fingerprint = `fp-${randomUUID()}`;
      await withTenant(appUserPool, accountId, async (client) => {
        await client.query(
          `INSERT INTO model_connections
             (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
           VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5)`,
          [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
        );
      });
      const { rows } = await admin.query(
        `SELECT status, last_validated_at, last_error_code FROM model_connections WHERE key_fingerprint = $1`,
        [fingerprint],
      );
      expect(rows[0]).toMatchObject({ status: 'unvalidated', last_validated_at: null, last_error_code: null });
    });
  });

  describe('usd CHECK: NaN and Infinity are rejected on both money columns', () => {
    /**
     * 'Infinity' fails with a DIFFERENT SQLSTATE than 'NaN'/'-1', proved
     * directly against a real Postgres rather than assumed: both columns
     * are `numeric(10, 4)` (a bounded precision/scale), and Postgres
     * enforces that bound -- and rejects 'Infinity' as an overflow of it
     * (22003, "numeric field overflow") -- at type-coercion time, before
     * any CHECK constraint ever runs. 'NaN' has no magnitude to overflow
     * (it is explicitly exempt from precision/scale enforcement, which is
     * exactly why `usd >= 0` alone lets it through -- see this
     * migration's file header), so it reaches, and is caught by,
     * `ledger_usd_finite_check` / `spend_reservations_usd_reserved_finite_check`
     * (23514, "check_violation"), same as the plain -1 case. Either way,
     * the insert fails -- confirmed by rejects.toMatchObject below for
     * every one of the three values on both columns.
     */
    const expectedCode: Record<string, string> = {
      NaN: PG_ERROR.CHECK_VIOLATION,
      Infinity: PG_ERROR.NUMERIC_OVERFLOW,
      '-1': PG_ERROR.CHECK_VIOLATION,
    };

    it.each(['NaN', 'Infinity', '-1'])('ledger.usd = %s is rejected', async (value) => {
      const runId = randomUUID();
      await seedRun(admin, accountId, runId);
      await expect(
        admin.query(
          `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`,
          [accountId, value, runId],
        ),
      ).rejects.toMatchObject({ code: expectedCode[value] });
    });

    it.each(['NaN', 'Infinity', '-1'])('spend_reservations.usd_reserved = %s is rejected', async (value) => {
      const runId = randomUUID();
      await seedRun(admin, accountId, runId);
      await expect(
        admin.query(
          `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, $3, 'open', 'model')`,
          [accountId, runId, value],
        ),
      ).rejects.toMatchObject({ code: expectedCode[value] });
    });

    it('a positive finite usd still inserts normally on both columns', async () => {
      const runId = randomUUID();
      await seedRun(admin, accountId, runId);
      await expect(
        admin.query(
          `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 12.5, 'open', 'model')`,
          [accountId, runId],
        ),
      ).resolves.toBeDefined();
      await expect(
        admin.query(
          `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 12.5, $2, 'model')`,
          [accountId, runId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('spend_reservations.purpose is persisted and immutable', () => {
    it("reserve() persists the caller's purpose", async () => {
      // purpose: 'preview' skips the accounts.status gate but requires an
      // ok model_connections row (H05 pass/fail 5) -- seed one via admin
      // (bypassing the E4 guard above: admin connects as the Postgres
      // superuser, which satisfies pg_has_role() for any role, including
      // platform_ops, unconditionally) so this test proves persistence,
      // not the preview gate itself (that's reserve-denials.test.ts's
      // job).
      const runId = randomUUID();
      await seedRun(admin, accountId, runId);
      await seedModelConnectionOk(admin, accountId);
      const result = await reserve(appUserPool, {
        accountId,
        runId,
        plan: 'starter',
        purpose: 'preview',
        estimateModelUsd: 5,
        monthlyModelBudgetUsd: 100,
      });
      expect(result.decision).toBe('admit');
      const { rows } = await admin.query(`SELECT purpose FROM spend_reservations WHERE run_id = $1`, [runId]);
      expect(rows[0].purpose).toBe('preview');
    });

    it('a tenant UPDATE of purpose is refused', async () => {
      const runId = randomUUID();
      await seedRun(admin, accountId, runId);
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
         VALUES ($1, $2, 5, 'open', 'model', 'run') RETURNING id`,
        [accountId, runId],
      );
      const id = rows[0].id;
      await expect(
        withTenant(appUserPool, accountId, async (client) => {
          await client.query(`UPDATE spend_reservations SET purpose = 'preview' WHERE id = $1`, [id]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('the legitimate open -> settled state UPDATE (which never touches purpose) still succeeds', async () => {
      const runId = randomUUID();
      await seedRun(admin, accountId, runId);
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
         VALUES ($1, $2, 5, 'open', 'model', 'run') RETURNING id`,
        [accountId, runId],
      );
      const id = rows[0].id;
      await withTenant(appUserPool, accountId, async (client) => {
        await expect(
          client.query(`UPDATE spend_reservations SET state = 'settled' WHERE id = $1`, [id]),
        ).resolves.toBeDefined();
      });
    });
  });

  /**
   * D#2605 H05: security review round 4 (PR #11), needs-fix. Two blocking/
   * should-fix findings against 0003_spend_security_fixes.sql's round-3
   * trigger, plus the round-4 informational note on spend_reservations.id,
   * all closed in the same migration edit and proved here the same way
   * round 3 was: directly against a real Postgres, not through mocks.
   */
  describe('security review round 5 fixes', () => {
    let platformOpsPool: Pool;

    beforeAll(() => {
      platformOpsPool = createPool(process.env.SPEND_DATABASE_URL_PLATFORM_OPS!);
    });

    afterAll(async () => {
      await platformOpsPool.end();
    });

    describe('E4 closed on UPDATE and upsert too (round-4 finding 1, error)', () => {
      it('an INSERT that lands unvalidated, followed by a tenant UPDATE to status = ok, is rejected', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        await expect(
          withTenant(appUserPool, accountId, async (client) => {
            await client.query(
              `UPDATE model_connections SET status = 'ok', last_validated_at = now() WHERE id = $1`,
              [id],
            );
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });

      it('a single INSERT ... ON CONFLICT (id) DO UPDATE upsert setting status = ok is rejected', async () => {
        const id = randomUUID();
        const fingerprint = `fp-${randomUUID()}`;
        await withTenant(appUserPool, accountId, async (client) => {
          await client.query(
            `INSERT INTO model_connections
               (id, account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, $2, 'ai_gateway', $3, $4, $5, 1, $6)`,
            [id, accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
        });

        await expect(
          withTenant(appUserPool, accountId, async (client) => {
            await client.query(
              `INSERT INTO model_connections
                 (id, account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
               VALUES ($1, $2, 'ai_gateway', $3, $4, $5, 1, $6)
               ON CONFLICT (id) DO UPDATE SET status = 'ok', last_validated_at = now()`,
              [id, accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
            );
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    describe('deny-by-default scoping (round-4 finding 2, warning)', () => {
      it('a login role that merely inherits app_user (not literally named app_user) is still guarded', async () => {
        const roleName = `rf5_member_${randomUUID().replace(/-/g, '_')}`;
        await admin.query(`CREATE ROLE ${roleName} LOGIN IN ROLE app_user`);
        const memberUrl = process.env.SPEND_DATABASE_URL_APP_USER!.replace('app_user@', `${roleName}@`);
        const memberPool = createPool(memberUrl);
        try {
          await expect(
            withTenant(memberPool, accountId, async (client) => {
              await client.query(
                `INSERT INTO model_connections
                   (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
                 VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, 'ok')`,
                [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), `fp-${randomUUID()}`],
              );
            }),
          ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        } finally {
          await memberPool.end();
          await admin.query(`DROP ROLE ${roleName}`);
        }
      });
    });

    describe('the privileged validation path', () => {
      it('platform_ops can set status = ok on a row app_user left unvalidated', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          await expect(
            platformOps.query(
              `UPDATE model_connections SET status = 'ok', last_validated_at = now() WHERE id = $1`,
              [id],
            ),
          ).resolves.toBeDefined();
        } finally {
          platformOps.release();
        }

        const { rows } = await admin.query(
          `SELECT status, last_validated_at FROM model_connections WHERE id = $1`,
          [id],
        );
        expect(rows[0].status).toBe('ok');
        expect(rows[0].last_validated_at).not.toBeNull();
      });

      it('platform_ops cannot touch key material through the same narrow grant', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          await expect(
            platformOps.query(`UPDATE model_connections SET key_fingerprint = 'hijacked' WHERE id = $1`, [id]),
          ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        } finally {
          platformOps.release();
        }
      });
    });

    describe('spend_reservations.id is immutable (round-4 informational note, round-5 suggestion 3)', () => {
      it('a tenant UPDATE that moves id is refused', async () => {
        const runId = randomUUID();
        await seedRun(admin, accountId, runId);
        const { rows } = await admin.query<{ id: string }>(
          `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
           VALUES ($1, $2, 5, 'open', 'model', 'run') RETURNING id`,
          [accountId, runId],
        );
        const id = rows[0].id;
        await expect(
          withTenant(appUserPool, accountId, async (client) => {
            await client.query(`UPDATE spend_reservations SET id = $1 WHERE id = $2`, [randomUUID(), id]);
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });
  });

  /**
   * D#2605 H05: security review round 5 (PR #11), needs-fix. One blocking
   * finding (platform_ops's SELECT grant on model_connections was
   * table-wide, reachable directly and through any role merely IN ROLE
   * platform_ops) and one should-fix-now finding (key material/provider
   * rotation left a validated row reading status = 'ok'), both against
   * migrations/0003_spend_security_fixes.sql, closed in the same migration
   * edit and proved here directly against a real Postgres.
   */
  describe('security review round 6 fixes', () => {
    let platformOpsPool: Pool;

    beforeAll(() => {
      platformOpsPool = createPool(process.env.SPEND_DATABASE_URL_PLATFORM_OPS!);
    });

    afterAll(async () => {
      await platformOpsPool.end();
    });

    describe('platform_ops SELECT on model_connections is column-scoped (round-5 finding 1, error)', () => {
      it('platform_ops gets 42501 selecting a key-material column directly', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          await expect(
            platformOps.query(`SELECT key_ciphertext FROM model_connections WHERE id = $1`, [id]),
          ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        } finally {
          platformOps.release();
        }
      });

      it('platform_ops gets 42501 on SELECT *', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          await expect(
            platformOps.query(`SELECT * FROM model_connections WHERE id = $1`, [id]),
          ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        } finally {
          platformOps.release();
        }
      });

      it('the validation UPDATE still succeeds through a subselect + RETURNING, using only the six granted columns', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          // Referencing only the six granted columns -- including in the
          // WHERE clause, where any other column (even one this query
          // never returns) would also need column-level SELECT.
          await expect(
            platformOps.query(
              `SELECT id, account_id, provider, status, last_validated_at, last_error_code
                 FROM model_connections WHERE id = $1 AND account_id = $2`,
              [id, accountId],
            ),
          ).resolves.toBeDefined();

          const { rows } = await platformOps.query(
            `UPDATE model_connections
               SET status = 'ok', last_validated_at = now()
               WHERE id = (SELECT id FROM model_connections WHERE id = $1 AND account_id = $2)
               RETURNING id, status`,
            [id, accountId],
          );
          expect(rows[0].status).toBe('ok');
        } finally {
          platformOps.release();
        }
      });
    });

    describe('key/provider rotation resets validation (round-5 finding 2, warning)', () => {
      it('platform_ops validates, app_user swaps the key, the row falls back to unvalidated, and the preview gate denies', async () => {
        // A dedicated account, not the describe block's shared `accountId`:
        // earlier tests in this file leave their own validated ('ok')
        // model_connections rows behind on that shared account, which would
        // make the account-wide preview-gate assertions below pass or fail
        // for the wrong reason.
        const rotationAccountId = randomUUID();
        await seedAccount(admin, rotationAccountId);

        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, rotationAccountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [rotationAccountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          await platformOps.query(
            `UPDATE model_connections SET status = 'ok', last_validated_at = now() WHERE id = $1`,
            [id],
          );
        } finally {
          platformOps.release();
        }

        const validated = await admin.query(
          `SELECT status, last_validated_at FROM model_connections WHERE id = $1`,
          [id],
        );
        expect(validated.rows[0].status).toBe('ok');
        expect(validated.rows[0].last_validated_at).not.toBeNull();

        const runIdBefore = randomUUID();
        await seedRun(admin, rotationAccountId, runIdBefore);
        const before = await reserve(appUserPool, {
          accountId: rotationAccountId,
          runId: runIdBefore,
          plan: 'starter',
          purpose: 'preview',
          estimateModelUsd: 5,
          monthlyModelBudgetUsd: 100,
        });
        expect(before.decision).toBe('admit');

        // app_user rotates the key -- status is left as submitted (still
        // 'ok'), so the round-5-finding-1 guard (which only rejects an
        // EXPLICIT change to status/last_validated_at/last_error_code)
        // does not fire on its own.
        await withTenant(appUserPool, rotationAccountId, async (client) => {
          await client.query(
            `UPDATE model_connections SET key_ciphertext = $1, key_fingerprint = $2 WHERE id = $3`,
            [Buffer.from('rotated-ciphertext'), `fp-${randomUUID()}`, id],
          );
        });

        const afterRotation = await admin.query(
          `SELECT status, last_validated_at, last_error_code FROM model_connections WHERE id = $1`,
          [id],
        );
        expect(afterRotation.rows[0]).toMatchObject({
          status: 'unvalidated',
          last_validated_at: null,
          last_error_code: null,
        });

        const gate = await admin.query(
          `SELECT 1 FROM model_connections WHERE account_id = $1 AND status = 'ok'`,
          [rotationAccountId],
        );
        expect(gate.rows.length).toBe(0);

        const runIdAfter = randomUUID();
        await seedRun(admin, rotationAccountId, runIdAfter);
        const after = await reserve(appUserPool, {
          accountId: rotationAccountId,
          runId: runIdAfter,
          plan: 'starter',
          purpose: 'preview',
          estimateModelUsd: 5,
          monthlyModelBudgetUsd: 100,
        });
        expect(after).toEqual({ decision: 'deny', reason: 'model_connection_not_ok' });
      });

      it('changing provider alone also resets a validated row back to unvalidated', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          await platformOps.query(
            `UPDATE model_connections SET status = 'ok', last_validated_at = now() WHERE id = $1`,
            [id],
          );
        } finally {
          platformOps.release();
        }

        await withTenant(appUserPool, accountId, async (client) => {
          await client.query(`UPDATE model_connections SET provider = 'anthropic' WHERE id = $1`, [id]);
        });

        const { rows } = await admin.query(
          `SELECT status, last_validated_at, last_error_code FROM model_connections WHERE id = $1`,
          [id],
        );
        expect(rows[0]).toMatchObject({ status: 'unvalidated', last_validated_at: null, last_error_code: null });
      });

      it('an UPDATE that touches neither key material nor provider does not disturb a validated row', async () => {
        const fingerprint = `fp-${randomUUID()}`;
        const id = await withTenant(appUserPool, accountId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO model_connections
               (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
             VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5) RETURNING id`,
            [accountId, Buffer.from('ct'), Buffer.from('n'), Buffer.from('w'), fingerprint],
          );
          return rows[0].id;
        });

        const platformOps = await platformOpsPool.connect();
        try {
          await platformOps.query(
            `UPDATE model_connections SET status = 'ok', last_validated_at = now() WHERE id = $1`,
            [id],
          );
        } finally {
          platformOps.release();
        }

        await withTenant(appUserPool, accountId, async (client) => {
          await expect(
            client.query(`UPDATE model_connections SET updated_at = now() WHERE id = $1`, [id]),
          ).resolves.toBeDefined();
        });

        const { rows } = await admin.query(
          `SELECT status, last_validated_at FROM model_connections WHERE id = $1`,
          [id],
        );
        expect(rows[0].status).toBe('ok');
        expect(rows[0].last_validated_at).not.toBeNull();
      });
    });
  });
});
