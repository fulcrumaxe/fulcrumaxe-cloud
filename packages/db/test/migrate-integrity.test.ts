import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolConfig } from 'pg';
import { Client } from 'pg';
import { createPool } from '../src/pool.js';
import { runMigrations } from '../src/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE_SRC_PATH = path.join(__dirname, '..', 'src', 'migrate.ts');

/**
 * D#8 R4 / D#9: `packages/db/src/migrate.ts` correctness against an empty
 * database is already covered by test/migrate.test.ts. This file proves
 * the four load-bearing changes that make it safe against a LIVE,
 * populated one -- each against a real, throwaway Postgres cluster
 * (globalSetup's own), never a mock.
 *
 * Every scenario below gets its own fresh database (via `adminPool`,
 * mirroring migrate-0005-upgrade.test.ts's own pattern) so tests can't
 * interfere with each other or with the shared database every other file
 * in this package uses.
 */
describe('migrate: safety against a live database (D#8 R4 / D#9)', () => {
  let adminPool: Pool;
  const dbNames: string[] = [];
  let tmpDirs: string[] = [];

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  afterAll(async () => {
    for (const dbName of dbNames) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    }
    await adminPool.end();
    // Fix round 1 added 4 more freshDb() cases (13 databases total, up from
    // 9), so this loop's total teardown time grew past the config's default
    // 20s hookTimeout when running alongside the rest of the package's
    // suite. Overridden here (not in vitest.config.ts, out of this PR's
    // scope) via the hook's own optional timeout argument.
  }, 60_000);

  function tmpMigrationsDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'fx-db-migrate-integrity-'));
    tmpDirs.push(dir);
    return dir;
  }

  async function freshDb(prefix: string, poolOverrides: PoolConfig = {}): Promise<{ dbName: string; pool: Pool }> {
    const dbName = `fx_migrate_integrity_${prefix}_${randomUUID().replace(/-/g, '')}`;
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    dbNames.push(dbName);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${dbName}`;
    return { dbName, pool: createPool(url.toString(), poolOverrides) };
  }

  /** Fix round 1 (review MUST 1): temporarily override the no-transaction
   * statement_timeout env var for one test, restoring whatever was there
   * before (usually nothing) afterward -- never a bare delete, in case a
   * concurrent env already had a legitimate value. */
  async function withNoTransactionTimeoutMsOverride<T>(value: string, fn: () => Promise<T>): Promise<T> {
    const envKey = 'MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS';
    const prev = process.env[envKey];
    process.env[envKey] = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = prev;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Criterion 1: schema_migrations.checksum -- an edited, already-applied
  // file fails the run and names itself.
  // ---------------------------------------------------------------------
  describe('criterion 1: checksum detects a tampered, already-applied file', () => {
    it('re-running after the file is edited fails, naming the file', async () => {
      const { pool } = await freshDb('tamper');
      const dir = tmpMigrationsDir();
      const file = path.join(dir, '0001_fixture.sql');
      writeFileSync(file, 'CREATE TABLE fixture_b (id int);\n');

      try {
        const first = await runMigrations(pool, dir);
        expect(first.applied).toEqual(['0001_fixture.sql']);

        writeFileSync(file, 'CREATE TABLE fixture_b (id int);\n-- edited after being applied\n');

        await expect(runMigrations(pool, dir)).rejects.toThrow(/0001_fixture\.sql/);
      } finally {
        await pool.end();
      }
    });

    it('an unmodified re-run stays a clean no-op even once checksums are tracked', async () => {
      const { pool } = await freshDb('clean');
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_fixture.sql'), 'CREATE TABLE fixture_c (id int);\n');

      try {
        const first = await runMigrations(pool, dir);
        expect(first.applied).toEqual(['0001_fixture.sql']);

        const second = await runMigrations(pool, dir);
        expect(second.applied).toEqual([]);

        const { rows } = await pool.query<{ checksum: string; applied_by: string }>(
          'SELECT checksum, applied_by FROM schema_migrations WHERE filename = $1',
          ['0001_fixture.sql'],
        );
        expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0]?.applied_by).toBe('postgres');
      } finally {
        await pool.end();
      }
    });

    it('a pre-existing row with no recorded checksum (an upgrade) is backfilled, not treated as a mismatch', async () => {
      const { pool } = await freshDb('backfill');
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_fixture.sql'), 'CREATE TABLE fixture_d (id int);\n');

      try {
        await runMigrations(pool, dir);

        // Simulate the moment this PR ships against an already-migrated
        // database: NULL out the checksum column the way an older
        // schema_migrations row (recorded before this PR existed) would
        // actually look.
        await pool.query('UPDATE schema_migrations SET checksum = NULL WHERE filename = $1', ['0001_fixture.sql']);

        const result = await runMigrations(pool, dir);
        expect(result.applied).toEqual([]);

        const { rows } = await pool.query<{ checksum: string | null }>(
          'SELECT checksum FROM schema_migrations WHERE filename = $1',
          ['0001_fixture.sql'],
        );
        expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Criterion 2: a migration file may opt out of the transaction wrapper,
  // which is what makes CREATE INDEX CONCURRENTLY usable at all.
  // ---------------------------------------------------------------------
  describe('criterion 2: the no-transaction opt-out', () => {
    it('fails on today\'s main / without the marker: CREATE INDEX CONCURRENTLY cannot run inside a transaction', async () => {
      const { pool } = await freshDb('concurrently_txn');
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_setup.sql'), 'CREATE TABLE fixture_e (col int);\n');
      writeFileSync(
        path.join(dir, '0002_bad_concurrent.sql'),
        'CREATE INDEX CONCURRENTLY idx_fixture_e_col ON fixture_e (col);\n',
      );

      try {
        // Both files are unapplied on this first call -- 0001 (plain
        // CREATE TABLE) and 0002 (CREATE INDEX CONCURRENTLY, no marker)
        // apply in the same run, so the failure surfaces here directly.
        await expect(runMigrations(pool, dir)).rejects.toThrow(/CONCURRENTLY.*transaction|transaction.*CONCURRENTLY/is);
      } finally {
        await pool.end();
      }
    });

    it('with the marker, CREATE INDEX CONCURRENTLY runs outside the transaction and succeeds', async () => {
      const { pool } = await freshDb('concurrently_ok');
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_setup.sql'), 'CREATE TABLE fixture_f (col int);\n');
      writeFileSync(
        path.join(dir, '0002_good_concurrent.sql'),
        '-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY idx_fixture_f_col ON fixture_f (col);\n',
      );

      try {
        const result = await runMigrations(pool, dir);
        expect(result.applied).toEqual(['0001_setup.sql', '0002_good_concurrent.sql']);

        const { rows } = await pool.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_fixture_f_col'",
        );
        expect(rows).toHaveLength(1);
      } finally {
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Criterion 3: lock_timeout -- a DDL statement queued behind an open,
  // conflicting lock fails fast instead of hanging.
  // ---------------------------------------------------------------------
  describe('criterion 3: lock_timeout', () => {
    it('a migration blocked by a conflicting lock from another session fails within the configured timeout, not indefinitely', async () => {
      const { dbName, pool } = await freshDb('lock_timeout');
      const setupDir = tmpMigrationsDir();
      writeFileSync(path.join(setupDir, '0001_setup.sql'), 'CREATE TABLE lock_target (id int);\n');

      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_setup.sql'), 'CREATE TABLE lock_target (id int);\n');
      writeFileSync(path.join(dir, '0002_ddl.sql'), 'ALTER TABLE lock_target ADD COLUMN val int;\n');

      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${dbName}`;
      const holder = new Client({ connectionString: url.toString() });

      try {
        // Apply the setup file alone first, so the lock below is already
        // held by the time 0002 (the file under test) is attempted.
        await runMigrations(pool, setupDir);

        await holder.connect();
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE lock_target IN ACCESS EXCLUSIVE MODE');

        const start = Date.now();
        await expect(runMigrations(pool, dir)).rejects.toMatchObject({ code: '55P03' });
        const elapsedMs = Date.now() - start;

        // The runner's own lock_timeout is 3s -- this must fail fast, not
        // hang until the test's own timeout kills it.
        expect(elapsedMs).toBeLessThan(10_000);
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end().catch(() => {});
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Criterion (D#9 item 2 / Team Lead note on D#8): statement_timeout --
  // a statement that hangs for a reason lock_timeout does not cover (it is
  // not waiting to ACQUIRE a lock, it is just slow) still fails within the
  // configured timeout.
  // ---------------------------------------------------------------------
  describe('D#9 item 2: statement_timeout', () => {
    it(
      'a deliberately blocking (long-running, non-lock-waiting) statement fails within the configured timeout rather than hanging',
      async () => {
        const { pool } = await freshDb('statement_timeout');
        const dir = tmpMigrationsDir();
        // pg_sleep is not blocked on any lock -- statement_timeout is the
        // ONLY guard that can end this one. Sleeps far longer than the
        // runner's own timeout so a false pass (finishing on its own) is
        // not possible.
        writeFileSync(path.join(dir, '0001_slow.sql'), 'SELECT pg_sleep(30);\n');

        try {
          const start = Date.now();
          await expect(runMigrations(pool, dir)).rejects.toMatchObject({ code: '57014' });
          const elapsedMs = Date.now() - start;

          expect(elapsedMs).toBeLessThan(15_000);
        } finally {
          await pool.end();
        }
      },
      20_000,
    );

    it('the escape hatch is exempt from statement_timeout: a slow no-transaction statement still completes', async () => {
      const { pool } = await freshDb('statement_timeout_exempt');
      const dir = tmpMigrationsDir();
      // Longer than MIGRATION_STATEMENT_TIMEOUT (5s) -- proves the
      // no-transaction path is not subject to the same cap that criterion
      // above proves fires for an ordinary (transactional) statement.
      writeFileSync(path.join(dir, '0001_slow_no_txn.sql'), '-- migrate: no-transaction\nSELECT pg_sleep(6);\n');

      try {
        const result = await runMigrations(pool, dir);
        expect(result.applied).toEqual(['0001_slow_no_txn.sql']);
      } finally {
        await pool.end();
      }
    }, 20_000);
  });

  // ---------------------------------------------------------------------
  // Criterion 4: a whole-run advisory lock serializes two concurrent
  // runners against the same database.
  // ---------------------------------------------------------------------
  describe('criterion 4: advisory lock serializes concurrent runners', () => {
    it('two concurrent runners against one database: the second waits, then no-ops, and neither errors', async () => {
      const { pool } = await freshDb('concurrent');
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE fixture_g (id int);\n');
      writeFileSync(path.join(dir, '0002_b.sql'), 'CREATE TABLE fixture_h (id int);\n');

      try {
        const [r1, r2] = await Promise.all([runMigrations(pool, dir), runMigrations(pool, dir)]);

        const results = [r1.applied, r2.applied].sort((a, b) => b.length - a.length);
        expect(results[0]).toEqual(['0001_a.sql', '0002_b.sql']);
        expect(results[1]).toEqual([]);

        const { rows } = await pool.query<{ filename: string }>(
          'SELECT filename FROM schema_migrations ORDER BY filename',
        );
        expect(rows.map((r) => r.filename)).toEqual(['0001_a.sql', '0002_b.sql']);
      } finally {
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Criterion 5: roll-forward only -- no down/revert/rollback migration
  // entry point exists.
  // ---------------------------------------------------------------------
  describe('criterion 5: no down-migration entry point', () => {
    it('migrate.ts has no down/revert/rollback migration entry point', () => {
      const src = readFileSync(MIGRATE_SRC_PATH, 'utf8');
      // The one legitimate use of the word "ROLLBACK" is the per-file
      // transaction abort on a failed apply -- SQL transaction control,
      // not a down-migration feature. Strip that literal before scanning.
      const stripped = src.replace(/client\.query\('ROLLBACK'\)/g, '');

      expect(stripped).not.toMatch(/\b(down|revert|rollback)[A-Za-z]*\s*\(/i);
      expect(stripped).not.toMatch(/export\s+(async\s+)?function\s+\w*(down|revert|rollback)\w*/i);
      expect(stripped.toLowerCase()).not.toContain('downmigration');
      expect(stripped.toLowerCase()).not.toContain('revertmigration');
    });

    it('non-vacuity: the grep above would actually catch a down-migration entry point', () => {
      const fixture = `export async function downMigrations() { /* not real */ }`;
      const stripped = fixture.replace(/client\.query\('ROLLBACK'\)/g, '');
      expect(stripped).toMatch(/\b(down|revert|rollback)[A-Za-z]*\s*\(/i);
    });
  });

  // ---------------------------------------------------------------------
  // Fix round 1 -- review MUST 1: the no-transaction escape hatch's
  // statement_timeout exemption is a separate, FINITE, named bound, not
  // unconditionally unlimited.
  // ---------------------------------------------------------------------
  describe('fix round 1, MUST 1: no-transaction statement_timeout is a finite bound', () => {
    it('a no-transaction statement slower than the normal 5s cap but inside the bound still succeeds', async () => {
      const { pool } = await freshDb('no_txn_bound_ok');
      const dir = tmpMigrationsDir();
      // Longer than MIGRATION_STATEMENT_TIMEOUT (5s), inside a bound
      // lowered to 10s for this test via the override env var.
      writeFileSync(path.join(dir, '0001_slow_no_txn.sql'), '-- migrate: no-transaction\nSELECT pg_sleep(6);\n');

      try {
        const result = await withNoTransactionTimeoutMsOverride('10000', () => runMigrations(pool, dir));
        expect(result.applied).toEqual(['0001_slow_no_txn.sql']);
      } finally {
        await pool.end();
      }
    }, 20_000);

    it('with the bound lowered below the statement duration, the statement is killed with 57014', async () => {
      const { pool } = await freshDb('no_txn_bound_kill');
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_slow_no_txn.sql'), '-- migrate: no-transaction\nSELECT pg_sleep(6);\n');

      try {
        const start = Date.now();
        // 2s bound, well under the 6s sleep -- on the old, unconditional
        // `statement_timeout = 0` behavior nothing would ever kill this.
        await expect(
          withNoTransactionTimeoutMsOverride('2000', () => runMigrations(pool, dir)),
        ).rejects.toMatchObject({ code: '57014' });
        const elapsedMs = Date.now() - start;
        expect(elapsedMs).toBeLessThan(15_000);
      } finally {
        await pool.end();
      }
    }, 20_000);
  });

  // ---------------------------------------------------------------------
  // Fix round 1 -- review MUST 2: backfilling a NULL checksum on upgrade is
  // logged (filename + adopted checksum), not silent.
  // ---------------------------------------------------------------------
  describe('fix round 1, MUST 2: NULL-checksum backfill is logged', () => {
    it('logs a line naming the file and the adopted checksum when backfilling a NULL checksum', async () => {
      const { pool } = await freshDb('backfill_log');
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_fixture.sql'), 'CREATE TABLE fixture_backfill_log (id int);\n');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runMigrations(pool, dir);
        await pool.query('UPDATE schema_migrations SET checksum = NULL WHERE filename = $1', ['0001_fixture.sql']);

        logSpy.mockClear();
        const result = await runMigrations(pool, dir);
        expect(result.applied).toEqual([]);

        const { rows } = await pool.query<{ checksum: string }>(
          'SELECT checksum FROM schema_migrations WHERE filename = $1',
          ['0001_fixture.sql'],
        );
        const adoptedChecksum = rows[0]?.checksum;
        expect(adoptedChecksum).toMatch(/^[0-9a-f]{64}$/);

        const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(logged).toContain('0001_fixture.sql');
        expect(logged).toContain(adoptedChecksum!);
      } finally {
        logSpy.mockRestore();
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Fix round 1 -- review SHOULD 3: session-level lock_timeout /
  // statement_timeout are reset before the connection returns to the pool.
  // ---------------------------------------------------------------------
  describe('fix round 1, SHOULD 3: session settings reset before the connection returns to the pool', () => {
    it('a pooled connection handed back after runMigrations has default lock_timeout and statement_timeout', async () => {
      // max: 1 pins every acquisition on this pool -- runMigrations' own
      // connect() and the query below -- to the exact same physical
      // connection, so this proves runMigrations itself reset the session
      // rather than a fresh connection simply never having seen the SETs.
      const { pool } = await freshDb('reset_session', { max: 1 });
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_fixture.sql'), 'CREATE TABLE fixture_reset (id int);\n');

      try {
        await runMigrations(pool, dir);

        const { rows } = await pool.query<{ lock_timeout: string; statement_timeout: string }>(
          "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
        );
        expect(rows[0]?.lock_timeout).toBe('0');
        expect(rows[0]?.statement_timeout).toBe('0');
      } finally {
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------
  // D#8 correction C3 (a)+(b), from the #166 recheck. Stubbed pool/client:
  // both behaviours are about what runMigrations does with the client, not
  // about server behaviour.
  // ---------------------------------------------------------------------
  describe('D#8 C3 (a): a failed RESET ALL destroys the connection instead of recycling it', () => {
    function stubPool(failResetAll: boolean) {
      const release = vi.fn();
      const resetError = new Error('RESET ALL failed: connection broken');
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'RESET ALL' && failResetAll) throw resetError;
          return { rows: [{ role: 'stub_user' }] };
        }),
        release,
      };
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      return { pool, release, resetError };
    }

    it('releases with the caught error when RESET ALL fails', async () => {
      const { pool, release, resetError } = stubPool(true);
      const result = await runMigrations(pool, tmpMigrationsDir());
      expect(result.applied).toEqual([]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(resetError);
    });

    it('releases without an error when RESET ALL succeeds', async () => {
      const { pool, release } = stubPool(false);
      await runMigrations(pool, tmpMigrationsDir());
      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0]?.[0]).toBeUndefined();
    });
  });

  describe('D#8 C3 (b): MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS rejects empty and whitespace-only values', () => {
    async function runWithNoTxnFile(value: string) {
      const client = {
        query: vi.fn(async () => ({ rows: [{ role: 'stub_user' }] })),
        release: vi.fn(),
      };
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      const dir = tmpMigrationsDir();
      writeFileSync(path.join(dir, '0001_no_txn.sql'), '-- migrate: no-transaction\nSELECT 1;\n');
      return withNoTransactionTimeoutMsOverride(value, () => runMigrations(pool, dir));
    }

    it.each(['', '   ', '\t\n', '0', '-5000', 'abc'])('rejects %j', async (value) => {
      await expect(runWithNoTxnFile(value)).rejects.toThrow(
        /MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS must be a positive integer/,
      );
    });

    it('still accepts a positive integer', async () => {
      await expect(runWithNoTxnFile('10000')).resolves.toMatchObject({ applied: ['0001_no_txn.sql'] });
    });
  });
});
