import { createPool } from '../../src/pool.js';

/**
 * D#2 H09c (correction C37): every `agent_runs` write goes through the
 * `agent_run_writer`-only SECURITY DEFINER functions (0642), and
 * `app_user` is deliberately NOT a member of that role. The runner
 * therefore needs a connection that is a member of BOTH `app_user` (its
 * own reads, `run_events`, `domain_events`) and `agent_run_writer` (the
 * EXECUTE on the two functions). Production creates that LOGIN as an ops
 * step; the [pg] test clusters create this throwaway one instead.
 *
 * Call AFTER `runMigrations` (the role is created by 0642). Idempotent.
 */
export const RUN_WRITER_TEST_LOGIN = 'fx_run_writer_test';

export async function createRunWriterTestLogin(adminUrl: string): Promise<void> {
  const pool = createPool(adminUrl);
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUN_WRITER_TEST_LOGIN}') THEN
          CREATE ROLE ${RUN_WRITER_TEST_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END
      $$`);
    await pool.query(`GRANT app_user, agent_run_writer TO ${RUN_WRITER_TEST_LOGIN}`);
  } finally {
    await pool.end();
  }
}

/** Same host/port/database as `appUserUrl`, connecting as the test login. */
export function runWriterUrlFrom(appUserUrl: string): string {
  const u = new URL(appUserUrl);
  u.username = RUN_WRITER_TEST_LOGIN;
  u.password = '';
  return u.toString();
}
