import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { guardPoolTeardown, type PoolTeardownGuard } from "@fx/db/test/support/pool-teardown.js";
import { defineFeature,type FeatureCatalogueEntry } from "../src/featureExposure.js";
import { freezeOnto, resolveExposure } from "../src/resolve.js";

/**
 * D#8 C2 (PM correction, 2026-09-26, on the #164/R3 review): a live-Postgres
 * regression test for `resolveExposure()`'s tenant scoping.
 *
 * resolve.test.ts's stub-pool suite is explicitly sanctioned by R3
 * criterion 1's own wording, but the #164 reviewer proved by mutation
 * testing that the stub is structurally blind to a missing
 * `app.account_id`: it pattern-matches on `"FROM account_features"` in the
 * query text and returns the same canned rows no matter which account asks,
 * so a resolver that silently dropped `withTenant` scoping would still pass
 * all 40 stub tests. Only a real connection against `account_features`'s
 * `FORCE ROW LEVEL SECURITY` policy can see that regression -- this file is
 * that live probe, the same way `packages/db/test/exposure.test.ts` already
 * proves the grant-matrix side of this same tenant boundary.
 *
 * This is a NEW, self-contained ephemeral-Postgres fixture rather than the
 * shared `globalSetup.ts` pattern `packages/db`/`packages/core`/etc. use:
 * `@fx/features`'s package scaffold (package.json/tsconfig.json/
 * vitest.config.ts) is R2's frozen scaffold ("so no later task edits a
 * shared package file" -- see resolve.test.ts's own file header), so this
 * task does not touch it. Instead this ONE file provisions and tears down
 * its own throwaway cluster in beforeAll/afterAll, reusing the exact same
 * `provisionEphemeralPostgres`/`runMigrations` helpers `packages/db`'s own
 * globalSetup.ts calls -- no new shared infrastructure, no scaffold edit.
 *
 * Seeding is minimal and inline (an `accounts` row + a `users` row per
 * account, via the admin pool's own `.query()` -- no client checkout, no
 * `SET ROLE` dance) rather than reusing `packages/db/test/helpers/seed.ts`'s
 * full 12-tenant-table `seedAccount()`: `resolveExposure()` and
 * `account_features`'s RLS only ever consult `accounts` (for
 * `account_is_active()`) and `users` (the FK target of
 * `decided_by_user_id`) -- nothing else `seedAccount()` seeds is reachable
 * from the code path this test exercises. The one write into
 * `account_features` itself is a plain INSERT as the superuser admin
 * connection, which -- like every other insert in
 * `packages/db/test/helpers/seed.ts` -- bypasses grants and RLS by virtue
 * of being a superuser, without needing `SET ROLE exposure_writer` first;
 * that role-privilege boundary is `packages/db/test/exposure.test.ts`'s own
 * concern, not this test's.
 *
 * No `pg` import anywhere: pool types are inferred from `@fx/db`'s own
 * exported `createPool`/`withTenant` (the identical discipline `resolve.ts`
 * itself already uses), so `@fx/features`'s frozen package.json never needs
 * `pg` (or `@types/pg`) as a dependency, and this file never checks out a
 * `PoolClient` at all -- every query here goes through a `Pool` directly.
 */
describe("D#8 C2: resolveExposure() tenant scoping, against real Postgres", () => {
  let cluster: EphemeralPostgres;
  let adminPool: ReturnType<typeof createPool>;
  let appUserPool: ReturnType<typeof createPool>;
  let adminGuard: PoolTeardownGuard | undefined;
  let appUserGuard: PoolTeardownGuard | undefined;
  let accountIdA: string;
  let accountIdB: string;
  let workItemIdA: string;

  const FEATURE_KEY = "c2_live_gated";
  const CATALOGUE: readonly FeatureCatalogueEntry[] = [
    defineFeature({ key: FEATURE_KEY, class: "gated", addedIn: 1, description: "x" }),
  ];

  /** accounts + users rows only -- see file header for why that's the whole seed this test needs. */
  async function seedMinimalAccount(accountId: string, userId: string): Promise<void> {
    await adminPool.query(
      `INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`,
      [accountId, `cus_test_${accountId}`],
    );
    await adminPool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
  }

  async function writeAccountFeature(accountId: string, userId: string, state: "on" | "off"): Promise<void> {
    await adminPool.query(
      `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
       VALUES ($1, $2, $3, 'customer', $4)`,
      [accountId, FEATURE_KEY, state, userId],
    );
  }

  beforeAll(async () => {
    cluster = await provisionEphemeralPostgres({ database: "fx_features_c2_test", tmpPrefix: "fx-features-c2-pg-" });
    adminPool = createPool(cluster.url);
    adminGuard = guardPoolTeardown(adminPool, "adminPool");
    await runMigrations(adminPool);
    appUserPool = createPool(cluster.appUserUrl);
    appUserGuard = guardPoolTeardown(appUserPool, "appUserPool");

    accountIdA = randomUUID();
    accountIdB = randomUUID();
    workItemIdA = randomUUID();
    const userIdA = randomUUID();
    const userIdB = randomUUID();

    await seedMinimalAccount(accountIdA, userIdA);
    await seedMinimalAccount(accountIdB, userIdB);

    // Opposite decisions for the SAME feature key on the two accounts --
    // if scoping ever leaks, account A reading account B's row (or vice
    // versa) flips the observed state, which the assertions below catch.
    await writeAccountFeature(accountIdA, userIdA, "on");
    await writeAccountFeature(accountIdB, userIdB, "off");
  }, 60_000);

  afterAll(async () => {
    // D#219 flake 1: pool.end() resolves before the sockets have closed, so
    // stopping the cluster straight after it hands 57P01 to a live socket
    // nobody is listening on. Wait for the sockets to close, and stop the
    // cluster last, whatever happened above.
    try {
      adminGuard?.assertNoCheckedOutClients();
      appUserGuard?.assertNoCheckedOutClients();
      await Promise.all([adminGuard?.endAndWaitForSockets(), appUserGuard?.endAndWaitForSockets()]);
    } finally {
      cluster?.cleanup();
    }
  }, 30_000);

  it("resolves account A's own explicit row, not account B's, through the real pool and RLS", async () => {
    const resolvedA = await resolveExposure(accountIdA, CATALOGUE, appUserPool);
    expect(resolvedA.value.features[FEATURE_KEY]).toEqual({
      class: "gated",
      state: "on",
      version: 1,
      source: "account",
    });

    const resolvedB = await resolveExposure(accountIdB, CATALOGUE, appUserPool);
    expect(resolvedB.value.features[FEATURE_KEY]).toEqual({
      class: "gated",
      state: "off",
      version: 1,
      source: "account",
    });

    // Non-vacuity for the assertions above: reading straight off the table
    // (superuser, no RLS in the way) confirms the two accounts really do
    // hold opposite rows, so the resolver assertions aren't accidentally
    // comparing two rows that happen to agree.
    const { rows } = await adminPool.query<{ account_id: string; state: string }>(
      `SELECT account_id, state FROM account_features WHERE feature_key = $1 ORDER BY account_id`,
      [FEATURE_KEY],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.account_id === accountIdA)?.state).toBe("on");
    expect(rows.find((r) => r.account_id === accountIdB)?.state).toBe("off");
  });

  it("freezeOnto's frozen read for account A's work item carries account A's state only", async () => {
    const resolvedA = await resolveExposure(accountIdA, CATALOGUE, appUserPool);
    const frozenRecord = freezeOnto({ id: workItemIdA, accountId: accountIdA }, resolvedA);

    expect(frozenRecord.resolved_exposure.accountId).toBe(accountIdA);
    expect(frozenRecord.resolved_exposure.features[FEATURE_KEY]?.state).toBe("on");

    // Nothing in the frozen value is, or came from, account B's row.
    expect(JSON.stringify(frozenRecord.resolved_exposure)).not.toContain(accountIdB);
    expect(frozenRecord.resolved_exposure.features[FEATURE_KEY]?.state).not.toBe("off");
  });
});
