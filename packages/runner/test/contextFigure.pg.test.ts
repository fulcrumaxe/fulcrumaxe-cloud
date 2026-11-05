import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { seedAccount as seedTenant } from "@fx/db/test/helpers/seed.js";
import { ContextLedgerInvalid, recordContextFigure } from "../src/contextLedgerWriter.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * [pg] D#600 CX-9b (migration 0989): the run's context figure, through the writer the sandbox target and the runner's done path both call, on the real run-writer login
 * and a real app_user login. The writer is the code under test; the table's own CHECKs, grants and row security are what it meets.
 */
describe("run context figure [pg] (D#600 CX-9b)", () => {
  const db = pgHarness();
  const seed = () => seedTenant(db.admin, randomUUID());
  const rows = (accountId: string, runId: string) => db.admin.query("SELECT last_context_tokens, window_tokens FROM run_context_figure WHERE account_id = $1 AND run_id = $2", [accountId, runId]);
  const write = (accountId: string, runId: string, lastContextTokens: number, windowTokens?: number, tenant = accountId) =>
    withTenant(db.runWriterPool, tenant, (client) => recordContextFigure(client, { accountId, runId, lastContextTokens, windowTokens }));

  it("stores the latest turn's context and the window, and a later write replaces the figure (a live run, then its end)", async () => {
    const A = await seed();
    await write(A.accountId, A.runId, 60_000, 200_000);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([{ last_context_tokens: "60000", window_tokens: "200000" }]);
    await write(A.accountId, A.runId, 150_000, 200_000);
    // After a compaction the context falls, and the stored figure follows it: it is the current context, not the peak.
    await write(A.accountId, A.runId, 40_000, 200_000);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([{ last_context_tokens: "40000", window_tokens: "200000" }]);
  });

  it("a model with no window stores NULL for it (window not known), and a later write without a window keeps a stored one", async () => {
    const A = await seed();
    await write(A.accountId, A.runId, 5_000);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([{ last_context_tokens: "5000", window_tokens: null }]);
    await write(A.accountId, A.runId, 6_000, 200_000);
    await write(A.accountId, A.runId, 7_000);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([{ last_context_tokens: "7000", window_tokens: "200000" }]);
  });

  it.each([
    ["a negative figure", -1, 200_000],
    ["a fractional figure", 1.5, 200_000],
    ["a figure past the cap", 1_000_000_000_001, 150_000],
    ["NaN", Number.NaN, 200_000],
    ["a zero window", 10, 0],
    ["a negative window", 10, -5],
    ["a fractional window", 10, 1.5],
    ["a window past the cap", 10, 10_000_001],
  ])("refuses %s before anything is sent, and writes nothing", async (_name, last, window) => {
    const A = await seed();
    await expect(write(A.accountId, A.runId, last, window)).rejects.toBeInstanceOf(ContextLedgerInvalid);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
  });

  it("the table's own CHECKs hold even for a caller that skips the writer", async () => {
    const A = await seed();
    await expect(withTenant(db.runWriterPool, A.accountId, (c) => c.query("INSERT INTO run_context_figure (account_id, run_id, last_context_tokens, window_tokens) VALUES ($1, $2, -1, NULL)", [A.accountId, A.runId]))).rejects.toMatchObject({ code: "23514" });
    await expect(withTenant(db.runWriterPool, A.accountId, (c) => c.query("INSERT INTO run_context_figure (account_id, run_id, last_context_tokens, window_tokens) VALUES ($1, $2, 1, 0)", [A.accountId, A.runId]))).rejects.toMatchObject({ code: "23514" });
  });

  it("another account's run cannot be written from this tenant's session (row security), nor a run that does not exist (foreign key)", async () => {
    const A = await seed();
    const B = await seed();
    await expect(write(B.accountId, B.runId, 10, 100, A.accountId)).rejects.toMatchObject({ code: "42501" });
    await expect(write(A.accountId, B.runId, 10, 100)).rejects.toMatchObject({ code: "23503" });
    await expect(write(A.accountId, randomUUID(), 10, 100)).rejects.toMatchObject({ code: "23503" });
    expect((await rows(B.accountId, B.runId)).rows).toEqual([]);
  });

  it("the run-writer login can neither delete a row, nor move it to another run, nor change its account", async () => {
    const A = await seed();
    await write(A.accountId, A.runId, 10, 100);
    await expect(withTenant(db.runWriterPool, A.accountId, (c) => c.query("DELETE FROM run_context_figure WHERE run_id = $1", [A.runId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(db.runWriterPool, A.accountId, (c) => c.query("UPDATE run_context_figure SET run_id = $2 WHERE run_id = $1", [A.runId, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(db.runWriterPool, A.accountId, (c) => c.query("UPDATE run_context_figure SET account_id = $2 WHERE run_id = $1", [A.runId, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    expect((await rows(A.accountId, A.runId)).rows).toHaveLength(1);
  });

  it("a member's session (app_user) reads its own account's row and nobody else's, and writes nothing", async () => {
    const A = await seed();
    const B = await seed();
    await write(A.accountId, A.runId, 10, 100);
    const read = (tenant: string) => withTenant(db.pureAppUserPool, tenant, (c) => c.query("SELECT last_context_tokens FROM run_context_figure WHERE run_id = $1", [A.runId]));
    expect((await read(A.accountId)).rows).toEqual([{ last_context_tokens: "10" }]);
    expect((await read(B.accountId)).rows).toEqual([]);
    await expect(withTenant(db.pureAppUserPool, A.accountId, (c) => c.query("UPDATE run_context_figure SET last_context_tokens = 99 WHERE run_id = $1", [A.runId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(db.pureAppUserPool, A.accountId, (c) => c.query("INSERT INTO run_context_figure (account_id, run_id, last_context_tokens) VALUES ($1, $2, 1)", [A.accountId, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(db.pureAppUserPool, A.accountId, (c) => c.query("DELETE FROM run_context_figure WHERE run_id = $1", [A.runId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("the figure goes with its run (ON DELETE CASCADE)", async () => {
    const A = await seed();
    await write(A.accountId, A.runId, 10, 100);
    await db.admin.query("DELETE FROM agent_runs WHERE id = $1", [A.runId]);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
  });
});
