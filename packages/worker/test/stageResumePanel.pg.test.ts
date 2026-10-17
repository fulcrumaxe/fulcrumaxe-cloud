import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PANEL_WHOLE_CODE, PARKED_STAGE_REGISTRY, UNREGISTERED_STAGES, registeredStages, type ParkedStageEntry } from "@fx/pipeline";
import { createStageResume } from "../src/stageResume.js";
import type { AdvanceStartArgs } from "../src/advance.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#483 S5-k1e [pg]: the parked-stage sweep for the panel, over real rows and the REAL registry entry. The cross-tenant list, the tenant-scoped checks and the spend
 * check are the real ones; the seat is the only fake (it hands the sweep the limits this test moves). Runs are real `agent_runs` rows with their real idempotency
 * keys: the seats that posted have a finished run, the seat a limit denied has a `refused_spend` one, as the panel leaves them.
 */
describe("the parked-stage sweep for the panel [pg]", { timeout: 90_000 }, () => {
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

  const entry: ParkedStageEntry = PARKED_STAGE_REGISTRY.panel!;
  const limits = (monthlyModelBudgetUsd: number) => ({ current: monthlyModelBudgetUsd });
  const seatFor = (l: { current: number }) => async (r: { accountId: string; workItemId?: string }) =>
    ({ ok: true, seat: { spend: { plan: "starter", purpose: "run", trigger: "foreground", workItemId: r.workItemId, workItemKind: "feature", estimateModelUsd: 5, estimateComputeUsd: 0, monthlyModelBudgetUsd: l.current, perSpawnCapUsd: 40 } } }) as SeatResult;
  function sweeper(l: { current: number }, started: AdvanceStartArgs[], clock: { t: number }) {
    return createStageResume(writerPool, { resolveRunSeat: seatFor(l) as never, startAdvance: async (args) => void started.push(args), now: () => clock.t, log: () => undefined });
  }
  const mine = (started: AdvanceStartArgs[], w: string) => started.filter((s) => s.workItemId === w);
  const stale = (w: string) => admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);

  let n = 14000;
  interface Parked {
    a: SeedRefs;
    w: string;
    approvalTarget: string;
    approval: string;
    disc: string;
  }
  interface Opts {
    stage?: string;
    pause?: string;
    ageSeconds?: number;
    halted?: boolean;
    onOrigin?: boolean;
    provenance?: string;
  }

  /** An item parked at the panel, its person-given approval (on the retired webhook card, the real shape after a triage) and a waiting fact `ageSeconds` old. */
  async function parked(o: Opts = {}): Promise<Parked> {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    const w = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', $4, $5, $6)", [w, a.accountId, a.repoId, o.provenance ?? "internal", o.stage ?? "discussing", n++]);
    let approvalTarget = w;
    if (o.onOrigin !== false) {
      approvalTarget = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'closed', $4)", [approvalTarget, a.accountId, a.repoId, n++]);
      await admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`, [a.accountId, approvalTarget, `superseded:${w}`]);
    }
    const approval = randomUUID();
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - interval '1 day', $6::jsonb)`,
      [approval, a.accountId, approvalTarget, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: approvalTarget, advance: "started" })],
    );
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'panel', $3, 0, $4)", [a.accountId, w, o.pause ?? "account_budget_reached", `wait:panel:${approval}:0`]);
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1", [w, o.ageSeconds ?? 5 * 3600]);
    if (o.halted) await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [w, randomUUID()]);
    return { a, w, approvalTarget, approval, disc: randomUUID() };
  }
  /** A seat's run row and its key. */
  async function seatRun(p: Parked, rest: string, role: string, status: string): Promise<void> {
    const run = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', $5)", [run, p.a.accountId, p.w, role, status]);
    await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [p.a.accountId, `advance:${p.w}:panel:${p.disc}${rest}`, run, "0".repeat(64)]);
  }
  /** Two seats posted, the third denied once (the shape S5k1e-2 leaves), plus the denied seat's attempts. */
  async function twoPostedOneDenied(p: Parked, deniedAttempts = 1): Promise<void> {
    await seatRun(p, ":r1:technical-architect", "technical-architect", "succeeded");
    await seatRun(p, ":r1:product-owner", "product-owner", "succeeded");
    await seatRun(p, ":r1:performance-expert", "performance-expert", "refused_spend");
    for (let i = 1; i < deniedAttempts; i += 1) await seatRun(p, `:s${i}:r1:performance-expert`, "performance-expert", "refused_spend");
  }

  const counts = async (accountId: string) => ({
    runs: Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n),
    reservations: Number((await admin.query("SELECT count(*) AS n FROM spend_reservations WHERE account_id = $1", [accountId])).rows[0].n),
    facts: Number((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE account_id = $1 AND kind = 'stage_waiting'", [accountId])).rows[0].n),
  });
  const itemRow = async (w: string) => (await admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [w])).rows[0]!;
  const expectedStart = (p: Parked, startAttempt?: number): AdvanceStartArgs => ({ accountId: p.a.accountId, userId: p.a.userId, workItemId: p.w, actionId: p.approval, haltEpoch: 0, ...(startAttempt ? { startAttempt } : {}) });

  it("S5k1e-7: the panel is the last stage to leave the allowlist; every stage is registered", () => {
    expect([...UNREGISTERED_STAGES]).toEqual([]);
    expect(registeredStages().map((e) => e.stage)).toContain("panel");
  });

  it("S5k1e-4: three days with the limit still denied, the sweep makes no run row, no reservation and no workflow; the posted seats keep their runs; only the waiting fact is refreshed", async () => {
    const p = await parked();
    await twoPostedOneDenied(p, 3);
    const l = limits(1);
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    const before = await counts(p.a.accountId);
    for (let day = 0; day < 3; day += 1) {
      for (let pass = 0; pass < 3; pass += 1) {
        clock.t += 15 * 60_000;
        await stale(p.w);
        const out = await sweeper(l, started, clock).sweepParkedStages([entry]);
        expect(out.nextDueAt).not.toBeNull();
      }
    }
    expect(mine(started, p.w)).toEqual([]);
    const after = await counts(p.a.accountId);
    expect(after.runs).toBe(before.runs);
    expect(after.reservations).toBe(before.reservations);
    expect(after.facts).toBeGreaterThan(before.facts);
    const last = await admin.query("SELECT code, stage FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1", [p.w]);
    expect(last.rows[0]).toEqual({ code: "account_budget_reached", stage: "panel" });
    // The item did not move and nothing was stamped; the seats that posted still have their one finished run each.
    expect(await itemRow(p.w)).toEqual({ stage: "discussing", halted_at: null });
    expect((await admin.query("SELECT role, status FROM agent_runs WHERE work_item_id = $1 AND status = 'succeeded' ORDER BY role", [p.w])).rows).toEqual([
      { role: "product-owner", status: "succeeded" },
      { role: "technical-architect", status: "succeeded" },
    ]);
  });

  it("S5k1e-4: once the limit is raised the next pass restarts the workflow under the same approval, with no person, at an attempt above every earlier one; the sweep itself makes no run", async () => {
    const p = await parked();
    await twoPostedOneDenied(p, 3); // the denied seat asked at attempts 0, 1 and 2
    const l = limits(1);
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    await sweeper(l, started, clock).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([]);
    const before = await counts(p.a.accountId);
    l.current = 600;
    clock.t += 15 * 60_000;
    await stale(p.w);
    await sweeper(l, started, clock).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([expectedStart(p, 3)]);
    const after = await counts(p.a.accountId);
    expect(after.runs).toBe(before.runs);
    expect(after.reservations).toBe(before.reservations);
  });

  it("the posted seats' finished runs are expected beside the denied one: they are not read as 'the stage already ran'", async () => {
    const p = await parked();
    await twoPostedOneDenied(p);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toHaveLength(1);
  });

  it("a whole-round denial left no run row: the restart is above the attempts the workflow wrote on its waiting facts, so its own facts are not found already written", async () => {
    const p = await parked();
    // The workflow asked 5 times (attempts 0..4) and every ask was denied by the whole-round check: facts, and no run at all.
    for (let i = 1; i <= 4; i += 1) await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'panel', 'account_budget_reached', $3, $4)", [p.a.accountId, p.w, i, `wait:panel:${p.approval}:${i}`]);
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '5 hours' WHERE work_item_id = $1", [p.w]);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([expectedStart(p, 5)]);
  });

  it("the sweep's own refreshes do not move the number: three passes with the limit denied, then raised, give the same attempt as no passes", async () => {
    const p = await parked();
    for (let i = 1; i <= 4; i += 1) await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'panel', 'account_budget_reached', $3, $4)", [p.a.accountId, p.w, i, `wait:panel:${p.approval}:${i}`]);
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '5 hours' WHERE work_item_id = $1", [p.w]);
    const l = limits(1);
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    for (let pass = 0; pass < 3; pass += 1) {
      clock.t += 15 * 60_000;
      await stale(p.w);
      await sweeper(l, started, clock).sweepParkedStages([entry]);
    }
    expect(mine(started, p.w)).toEqual([]);
    l.current = 600;
    clock.t += 15 * 60_000;
    await stale(p.w);
    await sweeper(l, started, clock).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([expectedStart(p, 5)]);
  });

  it("with only the first ask's fact and no run, the restart is the attempt after it (its fact is keyed by attempt 0, so a restart at 0 would find that fact already written)", async () => {
    const p = await parked();
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([expectedStart(p, 1)]);
  });

  it("an approval on the item itself (a person approved the Discussing card again) counts too", async () => {
    const p = await parked({ onOrigin: false });
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([expectedStart(p, 1)]);
  });

  it("S5k1e-6: a halted item is not resumed", async () => {
    const p = await parked();
    await twoPostedOneDenied(p);
    // Halted after the seats ran (a halted item cannot take a run row): the person's halt ends the parking.
    await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [p.w, randomUUID()]);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([]);
  });

  it("S5k1e-6: an item that has moved on (a Spec was written, so it sits at Spec ready), or is cancelled or closed, is not resumed", async () => {
    const started: AdvanceStartArgs[] = [];
    const ready = await parked({ stage: "spec_ready" });
    const closed = await parked({ stage: "closed" });
    const cancelled = await parked({ stage: "closed_unmerged" });
    for (const x of [ready, closed, cancelled]) await twoPostedOneDenied(x);
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    for (const x of [ready, closed, cancelled]) expect(mine(started, x.w), x.w).toEqual([]);
  });

  it("S5k1e-6: a live run (a seat still working), a person's approval in flight, a lowered approver, a missing approval and an external item are not resumed", async () => {
    const started: AdvanceStartArgs[] = [];
    const live = await parked();
    await seatRun(live, ":r1:technical-architect", "technical-architect", "running");
    const inFlight = await parked();
    await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state) VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, 'accepted')", [inFlight.a.accountId, inFlight.approvalTarget, `session:${inFlight.a.userId}`, "h".repeat(64)]);
    const lowered = await parked();
    await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [lowered.a.accountId, lowered.a.userId]);
    const none = await parked();
    await admin.query("DELETE FROM run_action_requests WHERE id = $1", [none.approval]);
    const external = await parked({ provenance: "external" });
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    for (const x of [live, inFlight, lowered, none, external]) expect(mine(started, x.w), x.w).toEqual([]);
  });

  it("a restart that ended in a refusal that is not a limit left a stop after the wait; it is not restarted again every pass, and a later limit pause makes it the sweep's again", async () => {
    const p = await parked();
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', 'panel_refused', $3)", [p.a.accountId, p.w, randomUUID()]);
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    for (let pass = 0; pass < 3; pass += 1) {
      clock.t += 15 * 60_000;
      await stale(p.w);
      await sweeper(limits(600), started, clock).sweepParkedStages([entry]);
    }
    expect(mine(started, p.w)).toEqual([]);
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'panel', 'account_budget_reached', 1, $3)", [p.a.accountId, p.w, `wait:panel:${p.approval}:1`]);
    await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '1 hour' WHERE work_item_id = $1", [p.w]);
    await sweeper(limits(600), started, clock).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toHaveLength(1);
  });

  it("a denial that is not a pause (the account is not active) writes nothing and starts nothing", async () => {
    const p = await parked();
    await admin.query("UPDATE accounts SET status = 'paused', owner_paused_at = now() WHERE id = $1", [p.a.accountId]);
    const started: AdvanceStartArgs[] = [];
    const before = await counts(p.a.accountId);
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([]);
    expect(await counts(p.a.accountId)).toEqual(before);
  });

  it("the panel does not read another stage's facts: a Spec fact on the same item stage is not the panel's, and the panel's is not the Spec's", async () => {
    const p = await parked();
    await admin.query("UPDATE work_item_driver_events SET stage = 'spec' WHERE work_item_id = $1", [p.w]);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entry]);
    expect(mine(started, p.w)).toEqual([]);
    const q = await parked();
    const asSpec: AdvanceStartArgs[] = [];
    await sweeper(limits(600), asSpec, { t: Date.now() }).sweepParkedStages([PARKED_STAGE_REGISTRY.spec!]);
    expect(mine(asSpec, q.w)).toEqual([]);
  });

  it("a restarted panel that completes and whose Spec then ends needs_owner_action is restarted ONCE: later passes start nothing, refresh no panel waiting fact and start no second Spec PM run", async () => {
    const p = await parked();
    await twoPostedOneDenied(p, 3);
    const l = limits(1);
    const clock = { t: Date.now() };
    const started: AdvanceStartArgs[] = [];
    // The restarted workflow, as the real one ends it: the denied seat posts, the panel is whole (the workflow records `stopped`/panel_whole at the attempt that got through),
    // the Spec step starts its PM (a run keyed by the restart's attempt, as the real one is) which finishes with needs_owner_action: no waiting fact follows.
    const sweep = createStageResume(writerPool, {
      resolveRunSeat: seatFor(l) as never,
      startAdvance: async (args) => {
        started.push(args);
        const attempt = args.startAttempt ?? 0;
        await seatRun(p, `:s${attempt}:r1:performance-expert`, "performance-expert", "succeeded");
        await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', $3, $4)", [p.a.accountId, p.w, PANEL_WHOLE_CODE, `panel_whole:${args.actionId}:${attempt}`]);
        const pm = randomUUID();
        await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'production', 'succeeded')", [pm, p.a.accountId, p.w]);
        await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [p.a.accountId, `advance:${p.w}:spec:1:pm:${args.actionId}:s${attempt}`, pm, "1".repeat(64)]);
      },
      now: () => clock.t,
      log: () => undefined,
    });
    await sweep.sweepParkedStages([entry]);
    expect(started).toHaveLength(0); // still denied: the limit is 1
    l.current = 600;
    const count = async (where: string) => Number((await admin.query(`SELECT count(*) AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stage_waiting' AND ${where}`, [p.w])).rows[0].n);
    for (let pass = 0; pass < 6; pass += 1) {
      clock.t += 15 * 60_000;
      await stale(p.w);
      await sweep.sweepParkedStages([entry]);
    }
    expect(mine(started, p.w)).toEqual([expectedStart(p, 3)]);
    expect(await count("dedupe_key LIKE 'resume:%'")).toBe(1); // the one claim of the one restart, and no new `resume:` fact since
    expect(await count("true")).toBe(3); // the parking's own fact, the first pass's refresh (limit still denied) and that claim
    expect(Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND role = 'project-manager'", [p.w])).rows[0].n)).toBe(1);
    expect(await itemRow(p.w)).toEqual({ stage: "discussing", halted_at: null });
  });

  it("S5k1e-7 (mutation): without the headroom check the item would start a workflow every pass; the real sweep, over the same passes, starts none", async () => {
    const p = await parked();
    const started: AdvanceStartArgs[] = [];
    const clock = { t: Date.now() };
    const skipsCheck = createStageResume(writerPool, { resolveRunSeat: seatFor(limits(600)) as never, startAdvance: async (args) => void started.push(args), now: () => clock.t, log: () => undefined });
    for (let pass = 0; pass < 3; pass += 1) {
      clock.t += 15 * 60_000;
      await stale(p.w);
      await skipsCheck.sweepParkedStages([entry]);
    }
    expect(mine(started, p.w).length).toBe(3);
    const real: AdvanceStartArgs[] = [];
    const q = await parked();
    for (let pass = 0; pass < 3; pass += 1) {
      clock.t += 15 * 60_000;
      await stale(q.w);
      await sweeper(limits(1), real, clock).sweepParkedStages([entry]);
    }
    expect(mine(real, q.w)).toEqual([]);
  });
});
