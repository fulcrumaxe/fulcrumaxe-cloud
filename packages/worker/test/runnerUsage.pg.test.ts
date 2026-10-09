import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { insertRunnerEvent } from "@fx/runner";
import { getRun } from "@fx/core/src/runs/read.js";
import { getRunInsight } from "@fx/core/src/runs/insight.js";
import { getWorkItem } from "@fx/core/src/work-items/read.js";
import { getStats } from "@fx/core/src/stats/read.js";
import { computeUsd, getUsage, monthToDateUsd, priceFor, pricingFetchedAt, reserve } from "@fx/spend";
import { resetPlanDataCache } from "@fx/plan-data";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] D#6 R2b-5a (C32 section 5, E1 to E6): the API-equivalent usage of runner runs, against the real definers (0768), the real run-writer
 * login and the real price tables. The figure is information: every test that stores one also shows what it did NOT touch.
 */
describe("runner run usage (API-equivalent figure) [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  const MODEL = "sonnet-5";
  const rate = () => priceFor("claude-code", MODEL)!;
  let A: SeedRefs;
  let runner: string;
  let facade: RunnerClaimFacade;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool, opsPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    runner = await newRunner();
  });

  async function newRunner(mode = "subscription"): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, { credentialMode: mode });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, [A.repoId], ["executor", "code-reviewer"]]);
    return id;
  }
  /** A pending runner run with a real signed job, on `model`, optionally under the account's seeded work item. */
  async function pending(o: { model?: string | null; workItem?: boolean; createdAt?: number } = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "app", private: true },
      role: "executor",
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
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, model, created_at)
       VALUES ($1, $2, $3, 'executor', 'runner', 'pending', 'runner_local', $4, $5::jsonb, $6, $7, to_timestamp($8 / 1000.0))`,
      [id, A.accountId, o.workItem ? A.workItemId : null, A.repoId, JSON.stringify(signJob(job, key)), A.userId, o.model === undefined ? MODEL : o.model, o.createdAt ?? T0 - 5000],
    );
    return id;
  }
  async function claimed(id: string, runnerId = runner): Promise<number> {
    const result = await facade.claimRunnerRun({ accountId: A.accountId, runnerId });
    if (result.kind !== "claimed" || result.runId !== id) throw new Error("not claimed");
    return result.leaseGeneration;
  }
  const usageEvent = (seq: number, usage: object) => ({ seq, ts: "2026-10-10T12:00:00.000Z", type: "usage" as const, usage });
  const send = (id: string, g: number, list: object[], runnerId = runner) => facade.ingestRunnerEvents({ accountId: A.accountId, runnerId, runId: id, leaseGeneration: g, events: list as never });
  const usageRow = async (id: string) => (await admin.query("SELECT * FROM runner_run_usage WHERE run_id = $1", [id])).rows[0];
  const principal = () => ({ accountId: A.accountId, userId: A.userId });

  /** Every table a spend decision reads, as numbers, for the account. */
  async function spendState() {
    const q = async (sql: string) => (await admin.query(sql, [A.accountId])).rows[0];
    return {
      ledger: await q("SELECT count(*)::int AS n, COALESCE(sum(usd), 0)::text AS usd FROM ledger WHERE account_id = $1"),
      reservations: await q("SELECT count(*)::int AS n, COALESCE(sum(usd_reserved), 0)::text AS usd FROM spend_reservations WHERE account_id = $1"),
      runs: await q("SELECT COALESCE(sum(usd), 0)::text AS usd, count(usd)::int AS n_with_usd, COALESCE(sum(tokens_in), 0)::text AS tin, COALESCE(sum(tokens_out), 0)::text AS tout FROM agent_runs WHERE account_id = $1"),
      budgets: (({ own_plan_api_equivalent_usd: _own, ...rest }) => rest)(await getUsage({ pool: appPool, principal: principal() })),
    };
  }

  describe("E1: the cloud recomputes, it never trusts the runner's usd", () => {
    it("stores computeUsd(rate, tokens), not the 99 the runner sent, with the credential mode, model and price table version", async () => {
      const id = await pending();
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 1000, output: 200, cache_read: 5000, cache_write: 300, usd: 99 })]);
      const row = await usageRow(id);
      const expected = computeUsd(rate(), { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 });
      expect(expected).not.toBe(99);
      expect(Number(row.api_equivalent_usd)).toBe(expected);
      expect(row).toMatchObject({ credential_mode: "subscription", model: MODEL, input_tokens: "1000", output_tokens: "200", cache_read_tokens: "5000", cache_write_tokens: "300", price_table_version: pricingFetchedAt(), runner_id: runner });
    });

    it("a runner that sends no usd, or a huge one, gets the same stored figure", async () => {
      const a = await pending({ createdAt: T0 - 9000 });
      const b = await pending({ createdAt: T0 - 8000 });
      const ga = await claimed(a);
      await send(a, ga, [usageEvent(0, { input: 4000, output: 100 })]);
      const gb = await claimed(b);
      await send(b, gb, [usageEvent(0, { input: 4000, output: 100, usd: 1e9 })]);
      expect(Number((await usageRow(a)).api_equivalent_usd)).toBe(Number((await usageRow(b)).api_equivalent_usd));
    });

    it("an api_key runner is stamped api_key, and the stamp is read from the registration at ingest", async () => {
      runner = await newRunner("api_key");
      const id = await pending();
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 10, output: 5 })]);
      expect((await usageRow(id)).credential_mode).toBe("api_key");
    });
  });

  describe("E2: it is never spend", () => {
    it("leaves agent_runs.usd NULL, the ledger, the reservations, the budget figures and a spend refusal exactly as they were", async () => {
      // Real spend on the account first, so "unchanged" is not "all zeros": 4.50 settled against a 5.00 monthly model budget.
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, budget, created_at) VALUES ($1, 'model', 'customer_gateway', 4.5, 'model', now())`, [A.accountId]);
      const refuse = () => reserve(appPool, { accountId: A.accountId, runId: randomUUID(), plan: "starter", estimateModelUsd: 1, monthlyModelBudgetUsd: 5, perSpawnCapUsd: 40 });
      const before = await spendState();
      const refusedBefore = await refuse();
      expect(refusedBefore).toMatchObject({ decision: "deny", reason: "model_budget_exceeded" });
      const mtdBefore = await withTenant(appPool, A.accountId, A.userId, (c) => monthToDateUsd(c, A.accountId, "model"));

      const id = await pending({ workItem: true });
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 9_000_000, output: 2_000_000, cache_read: 40_000_000, cache_write: 1_000_000, usd: 250 })]);
      expect(Number((await usageRow(id)).api_equivalent_usd)).toBeGreaterThan(0);

      expect((await admin.query("SELECT usd, tokens_in, tokens_out FROM agent_runs WHERE id = $1", [id])).rows[0]).toEqual({ usd: null, tokens_in: null, tokens_out: null });
      expect(await spendState()).toEqual(before);
      expect(await withTenant(appPool, A.accountId, A.userId, (c) => monthToDateUsd(c, A.accountId, "model"))).toBe(mtdBefore);
      expect(await refuse()).toEqual(refusedBefore);
    });

    it("no spend, metering or budget query reads the table: the source of every module that sums spend never names it", async () => {
      const { readFileSync } = await import("node:fs");
      for (const file of ["../../spend/src/reserve.ts", "../../spend/src/settle.ts", "../../spend/src/meter.ts", "../../spend/src/caps.ts", "../../spend/src/sandboxUsage.ts", "../../spend/src/gatewayMeter.ts"]) {
        expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/runner_run_usage|own_plan_api_equivalent/);
      }
    });
  });

  describe("E3: replay and sum", () => {
    it("a replayed batch changes nothing; two distinct usage events sum, and the figure is priced on the totals", async () => {
      const id = await pending();
      const g = await claimed(id);
      const first = [usageEvent(0, { input: 1000, output: 200, cache_read: 5000 })];
      expect(await send(id, g, first)).toMatchObject({ outcome: "accepted", stored: 1 });
      const afterFirst = await usageRow(id);
      // The runner resends the same numbers: answered seq_not_increasing, nothing stored.
      expect(await send(id, g, first)).toMatchObject({ outcome: "seq_not_increasing" });
      expect(await usageRow(id)).toEqual(afterFirst);

      expect(await send(id, g, [usageEvent(1, { input: 500, output: 50, cache_write: 7 })])).toMatchObject({ outcome: "accepted", stored: 1 });
      const row = await usageRow(id);
      expect(row).toMatchObject({ input_tokens: "1500", output_tokens: "250", cache_read_tokens: "5000", cache_write_tokens: "7" });
      expect(Number(row.api_equivalent_usd)).toBe(computeUsd(rate(), { inputTokens: 1500, outputTokens: 250, cacheReadTokens: 5000, cacheWriteTokens: 7 }));
    });

    it("an event whose number another writer stored first (a race) is a duplicate or conflict and adds nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      const racing = new Proxy(writerPool, {
        get(target, prop) {
          if (prop !== "connect") {
            const value: unknown = Reflect.get(target, prop);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          }
          return async () => {
            const client = await target.connect();
            const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
            const release = client.release.bind(client);
            (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
              const result = await query(...args);
              if (typeof args[0] === "string" && args[0].includes("max(runner_seq)")) {
                await insertRunnerEvent(client, { accountId: A.accountId, runId: id, runnerSeq: 0, bodySha256: "c".repeat(64), payload: { type: "usage" } });
              }
              return result;
            };
            (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
              (client as unknown as { query: unknown }).query = query;
              (client as unknown as { release: unknown }).release = release;
              return (release as (...a: unknown[]) => void)(...args);
            };
            return client;
          };
        },
      });
      const result = await createRunnerClaimFacade(racing, { visibility: { visibility: async () => "private" }, now: () => T0 }).ingestRunnerEvents({
        accountId: A.accountId,
        runnerId: runner,
        runId: id,
        leaseGeneration: g,
        events: [usageEvent(0, { input: 1000, output: 1000 })] as never,
      });
      expect(result).toMatchObject({ outcome: "accepted", stored: 0, duplicates: 1 });
      expect(await usageRow(id)).toBeUndefined();
    });
  });

  describe("E4: an unpriced model, and row security", () => {
    /** Runs `fn` with plan data as `change` leaves it (the price cache is dropped before and after). */
    async function withPlanData<T>(change: (data: { pricing: { claude: Record<string, unknown> } }) => void, fn: () => Promise<T>): Promise<T> {
      const saved = process.env.FX_PLAN_DATA;
      const data = JSON.parse(saved!) as { pricing: { claude: Record<string, unknown> } };
      change(data);
      process.env.FX_PLAN_DATA = JSON.stringify(data);
      resetPlanDataCache();
      try {
        return await fn();
      } finally {
        process.env.FX_PLAN_DATA = saved;
        resetPlanDataCache();
      }
    }

    it("stores the tokens with a NULL figure and no version for a model with no price row", async () => {
      // agent_runs.model admits three ids, so "no price row" is a price table that lacks one of them.
      const id = await pending({ model: "haiku-4.5" });
      const g = await claimed(id);
      await withPlanData((d) => void delete d.pricing.claude["haiku-4.5"], async () => {
        expect(await send(id, g, [usageEvent(0, { input: 10, output: 20 })])).toMatchObject({ outcome: "accepted", stored: 1 });
      });
      expect(await usageRow(id)).toMatchObject({ model: "haiku-4.5", input_tokens: "10", output_tokens: "20", api_equivalent_usd: null, price_table_version: null });
      // The read model says so: tokens, no figure.
      expect((await getRun({ pool: appPool, principal: principal() }, id)).runner_usage).toMatchObject({ tokens_in: 10, api_equivalent_usd: null });
    });

    it("with no plan data at all the batch is still accepted: tokens stored, no figure", async () => {
      const id = await pending();
      const g = await claimed(id);
      const saved = process.env.FX_PLAN_DATA;
      delete process.env.FX_PLAN_DATA;
      resetPlanDataCache();
      try {
        expect(await send(id, g, [usageEvent(0, { input: 10, output: 20 })])).toMatchObject({ outcome: "accepted", stored: 1 });
      } finally {
        process.env.FX_PLAN_DATA = saved;
        resetPlanDataCache();
      }
      expect(await usageRow(id)).toMatchObject({ input_tokens: "10", api_equivalent_usd: null, price_table_version: null });
    });

    it("a priced total past the column's range keeps the tokens, leaves the figure NULL and does not stall the batch: run_ended commits", async () => {
      const id = await pending();
      const g = await claimed(id);
      const max = { input: 1e12, output: 1e12, cache_read: 1e12, cache_write: 1e12 };
      // The priced total of seven maximum-size events is past 1e8 dollars, which numeric(12,4) cannot hold.
      expect(computeUsd(rate(), { inputTokens: 7e12, outputTokens: 7e12, cacheReadTokens: 7e12, cacheWriteTokens: 7e12 })).toBeGreaterThanOrEqual(1e8);
      expect(computeUsd(rate(), { inputTokens: 6e12, outputTokens: 6e12, cacheReadTokens: 6e12, cacheWriteTokens: 6e12 })).toBeLessThan(1e8);
      const first = await send(id, g, [0, 1, 2, 3, 4, 5].map((seq) => usageEvent(seq, max)));
      expect(first).toMatchObject({ outcome: "accepted", stored: 6, ended: null });
      expect((await usageRow(id)).api_equivalent_usd).not.toBeNull();
      // The seventh event pushes the total over the bound, in the same batch as the run's end.
      const last = await send(id, g, [usageEvent(6, max), { seq: 7, ts: "2026-10-10T12:00:01.000Z", type: "run_ended", reason: "agent_failed" }]);
      expect(last).toMatchObject({ outcome: "accepted", stored: 2 });
      expect(last).toHaveProperty("ended");
      expect((last as { ended: unknown }).ended).not.toBeNull();
      expect(await usageRow(id)).toMatchObject({ input_tokens: "7000000000000", output_tokens: "7000000000000", cache_read_tokens: "7000000000000", cache_write_tokens: "7000000000000", api_equivalent_usd: null, price_table_version: null });
      expect((await admin.query("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1", [id])).rows[0].n).toBeGreaterThanOrEqual(8);
    });

    it("runner_usage_price clears an earlier figure when the total later passes the bound, and accepts NaN and Infinity the same way", async () => {
      const id = await pending();
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 10, output: 20 })]);
      expect((await usageRow(id)).api_equivalent_usd).not.toBeNull();
      for (const usd of ["100000000", "NaN", "Infinity"]) {
        await admin.query("UPDATE runner_run_usage SET api_equivalent_usd = 1, price_table_version = 'v' WHERE run_id = $1", [id]);
        await withTenant(writerPool, A.accountId, A.userId, (c) => c.query("SELECT runner_usage_price($1, $2, $3::numeric, 'v')", [A.accountId, id, usd]));
        expect(await usageRow(id), usd).toMatchObject({ api_equivalent_usd: null, price_table_version: null });
      }
      // Just under the bound still stores.
      await withTenant(writerPool, A.accountId, A.userId, (c) => c.query("SELECT runner_usage_price($1, $2, 99999999.9999::numeric, 'v')", [A.accountId, id]));
      expect(Number((await usageRow(id)).api_equivalent_usd)).toBe(99999999.9999);
    });

    it("a run with no model (a follow-up child) keeps the tokens and a NULL figure", async () => {
      const id = await pending({ model: null });
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 10, output: 20 })]);
      expect(await usageRow(id)).toMatchObject({ model: null, input_tokens: "10", api_equivalent_usd: null });
    });

    it("another account cannot read the row; the owner can; app_user can write nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 10, output: 20 })]);
      const B = await seedAccount(admin, randomUUID());
      const count = async (accountId: string, userId: string) =>
        (await withTenant(appPool, accountId, userId, (c) => c.query("SELECT 1 FROM runner_run_usage WHERE run_id = $1", [id]))).rowCount;
      expect(await count(A.accountId, A.userId)).toBe(1);
      expect(await count(B.accountId, B.userId)).toBe(0);
      for (const sql of ["UPDATE runner_run_usage SET input_tokens = 0", "DELETE FROM runner_run_usage", `INSERT INTO runner_run_usage (account_id, run_id, runner_id, credential_mode) VALUES ('${A.accountId}', '${randomUUID()}', '${runner}', 'subscription')`]) {
        await expect(withTenant(appPool, A.accountId, A.userId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: "42501" });
      }
      expect(Number((await usageRow(id)).input_tokens)).toBe(10);
    });

    it("the definers refuse another tenant, another runner's run, a sandbox run, a platform_ops login and out-of-range numbers", async () => {
      const id = await pending();
      const g = await claimed(id);
      const B = await seedAccount(admin, randomUUID());
      const add = (pool: Pool, tenant: string, account: string, run: string, who: string, n: number | string = 1) =>
        withTenant(pool, tenant, A.userId, (c) => c.query("SELECT * FROM runner_usage_add($1, $2, $3, $4, 0, 0, 0)", [account, run, who, n]));
      // The tenant context must be the account named.
      await expect(add(writerPool, B.accountId, A.accountId, id, runner)).rejects.toMatchObject({ code: "42501" });
      // The run must belong to the runner named.
      await expect(add(writerPool, A.accountId, A.accountId, id, await newRunner())).rejects.toMatchObject({ code: "42501" });
      // A sandbox run, and a run that does not exist.
      await expect(add(writerPool, A.accountId, A.accountId, A.runId, runner)).rejects.toMatchObject({ code: "42501" });
      await expect(add(writerPool, A.accountId, A.accountId, randomUUID(), runner)).rejects.toMatchObject({ code: "42501" });
      // Out of range.
      await expect(add(writerPool, A.accountId, A.accountId, id, runner, -1)).rejects.toMatchObject({ code: "22023" });
      await expect(add(writerPool, A.accountId, A.accountId, id, runner, "1000000000001")).rejects.toMatchObject({ code: "22023" });
      // Nobody but the run-writer login may call them.
      await expect(add(appPool, A.accountId, A.accountId, id, runner)).rejects.toMatchObject({ code: "42501" });
      await expect(add(opsPool, A.accountId, A.accountId, id, runner)).rejects.toMatchObject({ code: "42501" });
      const price = (tenant: string, account: string, usd: number) => withTenant(writerPool, tenant, A.userId, (c) => c.query("SELECT runner_usage_price($1, $2, $3, 'v')", [account, id, usd]));
      await expect(price(B.accountId, A.accountId, 1)).rejects.toMatchObject({ code: "42501" });
      await expect(price(A.accountId, A.accountId, -1)).rejects.toMatchObject({ code: "22023" });
      // No row for the run yet: pricing it is refused, not an insert.
      await expect(price(A.accountId, A.accountId, 1)).rejects.toMatchObject({ code: "42501" });
      expect(await usageRow(id)).toBeUndefined();
      void g;
    });

    it("the row goes with its run", async () => {
      const id = await pending();
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 10, output: 20 })]);
      expect(await usageRow(id)).toBeDefined();
      await admin.query("DELETE FROM run_events WHERE run_id = $1", [id]);
      await admin.query("DELETE FROM agent_runs WHERE id = $1", [id]);
      expect(await usageRow(id)).toBeUndefined();
    });
  });

  describe("E5: the run read model", () => {
    it("a runner run answers runtime runner and runner_usage with its credential mode; a sandbox run has no runner_usage", async () => {
      const id = await pending();
      const g = await claimed(id);
      const empty = await getRun({ pool: appPool, principal: principal() }, id);
      expect(empty).toMatchObject({ runtime: "runner", runner_usage: null });
      await send(id, g, [usageEvent(0, { input: 1000, output: 200, cache_read: 5000 })]);
      const dto = await getRun({ pool: appPool, principal: principal() }, id);
      expect(dto).toMatchObject({
        runtime: "runner",
        usd: null,
        tokens_in: null,
        runner_usage: { credential_mode: "subscription", model: MODEL, tokens_in: 1000, tokens_out: 200, cache_read_tokens: 5000, cache_write_tokens: 0, price_table_version: pricingFetchedAt() },
      });
      expect(dto.runner_usage?.api_equivalent_usd).toBe(computeUsd(rate(), { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 }));

      const sandbox = await getRun({ pool: appPool, principal: principal() }, A.runId);
      expect(sandbox.runtime).not.toBe("runner");
      expect("runner_usage" in sandbox).toBe(false);
    });

    it("the insight carries the same object beside an unchanged cost block, and none for a sandbox run", async () => {
      const id = await pending();
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 1000, output: 200 })]);
      const insight = await getRunInsight({ pool: appPool, principal: principal() }, id);
      expect(insight.runner_usage).toMatchObject({ credential_mode: "subscription", tokens_in: 1000, tokens_out: 200 });
      expect(insight.cost).toEqual({ model: { usd: null, source: null, tokens_in: null, tokens_out: null }, compute: { usd: null, source: null } });
      const sandbox = await getRunInsight({ pool: appPool, principal: principal() }, A.runId);
      expect("runner_usage" in sandbox).toBe(false);
    });
  });

  describe("E6: the aggregates carry it apart and their spend fields do not move", () => {
    async function fixture() {
      // One sandbox run with real spend under the work item, then one runner run under the same item with a large figure.
      await admin.query("UPDATE agent_runs SET usd = 2.5, tokens_in = 100, tokens_out = 50 WHERE id = $1", [A.runId]);
      await admin.query(`UPDATE ledger SET usd = 2.5 WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [A.accountId, A.runId]);
    }
    const reads = async () => {
      const item = await getWorkItem({ pool: appPool, principal: principal() }, A.workItemId);
      const usage = await getUsage({ pool: appPool, principal: principal() });
      const now = new Date();
      const stats = await getStats({ pool: appPool, principal: principal() }, { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 86_400_000), repoId: null, now });
      const repoStats = await getStats({ pool: appPool, principal: principal() }, { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 86_400_000), repoId: A.repoId, now });
      return { item, usage, stats, repoStats };
    };

    it("work item, month and window figures: own_plan_api_equivalent_usd is separate, every existing spend field is identical", async () => {
      await fixture();
      const before = await reads();
      expect(before.item.own_plan_api_equivalent_usd).toBe(0);
      expect(before.usage.own_plan_api_equivalent_usd).toBe(0);
      expect(before.stats.runner_api_equivalent_usd).toBe(0);
      expect(before.repoStats.runner_api_equivalent_usd).toBe(0);

      const id = await pending({ workItem: true });
      const g = await claimed(id);
      await send(id, g, [usageEvent(0, { input: 3_000_000, output: 1_000_000, cache_read: 10_000_000, usd: 77 })]);
      const figure = computeUsd(rate(), { inputTokens: 3_000_000, outputTokens: 1_000_000, cacheReadTokens: 10_000_000 });
      expect(figure).toBeGreaterThan(0);

      const after = await reads();
      // The separate figure appears on the work item, the month and the stats window (all repos, and the run's own repo), outside `metrics`.
      expect(after.item.own_plan_api_equivalent_usd).toBe(figure);
      expect(after.usage.own_plan_api_equivalent_usd).toBe(figure);
      expect(after.stats.runner_api_equivalent_usd).toBe(figure);
      expect(after.repoStats.runner_api_equivalent_usd).toBe(figure);
      expect("runner_api_equivalent_usd" in after.stats.metrics).toBe(false);
      // A window that does not hold the run, another repo and another account see none of it.
      const at = new Date();
      const stats = (ctx: { accountId: string; userId: string }, from: Date, to: Date, repoId: string | null) => getStats({ pool: appPool, principal: ctx }, { from, to, repoId, now: at });
      expect((await stats(principal(), new Date(at.getTime() - 3 * 86_400_000), new Date(at.getTime() - 2 * 86_400_000), null)).runner_api_equivalent_usd).toBe(0);
      expect((await stats(principal(), new Date(at.getTime() - 86_400_000), new Date(at.getTime() + 86_400_000), randomUUID())).runner_api_equivalent_usd).toBe(0);
      const other = await seedAccount(admin, randomUUID());
      expect((await stats({ accountId: other.accountId, userId: other.userId }, new Date(at.getTime() - 86_400_000), new Date(at.getTime() + 86_400_000), null)).runner_api_equivalent_usd).toBe(0);
      // ... and nothing else moved: every existing spend field is deep-equal to what it was.
      const apart = <T extends { own_plan_api_equivalent_usd: number }>(v: T): Omit<T, "own_plan_api_equivalent_usd"> => ({ ...v, own_plan_api_equivalent_usd: undefined }) as never;
      const [itemBefore, itemAfter] = [apart(before.item), apart(after.item)];
      expect(JSON.parse(JSON.stringify(itemAfter))).toEqual(JSON.parse(JSON.stringify(itemBefore)));
      expect(itemAfter.cost_usd).toBe(2.5);
      const [usageBefore, usageAfter] = [apart(before.usage), apart(after.usage)];
      expect(JSON.parse(JSON.stringify(usageAfter))).toEqual(JSON.parse(JSON.stringify(usageBefore)));
      expect(usageAfter.model.spent_usd).toBeGreaterThan(0);
      expect(after.stats.metrics).toEqual(before.stats.metrics);
      expect(after.repoStats.metrics).toEqual(before.repoStats.metrics);
    });

    it("another account sees none of it, and an unpriced run adds tokens but no figure to the month", async () => {
      const id = await pending({ workItem: true, model: "haiku-4.5" });
      const g = await claimed(id);
      const saved = process.env.FX_PLAN_DATA;
      const data = JSON.parse(saved!) as { pricing: { claude: Record<string, unknown> } };
      delete data.pricing.claude["haiku-4.5"];
      process.env.FX_PLAN_DATA = JSON.stringify(data);
      resetPlanDataCache();
      try {
        await send(id, g, [usageEvent(0, { input: 1000, output: 1000 })]);
      } finally {
        process.env.FX_PLAN_DATA = saved;
        resetPlanDataCache();
      }
      expect((await getUsage({ pool: appPool, principal: principal() })).own_plan_api_equivalent_usd).toBe(0);
      expect((await getWorkItem({ pool: appPool, principal: principal() }, A.workItemId)).own_plan_api_equivalent_usd).toBe(0);
      const priced = await pending({ workItem: true });
      const g2 = await claimed(priced);
      await send(priced, g2, [usageEvent(0, { input: 1_000_000, output: 0 })]);
      const want = computeUsd(rate(), { inputTokens: 1_000_000, outputTokens: 0 });
      expect((await getUsage({ pool: appPool, principal: principal() })).own_plan_api_equivalent_usd).toBe(want);
      const B = await seedAccount(admin, randomUUID());
      expect((await getUsage({ pool: appPool, principal: { accountId: B.accountId, userId: B.userId } })).own_plan_api_equivalent_usd).toBe(0);
    });
  });
});
