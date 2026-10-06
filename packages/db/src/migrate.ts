import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** migrations/ lives one directory up from src/. */
export const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * D#8 R4 / D#9 item 2: the migration session's own guard timeouts, named
 * constants (not magic strings inline in the `SET` calls) so their values
 * are reviewable on their own.
 *
 * MIGRATION_LOCK_TIMEOUT -- R4 criterion 3's value. A DDL statement that
 * queues behind an already-open transaction puts every later reader behind
 * it in the ACCESS EXCLUSIVE wait queue -- the convoy is the outage, not
 * the DDL -- so this fails fast instead of waiting indefinitely.
 *
 * MIGRATION_STATEMENT_TIMEOUT -- the Team Lead's D#9-item-2 addition to R4:
 * belt-and-suspenders for a statement that hangs for a reason lock_timeout
 * doesn't cover (lock_timeout only bounds the wait to ACQUIRE a lock, not
 * total execution once it's held). Deliberately NOT applied to a
 * no-transaction file below -- see `NO_TRANSACTION_MARKER`'s own comment
 * for why a session-wide cap here would defeat that escape hatch's whole
 * purpose.
 */
export const MIGRATION_LOCK_TIMEOUT = '3s';
export const MIGRATION_STATEMENT_TIMEOUT = '5s';

/**
 * D#9 item 4 / R4 criterion 2: a migration file opts out of the transaction
 * wrapper by making this its exact first line -- nothing before it, not
 * even a blank line. `CREATE INDEX CONCURRENTLY` cannot run inside
 * `BEGIN … COMMIT` (Postgres rejects it outright), so a file that needs it
 * marks itself and runs as a bare statement instead.
 *
 * A no-transaction file is NOT atomic: a build that fails partway can leave
 * an `INVALID` index behind, so such a file must be written idempotently --
 * `DROP INDEX CONCURRENTLY IF EXISTS …` before `CREATE INDEX CONCURRENTLY
 * IF NOT EXISTS …` -- and the next run picks up from whatever state the
 * previous attempt left.
 *
 * `MIGRATION_STATEMENT_TIMEOUT` is relaxed for exactly the duration of a
 * no-transaction file's own statement: the whole reason this escape hatch
 * exists is to let a large-table concurrent index build run to completion
 * without holding up every other reader, and a session-wide statement cap
 * sized for ordinary DDL would just as cheerfully kill that build.
 * `lock_timeout` stays in effect throughout -- it only bounds the (fast)
 * initial lock request `CREATE INDEX CONCURRENTLY` still makes, never the
 * build's total duration.
 *
 * D#8 R4 fix round 1 (review MUST 1): that relaxation used to be to `0`
 * (unconditionally unlimited). While a no-transaction statement runs, it
 * holds the whole-run advisory lock, so a statement that is simply stuck --
 * not legitimately slow -- blocked every other migration runner against the
 * same database indefinitely, with no operator-visible circuit breaker. It
 * is now `MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS` below: a separate,
 * named, FINITE bound sized for a real large-index build, not unlimited.
 */
export const NO_TRANSACTION_MARKER = '-- migrate: no-transaction';

/**
 * D#8 R4 fix round 1 (review MUST 1): the finite bound a no-transaction
 * file's own statement runs under, replacing the previous unconditional
 * `statement_timeout = 0`. Thirty minutes comfortably covers a large
 * `CREATE INDEX CONCURRENTLY` build while still giving a genuinely stuck
 * statement a backstop. Overridable via the identically-named
 * `MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS` env var (milliseconds) --
 * see `resolveNoTransactionStatementTimeoutMs`, which validates it as a
 * positive integer and fails fast on anything else rather than silently
 * falling back to the default. Only an unset variable uses the default; an
 * empty or whitespace-only value is a misconfiguration and is rejected too.
 */
export const MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS = 30 * 60 * 1000;

function resolveNoTransactionStatementTimeoutMs(): number {
  const raw = process.env.MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS;
  if (raw === undefined) {
    return MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      'MIGRATION_NO_TRANSACTION_STATEMENT_TIMEOUT_MS must be a positive integer number of ' +
        `milliseconds; got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * D#9 item 1 / R4 criterion 4: fixed, reviewable key for the whole-run
 * advisory lock. Two concurrent runners against the same database must
 * serialize -- otherwise both read the same `alreadyApplied` set and both
 * try to apply the same file. Acquired with the BLOCKING form
 * (`pg_advisory_lock`, not `pg_try_advisory_lock`) so the second runner
 * waits and then finds everything already done, rather than failing.
 *
 * Acquired BEFORE `lock_timeout` is set below -- deliberately. If
 * `lock_timeout` were already active, the second runner's own wait for
 * this lock would itself be bounded by it and could error out instead of
 * waiting for the first runner to finish, which is exactly the failure
 * criterion 4 rules out ("the second waits and then no-ops, and neither
 * errors").
 */
const ADVISORY_LOCK_KEY = 958_311_002;

export interface MigrateResult {
  /** Filenames applied by THIS call, in order. Empty on a no-op re-run. */
  applied: string[];
}

function isNoTransaction(sql: string): boolean {
  return sql.split('\n', 1)[0]?.trim() === NO_TRANSACTION_MARKER;
}

/**
 * Applies every `*.sql` file under `migrationsDir` that isn't already
 * recorded in `schema_migrations`, in filename order, each inside its own
 * transaction unless it opts out (see `NO_TRANSACTION_MARKER`). Re-running
 * against a database that has already applied everything is a no-op
 * (`applied: []`) -- test/migrate.test.ts asserts this by running it twice.
 *
 * D#8 R4 / D#9 hardens this against a live, populated database: a
 * whole-run advisory lock serializes concurrent callers, `lock_timeout`
 * and `statement_timeout` bound how long a blocked or hung statement can
 * hold things up, and every already-applied file's checksum is re-checked
 * on each run so an edit made after the fact is a hard failure naming the
 * file rather than a silent, permanent divergence.
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrateResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
      await client.query(`SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename    text PRIMARY KEY,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      // R4 criterion 1 / D#9 item 4: added after the fact. An existing
      // (already-applied) row has no prior checksum to compare against --
      // nullable, and backfilled the first time this runner sees it below,
      // rather than treated as a mismatch.
      await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
      await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS applied_by text');

      const { rows: appliedRows } = await client.query<{ filename: string; checksum: string | null }>(
        'SELECT filename, checksum FROM schema_migrations',
      );
      const alreadyApplied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

      const { rows: userRows } = await client.query<{ role: string }>('SELECT current_user AS role');
      const appliedBy = userRows[0]!.role;

      const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      const applied: string[] = [];
      for (const filename of files) {
        const sql = readFileSync(path.join(migrationsDir, filename), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');

        if (alreadyApplied.has(filename)) {
          const recorded = alreadyApplied.get(filename)!;
          if (recorded === null) {
            // D#8 R4 fix round 1 (review MUST 2): a NULL checksum (the shape
            // every pre-existing row has on an upgrade) is trust-on-first-use
            // -- there is no prior value to compare the file on disk against.
            // That decision must be visible in deploy output, not silent.
            console.log(`migrate: backfilling NULL checksum for ${filename} -> ${checksum}`);
            await client.query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [
              checksum,
              filename,
            ]);
          } else if (recorded !== checksum) {
            throw new Error(
              `migration ${filename} has changed since it was applied (checksum mismatch) -- ` +
                'an applied migration file must never be edited; add a new file instead',
            );
          }
          continue;
        }

        if (isNoTransaction(sql)) {
          const noTransactionTimeoutMs = resolveNoTransactionStatementTimeoutMs();
          await client.query(`SET statement_timeout = ${noTransactionTimeoutMs}`);
          try {
            await client.query(sql);
          } finally {
            await client.query(`SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`).catch(() => {});
          }
          await client.query('INSERT INTO schema_migrations (filename, checksum, applied_by) VALUES ($1, $2, $3)', [
            filename,
            checksum,
            appliedBy,
          ]);
        } else {
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query(
              'INSERT INTO schema_migrations (filename, checksum, applied_by) VALUES ($1, $2, $3)',
              [filename, checksum, appliedBy],
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          }
        }
        applied.push(filename);
      }

      return { applied };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    // D#8 R4 fix round 1 (review SHOULD 3): `lock_timeout` and
    // `statement_timeout` above are set with plain `SET`, which is
    // session-scoped, not `SET LOCAL` (transaction-scoped) -- so they
    // outlive every transaction this call opened. Nothing in this
    // function's contract stops a future caller from handing in a
    // long-lived app pool rather than a dedicated per-invocation one (the
    // only production caller today, `neon-shape-migrate.ts`, does the
    // latter and exits), so reset before the connection goes back to the
    // pool rather than relying on every future caller happening to do the
    // right thing. Runs on every exit path, including an error thrown
    // before either SET ever ran -- RESET ALL on a session with nothing to
    // reset is a no-op.
    //
    // D#8 C3 (a): if RESET ALL itself fails, the session may still carry the
    // migration's timeouts (or be broken outright), so hand the caught error
    // to release() -- the pool then destroys the connection instead of
    // recycling it.
    let resetError: Error | undefined;
    await client.query('RESET ALL').catch((err: unknown) => {
      resetError = err instanceof Error ? err : new Error(String(err));
    });
    client.release(resetError);
  }
}
