import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] D#605 FL-3 acceptance 1: seeded with 50k historical runs and 10 runners, the planner reads the claim's candidate query through
 * `agent_runs_claim_pending` and the per-runner running count through `agent_runs_claim_running`, and the claim stays inside its budget.
 *
 * The statements EXPLAINed are the ones the claim really sent: a recording pool in front of the real run-writer login captures their text and
 * parameters while the real facade runs, so there is no copy of the SQL here to drift from runnerClaims.ts. EXPLAIN runs through the same
 * login under the same tenant settings (row security included), against the real planner.
 */
const HISTORY = 50_000;
const RUNNERS = 10;
const POLLS = 300;

interface Captured {
  text: string;
  values: unknown[];
}

const percentile = (samples: number[], p: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

describe("the claim reads through its two partial indexes [pg] (D#605 FL-3)", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  const runners: string[] = [];
  const candidateQueries: Captured[] = [];
  const runningCounts: Captured[] = [];
  /** Wall time of each transaction that took the per-account claim lock: the claimOne transaction. */
  const claimOneMs: number[] = [];
  let facade: RunnerClaimFacade;

  /** The run-writer pool seen through a recorder. It forwards every call untouched; it only notes what was sent and how long claimOne took. */
  const recording = (real: Pool): Pool => {
    const wrap = (client: PoolClient): PoolClient => {
      let begunAt = 0;
      let tookLock = false;
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== "query") return Reflect.get(target, prop, receiver);
          return async (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            const values = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
            if (text === "BEGIN") {
              begunAt = performance.now();
              tookLock = false;
            }
            if (text.includes("pg_advisory_xact_lock") && values[0] !== undefined && String(values[0]).startsWith("runner_claim:")) tookLock = true;
            if (text.includes("FROM agent_runs a") && text.includes("JOIN repos r") && text.includes("LIMIT 1") && text.includes("job_signed")) candidateQueries.push({ text, values });
            if (text.includes("AS light, count(*) FILTER (WHERE NOT role = ANY($3::text[])) AS heavy FROM agent_runs WHERE account_id = $1 AND runner_id = $2")) runningCounts.push({ text, values });
            const out = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (text === "COMMIT" && tookLock) claimOneMs.push(performance.now() - begunAt);
            return out;
          };
        },
      });
    };
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "connect") return Reflect.get(target, prop, receiver);
        return async () => wrap(await target.connect());
      },
    });
  };

  const job = (runId: string, role: Job["role"]): Job => ({
    schema_version: 1,
    job_id: randomUUID(),
    run_id: runId,
    repo: { id: A.repoId, owner: "acme", name: "app", private: true },
    role,
    mode: "local",
    spec: null,
    task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
    role_card: { text: "c", sha256: sha256Text("c") },
    role_tools_sha256: "a".repeat(64),
    continues: null,
    branch_prefix: "fx/",
    model_hint: null,
    issued_at: new Date(T0 - 1000).toISOString(),
    expires_at: new Date(T0 + 72 * 3_600_000).toISOString(),
    key_id: "k1",
  });

  async function addPending(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      ids.push(id);
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at)
         VALUES ($1, $2, 'code-reviewer', 'runner', 'pending', 'runner_local', $3, $4::jsonb, $5, to_timestamp($6 / 1000.0))`,
        [id, A.accountId, A.repoId, JSON.stringify(signJob(job(id, "code-reviewer"), key)), A.userId, T0 - 500_000 + i],
      );
    }
    return ids;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    for (let i = 0; i < RUNNERS; i++) {
      const id = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key" });
      await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, [A.repoId], ["executor", "code-reviewer"]]);
      runners.push(id);
    }
    // 50k finished runs, spread over the 10 runners, the way an account that has used runners for a long while looks: every one of them has a
    // runner_id, so an index over "runs that ever had a runner" is as big as the history.
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, runner_id, created_at)
       SELECT gen_random_uuid(), $1, CASE WHEN g % 3 = 0 THEN 'executor' ELSE 'code-reviewer' END, 'runner', 'succeeded', 'runner_local', $2, ($3::uuid[])[1 + g % $4], to_timestamp($5 / 1000.0) - make_interval(secs => g)
         FROM generate_series(1, $6) g`,
      [A.accountId, A.repoId, runners, RUNNERS, T0 - 1_000_000, HISTORY],
    );
    // A few runs running now (two per runner), and a queue to claim from.
    for (const runner of runners) {
      for (let i = 0; i < 2; i++) {
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, runner_id, created_at)
           VALUES (gen_random_uuid(), $1, 'code-reviewer', 'runner', 'running', 'runner_local', $2, $3, to_timestamp($4 / 1000.0))`,
          [A.accountId, A.repoId, runner, T0 - 10_000],
        );
      }
    }
    await addPending(POLLS + 20);
    await admin.query("ANALYZE agent_runs");
    facade = createRunnerClaimFacade(recording(writerPool), {
      visibility: { visibility: async () => "private" },
      now: () => T0,
      randomBetween: (min) => min,
      limits: () => ({ maxConcurrentRunnerJobs: 1000, maxConcurrentHeavyRunnerJobs: 1000, maxRunWallClockMs: 7_200_000 }),
    });
  }, 120_000);
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const cap = { light: { limit: 8, in_use: 0 }, heavy: { limit: 0, in_use: 0 } };
  /** The plan of a statement the claim really sent, as the run-writer login reads it under the account's tenant settings. */
  const plan = async (sent: Captured): Promise<string> =>
    withTenant(writerPool, A.accountId, async (client) => {
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sent.text}`, sent.values);
      return JSON.stringify(rows[0]["QUERY PLAN"]);
    });

  it("polls: claimOne p99 under 10 ms and the whole poll p95 under 50 ms with 50k finished runs and 10 runners", async () => {
    // Warm up, then complete every claimed run at once so the next poll has room: the runner's own count stays at the two running runs.
    const pollMs: number[] = [];
    let claimed = 0;
    for (let i = 0; i < POLLS + 10; i++) {
      const runner = runners[i % RUNNERS]!;
      const started = performance.now();
      const res = await facade.claimRunnerRun({ accountId: A.accountId, runnerId: runner, capacity: cap });
      const took = performance.now() - started;
      if (res.kind === "claimed") {
        claimed++;
        await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [res.runId]);
        if (i >= 10) pollMs.push(took);
      }
    }
    expect(claimed).toBeGreaterThanOrEqual(POLLS);
    const claimOneSamples = claimOneMs.slice(10);
    expect(claimOneSamples.length).toBeGreaterThanOrEqual(POLLS - 10);
    const stats = { claimOneP99: percentile(claimOneSamples, 99), pollP95: percentile(pollMs, 95), polls: pollMs.length };
    console.info(`fl3-perf ${JSON.stringify(stats)}`);
    expect(stats.claimOneP99).toBeLessThan(10);
    expect(stats.pollP95).toBeLessThan(50);
  }, 120_000);

  it("EXPLAIN of the candidate query the claim sent shows agent_runs_claim_pending, and a control without the index does not", async () => {
    await addPending(5);
    expect(candidateQueries.length).toBeGreaterThan(0);
    // The last candidate query sent, with its real parameters, planned afresh against the table as it is now.
    const sent = candidateQueries[candidateQueries.length - 1]!;
    expect(await plan(sent)).toContain("agent_runs_claim_pending");
    // Control: the same statement planned while the index is gone (rolled back at once) must not name it, so the assertion above can fail.
    await admin.query("BEGIN");
    try {
      await admin.query("DROP INDEX agent_runs_claim_pending");
      const { rows } = await admin.query(`EXPLAIN (FORMAT JSON) ${sent.text}`, sent.values);
      expect(JSON.stringify(rows[0]["QUERY PLAN"])).not.toContain("agent_runs_claim_pending");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("EXPLAIN of the per-runner running count the claim sent shows agent_runs_claim_running, and a control without the index does not", async () => {
    expect(runningCounts.length).toBeGreaterThan(0);
    const sent = runningCounts[runningCounts.length - 1]!;
    expect(await plan(sent)).toContain("agent_runs_claim_running");
    await admin.query("BEGIN");
    try {
      await admin.query("DROP INDEX agent_runs_claim_running");
      const { rows } = await admin.query(`EXPLAIN (FORMAT JSON) ${sent.text}`, sent.values);
      expect(JSON.stringify(rows[0]["QUERY PLAN"])).not.toContain("agent_runs_claim_running");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("the account really holds the history: 50k finished runs, and only the live ones are in the two indexes", async () => {
    const total = await admin.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [A.accountId]);
    expect(Number(total.rows[0]!.n)).toBeGreaterThanOrEqual(HISTORY);
    const sizes = await admin.query<{ pending: string; running: string; ever: string }>(
      "SELECT pg_relation_size('agent_runs_claim_pending') AS pending, pg_relation_size('agent_runs_claim_running') AS running, pg_relation_size('idx_agent_runs_runner_id') AS ever",
    );
    // The partial indexes hold the queue and the live runs; the 0711 index holds every run that ever had a runner.
    // The database is shared with this package's other tests, which leave their own pending runs behind, so the bound is a fifth, not a tenth.
    console.info(`fl3-sizes ${JSON.stringify(sizes.rows[0])}`);
    expect(Number(sizes.rows[0]!.pending)).toBeLessThan(Number(sizes.rows[0]!.ever) / 5);
    expect(Number(sizes.rows[0]!.running)).toBeLessThan(Number(sizes.rows[0]!.ever) / 5);
  });

  it("the migration adds indexes only: no grant, policy, role or function (platform_ops gains nothing)", () => {
    const sql = readFileSync(new URL("../../db/migrations/0785_runner_claim_indexes.sql", import.meta.url), "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--") && line.trim() !== "")
      .join("\n");
    expect(statements.match(/;/g)?.length).toBe(2);
    expect(statements).toMatch(/^CREATE INDEX agent_runs_claim_pending ON agent_runs \(account_id, created_at, id\) WHERE status = 'pending' AND runtime = 'runner' AND runner_id IS NULL;\nCREATE INDEX agent_runs_claim_running ON agent_runs \(account_id, runner_id\) WHERE status = 'running';$/);
    expect(statements).not.toMatch(/GRANT|REVOKE|POLICY|ROLE|FUNCTION/i);
  });
});
