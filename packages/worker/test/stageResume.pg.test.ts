import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createStageResume, type ParkedStageEntryInput } from "../src/stageResume.js";
import type { AdvanceStartArgs } from "../src/advance.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#483 S5-k1b [pg]: the parked-stage sweep over real rows (the cross-tenant definer list, the tenant-scoped checks, the REAL spend check). The seat is the
 * only fake: it hands the sweep the reservation parameters the real resolver would, with the limits this test moves.
 */
describe("the parked-stage sweep [pg]", { timeout: 60_000 }, () => {
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

  const PAUSES = ["account_budget_reached", "compute_cap_reached", "item_cap_reached", "run_limit_below_estimate"];
  const DENIALS: Record<string, string> = { model_budget_exceeded: "account_budget_reached", compute_cap_exceeded: "compute_cap_reached", work_item_cap_exceeded: "item_cap_reached", per_spawn_cap_exceeded: "run_limit_below_estimate" };
  const keyOf = (item: string, approval: string, suffix = ""): string => `advance:${item}:build:v1:${approval}${suffix}`;
  const entry: ParkedStageEntryInput = {
    stage: "build",
    itemStages: ["spec_ready"],
    pauses: PAUSES,
    role: "executor",
    approval: { kind: "advance_work_item", from: "self" },
    needsSpec: true,
    respec: false,
    runKeyLikes: (item, approval) => [`advance:${item}:build:v%:${approval}%`],
    nextAttempt: (keys) => (keys.length === 0 ? 0 : Math.max(...keys.map((k) => Number(/:s(\d+)(?::n[0-9a-f]{16})?$/.exec(k)?.[1] ?? 0))) + 1),
    pauseForDenial: (d) => DENIALS[d] ?? null,
  };

  /** The limits the fake seat reports; a test moves them to model the person raising a budget (or the month turning). */
  function limits(monthlyModelBudgetUsd: number) {
    return { current: monthlyModelBudgetUsd };
  }
  function seatFor(l: { current: number }): (r: { accountId: string; workItemId?: string }) => Promise<SeatResult> {
    return async (r) =>
      ({
        ok: true,
        seat: { spend: { plan: "starter", purpose: "run", trigger: "foreground", workItemId: r.workItemId, workItemKind: "feature", estimateModelUsd: 5, estimateComputeUsd: 0, monthlyModelBudgetUsd: l.current, perSpawnCapUsd: 40 } },
      }) as never;
  }

  let n = 7000;
  /** A Spec-ready item with a Spec, a performed approval by the account's owner, and a limit-pause fact `ageSeconds` old. */
  async function parked(o: { ageSeconds?: number; pause?: string; stage?: string; halted?: boolean; specAfterApproval?: boolean; provenance?: string } = {}) {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    const w = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', $4, $5, $6)", [w, a.accountId, a.repoId, o.provenance ?? "internal", o.stage ?? "spec_ready", n++]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    await admin.query("UPDATE spec_versions SET created_at = now() - interval '2 days' WHERE work_item_id = $1", [w]);
    const approval = randomUUID();
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - interval '1 day', $6::jsonb)`,
      [approval, a.accountId, w, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: w, advance: "started" })],
    );
    if (o.specAfterApproval) await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 2, 'spec 2', encode(sha256(convert_to('spec 2', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', $3, 0, $4)", [a.accountId, w, o.pause ?? "account_budget_reached", randomUUID()]);
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1", [w, o.ageSeconds ?? 3 * 3600]);
    if (o.halted) await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [w, randomUUID()]);
    return { a, w, approval };
  }

  /** An earlier ask's run row and its key (a refused_spend run, as the denied asks leave). */
  async function earlierAsk(a: SeedRefs, w: string, key: string): Promise<void> {
    const run = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'refused_spend')", [run, a.accountId, w]);
    await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [a.accountId, key, run, "0".repeat(64)]);
  }

  const counts = async (accountId: string) => ({
    runs: Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n),
    reservations: Number((await admin.query("SELECT count(*) AS n FROM spend_reservations WHERE account_id = $1", [accountId])).rows[0].n),
    facts: Number((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE account_id = $1 AND kind = 'stage_waiting'", [accountId])).rows[0].n),
  });

  function sweeper(l: { current: number }, started: AdvanceStartArgs[], clock: { t: number }) {
    return createStageResume(writerPool, { resolveRunSeat: seatFor(l) as never, startAdvance: async (args) => void started.push(args), now: () => clock.t, log: () => undefined });
  }
  /** The sweep sees every account on the shared database; a test looks only at its own item. */
  const mine = (started: AdvanceStartArgs[], w: string) => started.filter((s) => s.workItemId === w);

  it("S5k-5: three days with the limit still denied, the sweep creates no run row, no reservation and no workflow; it only refreshes the waiting fact once per pass", async () => {
    const { a, w, approval } = await parked();
    await earlierAsk(a, w, keyOf(w, approval));
    const l = limits(1); // the monthly model budget is below the 5 dollar estimate
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    const before = await counts(a.accountId);
    for (let day = 0; day < 3; day += 1) {
      for (let pass = 0; pass < 3; pass += 1) {
        clock.t += 15 * 60_000;
        // The fact the last pass wrote is ten minutes old by the next one, as in production.
        await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);
        const out = await sweeper(l, started, clock).sweepParkedStages([entry]);
        expect(out.nextDueAt).not.toBeNull();
      }
    }
    expect(mine(started, w)).toEqual([]);
    const after = await counts(a.accountId);
    expect(after.runs).toBe(before.runs);
    expect(after.reservations).toBe(before.reservations); // the account's seeded baseline row, and nothing the sweep made
    expect(after.facts).toBeGreaterThan(before.facts); // refreshed, so the card keeps naming the limit
    const last = await admin.query("SELECT code, stage FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1", [w]);
    expect(last.rows[0]).toEqual({ code: "account_budget_reached", stage: "build" });
  });

  it("S5-d: an item parked on its spend envelope is refreshed while the envelope denies the run, and resumes the pass after a new envelope version covers it (no run row from the sweep)", async () => {
    const { a, w, approval } = await parked({ pause: "envelope_reached" });
    await earlierAsk(a, w, keyOf(w, approval));
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 1, 1, $3)`, [envelopeId, a.accountId, a.userId]);
    await admin.query("UPDATE work_items SET envelope_id = $1 WHERE id = $2", [envelopeId, w]);
    const envEntry: ParkedStageEntryInput = { ...entry, pauses: [...PAUSES, "envelope_reached"], pauseForDenial: (d) => (d === "envelope_exceeded" ? "envelope_reached" : DENIALS[d] ?? null) };
    const l = limits(600);
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    const before = await counts(a.accountId);
    await sweeper(l, started, clock).sweepParkedStages([envEntry]);
    expect(mine(started, w)).toEqual([]);
    const refreshed = await counts(a.accountId);
    expect(refreshed.runs).toBe(before.runs);
    expect(refreshed.facts).toBeGreaterThan(before.facts);
    expect((await admin.query("SELECT code FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1", [w])).rows[0].code).toBe("envelope_reached");
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 50, 2, $3)`, [envelopeId, a.accountId, a.userId]);
    clock.t += 15 * 60_000;
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);
    await sweeper(l, started, clock).sweepParkedStages([envEntry]);
    expect(mine(started, w)).toHaveLength(1);
    expect(mine(started, w)[0]).toMatchObject({ workItemId: w, startAttempt: 1 });
  });

  it("S5k-5: once the limit is raised the next pass starts the workflow on the same approval, with no person, at an attempt above every earlier one", async () => {
    const { a, w, approval } = await parked();
    for (const suffix of ["", ":s1", ":s2", ":s3:n0123456789abcdef"]) await earlierAsk(a, w, keyOf(w, approval, suffix));
    const l = limits(1);
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    await sweeper(l, started, clock).sweepParkedStages([entry]);
    expect(mine(started, w)).toEqual([]);
    const before = await counts(a.accountId);
    l.current = 600;
    clock.t += 15 * 60_000;
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);
    const out = await sweeper(l, started, clock).sweepParkedStages([entry]);
    expect(out.resumed).toBeGreaterThanOrEqual(1);
    expect(mine(started, w)).toEqual([{ accountId: a.accountId, userId: a.userId, workItemId: w, actionId: approval, haltEpoch: 0, specVersion: 1, startAttempt: 4 }]);
    // The sweep itself made no run and no reservation: the workflow's own start does that.
    const after = await counts(a.accountId);
    expect(after.reservations).toBe(before.reservations);
    expect(after.runs).toBe(before.runs);
  });

  it("with no earlier run at all the restart uses the first attempt and carries no startAttempt", async () => {
    const { a, w, approval } = await parked();
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, w)).toEqual([{ accountId: a.accountId, userId: a.userId, workItemId: w, actionId: approval, haltEpoch: 0, specVersion: 1 }]);
  });

  it("two passes in the same quarter hour start one workflow (the claim is one fact per attempt per pass)", async () => {
    const { w } = await parked();
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    await sweeper(limits(600), started, clock).sweepParkedStages([entry]);
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);
    await sweeper(limits(600), started, clock).sweepParkedStages([entry]);
    expect(mine(started, w)).toHaveLength(1);
  });

  it("S5k-6: a halted item is not listed, so it is never resumed", async () => {
    const { w } = await parked({ halted: true });
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, w)).toEqual([]);
  });

  it("S5k-6: an item whose Spec changed since the approval is not resumed", async () => {
    const { w } = await parked({ specAfterApproval: true });
    const started: AdvanceStartArgs[] = [];
    const out = await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, w)).toEqual([]);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
  });

  it("an item that left Spec ready, a live run, a person's approval in flight, a lowered approver, an external item: none is resumed", async () => {
    const started: AdvanceStartArgs[] = [];
    const moved = await parked({ stage: "in_progress" });
    const live = await parked();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')", [randomUUID(), live.a.accountId, live.w]);
    const inFlight = await parked();
    await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state) VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, 'accepted')", [inFlight.a.accountId, inFlight.w, `session:${inFlight.a.userId}`, "h".repeat(64)]);
    const lowered = await parked();
    await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [lowered.a.accountId, lowered.a.userId]);
    const external = await parked({ provenance: "external" });
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    for (const x of [moved, live, inFlight, lowered, external]) expect(mine(started, x.w), x.w).toEqual([]);
  });

  /** A second performed approval on the item by a new member with `role`, finished `hoursAgo` hours ago (the parked() approval finished one day ago). */
  async function secondApprover(a: SeedRefs, w: string, role: string, hoursAgo: number): Promise<{ userId: string; approval: string }> {
    const userId = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [a.accountId, userId, role]);
    const approval = randomUUID();
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - make_interval(hours => $6::int), $7::jsonb)`,
      [approval, a.accountId, w, `session:${userId}`, "g".repeat(64), hoursAgo, JSON.stringify({ work_item_id: w, advance: "started" })],
    );
    return { userId, approval };
  }

  it("the LATEST performed approval decides: a newer approver who was lowered stops the item even though an older approver is still an admin", async () => {
    const { a, w } = await parked(); // the account's owner approved one day ago and is still an owner
    const newer = await secondApprover(a, w, "member", 2); // a newer approval, by someone no longer an owner or admin
    const started: AdvanceStartArgs[] = [];
    const out = await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, w)).toEqual([]);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    expect(newer.userId).not.toBe(a.userId);
  });

  it("the LATEST performed approval decides: a newer approver who is an admin restarts it on that approval even though the older approver was lowered", async () => {
    const { a, w } = await parked();
    await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]); // the older approver is gone
    const newer = await secondApprover(a, w, "admin", 2);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, w)).toEqual([{ accountId: a.accountId, userId: newer.userId, workItemId: w, actionId: newer.approval, haltEpoch: 0, specVersion: 1 }]);
  });

  it("a restart that ended in a refusal that is not a limit is not restarted again every pass; a later limit pause makes it the sweep's again", async () => {
    const { a, w } = await parked();
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_refused', 'start_no_model', $3)", [a.accountId, w, randomUUID()]);
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    for (let pass = 0; pass < 3; pass += 1) {
      clock.t += 15 * 60_000;
      await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);
      await sweeper(limits(600), started, clock).sweepParkedStages([entry]);
      expect(mine(started, w)).toEqual([]);
    }
    expect(mine(started, w)).toEqual([]);
    // A `stopped` fact after the wait does the same.
    const other = await parked();
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', 'respec_list_unreadable', $3)", [other.a.accountId, other.w, randomUUID()]);
    await sweeper(limits(600), started, clock).sweepParkedStages([entry]);
    expect(mine(started, other.w)).toEqual([]);
    // A newer limit pause (a later ask that a limit denied) puts the item back in the sweep's hands.
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', 'account_budget_reached', 1, $3)", [a.accountId, w, randomUUID()]);
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '1 hour' WHERE work_item_id = $1", [w]);
    await sweeper(limits(600), started, clock).sweepParkedStages([entry]);
    expect(mine(started, w)).toHaveLength(1);
  });

  it("a fresh fact (a workflow is still asking) is left alone; a fact for another stage or a slot wait is not this sweep's", async () => {
    const started: AdvanceStartArgs[] = [];
    const fresh = await parked({ ageSeconds: 60 });
    const slot = await parked({ pause: "waiting_for_build_slot_repo" });
    const other = await parked();
    await admin.query("UPDATE work_item_driver_events SET stage = 'classify' WHERE work_item_id = $1", [other.w]);
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    for (const x of [fresh, slot, other]) expect(mine(started, x.w), x.w).toEqual([]);
  });

  it("a denial that is not a pause (the account is not active) writes nothing and starts nothing", async () => {
    const { a, w } = await parked();
    await admin.query("UPDATE accounts SET status = 'paused', owner_paused_at = now() WHERE id = $1", [a.accountId]);
    const started: AdvanceStartArgs[] = [];
    const before = await counts(a.accountId);
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, w)).toEqual([]);
    expect(await counts(a.accountId)).toEqual(before);
  });

  it("S5k1b-12 (mutation): with the registry entry removed, nothing is resumed", async () => {
    const { w } = await parked();
    const started: AdvanceStartArgs[] = [];
    const out = await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([]);
    expect(mine(started, w)).toEqual([]);
    expect(out).toMatchObject({ stages: 0, listed: 0, resumed: 0 });
  });

  it("S5k-7 (mutation): without the headroom check a denied item would start a workflow every pass", async () => {
    // The check is the only thing between a listed item and a start: a seat that always says yes (what skipping the check amounts to, since the start's own
    // reserve() is what would deny) restarts the item on every pass while the limit still denies.
    const { w } = await parked();
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    const skipsCheck = createStageResume(writerPool, { resolveRunSeat: seatFor(limits(600)) as never, startAdvance: async (args) => void started.push(args), now: () => clock.t, log: () => undefined });
    const l = limits(1);
    for (let pass = 0; pass < 3; pass += 1) {
      clock.t += 15 * 60_000;
      await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);
      await skipsCheck.sweepParkedStages([entry]);
    }
    expect(mine(started, w).length).toBe(3); // 3 workflows, each of which would write a refused_spend run row
    // The real sweep, with the limit denied, over the same passes: none.
    const real: AdvanceStartArgs[] = [];
    const { w: w2 } = await parked();
    for (let pass = 0; pass < 3; pass += 1) {
      clock.t += 15 * 60_000;
      await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w2]);
      await sweeper(l, real, clock).sweepParkedStages([entry]);
    }
    expect(mine(real, w2)).toEqual([]);
  });

  it("a failure on one item does not stop the pass", async () => {
    const bad = await parked();
    const good = await parked();
    const started: AdvanceStartArgs[] = [];
    const resolve = vi.fn(async (r: { accountId: string; workItemId?: string }) => {
      if (r.workItemId === bad.w) throw new Error("boom");
      return seatFor(limits(600))(r);
    });
    const sweep = createStageResume(writerPool, { resolveRunSeat: resolve as never, startAdvance: async (args) => void started.push(args), now: () => Date.now(), log: () => undefined });
    const out = await sweep.sweepParkedStages([entry]);
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(mine(started, good.w)).toHaveLength(1);
  });

  it("the definer list is refused arguments outside its bounds and is not callable by the web login", async () => {
    await expect(writerPool.query("SELECT * FROM work_item_list_parked_stage('nonsense', ARRAY['spec_ready'], ARRAY['x'], 0, 10)")).rejects.toThrow(/bad argument/);
    await expect(writerPool.query("SELECT * FROM work_item_list_parked_stage('build', ARRAY[]::text[], ARRAY['x'], 0, 10)")).rejects.toThrow(/bad argument/);
    await expect(writerPool.query("SELECT * FROM work_item_list_parked_stage('build', ARRAY['spec_ready'], ARRAY['x'], 0, 201)")).rejects.toThrow(/bad argument/);
    const appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    try {
      await expect(appPool.query("SELECT * FROM work_item_list_parked_stage('build', ARRAY['spec_ready'], ARRAY['x'], 0, 10)")).rejects.toThrow(/permission denied/);
    } finally {
      await appPool.end();
    }
  });
});
