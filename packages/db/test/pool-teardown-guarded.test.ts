import { describe, expect, it } from "vitest";
import { provisionEphemeralPostgres } from "./support/ephemeral-pg.js";
import { guardedPools } from "./support/pool-teardown.js";

/**
 * Stopping a cluster while pools still hold connections must not raise an unhandled 57P01 (main CI failed once on exactly that, with every
 * test green). `guardedPools().stop()` ends the pools and waits for their sockets before the cluster stops. Outside teardown a 57P01 is still
 * rethrown by the guard; that rule has its own cases in packages/features/test/teardown-57p01.test.ts.
 */
describe("guardedPools", () => {
  it("stopping the cluster through stop() with idle clients on two pools raises no unhandled error", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", onUnhandled);
    process.on("unhandledRejection", onUnhandled);
    const cluster = await provisionEphemeralPostgres({ database: "fx_db_guarded_pools_test", tmpPrefix: "fx-db-guarded-pools-pg-" });
    try {
      const pools = guardedPools();
      const a = pools.create(cluster.url, "a");
      const b = pools.create(cluster.url, "b");
      await Promise.all([a.query("SELECT 1"), b.query("SELECT 1")]); // one idle client, one live socket, per pool
      expect(a.idleCount + b.idleCount).toBe(2);
      await pools.stop(() => cluster.cleanup());
      await new Promise((r) => setTimeout(r, 200)); // a late FATAL from the stopped server would surface here
    } finally {
      cluster.cleanup(); // idempotent
      process.off("uncaughtException", onUnhandled);
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  }, 60_000);

  it("stop() still stops the cluster when a pool cannot be ended, and reports that failure", async () => {
    const cluster = await provisionEphemeralPostgres({ database: "fx_db_guarded_pools_test", tmpPrefix: "fx-db-guarded-pools-pg-" });
    const pools = guardedPools();
    const pool = pools.create(cluster.url, "alreadyEnded");
    await pool.query("SELECT 1");
    await pool.end(); // a second end() rejects
    let stopped = false;
    try {
      await expect(pools.stop(() => ((stopped = true), cluster.cleanup()))).rejects.toThrow();
      expect(stopped).toBe(true);
    } finally {
      cluster.cleanup();
    }
  }, 60_000);
});
