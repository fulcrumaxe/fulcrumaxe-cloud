import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';

describe('withTenant', () => {
  let pool: Pool;

  beforeAll(() => {
    // max: 1 forces every acquisition to reuse the same underlying
    // connection, so a leak of SET LOCAL past its transaction is directly
    // observable on the very next connect().
    pool = createPool(process.env.DATABASE_URL_APP_USER!, { max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sets app.account_id for the duration of the callback', async () => {
    const accountId = randomUUID();
    const seen = await withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ v: string }>(
        "SELECT current_setting('app.account_id', true) AS v",
      );
      return rows[0].v;
    });
    expect(seen).toBe(accountId);
  });

  it('does not leak app.account_id to the next pooled connection (success path)', async () => {
    const accountId = randomUUID();
    await withTenant(pool, accountId, async () => {});

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.account_id', true) AS v",
      );
      // SET LOCAL is transaction-scoped by Postgres itself, so by the time
      // this runs, the value has ALREADY reverted -- to '' (the boot value
      // of a placeholder that's been touched at least once on this
      // backend), same as migrations/0001_core.sql's long comment on the
      // NULLIF policy guard. Either way, the real accountId must be gone.
      expect(rows[0].v === null || rows[0].v === '').toBe(true);
      expect(rows[0].v).not.toBe(accountId);
    } finally {
      client.release();
    }
  });

  it('does not leak app.account_id to the next pooled connection (error path)', async () => {
    const accountId = randomUUID();
    await expect(
      withTenant(pool, accountId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.account_id', true) AS v",
      );
      expect(rows[0].v === null || rows[0].v === '').toBe(true);
      expect(rows[0].v).not.toBe(accountId);
    } finally {
      client.release();
    }
  });

  it(
    'RESET in finally is what clears a SESSION-level override, even though transaction-end ' +
      'scoping alone already handles the ordinary (SET LOCAL) case above',
    async () => {
      // D#2605 H02 security fix round 2, item 2. Transaction-end scoping
      // (the two tests above) only protects a value set with SET LOCAL /
      // set_config(..., true). It does NOT protect against a callback
      // that sets the GUC at SESSION level instead -- is_local=false
      // persists past COMMIT, same as a plain `SET`. That's exactly the
      // "caller misusing the client" case withTenant's RESET-in-finally
      // exists for. Simulate it: fn sets app.account_id at session level
      // to a THIRD value, then withTenant's own finally must still clear
      // it before the connection goes back to the pool. Against the code
      // before this fix round (no RESET call at all), this test is RED:
      // the malicious value survives release() and is what the next
      // borrower would see.
      const accountId = randomUUID();
      const sessionLevelValue = randomUUID();
      await withTenant(pool, accountId, async (client) => {
        await client.query('SELECT set_config($1, $2, false)', [
          'app.account_id',
          sessionLevelValue,
        ]);
      });

      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ v: string | null }>(
          "SELECT current_setting('app.account_id', true) AS v",
        );
        expect(rows[0].v).not.toBe(sessionLevelValue);
      } finally {
        client.release();
      }
    },
  );

  it('rolls back and still releases the connection on error', async () => {
    await expect(
      withTenant(pool, randomUUID(), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Pool must still be usable afterwards -- proves release() ran even on error.
    const client = await pool.connect();
    client.release();
  });

  it('rejects a non-UUID accountId before ever acquiring a connection', async () => {
    let fnCalled = false;
    await expect(
      withTenant(pool, 'not-a-uuid', async () => {
        fnCalled = true;
      }),
    ).rejects.toThrow(/uuid/i);
    expect(fnCalled).toBe(false);
  });

  it('rejects an empty-string accountId (the placeholder-reset value, not a valid tenant)', async () => {
    await expect(withTenant(pool, '', async () => {})).rejects.toThrow(/uuid/i);
  });

  // D#2607 X1: withTenant's optional userId, set alongside app.account_id.
  it('sets app.user_id for the duration of the callback when given (4-arg form)', async () => {
    const accountId = randomUUID();
    const userId = randomUUID();
    const seen = await withTenant(pool, accountId, userId, async (client) => {
      const { rows } = await client.query<{ acct: string; usr: string }>(
        "SELECT current_setting('app.account_id', true) AS acct, current_setting('app.user_id', true) AS usr",
      );
      return rows[0];
    });
    expect(seen).toEqual({ acct: accountId, usr: userId });
  });

  it('the 3-arg form leaves app.user_id unset', async () => {
    const accountId = randomUUID();
    const seen = await withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.user_id', true) AS v",
      );
      return rows[0].v;
    });
    // Either genuinely NULL (never touched on this connection) or '' (the
    // placeholder-reset value from an EARLIER test's userId use on this
    // same size-1 pool) -- either way, not a real user id.
    expect(seen === null || seen === '').toBe(true);
  });

  it('does not leak app.user_id to the next pooled connection', async () => {
    const accountId = randomUUID();
    const userId = randomUUID();
    await withTenant(pool, accountId, userId, async () => {});

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.user_id', true) AS v",
      );
      expect(rows[0].v === null || rows[0].v === '').toBe(true);
      expect(rows[0].v).not.toBe(userId);
    } finally {
      client.release();
    }
  });

  it('RESET also clears a SESSION-level override of app.user_id', async () => {
    const accountId = randomUUID();
    const userId = randomUUID();
    const sessionLevelValue = randomUUID();
    await withTenant(pool, accountId, userId, async (client) => {
      await client.query('SELECT set_config($1, $2, false)', ['app.user_id', sessionLevelValue]);
    });

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.user_id', true) AS v",
      );
      expect(rows[0].v).not.toBe(sessionLevelValue);
    } finally {
      client.release();
    }
  });

  it('rejects a non-UUID userId before ever acquiring a connection', async () => {
    let fnCalled = false;
    await expect(
      withTenant(pool, randomUUID(), 'not-a-uuid', async () => {
        fnCalled = true;
      }),
    ).rejects.toThrow(/uuid/i);
    expect(fnCalled).toBe(false);
  });
});
