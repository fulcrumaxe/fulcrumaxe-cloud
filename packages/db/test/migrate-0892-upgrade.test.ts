import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

/**
 * Migration 0892 on a database that already holds webhook endpoints subscribed to the removed `merge_approval.decided`
 * event. Same shape as migrate-0800-upgrade.test.ts: migrate to just before 0892, seed, then apply the real directory.
 */
const MIGRATION = '0892_webhook_drop_merge_approval_event.sql';

describe('migrate: the 0892 upgrade path (merge_approval.decided removed from webhook subscriptions)', () => {
  let adminPool: Pool;
  let dbs: ThrowawayDbs;
  let tmpMigrationsDir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });
  afterEach(async () => {
    if (tmpMigrationsDir) {
      rmSync(tmpMigrationsDir, { recursive: true, force: true });
      tmpMigrationsDir = undefined;
    }
    await dbs.dropAll();
  });
  afterAll(async () => {
    await adminPool.end();
  });

  async function migrateBefore0892(): Promise<Pool> {
    const dbName = await dbs.create('fx_0892_upgrade');
    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());
    const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(allFiles).toContain(MIGRATION);
    const pre = allFiles.filter((f) => f < MIGRATION);
    tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0892-upgrade-'));
    for (const f of pre) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
    expect((await runMigrations(pool, tmpMigrationsDir)).applied).toEqual(pre);
    return pool;
  }

  async function seedEndpoint(pool: Pool, eventTypes: string[], status = 'active', disabledReason: string | null = null): Promise<string> {
    const accountId = randomUUID();
    const userId = randomUUID();
    const id = randomUUID();
    await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await pool.query(
      `INSERT INTO webhook_endpoints
         (id, account_id, url, event_types, secret_ciphertext, secret_nonce, wrapped_dek, kek_version, status, disabled_reason, created_by)
       VALUES ($1, $2, 'https://example.test/hook', $3, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 1, $4, $5, $6)`,
      [id, accountId, eventTypes, status, disabledReason, userId],
    );
    return id;
  }

  async function row(pool: Pool, id: string) {
    const { rows } = await pool.query(`SELECT event_types, status, disabled_reason FROM webhook_endpoints WHERE id = $1`, [id]);
    return rows[0] as { event_types: string[]; status: string; disabled_reason: string | null };
  }

  it('strips the event from a mixed subscription, parks an only-that-event endpoint, and leaves the rest alone', async () => {
    const pool = await migrateBefore0892();
    try {
      const mixed = await seedEndpoint(pool, ['pr.opened', 'merge_approval.decided', 'budget.exhausted']);
      const only = await seedEndpoint(pool, ['merge_approval.decided']);
      const clean = await seedEndpoint(pool, ['pr.opened', 'pr.ready_to_merge']);
      const cleanDisabled = await seedEndpoint(pool, ['pr.opened'], 'disabled');
      const onlyAlreadyDisabled = await seedEndpoint(pool, ['merge_approval.decided'], 'disabled', 'failing');
      const cleanBefore = (await pool.query(`SELECT updated_at FROM webhook_endpoints WHERE id = $1`, [clean])).rows[0];

      expect((await runMigrations(pool)).applied[0]).toBe(MIGRATION);

      expect(await row(pool, mixed)).toEqual({ event_types: ['pr.opened', 'budget.exhausted'], status: 'active', disabled_reason: null });
      expect(await row(pool, only)).toEqual({ event_types: ['endpoint.test'], status: 'disabled', disabled_reason: 'event_removed' });
      expect(await row(pool, clean)).toEqual({ event_types: ['pr.opened', 'pr.ready_to_merge'], status: 'active', disabled_reason: null });
      expect(await row(pool, cleanDisabled)).toEqual({ event_types: ['pr.opened'], status: 'disabled', disabled_reason: null });
      expect(await row(pool, onlyAlreadyDisabled)).toEqual({ event_types: ['endpoint.test'], status: 'disabled', disabled_reason: 'failing' });
      expect((await pool.query(`SELECT updated_at FROM webhook_endpoints WHERE id = $1`, [clean])).rows[0]).toEqual(cleanBefore);
      const left = await pool.query(`SELECT count(*)::int AS n FROM webhook_endpoints WHERE 'merge_approval.decided' = ANY (event_types)`);
      expect(left.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
