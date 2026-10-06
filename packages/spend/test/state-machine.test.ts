import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, withTenant } from '../src/pg.js';
import { seedAccount, seedRun } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2605 amendment A8 (H02/H03 security-review criteria, binding on H05):
 * "H05 owns spend_reservations.state ... each owning task defines the
 * legal values and transitions in one place and tests that an illegal
 * transition is refused."
 *
 * Legal values: open, settled, released (migrations/0002_spend_fns.sql's
 * CHECK constraint). Legal transitions: open -> settled, open ->
 * released. Everything else -- including settled/released back to open,
 * settled -> released, or a same-state no-op re-write -- is refused by
 * the migration's trigger, for any writer (app_user's ordinary UPDATE
 * grant included), not just through packages/spend's own settle()/
 * release() functions.
 */
describe('spend_reservations.state machine (A8)', () => {
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

  async function openReservation(): Promise<string> {
    const runId = randomUUID();
    await seedRun(admin, accountId, runId);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget)
       VALUES ($1, $2, 5, 'open', 'model') RETURNING id`,
      [accountId, runId],
    );
    return rows[0].id;
  }

  it('open -> settled is legal', async () => {
    const id = await openReservation();
    await withTenant(appUserPool, accountId, async (client) => {
      await expect(
        client.query(`UPDATE spend_reservations SET state = 'settled' WHERE id = $1`, [id]),
      ).resolves.toBeDefined();
    });
  });

  it('open -> released is legal', async () => {
    const id = await openReservation();
    await withTenant(appUserPool, accountId, async (client) => {
      await expect(
        client.query(`UPDATE spend_reservations SET state = 'released' WHERE id = $1`, [id]),
      ).resolves.toBeDefined();
    });
  });

  it('settled -> open is refused (would let a settled reservation re-enter the open aggregate)', async () => {
    const id = await openReservation();
    await admin.query(`UPDATE spend_reservations SET state = 'settled' WHERE id = $1`, [id]);
    await expect(
      withTenant(appUserPool, accountId, async (client) => {
        await client.query(`UPDATE spend_reservations SET state = 'open' WHERE id = $1`, [id]);
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('settled -> released is refused (settled is terminal)', async () => {
    const id = await openReservation();
    await admin.query(`UPDATE spend_reservations SET state = 'settled' WHERE id = $1`, [id]);
    await expect(
      withTenant(appUserPool, accountId, async (client) => {
        await client.query(`UPDATE spend_reservations SET state = 'released' WHERE id = $1`, [id]);
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('released -> settled is refused (released is terminal)', async () => {
    const id = await openReservation();
    await admin.query(`UPDATE spend_reservations SET state = 'released' WHERE id = $1`, [id]);
    await expect(
      withTenant(appUserPool, accountId, async (client) => {
        await client.query(`UPDATE spend_reservations SET state = 'settled' WHERE id = $1`, [id]);
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('an unrecognized state value is refused by the CHECK constraint, not just the trigger', async () => {
    const id = await openReservation();
    await expect(
      withTenant(appUserPool, accountId, async (client) => {
        await client.query(`UPDATE spend_reservations SET state = 'cancelled' WHERE id = $1`, [id]);
      }),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('the trigger is not bypassed for a superuser/admin connection either', async () => {
    // spend_reservations has no platform_ops grant at all (H02:
    // migrations/0001_core.sql grants app_user only) -- the role that
    // CAN reach this table beyond app_user is the migration-owner/admin
    // connection tests use directly. Triggers fire regardless of the
    // calling role's privilege level, unlike RLS's BYPASSRLS -- this
    // proves the guarantee isn't just an app_user-grant accident.
    const id = await openReservation();
    await admin.query(`UPDATE spend_reservations SET state = 'settled' WHERE id = $1`, [id]);
    await expect(
      admin.query(`UPDATE spend_reservations SET state = 'open' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });
});
