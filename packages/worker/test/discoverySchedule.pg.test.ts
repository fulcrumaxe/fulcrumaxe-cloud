import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { queueDiscoveries } from "@fx/db/src/discoveryRuns.js";
import { queueAnalysis } from "@fx/db/src/discoveryAnalyses.js";
import { runQueuedDiscoveries } from "@fx/core/src/discovery/run.js";
import type { AnalysisSettings } from "@fx/plan-data";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createDiscoverySchedule, type DiscoveryScheduleCounts } from "../src/discoverySchedule.js";
import { seedPreviewTarget } from "./support/previewTarget.js";

/** D#483 S5-g2 [pg]: the daily sweep over the real lister (0952), queues and drain; the source answers the head, no model. The database is shared, so the list is narrowed to this file's repositories. */
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ON: AnalysisSettings = { on: true, perRepoDailyUsd: 5.3, analysisPerRunUsd: 1.3 };
type Due = Array<{ account_id: string; repo_id: string; period_ref: string }>;

describe("the daily re-discovery sweep [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let sweep: () => Promise<DiscoveryScheduleCounts>;
  let head = SHA_A;
  let settings: AnalysisSettings = ON;
  const mine = new Set<string>();

  const source = () => ({ head: async () => ({ defaultBranch: "main", sha: head }), file: async () => null, recentOpen: async () => ({ items: [] }) });
  const listDue = async (): Promise<Due> => (await writerPool.query<Due[number]>("SELECT * FROM discovery_sweep_list_due(500)")).rows.filter((r) => mine.has(r.repo_id));
  const runs = async (repoId: string) => (await admin.query<{ trigger: string; trigger_ref: string; state: string; skip_reason: string | null }>("SELECT trigger, trigger_ref, state, skip_reason FROM discovery_runs WHERE repo_id = $1 AND trigger = 'sweep'", [repoId])).rows;
  const analyses = async (repoId: string) => (await admin.query<{ head_sha: string }>("SELECT head_sha FROM discovery_analyses WHERE repo_id = $1 ORDER BY created_at", [repoId])).rows.map((r) => r.head_sha);
  const count = async (table: string, accountId: string): Promise<number> => Number((await admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    sweep = createDiscoverySchedule({ pool: writerPool, openSource: source, settings: () => settings, list: listDue });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  afterEach(() => {
    head = SHA_A;
    settings = ON;
  });

  async function fixture(): Promise<{ a: SeedRefs; repoId: string }> {
    // The list is ordered by account and the database is shared: ids that sort first keep these accounts inside the page.
    const a = await seedAccount(admin, `00000000-${randomUUID().slice(9)}`);
    const repoId = (await seedPreviewTarget(admin, a)).repoId;
    mine.add(repoId);
    return { a, repoId };
  }

  it("S5g-1: two sweeps in one day queue each due repository once (one run, one analysis); a replayed period (a race) queues nothing twice", async () => {
    const { a, repoId } = await fixture();
    const ref = (await listDue()).find((r) => r.repo_id === repoId)!.period_ref;
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 1, unchanged: 0, errors: 0 });
    expect(await sweep()).toMatchObject({ listed: 0, queued: 0, analyses: 0 });
    const replay = createDiscoverySchedule({ pool: writerPool, openSource: source, settings: () => settings, list: async () => [{ account_id: a.accountId, repo_id: repoId, period_ref: ref }] });
    expect(await replay()).toMatchObject({ listed: 1, queued: 0, analyses: 0, unchanged: 1 });
    expect((await runs(repoId)).map((r) => [r.trigger, r.trigger_ref, r.state])).toEqual([["sweep", ref, "queued"]]);
    expect(await analyses(repoId)).toEqual([SHA_A]);
  });

  it("A-S4-1: an install queues a discovery and no analysis; the first analysis comes with the first sweep", async () => {
    const { a, repoId } = await fixture();
    await queueDiscoveries(writerPool, a.accountId, { kind: "account" }, "installation_created", `installation:${randomUUID()}`);
    expect(await analyses(repoId)).toEqual([]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 1, unchanged: 0, errors: 0 });
    expect(await analyses(repoId)).toEqual([SHA_A]);
  });

  it("S5g-3: an unchanged default branch queues no analysis and starts no agent run; a moved head, in a later period, queues exactly one", async () => {
    const { a, repoId } = await fixture();
    const runsBefore = await count("agent_runs", a.accountId);
    const q = await queueAnalysis(writerPool, a.accountId, repoId, SHA_A);
    await admin.query("UPDATE discovery_analyses SET state = 'skipped', skip_reason = 'head_moved', finished_at = now() WHERE id = $1", [q!.id]);
    expect(await sweep()).toMatchObject({ queued: 1, analyses: 0, unchanged: 1 });
    expect(await analyses(repoId)).toEqual([SHA_A]);
    await admin.query("DELETE FROM discovery_runs WHERE repo_id = $1 AND trigger = 'sweep'", [repoId]); // the last period's run is gone, as it is once the day turns
    head = SHA_B;
    expect(await sweep()).toMatchObject({ queued: 1, analyses: 1 });
    expect(await analyses(repoId)).toEqual([SHA_A, SHA_B]);
    expect(await count("agent_runs", a.accountId)).toBe(runsBefore);
  });

  it("S5g-2: discovery off is recorded `discovery_off` by the drain with no analysis; a disconnected repository is not listed", async () => {
    const off = await fixture();
    await admin.query("INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', 1, $3)", [off.a.accountId, off.repoId, off.a.userId]);
    const gone = await fixture();
    await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [gone.repoId]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 0, not_analysed: 1 });
    expect(await runQueuedDiscoveries({ pool: writerPool, accountId: off.a.accountId, openSource: source })).toEqual([{ state: "skipped", reason: "discovery_off" }]);
    expect((await runs(off.repoId)).map((r) => [r.state, r.skip_reason])).toEqual([["skipped", "discovery_off"]]);
    expect([await analyses(off.repoId), await runs(gone.repoId)]).toEqual([[], []]);
  });

  it("S5g-2: analysis off (unconfigured) still queues the run and no analysis", async () => {
    const unconfigured = await fixture();
    settings = { on: false, code: "analysis_unconfigured" };
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 0, not_analysed: 1 });
    expect((await runs(unconfigured.repoId)).map((r) => [r.trigger, r.state])).toEqual([["sweep", "queued"]]);
    expect(await analyses(unconfigured.repoId)).toEqual([]);
  });

  it("S4-f4: a Cloud-verified repository is analysed like a sandbox one (a run queued and an analysis for the head); a Local-only one is not (not_analysed)", async () => {
    const verified = await fixture();
    await admin.query("UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1", [verified.repoId]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 1, not_analysed: 0, errors: 0 });
    expect(await analyses(verified.repoId)).toEqual([SHA_A]);
    const local = await fixture();
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [local.repoId]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 0, not_analysed: 1, errors: 0 });
    expect(await analyses(local.repoId)).toEqual([]);
  });

  it("S5g-2: a Local-only repository still gets its sweep run queued and no analysis (a sandbox or Cloud-verified repository is analysed)", async () => {
    const runner = await fixture();
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [runner.repoId]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 0, not_analysed: 1, errors: 0 });
    expect((await runs(runner.repoId)).map((r) => [r.trigger, r.state])).toEqual([["sweep", "queued"]]);
    expect(await analyses(runner.repoId)).toEqual([]);
  });

  it("S5g-2: an account that is not active (unsubscribed) still gets its sweep run queued and no analysis", async () => {
    const lapsed = await fixture();
    await admin.query("UPDATE accounts SET stripe_customer_id = NULL, status = 'unsubscribed' WHERE id = $1", [lapsed.a.accountId]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 0, not_analysed: 1, errors: 0 });
    expect((await runs(lapsed.repoId)).map((r) => [r.trigger, r.state])).toEqual([["sweep", "queued"]]);
    expect(await analyses(lapsed.repoId)).toEqual([]);
  });

  it("S5g-2: the sweep is not a trigger a caller can queue through queueDiscoveries (only the schedule's own writer queues it)", async () => {
    const { a, repoId } = await fixture();
    await expect(queueDiscoveries(writerPool, a.accountId, { kind: "account" }, "sweep", "2026-11-01")).rejects.toThrow("discovery: unknown trigger");
    expect(await runs(repoId)).toEqual([]);
  });

  it("the period names are cut in the database, in UTC: weekly is an ISO week, daily a date, and no session time zone changes either", async () => {
    const weekly = await fixture();
    await admin.query("INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'weekly', 1, $3)", [weekly.a.accountId, weekly.repoId, weekly.a.userId]);
    const daily = await fixture();
    const refsIn = async (zone: string): Promise<Record<string, string>> => {
      const c = await writerPool.connect();
      try {
        await c.query(`SET timezone = '${zone}'`);
        const { rows } = await c.query<Due[number]>("SELECT * FROM discovery_sweep_list_due(500)");
        return Object.fromEntries(rows.filter((r) => mine.has(r.repo_id)).map((r) => [r.repo_id, r.period_ref]));
      } finally {
        c.release();
      }
    };
    const east = await refsIn("Pacific/Kiritimati");
    expect(east).toEqual(await refsIn("Etc/GMT+12"));
    expect(east[weekly.repoId]).toMatch(/^\d{4}-W\d{2}$/);
    expect(east[daily.repoId]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("R-597-1: a sweep creates no work item, action request or start, and a pass that finds the lock held does nothing", async () => {
    const { a } = await fixture();
    const tables = ["work_items", "run_action_requests", "agent_runs"];
    const before = await Promise.all(tables.map((t) => count(t, a.accountId)));
    await sweep();
    expect(await Promise.all(tables.map((t) => count(t, a.accountId)))).toEqual(before);
    await admin.query("BEGIN");
    await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('fx:discovery_schedule', 0))");
    try {
      expect(await sweep()).toMatchObject({ idle: "busy", listed: 0, queued: 0 });
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});
