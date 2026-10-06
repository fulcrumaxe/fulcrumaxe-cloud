import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '../src/pg.js';
import { provisionEphemeralPostgres, type TestDbEnv } from '../../db/test/support/ephemeral-pg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * H10's own throwaway-Postgres bootstrap, deliberately parallel to
 * packages/spend/test/globalSetup.ts (itself parallel to packages/db's)
 * rather than importing either -- @fx/db publishes no main/exports and
 * H10's file scope is packages/billing/** plus the webhook route, not
 * packages/db/package.json. Applying packages/db/migrations/*.sql
 * directly gives this project the real accounts/ledger/audit_log schema
 * (H02) without adding a migration of its own: H10's Files line lists no
 * new migration, and none is needed -- accounts.plan already has no
 * CHECK constraint by design, and idempotent event replay is tracked in
 * the existing audit_log table (see src/idempotency.ts).
 */
async function applyMigrations(url: string): Promise<void> {
  const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pool = createPool(url);
  try {
    const client = await pool.connect();
    try {
      for (const filename of files) {
        const sql = readFileSync(path.join(migrationsDir, filename), 'utf8');
        await client.query(sql);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * D#56 / PR #53 fix round 3 (PART 2, following #67's pattern for
 * packages/spend): this used to write `process.env.BILLING_DATABASE_URL*`
 * directly, and picked its throwaway port with a pseudo-random offset
 * (a random-number generator call, no OS collision check). With
 * `vitest.workspace.ts` running every project's globalSetup in ONE shared
 * orchestrator process, `process.env` is that process's single shared
 * object -- another project's globalSetup writing the SAME bare name (or
 * this project's own value being read by a worker forked at the wrong
 * moment) meant one project's tests could end up talking to another
 * project's database, and the unguarded random port pick had no real
 * collision guard either. Provisioning now goes through the shared
 * `ephemeral-pg.ts` helper (an OS-assigned free port, not a pseudo-random
 * offset), and the result is handed to THIS project only via `provide()`
 * -- `bind-test-env.ts` (a setupFiles entry, see vitest.config.ts) puts it
 * back into `process.env` inside this project's own worker fork, where
 * nothing else can overwrite it. Existing test files keep reading
 * `process.env.BILLING_DATABASE_URL*` completely unchanged.
 *
 * Deliberately `BILLING_`-prefixed, never the bare `DATABASE_URL*` names
 * (packages/db) or the `SPEND_`-prefixed ones (packages/spend) -- same
 * reasoning as those two projects' own globalSetup.ts headers.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.BILLING_DATABASE_URL_TEST) {
    url = process.env.BILLING_DATABASE_URL_TEST;
    const appUserUrl = process.env.BILLING_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.BILLING_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error(
        'BILLING_DATABASE_URL_APP_USER and BILLING_DATABASE_URL_PLATFORM_OPS must both be set alongside BILLING_DATABASE_URL_TEST.',
      );
    }
    testDbEnv = { prefix: 'BILLING_', url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: 'fx_billing_test',
      tmpPrefix: 'fx-billing-pg-',
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: 'BILLING_',
      url: provisioned.url,
      appUserUrl: provisioned.appUserUrl,
      platformOpsUrl: provisioned.platformOpsUrl,
    };
  }

  provide('testDbEnv', testDbEnv);

  await applyMigrations(url);

  return async () => {
    cleanup?.();
  };
}
