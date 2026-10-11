import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { seedAccount as seedTenant } from "@fx/db/test/helpers/seed.js";
import { ContextLedgerCapture, type ContextSection } from "@fulcrumaxe/runner-protocol";
import { ContextLedgerInvalid, recordContextLedger } from "../src/contextLedgerWriter.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * [pg] D#600 CX-1a (migration 0792), acceptance 3 and 4 and the capture-to-row path, against the real definer, the real run-writer login
 * and a real app_user login.
 */
describe("run context ledger [pg] (D#600 CX-1a)", () => {
  const db = pgHarness();
  const sha = "a".repeat(64);
  const section = (code: string, bytes = 100, trimmed = 0): ContextSection => ({ code: code as ContextSection["code"], bytes, sha256: sha, trimmed_bytes: trimmed });

  const usage = (id: string, input: number, write: number, read: number) => ({ type: "assistant", message: { id, content: [], usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read } } });
  function measureOf(...lines: unknown[]) {
    const c = new ContextLedgerCapture();
    for (const l of lines) c.observe(l);
    return c.snapshot();
  }

  async function seed() {
    const refs = await seedTenant(db.admin, randomUUID());
    return refs;
  }
  const rows = (accountId: string, runId: string) => db.admin.query("SELECT * FROM run_context_ledger WHERE account_id = $1 AND run_id = $2", [accountId, runId]);
  const record = (accountId: string, runId: string, sections: unknown, measure = measureOf(usage("m1", 10, 20, 30)), tenant = accountId) =>
    withTenant(db.runWriterPool, tenant, (client) => recordContextLedger(client, { accountId, runId, sections: sections as ContextSection[], measure }));

  it("stores a measured row: sections, per-turn figures from the capture, tool bytes and compactions", async () => {
    const A = await seed();
    const m = measureOf(
      usage("m1", 10, 20, 30),
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t", name: "Grep", input: {} }], usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "12345" }] } },
      usage("m2", 1, 2, 500),
      { type: "system", subtype: "compact_boundary" },
    );
    await record(A.accountId, A.runId, [section("card", 10), section("spec", 20, 4), section("findings")], m);
    const { rows: r } = await rows(A.accountId, A.runId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ basis: "measured", compactions: 1, tool_output_bytes: { Grep: 5 } });
    expect([r[0].first_turn_input_tokens, r[0].peak_context_tokens, r[0].cache_read_tokens, r[0].cache_write_tokens, r[0].memory_tokens]).toEqual(["60", "503", "530", "22", null]);
    expect(r[0].sections).toEqual([section("card", 10), section("spec", 20, 4), section("findings")]);
  });

  it("a partial measure stores nulls (Not recorded), never zeros", async () => {
    const A = await seed();
    await record(A.accountId, A.runId, [], measureOf({ type: "system", subtype: "init" }));
    const { rows: r } = await rows(A.accountId, A.runId);
    expect(r[0]).toMatchObject({ basis: "partial", first_turn_input_tokens: null, peak_context_tokens: null, cache_read_tokens: null, cache_write_tokens: null, sections: [], compactions: 0 });
  });

  it("an unknown section code is refused as invalid_message and nothing is written", async () => {
    const A = await seed();
    await expect(record(A.accountId, A.runId, [section("card"), section("surprise")])).rejects.toBeInstanceOf(ContextLedgerInvalid);
    await expect(record(A.accountId, A.runId, [section("card"), section("surprise")])).rejects.toMatchObject({ code: "invalid_message" });
    expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
  });

  it.each([
    ["an extra key on a section", [{ ...section("card"), path: "/etc/passwd" }]],
    ["a missing key", [{ code: "card", bytes: 1, sha256: sha }]],
    ["a bad hash", [{ ...section("card"), sha256: "XYZ" }]],
    ["a negative size", [{ ...section("card"), bytes: -1 }]],
    ["a fractional size", [{ ...section("card"), bytes: 1.5 }]],
    ["a string size", [{ ...section("card"), bytes: "7" }]],
    ["a non-array", { card: 1 }],
    ["more than 64 sections", Array.from({ length: 65 }, () => section("note"))],
  ])("refuses %s with invalid_message and writes nothing", async (_name, sections) => {
    const A = await seed();
    await expect(record(A.accountId, A.runId, sections)).rejects.toBeInstanceOf(ContextLedgerInvalid);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
  });

  it("refuses a tool name outside the enum, a non-integer byte count and a peak below the first turn", async () => {
    const A = await seed();
    const base = measureOf(usage("m", 1, 2, 3));
    await expect(record(A.accountId, A.runId, [], { ...base, tool_output_bytes: { Evil: 1 } as never })).rejects.toBeInstanceOf(ContextLedgerInvalid);
    await expect(record(A.accountId, A.runId, [], { ...base, tool_output_bytes: { Read: 1.5 } })).rejects.toBeInstanceOf(ContextLedgerInvalid);
    await expect(record(A.accountId, A.runId, [], { ...base, first_turn_input_tokens: 10, peak_context_tokens: 5 })).rejects.toBeInstanceOf(ContextLedgerInvalid);
    await expect(record(A.accountId, A.runId, [], { ...base, basis: "measured", first_turn_input_tokens: null })).rejects.toBeInstanceOf(ContextLedgerInvalid);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
  });

  it("a second command of the same run merges: first turn and sections stay, the peak is the larger, sums add", async () => {
    const A = await seed();
    await record(A.accountId, A.runId, [section("spec", 5)], measureOf(usage("a", 1, 1, 8), { type: "system", subtype: "compact_boundary" }));
    await record(A.accountId, A.runId, [section("note", 9)], measureOf(usage("b", 1, 1, 98)));
    const { rows: r } = await rows(A.accountId, A.runId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ basis: "measured", compactions: 1, sections: [section("spec", 5)] });
    expect([r[0].first_turn_input_tokens, r[0].peak_context_tokens, r[0].cache_read_tokens, r[0].cache_write_tokens]).toEqual(["10", "100", "106", "2"]);
  });

  it("an account-B read of an account-A ledger row returns no rows (row security is forced); account A reads its own", async () => {
    const A = await seed();
    const B = await seed();
    await record(A.accountId, A.runId, [section("card")]);
    const read = (tenant: string) => withTenant(db.pureAppUserPool, tenant, (c) => c.query("SELECT run_id FROM run_context_ledger WHERE run_id = $1", [A.runId]));
    expect((await read(B.accountId)).rows).toEqual([]);
    expect((await read(A.accountId)).rows).toHaveLength(1);
    const flags = await db.admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'run_context_ledger'");
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it("the writer cannot record for another account's run or name another tenant, and a run that does not exist is refused", async () => {
    const A = await seed();
    const B = await seed();
    await expect(record(A.accountId, A.runId, [], undefined, B.accountId)).rejects.toMatchObject({ code: "42501" });
    await expect(record(B.accountId, A.runId, [])).rejects.toMatchObject({ code: "42501" });
    await expect(record(A.accountId, randomUUID(), [])).rejects.toMatchObject({ code: "42501" });
    expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
  });

  it("app_user can neither call the function nor write the table; the row goes with its run", async () => {
    const A = await seed();
    await expect(
      withTenant(db.pureAppUserPool, A.accountId, (c) => c.query("SELECT run_context_ledger_record($1::uuid, $2::uuid, '[]'::jsonb, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, 0, 'partial')", [A.accountId, A.runId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(db.pureAppUserPool, A.accountId, (c) => c.query("INSERT INTO run_context_ledger (account_id, run_id, basis) VALUES ($1, $2, 'partial')", [A.accountId, A.runId])),
    ).rejects.toMatchObject({ code: "42501" });
    await record(A.accountId, A.runId, []);
    await db.admin.query("DELETE FROM agent_runs WHERE id = $1", [A.runId]);
    expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
  });
});
