import { afterAll, beforeAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createPool } from "@fx/db/src/pool.js";

/** Shared `beforeAll`/`afterAll` wiring for this package's [pg] test
 * files -- one admin (superuser) connection for seeding/assertions, one
 * app_user pool (RLS-enforced) for the code under test. Call synchronously
 * inside a `describe(...)` callback, exactly like a hand-written
 * `beforeAll`/`afterAll` pair would be. */
export function pgHarness(): { adminPool: Pool; admin: PoolClient; runWriterPool: Pool; pureAppUserPool: Pool } {
  const state: { adminPool?: Pool; admin?: PoolClient; runWriterPool?: Pool; pureAppUserPool?: Pool } = {};

  beforeAll(async () => {
    state.adminPool = createPool(process.env.RUNNER_DATABASE_URL!);
    state.admin = await state.adminPool.connect();
    // D#2 H09c: `runWriterPool` is the pool handed to the code under test,
    // i.e. a LOGIN that is a member of app_user AND agent_run_writer (the
    // only way to reach the agent_runs writer functions). Its table-level
    // privileges are exactly app_user's. `pureAppUserPool` is a plain
    // app_user connection, for the tests that prove app_user itself can
    // no longer write agent_runs.
    state.runWriterPool = createPool(process.env.RUNNER_DATABASE_URL_RUN_WRITER!);
    state.pureAppUserPool = createPool(process.env.RUNNER_DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    state.admin!.release();
    await state.adminPool!.end();
    await state.runWriterPool!.end();
    await state.pureAppUserPool!.end();
  });

  return state as { adminPool: Pool; admin: PoolClient; runWriterPool: Pool; pureAppUserPool: Pool };
}
