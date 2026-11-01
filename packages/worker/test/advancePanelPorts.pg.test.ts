import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStepPorts } from "../src/advance.js";
import type { SeatRequest, SeatResult } from "../src/seat.js";

/**
 * D#483 S5-k1e [pg]: the two ports the worker gives the panel step, over real rows. `startedAttempts` reads the runs a seat's earlier asks started from the real
 * idempotency keys; `headroom` is the whole-round check, asked of the REAL read-only `checkHeadroom` (the account's ledger, the budget, the item's cap), so a round that
 * would only fit seat by seat is refused before any seat spends. The seat resolver is the only fake: it hands over the limits this test sets.
 */
describe("advance: the panel step's ports [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  let n = 33000;
  async function item(a: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'discussing', $4)", [id, a.accountId, a.repoId, n++]);
    return id;
  }
  const DISC = "11111111-2222-4333-8444-555555555555";

  /** The ports the module hands to the injected panel step, for this item. */
  async function portsOf(a: SeedRefs, w: string, resolveRunSeat: (r: SeatRequest) => Promise<SeatResult>): Promise<AdvanceStepPorts> {
    let captured: AdvanceStepPorts | null = null;
    const deps = {
      starter: { start: async () => ({ runId: randomUUID() }) },
      resolveRunSeat,
      startAdvance: async () => undefined,
      triage: null,
      panel: (async (_p: Pool, _a: string, _w: string, ports: AdvanceStepPorts) => {
        captured = ports;
        return { status: "completed" };
      }) as never,
      registry: {} as never,
    } as AdvanceModuleDeps;
    const out = await createAdvanceModule(writerPool, deps).advancePanel({ accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 });
    expect(out.status).toBe("completed");
    return captured!;
  }
  async function run(a: SeedRefs, w: string, key: string, role: string, status: string): Promise<void> {
    const id = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', $5)", [id, a.accountId, w, role, status]);
    await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [a.accountId, key, id, "0".repeat(64)]);
  }

  describe("startedAttempts", () => {
    it("a placement generation past 99 reads through (`:s3:r1:security-expert:p100` is attempt 3)", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await run(a, w, `advance:${w}:panel:${DISC}:s3:r1:security-expert:p100`, "security-expert", "succeeded");
      const ports = await portsOf(a, w, async () => ({ ok: false, reason: "no_model" }));
      expect(await ports.startedAttempts(`panel:${DISC}`, ":r1:security-expert")).toEqual([{ attempt: 3, status: "succeeded" }]);
    });

    it("reads the runs one seat's asks started, by their real keys: the bare key, each :s<n>, a placement restart, oldest first; and no one else's", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const other = await item(a);
      const k = (rest: string, item = w) => `advance:${item}:panel:${DISC}${rest}`;
      await run(a, w, k(":r1:security-expert"), "security-expert", "refused_spend");
      await run(a, w, k(":s1:r1:security-expert"), "security-expert", "refused_spend");
      await run(a, w, k(":s2:r1:security-expert"), "security-expert", "cancelled");
      await run(a, w, k(":s2:r1:security-expert:p1"), "security-expert", "succeeded");
      // Not this seat: another role, another round, another generation, a longer role name, another item, a key that merely contains the head.
      await run(a, w, k(":r1:cost-analyst"), "cost-analyst", "succeeded");
      await run(a, w, k(":r2:security-expert"), "security-expert", "succeeded");
      await run(a, w, k(":g1:r1:security-expert"), "security-expert", "succeeded");
      await run(a, w, k(":r1:security-expert-extra"), "security-expert", "succeeded");
      await run(a, other, k(":r1:security-expert", other), "security-expert", "succeeded");
      await run(a, w, `advance:${w}:x:panel:${DISC}:r1:security-expert`, "security-expert", "succeeded");
      const ports = await portsOf(a, w, async () => ({ ok: false, reason: "no_model" }));
      expect(await ports.startedAttempts(`panel:${DISC}`, ":r1:security-expert")).toEqual([
        { attempt: 0, status: "refused_spend" },
        { attempt: 1, status: "refused_spend" },
        { attempt: 2, status: "cancelled" },
        { attempt: 2, status: "succeeded" },
      ]);
      expect(await ports.startedAttempts(`panel:${DISC}:g1`, ":r1:security-expert")).toEqual([{ attempt: 0, status: "succeeded" }]);
      expect(await ports.startedAttempts(`panel:${DISC}`, ":r2:security-expert")).toEqual([{ attempt: 0, status: "succeeded" }]);
      expect(await ports.startedAttempts(`panel:${DISC}`, ":r1:ux-designer")).toEqual([]);
    });

    it("a seat with more than 500 rows keeps its NEWEST attempts (newest are read first, handed back oldest first), so the next attempt is never chosen from a stale one", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      // 505 earlier denied asks (attempts 1..505), the oldest first by created_at, then the real newest one: attempt 506, which posted.
      await admin.query(
        `WITH r AS (INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
                    SELECT gen_random_uuid(), $1, $2, 'security-expert', 'production', CASE WHEN g = 506 THEN 'succeeded' ELSE 'refused_spend' END FROM generate_series(1, 506) g RETURNING id, status)
         SELECT count(*) FROM r`,
        [a.accountId, w],
      );
      const runs = (await admin.query<{ id: string; status: string }>("SELECT id, status FROM agent_runs WHERE work_item_id = $1 ORDER BY status DESC", [w])).rows; // succeeded first
      let i = 0;
      for (const r of runs) {
        const attempt = r.status === "succeeded" ? 506 : (i += 1);
        await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5::int))", [
          a.accountId,
          `advance:${w}:panel:${DISC}:s${attempt}:r1:security-expert`,
          r.id,
          "0".repeat(64),
          1000 - attempt,
        ]);
      }
      const ports = await portsOf(a, w, async () => ({ ok: false, reason: "no_model" }));
      const rows = await ports.startedAttempts(`panel:${DISC}`, ":r1:security-expert");
      expect(rows).toHaveLength(500);
      expect(rows.at(-1)).toEqual({ attempt: 506, status: "succeeded" });
      expect(Math.max(...rows.map((r) => r.attempt))).toBe(506);
    });

    it("a head or a tail that is not the shape of a seat key finds nothing (no wildcard reaches the query)", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await run(a, w, `advance:${w}:panel:${DISC}:r1:security-expert`, "security-expert", "succeeded");
      const ports = await portsOf(a, w, async () => ({ ok: false, reason: "no_model" }));
      expect(await ports.startedAttempts("panel:%", ":r1:security-expert")).toEqual([]);
      expect(await ports.startedAttempts(`panel:${DISC}`, ":r1:%")).toEqual([]);
      expect(await ports.startedAttempts(`panel:${DISC}`, ":r3:security-expert")).toEqual([]);
      expect(await ports.startedAttempts("", ":r1:security-expert")).toEqual([]);
    });
  });

  describe("headroom", () => {
    const seatWith = (estimateModelUsd: number, extra: Record<string, unknown> = {}) =>
      async (r: SeatRequest): Promise<SeatResult> =>
        ({ ok: true, seat: { spend: { plan: "starter", purpose: "run", trigger: "foreground", workItemId: "workItemId" in r ? r.workItemId : undefined, workItemKind: "feature", estimateModelUsd, estimateComputeUsd: 0, monthlyModelBudgetUsd: 50, perSpawnCapUsd: 40, ...extra } } }) as never;
    const counts = async (accountId: string) => ({
      runs: Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n),
      reservations: Number((await admin.query("SELECT count(*) AS n FROM spend_reservations WHERE account_id = $1", [accountId])).rows[0].n),
      ledger: Number((await admin.query("SELECT count(*) AS n FROM ledger WHERE account_id = $1", [accountId])).rows[0].n),
    });
    const ROLES = ["technical-architect", "product-owner", "performance-expert"];

    it("a round that fits is admitted, and the check writes no run, no reservation and no ledger row", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const ports = await portsOf(a, w, seatWith(10));
      const before = await counts(a.accountId);
      expect(await ports.headroom(ROLES)).toEqual({ ok: true });
      expect(await ports.headroom([])).toEqual({ ok: true });
      expect(await counts(a.accountId)).toEqual(before);
    });

    it("S5k1e-1: a round whose seats each fit but do not fit together is denied as a whole, with the limit's own name", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      // Three seats of 20 against a budget of 50: each is admitted alone, the three are not.
      const ports = await portsOf(a, w, seatWith(20));
      expect(await ports.headroom(["technical-architect"])).toEqual({ ok: true });
      expect(await ports.headroom(ROLES.slice(0, 2))).toEqual({ ok: true });
      expect(await ports.headroom(ROLES)).toEqual({ ok: false, reason: "model_budget_exceeded" });
    });

    it("the account's month-to-date counts: a round that would fit an empty month is denied after the month's spend", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const prior = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, NULL, 'executor', 'production', 'running')", [prior, a.accountId]);
      await admin.query("INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 45, $2, 'model')", [a.accountId, prior]);
      const ports = await portsOf(a, w, seatWith(3));
      expect(await ports.headroom(["technical-architect"])).toEqual({ ok: true });
      expect(await ports.headroom(ROLES)).toEqual({ ok: false, reason: "model_budget_exceeded" });
    });

    it("the per-run limit is a limit on one run: three seats at the limit are not denied for their sum, and one above it is denied alone", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const atLimit = await portsOf(a, w, async (r) => ({ ...(await seatWith(40, { monthlyModelBudgetUsd: 1000 })(r)) }) as never);
      expect(await atLimit.headroom(ROLES)).toEqual({ ok: true });
      const above = await portsOf(a, w, seatWith(50, { monthlyModelBudgetUsd: 1000 }));
      expect(await above.headroom(["product-owner"])).toEqual({ ok: false, reason: "per_spawn_cap_exceeded" });
    });

    it("the item's own cap counts the whole round", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const ports = await portsOf(a, w, seatWith(2, { monthlyModelBudgetUsd: 1000, featureCapUsd: 5 }));
      expect(await ports.headroom(ROLES.slice(0, 2))).toEqual({ ok: true });
      expect(await ports.headroom(ROLES)).toEqual({ ok: false, reason: "work_item_cap_exceeded" });
    });

    /** An item under an item envelope of `amount`, and a resolver that prices each role with its own terms (the real resolver prices every role by its own floor). */
    const envelopeItem = async (a: SeedRefs, amount: number): Promise<string> => {
      const envelopeId = randomUUID();
      const w = randomUUID();
      await admin.query("INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', $3, 1, $4)", [envelopeId, a.accountId, amount, a.userId]);
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number, envelope_id) VALUES ($1, $2, $3, 'feature', 'internal', 'discussing', $4, $5)", [w, a.accountId, a.repoId, n++, envelopeId]);
      return w;
    };
    const perRole = (terms: Record<string, Record<string, unknown>>) => async (r: SeatRequest): Promise<SeatResult> =>
      ({ ok: true, seat: { spend: { plan: "starter", purpose: "run", trigger: "foreground", workItemId: "workItemId" in r ? r.workItemId : undefined, workItemKind: "feature", estimateModelUsd: 6, estimateComputeUsd: 0, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 40, ...terms[r.role] } } }) as never;

    it("S5k1e-2: seats priced with different per-role floors share ONE item envelope, so a round that fits seat by seat but not together is denied", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await envelopeItem(a, 10);
      const ports = await portsOf(a, w, perRole({ "technical-architect": { envelopeFloorUsd: 1.25 }, "product-owner": { envelopeFloorUsd: 2.5 } }));
      expect(await ports.headroom(["technical-architect"])).toEqual({ ok: true });
      expect(await ports.headroom(["product-owner"])).toEqual({ ok: true });
      expect(await ports.headroom(["technical-architect", "product-owner"])).toEqual({ ok: false, reason: "envelope_exceeded" });
    });

    it("S5k1e-3: seats that reserve no model money count their floors together against the envelope", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await envelopeItem(a, 10);
      const free = { estimateModelUsd: 0, modelBrokeredBy: "operator_subscription" };
      const ports = await portsOf(a, w, perRole({ "technical-architect": { ...free, envelopeFloorUsd: 4 }, "product-owner": { ...free, envelopeFloorUsd: 7 } }));
      expect(await ports.headroom(["technical-architect"])).toEqual({ ok: true });
      expect(await ports.headroom(["product-owner"])).toEqual({ ok: true });
      expect(await ports.headroom(["technical-architect", "product-owner"])).toEqual({ ok: false, reason: "envelope_exceeded" });
      const small = await portsOf(a, w, perRole({ "technical-architect": { ...free, envelopeFloorUsd: 4 }, "product-owner": { ...free, envelopeFloorUsd: 5 } }));
      expect(await small.headroom(["technical-architect", "product-owner"])).toEqual({ ok: true });
    });

    it("S5k1e-4: seats that differ in a term that picks the budget (plan, trigger, brokering, or whether they reserve model money) fail closed, never split across the shared limits", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await envelopeItem(a, 10);
      const odd: Array<Record<string, unknown>> = [{ plan: "pro" }, { trigger: "background" }, { modelBrokeredBy: "operator_subscription" }, { estimateModelUsd: 0, envelopeFloorUsd: 1 }];
      for (const other of odd) {
        const ports = await portsOf(a, w, perRole({ "technical-architect": { envelopeFloorUsd: 1 }, "product-owner": { envelopeFloorUsd: 1, ...other } }));
        expect(await ports.headroom(["technical-architect", "product-owner"])).toEqual({ ok: false, reason: "round_terms_differ" });
        expect(await ports.headroom(["technical-architect"])).toEqual({ ok: true });
      }
    });

    it("an account that is not active is the check's own answer (not a spending limit), and a seat that cannot be resolved is named, not guessed", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await admin.query("UPDATE accounts SET status = 'paused', owner_paused_at = now() WHERE id = $1", [a.accountId]);
      const ports = await portsOf(a, w, seatWith(1));
      expect(await ports.headroom(ROLES)).toEqual({ ok: false, reason: "account_not_active" });
      const b = await seedAccount(admin, randomUUID());
      const x = await item(b);
      const unresolved = await portsOf(b, x, vi.fn(async () => ({ ok: false, reason: "no_model" }) as SeatResult));
      expect(await unresolved.headroom(ROLES)).toEqual({ ok: false, reason: "seat_no_model" });
    });
  });
});
