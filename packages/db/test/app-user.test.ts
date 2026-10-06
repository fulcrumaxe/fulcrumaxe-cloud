import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { runMigrations } from '../src/migrate.js';

describe('app_user role', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has BYPASSRLS = false', async () => {
    const { rows } = await pool.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_user'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it('owns no tables', async () => {
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'app_user'",
    );
    expect(rows).toEqual([]);
  });

  it('cannot CREATE TEMP TABLE (TEMP revoked from PUBLIC and from app_user)', async () => {
    const appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    try {
      const client = await appUserPool.connect();
      try {
        await expect(client.query('CREATE TEMP TABLE t_probe (id int)')).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        client.release();
      }
    } finally {
      await appUserPool.end();
    }
  });

  it(
    'a pre-existing app_user role (from an earlier migration on another database on this ' +
      'cluster -- roles are cluster-wide) gets its attributes corrected, not just created-once',
    async () => {
      // D#2605 H02 security fix round 2, item 3. Roles are cluster-wide, so
      // "app_user already exists" happens for real whenever a second
      // database on the same Postgres instance runs this migration for the
      // FIRST time: migrate.ts's schema_migrations bookkeeping is
      // per-database, but pg_roles is not. Simulate that by corrupting the
      // already-migrated app_user's attributes directly, then applying
      // 0001_core.sql to a BRAND NEW, never-migrated database on this same
      // cluster: its CREATE ROLE branch is skipped (the role already
      // exists), so only an unconditional ALTER ROLE (this fix) can
      // correct it.
      // This corrupts a role shared by the WHOLE cluster, including every
      // other test file's connections. If the fix under test is missing or
      // broken, nothing else in this run would un-corrupt it -- so the
      // outer try/finally unconditionally restores safe attributes no
      // matter how the assertions below turn out, isolating this test's
      // blast radius to itself.
      const dbName = `fx_role_idem_${randomUUID().replace(/-/g, '')}`;
      try {
        await pool.query('ALTER ROLE app_user BYPASSRLS SUPERUSER');
        const { rows: corrupted } = await pool.query<{
          rolbypassrls: boolean;
          rolsuper: boolean;
        }>("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_user'");
        expect(corrupted[0]).toEqual({ rolbypassrls: true, rolsuper: true });

        await pool.query(`CREATE DATABASE ${dbName}`);
        const otherUrl = new URL(process.env.DATABASE_URL!);
        otherUrl.pathname = `/${dbName}`;
        const otherPool = createPool(otherUrl.toString());
        try {
          await runMigrations(otherPool);
        } finally {
          await otherPool.end();
        }

        const { rows: fixed } = await pool.query<{
          rolbypassrls: boolean;
          rolsuper: boolean;
        }>("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_user'");
        expect(fixed[0]).toEqual({ rolbypassrls: false, rolsuper: false });
      } finally {
        await pool.query('ALTER ROLE app_user NOSUPERUSER NOBYPASSRLS').catch(() => {});
        await pool.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
      }
    },
  );
});
