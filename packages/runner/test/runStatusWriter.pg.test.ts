import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { IllegalRunTransitionError } from "../src/statusTransitions.js";
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
});
