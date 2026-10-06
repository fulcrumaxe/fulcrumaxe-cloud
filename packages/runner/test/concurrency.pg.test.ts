import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { startAgentRun } from "../src/startAgentRun.js";
import { cancelRun } from "../src/cancelRun.js";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * PR #85 fix round item 5 (CWE-833/400): `startAgentRun`'s own
 * `admitClient` and `cancelRun`'s own outer `withTenant` client used to
 * be held open while the code they called (`target.admit`/
 * `writeRunStatus`/`target.cancel`) made its OWN `pool.connect()` call
 * against the SAME pool. On a pool sized smaller than the number of
 * concurrent callers, every caller can end up holding one connection
 * while waiting on a second that never frees -- a real deadlock, not
 * just a slowdown. `db` (from `pgHarness`) is NOT reused for the calls
 * under test here on purpose: this file builds its OWN small pool so the
 * scenario is deterministic regardless of whatever pool size the shared
 * test harness happens to use elsewhere.
 */
describe("PR #85 fix round item 5: no nested-pool-connection deadlock [pg]", () => {
  const db = pgHarness();
  const POOL_MAX = 3;
  const N = POOL_MAX * 3;
  const DEADLOCK_TIMEOUT_MS = 8000;

  async function raceAgainstTimeout<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${DEADLOCK_TIMEOUT_MS}ms -- looks like a deadlock`)), DEADLOCK_TIMEOUT_MS);
      }),
    ]);
  }

  /**
   * Pre-fix (fdc38c4) failure, run against this exact test body:
   *   FAIL  test/concurrency.pg.test.ts > ... > startAgentRun calls ...
   *     Error: timed out after 8000ms -- looks like a deadlock
   *     (every one of the N concurrent calls was blocked inside
   *      `pool.connect()` for its nested reserve() call, each waiting on
   *      a connection held -- unused -- by another call's own
   *      `admitClient`)
   */
  it(`${N} concurrent startAgentRun calls on a pool of ${POOL_MAX} all complete within a bounded timeout`, async () => {
    const smallPool = createPool(process.env.RUNNER_DATABASE_URL_RUN_WRITER!, { max: POOL_MAX });
    try {
      const accountId = randomUUID();
      await seedAccount(db.admin, accountId);
      const repoIds: string[] = [];
      for (let i = 0; i < N; i++) {
        const repoId = randomUUID();
        await seedRepo(db.admin, accountId, repoId);
        repoIds.push(repoId);
      }
      const harness = createSandboxTargetHarness(smallPool);
      const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

      const calls = repoIds.map((repoId) =>
        startAgentRun(smallPool, registry, {
          accountId,
          repoId,
          role: "code-reviewer",
          product: "team",
          roleCard: "fake role card",
          prompt: "fake prompt",
          model: "haiku-4.5",
          capUsd: 5,
          spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
        }),
      );

      const results = await raceAgainstTimeout(Promise.all(calls));
      expect(results).toHaveLength(N);
      expect(results.every((r) => r.status === "running")).toBe(true);
    } finally {
      await smallPool.end();
    }
  }, DEADLOCK_TIMEOUT_MS + 5000);

  /**
   * Pre-fix (fdc38c4) failure, run against this exact test body:
   *   FAIL  test/concurrency.pg.test.ts > ... > cancelRun calls ...
   *     Error: timed out after 8000ms -- looks like a deadlock
   *     (every one of the N concurrent calls was blocked inside its own
   *      writeRunStatus/target.cancel `pool.connect()`, each waiting on
   *      a connection held by cancelRun's own outer withTenant client,
   *      which was never released until the whole function returned)
   */
  it(`${N} concurrent cancelRun calls on a pool of ${POOL_MAX} all complete within a bounded timeout`, async () => {
    const smallPool = createPool(process.env.RUNNER_DATABASE_URL_RUN_WRITER!, { max: POOL_MAX });
    try {
      const accountId = randomUUID();
      const userId = randomUUID();
      await seedAccount(db.admin, accountId);
      await seedMember(db.admin, accountId, userId);

      const runIds: string[] = [];
      for (let i = 0; i < N; i++) {
        const { id } = await insertAgentRun(smallPool, {
          id: randomUUID(),
          accountId,
          role: "code-reviewer",
          runtime: "production",
        });
        await writeRunStatus(smallPool, { accountId, runId: id, from: "pending", to: "running" });
        await db.admin.query(
          `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose)
           VALUES ($1, $2, 1, 'open', 'foreground_compute', 'run')`,
          [accountId, id],
        );
        runIds.push(id);
      }

      const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(createSandboxTargetHarness(smallPool).deps) };
      const calls = runIds.map((runId) => cancelRun({ pool: smallPool, principal: { accountId, userId } }, runId, registry));

      const results = await raceAgainstTimeout(Promise.all(calls));
      expect(results).toHaveLength(N);
      expect(results.every((r) => r.status === "cancelled")).toBe(true);
    } finally {
      await smallPool.end();
    }
  }, DEADLOCK_TIMEOUT_MS + 5000);
});
