import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { IllegalRunTransitionError } from "../src/statusTransitions.js";
import { createRunGuard, resolveRunLimits } from "../src/meteringGuard.js";
import { buildTerminalReport } from "../src/targets/sandboxTarget.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#2 H09b, correction C10, pass/fail 7 (H09.11) and 13. [pg]: real
 * Postgres, zero model tokens.
 */
describe("runStatusWriter [pg]", () => {
  const db = pgHarness();

  async function seedFreshAccount(): Promise<{ accountId: string; repoId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }

  /** Every test below only needs a bare pending run to hang a write on. */
  async function insertPending(accountId: string): Promise<string> {
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    return id;
  }

  it("H09.11: insertAgentRun writes agent_runs (status=pending) and a run.created run_events row, both through withTenant", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);

    const runRow = await db.admin.query(`SELECT status, head_sha FROM agent_runs WHERE id = $1`, [id]);
    expect(runRow.rows[0]).toEqual({ status: "pending", head_sha: null });

    const events = await db.admin.query(`SELECT kind, seq FROM run_events WHERE run_id = $1 ORDER BY seq`, [id]);
    expect(events.rows).toEqual([{ kind: "run.created", seq: "1" }]);
  });

  it("H09b pass/fail 17: headSha is written only at INSERT time", async () => {
    const { accountId } = await seedFreshAccount();
    const { id } = await insertAgentRun(db.runWriterPool, {
      id: randomUUID(),
      accountId,
      role: "executor",
      runtime: "production",
      headSha: "abc123headsha",
    });
    const { rows } = await db.admin.query(`SELECT head_sha FROM agent_runs WHERE id = $1`, [id]);
    expect(rows[0].head_sha).toBe("abc123headsha");
  });

  it("writeRunStatus: a legal compare-and-set write succeeds and records a run.status_changed event", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);

    const result = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
    expect(result).toEqual({ updated: true });

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("running");

    const events = await db.admin.query(`SELECT kind, payload FROM run_events WHERE run_id = $1 ORDER BY seq`, [id]);
    expect(events.rows[1]).toEqual({ kind: "run.status_changed", payload: { from: "pending", to: "running" } });
  });

  // D#2 C10 pass/fail 15 (D#31 API-4b wiring): each successful transition
  // writes one domain event, in the SAME transaction as the run_events
  // insert and the status UPDATE.
  it("D#2 C10 pass/fail 15: a successful transition emits one run.status_changed domain event, ids/enums only", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);

    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });

    const { rows } = await db.admin.query(
      `SELECT type, account_id, subject_id, payload FROM domain_events WHERE account_id = $1`,
      [accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      type: "run.status_changed",
      account_id: accountId,
      subject_id: id,
      payload: { runId: id, from: "pending", to: "running" },
    });
  });

  // D#31 API-4b fix round MUST 1: a `failureReason`-carrying transition
  // must not leak that free text onto the domain-event outbox -- only
  // `run_events` (not a customer/notification-facing surface) keeps it.
  it("D#31 API-4b fix round: a failureReason transition's domain event payload keys are exactly the allowed set, no failureReason", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
    await writeRunStatus(db.runWriterPool, {
      accountId,
      runId: id,
      from: "running",
      to: "failed",
      failureReason: "model_key_broken",
    });

    const { rows } = await db.admin.query(
      `SELECT payload FROM domain_events WHERE account_id = $1 ORDER BY seq`,
      [accountId],
    );
    expect(rows).toHaveLength(2);
    const failedPayload = rows[1].payload as Record<string, unknown>;
    expect(Object.keys(failedPayload).sort()).toEqual(["from", "runId", "to"]);
    expect(failedPayload).toEqual({ runId: id, from: "running", to: "failed" });

    // run_events (not the domain-event outbox) is where failureReason still lives.
    const runEvents = await db.admin.query(
      `SELECT payload FROM run_events WHERE run_id = $1 ORDER BY seq`,
      [id],
    );
    expect(runEvents.rows.at(-1).payload).toEqual({ from: "running", to: "failed", failureReason: "model_key_broken" });
  });

  it("D#2 C10 pass/fail 15: a second transition emits a second event, not part of the webhook-subscribable catalogue", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "succeeded" });

    const { rows } = await db.admin.query(
      `SELECT type FROM domain_events WHERE account_id = $1 ORDER BY seq`,
      [accountId],
    );
    expect(rows.map((r: { type: string }) => r.type)).toEqual(["run.status_changed", "run.status_changed"]);
  });

  it("D#2 C10 pass/fail 15: a compare-and-set that updates 0 rows writes no domain event", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "cancelled" });

    const before = await db.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1`, [accountId]);
    expect(before.rows[0].n).toBe(2);

    // Stale "running" assumption -- the run is already cancelled, so this
    // touches 0 rows (same race the earlier "a cancel that commits first
    // wins" test exercises).
    const lateSucceed = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "succeeded" });
    expect(lateSucceed).toEqual({ updated: false, currentStatus: "cancelled" });

    const after = await db.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1`, [accountId]);
    expect(after.rows[0].n).toBe(2);
  });

  it("D#2 C10 pass/fail 15: a transition the state machine refuses writes no domain event (nothing commits at all)", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);

    await expect(
      writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "succeeded" }),
    ).rejects.toThrow(IllegalRunTransitionError);

    const { rows } = await db.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1`, [accountId]);
    expect(rows[0].n).toBe(0);
  });

  it("writeRunStatus throws IllegalRunTransitionError, and writes nothing, for a from/to pair the state machine doesn't declare legal", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);

    await expect(
      writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "succeeded" }),
    ).rejects.toThrow(IllegalRunTransitionError);

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("pending");
  });

  // C10 pass/fail 13, race 1: a cancel commits first; a late "succeeded" write is a no-op.
  it("race: a cancel that commits first wins -- a later write from a stale 'running' assumption touches 0 rows", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });

    const cancelled = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "cancelled" });
    expect(cancelled).toEqual({ updated: true });

    const lateSucceed = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "succeeded" });
    expect(lateSucceed).toEqual({ updated: false, currentStatus: "cancelled" });

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("cancelled");
  });

  // C10 pass/fail 13, race 2: completion commits first; a late cancel is a no-op.
  it("race: completion commits first -- a later cancel attempt from a stale 'running' assumption touches 0 rows and reports the real status", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });

    const succeeded = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "succeeded" });
    expect(succeeded).toEqual({ updated: true });

    const lateCancel = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "cancelled" });
    expect(lateCancel).toEqual({ updated: false, currentStatus: "succeeded" });
  });

  // C10 pass/fail 13, race 3: the watchdog fires on an already-cancelled run.
  it("race: the watchdog firing on an already-cancelled run touches 0 rows", async () => {
    const { accountId } = await seedFreshAccount();
    const id = await insertPending(accountId);
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "cancelled" });

    const lateWatchdog = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "timed_out" });
    expect(lateWatchdog).toEqual({ updated: false, currentStatus: "cancelled" });
  });
  // D#221 OM-1 (0744): the metered model-response count. The figure travels the same way it does in a real run:
  // the run guard counts, the terminal report carries it, writeRunStatus stores it.
  describe("metered_model_calls (D#221 OM-1)", () => {
    async function terminalWithIds(accountId: string, ids: string[]): Promise<string> {
      const id = await insertPending(accountId);
      await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
      const guard = createRunGuard(resolveRunLimits(), () => undefined);
      for (const messageId of ids) guard.observe({ type: "assistant", messageId, usage: undefined });
      const report = buildTerminalReport(undefined, undefined, 0, { tokens: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, flags: [], modelCalls: guard.modelCalls() });
      const written = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: report.status, metering: report.metering });
      expect(written).toEqual({ updated: true });
      return id;
    }
    const stored = async (id: string): Promise<number | null> =>
      (await db.admin.query(`SELECT metered_model_calls AS n FROM agent_runs WHERE id = $1`, [id])).rows[0].n;

    it("a run with 3 distinct assistant ids stores 3", async () => {
      const { accountId } = await seedFreshAccount();
      expect(await stored(await terminalWithIds(accountId, ["m1", "m2", "m3"]))).toBe(3);
    });

    it("a repeated message id is counted once", async () => {
      const { accountId } = await seedFreshAccount();
      expect(await stored(await terminalWithIds(accountId, ["m1", "m1", "m2", "m1", "m2"]))).toBe(2);
    });

    it("a run that ends before any model call stores 0, not NULL", async () => {
      const { accountId } = await seedFreshAccount();
      expect(await stored(await terminalWithIds(accountId, []))).toBe(0);
    });

    it("a run with no terminal write (a runner crash) stays NULL, and a terminal write with no count leaves NULL", async () => {
      const { accountId } = await seedFreshAccount();
      const running = await insertPending(accountId);
      await writeRunStatus(db.runWriterPool, { accountId, runId: running, from: "pending", to: "running" });
      expect(await stored(running)).toBeNull();
      const lost = await insertPending(accountId);
      await writeRunStatus(db.runWriterPool, { accountId, runId: lost, from: "pending", to: "running" });
      await writeRunStatus(db.runWriterPool, { accountId, runId: lost, from: "running", to: "failed", metering: { meteredUsd: null, reportedUsd: null, flags: ["no_metering"] } });
      expect(await stored(lost)).toBeNull();
    });

    it("an app_user update of the column is refused", async () => {
      const { accountId } = await seedFreshAccount();
      const id = await insertPending(accountId);
      await expect(
        withTenant(db.pureAppUserPool, accountId, (c) => c.query(`UPDATE agent_runs SET metered_model_calls = 5 WHERE id = $1`, [id])),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await stored(id)).toBeNull();
    });

    it("write-once: a second terminal write cannot change it, and no later UPDATE can either", async () => {
      const { accountId } = await seedFreshAccount();
      const id = await terminalWithIds(accountId, ["m1", "m2"]);
      const again = await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "failed", metering: { meteredUsd: null, reportedUsd: null, flags: [], modelCalls: 9 } });
      expect(again).toEqual({ updated: false, currentStatus: "failed" });
      await expect(db.admin.query(`UPDATE agent_runs SET metered_model_calls = 9 WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
      expect(await stored(id)).toBe(2);
    });

    it("the count is only accepted together with a terminal status", async () => {
      const { accountId } = await seedFreshAccount();
      const id = await insertPending(accountId);
      await expect(
        writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running", metering: { meteredUsd: 0, reportedUsd: null, flags: [], modelCalls: 1 } }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(db.admin.query(`UPDATE agent_runs SET metered_model_calls = 1 WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
    });
  });
});
