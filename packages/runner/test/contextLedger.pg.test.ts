import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { seedAccount as seedTenant } from "@fx/db/test/helpers/seed.js";
import { ContextLedgerCapture, NOT_RECORDED_MEASURE, type ContextSection } from "@fulcrumaxe/runner-protocol";
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

  // D#600 CX-2b (migration 0869): the dispatch writes the cloud's sections with nothing measured; the runner's `done` adds to that row.
  describe("the cloud's sections first, the runner's measure after (CX-2b)", () => {
    const sha2 = "b".repeat(64);
    const mapSection = (bytes: number): ContextSection => ({ code: "map", bytes, sha256: sha2, trimmed_bytes: 0 });
    const dispatchWrite = (A: { accountId: string; runId: string }, sections: ContextSection[]) =>
      withTenant(db.runWriterPool, A.accountId, (client) => recordContextLedger(client, { accountId: A.accountId, runId: A.runId, sections, measure: NOT_RECORDED_MEASURE }));

    it("the dispatch write is a partial row of the sections with every figure null, never 0", async () => {
      const A = await seed();
      await dispatchWrite(A, [section("boundary", 40), section("spec", 200), section("output", 30)]);
      const { rows: r } = await rows(A.accountId, A.runId);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ basis: "partial", first_turn_input_tokens: null, peak_context_tokens: null, cache_read_tokens: null, cache_write_tokens: null, memory_tokens: null, compactions: 0, tool_output_bytes: {} });
      expect(r[0].sections).toEqual([section("boundary", 40), section("spec", 200), section("output", 30)]);
    });

    it("the runner's done then makes the row measured and its map entry joins the cloud's sections; every other cloud entry stays", async () => {
      const A = await seed();
      await dispatchWrite(A, [section("boundary", 40), section("spec", 200), section("output", 30)]);
      await record(A.accountId, A.runId, [mapSection(900)], measureOf(usage("r1", 12_000, 600, 19)));
      const { rows: r } = await rows(A.accountId, A.runId);
      expect(r[0]).toMatchObject({ basis: "measured", first_turn_input_tokens: "12619", peak_context_tokens: "12619" });
      expect(r[0].sections).toEqual([section("boundary", 40), section("spec", 200), section("output", 30), mapSection(900)]);
    });

    it("a map entry from the runner replaces the cloud's map in place, so there is one map entry", async () => {
      const A = await seed();
      await dispatchWrite(A, [section("boundary", 40), { ...mapSection(100), sha256: sha }, section("spec", 200)]);
      await record(A.accountId, A.runId, [mapSection(900)], measureOf(usage("r1", 10, 0, 0)));
      const { rows: r } = await rows(A.accountId, A.runId);
      expect(r[0].sections).toEqual([section("boundary", 40), mapSection(900), section("spec", 200)]);
    });

    it("the runner cannot change the cloud's figures for any other code, and cannot add one", async () => {
      const A = await seed();
      await dispatchWrite(A, [section("boundary", 40), section("spec", 200)]);
      await record(A.accountId, A.runId, [section("spec", 999_999), section("findings", 5), section("note", 6)], measureOf(usage("r1", 10, 0, 0)));
      const { rows: r } = await rows(A.accountId, A.runId);
      expect(r[0].sections).toEqual([section("boundary", 40), section("spec", 200)]);
    });

    it("a runner that sends no ledger leaves the cloud's sections, partial, with nothing measured", async () => {
      const A = await seed();
      await dispatchWrite(A, [section("boundary", 40), section("spec", 200)]);
      await record(A.accountId, A.runId, [], NOT_RECORDED_MEASURE);
      const { rows: r } = await rows(A.accountId, A.runId);
      expect(r[0]).toMatchObject({ basis: "partial", first_turn_input_tokens: null, peak_context_tokens: null, compactions: 0 });
      expect(r[0].sections).toEqual([section("boundary", 40), section("spec", 200)]);
    });

    it("the same dispatch recorded twice changes nothing", async () => {
      const A = await seed();
      await dispatchWrite(A, [section("boundary", 40), section("spec", 200)]);
      await dispatchWrite(A, [section("boundary", 40), section("spec", 200)]);
      expect((await rows(A.accountId, A.runId)).rows[0].sections).toEqual([section("boundary", 40), section("spec", 200)]);
    });

    it("several sections of one code are kept as sent (a note per note, the boundary around the card)", async () => {
      const A = await seed();
      const sent = [section("boundary", 10), section("card", 20), section("boundary", 5), section("note", 7), { ...section("note", 8), sha256: sha2 }];
      await dispatchWrite(A, sent);
      expect((await rows(A.accountId, A.runId)).rows[0].sections).toEqual(sent);
    });

    it("a row that already measured something stays partial when a later command measured nothing (the old rule)", async () => {
      const A = await seed();
      await record(A.accountId, A.runId, [], measureOf(usage("a", 1, 1, 8)));
      await record(A.accountId, A.runId, [], measureOf({ type: "system", subtype: "init" }));
      expect((await rows(A.accountId, A.runId)).rows[0]).toMatchObject({ basis: "partial", first_turn_input_tokens: "10" });
    });

    it("a map entry on a row that has sections but no map is appended; the row never exceeds 64 entries", async () => {
      const A = await seed();
      await dispatchWrite(A, Array.from({ length: 64 }, (_, i) => ({ ...section("note", i + 1) })));
      await record(A.accountId, A.runId, [mapSection(9)], measureOf(usage("a", 1, 1, 8)));
      const { rows: r } = await rows(A.accountId, A.runId);
      expect(r[0].sections).toHaveLength(64);
      const B = await seed();
      await dispatchWrite(B, [section("spec", 5)]);
      await record(B.accountId, B.runId, [mapSection(9)], measureOf(usage("a", 1, 1, 8)));
      expect((await rows(B.accountId, B.runId)).rows[0].sections).toEqual([section("spec", 5), mapSection(9)]);
    });
  });

  // D#600 CX-4a (migration 0870): the `pinned` code and the `trimmed_reason` on a section, against the real definer. Acceptance 4.
  describe("pinned and trimmed_reason (CX-4a)", () => {
    const cut = (code: string, reason: unknown, trimmed = 40): Record<string, unknown> => ({ ...section(code, 100, trimmed), trimmed_reason: reason });

    it("a pinned section is a known code and is stored", async () => {
      const A = await seed();
      await record(A.accountId, A.runId, [section("pinned", 300), section("spec", 200)]);
      expect((await rows(A.accountId, A.runId)).rows[0].sections).toEqual([section("pinned", 300), section("spec", 200)]);
    });

    it.each(["findings_cap", "memory_slot", "over_budget"])("stores trimmed_reason %s with its section", async (reason) => {
      const A = await seed();
      await record(A.accountId, A.runId, [section("boundary", 10), cut("memory_item", reason), section("spec", 20)]);
      expect((await rows(A.accountId, A.runId)).rows[0].sections).toEqual([section("boundary", 10), cut("memory_item", reason), section("spec", 20)]);
    });

    it.each([
      ["an unknown reason", [cut("note", "too_big")]],
      ["a reason that is not a string", [cut("note", 3)]],
      ["a null reason", [cut("note", null)]],
      ["an empty reason", [cut("note", "")]],
      ["a reason in another case", [cut("note", "Over_Budget")]],
      ["an unknown code beside a valid reason", [cut("note", "over_budget"), section("surprise")]],
      ["a reason plus another unknown key", [{ ...cut("note", "over_budget"), path: "/etc/passwd" }]],
      ["two unknown keys and no reason", [{ ...section("note"), a: 1, b: 2 }]],
    ])("refuses %s with invalid_message and writes nothing", async (_name, sections) => {
      const A = await seed();
      await expect(record(A.accountId, A.runId, sections)).rejects.toBeInstanceOf(ContextLedgerInvalid);
      expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
    });

    it("a section without a reason is still valid, so a row recorded before 0870 reads the same", async () => {
      const A = await seed();
      await record(A.accountId, A.runId, [section("note", 10, 0)]);
      expect(((await rows(A.accountId, A.runId)).rows[0].sections as Array<Record<string, unknown>>)[0]).not.toHaveProperty("trimmed_reason");
    });
  });

  // D#600 CX-10a (migration 0883): tool call counts and the cloud's assembly time, through the real definer and the real run-writer login.
  describe("tool call counts and assembly time (CX-10a)", () => {
    const base = () => measureOf(usage("m1", 10, 20, 30));
    const withCounts = (tool_call_counts: Record<string, number>) => ({ ...base(), tool_call_counts: tool_call_counts as never });
    const recordWith = (accountId: string, runId: string, measure: ReturnType<typeof base>, assembly?: { ms: number; cold?: boolean }) =>
      withTenant(db.runWriterPool, accountId, (client) => recordContextLedger(client, { accountId, runId, sections: [], measure, ...(assembly ? { assembly } : {}) }));
    const cx = async (accountId: string, runId: string) => (await rows(accountId, runId)).rows.map((r) => [r.tool_call_counts, r.assembly_ms, r.assembly_cold]);

    it("records {Read:3,Grep:1}, assembly 120 ms and a warm map, and reads them back for the same account only", async () => {
      const A = await seed();
      const B = await seed();
      await recordWith(A.accountId, A.runId, withCounts({ Read: 3, Grep: 1 }), { ms: 120, cold: false });
      expect(await cx(A.accountId, A.runId)).toEqual([[{ Read: 3, Grep: 1 }, 120, false]]);
      const read = (tenant: string) => withTenant(db.pureAppUserPool, tenant, (c) => c.query("SELECT tool_call_counts, assembly_ms, assembly_cold FROM run_context_ledger WHERE run_id = $1", [A.runId]));
      expect((await read(A.accountId)).rows).toEqual([{ tool_call_counts: { Read: 3, Grep: 1 }, assembly_ms: 120, assembly_cold: false }]);
      expect((await read(B.accountId)).rows).toEqual([]);
    });

    it.each([
      ["a tool outside the closed list", withCounts({ Evil: 1 })],
      ["a negative count", withCounts({ Read: -1 })],
      ["a fractional count", withCounts({ Read: 1.5 })],
      ["a count over 1,000,000", withCounts({ Read: 1_000_001 })],
    ])("refuses %s with invalid_message and writes nothing", async (_name, measure) => {
      const A = await seed();
      await expect(recordWith(A.accountId, A.runId, measure as never)).rejects.toBeInstanceOf(ContextLedgerInvalid);
      expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
    });

    it("refuses an assembly time out of range (negative, over 3,600,000, fractional) and accepts both ends", async () => {
      const A = await seed();
      for (const ms of [-1, 3_600_001, 1.5]) await expect(recordWith(A.accountId, A.runId, base(), { ms }), String(ms)).rejects.toBeInstanceOf(ContextLedgerInvalid);
      expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
      const lo = await seed();
      await recordWith(lo.accountId, lo.runId, base(), { ms: 0 });
      const hi = await seed();
      await recordWith(hi.accountId, hi.runId, base(), { ms: 3_600_000, cold: true });
      expect(await cx(lo.accountId, lo.runId)).toEqual([[{}, 0, null]]);
      expect(await cx(hi.accountId, hi.runId)).toEqual([[{}, 3_600_000, true]]);
    });

    it("a second call adds the counts per tool and keeps the first assembly values, even when the second carries others", async () => {
      const A = await seed();
      await recordWith(A.accountId, A.runId, withCounts({ Read: 3, Grep: 1 }), { ms: 120, cold: false });
      await recordWith(A.accountId, A.runId, withCounts({ Read: 2, Bash: 4 }), { ms: 900, cold: true });
      expect(await cx(A.accountId, A.runId)).toEqual([[{ Read: 5, Grep: 1, Bash: 4 }, 120, false]]);
    });

    it("a later call fills a value the first left null, and a call that carries none leaves the row's", async () => {
      const A = await seed();
      await recordWith(A.accountId, A.runId, base(), { ms: 40 });
      await recordWith(A.accountId, A.runId, withCounts({ Glob: 2 }), { ms: 99, cold: true });
      await recordWith(A.accountId, A.runId, base());
      expect(await cx(A.accountId, A.runId)).toEqual([[{ Glob: 2 }, 40, true]]);
    });

    it("a caller that omits the new fields stores NULL, not 0, and the row still satisfies the basis check (the dispatch write and an older runner)", async () => {
      const A = await seed();
      await recordWith(A.accountId, A.runId, NOT_RECORDED_MEASURE as never);
      const { rows: r } = await rows(A.accountId, A.runId);
      expect(r[0]).toMatchObject({ basis: "partial", tool_call_counts: null, assembly_ms: null, assembly_cold: null });
      // The eleven- and twelve-argument calls still resolve to the one function.
      const B = await seed();
      await withTenant(db.runWriterPool, B.accountId, async (c) => {
        await c.query("SELECT run_context_ledger_record($1::uuid, $2::uuid, '[]'::jsonb, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, 0, 'partial')", [B.accountId, B.runId]);
        await c.query("SELECT run_context_ledger_record($1::uuid, $2::uuid, '[]'::jsonb, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, 0, 'partial', 1)", [B.accountId, B.runId]);
      });
      expect(await cx(B.accountId, B.runId)).toEqual([[null, null, null]]);
    });

    it("a platform_ops login cannot call the function", async () => {
      const A = await seed();
      await db.admin.query("SET SESSION AUTHORIZATION platform_ops");
      try {
        await db.admin.query("SELECT set_config('app.account_id', $1, false)", [A.accountId]);
        await expect(db.admin.query("SELECT run_context_ledger_record($1::uuid, $2::uuid, '[]'::jsonb, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, 0, 'partial', NULL, '{\"Read\":1}'::jsonb, 5, true)", [A.accountId, A.runId])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.admin.query("RESET SESSION AUTHORIZATION");
      }
      expect((await rows(A.accountId, A.runId)).rows).toEqual([]);
    });
  });
});
