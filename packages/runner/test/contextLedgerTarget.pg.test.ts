import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextLedgerCapture, type ContextLedgerMeasure, type ContextSection, type ContextSpill } from "@fulcrumaxe/runner-protocol";
import { buildExecutionRun, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = "b".repeat(64);

/** [pg] D#600 CX-1a: a sandbox run's stream measure reaches `run_context_ledger` once, at finalize, and never fails the run. */
describe("sandbox target records the context ledger [pg] (D#600 CX-1a)", () => {
  const db = pgHarness();

  function measureOf(): ContextLedgerMeasure {
    const c = new ContextLedgerCapture();
    c.observe({ type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 90 } } });
    c.observe({ type: "assistant", message: { id: "m2", content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 150 } } });
    return c.snapshot();
  }

  /** A started run whose fake port reports `measure` (when given) from its command stream, as the real port does at stream end. */
  async function started(measure: ContextLedgerMeasure | undefined, spill?: { written: boolean; value: ContextSpill }) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId, repoId, workItemId, role: "code-reviewer", product: "team", roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5, ...(spill ? { contextSpill: spill.value } : {}),
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    const h = createSandboxTargetHarness(db.runWriterPool);
    const port: SandboxPort = {
      ...h.deps.sandboxPort,
      startDetached(handle, opts) {
        const out = h.deps.sandboxPort.startDetached(handle, opts);
        if (measure !== undefined) opts.onContextLedger?.(measure);
        if (spill !== undefined && opts.spill === spill.value) opts.onSpill?.(spill.written);
        return out;
      },
    };
    const target = new SandboxTarget({ ...h.deps, sandboxPort: port });
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (result.status !== "running") throw new Error("run did not start");
    await sleep(30);
    return { accountId, id: result.id, target, run: buildExecutionRun(result.id, input) };
  }
  const rowsOf = (accountId: string, id: string) => db.admin.query("SELECT * FROM run_context_ledger WHERE account_id = $1 AND run_id = $2", [accountId, id]);
  const section = (code: string): ContextSection => ({ code: code as ContextSection["code"], bytes: 10, sha256: sha, trimmed_bytes: 0 });

  it("finalize stores the measure and the run's sections, and a second pass adds nothing", async () => {
    const s = await started(measureOf());
    const run = { ...s.run, contextSections: [section("card"), section("spec")] };
    await s.target.finalize(run, { status: "succeeded", usd: 0.1 });
    await s.target.finalize(run, { status: "succeeded", usd: 0.1 }).catch(() => undefined);
    const { rows } = await rowsOf(s.accountId, s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ basis: "measured", first_turn_input_tokens: "100", peak_context_tokens: "151", cache_read_tokens: "240", cache_write_tokens: "6", sections: [section("card"), section("spec")] });
  });

  it("D#601 MEM-3: the memory token figure of the run lands on the ledger row: N when memory was recalled, 0 when none was, and null only when the run never recalled (not recorded)", async () => {
    const recorded = async (memoryTokens: number | undefined) => {
      const s = await started(measureOf());
      await s.target.finalize({ ...s.run, contextSections: [section("card")], ...(memoryTokens === undefined ? {} : { memoryTokens }) }, { status: "succeeded", usd: 0.1 });
      const { rows } = await rowsOf(s.accountId, s.id);
      expect(rows).toHaveLength(1);
      return rows[0].memory_tokens;
    };
    expect(await recorded(1234)).toBe("1234");
    expect(await recorded(0)).toBe("0");
    // The column is nullable by design: a fix round or a runner run never asked the store, so its figure is "not recorded", not a zero.
    expect(await recorded(undefined)).toBeNull();
  });

  it("a run whose stream gave no measure has no row (the screen says Not recorded), and the run still finalizes", async () => {
    const s = await started(undefined);
    await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
    expect((await rowsOf(s.accountId, s.id)).rows).toEqual([]);
  });

  it("a refused ledger write (an unknown section code) is reported, writes nothing and does not fail finalize", async () => {
    const s = await started(measureOf());
    await expect(s.target.finalize({ ...s.run, contextSections: [section("not_a_section")] }, { status: "succeeded", usd: 0.1 })).resolves.toBeDefined();
    expect((await rowsOf(s.accountId, s.id)).rows).toEqual([]);
  });

  // D#600 CX-4a: the spill reaches the port, and the ledger records the sections of the prompt that went out.
  describe("the spill and the sections of the prompt that went out (CX-4a)", () => {
    const cutSections: ContextSection[] = [{ ...section("note"), bytes: 40, trimmed_bytes: 3000, trimmed_reason: "over_budget" }, section("spec")];
    const uncutSections: ContextSection[] = [{ ...section("note"), bytes: 3040 }, section("spec")];
    const spillValue: ContextSpill = { files: [{ code: "note", text: "N".repeat(3000) }], uncut: { prompt: "uncut", sections: uncutSections } };

    it("a written spill records the cut sections with their trimmed_reason", async () => {
      const s = await started(measureOf(), { written: true, value: spillValue });
      await s.target.finalize({ ...s.run, contextSections: cutSections, contextSpill: spillValue }, { status: "succeeded", usd: 0.1 });
      expect((await rowsOf(s.accountId, s.id)).rows[0].sections).toEqual(cutSections);
    });

    it("a spill that could not be written records the uncut sections: trimmed_bytes 0 and no reason", async () => {
      const s = await started(measureOf(), { written: false, value: spillValue });
      await s.target.finalize({ ...s.run, contextSections: cutSections, contextSpill: spillValue }, { status: "succeeded", usd: 0.1 });
      const sections = (await rowsOf(s.accountId, s.id)).rows[0].sections as ContextSection[];
      expect(sections).toEqual(uncutSections);
      expect(sections.every((x) => x.trimmed_bytes === 0 && !("trimmed_reason" in x))).toBe(true);
    });
  });
});
