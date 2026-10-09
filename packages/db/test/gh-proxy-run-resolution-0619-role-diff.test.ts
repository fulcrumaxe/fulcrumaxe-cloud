import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

interface ColumnPrivilege {
  table_name: string;
  column_name: string;
  privilege_type: string;
}

const MIGRATION_0619_FILENAME = '0619_gh_proxy_run_resolution.sql';

/**
 * S3 (D#2 H13c fix round 1, security review): a real before/after diff,
 * not an assertion about the post-migration state alone. This actually
 * migrates a throwaway cluster to 0613, snapshots
 * `information_schema.column_privileges` for `app_user` and
 * `partner_user` on the two tables 0619 touches (`agent_runs`, `repos`),
 * applies 0619 on the SAME database, and snapshots again.
 *
 * `partner_user` really does come out byte-identical before and after --
 * it never had a grant on either table, and 0619 doesn't give it one.
 *
 * `app_user` does NOT come out byte-identical, and that is expected, not
 * a regression: `app_user` already has a TABLE-WIDE grant on `repos`
 * (0001_core.sql), and 0619 adds two new columns to `repos`
 * (`gh_owner`, `gh_name`). PostgreSQL extends an existing table-wide
 * grant to a newly added column automatically -- that is what
 * `information_schema.column_privileges` is reporting, not a new GRANT
 * statement. The first `it` below confirms the reason directly: 0619's
 * own SQL text contains no statement naming `app_user` at all. The
 * second confirms the shape of the difference is EXACTLY that automatic
 * extension -- every pre-existing column is untouched, and the two new
 * columns carry the exact same privilege-type set `app_user` already had
 * on every other `repos` column, no more and no less.
 *
 * This needs its OWN ephemeral cluster (packages/db/test/globalSetup.ts's
 * shared one already has every migration, including 0619, applied before
 * any test file runs -- there is no "before" state left to read there).
 * Same throwaway-cluster helper every other project's globalSetup used to
 * hand-roll (D#56) and test-neon-shape.sh's own bash equivalent.
 *
 * Both roles' before/after snapshots are captured once in `beforeAll` --
 * the `it` blocks below just assert on them, so a failure in one role's
 * diff can never be masked by the other `it` re-running (or skipping)
 * the migration step.
 */
describe('migration 0619: app_user and partner_user column privileges are unchanged (D#2 H13c fix round 1, S3)', () => {
  let pg: EphemeralPostgres;
  let pool: Pool;
  let guard: PoolTeardownGuard | undefined;
  let beforeMigrationsDir: string;
  let appUserBefore: ColumnPrivilege[];
  let appUserAfter: ColumnPrivilege[];
  let partnerUserBefore: ColumnPrivilege[];
  let partnerUserAfter: ColumnPrivilege[];

  async function columnPrivileges(grantee: string): Promise<ColumnPrivilege[]> {
    const { rows } = await pool.query<ColumnPrivilege>(
      `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee = $1 AND table_name IN ('agent_runs', 'repos')
        ORDER BY table_name, column_name, privilege_type`,
      [grantee],
    );
    return rows;
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_614_role_diff_test', tmpPrefix: 'fx-614-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'roleDiffPool');

    // Every migration file EXCEPT 0619 -- the "before" state -- and except the files that grant a column 0619 adds
    // (repos.gh_owner, repos.gh_name), which cannot apply without it. They apply right after 0619 in the second run below,
    // and give app_user and partner_user nothing on either table.
    const NEEDS_0619_COLUMNS = ['0765_runner_git_path_a.sql'];
    beforeMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-614-diff-migrations-'));
    const files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f !== '0619_gh_proxy_run_resolution.sql' && !NEEDS_0619_COLUMNS.includes(f));
    for (const f of files) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(beforeMigrationsDir, f));
    }

    await runMigrations(pool, beforeMigrationsDir);
    appUserBefore = await columnPrivileges('app_user');
    partnerUserBefore = await columnPrivileges('partner_user');

    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies 0619, then the files held back above -- everything else is already recorded.
    appUserAfter = await columnPrivileges('app_user');
    partnerUserAfter = await columnPrivileges('partner_user');
  }, 90_000);

  afterAll(async () => {
    // D#219 follow-up: pool.end() resolves before the sockets have closed, so
    // wait for them, and stop the cluster last whatever happened above.
    try {
      guard?.assertNoCheckedOutClients();
      await guard?.endAndWaitForSockets();
    } finally {
      pg?.cleanup();
      if (beforeMigrationsDir) rmSync(beforeMigrationsDir, { recursive: true, force: true });
    }
  });

  it('migration 0619 contains no GRANT/REVOKE statement naming app_user or partner_user', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION_0619_FILENAME), 'utf8');
    // Strip `--` line comments first -- this file's own prose mentions
    // `app_user` by name (explaining 0001_core.sql's pre-existing
    // `tenant_isolation` grant for context), which is not a statement
    // this migration executes.
    const withoutComments = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(withoutComments).not.toMatch(/\bapp_user\b/);
    expect(withoutComments).not.toMatch(/\bpartner_user\b/);
  });

  it('app_user: every pre-existing agent_runs/repos column privilege is unchanged; the two new repos columns (gh_owner, gh_name) get exactly the SAME privilege-type set app_user already had on every other repos column -- the automatic table-wide-grant extension, not a new grant', () => {
    expect(appUserBefore.length).toBeGreaterThan(0); // sanity: app_user's table-wide grants exist pre-0619.

    const newRepoColumns = new Set(['gh_owner', 'gh_name']);
    const appUserAfterExcludingNewColumns = appUserAfter.filter((r) => !(r.table_name === 'repos' && newRepoColumns.has(r.column_name)));
    expect(appUserAfterExcludingNewColumns).toEqual(appUserBefore);

    const otherRepoPrivilegeTypes = new Set(appUserBefore.filter((r) => r.table_name === 'repos').map((r) => r.privilege_type));
    const newColumnPrivileges = appUserAfter.filter((r) => r.table_name === 'repos' && newRepoColumns.has(r.column_name));
    expect(new Set(newColumnPrivileges.map((r) => r.privilege_type))).toEqual(otherRepoPrivilegeTypes);
    expect(newColumnPrivileges).toHaveLength(newRepoColumns.size * otherRepoPrivilegeTypes.size);
  });

  it('partner_user: column privileges on agent_runs/repos are identical before and after 0619', () => {
    // partner_user has no grant on either table before OR after -- 0619
    // never mentions it -- so this is also `[]` on both sides, but read
    // live off the same before/after migration run as app_user's, not
    // asserted as a hardcoded assumption.
    expect(partnerUserAfter).toEqual(partnerUserBefore);
  });
});
