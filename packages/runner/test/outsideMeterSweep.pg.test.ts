import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { mintGatewayTag } from "@fx/spend";
import { startGatewayReportFake, type FakeReport, type FakeRow } from "../../spend/test/fakes/gatewayReport.js";
import { FLAG, ensureReportTag, keyRefOf, sweepOutsideMeter } from "../src/outsideMeterSweep.js";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { seedAccount } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#221 OM-2b [pg]: tag store, sweep, ledger lines, flags. Real Postgres and a real local HTTP fake of the report host; no model call. */
describe("outside meter [pg]", () => {
  const db = pgHarness();
  let fake: FakeReport;
  const KEY = "vck_sweepkey";
  const CT = new Uint8Array([1, 2, 3]);
  beforeAll(async () => {
    fake = await startGatewayReportFake();
    fake.validKeys.add(KEY);
  });
  afterAll(() => fake.close());

  const wa = <T>(id: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.runWriterPool, id, fn);
  const withAcct = wa;
  const connection = (connectionId: string, ciphertext: Uint8Array<ArrayBuffer> = CT) =>
    ({ get: async () => ({ provider: "ai_gateway" as const, connectionId, encryptedKey: { ciphertext, nonce: new Uint8Array(12), wrappedDek: new Uint8Array(32), kekVersion: 1 } }) });
  const sweep = (connId: string, extra: { flagOn?: boolean; now?: Date; ciphertext?: Uint8Array<ArrayBuffer> } = {}) =>
    sweepOutsideMeter({ pool: db.runWriterPool, modelConnection: connection(connId, extra.ciphertext), decryptTenantKey: async () => KEY, flagOn: () => extra.flagOn ?? true, reportBase: fake.url, now: extra.now ? () => extra.now! : undefined });

  /** A finished run with a tag: usd metered, N model calls counted, finalize called. */
  async function finishedRun(opts: { usd: number; calls: number | null; rows: FakeRow[]; settledLine?: boolean }) {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    const connId = randomUUID();
    const { id: runId } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
    const keyRef = keyRefOf(connId, CT);
    const tag = await ensureReportTag(withAcct, { accountId, runId, connectionId: connId, keyRef });
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "succeeded", result: { usd: opts.usd }, metering: { meteredUsd: opts.usd, reportedUsd: null, flags: [], ...(opts.calls === null ? {} : { modelCalls: opts.calls }) } });
    // the run's settled model line, as finalize's settle writes it
    if (opts.settledLine !== false) await wa(accountId, (c) => c.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [accountId, opts.usd, runId]));
    await wa(accountId, (c) => c.query(`SELECT agent_run_outside_meter_finalize($1::uuid, $2::uuid)`, [accountId, runId]));
    fake.validKeys.add(KEY);
    fake.script.set(tag, opts.rows);
    return { accountId, runId, connId, tag };
  }
  const due = (runId: string) => db.admin.query(`UPDATE agent_runs SET om_next_due_at = now() - interval '1 minute' WHERE id = $1`, [runId]);
  const state = async (runId: string) =>
    (await db.admin.query(`SELECT om_state AS state, om_reason AS reason, om_reads AS reads, om_flags AS flags, om_true_up_usd AS true_up, om_overhead_usd AS overhead FROM agent_runs WHERE id = $1`, [runId])).rows[0];
  const ledger = async (runId: string) => (await db.admin.query(`SELECT reason, usd::float AS usd FROM ledger WHERE run_id = $1 AND reason IS NOT NULL ORDER BY reason`, [runId])).rows;

  it("ensureReportTag works when app_user's column grants leave out the tag and the key reference: it reads through a definer, not the table", async () => {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    const connId = randomUUID();
    const { id: runId } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    const cols = (await db.admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_runs' AND column_name NOT IN ('gateway_report_tag', 'om_key_ref') ORDER BY ordinal_position`)).rows.map((r) => `"${r.column_name}"`);
    await db.admin.query(`REVOKE SELECT ON agent_runs FROM app_user`);
    try {
      await db.admin.query(`GRANT SELECT (${cols.join(", ")}) ON agent_runs TO app_user`);
      // the direct read is refused for the runner's login now ...
      await expect(wa(accountId, (c) => c.query(`SELECT gateway_report_tag FROM agent_runs WHERE id = $1`, [runId]))).rejects.toMatchObject({ code: "42501" });
      // ... and the tag is still minted, stored first-wins, and returned again
      const tag = await ensureReportTag(withAcct, { accountId, runId, connectionId: connId, keyRef: keyRefOf(connId, CT) });
      expect(tag).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(await ensureReportTag(withAcct, { accountId, runId, connectionId: connId, keyRef: "x", mint: () => mintGatewayTag() })).toBe(tag);
      expect((await db.admin.query(`SELECT gateway_report_tag AS t FROM agent_runs WHERE id = $1`, [runId])).rows[0].t).toBe(tag);
    } finally {
      await db.admin.query(`GRANT SELECT ON agent_runs TO app_user`);
    }
  });

  it("the tag is stored once; a repeat returns the same tag; a duplicate tag and a non-tag are refused; app_user cannot write it", async () => {
    const r = await finishedRun({ usd: 1, calls: 1, rows: [] });
    expect(await ensureReportTag(withAcct, { accountId: r.accountId, runId: r.runId, connectionId: r.connId, keyRef: "x", mint: () => mintGatewayTag() })).toBe(r.tag);
    const other = { runId: (await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId: r.accountId, role: "executor", runtime: "production" })).id };
    await expect(db.admin.query(`UPDATE agent_runs SET gateway_report_tag = $1 WHERE id = $2`, [r.tag, other.runId])).rejects.toMatchObject({ code: "23505" });
    await expect(db.admin.query(`UPDATE agent_runs SET gateway_report_tag = 'bad' WHERE id = $1`, [other.runId])).rejects.toMatchObject({ code: "23514" });
    await expect(db.admin.query(`UPDATE agent_runs SET gateway_report_tag = $1 WHERE id = $2`, [mintGatewayTag(), r.runId])).rejects.toMatchObject({ code: "23514" });
    await expect(withTenant(db.pureAppUserPool, r.accountId, (c) => c.query(`UPDATE agent_runs SET om_state = 'matches' WHERE id = $1`, [r.runId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("two agreeing reads settle: the true-up and the overhead are posted once, the result is final and a re-run changes nothing", async () => {
    const row: FakeRow = { total_cost: 1.2003, surcharge_cost: 0.0003, request_count: 3 };
    const r = await finishedRun({ usd: 1, calls: 3, rows: [row, row] });
    await due(r.runId);
    expect(await sweep(r.connId)).toMatchObject({ listed: 1, final: 0 });
    expect(await state(r.runId)).toMatchObject({ state: "pending", reads: 1 });
    // a crash after the true-up line but before the result: the repeat finds the line and finishes (idempotent)
    await db.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, reason) VALUES ($1, 'model', 'customer_gateway', 0.2, $2, 'model', 'outside_meter')`, [r.accountId, r.runId]);
    await due(r.runId);
    expect(await sweep(r.connId)).toMatchObject({ final: 1 });
    const s = await state(r.runId);
    expect(s).toMatchObject({ state: "higher", reads: 2 });
    expect(Number(s.true_up)).toBeCloseTo(0.2, 6);
    expect(s.flags).toEqual(["outside_meter_disagree", "outside_meter_escalate"]);
    expect(await ledger(r.runId)).toEqual([{ reason: "outside_meter", usd: 0.2 }, { reason: "outside_meter_overhead", usd: 0.0103 }]);
    await due(r.runId);
    expect(await sweep(r.connId)).toMatchObject({ listed: 0 });
    expect(await ledger(r.runId)).toHaveLength(2);
    // a final result is history: no direct change either
    await expect(db.admin.query(`UPDATE agent_runs SET om_state = 'pending' WHERE id = $1`, [r.runId])).rejects.toMatchObject({ code: "23514" });
  });

  it("the needs-owner signal is a counts-only function for platform_ops: one row, no account, run or figure; the runner's login cannot call it", async () => {
    const row: FakeRow = { total_cost: 2, surcharge_cost: 0, request_count: 2 };
    const r = await finishedRun({ usd: 1, calls: 2, rows: [row, row] });
    for (let i = 0; i < 2; i++) { await due(r.runId); await sweep(r.connId); }
    expect((await state(r.runId)).flags).toContain("outside_meter_escalate");
    const res = await db.admin.query(`SELECT * FROM outside_meter_flag_counts(7)`);
    expect(res.rows).toHaveLength(1);
    expect(res.fields.map((f) => f.name).sort()).toEqual(["bad_request", "contract", "disagree", "escalated", "floor_unmet", "late_finalize", "no_count", "runs_checked", "trueup_held", "unavailable"]);
    expect(Number(res.rows[0].escalated)).toBeGreaterThanOrEqual(1);
    await expect(db.runWriterPool.query(`SELECT * FROM outside_meter_flag_counts(7)`)).rejects.toMatchObject({ code: "42501" });
  });

  it("a gateway figure at or below the metered one matches, with a true-up never posted and no credit", async () => {
    const row: FakeRow = { total_cost: 0.9, surcharge_cost: 0, request_count: 2 };
    const r = await finishedRun({ usd: 1, calls: 2, rows: [row, row] });
    for (let i = 0; i < 2; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "matches" });
    expect((await ledger(r.runId)).map((l) => l.reason)).toEqual(["outside_meter_overhead"]);
  });

  it("a report with fewer requests than the runner metered is not final; a run with no count settles and is flagged", async () => {
    const few: FakeRow = { total_cost: 1, surcharge_cost: 0, request_count: 2 };
    const a = await finishedRun({ usd: 1, calls: 3, rows: [few, few] });
    for (let i = 0; i < 2; i++) { await due(a.runId); await sweep(a.connId); }
    expect(await state(a.runId)).toMatchObject({ state: "pending", reads: 2 });
    const full: FakeRow = { total_cost: 1, surcharge_cost: 0, request_count: 3 };
    const b = await finishedRun({ usd: 1, calls: null, rows: [full, full] });
    for (let i = 0; i < 2; i++) { await due(b.runId); await sweep(b.connId); }
    expect(await state(b.runId)).toMatchObject({ state: "matches", flags: ["outside_meter_no_count"] });
  });

  it("a run that never stabilizes gets exactly 8 reads, then unavailable (not_stable)", async () => {
    const rows = Array.from({ length: 12 }, (_, i): FakeRow => ({ total_cost: 1 + i, surcharge_cost: 0, request_count: 1 + i }));
    const r = await finishedRun({ usd: 1, calls: 1, rows });
    const before = fake.requests.length;
    for (let i = 0; i < 10; i++) { await due(r.runId); await sweep(r.connId); }
    expect(fake.requests.length - before).toBe(8);
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "not_stable", reads: 8 });
  });

  it("an unmet floor at the last read (reads agree, count under the meter's) ends floor_unmet, flagged, and still trues up when the gateway is higher", async () => {
    const stable: FakeRow = { total_cost: 2, surcharge_cost: 0, request_count: 3 };
    const r = await finishedRun({ usd: 1, calls: 40, rows: [stable] });
    for (let i = 0; i < 9; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "floor_unmet", reads: 8 });
    expect((await state(r.runId)).flags).toContain("outside_meter_floor_unmet");
    expect(Number((await state(r.runId)).true_up)).toBeCloseTo(1, 6);
    expect((await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [r.runId])).rows[0].status).toBe("succeeded");
    expect(await ledger(r.runId)).toEqual([{ reason: "outside_meter", usd: 1 }, { reason: "outside_meter_overhead", usd: expect.any(Number) }]);
    // before the last read nothing ends it
    const early = await finishedRun({ usd: 1, calls: 40, rows: [stable] });
    for (let i = 0; i < 3; i++) { await due(early.runId); await sweep(early.connId); }
    expect(await state(early.runId)).toMatchObject({ state: "pending", reads: 3 });
  });

  it("an unmet floor with the gateway at or below the meter posts no line and still ends floor_unmet", async () => {
    const stable: FakeRow = { total_cost: 0.5, surcharge_cost: 0, request_count: 3 };
    const r = await finishedRun({ usd: 1, calls: 40, rows: [stable] });
    for (let i = 0; i < 9; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "floor_unmet" });
    expect((await ledger(r.runId)).map((l) => l.reason)).toEqual(["outside_meter_overhead"]);
  });

  it("a report that never agrees ends not_stable with no true-up", async () => {
    const rows = Array.from({ length: 12 }, (_, i): FakeRow => ({ total_cost: 3 + i, surcharge_cost: 0, request_count: 5 + i }));
    const r = await finishedRun({ usd: 1, calls: 40, rows });
    for (let i = 0; i < 9; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "not_stable", flags: ["outside_meter_unavailable"] });
    expect((await ledger(r.runId)).map((l) => l.reason)).toEqual(["outside_meter_overhead"]); // it paid for reads
  });

  it("the true-up has a ceiling of the floor or 2 x per-run cap x (1 + max resumes): at it a line is posted, a cent above it is held and escalated", async () => {
    const run = async (g: number, limits: boolean) => {
      const row: FakeRow = { total_cost: g, surcharge_cost: 0, request_count: 2 };
      const r = await finishedRun({ usd: 1, calls: 2, rows: [row, row] });
      if (limits) await db.admin.query(`INSERT INTO run_limits (account_id, role, per_run_usd, max_resumes) VALUES ($1, '*', 1, 0) ON CONFLICT (account_id, role) DO NOTHING`, [r.accountId]);
      const escalated: unknown[] = [];
      for (let i = 0; i < 2; i++) {
        await due(r.runId);
        await sweepOutsideMeter({ pool: db.runWriterPool, modelConnection: connection(r.connId), decryptTenantKey: async () => KEY, flagOn: () => true, reportBase: fake.url, onEscalate: (e) => void escalated.push(e) });
      }
      return { r, escalated };
    };
    const at = await run(6, true); // the fixed floor: 6 - 1 = 5.00 exactly
    expect(await state(at.r.runId)).toMatchObject({ state: "higher" });
    expect((await ledger(at.r.runId)).map((l) => l.reason)).toContain("outside_meter");
    const over = await run(6.01, true);
    expect(await state(over.r.runId)).toMatchObject({ state: "unavailable", reason: "trueup_over_ceiling" });
    expect((await state(over.r.runId)).flags).toContain("outside_meter_trueup_held");
    expect((await ledger(over.r.runId)).map((l) => l.reason)).toEqual(["outside_meter_overhead"]);
    expect(over.escalated).toEqual([{ runId: over.r.runId, kind: "trueup_held", gatewayUsd: 6.01, meteredUsd: 1 }]);
    // the run's own limits raise it (twice a cap of ten, one spawn), so a true-up of ten posts
    const row: FakeRow = { total_cost: 11, surcharge_cost: 0, request_count: 2 };
    const r = await finishedRun({ usd: 1, calls: 2, rows: [row, row] });
    await db.admin.query(`INSERT INTO run_limits (account_id, role, per_run_usd, max_resumes) VALUES ($1, '*', 10, 0)`, [r.accountId]);
    for (let i = 0; i < 2; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "higher" });
  });

  it("a transient failure on every read gives 8 reads, then unavailable (gateway_error)", async () => {
    const r = await finishedRun({ usd: 1, calls: 1, rows: [] });
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("", { status: 503 }); }) as typeof fetch;
    try {
      for (let i = 0; i < 10; i++) { await due(r.runId); await sweep(r.connId); }
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(8);
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "gateway_error", reads: 8 });
    expect((await ledger(r.runId))).toEqual([]); // failed reads cost nothing
  });

  it("a run with no settled model line is never read as 0: no true-up, the next read is tried, and the last ends no_metered_figure", async () => {
    const row: FakeRow = { total_cost: 2, surcharge_cost: 0, request_count: 2 };
    const r = await finishedRun({ usd: 1, calls: 2, rows: [row], settledLine: false });
    for (let i = 0; i < 3; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "pending", reads: 3 });
    expect((await ledger(r.runId)).map((l) => l.reason)).not.toContain("outside_meter");
    for (let i = 0; i < 6; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "no_metered_figure", reads: 8 });
    expect((await state(r.runId)).flags).toContain("outside_meter_unavailable");
    expect((await ledger(r.runId)).map((l) => l.reason)).toEqual(["outside_meter_overhead"]);
  });

  it("overhead is posted once for a run that paid for a read and ended unavailable, and not at all for a run that never read", async () => {
    const stable: FakeRow = { total_cost: 1, surcharge_cost: 0, request_count: 1 };
    const none = await finishedRun({ usd: 1, calls: 1, rows: [] });
    fake.notEntitled.add(KEY);
    await due(none.runId);
    await sweep(none.connId);
    fake.notEntitled.delete(KEY);
    expect(await state(none.runId)).toMatchObject({ state: "unavailable", reason: "plan_not_entitled" });
    expect(await ledger(none.runId)).toEqual([]);
    const paid = await finishedRun({ usd: 1, calls: 1, rows: [stable], settledLine: false });
    for (let i = 0; i < 9; i++) { await due(paid.runId); await sweep(paid.connId); }
    expect(await ledger(paid.runId)).toHaveLength(1);
    expect(Number((await state(paid.runId)).overhead)).toBeGreaterThan(0);
  });

  it("every flag the sweep can raise is counted by outside_meter_flag_counts, and the count has no flag the code never raises", async () => {
    const src = readFileSync(fileURLToPath(new URL("../src/outsideMeterSweep.ts", import.meta.url)), "utf8");
    const raised = new Set(Object.values(FLAG));
    // every flag literal in the sweep or the spend rules is in FLAG
    const spend = readFileSync(fileURLToPath(new URL("../../spend/src/gatewayMeter.ts", import.meta.url)), "utf8");
    const literals = new Set([...(src + spend).matchAll(/"(outside_meter_[a-z_]+)"/g)].map((m) => m[1]!));
    for (const l of ["outside_meter_overhead"]) literals.delete(l);
    for (const l of literals) expect(raised.has(l as never), l).toBe(true);
    // each raised flag, set alone on a fresh finalized run, moves the counts
    const base = (await db.admin.query(`SELECT * FROM outside_meter_flag_counts(7)`)).rows[0];
    const cols = Object.keys(base).filter((k) => k !== "runs_checked");
    const hit = new Set<string>();
    for (const flag of raised) {
      const r = await finishedRun({ usd: 1, calls: 1, rows: [] });
      await db.admin.query(`UPDATE agent_runs SET om_flags = ARRAY[$2]::text[] WHERE id = $1`, [r.runId, flag]);
      const after = (await db.admin.query(`SELECT * FROM outside_meter_flag_counts(7)`)).rows[0];
      const moved = cols.filter((k) => Number(after[k]) > Number(base[k]));
      expect(moved.length, flag).toBeGreaterThan(0);
      moved.forEach((k) => hit.add(k));
      await db.admin.query(`UPDATE agent_runs SET om_flags = '{}' WHERE id = $1`, [r.runId]);
    }
    // no counted column is dead: each is moved by some flag
    expect([...hit].sort()).toEqual(cols.sort());
  });
  it("403 ends the run as plan_not_entitled; a replaced key or connection is never read with; the flag off closes it after 24 h with no read", async () => {
    const a = await finishedRun({ usd: 1, calls: 1, rows: [] });
    fake.notEntitled.add(KEY);
    await due(a.runId);
    await sweep(a.connId);
    fake.notEntitled.delete(KEY);
    expect(await state(a.runId)).toMatchObject({ state: "unavailable", reason: "plan_not_entitled" });

    const b = await finishedRun({ usd: 1, calls: 1, rows: [] });
    const n = fake.requests.length;
    await due(b.runId);
    await sweep(b.connId, { ciphertext: new Uint8Array([9]) }); // rotated key
    await sweep(randomUUID()); // a different connection
    expect(fake.requests.length).toBe(n);
    expect(await state(b.runId)).toMatchObject({ state: "unavailable", reason: "connection_changed" });

    const c = await finishedRun({ usd: 1, calls: 1, rows: [] });
    await due(c.runId);
    await sweep(c.connId, { flagOn: false });
    expect(await state(c.runId)).toMatchObject({ state: "pending" });
    await due(c.runId);
    await sweep(c.connId, { flagOn: false, now: new Date(Date.now() + 25 * 3_600_000) });
    expect(await state(c.runId)).toMatchObject({ state: "unavailable", reason: "flag_off" });
    expect(fake.requests.length).toBe(n);
  });

  it("a malformed 200 is a contract break: the run stays pending with the flag, and ends contract_mismatch on the last read", async () => {
    const r = await finishedRun({ usd: 1, calls: 1, rows: [] });
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([{ tag: r.tag }]), { status: 200 })) as typeof fetch;
    try {
      await due(r.runId);
      await sweep(r.connId);
      expect(await state(r.runId)).toMatchObject({ state: "pending", reads: 1, flags: ["outside_meter_contract"] });
      await db.admin.query(`UPDATE agent_runs SET om_reads = 7 WHERE id = $1`, [r.runId]);
      await due(r.runId);
      await sweep(r.connId);
      expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "contract_mismatch" });
    } finally {
      globalThis.fetch = real;
    }
  });

  // OM-2c carry-ins from the review of the finalize PR.
  it("a transient failure on a read that is not the last keeps the previous snapshot instead of nulling it", async () => {
    const r = await finishedRun({ usd: 1, calls: 5, rows: [{ total_cost: 1, surcharge_cost: 0, request_count: 2 }] });
    await due(r.runId);
    await sweep(r.connId);
    expect(await state(r.runId)).toMatchObject({ state: "pending", reads: 1 });
    const snap = async () => (await db.admin.query(`SELECT om_last_cost::float AS cost, om_last_count AS n FROM agent_runs WHERE id = $1`, [r.runId])).rows[0];
    expect(await snap()).toEqual({ cost: 1, n: 2 });
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    try {
      await due(r.runId);
      await sweep(r.connId);
    } finally {
      globalThis.fetch = real;
    }
    expect(await state(r.runId)).toMatchObject({ state: "pending", reads: 2 });
    expect(await snap()).toEqual({ cost: 1, n: 2 });
  });

  it("a failing backstop query is counted and handed to onError, and the due reads still run", async () => {
    const r = await finishedRun({ usd: 1, calls: 1, rows: [{ total_cost: 1, surcharge_cost: 0, request_count: 1 }] });
    await due(r.runId);
    const real = db.runWriterPool.query.bind(db.runWriterPool) as (...a: unknown[]) => Promise<unknown>;
    const seen: unknown[] = [];
    const pool = new Proxy(db.runWriterPool, {
      get: (t, k) => (k === "query"
        ? (sql: unknown, ...rest: unknown[]) => (typeof sql === "string" && sql.includes("outside_meter_list_unfinalized") ? Promise.reject(new Error("boom")) : real(sql, ...rest))
        : Reflect.get(t, k, t)),
    });
    const res = await sweepOutsideMeter({ pool, modelConnection: connection(r.connId), decryptTenantKey: async () => KEY, flagOn: () => true, reportBase: fake.url, onError: (id) => void seen.push(id) });
    expect(res.failed).toBe(1);
    expect(seen).toEqual([null]);
    expect(await state(r.runId)).toMatchObject({ reads: 1 });
  });

  it("a limits query that rejects leaves the run pending, counts it failed and posts no line; the next tick, with the database back, settles it", async () => {
    const row: FakeRow = { total_cost: 3, surcharge_cost: 0, request_count: 2 };
    const r = await finishedRun({ usd: 1, calls: 2, rows: [row, row] });
    const failing = new Proxy(db.runWriterPool, {
      get: (t, k) => (k === "connect"
        ? async () => {
            const c = await t.connect();
            return new Proxy(c, {
              get: (ct, ck) => (ck === "query"
                ? (sql: unknown, ...rest: unknown[]) => (typeof sql === "string" && sql.includes("SELECT role FROM agent_runs") ? Promise.reject(new Error("limits down")) : (ct.query as (...a: unknown[]) => unknown).call(ct, sql, ...rest))
                : Reflect.get(ct, ck, ct)),
            });
          }
        : k === "query" ? t.query.bind(t) : Reflect.get(t, k, t)), // pool.query takes its own callback-style connect, so it is left on the real pool
    });
    const seen: unknown[] = [];
    let last = { failed: 0 };
    for (let i = 0; i < 2; i++) {
      await due(r.runId);
      last = await sweepOutsideMeter({ pool: failing, modelConnection: connection(r.connId), decryptTenantKey: async () => KEY, flagOn: () => true, reportBase: fake.url, onError: (id) => void seen.push(id) });
    }
    expect(last.failed).toBe(1);
    expect(seen).toEqual([r.runId]);
    expect(await state(r.runId)).toMatchObject({ state: "pending" });
    expect(await ledger(r.runId)).toEqual([]);
    await due(r.runId);
    await sweep(r.connId);
    expect(await state(r.runId)).toMatchObject({ state: "higher" });
    expect((await ledger(r.runId)).map((l) => l.reason)).toContain("outside_meter");
  });

  it("an unmet floor and a held true-up together raise both flags; the run ends held", async () => {
    const stable: FakeRow = { total_cost: 8, surcharge_cost: 0, request_count: 3 };
    const r = await finishedRun({ usd: 1, calls: 40, rows: [stable] });
    await db.admin.query(`INSERT INTO run_limits (account_id, role, per_run_usd, max_resumes) VALUES ($1, '*', 1, 0)`, [r.accountId]);
    for (let i = 0; i < 9; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "trueup_over_ceiling" });
    expect((await state(r.runId)).flags).toEqual(expect.arrayContaining(["outside_meter_floor_unmet", "outside_meter_trueup_held"]));
  });
});
