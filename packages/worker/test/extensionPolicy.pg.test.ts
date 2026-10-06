import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { SandboxTarget, buildExecutionRun, writeRunStatus, defaultResolvePayer, tryExtend, type ExecutionRun, type ExtensionFacts, type ExtensionPolicyInput, type SandboxPort, type StartDetachedOptions } from "@fx/runner";
import { defaultPerSpawnCapUsd, settle } from "@fx/spend";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createExtensionPolicyFor } from "../src/extensionPolicy.js";
import { createSeatResolver } from "../src/seat.js";

/** [pg] the extension policy's reservation, against the real spend tables and the real SandboxTarget.admit. */
describe("extension policy [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  /** A pool that records the SQL its clients run, so a test can see which statements a reservation took. */
  function recordingPool(): { pool: Pool; sql: string[] } {
    const sql: string[] = [];
    const pool = {
      connect: async () => {
        const client = await writerPool.connect();
        const query = client.query.bind(client) as (...a: unknown[]) => unknown;
        (client as { query: unknown }).query = (...a: unknown[]) => (sql.push(String((a[0] as { text?: string } | undefined)?.text ?? a[0])), query(...a));
        return client;
      },
    } as unknown as Pool;
    return { pool, sql };
  }

  /** A run the real seat resolver seated and the real target admitted. */
  async function admitted(budget: number, role = "code-reviewer") {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = $2 WHERE id = $1", [a.accountId, budget]);
    const seated = await createSeatResolver({ pool: writerPool })({ accountId: a.accountId, role, workItemId: a.workItemId });
    if (!seated.ok) throw new Error(`seat refused: ${seated.reason}`);
    const runId = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, $3, 'production', 'pending')", [runId, a.accountId, role]);
    const run = buildExecutionRun(runId, { ...seated.seat, accountId: a.accountId, role, workItemId: a.workItemId, prompt: "go" } as never);
    const harness = createSandboxTargetHarness(writerPool);
    const target = new SandboxTarget(harness.deps);
    expect(await target.admit(run, admin)).toEqual({ admitted: true });
    return { a, run, harness };
  }
  const openModel = async (run: ExecutionRun) =>
    Number((await admin.query("SELECT count(*) FROM spend_reservations WHERE run_id = $1 AND account_id = $2 AND budget = 'model' AND state = 'open'", [run.id, run.accountId])).rows[0].count);
  const allRows = async (run: ExecutionRun) => Number((await admin.query("SELECT count(*) FROM spend_reservations WHERE run_id = $1", [run.id])).rows[0].count);

  it("5: reserveExtension takes one more open model reservation for the same run and payer, through reserve() and its advisory lock", async () => {
    const { run } = await admitted(500);
    expect(await openModel(run)).toBe(1);
    const { pool, sql } = recordingPool();
    const policy = createExtensionPolicyFor({ pool, resolvePayer: defaultResolvePayer })(run)!;
    expect(await policy.reserveExtension(3)).toBe(true);
    expect(await openModel(run)).toBe(2);
    expect(sql.some((q) => /pg_advisory_xact_lock/.test(q))).toBe(true);
    const { rows } = await admin.query("SELECT DISTINCT account_id FROM spend_reservations WHERE run_id = $1", [run.id]);
    expect(rows.map((r) => r.account_id)).toEqual([run.accountId]);
  });

  it("5: a month with no room is a false and leaves no reservation row behind", async () => {
    const cap = defaultPerSpawnCapUsd();
    const { run } = await admitted(cap + 5); // the run's own hold (the per-spawn cap) takes most of it
    const before = await allRows(run);
    const policy = createExtensionPolicyFor({ pool: writerPool, resolvePayer: defaultResolvePayer })(run)!;
    expect(await policy.reserveExtension(cap)).toBe(false);
    expect(await allRows(run)).toBe(before);
  });

  it("an estimate that records nothing (0 or NaN) is not an extension, and leaves no reservation row", async () => {
    const { run } = await admitted(500);
    const before = await allRows(run);
    const policy = createExtensionPolicyFor({ pool: writerPool, resolvePayer: defaultResolvePayer })(run)!;
    for (const estimate of [0, Number.NaN]) expect(await policy.reserveExtension(estimate).catch(() => false), String(estimate)).toBe(false);
    expect(await allRows(run)).toBe(before);
  });

  it("3: a continuation of a run whose checkpoint recorded one extension still gets the full resolved count", async () => {
    const { run } = await admitted(500);
    await writeRunStatus(writerPool, { accountId: run.accountId, runId: run.id, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: run.accountId, runId: run.id, from: "running", to: "timed_out", checkpoint: { kind: "run_time", ccSessionId: "cc-1", meteredUsd: 1, extensionsUsed: 1 } });
    const { rows } = await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'checkpoint'", [run.id]);
    expect(rows[0].payload).toMatchObject({ extensions_used: 1 }); // the real prior checkpoint
    const continuation: ExecutionRun = { ...run, id: randomUUID(), parentRunId: run.id };
    expect(createExtensionPolicyFor({ pool: writerPool, resolvePayer: defaultResolvePayer })(continuation)!.maxExtensions).toBe(run.maxExtensions);
  });

  it("6: settling the run after an admitted extension closes both model reservations and writes one ledger row", async () => {
    const { run } = await admitted(500);
    const policy = createExtensionPolicyFor({ pool: writerPool, resolvePayer: defaultResolvePayer })(run)!;
    expect(await policy.reserveExtension(3)).toBe(true);
    await settle(writerPool, { accountId: run.accountId, runId: run.id, entries: [{ budget: "model", actualUsd: 1.5, source: "customer_gateway" }] });
    expect(await openModel(run)).toBe(0);
    expect((await admin.query("SELECT usd FROM ledger WHERE run_id = $1 AND budget = 'model'", [run.id])).rows.map((r) => Number(r.usd))).toEqual([1.5]);
  });

  it("7: a run funded by a claim cannot name a payer yet, so its extension is spend_denied and holds nothing", async () => {
    const { run } = await admitted(500);
    const claimed: ExecutionRun = { ...run, funding: { kind: "claim", payerAccountId: randomUUID(), fundingId: randomUUID() } };
    const before = await allRows(run);
    const policy = createExtensionPolicyFor({ pool: writerPool, resolvePayer: defaultResolvePayer })(claimed)!;
    const facts: ExtensionFacts = {
      kind: "run_time", nowMs: 1000, startedMs: 0, lastUsageRiseMs: 900, silenceMs: 60_000, extensionsUsed: 0, maxExtensions: policy.maxExtensions, ghWrites: 0, ghWritesAtLastExtension: 0,
      roleWrites: true, messageIds: 1, messageIdsAtLastExtension: 0, resolvedLimit: 60 * 60_000, currentLimit: 60 * 60_000, meteredUsd: 0.0001, ceilings: policy.ceilings,
    };
    expect(await tryExtend(facts, policy.reserveExtension)).toEqual({ extend: false, reason: "spend_denied" });
    expect(await allRows(run)).toBe(before);
  });

  it("9: the production policy reaches the port through the real target, whose event write records limit_extended", async () => {
    const a = await admitted(500);
    const seen: Array<StartDetachedOptions["extension"]> = [];
    const port = a.harness.deps.sandboxPort;
    const spied = { ...port, startDetached: (h, o) => (seen.push(o.extension), port.startDetached(h, o)) } as SandboxPort;
    const extensionPolicyFor = createExtensionPolicyFor({ pool: writerPool, resolvePayer: defaultResolvePayer });
    const target = new SandboxTarget({ ...a.harness.deps, sandboxPort: spied, extensionPolicyFor });
    await target.dispatch(a.run);
    const policy = seen[0]! as ExtensionPolicyInput & { onExtended(e: unknown): Promise<void> };
    expect(policy).toMatchObject({ maxExtensions: a.run.maxExtensions, roleWrites: false });
    await policy.onExtended({ kind: "run_time", extensionsUsed: 1, newLimit: 90 * 60_000, progress: { usage_rose: true, gh_writes: 0, new_message_ids: 1 } });
    const { rows } = await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'limit_extended'", [a.run.id]);
    expect(rows).toHaveLength(1);
  });
});
