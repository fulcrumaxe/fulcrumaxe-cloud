import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { emitBudgetExhaustedOnce, emitDomainEvent } from '../src/domain-events/emit.js';

/**
 * D#31 API-4a criterion 5 (outbox atomicity) against real Postgres:
 *   - a transaction that rolls back after emitDomainEvent leaves no row;
 *   - emitBudgetExhaustedOnce is idempotent per (account, budget, month).
 */
describe('domain-events/emit (D#31 API-4a)', () => {
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

  async function countEvents(accountId: string, type: string): Promise<number> {
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM domain_events WHERE account_id = $1 AND type = $2`,
      [accountId, type],
    );
    return Number(rows[0]!.count);
  }

  it('writes a row inside the caller-owned transaction, visible after COMMIT', async () => {
    const type = `test.committed.${randomUUID()}`;
    const before = await countEvents(refsA.accountId, type);

    const emitted = await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) =>
      emitDomainEvent(client, {
        type,
        accountId: refsA.accountId,
        payload: { workItemId: refsA.workItemId, stage: 'pr_opened' },
      }),
    );

    expect(emitted.id).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(await countEvents(refsA.accountId, type)).toBe(before + 1);

    const { rows } = await admin.query(`SELECT seq, id, payload FROM domain_events WHERE id = $1`, [emitted.id]);
    expect(rows).toHaveLength(1);
    // The private serial is never part of the public identifier.
    expect(typeof rows[0].seq).toBe('string'); // bigint comes back as a string from node-postgres
    expect(rows[0].payload).toEqual({ workItemId: refsA.workItemId, stage: 'pr_opened' });
  });

  it('a transaction that rolls back after emitDomainEvent leaves no row (criterion 5)', async () => {
    const type = `test.rolledback.${randomUUID()}`;
    const before = await countEvents(refsA.accountId, type);

    class InjectedFailure extends Error {}
    await expect(
      withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await emitDomainEvent(client, { type, accountId: refsA.accountId, payload: {} });
        throw new InjectedFailure('simulated failure after emit, before commit');
      }),
    ).rejects.toBeInstanceOf(InjectedFailure);

    expect(await countEvents(refsA.accountId, type)).toBe(before);
  });

  it('tenant isolation: account A cannot see account B rows, and cannot insert into account B', async () => {
    const type = `test.isolation.${randomUUID()}`;
    await withTenant(appUserPool, refsB.accountId, refsB.userId, (client) =>
      emitDomainEvent(client, { type, accountId: refsB.accountId, payload: {} }),
    );

    const seenByA = await withTenant(appUserPool, refsA.accountId, refsA.userId, (client) =>
      client.query(`SELECT 1 FROM domain_events WHERE type = $1`, [type]),
    );
    expect(seenByA.rows).toHaveLength(0);

    // A's own transaction cannot insert a row claiming to be B's account --
    // the WITH CHECK on tenant_isolation_insert rejects the mismatch.
    await expect(
      withTenant(appUserPool, refsA.accountId, refsA.userId, (client) =>
        emitDomainEvent(client, { type: `${type}.cross`, accountId: refsB.accountId, payload: {} }),
      ),
    ).rejects.toThrow();
  });

  describe('emitBudgetExhaustedOnce', () => {
    it('3 denials in the same calendar month emit exactly 1 event', async () => {
      const accountId = refsA.accountId;
      const before = await countEvents(accountId, 'budget.exhausted');

      for (let i = 0; i < 3; i++) {
        await withTenant(appUserPool, accountId, refsA.userId, (client) =>
          emitBudgetExhaustedOnce(client, accountId, 'model', new Date('2026-03-15T00:00:00.000Z')),
        );
      }

      expect(await countEvents(accountId, 'budget.exhausted')).toBe(before + 1);
    });

    it('a different budget, or a different calendar month, gets its own event', async () => {
      const accountId = refsB.accountId;
      const before = await countEvents(accountId, 'budget.exhausted');

      await withTenant(appUserPool, accountId, refsB.userId, (client) =>
        emitBudgetExhaustedOnce(client, accountId, 'model', new Date('2026-04-01T00:00:00.000Z')),
      );
      await withTenant(appUserPool, accountId, refsB.userId, (client) =>
        emitBudgetExhaustedOnce(client, accountId, 'foreground_compute', new Date('2026-04-01T00:00:00.000Z')),
      );
      await withTenant(appUserPool, accountId, refsB.userId, (client) =>
        emitBudgetExhaustedOnce(client, accountId, 'model', new Date('2026-05-01T00:00:00.000Z')),
      );

      // model/April, foreground_compute/April, model/May: 3 distinct events.
      expect(await countEvents(accountId, 'budget.exhausted')).toBe(before + 3);
    });
  });
});
