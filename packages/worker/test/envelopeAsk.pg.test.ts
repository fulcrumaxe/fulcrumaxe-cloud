import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule } from "../src/advance.js";
import { createEnvelopeAsk } from "../src/envelopeAsk.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/** D#483 S5-d [pg]: the spend_past_envelope ask, raised on the receipt login, once per item per envelope version. */
const INVOKER_LOGIN = "fx_envelope_ask_invoker_test";

describe("the spend_past_envelope ask [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let runnerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    runnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, runnerPool]) await p.end();
  });

  async function setup(a: SeedRefs, amount: number | null, opts: { finishedRun?: boolean } = {}) {
    const itemId = randomUUID();
    const envelopeId = randomUUID();
    if (amount !== null) await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', $3, 1, $4)`, [envelopeId, a.accountId, amount, a.userId]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, envelope_id) VALUES ($1, $2, $3, 'issue', 'internal', 'spec_ready', $4)`, [itemId, a.accountId, a.repoId, amount === null ? null : envelopeId]);
    let runId: string | null = null;
    if (opts.finishedRun !== false) {
      runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, ended_at) VALUES ($1, $2, $3, 'project-manager', 'local', 'succeeded', now())`, [runId, a.accountId, itemId]);
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 0.3, $2, 'model')`, [a.accountId, runId]);
    }
    return { itemId, envelopeId, runId };
  }
  const asks = async (a: SeedRefs, itemId: string) => (await admin.query(`SELECT * FROM decision_asks WHERE account_id = $1 AND work_item_id = $2 AND decision_type = 'spend_past_envelope' ORDER BY raised_at`, [a.accountId, itemId])).rows;

  it("raises one ask, anchored on the latest finished run, with the two options and figures in fixed words", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await setup(a, 0.5);
    const raise = createEnvelopeAsk(receiptPool);
    expect(await raise({ accountId: a.accountId, workItemId: s.itemId, runUsd: 0.4 })).toBe("raised");
    const rows = await asks(a, s.itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "open", run_id: s.runId, proposed: "raise_limit", timeout_outcome: "stop_and_flag" });
    expect(rows[0].options).toEqual([{ id: "raise_limit", label: "Raise the limit to $0.70" }, { id: "stop_item", label: "Stop this item" }]);
    expect(rows[0].rationale).toBe("This item has used $0.30 of its $0.50 limit, and its next step needs about $0.40 more. Nothing more starts until you raise the limit or stop the item.");
    expect(rows[0].rationale + JSON.stringify(rows[0].options)).not.toMatch(/NaN|undefined|null/);
  });

  it("S5d-3: a second denial under the same envelope version raises no second ask; a new version asks again", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await setup(a, 0.5);
    const raise = createEnvelopeAsk(receiptPool);
    expect(await raise({ accountId: a.accountId, workItemId: s.itemId, runUsd: 1 })).toBe("raised");
    for (let i = 0; i < 3; i += 1) expect(await raise({ accountId: a.accountId, workItemId: s.itemId, runUsd: 1 })).toBe("already_asked");
    expect(await asks(a, s.itemId)).toHaveLength(1);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 0.6, 2, $3)`, [s.envelopeId, a.accountId, a.userId]);
    expect(await raise({ accountId: a.accountId, workItemId: s.itemId, runUsd: 1 })).toBe("raised");
    expect(await asks(a, s.itemId)).toHaveLength(2);
  });

  it("two denials at the same moment raise one ask", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await setup(a, 0.5);
    const raise = createEnvelopeAsk(receiptPool);
    const out = await Promise.all(Array.from({ length: 6 }, () => raise({ accountId: a.accountId, workItemId: s.itemId, runUsd: 1 })));
    expect(out.filter((o) => o === "raised")).toHaveLength(1);
    expect(await asks(a, s.itemId)).toHaveLength(1);
  });

  it("asks nothing for an item with no envelope, or no finished run to anchor on, and leaves no memory row", async () => {
    const a = await seedAccount(admin, randomUUID());
    const none = await setup(a, null);
    const young = await setup(a, 0.5, { finishedRun: false });
    const raise = createEnvelopeAsk(receiptPool);
    expect(await raise({ accountId: a.accountId, workItemId: none.itemId, runUsd: 1 })).toBe("no_envelope");
    expect(await raise({ accountId: a.accountId, workItemId: young.itemId, runUsd: 1 })).toBe("no_run");
    expect(await asks(a, none.itemId)).toHaveLength(0);
    expect(await asks(a, young.itemId)).toHaveLength(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM envelope_pause_asks WHERE account_id = $1`, [a.accountId])).rows[0].n).toBe(0);
  });

  it("a failed raise leaves no 'already asked' row, so the next denial asks again", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await setup(a, 0.5);
    // An item whose account is gone from the receipt pool's view: the definer refuses, the transaction rolls back whole.
    const broken = createEnvelopeAsk({ connect: async () => { throw new Error("pool down"); } } as unknown as Pool);
    await expect(broken({ accountId: a.accountId, workItemId: s.itemId, runUsd: 1 })).rejects.toThrow("pool down");
    expect((await admin.query(`SELECT count(*)::int AS n FROM envelope_pause_asks WHERE account_id = $1`, [a.accountId])).rows[0].n).toBe(0);
    expect(await createEnvelopeAsk(receiptPool)({ accountId: a.accountId, workItemId: s.itemId, runUsd: 1 })).toBe("raised");
  });

  describe("the start path", () => {
    const SEAT: SeatResult = {
      ok: true,
      seat: { repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 }, limits: { maxRunMs: 1, maxTurns: 1, maxModelCalls: 1, meteringSilenceMs: 1 }, timeoutMs: 1, maxExtensions: 0 } as never,
    };
    const starterRefusing = (refused: string): RunStarter => ({ start: async () => ({ runId: randomUUID(), refused: refused as never }) });
    const mod = (refused: string, raise: ReturnType<typeof createEnvelopeAsk> | null) =>
      createAdvanceModule(runnerPool, { starter: starterRefusing(refused), resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, raiseEnvelopeAsk: raise });

    it("a start the envelope denied raises the ask with the run's own figure; the answer to the caller is unchanged", async () => {
      const a = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
      const s = await setup(a, 0.5);
      const out = await mod("envelope_exceeded", createEnvelopeAsk(receiptPool)).advanceStartRun({ accountId: a.accountId, workItemId: s.itemId, step: "build:v1:x", role: "executor", prompt: "p", haltEpoch: 0 } as never);
      expect(out).toEqual({ ok: false, reason: "envelope_exceeded" });
      const rows = await asks(a, s.itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0].options[0].label).toBe("Raise the limit to $5.80"); // spent 0.30 + the run's 5 + 0.5
    });

    it("any other refusal raises no ask, and a failing ask never changes the refusal", async () => {
      const a = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
      const s = await setup(a, 0.5);
      const req = { accountId: a.accountId, workItemId: s.itemId, step: "build:v1:y", role: "executor", prompt: "p", haltEpoch: 0 } as never;
      expect(await mod("model_budget_exceeded", createEnvelopeAsk(receiptPool)).advanceStartRun(req)).toEqual({ ok: false, reason: "model_budget_exceeded" });
      expect(await asks(a, s.itemId)).toHaveLength(0);
      const failing = (async () => { throw new Error("ask down"); }) as never;
      expect(await mod("envelope_exceeded", failing).advanceStartRun(req)).toEqual({ ok: false, reason: "envelope_exceeded" });
    });
  });
});
