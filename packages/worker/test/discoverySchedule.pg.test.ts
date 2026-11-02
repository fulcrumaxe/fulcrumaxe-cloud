import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { queueDiscoveries } from "@fx/db/src/discoveryRuns.js";
import { queueAnalysis } from "@fx/db/src/discoveryAnalyses.js";
import { runQueuedDiscoveries } from "@fx/core/src/discovery/run.js";
import type { AnalysisSettings } from "@fx/plan-data";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createDiscoverySchedule, passStart, SCHEDULE_PASS_BUDGET_MS, type DiscoveryScheduleCounts, type SweepCursor } from "../src/discoverySchedule.js";
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
  /** One page of the real lister strictly after the cursor, narrowed to this file's repositories (pages are read until one of them turns up, so the shared database's others never end a pass early). */
  const listPage = async (after: SweepCursor | null, limit = 500): Promise<Due> => {
    let cur = after;
    for (;;) {
      const { rows } = await writerPool.query<Due[number]>("SELECT * FROM discovery_sweep_list_due($1, $2, $3)", [limit, cur?.accountId ?? null, cur?.repoId ?? null]);
      const own = rows.filter((r) => mine.has(r.repo_id));
      if (own.length > 0 || rows.length < limit) return own;
      cur = { accountId: rows[rows.length - 1]!.account_id, repoId: rows[rows.length - 1]!.repo_id };
    }
  };
  const listDue = async (): Promise<Due> => {
    const all: Due = [];
    for (let page = await listPage(null); page.length > 0; page = await listPage({ accountId: page[page.length - 1]!.account_id, repoId: page[page.length - 1]!.repo_id })) all.push(...page);
    return all;
  };
  const runs = async (repoId: string) => (await admin.query<{ trigger: string; trigger_ref: string; state: string; skip_reason: string | null }>("SELECT trigger, trigger_ref, state, skip_reason FROM discovery_runs WHERE repo_id = $1 AND trigger = 'sweep'", [repoId])).rows;
  const analyses = async (repoId: string) => (await admin.query<{ head_sha: string }>("SELECT head_sha FROM discovery_analyses WHERE repo_id = $1 ORDER BY created_at", [repoId])).rows.map((r) => r.head_sha);
  const count = async (table: string, accountId: string): Promise<number> => Number((await admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    sweep = createDiscoverySchedule({ pool: writerPool, openSource: source, settings: () => settings, list: listPage });
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
    // The list is ordered by repo id and the database is shared: a test reads every page (listPage narrows to this file's repositories).
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
    const replay = createDiscoverySchedule({ pool: writerPool, openSource: source, settings: () => settings, list: async (after) => (after === null || after.repoId < repoId ? [{ account_id: a.accountId, repo_id: repoId, period_ref: ref }] : []) });
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

  it("C26-g2f-1: a repository whose newest setting is off is neither listed nor queued (the drain still records discovery_off for a run another trigger queued); turned back on, it is listed the same UTC day", async () => {
    const off = await fixture();
    await admin.query("INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', 1, $3)", [off.a.accountId, off.repoId, off.a.userId]);
    const gone = await fixture();
    await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [gone.repoId]);
    expect(await sweep()).toEqual({ listed: 0, queued: 0, analyses: 0, unchanged: 0, not_analysed: 0, errors: 0, more: false });
    expect([await runs(off.repoId), await runs(gone.repoId), await analyses(off.repoId)]).toEqual([[], [], []]);
    await queueDiscoveries(writerPool, off.a.accountId, { kind: "account" }, "repos_added", `repos:${randomUUID()}`);
    expect(await runQueuedDiscoveries({ pool: writerPool, accountId: off.a.accountId, openSource: source })).toContainEqual({ state: "skipped", reason: "discovery_off" });
    await admin.query("INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'daily', 2, $3)", [off.a.accountId, off.repoId, off.a.userId]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 1, errors: 0 });
    expect((await runs(off.repoId)).map((r) => [r.trigger, r.state])).toEqual([["sweep", "queued"]]);
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

  it("C26-g2f-2: an account that is not active has no repository listed or queued; once it is active again its repository is listed", async () => {
    const lapsed = await fixture();
    await admin.query("UPDATE accounts SET stripe_customer_id = NULL, status = 'unsubscribed' WHERE id = $1", [lapsed.a.accountId]);
    expect(await sweep()).toMatchObject({ listed: 0, queued: 0, analyses: 0, errors: 0 });
    expect([await runs(lapsed.repoId), await analyses(lapsed.repoId)]).toEqual([[], []]);
    await admin.query("UPDATE accounts SET stripe_customer_id = $2, status = 'active' WHERE id = $1", [lapsed.a.accountId, `cus_${randomUUID()}`]);
    expect(await sweep()).toMatchObject({ listed: 1, queued: 1, analyses: 1, errors: 0 });
  });

  const hex = (frac: number): string => Math.floor(frac * 2 ** 48).toString(16).padStart(12, "0");
  const uuidAt = (frac: number, tail: string): string => `${hex(frac).slice(0, 8)}-${hex(frac).slice(8)}-4000-8000-${tail}`;
  /** A repository whose id sorts high (the list is in repo id order), so rows spread below it come first. */
  async function lastFixture(): Promise<{ a: SeedRefs; repoId: string; frac: number }> {
    const { a, repoId } = await fixture();
    const high = `${(0xc0 + Math.floor(Math.random() * 0x3f)).toString(16)}${randomUUID().slice(2)}`;
    await admin.query("UPDATE repos SET id = $2 WHERE id = $1", [repoId, high]);
    mine.delete(repoId);
    mine.add(high);
    return { a, repoId: high, frac: parseInt(high.slice(0, 8), 16) / 2 ** 32 };
  }
  /** 100 rows that are not repositories (queueing each is refused, before anything is written), spread evenly over the order below the healthy repository, which comes last. */
  const spread = (healthy: { accountId: string; repoId: string; frac: number }, ref: string): Due => [
    ...Array.from({ length: 100 }, (_, i) => ({ account_id: randomUUID(), repo_id: uuidAt(((i + 0.5) / 100) * healthy.frac, "000000000000"), period_ref: ref })),
    { account_id: healthy.accountId, repo_id: healthy.repoId, period_ref: ref },
  ];
  /** A lister over those rows with the real lister's keyset rule: repo id first. */
  const listOver = (rows: Due) => async (after: SweepCursor | null, limit: number): Promise<Due> =>
    rows.filter((r) => after === null || r.repo_id + r.account_id > after.repoId + after.accountId).sort((x, y) => (x.repo_id + x.account_id < y.repo_id + y.account_id ? -1 : 1)).slice(0, limit);
  /** The first quarter-hour slot at or after noon whose start falls in the first 12% of the order, so that the next slot's start (0.618 further round) falls in the middle. */
  const lowSlotTime = (): number => {
    const from = Date.UTC(2026, 10, 1, 12, 0, 0);
    for (let t = from; t < from + 24 * 3_600_000; t += 15 * 60_000) {
      const f = parseInt(passStart(t).repoId.slice(0, 8), 16) / 2 ** 32;
      if (f > 0.02 && f < 0.12) return t;
    }
    throw new Error("lowSlotTime: no quarter-hour slot of the day starts in the first 12% of the order (passStart no longer rotates)");
  };

  it("C26-g2f-3: 100 failing repositories ahead of one healthy one: the healthy one is queued in the same pass, errors is 100, and none is tried twice", async () => {
    const h = await lastFixture();
    const rows = spread({ accountId: h.a.accountId, repoId: h.repoId, frac: h.frac }, "2026-11-01");
    const pass = createDiscoverySchedule({ pool: writerPool, openSource: source, settings: () => settings, list: listOver(rows) });
    expect(await pass()).toEqual({ listed: 101, queued: 1, analyses: 1, unchanged: 0, not_analysed: 0, errors: 100, more: false }); // listed counts attempts: 101 rows, each tried once
    expect((await runs(h.repoId)).map((r) => r.trigger_ref)).toEqual(["2026-11-01"]);
  });

  /** A pass whose clock ticks on every read, so its budget covers about 75 attempts. */
  async function passesUntilQueued(rows: Due, repoId: string): Promise<DiscoveryScheduleCounts[]> {
    let wall = lowSlotTime();
    let ticks = 0;
    const now = () => wall + ticks++ * (SCHEDULE_PASS_BUDGET_MS / 75);
    const pass = createDiscoverySchedule({ pool: writerPool, openSource: source, settings: () => settings, now, list: listOver(rows) });
    const results: DiscoveryScheduleCounts[] = [];
    for (let i = 0; i < 3; i += 1) {
      ticks = 0;
      results.push(await pass());
      wall += 15 * 60_000;
      if ((await runs(repoId)).length > 0) break;
    }
    return results;
  }

  it("C26-g2f-4: the healthy repository is last, behind 100 failing rows; the first pass's budget runs out among them (per row, inside one page), and it is queued within two more passes", async () => {
    const h = await lastFixture();
    const results = await passesUntilQueued(spread({ accountId: h.a.accountId, repoId: h.repoId, frac: h.frac }, "2026-11-01"), h.repoId);
    expect((await runs(h.repoId)).length).toBe(1);
    expect(results.length).toBeLessThanOrEqual(3); // the first pass and at most two more
    expect(results[0]).toMatchObject({ more: true, queued: 0 });
    expect(results[0]!.listed).toBeLessThan(90); // stopped by the per-row check, not by the end of the 100-row page
    for (const c of results) for (const [k, v] of Object.entries(c)) if (k !== "more" && k !== "idle") expect(Number.isInteger(v)).toBe(true);
    expect(passStart(Date.UTC(2026, 10, 1, 12, 0, 0))).not.toEqual(passStart(Date.UTC(2026, 10, 1, 12, 15, 0)));
  });

  it("C26-g2f-4 within one account: 100 failing repositories in the healthy repository's own account, ahead of it, do not starve it either", async () => {
    const h = await lastFixture();
    const rows = spread({ accountId: h.a.accountId, repoId: h.repoId, frac: h.frac }, "2026-11-01").map((r) => ({ ...r, account_id: h.a.accountId }));
    expect(new Set(rows.map((r) => r.account_id)).size).toBe(1);
    const results = await passesUntilQueued(rows, h.repoId);
    expect((await runs(h.repoId)).length).toBe(1);
    expect(results.length).toBeLessThanOrEqual(3);
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
        const refs: Record<string, string> = {};
        let after = null as [string, string] | null;
        for (;;) {
          const res: { rows: Due } = await c.query<Due[number]>("SELECT * FROM discovery_sweep_list_due(500, $1, $2)", [after?.[0] ?? null, after?.[1] ?? null]);
          const rows = res.rows;
          if (rows.length === 0) break;
          for (const r of rows) if (mine.has(r.repo_id)) refs[r.repo_id] = r.period_ref;
          after = [rows[rows.length - 1]!.account_id, rows[rows.length - 1]!.repo_id];
        }
        return refs;
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
