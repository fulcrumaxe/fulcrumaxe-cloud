import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writePlatformAudit, listPlatformAudit } from '../src/platformAudit.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { PLATFORM_WIDE_TABLES } from '../src/platformWideTables.js';
import { EVIDENCE_TABLES } from './support/evidenceTables.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_FILE = '0611_exposure_audit.sql';

describe('platform_audit (D#8 R1 criteria 5-6), agent_runs frozen columns (criterion 7), migration hygiene (criteria 8-9)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refsA = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  describe('criterion 5: shape and the exact grant matrix', () => {
    it('has exactly the column shape from criterion 5, account_id nullable', async () => {
      const { rows } = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
      }>(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'platform_audit'
         ORDER BY column_name`,
      );
      const byName = new Map(rows.map((r) => [r.column_name, r]));
      expect(byName.get('id')?.data_type).toBe('uuid');
      expect(byName.get('account_id')?.data_type).toBe('uuid');
      expect(byName.get('account_id')?.is_nullable).toBe('YES');
      expect(byName.get('actor_user_id')?.data_type).toBe('uuid');
      expect(byName.get('actor_user_id')?.is_nullable).toBe('NO');
      expect(byName.get('action')?.data_type).toBe('text');
      expect(byName.get('advisory_ref')?.data_type).toBe('text');
      expect(byName.get('previous_value')?.data_type).toBe('jsonb');
      expect(byName.get('new_value')?.data_type).toBe('jsonb');
      expect(byName.get('authorised_by')?.data_type).toBe('jsonb');
      expect(byName.get('created_at')?.data_type).toBe('timestamp with time zone');
      expect(rows.map((r) => r.column_name).sort()).toEqual(
        [
          'account_id',
          'action',
          'actor_user_id',
          'advisory_ref',
          'authorised_by',
          'created_at',
          'id',
          'new_value',
          'previous_value',
        ].sort(),
      );
    });

    it('the exact matrix: app_user nothing, platform_ops SELECT-only, exposure_writer INSERT-only, nobody UPDATE/DELETE', async () => {
      // Scoped to the known application roles -- see exposure.test.ts's
      // own comment on the identical pattern: the table owner (`postgres`
      // in this ephemeral cluster) implicitly holds every privilege and
      // is correctly excluded, not part of what R1 criterion 5 asks about.
      const { rows } = await admin.query<{ grantee: string; privilege_type: string }>(
        `SELECT grantee, privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'platform_audit'
           AND grantee IN ('app_user', 'platform_ops', 'partner_user', 'exposure_writer')
         ORDER BY grantee, privilege_type`,
      );
      const byGrantee = new Map<string, string[]>();
      for (const r of rows) {
        byGrantee.set(r.grantee, [...(byGrantee.get(r.grantee) ?? []), r.privilege_type]);
      }
      expect(byGrantee.get('app_user')).toBeUndefined();
      expect(byGrantee.get('platform_ops')).toEqual(['SELECT']);
      expect(byGrantee.get('exposure_writer')).toEqual(['INSERT']);
      expect(rows.some((r) => r.privilege_type === 'UPDATE')).toBe(false);
      expect(rows.some((r) => r.privilege_type === 'DELETE')).toBe(false);
    });

    it('app_user cannot SELECT from platform_audit at all (fails on privileges)', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query('SELECT 1 FROM platform_audit LIMIT 1');
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot INSERT into platform_audit (fails on privileges)', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `INSERT INTO platform_audit (actor_user_id, action) VALUES ($1, 'app-user-attempt')`,
            [refsA.userId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('platform_ops cannot INSERT into platform_audit either (SELECT-only, fails on privileges)', async () => {
      await expect(
        platformOpsPool.query(
          `INSERT INTO platform_audit (actor_user_id, action) VALUES ($1, 'platform-ops-attempt')`,
          [refsA.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('non-vacuity: writePlatformAudit() succeeds AS exposure_writer where app_user and platform_ops were refused, and platform_ops can then read it back', async () => {
      // `admin` is the ephemeral cluster's postgres superuser (see the
      // file header on exposure.test.ts for why SET ROLE, not a
      // dedicated exposure_writer connection string). SET ROLE first is
      // what makes this a real proof of exposure_writer's own grant,
      // not just "a superuser can always write".
      await admin.query('SET ROLE exposure_writer');
      let entry;
      try {
        entry = await writePlatformAudit(
          { pool: admin, principal: refsA.userId },
          { accountId: refsA.accountId, action: 'non-vacuity-check', newValue: { on: true } },
        );
      } finally {
        await admin.query('RESET ROLE');
      }
      expect(entry.action).toBe('non-vacuity-check');
      expect(entry.actorUserId).toBe(refsA.userId);
      expect(entry.accountId).toBe(refsA.accountId);

      const rows = await listPlatformAudit(platformOpsPool, 10);
      expect(rows.some((r) => r.id === entry.id && r.action === 'non-vacuity-check')).toBe(true);
    });

    it('a platform-wide entry (no accountId) is representable -- the whole point of the nullable column', async () => {
      await admin.query('SET ROLE exposure_writer');
      let entry;
      try {
        entry = await writePlatformAudit(
          { pool: admin, principal: refsA.userId },
          { action: 'platform-wide-check' },
        );
      } finally {
        await admin.query('RESET ROLE');
      }
      const { rows } = await admin.query<{ action: string; account_id: string | null }>(
        `SELECT action, account_id FROM platform_audit WHERE id = $1`,
        [entry.id],
      );
      expect(rows).toEqual([{ action: 'platform-wide-check', account_id: null }]);
    });
  });

  describe('criterion 6: PLATFORM_WIDE_TABLES registration and findRlsViolations() exemption', () => {
    it('platform_audit is registered', () => {
      expect(PLATFORM_WIDE_TABLES).toContain('platform_audit');
    });

    it('findRlsViolations() returns [] against the real schema with platform_audit present', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
    });

    it('non-vacuity: removing platform_audit from the exemption list makes the check report it', async () => {
      const withoutPlatformAudit = PLATFORM_WIDE_TABLES.filter((t) => t !== 'platform_audit');
      const violations = await findRlsViolations(admin, withoutPlatformAudit);
      expect(violations).toContain('platform_audit');
    });

    it('platform_audit itself carries no RLS at all (exempt, same shape as routing_tables/routing_rows)', async () => {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'platform_audit'`,
      );
      expect(rows).toEqual([{ relrowsecurity: false, relforcerowsecurity: false }]);
    });
  });

  describe('criterion 7: agent_runs gains resolved_exposure/exposure_digest, additive only', () => {
    it('both columns exist, nullable, correct types', async () => {
      const { rows } = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'agent_runs'
           AND column_name IN ('resolved_exposure', 'exposure_digest')
         ORDER BY column_name`,
      );
      const byName = new Map(rows.map((r) => [r.column_name, r]));
      expect(byName.get('resolved_exposure')?.data_type).toBe('jsonb');
      expect(byName.get('resolved_exposure')?.is_nullable).toBe('YES');
      expect(byName.get('exposure_digest')?.data_type).toBe('text');
      expect(byName.get('exposure_digest')?.is_nullable).toBe('YES');
    });

    it(
      "an ordinary agent_runs INSERT that doesn't mention the new columns still works, and they default to null " +
        '(the additive proof achievable at this layer: globalSetup migrates the full chain before any row exists in ' +
        'this suite, so there is no literal pre-migration row to snapshot here -- the SQL-level fresh-vs-upgrade ' +
        'parity proof is test-neon-shape.sh\'s D#94 check, run separately by scripts/check.sh)',
      async () => {
        // Exactly the shape test/helpers/seed.ts's own agent_runs
        // INSERT uses -- unaware of resolved_exposure/exposure_digest.
        const runId = randomUUID();
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
           VALUES ($1, $2, $3, 'executor', 'local', 'running')`,
          [runId, refsA.accountId, refsA.workItemId],
        );
        const { rows } = await admin.query<{
          id: string;
          role: string;
          runtime: string;
          status: string;
          resolved_exposure: unknown;
          exposure_digest: string | null;
        }>(
          `SELECT id, role, runtime, status, resolved_exposure, exposure_digest FROM agent_runs WHERE id = $1`,
          [runId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].role).toBe('executor');
        expect(rows[0].runtime).toBe('local');
        expect(rows[0].status).toBe('running');
        expect(rows[0].resolved_exposure).toBeNull();
        expect(rows[0].exposure_digest).toBeNull();
      },
    );

    it('row count is otherwise unaffected: the seeded agent_runs row from beforeAll is intact with the new columns null', async () => {
      const { rows } = await admin.query<{
        role: string;
        status: string;
        resolved_exposure: unknown;
        exposure_digest: string | null;
      }>(
        `SELECT role, status, resolved_exposure, exposure_digest FROM agent_runs WHERE id = $1`,
        [refsA.runId],
      );
      expect(rows).toEqual([{ role: 'executor', status: 'running', resolved_exposure: null, exposure_digest: null }]);
    });

    it(
      'Spec Failure condition ("Any pin, entitlement or exposure state reachable by an app_user UPDATE"): ' +
        'app_user cannot UPDATE resolved_exposure or exposure_digest on its own agent_runs row',
      async () => {
        await expect(
          withTenant(appUserPool, refsA.accountId, async (client) => {
            await client.query(`UPDATE agent_runs SET resolved_exposure = '{}'::jsonb WHERE id = $1`, [
              refsA.runId,
            ]);
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

        await expect(
          withTenant(appUserPool, refsA.accountId, async (client) => {
            await client.query(`UPDATE agent_runs SET exposure_digest = 'forged' WHERE id = $1`, [refsA.runId]);
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      },
    );

    it('app_user retains UPDATE on pre-existing agent_runs columns (the narrowing did not become a blanket revoke)', async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        await expect(
          client.query(`UPDATE agent_runs SET tokens_in = 100, tokens_out = 50 WHERE id = $1`, [refsA.runId]),
        ).resolves.toBeDefined();
      });
      const { rows } = await admin.query<{ tokens_in: string; tokens_out: string }>(
        `SELECT tokens_in, tokens_out FROM agent_runs WHERE id = $1`,
        [refsA.runId],
      );
      // bigint columns: node-postgres returns these as strings by
      // default to avoid precision loss outside JS's safe integer range.
      expect(rows).toEqual([{ tokens_in: '100', tokens_out: '50' }]);
    });
  });

  describe('criterion 8: no destructive DML against an existing table, additive-only', () => {
    const migrationText = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
    const EXISTING_TABLES = EVIDENCE_TABLES;

    it.each(EXISTING_TABLES)('never issues a DML UPDATE/DELETE/INSERT...SELECT against %s', (table) => {
      // Deliberately narrow patterns: a real DML statement has the verb
      // directly adjacent to the table name, whereas this migration's own
      // GRANT/REVOKE statements on agent_runs (see the file header) always
      // have "ON" or "(...)" in between -- e.g. "REVOKE UPDATE ON
      // agent_runs" and "GRANT UPDATE (...) ON agent_runs" both correctly
      // do NOT match `UPDATE\s+agent_runs`.
      const updateRe = new RegExp(`\\bUPDATE\\s+${table}\\b`, 'i');
      const deleteRe = new RegExp(`\\bDELETE\\s+FROM\\s+${table}\\b`, 'i');
      expect(migrationText).not.toMatch(updateRe);
      expect(migrationText).not.toMatch(deleteRe);

      // INSERT INTO <table> ... SELECT, checked per-statement (split on
      // ';') so an unrelated later SELECT elsewhere in the file can never
      // false-positive against an earlier, unrelated INSERT.
      const insertIntoRe = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i');
      for (const statement of migrationText.split(';')) {
        if (insertIntoRe.test(statement)) {
          expect(statement).not.toMatch(/\bSELECT\b/i);
        }
      }
    });

    it('this migration only ADDs a column to agent_runs (ALTER TABLE ... ADD COLUMN), never DROP/ALTER an existing one', () => {
      const alterStatements = migrationText
        .split(';')
        .filter((s) => /ALTER\s+TABLE\s+agent_runs/i.test(s));
      expect(alterStatements.length).toBeGreaterThan(0);
      for (const statement of alterStatements) {
        expect(statement).not.toMatch(/DROP\s+COLUMN/i);
        expect(statement).not.toMatch(/ALTER\s+COLUMN/i);
      }
    });

    it('applies to an empty database and re-runs as a no-op (proven generically by test/migrate.test.ts, which iterates every file in migrations/ -- this migration is included by construction since it is in that directory)', () => {
      expect(existsSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE))).toBe(true);
    });
  });

  describe('criterion 9 (adapted for D#94 R1 -- see the migration file header): unmodified 0001, correct number, no stale 0501', () => {
    it('0001_core.sql is byte-for-byte unmodified', () => {
      const bytes = readFileSync(path.join(MIGRATIONS_DIR, '0001_core.sql'));
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      expect(actualHash).toBe('adce1250d847b82e9b21114444426568eb8c05fa6791f16c6484af1acc182384');
    });

    it('the migration lands as 0611_exposure_audit.sql, and no 0501-prefixed file was created', () => {
      const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
      expect(sqlFiles).toContain(MIGRATION_FILE);
      expect(sqlFiles.some((f) => /^0501_/.test(f))).toBe(false);
    });
  });
});
