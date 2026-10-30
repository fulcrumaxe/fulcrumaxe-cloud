import { describe, expect, it } from "vitest";
import { provisionEphemeralPostgres } from "./support/ephemeral-pg.js";
import { guardPoolTeardown } from "./support/pool-teardown.js";
import { createPool } from "../src/pool.js";

/**
 * Reproduction of the recurring "terminating connection due to administrator command" (57P01) failure: a backend is terminated while its
 * client sits idle in a pool. Without any 'error' listener the pool re-emits the client error, Node raises it as an uncaught exception and
 * vitest fails the whole run after every test passed. The guard absorbs that one code, and only once teardown has begun.
 */
async function terminateIdleBackendAndCollect(attach: (pool: ReturnType<typeof createPool>) => void): Promise<{ code?: string }[]> {
  const seen: { code?: string }[] = [];
  const onUncaught = (e: unknown) => seen.push(e as { code?: string });
  const prior = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException"); // vitest's own handler would turn this into a run failure
  process.on("uncaughtException", onUncaught);
  const cluster = await provisionEphemeralPostgres({ database: "fx_db_terminate_57p01", tmpPrefix: "fx-db-terminate-57p01-pg-" });
  const admin = createPool(cluster.url);
  admin.on("error", () => {}); // the admin pool is not under test
  const pool = createPool(cluster.url);
  try {
    attach(pool);
    await pool.query("SELECT 1"); // leaves one idle client
    const { rows } = await admin.query(`SELECT pg_backend_pid() AS me`);
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> $1 AND backend_type = 'client backend' AND datname = current_database()`, [rows[0].me]);
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    await pool.end().catch(() => {});
    await admin.end().catch(() => {});
    cluster.cleanup();
    process.off("uncaughtException", onUncaught);
    for (const l of prior) process.on("uncaughtException", l as never);
  }
  return seen;
}

describe("57P01 on an idle pooled client", () => {
  it("without a handler the terminated backend surfaces as an uncaught 57P01 (the bug)", async () => {
    const seen = await terminateIdleBackendAndCollect(() => {});
    expect(seen.map((e) => e.code)).toContain("57P01");
  }, 60_000);

  it("with the teardown guard it is absorbed once teardown has begun", async () => {
    let absorbed: readonly unknown[] = [];
    const seen = await terminateIdleBackendAndCollect((pool) => {
      const g = guardPoolTeardown(pool, "repro");
      g.beginTeardown();
      absorbed = g.absorbed;
    });
    expect(seen).toEqual([]);
    expect(absorbed.length).toBeGreaterThan(0);
  }, 60_000);
});
