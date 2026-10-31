import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { answerAsk } from "@fx/core/src/decisions/answer.js";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { writeReceipt } from "@fx/db/src/receiptWriter.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { buildDecisionSnapshot, type SnapshotDial } from "../src/decisionSnapshot.js";
import { createDecisionIntake, type DecisionStepCode } from "../src/decisionIntake.js";

/**
 * [pg] D#7 DP7-2e, frozen DP7 criterion 6: an agent only proposes, and a reversal is a person's act. A run envelope that asks for one, in every place an agent
 * can write, ends with no compensation row, no reversal receipt and no GitHub call. The step is entered through packages/worker/src/decisionIntake.ts, the one
 * place an envelope becomes receipts and asks. The intake holds no GitHub client at all; the fetch spy proves nothing reaches the network from the step or from
 * answering the ask it raised.
 */
const LOGIN = "fx_envelope_no_reversal_test";
const ASKED = "test_strategy_choice";
const ACTED = "nonbreaking_refactor_approach";
const OPTIONS = [
  { id: "keep", label: "Keep the current shape" },
  { id: "split", label: "Split it in two" },
];
const FORGED = [...OPTIONS, { id: "reverse", label: "Reverse the last decision" }];
/** Every field name an agent could try to carry a reversal in. */
const ORIGINAL = "__ORIGINAL_RECEIPT__";
const REVERSAL_KEYS = { reverse: true, reversal: true, reverse_receipt_id: ORIGINAL, reverses_receipt_id: ORIGINAL, allow_reversal: true };

describe("a hostile run envelope cannot reverse anything [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let runnerPool: Pool;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    runnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterEach(() => fetchSpy.mockClear());
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, runnerPool]) await p.end();
  });

  interface World { a: SeedRefs; itemId: string; runId: string; step: () => Promise<DecisionStepCode> }
  /** An executor run on a fresh item: ASKED stops and asks (a cautious dial), ACTED is decided by policy (act). */
  async function world(envelope: unknown): Promise<World> {
    const a = await seedAccount(admin, randomUUID());
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress')`, [itemId, a.accountId, a.repoId]);
    const dials = new Map<string, SnapshotDial>([
      [ASKED, { version: 1, disposition: "ask", preset: "cautious" }],
      [ACTED, { version: 1, disposition: "act", preset: null }],
    ]);
    for (const [type, d] of dials) {
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, $5, 1, $6)`, [a.accountId, a.repoId, type, d.disposition, d.preset, a.userId]);
    }
    const snapshot = buildDecisionSnapshot({ role: "executor", dials, declared: [ASKED, ACTED] });
    // A real receipt the envelope can name: if any key were honoured, the database would accept the reversal.
    const earlier = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [earlier, a.accountId, itemId]);
    const written = await withTenant(receiptPool, a.accountId, a.userId, (c) =>
      writeReceipt(c, { class: "human_over_the_loop", runId: earlier, workItemId: itemId, decisionType: "test_strategy_choice", chosen: "unit_tests", rejectedAlternative: "end_to_end_tests", dialVersion: 0, quotedInputs: [] }));
    if (written.store !== "decision_receipts") throw new Error("expected the durable store");
    const original = written.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, ended_at) VALUES ($1, $2, $3, 'executor', 'local', 'succeeded', $4::jsonb, now())`, [runId, a.accountId, itemId, JSON.stringify(envelope).replaceAll(ORIGINAL, original)]);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'decision.snapshot', $3::jsonb)`, [a.accountId, runId, JSON.stringify(snapshot)]);
    const intake = createDecisionIntake({ runnerPool, receiptPool, declared: () => [ASKED, ACTED] });
    return { a, itemId, runId, step: () => intake({ accountId: a.accountId, workItemId: itemId, haltEpoch: 0, runId }) };
  }

  const count = async (sql: string, accountId: string) => (await admin.query<{ n: number }>(sql, [accountId])).rows[0]!.n;
  /** No compensation row, no receipt that reverses anything and none of a reversal type, and no outbound call. */
  async function nothingReversed(accountId: string): Promise<void> {
    expect(await count("SELECT count(*)::int AS n FROM reversal_compensations WHERE account_id = $1", accountId)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM decision_receipts WHERE account_id = $1 AND (reverses_receipt_id IS NOT NULL OR decision_type IN ('reversal_recorded', 'reversal_over_cap'))", accountId)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM decision_asks WHERE account_id = $1 AND decision_type = 'reversal_over_cap'", accountId)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  }
  const ask = () => ({ type: "d1", options: OPTIONS, proposed: "keep", rationale: "Smaller diff." });
  const taken = { type: "d2", options: OPTIONS, chosen: "split", rationale: "It reads better." };

  it("an extra top-level key asking for a reversal does nothing", async () => {
    const w = await world({ ...REVERSAL_KEYS, reverse_last: true, decision_request: ask(), decisions_taken: [taken] });
    expect(await w.step()).toBe("parked"); // the ordinary ask and receipt; the extra keys are ignored

    await nothingReversed(w.a.accountId);
  });

  it("a reversal key inside decision_request does nothing", async () => {
    const w = await world({ decision_request: { ...ask(), ...REVERSAL_KEYS } });
    expect(await w.step()).toBe("refused"); // a request with keys it does not define is malformed

    await nothingReversed(w.a.accountId);
  });

  it("a reversal key inside decisions_taken does nothing", async () => {
    const w = await world({ decisions_taken: [{ ...taken, ...REVERSAL_KEYS }] });
    expect(await w.step()).toBe("refused");

    await nothingReversed(w.a.accountId);
  });

  it("an entry that names a reversal type as its decision is refused and writes no reversal", async () => {
    for (const type of ["reversal_over_cap", "reversal_recorded"]) {
      const w = await world({ decision_request: { type, options: OPTIONS, proposed: "keep", rationale: "Reverse it." }, decisions_taken: [{ ...taken, type }] });
      expect(await w.step()).toBe("refused"); // no such key in the run's decision snapshot
      await nothingReversed(w.a.accountId);
    }
  });

  it("a forged `reverse` option is only an option of an ordinary ask: choosing it files the ordinary resume and reverses nothing", async () => {
    const w = await world({ decision_request: { type: "d1", options: FORGED, proposed: "reverse", rationale: "Undo the last decision." } });
    expect(await w.step()).toBe("parked");
    const asks = (await admin.query(`SELECT id, decision_type FROM decision_asks WHERE run_id = $1`, [w.runId])).rows;
    expect(asks).toEqual([{ id: expect.any(String), decision_type: ASKED }]);
    await nothingReversed(w.a.accountId);
    const answered = await answerAsk({ pool: receiptPool, principal: { accountId: w.a.accountId, userId: w.a.userId } }, { askId: asks[0].id, choice: "reverse" });
    expect(answered.answeredOption).toBe("reverse");
    await nothingReversed(w.a.accountId);
  });
});
