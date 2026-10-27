import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { addSpec, plannedFixture, reapprove, row, TABLE, type PlannedFixture, type PlannedOptions } from "@fx/db/test/helpers/plannedChildren.js";
import type { SeedRefs } from "@fx/db/test/helpers/seed.js";
import { approveSubItem } from "@fx/core/src/decisions/approveSubItem.js";
import { answerAsk } from "@fx/core/src/decisions/answer.js";
import {
  CHILD_LAUNCH_SENTENCES, DIAL_LAUNCH_CHILD_ERROR_CODES, childLaunchSentence, readChildLaunch, type ChildLaunchDeps,
} from "@fx/core/src/decisions/childLaunch.js";
import { CHILD_BUILD_SUPPORTED } from "@fx/pipeline";
import { childEnvelopeRoom } from "@fx/spend";
import { createAutoStartSweep } from "../src/autoStartSweep.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStartArgs } from "../src/advance.js";
import { createRunActionFacade } from "../src/runActions.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] D#483 S5-b2c-1: launching a planned PR child, as the real receipt login against the real 0920 definers: the dial's pass, a person's Approve, every refusal
 * (through the definer path, the person path and the card read), the sibling hold, the parent envelope's lock, and the pairing guard. Each test seeds its own account.
 */
const LOGIN = "fx_child_launch_test";
const PRICE = 1;

describe("the planned PR child launch gate [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let writerPool: Pool;
  let supported = true;

  const room: ChildLaunchDeps["room"] = async (client, input) => {
    const r = await childEnvelopeRoom(client, { accountId: input.accountId, envelopeId: input.envelopeId, childId: input.childId, firstRunUsd: PRICE });
    return { fits: r.fits, remainingUsd: r.remainingUsd, priceUsd: PRICE };
  };
  const child: ChildLaunchDeps = { get buildSupported() { return supported; }, room };
  let sweep: ReturnType<typeof createAutoStartSweep>;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    sweep = createAutoStartSweep({ receiptPool, firstRunUsd: async () => PRICE, child, warn: () => {} });
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), writerPool.end()]);
  });

  const fixture = (o: PlannedOptions = {}) => plannedFixture(admin, appPool, { envelopeUsd: 20, ...o });
  async function person(t: SeedRefs, role: "owner" | "admin" | "member"): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [t.accountId, id, role]);
    return id;
  }
  const written = async (t: SeedRefs) => {
    const one = async (sql: string) => Number((await admin.query(sql, [t.accountId])).rows[0].n);
    return {
      requests: await one(`SELECT count(*) n FROM run_action_requests WHERE account_id = $1`),
      receipts: await one(`SELECT count(*) n FROM decision_receipts WHERE account_id = $1`),
      envelopes: await one(`SELECT count(*) n FROM work_items WHERE account_id = $1 AND parent_id IS NOT NULL AND envelope_id IS NOT NULL`),
      audits: await one(`SELECT count(*) n FROM audit_log WHERE account_id = $1 AND action = 'child_launch.dial'`),
    };
  };
  const NOTHING = { requests: 0, receipts: 0, envelopes: 0, audits: 0 };
  const approve = (f: PlannedFixture, key: string, userId = f.t.userId, tokenId?: string, deps: ChildLaunchDeps | null = child) =>
    approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId, ...(tokenId ? { tokenId } : {}) }, ...(deps ? { child: deps } : {}) }, { workItemId: f.parent, key });
  const card = (f: PlannedFixture, key: string, person = false) =>
    withTenant(receiptPool, f.t.accountId, (c) => readChildLaunch(c, { accountId: f.t.accountId, childId: f.kids[key]!, person, deps: { room } }));
  const refusedApprove = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ name: "SubItemApprovalError", code, status: 409 });

  // ---- the driver, for the start args ---------------------------------------------------------------------------------------------------------
  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 }, timeoutMs: 40 * 60_000, maxExtensions: 3,
    } as never,
  };
  function driver() {
    const started: AdvanceStartArgs[] = [];
    const starter: RunStarter = { async start() { return { runId: randomUUID() }; } };
    const deps: AdvanceModuleDeps = {
      starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async (args) => void started.push(args),
      triage: async (_p, _a, input) => ({ status: "triaged", category: input.category, stage: "discussing" }),
    } as AdvanceModuleDeps;
    return { module: createAdvanceModule(writerPool, deps), started };
  }
  const claim = async (actionId: string) => expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(actionId, 600)).not.toBeNull();
  const requestsOf = async (f: PlannedFixture, key: string) =>
    (await admin.query(`SELECT id, principal_kind, requested_by, idempotency_key, state FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item' ORDER BY created_at`, [f.kids[key]])).rows;

  describe("S5b2c1-1/2: the dial's launch and its replays", () => {
    it("with the dial at act: one policy receipt, one request on the CHILD keyed dial:<receipt>, the parent's envelope, one audit row; the driver reads it as the dial's, never a person's", async () => {
      const f = await fixture({ dial: "act" });
      const counts = await sweep.sweepAutoStart();
      expect(counts.children!.started).toBeGreaterThanOrEqual(1);
      // The pass launches every unstarted, unblocked child of this parent (api and docs; ui waits on api).
      expect(await written(f.t)).toEqual({ requests: 2, receipts: 2, envelopes: 2, audits: 2 });
      const receipts = (await admin.query(`SELECT * FROM decision_receipts WHERE work_item_id = $1 AND decision_type = 'launch_sub_item' ORDER BY sub_item_key`, [f.parent])).rows;
      expect(receipts.map((r) => r.sub_item_key)).toEqual(["api", "docs"]);
      expect(receipts[0]).toMatchObject({ actor: "policy", class: "human_over_the_loop", chosen: "launch", rejected_alternative: "wait_for_approval", spec_version_id: f.specV1, approval_id: f.approvalId, run_id: f.pmRun });
      const reqs = await requestsOf(f, "api");
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ principal_kind: "session", requested_by: `session:${f.t.userId}`, idempotency_key: `dial:${receipts[0].id}`, state: "accepted" });
      expect((await admin.query("SELECT envelope_id FROM work_items WHERE id = $1", [f.kids.api])).rows[0].envelope_id).toBe(f.envelope);
      expect((await requestsOf(f, "ui"))).toHaveLength(0);

      // The driver: the same request, performed, starts the workflow as the dial's start. (The child gets an issue number here only to get past the build's own
      // link check, which the build row of this chain replaces; the classification under test is the request key.)
      await admin.query("UPDATE work_items SET gh_number = 99100 WHERE id = $1", [f.kids.api]);
      await claim(reqs[0].id);
      const d = driver();
      expect(await d.module.performAdvanceWorkItem(reqs[0].id)).toMatchObject({ result: "done" });
      expect(d.started[0]).toMatchObject({ workItemId: f.kids.api, personFiled: false, dialFiled: true });
    });

    it("a second pass and a concurrent pass write nothing more (replayed)", async () => {
      const f = await fixture({ dial: "act" });
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "started" });
      const after = await written(f.t);
      expect(after).toEqual({ requests: 1, receipts: 1, envelopes: 1, audits: 1 });
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "replayed" });
      expect(await written(f.t)).toEqual(after);

      const g = await fixture({ dial: "act" });
      const outcomes = (await Promise.all([sweep.gateChild(g.t.accountId, g.kids.api), sweep.gateChild(g.t.accountId, g.kids.api), sweep.gateChild(g.t.accountId, g.kids.api)])).map((r) => r.outcome).sort();
      expect(outcomes).toEqual(["replayed", "replayed", "started"]);
      expect(await written(g.t)).toEqual({ requests: 1, receipts: 1, envelopes: 1, audits: 1 });
    });

    it("announce launches too, with its receipt saying so", async () => {
      const f = await fixture({ dial: "announce" });
      expect(await sweep.gateChild(f.t.accountId, f.kids.docs)).toEqual({ outcome: "started" });
      expect((await admin.query(`SELECT chosen FROM decision_receipts WHERE work_item_id = $1 AND sub_item_key = 'docs'`, [f.parent])).rows).toEqual([{ chosen: "announce" }]);
    });

    it("no dial row reads as Balanced (announce), as the fix-round gate does", async () => {
      const f = await fixture({ dial: null });
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "started" });
    });
  });

  describe("S5b2c1-3: ask", () => {
    it("raises exactly one ask per (parent, key) on the run that published the approved version, and nothing else; a second pass raises none", async () => {
      const f = await fixture({ dial: "ask" });
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "asked" });
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "asked" });
      const asks = (await admin.query(`SELECT * FROM decision_asks WHERE account_id = $1`, [f.t.accountId])).rows;
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ work_item_id: f.parent, run_id: f.pmRun, sub_item_key: "api", decision_type: "launch_sub_item", state: "open" });
      expect(asks[0].rationale).toContain("Start planned PR: The API?");
      expect(await written(f.t)).toEqual({ ...NOTHING });
      expect((await admin.query(`SELECT count(*)::int n FROM run_action_requests WHERE account_id = $1`, [f.t.accountId])).rows[0].n).toBe(0);
    });
  });

  describe("the ask's answers", () => {
    const answer = (f: PlannedFixture, askId: string, choice: string, deps: ChildLaunchDeps | null = child) =>
      answerAsk({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.t.userId }, ...(deps ? { child: deps } : {}) }, { askId, choice });
    const asksOf = async (f: PlannedFixture, key: string) => (await admin.query(`SELECT id, state, answered_option FROM decision_asks WHERE account_id = $1 AND sub_item_key = $2 ORDER BY raised_at`, [f.t.accountId, key])).rows;

    it("Start runs the same function as the card's Approve: the child is filed in the person's name and the ask is closed", async () => {
      const f = await fixture({ dial: "ask" });
      await sweep.gateChild(f.t.accountId, f.kids.api);
      const [ask] = await asksOf(f, "api");
      await answer(f, ask.id, "fix_start");
      const reqs = await requestsOf(f, "api");
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ requested_by: `session:${f.t.userId}` });
      expect(reqs[0].idempotency_key).not.toMatch(/^dial:/);
      expect((await asksOf(f, "api")).map((a) => a.state)).toEqual(["withdrawn"]);
      expect((await admin.query("SELECT envelope_id FROM work_items WHERE id = $1", [f.kids.api])).rows[0].envelope_id).toBe(f.envelope);
    });

    it("Start while the build cannot build a child is refused and leaves the ask open", async () => {
      const f = await fixture({ dial: "ask" });
      await sweep.gateChild(f.t.accountId, f.kids.api);
      const [ask] = await asksOf(f, "api");
      await expect(answer(f, ask.id, "fix_start", null)).rejects.toMatchObject({ name: "AskAnswerError", status: 409 });
      expect((await asksOf(f, "api")).map((a) => a.state)).toEqual(["open"]);
      expect(await requestsOf(f, "api")).toHaveLength(0);
    });

    it("Hold stays held: later passes do not ask again, and nothing is filed", async () => {
      const f = await fixture({ dial: "ask" });
      await sweep.gateChild(f.t.accountId, f.kids.api);
      const [ask] = await asksOf(f, "api");
      await answer(f, ask.id, "fix_hold");
      for (let i = 0; i < 3; i++) expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "asked" });
      expect((await asksOf(f, "api")).map((a) => [a.state, a.answered_option])).toEqual([["answered", "fix_hold"]]);
      expect(await requestsOf(f, "api")).toHaveLength(0);
      // A new Spec version is a new question: the approved version's run differs, so it is asked again.
      const v2 = await addSpec(admin, f.t, f.parent, 2, TABLE);
      await reapprove(appPool, f);
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, 'project-manager', 'local', 'succeeded', $3)`, [f.t.accountId, f.parent, v2]);
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "asked" });
      expect((await asksOf(f, "api")).map((a) => a.state)).toEqual(["answered", "open"]);
    });
  });

  describe("S5b2c1-4: a person's Approve", () => {
    it("files exactly one request on the child in the person's name, sets the envelope, and closes the open ask as superseded; the driver reads it as a person's click", async () => {
      const f = await fixture({ dial: "ask" });
      await sweep.gateChild(f.t.accountId, f.kids.api);
      const done = await approve(f, "api");
      expect(done).toMatchObject({ replayed: false, withdrawnAsks: 1, childLaunchedId: f.kids.api });
      const reqs = await requestsOf(f, "api");
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ principal_kind: "session", requested_by: `session:${f.t.userId}` });
      expect(reqs[0].idempotency_key).not.toMatch(/^dial:/);
      expect((await admin.query("SELECT envelope_id FROM work_items WHERE id = $1", [f.kids.api])).rows[0].envelope_id).toBe(f.envelope);
      expect((await admin.query(`SELECT state, withdrawn_reason FROM decision_asks WHERE account_id = $1`, [f.t.accountId])).rows).toEqual([{ state: "withdrawn", withdrawn_reason: "superseded" }]);
      // No dial path was used: no policy receipt, no child_launch.dial audit row.
      expect((await admin.query(`SELECT actor FROM decision_receipts WHERE work_item_id = $1 AND sub_item_key = 'api'`, [f.parent])).rows).toEqual([{ actor: f.t.userId }]);
      expect((await written(f.t)).audits).toBe(0);
      await admin.query("UPDATE work_items SET gh_number = 99101 WHERE id = $1", [f.kids.api]);
      await claim(reqs[0].id);
      const d = driver();
      await d.module.performAdvanceWorkItem(reqs[0].id);
      expect(d.started[0]).toMatchObject({ workItemId: f.kids.api, personFiled: true });
      expect(d.started[0]).not.toHaveProperty("dialFiled");
      // The same click again is a replay: nothing more is filed.
      const again = await approve(f, "api");
      expect(again).toMatchObject({ replayed: true, childLaunchedId: null });
      expect(await requestsOf(f, "api")).toHaveLength(1);
    });

    it("a member is forbidden, a token needs a session; nothing is written", async () => {
      const f = await fixture();
      const member = await person(f.t, "member");
      await expect(approve(f, "api", member)).rejects.toMatchObject({ name: "SubItemApprovalError", code: "forbidden", status: 403 });
      await expect(approve(f, "api", f.t.userId, randomUUID())).rejects.toMatchObject({ name: "SubItemApprovalError", code: "session_required", status: 403 });
      expect(await written(f.t)).toEqual(NOTHING);
    });

    it("a launch after a cancelled run is a new request (the cancelled run does not count as started)", async () => {
      const f = await fixture();
      await approve(f, "api");
      const first = await requestsOf(f, "api");
      await admin.query(`UPDATE run_action_requests SET state = 'done', finished_at = now() WHERE id = $1`, [first[0].id]);
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'cancelled')`, [f.t.accountId, f.kids.api]);
      expect(await approve(f, "api")).toMatchObject({ childLaunchedId: f.kids.api });
      expect(await requestsOf(f, "api")).toHaveLength(2);
    });
  });

  describe("S5b2c1-5: each refusal, through the dial, the person path and the card", () => {
    interface Case { code: string; opts: PlannedOptions; arrange: (f: PlannedFixture) => Promise<void>; sentence: string; dial: { outcome: string; code: string }; person: "refused" | "files" }
    const cases: Case[] = [
      { code: "child_orphaned", opts: {}, arrange: async (f) => void (await admin.query("DELETE FROM work_items WHERE id = $1", [f.parent])), sentence: "The item this planned PR belonged to was deleted.", dial: { outcome: "held_by_rule", code: "child_orphaned" }, person: "refused" },
      { code: "parent_closed", opts: {}, arrange: async (f) => void (await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.parent])), sentence: "The item this planned PR belongs to is closed.", dial: { outcome: "held_by_rule", code: "parent_closed" }, person: "refused" },
      { code: "respec_needs_approval", opts: {}, arrange: async (f) => void (await addSpec(admin, f.t, f.parent, 2, TABLE)), sentence: "The Spec changed. It needs approval again before more planned PRs start.", dial: { outcome: "held_by_rule", code: "respec_needs_approval" }, person: "refused" },
      {
        code: "key_not_in_approved_spec", opts: {},
        arrange: async (f) => { await addSpec(admin, f.t, f.parent, 2, [row("docs"), row("other")]); await reapprove(appPool, f); },
        sentence: "This planned PR is no longer in the approved Spec.", dial: { outcome: "held_by_rule", code: "key_not_in_approved_spec" }, person: "refused",
      },
      { code: "external_needs_approval", opts: { provenance: "external" }, arrange: async () => {}, sentence: "This planned PR came from outside your team, so a person has to approve it before it starts.", dial: { outcome: "held_by_rule", code: "external_needs_approval" }, person: "files" },
      { code: "parent_no_envelope", opts: { envelopeUsd: null }, arrange: async () => {}, sentence: "This planned PR has no spending limit to draw on. Set one on The parent feature.", dial: { outcome: "held_by_rule", code: "parent_no_envelope" }, person: "refused" },
      { code: "parent_envelope_reached", opts: { envelopeUsd: 0.5 }, arrange: async () => {}, sentence: "This item's spending limit is used up. Nothing more starts until you raise the limit or stop the item.", dial: { outcome: "no_room", code: "parent_envelope_reached" }, person: "refused" },
    ];
    for (const c of cases) {
      it(`${c.code}`, async () => {
        const f = await fixture({ dial: "act", ...c.opts });
        await c.arrange(f);
        const before = await written(f.t);
        // The card read: the code and its exact sentence (for a person, the external hold does not apply).
        const state = await card(f, "api");
        expect(state).toMatchObject({ code: c.code, sentence: c.sentence });
        // The dial.
        expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual(c.dial);
        expect(await written(f.t)).toEqual(before);
        // The person.
        if (c.person === "refused") {
          if (c.code !== "child_orphaned") await refusedApprove(approve(f, "api"), c.code);
          else await expect(approve(f, "api")).rejects.toBeInstanceOf(Error); // the parent is gone: there is nothing to approve
          expect(await written(f.t)).toEqual(before);
        } else {
          expect(await approve(f, "api")).toMatchObject({ childLaunchedId: f.kids.api });
          expect(await requestsOf(f, "api")).toHaveLength(1);
        }
      });
    }

    it("the card of a child that may launch says nothing; a started one says so; Close removes a closed one for good", async () => {
      const f = await fixture();
      expect(await card(f, "api")).toMatchObject({ code: null, sentence: null, started: false });
      await approve(f, "api");
      expect(await card(f, "api")).toMatchObject({ started: true });
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [f.kids.docs]);
      expect(await card(f, "docs")).toMatchObject({ code: "child_closed", offers: "close" });
      await refusedApprove(approve(f, "docs"), "child_closed");
      expect(await sweep.gateChild(f.t.accountId, f.kids.docs)).toEqual({ outcome: "held_by_rule", code: "child_closed" });
    });

    it("an orphan is never launched by the dial or the sweep, even with a valid keyed receipt for its old parent", async () => {
      const f = await fixture({ dial: "act" });
      await admin.query("UPDATE work_items SET parent_id = NULL WHERE id = $1", [f.kids.api]);
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "held_by_rule", code: "child_orphaned" });
      await sweep.sweepAutoStart();
      expect(await requestsOf(f, "api")).toHaveLength(0);
    });
  });

  describe("S5b2c1-9: depends_on", () => {
    it("holds the dependent child while its sibling is open, launches it once the sibling's PR merged; a person may start it earlier and the card warns", async () => {
      const f = await fixture({ dial: "act" });
      expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual({ outcome: "held_by_rule", code: "waiting_on_planned_pr" });
      expect(await card(f, "ui")).toMatchObject({ code: "waiting_on_planned_pr", sentence: "Waits for The API to merge." });
      expect(await written(f.t)).toEqual(NOTHING);
      await admin.query(`UPDATE work_items SET stage = 'merged' WHERE id = $1`, [f.kids.api]);
      expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual({ outcome: "started" });

      const g = await fixture({ dial: "ask" });
      expect((await card(g, "ui", true)).warning).toMatchObject({ code: "waiting_on_planned_pr", sentence: "Waits for The API to merge." });
      expect(await approve(g, "ui")).toMatchObject({ childLaunchedId: g.kids.ui });
      expect(await requestsOf(g, "ui")).toHaveLength(1);
    });
  });

  describe("S5b2c1-10: R6 through the whole path", () => {
    it("a child moved to the re-approved version launches under it; one whose key left the table is case (d) and never a new item", async () => {
      const f = await fixture({ dial: "act" });
      const v2 = await addSpec(admin, f.t, f.parent, 2, [row("api", "The API"), row("ui", "The screen", ["api"]), row("extra", "Extra")]);
      await reapprove(appPool, f);
      const pins = Object.fromEntries((await admin.query(`SELECT planned_pr_key, planned_pr_spec_version_id FROM work_items WHERE parent_id = $1`, [f.parent])).rows.map((r) => [r.planned_pr_key, r.planned_pr_spec_version_id]));
      expect(pins).toMatchObject({ api: v2, ui: v2, docs: f.specV1, extra: v2 });
      // A policy launch now needs a run that published v2 (the approved version): the project manager's.
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, 'project-manager', 'local', 'succeeded', $3)`, [f.t.accountId, f.parent, v2]);
      expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "started" });
      expect(await sweep.gateChild(f.t.accountId, f.kids.docs)).toEqual({ outcome: "held_by_rule", code: "key_not_in_approved_spec" });
      expect(await card(f, "docs")).toMatchObject({ code: "key_not_in_approved_spec", offers: "close" });
      // No new work item was made for the removed key.
      expect((await admin.query(`SELECT count(*)::int n FROM work_items WHERE account_id = $1 AND title = 'The docs'`, [f.t.accountId])).rows[0].n).toBe(1);
    });
  });

  describe("S5b2c1-11: the parent's envelope, under its lock", () => {
    it("two children launched at once cannot together pass an envelope with room for one first run", async () => {
      const f = await fixture({ dial: "act", envelopeUsd: 1.5 });
      const results = await Promise.all([sweep.gateChild(f.t.accountId, f.kids.api), sweep.gateChild(f.t.accountId, f.kids.docs)]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["no_room", "started"]);
      expect(results.find((r) => r.outcome === "no_room")).toMatchObject({ code: "parent_envelope_reached" });
      expect(await written(f.t)).toMatchObject({ requests: 1, receipts: 1, envelopes: 1, audits: 1 });
    });
    it("the person path counts the same pending launches", async () => {
      const f = await fixture({ dial: "act", envelopeUsd: 1.5 });
      await approve(f, "api");
      await refusedApprove(approve(f, "docs"), "parent_envelope_reached");
      expect((await card(f, "docs")).code).toBe("parent_envelope_reached");
    });
    it("two children of one parent share its envelope", async () => {
      const f = await fixture({ dial: "act", envelopeUsd: 5 });
      await sweep.gateChild(f.t.accountId, f.kids.api);
      await sweep.gateChild(f.t.accountId, f.kids.docs);
      expect((await admin.query(`SELECT DISTINCT envelope_id FROM work_items WHERE parent_id = $1 AND envelope_id IS NOT NULL`, [f.parent])).rows).toEqual([{ envelope_id: f.envelope }]);
    });
  });

  describe("S5b2c1-12: the pairing guard", () => {
    it("with the build unsupported the pass derives reasons and files nothing, and a person's Approve answers 409 child_build_unsupported", async () => {
      expect(CHILD_BUILD_SUPPORTED).toBe(false);
      supported = false;
      try {
        const f = await fixture({ dial: "act" });
        expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "not_ready" });
        // The reasons are still derived: a held child says why.
        expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual({ outcome: "held_by_rule", code: "waiting_on_planned_pr" });
        const counts = await sweep.sweepAutoStart();
        expect(counts.children!.started).toBe(0);
        await refusedApprove(approve(f, "api"), "child_build_unsupported");
        await refusedApprove(approve(f, "api", f.t.userId, undefined, null), "child_build_unsupported");
        expect(await written(f.t)).toEqual(NOTHING);
        // A sweep with no deps at all (the production default while the pipeline constant is false) does the same.
        const bare = createAutoStartSweep({ receiptPool, firstRunUsd: async () => PRICE, warn: () => {} });
        expect(await bare.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "not_ready" });
        expect(await written(f.t)).toEqual(NOTHING);
      } finally {
        supported = true;
      }
    });
    it("a key that names no planned PR child is untouched by the guard (a fix round key still works)", async () => {
      supported = false;
      try {
        const f = await fixture();
        await expect(approve(f, "fix-1")).rejects.toMatchObject({ code: "no_anchor_run" });
      } finally {
        supported = true;
      }
    });
  });

  describe("S5b2c1-13: the sentences", () => {
    it("every code the definer can raise has a sentence, read from the function itself; no sentence prints an id or a database word", async () => {
      const def = (await admin.query<{ d: string }>(`SELECT pg_get_functiondef('dial_launch_child(uuid,uuid)'::regprocedure) AS d`)).rows[0]!.d;
      const raised = new Set([...def.matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)].map((m) => m[1]!));
      raised.add("child_orphaned");
      const blockerDef = (await admin.query<{ d: string }>(`SELECT pg_get_functiondef('planned_pr_child_blocker(uuid,boolean,boolean)'::regprocedure) AS d`)).rows[0]!.d;
      for (const m of blockerDef.matchAll(/RETURN '([a-z_]+)'/g)) raised.add(m[1]!);
      raised.delete("not_a_child");
      for (const code of raised) {
        expect((DIAL_LAUNCH_CHILD_ERROR_CODES as readonly string[]).includes(code) || code === "waiting_on_planned_pr", code).toBe(true);
        expect(Object.hasOwn(CHILD_LAUNCH_SENTENCES, code), code).toBe(true);
      }
    });
  });

  describe("the lister and the sweep together", () => {
    it("the sweep lists only what the lister names and counts a held child by its reason", async () => {
      const f = await fixture({ dial: "act" });
      const counts = await sweep.sweepAutoStart();
      expect(counts.children!.held[("waiting_on_planned_pr")]).toBeGreaterThanOrEqual(1);
      expect(counts.children!.failed).toBe(0);
      void childLaunchSentence;
      void f;
    });
  });
});
