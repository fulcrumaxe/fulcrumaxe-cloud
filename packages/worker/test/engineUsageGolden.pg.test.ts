import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { readEngineAgentStats, readEngineUsage } from "@fx/core/src/engine/read.js";
import { RUNNER_USAGE_NOTE } from "@fx/core/src/runs/runnerUsage.js";
import { computeUsd, priceFor, pricingFetchedAt } from "@fx/spend";
import { ENGINE_EVENTS_PATH, ingestEngineEvents, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { newKey, registerKey, signed } from "../../runner-cloud/test/helpers.js";
import { recordEngineUsage } from "../src/engineUsage.js";
import { priceUsageTotals } from "../src/runnerUsage.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://runner.example.test";
const GH = 5150;

/**
 * [pg] Engine bridge EB-4.9 / EB-4.10: the golden fixture `fixtures/engine-usage-golden.jsonl` (6 agents, 3 models: one unpriced, one that reported no usage,
 * one on an API key, the rest on the plan), ingested through the real route, the real definer and the real price tables. The PINS below are literals computed
 * once from the price tables in the test plan data; a pricing change must update them on purpose.
 */
const PINS = {
  usd: { "a-opus1": 0.0158, "a-son1": 0.011, "a-son2": 0.0077, "a-myst": null, "a-none": null, "a-apik": 0.4071 } as Record<string, number | null>,
  state: { "a-opus1": "recorded", "a-son1": "recorded", "a-son2": "recorded", "a-myst": "not_priced", "a-none": "not_recorded", "a-apik": "recorded" } as Record<string, string>,
  tokens: { input: 34200, output: 6770, cache_read: 105007, cache_write: 6300 },
  byRole: { executor: 3, "code-reviewer": 2, "security-reviewer": 1 },
  duration: { n: 6, median: 75, p90: 210 },
  total: 0.4416,
};

describe("engine usage golden fixture [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;
  let repo: string;
  let runnerId: string;
  let deps: RunnerCloudDeps;
  const key = newKey();
  const fixture = readFileSync(path.join(DIR, "fixtures", "engine-usage-golden.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { seq: number; engine_instance_id: string });

  const send = async (events: object[]) => {
    const req = signed(key, ENGINE_EVENTS_PATH, { session: { engine_instance_id: fixture[0]!.engine_instance_id, repo_gh_id: GH, engine_version: "1.0.0" }, events });
    return (await toResponse(() => ingestEngineEvents(deps, req))) as { status: number; body: Record<string, unknown> };
  };
  const window = () => ({ from: new Date('2026-11-16T00:00:00Z'), to: new Date(Date.now() + 3_600_000), repoId: repo });
  const read = () => withTenant(appPool, A.accountId, A.userId, async (c) => ({ usage: await readEngineUsage(c, window()), stats: await readEngineAgentStats(c, window()) }));
  const tokens = async () => (await admin.query(`SELECT COALESCE(sum(input_tokens),0)::int AS i FROM engine_agent_usage WHERE account_id = $1`, [A.accountId])).rows[0].i as number;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    repo = A.repoId;
    runnerId = await registerKey(admin, A.accountId, A.userId, key);
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = $2 WHERE id = $1`, [A.repoId, GH]);
    await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [runnerId, A.repoId]);
    await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [A.accountId]);
    await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
    deps = { appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, engineUsage: { record: recordEngineUsage } };
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  it("ingests the fixture and answers the pinned figures, states, tokens, role counts and duration percentiles", async () => {
    expect((await send(fixture)).status).toBe(200);
    const { usage, stats } = await read();
    const byAgent = Object.fromEntries(usage.rows.map((r) => [r.subject_id, r]));
    expect(Object.keys(byAgent).sort()).toEqual(Object.keys(PINS.usd).sort());
    for (const [id, usd] of Object.entries(PINS.usd)) {
      expect(byAgent[id]!.api_equivalent_usd, id).toBe(usd);
      expect(byAgent[id]!.state, id).toBe(PINS.state[id]);
      expect(byAgent[id]!.note, id).toBe(usd === null ? RUNNER_USAGE_NOTE[PINS.state[id] as "not_priced" | "not_recorded"] : null);
    }
    expect(byAgent["a-apik"]!.credential_mode).toBe("api_key");
    expect(byAgent["a-none"]!.tokens).toBeNull();
    const sum = (k: "input" | "output" | "cache_read" | "cache_write") => usage.rows.reduce((n, r) => n + (r.tokens?.[k] ?? 0), 0);
    expect({ input: sum("input"), output: sum("output"), cache_read: sum("cache_read"), cache_write: sum("cache_write") }).toEqual(PINS.tokens);
    expect(usage.total_api_equivalent_usd).toBe(PINS.total);
    expect(stats.agents_by_role).toEqual(PINS.byRole);
    expect(stats.duration_s).toEqual(PINS.duration);
  });

  it("each figure is exactly what the cloud's own price step gives for the stored totals (never a figure the engine sent)", async () => {
    const { rows } = await admin.query(`SELECT subject_id, model, input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text, api_equivalent_usd::text AS usd, price_table_version FROM engine_agent_usage WHERE account_id = $1 AND model IN ('opus-5','sonnet-5')`, [A.accountId]);
    expect(rows.length).toBe(4);
    for (const r of rows) {
      const priced = priceUsageTotals({ model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens })!;
      expect(Number(r.usd)).toBe(Math.round(priced.usd * 1e4) / 1e4);
      expect(Number(r.usd)).toBe(Math.round(computeUsd(priceFor("claude-code", r.model)!, { inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), cacheReadTokens: Number(r.cache_read_tokens), cacheWriteTokens: Number(r.cache_write_tokens) }) * 1e4) / 1e4);
      expect(r.price_table_version).toBe(pricingFetchedAt());
    }
  });

  it("a replayed batch adds no tokens and no figure, exactly as the run path behaves", async () => {
    const before = await tokens();
    const first = await read();
    expect((await send(fixture)).status).toBe(409);
    expect((await send(fixture.slice(6))).status).toBe(409);
    expect(await tokens()).toBe(before);
    expect(await read()).toEqual(first);
  });
});
