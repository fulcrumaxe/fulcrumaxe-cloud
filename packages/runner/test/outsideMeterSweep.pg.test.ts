import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { mintGatewayTag } from "@fx/spend";
import { startGatewayReportFake, type FakeReport, type FakeRow } from "../../spend/test/fakes/gatewayReport.js";
import { ensureReportTag, keyRefOf, sweepOutsideMeter } from "../src/outsideMeterSweep.js";
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
  async function finishedRun(opts: { usd: number; calls: number | null; rows: FakeRow[] }) {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    const connId = randomUUID();
    const { id: runId } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
    const keyRef = keyRefOf(connId, CT);
    const tag = await ensureReportTag(withAcct, { accountId, runId, connectionId: connId, keyRef });
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "succeeded", result: { usd: opts.usd }, metering: { meteredUsd: opts.usd, reportedUsd: null, flags: [], ...(opts.calls === null ? {} : { modelCalls: opts.calls }) } });
    // the run's settled model line, as finalize's settle writes it
    await wa(accountId, (c) => c.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [accountId, opts.usd, runId]));
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
    expect(res.fields.map((f) => f.name).sort()).toEqual(["contract", "disagree", "escalated", "no_count", "runs_checked"]);
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

  it("a floor the report never reaches (the VM inflated the count, or a kill left it low) ends unavailable after 8 reads, flagged, and leaves the run's charge as it was", async () => {
    const stable: FakeRow = { total_cost: 2, surcharge_cost: 0, request_count: 3 };
    const r = await finishedRun({ usd: 1, calls: 40, rows: [stable] });
    for (let i = 0; i < 9; i++) { await due(r.runId); await sweep(r.connId); }
    expect(await state(r.runId)).toMatchObject({ state: "unavailable", reason: "not_stable", reads: 8, flags: ["outside_meter_unavailable"] });
    // it never blocked the run: the run is succeeded, its settled line is untouched, and no outside line was invented
    expect((await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [r.runId])).rows[0].status).toBe("succeeded");
    expect((await db.admin.query(`SELECT usd::float AS usd FROM ledger WHERE run_id = $1 AND reason IS NULL`, [r.runId])).rows).toEqual([{ usd: 1 }]);
    expect(await ledger(r.runId)).toEqual([]);
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
});
