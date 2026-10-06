import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

/**
 * D#31 API-5a fix round 2 (CWE-362): domain_events.inserted_at is the stream's settle clock, so no caller
 * may choose it. A BEFORE INSERT OR UPDATE trigger (migration 0639) overwrites it -- for app_user and for
 * platform_ops alike -- and history is backfilled from created_at.
 */
const MIGRATION = '0639_stream_leases.sql';

describe('domain_events.inserted_at is database-assigned and caller-proof', () => {
  let admin: Pool;
  let app: Pool;
  let ops: Pool;

  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    app = createPool(process.env.DATABASE_URL_APP_USER!);
    ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    await admin.end();
    await app.end();
    await ops.end();
  });

  async function account(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_${id}`]);
    return id;
  }

  async function insertAsAppUser(accountId: string, sql: string, params: unknown[]): Promise<{ inserted_at: Date; created_at: Date }> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
      const { rows } = await c.query<{ inserted_at: Date; created_at: Date }>(sql, params);
      await c.query('COMMIT');
      return rows[0]!;
    } finally {
      c.release();
    }
  }

  it('app_user cannot set inserted_at: an explicit past or future value is overwritten with the insert-time clock', async () => {
    const accountId = await account();
    const before = Date.now();
    for (const supplied of ['2001-01-01T00:00:00Z', '2999-01-01T00:00:00Z']) {
      const row = await insertAsAppUser(
        accountId,
        `INSERT INTO domain_events (account_id, type, payload, created_at, inserted_at)
         VALUES ($1, 'pr.opened', '{}', $2, $2) RETURNING inserted_at, created_at`,
        [accountId, supplied],
      );
      expect(row.created_at.toISOString()).toBe(new Date(supplied).toISOString()); // created_at stays producer-suppliable
      expect(row.inserted_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.inserted_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it('inserted_at is the statement-time clock (clock_timestamp), not the transaction start', async () => {
    const accountId = await account();
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
      await c.query('SELECT now()');
      await c.query('SELECT pg_sleep(0.3)');
      const { rows } = await c.query<{ gap_ms: number }>(
        `INSERT INTO domain_events (account_id, type, payload) VALUES ($1, 'pr.opened', '{}')
         RETURNING (extract(epoch FROM (inserted_at - created_at)) * 1000)::float8 AS gap_ms`,
        [accountId],
      );
      await c.query('COMMIT');
      expect(rows[0]!.gap_ms).toBeGreaterThanOrEqual(250);
    } finally {
      c.release();
    }
  });

  it('platform_ops cannot set it either, on INSERT or by UPDATE', async () => {
    const accountId = await account();
    const ins = await ops.query<{ id: string; inserted_at: string }>(
      `INSERT INTO domain_events (account_id, type, payload, inserted_at) VALUES ($1, 'pr.opened', '{}', '2001-01-01') RETURNING id, inserted_at::text AS inserted_at`,
      [accountId],
    );
    expect(new Date(ins.rows[0]!.inserted_at).getFullYear()).toBeGreaterThan(2020);
    const upd = await ops.query<{ same: boolean }>(
      `UPDATE domain_events SET inserted_at = '2001-01-01' WHERE id = $1 RETURNING inserted_at::text = $2 AS same`,
      [ins.rows[0]!.id, ins.rows[0]!.inserted_at],
    );
    expect(upd.rows[0]!.same).toBe(true);
  });

  it('app_user cannot drop or disable the trigger (only the owner can)', async () => {
    await expect(app.query('ALTER TABLE domain_events DISABLE TRIGGER domain_events_pin_inserted_at')).rejects.toThrow(/must be owner|permission denied/i);
    await expect(app.query('DROP TRIGGER domain_events_pin_inserted_at ON domain_events')).rejects.toThrow(/must be owner|permission denied/i);
  });
});

describe('migration 0639 backfills inserted_at on an existing outbox', () => {
  let adminPool: Pool;
  let dbs: ThrowawayDbs;
  let tmpDir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });
  afterEach(async () => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    await dbs.dropAll();
  });
  afterAll(async () => {
    await adminPool.end();
  });

  it('every pre-existing row gets inserted_at = created_at (FORCE RLS restored afterwards)', async () => {
    const dbName = await dbs.create('fx_0639_upgrade');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const pool = createPool(url.toString());
    try {
      const all = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      const pre = all.filter((f) => f !== MIGRATION);
      expect(pre.length).toBe(all.length - 1);
      tmpDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0639-upgrade-'));
      for (const f of pre) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpDir, f));
      await runMigrations(pool, tmpDir);

      const accountId = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
      await pool.query(
        `INSERT INTO domain_events (account_id, type, payload, created_at)
         VALUES ($1, 'pr.opened', '{}', '2026-01-02T03:04:05Z'), ($1, 'run.started', '{}', '2026-02-03T04:05:06Z')`,
        [accountId],
      );

      const res = await runMigrations(pool);
      expect(res.applied).toEqual([MIGRATION]);

      const { rows } = await pool.query<{ ok: boolean }>(`SELECT inserted_at = created_at AS ok FROM domain_events WHERE account_id = $1`, [accountId]);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.ok)).toBe(true);
      const flags = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'domain_events'`,
      );
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const col = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'domain_events' AND column_name = 'inserted_at'`,
      );
      expect(col.rows[0]!.is_nullable).toBe('NO');
    } finally {
      await pool.end();
    }
  });
});
