import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { autostartRoom, envelopeLockKey } from "@fx/spend";
import { readProposal } from "@fx/core/src/plan/proposals.js";
import { readStartDecision } from "@fx/core/src/work-items/startDecision.js";
import { recordStartReceipt } from "@fx/core/src/decisions/startGate.js";
import { createAutoStartSweep } from "../src/autoStartSweep.js";

/**
 * [pg] D#483 S5-b1a-2 (D#7 R1b): the auto-start sweep, as the real receipt login against the real 0901 definers. Each test seeds its own account, so the
 * per-account asserts hold however many other accounts the shared database holds. Guards are named in the test titles; the mutant notes in the PR say which
 * line removal turns which test red.
 */
const LOGIN = "fx_autostart_sweep_test";
const FIRST_RUN = 1;

describe("the auto-start sweep [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let n = 0;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    gate = createAutoStartSweep({ receiptPool, firstRunUsd: (c, i) => price(c, i), warn: () => {} });
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end()]);
  });

  const price = vi.fn(async (_client: PoolClient, _input: { accountId: string; repoId: string }): Promise<number> => FIRST_RUN);
  let gate: ReturnType<typeof createAutoStartSweep>;

  interface Fx { t: SeedRefs; proposal: string; envelope: string | null }
  /** A connected repo's verified, internal, product-owned proposal with a small-item hint, under the dial `disposition` (null: no dial row) and a weekly limit of `amount`. */
  async function fixture(o: { amount?: number | null; disposition?: string | null; hint?: string | null; provenance?: string; owner?: string; verified?: boolean; freePreview?: boolean; detached?: boolean; kind?: string } = {}): Promise<Fx> {
    const t = await seedAccount(admin, randomUUID());
    let envelope: string | null = null;
    if (o.amount !== null) {
      envelope = randomUUID();
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', $3, 1, $4)`, [envelope, t.accountId, o.amount ?? 2.5, t.userId]);
    }
    if (o.disposition !== null) {
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, 'balanced', 1, $5)`, [t.accountId, t.repoId, `start_work_${o.kind ?? "small"}`, o.disposition ?? "announce", t.userId]);
    }
    if (o.freePreview) await admin.query("UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1", [t.accountId]);
    if (o.detached) await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [t.repoId]);
    const proposal = await addProposal(t, o);
    return { t, proposal, envelope };
  }
  async function addProposal(t: SeedRefs, o: { hint?: string | null; provenance?: string; owner?: string; verified?: boolean; kind?: string } = {}): Promise<string> {
    const hint = o.hint === undefined ? (o.kind ?? "small") : o.hint;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process, category_hint) VALUES ($1, $2, $3, '{github_issue}', $4, 'Fix the typo', $5, $6, $7) RETURNING id`,
      [t.accountId, t.repoId, `gh:issue:${++n}`, 1000 + n, o.provenance ?? "internal", o.owner ?? "product", hint],
    );
    const id = rows[0]!.id;
    if (o.verified !== false) await admin.query(`UPDATE proposals SET verification = 'verified', verified_at = now(), verified_run_id = $2 WHERE id = $1`, [id, t.runId]);
    return id;
  }
  async function written(t: SeedRefs) {
    const one = async (sql: string) => Number((await admin.query(sql, [t.accountId])).rows[0].n);
    return {
      items: await one("SELECT count(*) n FROM work_items WHERE account_id = $1 AND gh_number >= 1000"),
      receipts: await one("SELECT count(*) n FROM decision_receipts WHERE account_id = $1"),
      actions: await one("SELECT count(*) n FROM run_action_requests WHERE account_id = $1"),
      approved: await one("SELECT count(*) n FROM proposals WHERE account_id = $1 AND state = 'approved'"),
      envelopes: await one("SELECT count(*) n FROM work_items WHERE account_id = $1 AND envelope_id IS NOT NULL"),
    };
  }
  const NOTHING = { items: 0, receipts: 0, actions: 0, approved: 0, envelopes: 0 };
  const rulesFor = async (t: SeedRefs, rules: unknown[]): Promise<void> => {
    const json = JSON.stringify({ rules });
    await admin.query(
      `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by) VALUES ($1, NULL, 1, $2::jsonb, $3, encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'), $4)`,
      [t.accountId, json, rules.length, t.userId],
    );
  };

  describe("S5b1-1: under Balanced with a weekly limit, a verified small proposal starts with one receipt", () => {
    it("approves as the dial, attaches the weekly limit, files the start for the confirming person; a second pass and a forced replay write nothing more", async () => {
      const f = await fixture();
      const counts = await gate.sweepAutoStart();
      expect(counts.started).toBeGreaterThanOrEqual(1);
      expect(await written(f.t)).toEqual({ items: 1, receipts: 2, actions: 1, approved: 1, envelopes: 1 });
      const p = (await admin.query("SELECT * FROM proposals WHERE id = $1", [f.proposal])).rows[0];
      expect(p).toMatchObject({ state: "approved", decided_by_kind: "dial", decided_by_user_id: null });
      const receipt = (await admin.query("SELECT * FROM decision_receipts WHERE id = $1", [p.decision_receipt_id])).rows[0];
      expect(receipt).toMatchObject({ class: "human_over_the_loop", decision_type: "start_work_small", chosen: "start", rejected_alternative: "wait_for_approval", actor: "policy", run_id: f.t.runId, dial_version: 1 });
      expect((await admin.query("SELECT envelope_id FROM work_items WHERE id = $1", [p.work_item_id])).rows[0].envelope_id).toBe(f.envelope);
      expect((await admin.query("SELECT principal_kind, requested_by, state FROM run_action_requests WHERE account_id = $1", [f.t.accountId])).rows).toEqual([{ principal_kind: "session", requested_by: `session:${f.t.userId}`, state: "accepted" }]);

      const again = await gate.sweepAutoStart();
      expect(again.listed).toBeGreaterThanOrEqual(0);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("replayed");
      expect(await written(f.t)).toEqual({ items: 1, receipts: 2, actions: 1, approved: 1, envelopes: 1 });
    });

    it("act starts too, and a bug and a doc item use their own dial", async () => {
      for (const [kind, disposition] of [["small", "act"], ["bug", "announce"], ["doc", "announce"]] as const) {
        const f = await fixture({ kind, disposition });
        expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("started");
        expect((await admin.query("SELECT decision_type FROM decision_receipts WHERE account_id = $1 AND run_id IS NOT NULL", [f.t.accountId])).rows).toEqual([{ decision_type: `start_work_${kind}` }]);
      }
    });

    it("two concurrent passes over one proposal start it once", async () => {
      const f = await fixture();
      const outcomes = await Promise.all([gate.gateProposal(f.t.accountId, f.proposal), gate.gateProposal(f.t.accountId, f.proposal)]);
      expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "replayed")).toHaveLength(1);
      expect(await written(f.t)).toEqual({ items: 1, receipts: 2, actions: 1, approved: 1, envelopes: 1 });
    });
  });

  describe("S5b1-2: ask and unknown states never start", () => {
    it("under Cautious (an ask row) the proposal stays new: no receipt, no work item", async () => {
      const f = await fixture({ disposition: "ask" });
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("asked");
      expect(await written(f.t)).toEqual(NOTHING);
      expect((await admin.query("SELECT state FROM proposals WHERE id = $1", [f.proposal])).rows[0].state).toBe("new");
    });

    it("no dial row at all starts nothing (the definer needs a dial version to name; the catalogue default is ask)", async () => {
      const f = await fixture({ disposition: null });
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("not_ready");
      expect(await written(f.t)).toEqual(NOTHING);
    });

    it("a repo's dial for another start type does not start this one", async () => {
      const f = await fixture({ kind: "bug", hint: "small" });
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("not_ready");
      expect(await written(f.t)).toEqual(NOTHING);
    });
  });

  describe("S5b1-6: only small, bug and doc items start on their own", () => {
    it.each([["feature"], ["project"], ["critical"], ["question"], ["nonsense"], [null]])("a %s hint stays new and asks", async (hint) => {
      const f = await fixture({ hint });
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("asked");
      expect(await written(f.t)).toEqual(NOTHING);
    });
  });

  describe("the hard rules hold for this unattended start, at the gate and again at the data", () => {
    const cases: Array<[string, Parameters<typeof fixture>[0], string]> = [
      ["text from outside (external)", { provenance: "external" }, "asked"],
      ["a proposal the repo's own loop owns", { owner: "internal_loop" }, "not_ready"],
      ["a proposal nobody has checked", { verified: false }, "asked"],
      ["an account still on the free preview", { freePreview: true }, "not_ready"],
      ["a repo with no write install", { detached: true }, "not_ready"],
    ];
    it.each(cases)("%s does not start", async (_name, o, outcome) => {
      const f = await fixture(o);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe(outcome);
      expect(await written(f.t)).toEqual(NOTHING);
    });
  });

  describe("S5b1-5: the confirmed weekly limit", () => {
    it("with no limit set, or a limit of 0, nothing is listed and nothing starts", async () => {
      for (const amount of [null, 0]) {
        const f = await fixture({ amount });
        await gate.sweepAutoStart();
        expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("not_ready");
        expect(await written(f.t)).toEqual(NOTHING);
      }
    });

    it("a limit that covers one first run starts one of two proposals and leaves the other waiting for room; the pass says when the limit renews", async () => {
      const f = await fixture({ amount: 1.5 });
      const second = await addProposal(f.t);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("started");
      // The first item has no run yet: it still holds its first run's price, so there is no room for the second.
      expect(await gate.gateProposal(f.t.accountId, second)).toBe("no_room");
      expect(await written(f.t)).toEqual({ items: 1, receipts: 2, actions: 1, approved: 1, envelopes: 1 });
      expect((await admin.query("SELECT state FROM proposals WHERE id = $1", [second])).rows[0].state).toBe("new");
      const counts = await gate.sweepAutoStart();
      expect(counts.no_room).toBeGreaterThanOrEqual(1);
      expect(Date.parse(counts.renews_at!)).toBeGreaterThan(Date.now());
      expect(new Date(counts.renews_at!).getUTCDay()).toBe(1);
    });

    it("spend already counted this week uses the room up", async () => {
      const f = await fixture({ amount: 2.5 });
      const item = randomUUID();
      const run = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, envelope_id) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress', $4)`, [item, f.t.accountId, f.t.repoId, f.envelope]);
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, ended_at) VALUES ($1, $2, $3, 'project-manager', 'local', 'succeeded', now())`, [run, f.t.accountId, item]);
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 2, $2, 'model')`, [f.t.accountId, run]);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("no_room");
      expect(await written(f.t)).toMatchObject({ approved: 0, receipts: 0 });
    });

    it("a price that rounds to nothing in the unit of the money columns is no price: with the limit spent it starts nothing", async () => {
      const f = await fixture({ amount: 1 });
      const item = randomUUID();
      const run = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, envelope_id) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress', $4)`, [item, f.t.accountId, f.t.repoId, f.envelope]);
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, ended_at) VALUES ($1, $2, $3, 'project-manager', 'local', 'succeeded', now())`, [run, f.t.accountId, item]);
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 1, $2, 'model')`, [f.t.accountId, run]);
      price.mockResolvedValueOnce(0.00004);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("not_ready");
      expect(await written(f.t)).toMatchObject({ approved: 0, receipts: 0 });
      const room = await withTenant(receiptPool, f.t.accountId, (c) => autostartRoom(c, { accountId: f.t.accountId, firstRunUsd: 0.00004 }));
      expect(room).toMatchObject({ fits: false, reason: "unpriced" });
    });

    it("a price that is missing, zero, negative or not a number starts nothing", async () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const f = await fixture();
        price.mockResolvedValueOnce(bad);
        expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("not_ready");
        expect(await written(f.t)).toEqual(NOTHING);
      }
      const f = await fixture();
      price.mockRejectedValueOnce(new Error("no price"));
      await expect(gate.gateProposal(f.t.accountId, f.proposal)).rejects.toThrow("no price");
      expect(await written(f.t)).toEqual(NOTHING);
    });
  });

  describe("the limit check is atomic with the start", () => {
    it("takes the envelope's own lock: while another transaction holds it, the gate waits; released, it goes on", async () => {
      const f = await fixture();
      const holder = await adminPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [envelopeLockKey(f.t.accountId, f.envelope!)]);
        let done = false;
        const pending = gate.gateProposal(f.t.accountId, f.proposal).then((o) => { done = true; return o; });
        await new Promise((r) => setTimeout(r, 600));
        expect(done).toBe(false);
        expect(await written(f.t)).toEqual(NOTHING);
        await holder.query("COMMIT");
        expect(await pending).toBe("started");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    });

    it("six passes held at a barrier before they read the room, on a limit that fits two first runs, start exactly two", async () => {
      const f = await fixture({ amount: 2.5 });
      const others = await Promise.all([1, 2, 3, 4, 5].map(() => addProposal(f.t)));
      const all = [f.proposal, ...others];
      // Every pass is inside its transaction, with its facts read, before any of them is let on to the room check: the race is made, not hoped for.
      let arrived = 0;
      let open!: () => void;
      const gateOpen = new Promise<void>((resolve) => { open = resolve; });
      price.mockImplementation(async () => {
        arrived += 1;
        if (arrived === all.length) open();
        await gateOpen;
        return FIRST_RUN;
      });
      try {
        const outcomes = await Promise.all(all.map((id) => gate.gateProposal(f.t.accountId, id)));
        expect(arrived).toBe(all.length);
        expect(outcomes.filter((o) => o === "started")).toHaveLength(2);
        expect(outcomes.filter((o) => o === "no_room")).toHaveLength(4);
        expect(await written(f.t)).toEqual({ items: 2, receipts: 4, actions: 2, approved: 2, envelopes: 2 });
      } finally {
        price.mockImplementation(async () => FIRST_RUN);
      }
    });

    it("autostartRoom counts started items that have not run yet, and stops counting an item once it has a run", async () => {
      const f = await fixture({ amount: 3 });
      const room = (usd = FIRST_RUN) => withTenant(receiptPool, f.t.accountId, (c) => autostartRoom(c, { accountId: f.t.accountId, firstRunUsd: usd }));
      expect(await room()).toMatchObject({ fits: true, reason: "ok", pendingItems: 0, remainingUsd: 3 });
      expect(await room(3.0001)).toMatchObject({ fits: false, reason: "exhausted" });
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("started");
      expect(await room()).toMatchObject({ fits: true, pendingItems: 1 });
      expect(await room(1.5)).toMatchObject({ fits: true, pendingItems: 1 });
      expect(await room(1.5001)).toMatchObject({ fits: false, reason: "exhausted", pendingItems: 1 });
      const item = (await admin.query("SELECT work_item_id FROM proposals WHERE id = $1", [f.proposal])).rows[0].work_item_id;
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'local', 'pending')`, [randomUUID(), f.t.accountId, item]);
      expect(await room()).toMatchObject({ pendingItems: 0 });
    });
  });

  describe("no account is starved by another's waiting rows", () => {
    it("more old rows that always ask than one page holds, in one account, do not keep a startable row of another account from starting", async () => {
      const a = await fixture({ disposition: "ask" });
      const extra = await Promise.all(Array.from({ length: 52 }, () => addProposal(a.t)));
      await admin.query("UPDATE proposals SET verified_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])", [[a.proposal, ...extra]]);
      const b = await fixture();
      await gate.sweepAutoStart();
      expect(await written(b.t)).toMatchObject({ approved: 1, items: 1 });
      expect(await written(a.t)).toEqual(NOTHING);
    });
  });

  describe("the item's start decision: one row, decided by the dial", () => {
    it("an announce start leaves one started row decided by the dial, shown as started automatically; a later person-filed advance adds nothing and changes nothing", async () => {
      const f = await fixture();
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("started");
      const item = (await admin.query("SELECT work_item_id FROM proposals WHERE id = $1", [f.proposal])).rows[0].work_item_id as string;
      const rowsOf = async () => (await admin.query("SELECT decision_type, preset, dial_version, outcome, decided_by, receipt_id FROM start_gate WHERE work_item_id = $1", [item])).rows;
      const before = await rowsOf();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ decision_type: "start_work_small", preset: "balanced", dial_version: 1, outcome: "started", decided_by: "policy" });
      expect(before[0].receipt_id).not.toBeNull();
      const card = await withTenant(receiptPool, f.t.accountId, (c) => readStartDecision(c, item));
      expect(card).toMatchObject({ state: "started", by: "dial", name: null, sentence: "Started automatically under your Balanced setting. No one had to answer." });

      // The run action is filed for the person who confirmed the limit, so the stage driver sees a person's session. Its start gate finds the pair started.
      const receiptsBefore = Number((await admin.query("SELECT count(*) n FROM decision_receipts WHERE account_id = $1", [f.t.accountId])).rows[0].n);
      const click = await recordStartReceipt({ pool: receiptPool, accountId: f.t.accountId, userId: f.t.userId }, { workItemId: item, decisionType: "start_work_small", preset: "balanced" });
      expect(click).toMatchObject({ outcome: "started", replayed: true });
      expect(Number((await admin.query("SELECT count(*) n FROM decision_receipts WHERE account_id = $1", [f.t.accountId])).rows[0].n)).toBe(receiptsBefore);
      expect(await rowsOf()).toEqual(before);
      expect(await withTenant(receiptPool, f.t.accountId, (c) => readStartDecision(c, item))).toEqual(card);
    });

    it("an act start is recorded under the Autonomous setting and is not announced to the Inbox; an announce start is", async () => {
      const act = await fixture({ disposition: "act" });
      const say = await fixture();
      expect(await gate.gateProposal(act.t.accountId, act.proposal)).toBe("started");
      expect(await gate.gateProposal(say.t.accountId, say.proposal)).toBe("started");
      expect((await admin.query("SELECT preset FROM start_gate WHERE account_id = $1", [act.t.accountId])).rows).toEqual([{ preset: "autonomous" }]);
      const flag = (f: Fx) => withTenant(receiptPool, f.t.accountId, async (c) => (await readProposal(c, f.proposal)).auto_started);
      expect(await flag(act)).toBe(false);
      expect(await flag(say)).toBe(true);
    });

    it("a proposal a person approved, and one that is not approved, are not announced", async () => {
      const f = await fixture({ disposition: "ask" });
      expect(await withTenant(receiptPool, f.t.accountId, async (c) => (await readProposal(c, f.proposal)).auto_started)).toBe(false);
    });
  });

  describe("customer rules can only tighten", () => {
    const matchSmall = { op: "equals", field: "/request/tool", value: "start_work_small" };
    it("a deny rule stops the start and leaves the proposal new", async () => {
      const f = await fixture();
      await rulesFor(f.t, [{ id: "no-auto", outcome: "deny", when: matchSmall }]);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("held_by_rule");
      expect(await written(f.t)).toEqual(NOTHING);
    });
    it("an ask rule stops the start too", async () => {
      const f = await fixture();
      await rulesFor(f.t, [{ id: "ask-first", outcome: "ask", when: matchSmall }]);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("asked");
      expect(await written(f.t)).toEqual(NOTHING);
    });
    it("an approve rule changes nothing: it does not start what the dial would ask about, and it does not stop what the dial starts", async () => {
      const approve = [{ id: "ok", outcome: "approve", when: matchSmall }];
      const cautious = await fixture({ disposition: "ask" });
      await rulesFor(cautious.t, approve);
      expect(await gate.gateProposal(cautious.t.accountId, cautious.proposal)).toBe("asked");
      expect(await written(cautious.t)).toEqual(NOTHING);
      const balanced = await fixture();
      await rulesFor(balanced.t, approve);
      expect(await gate.gateProposal(balanced.t.accountId, balanced.proposal)).toBe("started");
    });
    it("a rule that does not match changes nothing, and the receipt names the rule set version that framed the start", async () => {
      const f = await fixture();
      await rulesFor(f.t, [{ id: "other", outcome: "deny", when: { op: "equals", field: "/request/tool", value: "start_work_bug" } }]);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("started");
      expect((await admin.query("SELECT rule_set_version FROM decision_receipts WHERE account_id = $1", [f.t.accountId])).rows[0].rule_set_version).toBe(1);
    });
    it("a stored rule set that cannot be read asks, never starts", async () => {
      const f = await fixture();
      await rulesFor(f.t, [{ id: "bad", outcome: "approve", when: { op: "nope" } }]);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("asked");
      expect(await written(f.t)).toEqual(NOTHING);
    });
    it("a rule on the facts sees the limit's room and the first run's price in dollars", async () => {
      const f = await fixture({ amount: 2.5 });
      await rulesFor(f.t, [{ id: "price", outcome: "deny", when: { op: "all", of: [{ op: "equals", field: "/facts/first_run_usd", value: 1 }, { op: "equals", field: "/facts/remaining_usd", value: 2.5 }, { op: "equals", field: "/facts/category", value: "small" }] } }]);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("held_by_rule");
    });
  });

  describe("every query is the tenant's own", () => {
    it("a proposal id of another account, named under this account, is not found and nothing is written for either", async () => {
      const a = await fixture();
      const b = await fixture();
      expect(await gate.gateProposal(a.t.accountId, b.proposal)).toBe("replayed");
      expect(await gate.gateProposal(b.t.accountId, a.proposal)).toBe("replayed");
      expect(await written(a.t)).toEqual(NOTHING);
      expect(await written(b.t)).toEqual(NOTHING);
    });
    it("each account's own limit and dial decide its own proposals in one pass", async () => {
      const a = await fixture({ amount: 2.5 });
      const noLimit = await fixture({ amount: null });
      const ask = await fixture({ disposition: "ask" });
      await gate.sweepAutoStart();
      expect(await written(a.t)).toMatchObject({ approved: 1 });
      expect(await written(noLimit.t)).toEqual(NOTHING);
      expect(await written(ask.t)).toEqual(NOTHING);
    });
    it("the room of one account is not spent by another's started items", async () => {
      const a = await fixture({ amount: 1 });
      const b = await fixture({ amount: 1 });
      expect(await gate.gateProposal(a.t.accountId, a.proposal)).toBe("started");
      expect(await gate.gateProposal(b.t.accountId, b.proposal)).toBe("started");
    });
  });

  describe("the sweep is the receipt login's alone and names no person", () => {
    it("an issue that already has an open work item is not taken over", async () => {
      const f = await fixture();
      const gh = (await admin.query("SELECT gh_number FROM proposals WHERE id = $1", [f.proposal])).rows[0].gh_number;
      await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance, title, stage) VALUES ($1, $2, 'issue', $3, 'internal', 'Mine', 'triaged')`, [f.t.accountId, f.t.repoId, gh]);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("not_ready");
      expect((await admin.query("SELECT state FROM proposals WHERE id = $1", [f.proposal])).rows[0].state).toBe("new");
    });
    it("a withdrawn dial approval is never approved again by the dial", async () => {
      const f = await fixture();
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("started");
      await admin.query("UPDATE proposals SET state = 'new', work_item_id = NULL, roadmap_position = NULL, decided_at = NULL WHERE id = $1", [f.proposal]);
      expect((await admin.query("SELECT dial_withdrawn_at FROM proposals WHERE id = $1", [f.proposal])).rows[0].dial_withdrawn_at).not.toBeNull();
      await admin.query("UPDATE work_items SET stage = 'closed' WHERE account_id = $1", [f.t.accountId]);
      const before = await written(f.t);
      expect(await gate.gateProposal(f.t.accountId, f.proposal)).toBe("not_ready");
      expect(await written(f.t)).toEqual(before);
    });
  });
});
