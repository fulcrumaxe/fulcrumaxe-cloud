import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { cancelRun } from "../src/cancelRun.js";
import type { HookResult } from "../src/executionTarget.js";
import { ensureReportTag, keyRefOf, sweepOutsideMeter } from "../src/outsideMeterSweep.js";
import { writeRunStatus } from "../src/runStatusWriter.js";
import { startAgentRun } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { NormalizedEvent } from "../src/types.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#221 OM-2b2 [pg]: every way a tagged run ends starts the outside check, once, at the run's own end time; the sweep's backstop catches the rest. */
describe("outside meter: terminal paths and the backstop [pg]", () => {
  const db = pgHarness();
  const result: NormalizedEvent = { runId: "r", role: "code-reviewer", seq: 2, type: "result", ts: new Date().toISOString(), costUsd: 0.4 };
  const settle = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  };
  const om = async (runId: string) =>
    (await db.admin.query(`SELECT om_finalized_at AS fin, om_next_due_at AS due, ended_at, om_flags AS flags FROM agent_runs WHERE id = $1`, [runId])).rows[0];

  /** A running, tagged run whose hook is held until `release()`. */
  async function running(opts: { tagged?: boolean } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    const gate = { open: () => {} };
    const held = new Promise<void>((resolve) => (gate.open = resolve));
    const pool = db.runWriterPool;
    const harness = createSandboxTargetHarness(pool, [result]);
    const real = harness.deps.sandboxPort;
    const resumed: HookResult[] = [];
    const target = new SandboxTarget({
      ...harness.deps,
      finalizeBeforeResume: true,
      hooks: { resume: async (_t, r) => void resumed.push(r) },
      sandboxPort: { ...real, startDetached: (h, o) => ({ ...real.startDetached(h, o), hookFired: held.then(() => real.startDetached(h, o).hookFired) }) },
    });
    const started = await startAgentRun(pool, { sandbox: target }, { accountId, repoId, role: "code-reviewer", product: "team", roleCard: "c", prompt: "p", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" } });
    if (started.status !== "running") throw new Error("setup");
    if (opts.tagged !== false) {
      const connId = randomUUID();
      await ensureReportTag((id, fn) => withTenant(db.runWriterPool, id, fn), { accountId, runId: started.id, connectionId: connId, keyRef: keyRefOf(connId, new Uint8Array([1])) });
    }
    const run = { id: started.id, accountId, role: "code-reviewer", product: "team" as const, repoId, roleCard: "", prompt: "", model: "", capUsd: 0, spend: { plan: "starter" as const } };
    return { accountId, repoId, runId: started.id, target, run, release: gate.open, resumed };
  }
  /** ended_at is write-once (0610); a test moves it back with the stamping trigger off, in one transaction. */
  const backdate = async (runId: string, ago: string) => {
    if (!/^[0-9a-f-]{36}$/.test(runId) || !/^\d+ (minutes|hour)$/.test(ago)) throw new Error("bad test input");
    await db.admin.query(`BEGIN; ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_stamp_times; UPDATE agent_runs SET ended_at = now() - interval '${ago}' WHERE id = '${runId}'; ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_stamp_times; COMMIT`);
  };
  /** One sweep tick with the flag off: no report is read; it runs the backstop and parks what is listed. */
  const tick = () =>
    sweepOutsideMeter({ pool: db.runWriterPool, modelConnection: { get: async () => { throw new Error("not read"); } }, decryptTenantKey: async () => "k", flagOn: () => false });
  /** Runs `fn` with the clock trigger disabled (the backstop is the check for a bypass); restored in `finally`. */
  const triggerOff = async (fn: () => Promise<unknown>) => {
    await db.admin.query("ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_zz_outside_meter_start_clock");
    try {
      await fn();
    } finally {
      await db.admin.query("ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_zz_outside_meter_start_clock");
    }
  };
  const listedDue = async (runId: string) => {
    await db.admin.query(`UPDATE agent_runs SET om_next_due_at = now() - interval '1 minute' WHERE id = $1`, [runId]);
    return (await db.runWriterPool.query(`SELECT run_id FROM outside_meter_list_due(500)`)).rows.some((r: { run_id: string }) => r.run_id === runId);
  };
  const expectFinalizedAtEnd = async (runId: string) => {
    const r = await om(runId);
    expect(r.fin).not.toBeNull();
    expect(r.fin.getTime()).toBe(r.ended_at.getTime()); // T is the run's own end time
    expect(r.due.getTime() - r.ended_at.getTime()).toBe(5 * 60_000);
    expect(r.flags).toEqual([]);
    expect(await listedDue(runId)).toBe(true);
  };

  it("a user cancel starts the clock at the cancel time, and the run is read once its first read falls due", async () => {
    const r = await running();
    const userId = randomUUID();
    await seedMember(db.admin, r.accountId, userId);
    await cancelRun({ pool: db.runWriterPool, principal: { accountId: r.accountId, userId } }, r.runId, { sandbox: r.target });
    await expectFinalizedAtEnd(r.runId);
    r.release();
  });

  it("the watchdog's timed_out then cancel starts the clock", async () => {
    const r = await running();
    await writeRunStatus(db.runWriterPool, { accountId: r.accountId, runId: r.runId, from: "running", to: "timed_out" });
    await r.target.cancel(r.run);
    await expectFinalizedAtEnd(r.runId);
    r.release();
  });

  it("a hook that resumes after the run was cancelled leaves the clock at the cancel time (cancel-on-resume)", async () => {
    const r = await running();
    const userId = randomUUID();
    await seedMember(db.admin, r.accountId, userId);
    await cancelRun({ pool: db.runWriterPool, principal: { accountId: r.accountId, userId } }, r.runId, { sandbox: r.target });
    const atCancel = await om(r.runId);
    r.release();
    await settle(() => r.resumed.length > 0);
    expect(r.resumed).toHaveLength(1);
    await expectFinalizedAtEnd(r.runId);
    expect((await om(r.runId)).fin).toEqual(atCancel.fin);
  });

  it("finalize is idempotent: a second call changes nothing", async () => {
    const r = await running();
    await writeRunStatus(db.runWriterPool, { accountId: r.accountId, runId: r.runId, from: "running", to: "timed_out" });
    await r.target.cancel(r.run);
    const first = await om(r.runId);
    await new Promise((res) => setTimeout(res, 30));
    await withTenant(db.runWriterPool, r.accountId, (c) => c.query(`SELECT agent_run_outside_meter_finalize($1::uuid, $2::uuid)`, [r.accountId, r.runId]));
    expect(await om(r.runId)).toEqual(first);
  });

  it("an untagged run is never finalized, by a path or by the backstop", async () => {
    const r = await running({ tagged: false });
    await writeRunStatus(db.runWriterPool, { accountId: r.accountId, runId: r.runId, from: "running", to: "timed_out" });
    await r.target.cancel(r.run);
    await backdate(r.runId, "1 hour");
    await tick();
    expect((await om(r.runId)).fin).toBeNull();
    expect(await listedDue(r.runId)).toBe(false);
  });

  it("the backstop finalizes a tagged terminal run left unfinalized for over 10 minutes, at its end time, flagged; younger runs wait", async () => {
    const r = await running();
    await triggerOff(async () => writeRunStatus(db.runWriterPool, { accountId: r.accountId, runId: r.runId, from: "running", to: "failed" }));
    expect((await om(r.runId)).fin).toBeNull(); // the trigger was bypassed
    await tick();
    expect((await om(r.runId)).fin).toBeNull(); // only just ended
    await backdate(r.runId, "11 minutes");
    await tick();
    const row = await om(r.runId);
    expect(row.fin.getTime()).toBe(row.ended_at.getTime()); // not the sweep's clock
    expect(row.flags).toEqual(["outside_meter_late_finalize"]);
    expect(await listedDue(r.runId)).toBe(true);
    r.release();
  });

  it("the clock uses the terminal timestamp written in the same statement, not the statement's own time", async () => {
    const r = await running();
    await db.admin.query("ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_stamp_times");
    try {
      await db.admin.query(`UPDATE agent_runs SET status = 'failed', ended_at = $2 WHERE id = $1`, [r.runId, "2020-01-01T00:00:00Z"]);
    } finally {
      await db.admin.query("ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_stamp_times");
    }
    expect((await om(r.runId)).fin.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    r.release();
  });

  it("a run that is not terminal has no clock", async () => {
    const r = await running();
    expect((await om(r.runId)).fin).toBeNull();
    r.release();
  });
});
