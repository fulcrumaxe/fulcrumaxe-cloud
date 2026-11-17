import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { handleApiRequest } from "@fx/api/src/handler.js";
import { ROUTES } from "@fx/api/src/routes/index.js";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session.js";
import { getStats } from "@fx/core/src/stats/read.js";
import { getUsage } from "@fx/spend";
import { ENGINE_EVENTS_PATH, ingestEngineEvents, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { newKey, registerKey, signed } from "../../runner-cloud/test/helpers.js";
import { recordEngineUsage } from "../src/engineUsage.js";
import { priceUsageTotals } from "../src/runnerUsage.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GH = 5160;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any; // a decoded response body: its shape is what each test asserts

interface Prov { kinds: string[]; count: number; seqs: { session_id: string; seq: number }[] }

/**
 * [pg] Engine bridge EB-5.11 and EB-5.12: the golden fixture through the real ingest, then the real read routes. The four dollar figures agree, a runner
 * run built from the same tokens prices the same, and every stats figure's provenance resolves to stored events of the named kinds whose recount gives the figure.
 */
describe("engine read routes: parity and provenance [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let A: SeedRefs;
  const key = newKey();
  const fixture = readFileSync(path.join(DIR, "fixtures", "engine-usage-golden.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { seq: number; engine_instance_id: string });

  const get = async (p: string) => {
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: A.accountId, userId: A.userId })}`, accept: "application/json" };
    const res = await handleApiRequest(new Request(`http://localhost/api/v1${p}`, { headers }), appPool, opsPool, ROUTES);
    expect(res.status, p).toBe(200);
    return (await res.json()) as Json;
  };

  beforeAll(async () => {
    process.env.FX_SESSION_SECRET = "s".repeat(32);
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    A = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE accounts SET plan = 'team' WHERE id = $1`, [A.accountId]);
    const runnerId = await registerKey(admin, A.accountId, A.userId, key);
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = $2 WHERE id = $1`, [A.repoId, GH]);
    await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [runnerId, A.repoId]);
    await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [A.accountId]);
    await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
    const deps: RunnerCloudDeps = { appUserPool: appPool, origin: "https://runner.example.test", failRunnerLeases: null, engineUsage: { record: recordEngineUsage } };
    const req = signed(key, ENGINE_EVENTS_PATH, { session: { engine_instance_id: fixture[0]!.engine_instance_id, repo_gh_id: GH, engine_version: "1.0.0" }, events: fixture });
    expect(((await toResponse(() => ingestEngineEvents(deps, req))) as { status: number }).status).toBe(200);
    // Merges and gate receipts too, with the same label applied twice (one receipt) and a skipped gate (left out of the rate).
    const inst = fixture[0]!.engine_instance_id;
    const at = (i: number) => ({ v: 1, seq: fixture.length + i, ts: "2026-11-16T11:00:00.000Z", engine_instance_id: inst });
    const sha = (c: string) => c.repeat(40);
    const more = [
      { ...at(0), kind: "merged", pr: 1, closes: false },
      { ...at(1), kind: "merged", pr: 2, closes: true },
      { ...at(2), kind: "gate_receipt", pr: 1, gate: "gate1", result: "pass", head_sha: sha("a") },
      { ...at(3), kind: "gate_receipt", pr: 1, gate: "gate1", result: "pass", head_sha: sha("a") },
      { ...at(4), kind: "gate_receipt", pr: 1, gate: "code_review", result: "fail", head_sha: sha("b") },
      { ...at(5), kind: "gate_receipt", pr: 2, gate: "gate1", result: "skipped", head_sha: sha("c") },
    ];
    const req2 = signed(key, ENGINE_EVENTS_PATH, { session: { engine_instance_id: inst, repo_gh_id: GH, engine_version: "1.0.0" }, events: more });
    expect(((await toResponse(() => ingestEngineEvents(deps, req2))) as { status: number }).status).toBe(200);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  it("the usage route's total, the month figure, the window figure and the sum of the per-agent figures are equal", async () => {
    const from = "2026-11-16T00:00:00.000Z";
    const usage = await get(`/engine/repos/${A.repoId}/usage?from=${encodeURIComponent(from)}`);
    const perAgent = Math.round(usage.items.reduce((n: number, r: { api_equivalent_usd: number | null }) => n + (r.api_equivalent_usd ?? 0), 0) * 1e4) / 1e4;
    const ctx = { pool: appPool, principal: { accountId: A.accountId, userId: A.userId, role: "owner" } } as never;
    const month = (await getUsage(ctx)).engine_api_equivalent_usd;
    const win = (await getStats(ctx, { from: new Date(from), to: new Date(Date.now() + 3600_000), repoId: A.repoId })).engine_api_equivalent_usd;
    expect(usage.totals.api_equivalent_usd).toBe(0.4416);
    expect([month, win, perAgent]).toEqual([0.4416, 0.4416, 0.4416]);
    expect(usage.items.find((r: { subject_id: string }) => r.subject_id === "a-none")).toMatchObject({ api_equivalent_usd: null, state: "not_recorded" });
    expect(usage.items.find((r: { subject_id: string }) => r.subject_id === "a-myst")).toMatchObject({ api_equivalent_usd: null, state: "not_priced" });
    expect(usage.totals.tokens).toEqual({ input: 34200, output: 6770, cache_read: 105007, cache_write: 6300 });
  });

  it("a runner run built from the same tokens and model has the same figure as the engine row", async () => {
    const { rows } = await admin.query(`SELECT model, input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text, api_equivalent_usd::text AS usd FROM engine_agent_usage WHERE account_id = $1 AND subject_id = 'a-opus1'`, [A.accountId]);
    const priced = priceUsageTotals(rows[0])!;
    expect(Math.round(priced.usd * 1e4) / 1e4).toBe(Number(rows[0].usd));
  });

  it("every stats figure's provenance resolves to stored events of the named kinds, and recounting them reproduces the figure", async () => {
    const stats = await get(`/engine/repos/${A.repoId}/stats?from=${encodeURIComponent(new Date("2026-11-16T00:00:00Z").toISOString())}`);
    expect(stats.agents_by_role.value).toEqual({ executor: 3, "code-reviewer": 2, "security-reviewer": 1 });
    expect(stats.duration_s).toMatchObject({ n: 6, median: 75, p90: 210 });
    expect(stats.merges.value).toBe(2);
    expect(stats.gate_pass_rate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(stats.gate_pass_rate.provenance.count).toBe(3);
    const resolve = async (p: Prov) => {
      expect(p.seqs.length).toBe(Math.min(200, p.count));
      const { rows } = await admin.query(`SELECT session_id, seq::int AS seq, kind, body FROM engine_events WHERE account_id = $1 AND (session_id, seq) IN (${p.seqs.map((_, i) => `($${i * 2 + 2}::uuid, $${i * 2 + 3}::bigint)`).join(",") || "(NULL, NULL)"})`, [A.accountId, ...p.seqs.flatMap((s) => [s.session_id, s.seq])]);
      expect(rows).toHaveLength(p.seqs.length);
      for (const r of rows) expect(p.kinds, `${r.kind}`).toContain(r.kind);
      return rows as { kind: string; body: Record<string, unknown> }[];
    };
    const roles = await resolve(stats.agents_by_role.provenance);
    const byRole: Record<string, number> = {};
    for (const r of roles) byRole[String(r.body.role)] = (byRole[String(r.body.role)] ?? 0) + 1;
    expect(byRole).toEqual(stats.agents_by_role.value);
    const durations = (await resolve(stats.duration_s.provenance)).map((r) => Number(r.body.duration_s)).sort((a, b) => a - b);
    expect(durations).toHaveLength(stats.duration_s.n);
    expect(durations[Math.floor(durations.length / 2) - 1]! + 0).toBeLessThanOrEqual(stats.duration_s.p90);
    const merged = await resolve(stats.merges.provenance);
    expect(merged.length).toBe(stats.merges.value);
    const gates = await resolve(stats.gate_pass_rate.provenance);
    const counted = gates.filter((g) => g.body.result !== "skipped");
    expect([gates.filter((g) => g.body.result === "pass").length, counted.length]).toEqual([stats.gate_pass_rate.numerator, stats.gate_pass_rate.denominator]);
    if (stats.gate_pass_rate.denominator > 0) expect(stats.gate_pass_rate.value).toBe(Math.round((stats.gate_pass_rate.numerator / stats.gate_pass_rate.denominator) * 1e4) / 1e4);
  });
});
