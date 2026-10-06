import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { provisionEphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { guardPoolTeardown, type TeardownPool } from "@fx/db/test/support/pool-teardown.js";

/**
 * D#219 flake 1: the pool-teardown helper absorbs SQLSTATE 57P01 during the
 * teardown window only. Everything else still fails the run.
 */
function fakePool(): { pool: TeardownPool; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const pool = Object.assign(emitter, {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    end: async () => {},
  }) as unknown as TeardownPool;
  return { pool, emitter };
}

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe("guardPoolTeardown: 57P01 is handled during teardown only", () => {
  it("57P01 BEFORE teardown throws, so a mid-test administrator shutdown still fails the test", () => {
    const { pool, emitter } = fakePool();
    const guard = guardPoolTeardown(pool);
    expect(() => emitter.emit("error", pgError("57P01"))).toThrow(/57P01/);
    expect(guard.absorbed).toHaveLength(0);
  });

  it("57P01 AFTER beginTeardown() is absorbed and recorded", () => {
    const { pool, emitter } = fakePool();
    const guard = guardPoolTeardown(pool);
    guard.beginTeardown();
    expect(() => emitter.emit("error", pgError("57P01"))).not.toThrow();
    expect(guard.absorbed).toHaveLength(1);
  });

  it("a different code AFTER beginTeardown() still throws", () => {
    const { pool, emitter } = fakePool();
    const guard = guardPoolTeardown(pool);
    guard.beginTeardown();
    expect(() => emitter.emit("error", pgError("08006"))).toThrow(/08006/);
    expect(() => emitter.emit("error", new Error("no code at all"))).toThrow(/no code at all/);
    expect(guard.absorbed).toHaveLength(0);
  });

  it("assertNoCheckedOutClients names the pool and its counts when a client is checked out", () => {
    const { pool } = fakePool();
    Object.assign(pool, { totalCount: 2, idleCount: 1, waitingCount: 0 });
    expect(() => guardPoolTeardown(pool, "somePool").assertNoCheckedOutClients()).toThrow(
      /somePool: 1 client\(s\) still checked out at teardown \(totalCount=2, idleCount=1/,
    );
  });
});

describe("guardPoolTeardown against a real cluster", () => {
  it("stopping the cluster with an idle pool open delivers 57P01, which the teardown window absorbs", async () => {
    const cluster = await provisionEphemeralPostgres({ database: "fx_features_57p01_test", tmpPrefix: "fx-features-57p01-pg-" });
    const pool = createPool(cluster.url);
    const guard = guardPoolTeardown(pool, "idlePool");
    try {
      await pool.query("SELECT 1"); // leaves one idle client and its socket open
      expect(pool.totalCount).toBe(1);
      guard.assertNoCheckedOutClients();

      // The failing-first shape: the server is stopped while the socket is
      // still live. Without a listener this is the unhandled 57P01 from CI.
      guard.beginTeardown();
      cluster.cleanup();

      // The FATAL message arrives asynchronously after pg_ctl returns.
      const deadline = Date.now() + 5000;
      while (guard.absorbed.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(guard.absorbed.length, "57P01 never reached the idle client").toBeGreaterThanOrEqual(1);
      expect((guard.absorbed[0] as { code?: string }).code).toBe("57P01");
    } finally {
      cluster.cleanup(); // idempotent: a second stop fails quietly and the rm is force
      await guard.endAndWaitForSockets().catch(() => {});
    }
  }, 60_000);

  it("endAndWaitForSockets() leaves no open socket behind, so stopping the cluster afterwards raises nothing", async () => {
    const cluster = await provisionEphemeralPostgres({ database: "fx_features_57p01_test", tmpPrefix: "fx-features-57p01-pg-" });
    const pool = createPool(cluster.url);
    const guard = guardPoolTeardown(pool, "orderedPool");
    try {
      await pool.query("SELECT 1");
      await guard.endAndWaitForSockets();
    } finally {
      cluster.cleanup();
    }
    await new Promise((r) => setTimeout(r, 100)); // any late 57P01 would surface as an unhandled error here
    expect(guard.absorbed).toHaveLength(0);
  }, 60_000);
});
