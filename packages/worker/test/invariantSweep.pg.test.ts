import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { writeRunStatus } from "@fx/runner";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { INVARIANTS, sweepInvariants } from "../src/invariantSweep.js";

/**
 * [pg] D#597 CC-8: the three invariants, each against a real Postgres through the run-writer login the cron uses. A fixture per rule raises
 * exactly one alert and one item fact; a second sweep over the same state raises none; the healthy fixtures raise none. Grace is 0 here so a
 * fixture is due at once (the grace itself has its own case); the window is wide.
 */
describe("platform invariant sweep [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  const made: string[] = [];
  const reports: Array<{ code?: string }> = [];
  const warns: string[] = [];

  const sweep = (o: { i2?: boolean; graceSeconds?: number; pool?: Pick<Pool, "query"> } = {}) =>
    sweepInvariants({
      pool: (o.pool ?? writerPool) as Pool,
      report: (_e, ctx) => reports.push({ code: ctx.code }),
      warn: (l) => warns.push(l),
      i2Enabled: o.i2 ?? false,
      graceSeconds: o.graceSeconds ?? 0,
      windowSeconds: 3600,
    });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    // The database is shared with other suites' runs: alert whatever is already due once, so each case below counts only its own fixtures.
    await sweep({ i2: true });
    reports.length = 0;
    warns.length = 0;
  });
  afterEach(async () => {
    // Runs go with their alerts (cascade); the item facts keep a null run id and are removed by key.
    await admin.query("DELETE FROM work_item_driver_events WHERE kind = 'platform_check'");
    await admin.query("DELETE FROM agent_runs WHERE id = ANY($1::uuid[])", [made.splice(0)]);
    reports.length = 0;
    warns.length = 0;
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  async function item(acct: SeedRefs, stage = "in_progress"): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', $4)", [id, acct.accountId, acct.repoId, stage]);
    return id;
  }
  async function run(acct: SeedRefs, o: { item?: string | null; runtime?: "runner" | "local"; status?: string; role?: string; envelope?: unknown } = {}): Promise<string> {
    const id = randomUUID();
    const runner = (o.runtime ?? "local") === "runner";
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [id, acct.accountId, o.item === undefined ? null : o.item, o.role ?? "executor", o.runtime ?? "local", o.status ?? "succeeded", o.envelope === undefined ? null : JSON.stringify(o.envelope), runner ? "runner_local" : null, runner ? acct.repoId : null],
    );
    made.push(id);
    return id;
  }
  let seq = 1;
  const event = (acct: SeedRefs, runId: string, kind: string, payload: unknown) =>
    admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)", [acct.accountId, runId, seq++, kind, JSON.stringify(payload)]);
  const alerts = async (runId: string): Promise<string[]> => (await admin.query("SELECT invariant FROM platform_invariant_alerts WHERE run_id = $1", [runId])).rows.map((r) => r.invariant as string);
  const facts = async (runId: string) => (await admin.query("SELECT kind, code, reasons, head_sha, pr_number, round FROM work_item_driver_events WHERE kind = 'platform_check' AND dedupe_key LIKE '%' || $1", [runId])).rows;

  describe("I1 stage_not_moved", () => {
    it("a succeeded executor run with a PR and an item still in progress raises one alert and one item fact; a second sweep raises none", async () => {
      const it1 = await item(A);
      const r = await run(A, { item: it1, envelope: { pr_number: 12 } });
      const first = await sweep();
      expect(first.raised.stage_not_moved).toBe(1);
      expect(await alerts(r)).toEqual(["stage_not_moved"]);
      expect(await facts(r)).toEqual([{ kind: "platform_check", code: "stage_not_moved", reasons: [], head_sha: null, pr_number: null, round: null }]);
      expect(reports).toEqual([{ code: "invariant_stage_not_moved" }]);
      const second = await sweep();
      expect(second.raised.stage_not_moved).toBe(0);
      expect((await alerts(r)).length).toBe(1);
      expect((await facts(r)).length).toBe(1);
      expect(reports.length).toBe(1);
    });

    it("also reads the PR number a runner's done recorded on the run's status event", async () => {
      const r = await run(A, { item: await item(A), runtime: "runner" });
      await event(A, r, "run.status_changed", { to: "succeeded", viaRunnerDone: "true", prNumber: 77 });
      expect((await sweep()).raised.stage_not_moved).toBe(1);
    });

    it.each([
      ["the stage moved on", async () => ({ item: await item(A, "pr_opened"), envelope: { pr_number: 3 } })],
      ["the run opened no PR", async () => ({ item: await item(A), envelope: {} })],
      ["the run failed", async () => ({ item: await item(A), envelope: { pr_number: 3 }, status: "failed" })],
      ["the run is a reviewer's", async () => ({ item: await item(A), envelope: { pr_number: 3 }, role: "code-reviewer" })],
    ])("healthy: %s raises nothing", async (_name, make) => {
      const r = await run(A, await make());
      expect((await sweep()).raised.stage_not_moved).toBe(0);
      expect(await alerts(r)).toEqual([]);
    });

    it("healthy: a run still inside its grace period, and an item with a live run, raise nothing", async () => {
      const young = await run(A, { item: await item(A), envelope: { pr_number: 3 } });
      expect((await sweep({ graceSeconds: 3600 })).raised.stage_not_moved).toBe(0);
      expect(await alerts(young)).toEqual([]);
      const busyItem = await item(A);
      const done = await run(A, { item: busyItem, envelope: { pr_number: 4 } });
      await run(A, { item: busyItem, status: "running" });
      expect((await sweep()).raised.stage_not_moved).toBe(1); // only `young` (now past a zero grace)
      expect(await alerts(done)).toEqual([]);
    });
  });

  describe("I2 no_activity (behind the I2_ENABLED constant)", () => {
    it("a finished runner run with no activity row raises one alert and one item fact, once", async () => {
      const r = await run(A, { item: await item(A, "pr_opened"), runtime: "runner" });
      await event(A, r, "runner.event", { type: "tool_use" });
      expect((await sweep({ i2: true })).raised.no_activity).toBe(1);
      expect(await alerts(r)).toEqual(["no_activity"]);
      expect((await facts(r)).map((f) => f.code)).toEqual(["no_activity"]);
      expect((await sweep({ i2: true })).raised.no_activity).toBe(0);
      expect((await alerts(r)).length).toBe(1);
    });

    it("healthy: a run with an activity row raises nothing", async () => {
      const r = await run(A, { runtime: "runner" });
      await event(A, r, "agent.activity", { tool: "read", path: "a.ts" });
      expect((await sweep({ i2: true })).raised.no_activity).toBe(0);
    });

    it("healthy: a run that is not a runner run (a sandbox run has its own recorder), and one that did not succeed, raise nothing", async () => {
      const sandbox = await run(A, { runtime: "local" });
      const failed = await run(A, { runtime: "runner", status: "failed" });
      expect((await sweep({ i2: true })).raised.no_activity).toBe(0);
      expect([...(await alerts(sandbox)), ...(await alerts(failed))]).toEqual([]);
    });

    it("the rule does not run while the constant is off", async () => {
      const r = await run(A, { runtime: "runner" });
      const out = await sweep({ i2: false });
      expect(out.raised.no_activity).toBeUndefined();
      expect(out.checked).toBe(2);
      expect(await alerts(r)).toEqual([]);
    });
  });

  describe("I3 usage_not_recorded", () => {
    const usageRow = async (acct: SeedRefs, runId: string, tokens: number) => {
      const runner = await insertRunner(admin, acct.accountId, acct.userId);
      await admin.query(
        "INSERT INTO runner_run_usage (account_id, run_id, runner_id, credential_mode, input_tokens, output_tokens) VALUES ($1, $2, $3, 'subscription', $4, 0)",
        [acct.accountId, runId, runner, tokens],
      );
    };

    it("a reported usage event with tokens and no usage row raises one alert and one item fact, once", async () => {
      const r = await run(A, { item: await item(A, "pr_opened"), runtime: "runner" });
      await event(A, r, "runner.event", { type: "usage", usage: { input: 1000, output: 500 } });
      expect((await sweep()).raised.usage_not_recorded).toBe(1);
      expect(await alerts(r)).toEqual(["usage_not_recorded"]);
      expect((await facts(r)).map((f) => f.code)).toEqual(["usage_not_recorded"]);
      expect((await sweep()).raised.usage_not_recorded).toBe(0);
      expect((await alerts(r)).length).toBe(1);
    });

    it("a usage row that holds no tokens counts as not recorded", async () => {
      const r = await run(B, { runtime: "runner" });
      await event(B, r, "runner.event", { type: "usage", usage: { input: 10, output: 5 } });
      await usageRow(B, r, 0);
      expect((await sweep()).raised.usage_not_recorded).toBe(1);
      expect((await admin.query("SELECT account_id FROM platform_invariant_alerts WHERE run_id = $1", [r])).rows[0].account_id).toBe(B.accountId);
    });

    it("healthy: tokens recorded, a zero-token event, and a malformed token value raise nothing", async () => {
      const ok = await run(A, { runtime: "runner" });
      await event(A, ok, "runner.event", { type: "usage", usage: { input: 10, output: 5 } });
      await usageRow(A, ok, 15);
      const zero = await run(A, { runtime: "runner" });
      await event(A, zero, "runner.event", { type: "usage", usage: { input: 0, output: 0 } });
      const odd = await run(A, { runtime: "runner" });
      await event(A, odd, "runner.event", { type: "usage", usage: { input: "many", output: null } });
      const out = await sweep();
      expect(out.raised.usage_not_recorded).toBe(0);
      expect(out.failed).toBe(0);
    });
  });

  it("a run that reaches a terminal status marks the sweep pending (its gate); a move to running does not", async () => {
    const kv = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => kv.get(k), set: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) } });
    try {
      const r = await run(A, { status: "pending" });
      await writeRunStatus(writerPool, { accountId: A.accountId, runId: r, from: "pending", to: "running" });
      expect(kv.has("pending:invariant-sweep")).toBe(false);
      await writeRunStatus(writerPool, { accountId: A.accountId, runId: r, from: "running", to: "succeeded" });
      expect(kv.has("pending:invariant-sweep")).toBe(true);
    } finally {
      setPendingHooks(null);
    }
  });

  it("a whole sweep is at most three queries, and a failing rule does not stop the others", async () => {
    const seen: string[] = [];
    const counting = { query: ((text: string, values?: unknown[]) => (seen.push(text), writerPool.query(text, values))) as Pool["query"] };
    await sweep({ i2: true, pool: counting });
    expect(seen.length).toBe(3);
    const broken = { query: (async (text: string) => { if (text.includes("no_activity")) throw new Error("boom"); return { rows: [] }; }) as unknown as Pool["query"] };
    const out = await sweep({ i2: true, pool: broken });
    expect(out).toMatchObject({ checked: 3, failed: 1 });
    expect(warns.at(-1)).toBe(JSON.stringify({ event: "platform.invariant_failed", invariant: "no_activity" }));
  });

  it.each(INVARIANTS.map((r) => [r.fn]))("%s starts from an index scan on every table it reads (EXPLAIN of its own body)", async (fn) => {
    const src = (await admin.query<{ prosrc: string }>("SELECT prosrc FROM pg_proc WHERE proname = $1", [fn])).rows[0]!.prosrc;
    const body = src.replace(/p_limit/g, "$1").replace(/p_grace_s/g, "$2").replace(/p_window_s/g, "$3");
    await admin.query("BEGIN");
    try {
      // The fixture tables are tiny, so the planner is told not to prefer a sequential scan; what is checked is that an index path EXISTS for each read.
      await admin.query("SET LOCAL enable_seqscan = off");
      await admin.query(`PREPARE inv_plan(int, int, int) AS ${body}`);
      const plan = (await admin.query<Record<string, string>>("EXPLAIN EXECUTE inv_plan(100, 60, 3600)")).rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toMatch(/Index (Only )?Scan using agent_runs_ended_at_recent on agent_runs|Bitmap Index Scan on agent_runs_ended_at_recent/);
      expect(plan).not.toMatch(/Seq Scan on (agent_runs|run_events|work_items|runner_run_usage|platform_invariant_alerts)/);
    } finally {
      await admin.query("ROLLBACK");
      await admin.query("DEALLOCATE ALL");
    }
  });

  it("the alert and the item fact hold no free text: the alert table's only text column is the CHECK-listed rule name", async () => {
    const cols = (await admin.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'platform_invariant_alerts' ORDER BY 1")).rows;
    expect(cols.filter((c) => c.data_type === "text").map((c) => c.column_name)).toEqual(["invariant"]);
    await expect(admin.query("INSERT INTO platform_invariant_alerts (invariant, account_id, run_id) VALUES ('free text', $1, $2)", [A.accountId, A.runId])).rejects.toThrow();
  });
});
