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
 * D#221 MC1: migration 0800 on a database that already holds connections. Same shape as migrate-0629-upgrade.test.ts: a
 * fresh database migrated through every file before 0800, seeded with rows the way they exist today (no kind, no backend,
 * no AAD version), then the real migrations directory picks up 0800 and the rows must come out meaning what they meant.
 */
const MIGRATION = '0800_model_connection_kinds.sql';

describe('migrate: the 0800 upgrade path (D#221 MC1 connection kinds)', () => {
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

  async function migrateBefore0800(): Promise<Pool> {
    const dbName = await dbs.create('fx_0800_upgrade');
    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());
    const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(allFiles).toContain(MIGRATION);
    const pre = allFiles.filter((f) => f < MIGRATION);
    tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0800-upgrade-'));
    for (const f of pre) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
    expect((await runMigrations(pool, tmpMigrationsDir)).applied).toEqual(pre);
    return pool;
  }

  async function seedConnection(pool: Pool, provider: 'ai_gateway' | 'anthropic', status: string): Promise<string> {
    const accountId = randomUUID();
    const id = randomUUID();
    await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await pool.query(
      `INSERT INTO model_connections (id, account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status, last_validated_at)
       VALUES ($1, $2, $3, '\\x01', '\\x02', '\\x03', 1, 'abcd', $4, CASE WHEN $4 = 'ok' THEN now() ELSE NULL END)`,
      [id, accountId, provider, status],
    );
    return id;
  }

  it('existing rows keep their provider as their kind, stay at AAD version 1 on claude-code, and are otherwise untouched', async () => {
    const pool = await migrateBefore0800();
    try {
      const gateway = await seedConnection(pool, 'ai_gateway', 'ok');
      const anthropic = await seedConnection(pool, 'anthropic', 'unvalidated');
      const before = (await pool.query(`SELECT id, status, last_validated_at, updated_at, key_ciphertext, key_nonce, wrapped_dek FROM model_connections ORDER BY id`)).rows;

      expect((await runMigrations(pool)).applied[0]).toBe(MIGRATION);

      const { rows } = await pool.query(
        `SELECT id, provider, credential_kind, backend, aad_version, status, last_validated_at, updated_at, key_ciphertext, key_nonce, wrapped_dek
           FROM model_connections ORDER BY id`,
      );
      expect(rows.map((r) => [r.provider, r.credential_kind, r.backend, r.aad_version])).toEqual(
        rows.map((r) => [r.provider, r.provider, 'claude-code', 1]),
      );
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([gateway, anthropic]));
      // The backfill rewrote nothing else: not the status, the validation time, the update time or the sealed key.
      for (let i = 0; i < rows.length; i++) {
        for (const col of ['id', 'status', 'last_validated_at', 'updated_at', 'key_ciphertext', 'key_nonce', 'wrapped_dek']) {
          expect(rows[i]![col], col).toEqual(before[i]![col]);
        }
      }
    } finally {
      await pool.end();
    }
  });

  it('leaves every trigger on model_connections enabled, and the new checks and the OpenAI provider live', async () => {
    const pool = await migrateBefore0800();
    try {
      await seedConnection(pool, 'ai_gateway', 'ok');
      await runMigrations(pool);
      const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'model_connections'::regclass AND NOT tgisinternal`,
      );
      expect(triggers.rows.length).toBeGreaterThanOrEqual(3);
      expect(triggers.rows.filter((t) => t.tgenabled !== 'O')).toEqual([]);
      expect(triggers.rows.map((t) => t.tgname)).toEqual(expect.arrayContaining(['model_connections_guard_write', 'model_connections_default_kind']));

      const insert = (provider: string, kind: string | null, aad: number) =>
        pool.query(
          `INSERT INTO model_connections (account_id, provider, credential_kind, aad_version, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
           SELECT id, $1, $2, $3, '\\x01', '\\x02', '\\x03', 1, 'abcd' FROM accounts LIMIT 1`,
          [provider, kind, aad],
        );
      await expect(insert('openai', 'openai_api_key', 2)).resolves.toBeDefined();
      await expect(insert('openai', 'openai_api_key', 1)).rejects.toMatchObject({ constraint: 'model_connections_aad_version_kind_check' });
      await expect(insert('openai', 'ai_gateway', 2)).rejects.toMatchObject({ constraint: 'model_connections_kind_provider_check' });
      await expect(insert('azure', 'ai_gateway', 2)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await pool.end();
    }
  });
});
