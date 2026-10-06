import { afterAll, beforeAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createPool } from "@fx/db/src/pool.js";

/** Shared `beforeAll`/`afterAll` wiring for this package's [pg] test
 * files -- mirrors packages/pipeline/test/helpers/pgHarness.ts exactly,
 * with the `DISCUSSIONS_` prefix. One admin (superuser) connection for
 * seeding/assertions, one app_user pool (RLS-enforced) for the code under
 * test, one platform_ops pool for the erasure-role/negative tests. */
export function pgHarness(): { adminPool: Pool; admin: PoolClient; appUserPool: Pool; platformOpsPool: Pool } {
  const state: { adminPool?: Pool; admin?: PoolClient; appUserPool?: Pool; platformOpsPool?: Pool } = {};

  beforeAll(async () => {
    state.adminPool = createPool(process.env.DISCUSSIONS_DATABASE_URL!);
    state.admin = await state.adminPool.connect();
    state.appUserPool = createPool(process.env.DISCUSSIONS_DATABASE_URL_APP_USER!);
    state.platformOpsPool = createPool(process.env.DISCUSSIONS_DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    state.admin!.release();
    await state.adminPool!.end();
    await state.appUserPool!.end();
    await state.platformOpsPool!.end();
  });

  return state as { adminPool: Pool; admin: PoolClient; appUserPool: Pool; platformOpsPool: Pool };
}
