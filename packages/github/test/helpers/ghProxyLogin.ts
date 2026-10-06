import { createPool } from '@fx/db/src/pool.js';

/**
 * The throwaway stand-in for the production gh-proxy login (migration 0696,
 * docs/ops/gh-proxy-login.md): a LOGIN that is a member of run_binding_resolver
 * and of nothing else. The ephemeral test cluster uses trust auth, so the
 * login needs no password. Call AFTER the migrations ran. Idempotent; the
 * test files of this package run one at a time, so there is no create race.
 */
export const GH_PROXY_TEST_LOGIN = 'fx_gh_proxy_test';

export async function ensureGhProxyTestLogin(adminUrl: string): Promise<string> {
  const pool = createPool(adminUrl);
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${GH_PROXY_TEST_LOGIN}') THEN
          CREATE ROLE ${GH_PROXY_TEST_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END
      $$`);
    await pool.query(`GRANT run_binding_resolver TO ${GH_PROXY_TEST_LOGIN}`);
  } finally {
    await pool.end();
  }
  const u = new URL(adminUrl);
  u.username = GH_PROXY_TEST_LOGIN;
  u.password = '';
  return u.toString();
}
