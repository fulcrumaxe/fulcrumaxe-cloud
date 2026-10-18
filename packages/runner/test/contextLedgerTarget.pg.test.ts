import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextLedgerCapture, type ContextLedgerMeasure, type ContextSection, type ContextSpill } from "@fulcrumaxe/runner-protocol";
import { buildExecutionRun, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort, StartDetachedOptions } from "../src/sandboxPort.js";
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

  it("D#600 CX-10a: finalize stores the stream's tool call counts and the cloud's assembly time and cold flag; a run that carries no assembly leaves them null", async () => {
    const c = new ContextLedgerCapture();
    c.observe({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "a", name: "Read", input: {} }, { type: "tool_use", id: "b", name: "Read", input: {} }, { type: "tool_use", id: "c", name: "Grep", input: {} }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    const s = await started(c.snapshot());
    await s.target.finalize({ ...s.run, contextSections: [section("card")], contextAssembly: { ms: 120, cold: false } }, { status: "succeeded", usd: 0.1 });
    expect((await rowsOf(s.accountId, s.id)).rows[0]).toMatchObject({ tool_call_counts: { Read: 2, Grep: 1 }, assembly_ms: 120, assembly_cold: false });
    const bare = await started(c.snapshot());
    await bare.target.finalize({ ...bare.run, contextSections: [section("card")] }, { status: "succeeded", usd: 0.1 });
    expect((await rowsOf(bare.accountId, bare.id)).rows[0]).toMatchObject({ tool_call_counts: { Read: 2, Grep: 1 }, assembly_ms: null, assembly_cold: null });
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

/** [pg] D#600 CX-5b: the denial count lands on the sandbox row, and the excludes the port is given are the rules as they stand at each launch. */
describe("sandbox target: excludes and the denial count [pg] (D#600 CX-5b)", () => {
  const db = pgHarness();
  const measureOf = (): ContextLedgerMeasure => {
    const c = new ContextLedgerCapture();
    c.observe({ type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 90 } } });
    return c.snapshot();
  };

  async function world() {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const rule = (scope: "repo" | "item", kind: "pin" | "exclude", path: string) =>
      db.admin.query(`INSERT INTO context_rules (account_id, scope, repo_id, work_item_id, kind, path, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [accountId, scope, scope === "repo" ? repoId : null, scope === "item" ? workItemId : null, kind, path, userId]);
    const input: StartAgentRunInput = {
      accountId, repoId, workItemId, role: "code-reviewer", product: "team", roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    // The target's own pool, failing ONLY the query on context_rules while `rulesFail.on` (every other query passes through to the real database).
    const rulesFail = { on: false };
    const pool = new Proxy(db.runWriterPool, {
      get(target, prop, receiver) {
        if (prop !== "connect") return Reflect.get(target, prop, receiver) as unknown;
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = (text: unknown, ...rest: unknown[]) =>
            rulesFail.on && typeof text === "string" && text.includes("context_rules") ? Promise.reject(new Error("rules unavailable")) : query(text, ...rest);
          return client;
        };
      },
    });
    const h = createSandboxTargetHarness(pool);
    const created = { n: 0 };
    const seen: Array<{ op: "start" | "resume"; excludes: readonly string[] | undefined }> = [];
    let measure: ContextLedgerMeasure | undefined;
    const port: SandboxPort = {
      ...h.deps.sandboxPort,
      createSandbox(opts) {
        created.n += 1;
        return h.deps.sandboxPort.createSandbox(opts);
      },
      startDetached(handle, opts: StartDetachedOptions) {
        seen.push({ op: "start", excludes: opts.excludes });
        const out = h.deps.sandboxPort.startDetached(handle, opts);
        if (measure !== undefined) opts.onContextLedger?.(measure);
        return out;
      },
      resume(handle, sessionId, prompt, opts) {
        seen.push({ op: "resume", excludes: opts.excludes });
        const out = h.deps.sandboxPort.resume(handle, sessionId, prompt, opts);
        if (measure !== undefined) opts.onContextLedger?.(measure);
        return out;
      },
    };
    const target = new SandboxTarget({ ...h.deps, sandboxPort: port });
    const start = async (m?: ContextLedgerMeasure) => {
      measure = m;
      const result = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
      if (result.status !== "running") throw new Error("run did not start");
      await sleep(30);
      return { id: result.id, run: buildExecutionRun(result.id, input) };
    };
    return { accountId, rule, seen, target, start, rulesFail, created, input };
  }
  const denied = async (accountId: string, id: string) => (await db.admin.query("SELECT denied_tool_calls AS d FROM run_context_ledger WHERE account_id = $1 AND run_id = $2", [accountId, id])).rows.map((r) => r.d);

  it("acceptance 2: a sandbox run with no excludes records 0 refused calls; one whose stream refused 2 records 2; a measure with no count (a runner's) leaves null", async () => {
    for (const [count, expected] of [[0, 0], [2, 2], [undefined, null]] as const) {
      const w = await world();
      const s = await w.start({ ...measureOf(), ...(count === undefined ? {} : { denied_tool_calls: count }) });
      await w.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
      expect(await denied(w.accountId, s.id), String(count)).toEqual([expected]);
    }
  });

  it("the port gets the item's exclude paths at the start, with pins left out, an item rule over the repository's for the same path, and no other account's rules", async () => {
    const w = await world();
    await w.rule("repo", "exclude", "secret/a.txt");
    await w.rule("repo", "exclude", "docs/api.md");
    await w.rule("repo", "pin", "README.md");
    await w.rule("item", "pin", "docs/api.md"); // the item pins what the repository excludes: the item's rule wins
    await w.rule("item", "exclude", "keys/**");
    const other = await world();
    await other.rule("repo", "exclude", "other-account.txt");
    await w.start();
    expect(w.seen).toEqual([{ op: "start", excludes: expect.arrayContaining(["keys/**", "secret/a.txt"]) }]);
    expect(w.seen[0]!.excludes).toHaveLength(2);
  });

  it("a run with no excludes is given none (the port's settings are as before this row)", async () => {
    const w = await world();
    await w.rule("repo", "pin", "README.md");
    await w.start();
    expect(w.seen).toEqual([{ op: "start", excludes: undefined }]);
  });

  it("acceptance 4 and the undo path: a resume reads the rules as they stand at the resume; an exclude removed since stops denying, one added since applies", async () => {
    const w = await world();
    await w.rule("repo", "exclude", "secret/a.txt");
    const s = await w.start();
    // A fix round resumes a run that is queued again (`pending`), as `resumeAgentRun` leaves it.
    const resume = async () => {
      await db.admin.query("UPDATE agent_runs SET status = 'pending' WHERE id = $1", [s.id]);
      await w.target.resume(s.run, "sess-1");
      await sleep(30);
    };
    await resume();
    await w.rule("repo", "exclude", "added/later.txt");
    await resume();
    await db.admin.query("DELETE FROM context_rules WHERE account_id = $1", [w.accountId]);
    await resume();
    const sorted = (x: readonly string[] | undefined) => (x === undefined ? undefined : [...x].sort());
    expect(w.seen.map((x) => [x.op, sorted(x.excludes)])).toEqual([
      ["start", ["secret/a.txt"]],
      ["resume", ["secret/a.txt"]],
      ["resume", ["added/later.txt", "secret/a.txt"]],
      ["resume", undefined],
    ]);
  });

  it("fails closed on a RESUME: when the rules query fails, nothing reaches the port, and the failure is the rules' own", async () => {
    const w = await world();
    await w.rule("repo", "exclude", "secret/a.txt");
    const s = await w.start();
    w.seen.length = 0;
    w.created.n = 0;
    // The run is pending, as a fix round leaves it, so the only thing that can stop this launch is the failed read.
    await db.admin.query("UPDATE agent_runs SET status = 'pending' WHERE id = $1", [s.id]);
    w.rulesFail.on = true;
    await expect(w.target.resume(s.run, "sess-1")).rejects.toThrow("rules unavailable");
    w.rulesFail.on = false;
    expect(w.seen).toEqual([]);
    expect(w.created.n).toBe(0);
    // Nothing was marked as requested or started: the run is still pending, and the same call works once the rules can be read.
    expect((await db.admin.query("SELECT status FROM agent_runs WHERE id = $1", [s.id])).rows).toEqual([{ status: "pending" }]);
    await w.target.resume(s.run, "sess-1");
    expect(w.seen.map((x) => x.op)).toEqual(["resume"]);
  });

  it("fails closed on a START: when the rules query fails, no sandbox is created, the agent is never started, and the run does not go to running", async () => {
    const w = await world();
    await w.rule("repo", "exclude", "secret/a.txt");
    w.rulesFail.on = true;
    const outcome = await startAgentRun(db.runWriterPool, { sandbox: w.target }, w.input).then(
      (r) => r.status,
      () => "threw",
    );
    w.rulesFail.on = false;
    expect(outcome).not.toBe("running");
    expect(w.created.n).toBe(0);
    expect(w.seen).toEqual([]);
    const rows = (await db.admin.query("SELECT status FROM agent_runs WHERE account_id = $1", [w.accountId])).rows;
    expect(rows.every((r) => r.status !== "running")).toBe(true);
  });
});
