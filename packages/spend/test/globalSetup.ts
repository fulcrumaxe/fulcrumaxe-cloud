import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '../src/pg.js';
import { provisionEphemeralPostgres, type TestDbEnv } from '../../db/test/support/ephemeral-pg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * H05's own throwaway-Postgres bootstrap, deliberately parallel to
 * packages/db/test/globalSetup.ts rather than importing ITS migration
 * runner -- @fx/db publishes no main/exports (see src/pg.ts's file
 * header), and H05's file scope is packages/spend/** plus one migration
 * file, not packages/db/package.json. Applying packages/db/migrations/*.sql
 * directly (reading the .sql files, not @fx/db's runMigrations()) keeps
 * this self-contained: H05 needs the SCHEMA those migrations define
 * (including the 0002 migration this task adds), not @fx/db's specific
 * migration-tracking mechanism. D#56 does reuse @fx/db's shared
 * ephemeral-pg.ts PROVISIONING helper via a relative import though --
 * that's plumbing, not @fx/db's internals, and packages/core already
 * imports @fx/db's non-exported paths this same way.
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
 * Deliberately SPEND_-prefixed env vars, never the bare DATABASE_URL /
 * DATABASE_URL_APP_USER / DATABASE_URL_PLATFORM_OPS names
 * packages/db/test/globalSetup.ts uses for its OWN, separate ephemeral
 * Postgres cluster.
 *
 * D#56: this file's own header used to record the exact race this Spec
 * fixes -- running the root `vitest.workspace.ts` executes every
 * project's globalSetup in the SAME orchestrator process before forking
 * test workers, and `process.env` is that process's single shared object.
 * The SPEND_ prefix already made this project safe from a NAME collision
 * with packages/db, but writing to `process.env` at all was still
 * fragile: this now goes through `provide()` (this project's own value
 * only) and bind-test-env.ts puts it back into `process.env` inside this
 * project's own worker fork, same as packages/db and packages/core.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.SPEND_DATABASE_URL_TEST) {
    url = process.env.SPEND_DATABASE_URL_TEST;
    const appUserUrl = process.env.SPEND_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.SPEND_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error(
        'SPEND_DATABASE_URL_APP_USER and SPEND_DATABASE_URL_PLATFORM_OPS must be set alongside SPEND_DATABASE_URL_TEST.',
      );
    }
    testDbEnv = { prefix: 'SPEND_', url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: 'fx_spend_test',
      tmpPrefix: 'fx-spend-pg-',
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: 'SPEND_',
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
