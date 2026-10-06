import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { createFakeModelConnectionPort } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createReaperSdkFake } from "../../runner/test/helpers/reaperSdkFake.js";
import { buildWorker, type BuiltWorker } from "../src/compositionRoot.js";

/**
 * D#2 SANDBOX-REAPER-1a, C82 criterion 22 [pg]: the role boundary end to end. `sweepSandboxReap` runs on a worker built on a
 * runner login and succeeds; the same definer calls made on a platform_ops session (or app_user's) fail with insufficient_privilege;
 * and the reaper never touches the platform_ops pool the worker holds.
 */
describe("the sandbox reaper through the worker [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  const opsQueries: string[] = [];
  const sdk = createReaperSdkFake();
  let worker: BuiltWorker;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    const query = opsPool.query.bind(opsPool) as (...a: unknown[]) => unknown;
    (opsPool as unknown as { query: unknown }).query = (...a: unknown[]) => (opsQueries.push(String(a[0])), query(...a));
    worker = await buildWorker({
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => "tok" },
      ports: { decryptTenantKey: async () => "k", modelConnection: createFakeModelConnectionPort(), connectionStatus: { markBroken: async () => {} }, hooks: { resume: async () => {} } },
      sdk: sdk.sdk,
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: opsPool, close: async () => undefined }),
    });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool, opsPool]) await p.end();
  });

  /** An ended executor run on a merged item, and a stopped sandbox with its snapshot at the (fake) provider. */
  async function candidate(): Promise<{ name: string; accountId: string }> {
    const a = await seedAccount(admin, randomUUID());
    const itemId = randomUUID();
    const name = `ex-${a.accountId}-${a.repoId}-5`;
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', 5, 'internal', 'merged')`, [itemId, a.accountId, a.repoId]);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at)
       VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4, $5, 5, now() - interval '1 hour')`,
      [randomUUID(), a.accountId, itemId, name, a.repoId],
    );
    sdk.seed(name, "stopped", { persistent: true, snapshot: true });
    return { name, accountId: a.accountId };
  }
  const input = (mode: "on" | "dry_run") => ({ pass: "terminal", mode, now: Date.now(), cursor: null, maxCalls: 60, timeBudgetMs: 600_000 }) as const;

  it("a worker on the runner login deletes an ended executor sandbox and its snapshot, never uses the platform_ops pool, and answers in plain data", async () => {
    const c = await candidate();
    opsQueries.length = 0;
    const result = await worker.sweepSandboxReap(input("on"));
    expect(result.candidates).toContainEqual({ accountId: c.accountId, sandboxName: c.name, reason: "terminal" });
    expect(sdk.estate.has(c.name)).toBe(false);
    expect(sdk.snapshots.has(c.name)).toBe(false);
    expect((await admin.query(`SELECT state FROM sandbox_reaps WHERE sandbox_name = $1`, [c.name])).rows).toEqual([{ state: "deleted" }]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result); // nothing but data crosses the facade
    expect(Object.keys(result).sort()).toEqual(["alerts", "callsUsed", "candidates", "cursor", "deleted", "orphans", "skipped", "stopped", "wrapped"]);
    expect(sdk.waking).toEqual([]);
    await candidate();
    await worker.sweepSandboxReap(input("dry_run"));
    expect(opsQueries).toEqual([]);
    await expect(worker.sweepSandboxReap({ ...input("on"), pass: "idle" })).rejects.toMatchObject({ code: "not_supported" });
  });

  for (const sql of ["SELECT * FROM sandbox_reap_candidates_terminal(5, NULL)", "SELECT sandbox_reap_claim('ex-x', 'terminal')", "SELECT sandbox_reap_done('ex-x', 'deleted')", "SELECT sandbox_reap_unknown_names(ARRAY['ex-x'])"]) {
    it(`${sql.slice(7, 40)}: a platform_ops session and an app_user session fail with insufficient_privilege, the runner login's session does not`, async () => {
      await expect(opsPool.query(sql)).rejects.toMatchObject({ code: "42501" });
      await expect(appPool.query(sql)).rejects.toMatchObject({ code: "42501" });
      await writerPool.query(sql).catch((e: { code?: string }) => expect(e.code).not.toBe("42501"));
    });
  }
});
