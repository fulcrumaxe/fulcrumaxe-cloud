import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { INSTALLATION_APP_KINDS } from '../../core/src/repos/appKinds.js';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

const MIGRATION = '0647_installations_app_kind_team_readonly.sql';

/**
 * D#31 API-8c, migration 0647: installations.app_kind accepts 'team_readonly'
 * next to 'team' and 'sitekit', and nothing else.
 */
describe('installations.app_kind CHECK (migration 0647)', () => {
  let adminPool: Pool;
  let dbs: ThrowawayDbs;
  let tmpDir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });

  afterEach(async () => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    await dbs.dropAll();
  });

  afterAll(async () => {
    await adminPool.end();
  });

  async function insertInstallation(pool: Pool, accountId: string, kind: string): Promise<void> {
    await pool.query(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3)`, [
      accountId,
      Math.floor(Math.random() * 1e9),
      kind,
    ]);
  }

  async function seedAccount(pool: Pool): Promise<string> {
    const accountId = randomUUID();
    await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
      accountId,
      `cus_${accountId}`,
    ]);
    return accountId;
  }

  it("accepts 'team', 'team_readonly' and 'sitekit' and rejects anything else", async () => {
    const accountId = await seedAccount(adminPool);
    for (const kind of INSTALLATION_APP_KINDS) {
      await expect(insertInstallation(adminPool, accountId, kind)).resolves.toBeUndefined();
    }
    for (const bad of ['x', '', 'Team', 'team_read_only']) {
      await expect(insertInstallation(adminPool, accountId, bad)).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
    }
  });

  it('the CHECK value set equals INSTALLATION_APP_KINDS', async () => {
    const { rows } = await adminPool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'installations'::regclass AND conname = 'installations_app_kind_check'`,
    );
    expect(rows).toHaveLength(1);
    const values = [...rows[0]!.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!);
    expect([...values].sort()).toEqual([...INSTALLATION_APP_KINDS].sort());
  });

  it("a 'team' row inserted before the migration survives it", async () => {
    const name = await dbs.create('fx_0647_upgrade');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    const pool = createPool(url.toString());
    try {
      const all = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      expect(all).toContain(MIGRATION);
      tmpDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0647-'));
      for (const f of all.filter((f) => f !== MIGRATION)) {
        copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpDir, f));
      }
      await runMigrations(pool, tmpDir);

      const accountId = await seedAccount(pool);
      await insertInstallation(pool, accountId, 'team');
      await expect(insertInstallation(pool, accountId, 'team_readonly')).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });

      const result = await runMigrations(pool);
      expect(result.applied).toEqual([MIGRATION]);

      const { rows } = await pool.query<{ app_kind: string }>(`SELECT app_kind FROM installations WHERE account_id = $1`, [
        accountId,
      ]);
      expect(rows.map((r) => r.app_kind)).toEqual(['team']);
      await expect(insertInstallation(pool, accountId, 'team_readonly')).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
