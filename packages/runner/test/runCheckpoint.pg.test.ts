import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { insertAgentRun, recordLimitExtended, writeRunStatus, type WriteRunStatusParams } from "../src/runStatusWriter.js";
import { seedAccount } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#2 H14c-5b-2a (C48 LIMIT-END, C54 section 2): the checkpoint row is written
 * by `writeRunStatus` through the private, redacting `insertRunEvent`, in the
 * status change's own transaction. [pg]: real Postgres, zero model tokens.
 */
describe("writeRunStatus checkpoint [pg]", () => {
  const db = pgHarness();
  const checkpoint = { kind: "run_time", ccSessionId: "cc-1", meteredUsd: 1.25, extensionsUsed: 0 };

  async function runningRun(): Promise<{ accountId: string; runId: string }> {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    const { id: runId } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
    return { accountId, runId };
  }
  const events = async (runId: string) =>
    (await db.admin.query(`SELECT kind, payload FROM run_events WHERE run_id = $1 ORDER BY seq`, [runId])).rows as Array<{ kind: string; payload: Record<string, unknown> }>;
  const statusOf = async (runId: string) => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status;

  it("one checkpoint row follows run.status_changed, with the reason, kind, session, metered spend and extensions", async () => {
    const { accountId, runId } = await runningRun();
    await expect(writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "timed_out", checkpoint })).resolves.toEqual({ updated: true });
    const rows = await events(runId);
    expect(rows.map((r) => r.kind)).toEqual(["run.created", "run.status_changed", "run.status_changed", "checkpoint"]);
    expect(rows[3]!.payload).toEqual({ reason: "limit", kind: "run_time", cc_session_id: "cc-1", metered_usd: 1.25, extensions_used: 0 });
  });

  it("the status change and the checkpoint commit or roll back together", async () => {
    const { accountId, runId } = await runningRun();
    // A BigInt cannot be serialized, so the checkpoint insert throws AFTER the status update ran.
    const poisoned = { ...checkpoint, ccSessionId: 10n as unknown as string };
    await expect(writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "timed_out", checkpoint: poisoned })).rejects.toThrow();
    expect(await statusOf(runId)).toBe("running");
    expect((await events(runId)).map((r) => r.kind)).toEqual(["run.created", "run.status_changed"]);
  });

  it("a zero-row compare-and-set writes no checkpoint", async () => {
    const { accountId, runId } = await runningRun();
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "cancelled" });
    await expect(writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "timed_out", checkpoint })).resolves.toEqual({ updated: false, currentStatus: "cancelled" });
    expect((await events(runId)).filter((r) => r.kind === "checkpoint")).toEqual([]);
  });

  it.each<[string, Partial<WriteRunStatusParams>]>([
    ["to failed", { to: "failed" }],
    ["per_run_usd on timed_out", { to: "timed_out", checkpoint: { ...checkpoint, kind: "per_run_usd" } }],
    ["run_time on killed_spend", { to: "killed_spend" }],
    ["an unknown kind", { to: "timed_out", checkpoint: { ...checkpoint, kind: "whatever" } }],
    ["from pending", { from: "pending", to: "timed_out" }],
  ])("a checkpoint %s is refused before any query", async (_label, override) => {
    // A pool that would fail any query: the refusal must come first.
    const pool = { connect: () => Promise.reject(new Error("a query was attempted")) } as unknown as Pool;
    const params = { accountId: randomUUID(), runId: randomUUID(), from: "running", to: "timed_out", checkpoint, ...override } as WriteRunStatusParams;
    await expect(writeRunStatus(pool, params)).rejects.toThrow(/checkpoint needs/);
  });

  it("per_run_usd is accepted on running -> killed_spend", async () => {
    const { accountId, runId } = await runningRun();
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "killed_spend", checkpoint: { ...checkpoint, kind: "per_run_usd" } });
    expect((await events(runId)).at(-1)).toMatchObject({ kind: "checkpoint", payload: { kind: "per_run_usd" } });
  });

  it("W-3: an agent checkpoint writes reason agent_checkpoint with a sanitized, capped summary", async () => {
    const { accountId, runId } = await runningRun();
    const agent = { reason: "agent_checkpoint" as const, summary: `left\u0000 B ${"z".repeat(5000)}`, ccSessionId: "cc-1", meteredUsd: 2, extensionsUsed: 0 };
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "timed_out", checkpoint: agent });
    const last = (await events(runId)).at(-1)!;
    expect(last.kind).toBe("checkpoint");
    expect(last.payload).toMatchObject({ reason: "agent_checkpoint", cc_session_id: "cc-1", metered_usd: 2, extensions_used: 0 });
    expect(last.payload.summary).toBe(`left B ${"z".repeat(4096 - "left B ".length)}`);
    expect(last.payload.kind).toBeUndefined();
    expect(await statusOf(runId)).toBe("timed_out");
  });

  it("X-4: recordLimitExtended writes one limit_extended row, and the later checkpoint carries the count", async () => {
    const { accountId, runId } = await runningRun();
    const progress = { usage_rose: true as const, gh_writes: 1, new_message_ids: 6 };
    await recordLimitExtended(db.runWriterPool, { accountId, runId, kind: "run_time", extensionsUsed: 1, newLimit: 5_400_000, progress });
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "timed_out", checkpoint: { ...checkpoint, extensionsUsed: 1 } });
    const rows = await events(runId);
    expect(rows.map((r) => r.kind)).toEqual(["run.created", "run.status_changed", "limit_extended", "run.status_changed", "checkpoint"]);
    expect(rows[2]!.payload).toEqual({ kind: "run_time", extensions_used: 1, new_limit: 5_400_000, progress });
    expect(rows[4]!.payload).toMatchObject({ extensions_used: 1 });
  });

  it("the payload is redacted: a planted key in cc_session_id does not survive", async () => {
    const { accountId, runId } = await runningRun();
    const planted = "sk-ant-api03-" + "A".repeat(40);
    await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "timed_out", checkpoint: { ...checkpoint, ccSessionId: planted } });
    const stored = JSON.stringify((await events(runId)).at(-1));
    expect(stored).not.toContain(planted);
    expect(stored).toContain("[redacted]");
  });
});
