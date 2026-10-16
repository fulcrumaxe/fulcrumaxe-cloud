import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PARKED_STAGE_REGISTRY, type ParkedStageEntry } from "@fx/pipeline";
import { createStageResume } from "../src/stageResume.js";
import type { AdvanceStartArgs } from "../src/advance.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#483 S5-k1c [pg]: the parked-stage sweep for the starts before the build (classify, the first Spec and the re-spec), over real rows and the REAL registry
 * entries. The cross-tenant list, the tenant-scoped checks and the spend check are the real ones; the seat is the only fake (it hands the sweep the limits this
 * test moves). A run row is a real `agent_runs` row with its real idempotency key, as the denied asks leave them.
 */
describe("the parked-stage sweep for classify, the first Spec and the re-spec [pg]", { timeout: 90_000 }, () => {
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

  type StageName = "classify" | "spec" | "respec";
  const entryOf = (stage: StageName): ParkedStageEntry => PARKED_STAGE_REGISTRY[stage]!;
  const limits = (monthlyModelBudgetUsd: number) => ({ current: monthlyModelBudgetUsd });
  function seatFor(l: { current: number }): (r: { accountId: string; workItemId?: string }) => Promise<SeatResult> {
    return async (r) => ({ ok: true, seat: { spend: { plan: "starter", purpose: "run", trigger: "foreground", workItemId: r.workItemId, workItemKind: "feature", estimateModelUsd: 5, estimateComputeUsd: 0, monthlyModelBudgetUsd: l.current, perSpawnCapUsd: 40 } } }) as never;
  }
  function sweeper(l: { current: number }, started: AdvanceStartArgs[], clock: { t: number }) {
    return createStageResume(writerPool, { resolveRunSeat: seatFor(l) as never, startAdvance: async (args) => void started.push(args), now: () => clock.t, log: () => undefined });
  }
  const mine = (started: AdvanceStartArgs[], w: string) => started.filter((s) => s.workItemId === w);
  const stale = (w: string) => admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '20 minutes' WHERE work_item_id = $1", [w]);

  let n = 12000;
  interface Parked {
    a: SeedRefs;
    /** The parked item (the one the waiting fact is on and the workflow restarts for). */
    w: string;
    /** The item the approval targets: the same item, or the retired card the pipeline's own card replaced. */
    approvalTarget: string;
    approval: string;
  }
  interface Opts {
    stage?: string;
    pause?: string;
    ageSeconds?: number;
    halted?: boolean;
    approver?: boolean;
    /** The first Spec stage: the approval is on the retired webhook card (the real shape after a triage) rather than on the item itself. */
    onOrigin?: boolean;
    specAfterApproval?: boolean;
    provenance?: string;
  }
  const ITEM_STAGE: Record<StageName, string> = { classify: "triaged", spec: "discussing", respec: "spec_ready" };

  /** An item parked at `stage`, its person-given approval, and a waiting fact `ageSeconds` old. */
  async function parked(stage: StageName, o: Opts = {}): Promise<Parked> {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    const w = randomUUID();
    const kind = stage === "classify" ? "issue" : "feature";
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, $4, $5, $6, $7)", [w, a.accountId, a.repoId, kind, o.provenance ?? "internal", o.stage ?? ITEM_STAGE[stage], n++]);
    let approvalTarget = w;
    if (stage === "spec" && o.onOrigin !== false) {
      // The webhook's card, retired when the pipeline made its own card for the issue: closed with `superseded:<this item>`.
      approvalTarget = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'closed', $4)", [approvalTarget, a.accountId, a.repoId, n++]);
      await admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`, [a.accountId, approvalTarget, `superseded:${w}`]);
    }
    if (stage === "respec") {
      await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
      await admin.query("UPDATE spec_versions SET created_at = now() - interval '2 days' WHERE work_item_id = $1", [w]);
    }
    const approval = randomUUID();
    const kindOfApproval = entryOf(stage).approval.kind;
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, $3, $4, $5, 'session', $6, 'done', now() - interval '1 day', $7::jsonb)`,
      [approval, a.accountId, kindOfApproval, approvalTarget, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: approvalTarget, advance: "started" })],
    );
    if (o.specAfterApproval) await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 2, 'spec 2', encode(sha256(convert_to('spec 2', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', $3, $4, 0, $5)", [a.accountId, w, stage, o.pause ?? "account_budget_reached", randomUUID()]);
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1", [w, o.ageSeconds ?? 5 * 3600]);
    if (o.halted) await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [w, randomUUID()]);
    return { a, w, approvalTarget, approval };
  }

  /** An earlier ask's run row and its key (a refused_spend run, as the denied asks leave). */
  async function earlierAsk(p: Parked, key: string, status = "refused_spend"): Promise<void> {
    const run = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'production', $4)", [run, p.a.accountId, p.w, status]);
    await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [p.a.accountId, key, run, "0".repeat(64)]);
  }
  /** The keys the stage's own starts made for the approval, as the web steps and the Spec step build them (bare, then `:s<n>`). */
  const keysOf = (stage: StageName, p: Parked): string[] => {
    const base = stage === "classify" ? `advance:${p.w}:classify:${p.approval}` : stage === "respec" ? `advance:${p.w}:respec:${p.approval}` : `advance:${p.w}:spec:${randomUUID()}:pm:${p.approval}`;
    return [base, `${base}:s1`, `${base}:s2`];
  };

  const counts = async (accountId: string) => ({
    runs: Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n),
    reservations: Number((await admin.query("SELECT count(*) AS n FROM spend_reservations WHERE account_id = $1", [accountId])).rows[0].n),
    facts: Number((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE account_id = $1 AND kind = 'stage_waiting'", [accountId])).rows[0].n),
  });
  const stageOf = async (w: string) => (await admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [w])).rows[0]!;

  const STAGES: StageName[] = ["classify", "spec", "respec"];

  describe.each(STAGES)("%s", (stage) => {
    it("S5k1c-4: three days with the limit still denied, the sweep makes no run row, no reservation and no workflow, and only refreshes the stage's own waiting fact", async () => {
      const p = await parked(stage);
      for (const k of keysOf(stage, p)) await earlierAsk(p, k);
      const l = limits(1); // the monthly model budget is below the 5 dollar estimate
      const started: AdvanceStartArgs[] = [];
      const clock = { t: Date.now() };
      const before = await counts(p.a.accountId);
      for (let day = 0; day < 3; day += 1) {
        for (let pass = 0; pass < 3; pass += 1) {
          clock.t += 15 * 60_000;
          await stale(p.w); // the fact the last pass wrote is twenty minutes old by the next, as in production
          const out = await sweeper(l, started, clock).sweepParkedStages([entryOf(stage)]);
          expect(out.nextDueAt).not.toBeNull();
        }
      }
      expect(mine(started, p.w)).toEqual([]);
      const after = await counts(p.a.accountId);
      expect(after.runs).toBe(before.runs);
      expect(after.reservations).toBe(before.reservations);
      expect(after.facts).toBeGreaterThan(before.facts);
      const last = await admin.query("SELECT code, stage FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1", [p.w]);
      expect(last.rows[0]).toEqual({ code: "account_budget_reached", stage });
      // The item did not move and nothing was stamped.
      expect(await stageOf(p.w)).toEqual({ stage: ITEM_STAGE[stage], halted_at: null });
    });

    it("S5k1c-4: once the limit is raised the next pass restarts the workflow under the same approval, with no person, at an attempt above every earlier one", async () => {
      const p = await parked(stage);
      const made = keysOf(stage, p);
      const keys = [...made, `${made[0]}:s3`];
      for (const k of keys) await earlierAsk(p, k);
      const l = limits(1);
      const started: AdvanceStartArgs[] = [];
      const clock = { t: Date.now() };
      await sweeper(l, started, clock).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toEqual([]);
      const before = await counts(p.a.accountId);
      l.current = 600;
      clock.t += 15 * 60_000;
      await stale(p.w);
      await sweeper(l, started, clock).sweepParkedStages([entryOf(stage)]);
      // classify and the first Spec build on no published Spec; the re-spec carries the version the person saw and says it is a re-spec.
      const expected: AdvanceStartArgs = { accountId: p.a.accountId, userId: p.a.userId, workItemId: p.w, actionId: p.approval, haltEpoch: 0, startAttempt: 4 };
      if (stage === "respec") Object.assign(expected, { specVersion: 1, respec: true });
      expect(mine(started, p.w)).toEqual([expected]);
      // The sweep itself made no run and no reservation: the workflow's own start does that.
      const after = await counts(p.a.accountId);
      expect(after.reservations).toBe(before.reservations);
      expect(after.runs).toBe(before.runs);
    });

    it("with no earlier run at all the restart uses the first attempt and carries no startAttempt", async () => {
      const p = await parked(stage);
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      const base: AdvanceStartArgs = { accountId: p.a.accountId, userId: p.a.userId, workItemId: p.w, actionId: p.approval, haltEpoch: 0 };
      expect(mine(started, p.w)).toEqual([stage === "respec" ? { ...base, specVersion: 1, respec: true } : base]);
    });

    it("S5k1c-5: a halted item is not resumed", async () => {
      const p = await parked(stage, { halted: true });
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toEqual([]);
    });

    it("S5k1c-5: an item that is cancelled or closed, or has moved on to another stage, is not resumed", async () => {
      const started: AdvanceStartArgs[] = [];
      const closed = await parked(stage, { stage: "closed" });
      const cancelled = await parked(stage, { stage: "closed_unmerged" });
      const moved = await parked(stage, { stage: "in_progress" });
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      for (const x of [closed, cancelled, moved]) expect(mine(started, x.w), x.w).toEqual([]);
    });

    it("S5k1c-5: a live run, a person's approval in flight, a lowered approver, a missing approval and an external item are not resumed", async () => {
      const started: AdvanceStartArgs[] = [];
      const live = await parked(stage);
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'production', 'running')", [randomUUID(), live.a.accountId, live.w]);
      const inFlight = await parked(stage);
      await admin.query("INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state) VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, 'accepted')", [inFlight.a.accountId, inFlight.approvalTarget, `session:${inFlight.a.userId}`, "h".repeat(64)]);
      const lowered = await parked(stage);
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [lowered.a.accountId, lowered.a.userId]);
      const none = await parked(stage);
      await admin.query("DELETE FROM run_action_requests WHERE id = $1", [none.approval]);
      const external = await parked(stage, { provenance: "external" });
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      for (const x of [live, inFlight, lowered, none, external]) expect(mine(started, x.w), x.w).toEqual([]);
    });

    it("a stage that already really ran (a run that did not end refused_spend) is not started again every pass", async () => {
      const p = await parked(stage);
      await earlierAsk(p, keysOf(stage, p)[0]!, "succeeded");
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toEqual([]);
    });

    it("S5k1c-6: a restart that ended in a refusal that is not a limit left a stop after the wait; it is not restarted again every pass, and a later limit pause makes it the sweep's again", async () => {
      const p = await parked(stage);
      await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', $3, $4)", [p.a.accountId, p.w, `${stage}_refused`, randomUUID()]);
      const started: AdvanceStartArgs[] = [];
      const clock = { t: Date.now() };
      for (let pass = 0; pass < 3; pass += 1) {
        clock.t += 15 * 60_000;
        await stale(p.w);
        await sweeper(limits(600), started, clock).sweepParkedStages([entryOf(stage)]);
      }
      expect(mine(started, p.w)).toEqual([]);
      await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', $3, 'account_budget_reached', 1, $4)", [p.a.accountId, p.w, stage, randomUUID()]);
      await admin.query("UPDATE work_item_driver_events SET created_at = created_at - interval '1 hour' WHERE work_item_id = $1", [p.w]);
      await sweeper(limits(600), started, clock).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toHaveLength(1);
    });

    it("a denial that is not a pause (the account is not active) writes nothing and starts nothing", async () => {
      const p = await parked(stage);
      await admin.query("UPDATE accounts SET status = 'paused', owner_paused_at = now() WHERE id = $1", [p.a.accountId]);
      const started: AdvanceStartArgs[] = [];
      const before = await counts(p.a.accountId);
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toEqual([]);
      expect(await counts(p.a.accountId)).toEqual(before);
    });

    it("S5k1c-7 (mutation): without the headroom check the item would start a workflow every pass; the real sweep, over the same passes, starts none", async () => {
      const p = await parked(stage);
      const started: AdvanceStartArgs[] = [];
      const clock = { t: Date.now() };
      const skipsCheck = createStageResume(writerPool, { resolveRunSeat: seatFor(limits(600)) as never, startAdvance: async (args) => void started.push(args), now: () => clock.t, log: () => undefined });
      for (let pass = 0; pass < 3; pass += 1) {
        clock.t += 15 * 60_000;
        await stale(p.w);
        await skipsCheck.sweepParkedStages([entryOf(stage)]);
      }
      expect(mine(started, p.w).length).toBe(3); // 3 workflows, each of which would write a refused_spend run row
      const real: AdvanceStartArgs[] = [];
      const q = await parked(stage);
      for (let pass = 0; pass < 3; pass += 1) {
        clock.t += 15 * 60_000;
        await stale(q.w);
        await sweeper(limits(1), real, clock).sweepParkedStages([entryOf(stage)]);
      }
      expect(mine(real, q.w)).toEqual([]);
    });
  });

  it("the re-spec: a Spec written after the approval ends the parking (what runs is what was approved)", async () => {
    const p = await parked("respec", { specAfterApproval: true });
    const started: AdvanceStartArgs[] = [];
    const out = await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("respec")]);
    expect(mine(started, p.w)).toEqual([]);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
  });

  it("the re-spec listens to its own kind of approval: a Build approval is not a re-spec approval", async () => {
    const p = await parked("respec");
    await admin.query("UPDATE run_action_requests SET kind = 'advance_work_item' WHERE id = $1", [p.approval]);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("respec")]);
    expect(mine(started, p.w)).toEqual([]);
  });

  it("the first Spec: an approval on the item itself (a person approved the Discussing card again) counts too", async () => {
    const p = await parked("spec", { onOrigin: false });
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("spec")]);
    expect(mine(started, p.w)).toHaveLength(1);
    expect(mine(started, p.w)[0]).toMatchObject({ actionId: p.approval, workItemId: p.w });
  });

  it("the first Spec: an approval on a card that was NOT replaced by this item does not count", async () => {
    const p = await parked("spec");
    // Point the retired card's mark at some other item.
    await admin.query("UPDATE work_item_transitions SET source_ref = $2 WHERE work_item_id = $1", [p.approvalTarget, `superseded:${randomUUID()}`]);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("spec")]);
    expect(mine(started, p.w)).toEqual([]);
  });

  it("the short Spec's keys count as the Spec stage's earlier asks (an item gets the PM's or the short Spec's, not both)", async () => {
    const p = await parked("spec", { stage: "triaged" });
    for (const k of [`advance:${p.w}:light-spec:${p.approval}`, `advance:${p.w}:light-spec:${p.approval}:s1`, `advance:${p.w}:light-spec:${p.approval}:s4`]) await earlierAsk(p, k);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("spec")]);
    expect(mine(started, p.w)).toEqual([{ accountId: p.a.accountId, userId: p.a.userId, workItemId: p.w, actionId: p.approval, haltEpoch: 0, startAttempt: 5 }]);
  });

  it("the stages do not read each other's facts: a classify fact is not the Spec's, even on the same item stage", async () => {
    const p = await parked("classify");
    await admin.query("UPDATE work_item_driver_events SET stage = 'spec' WHERE work_item_id = $1", [p.w]);
    const started: AdvanceStartArgs[] = [];
    await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("classify")]);
    expect(mine(started, p.w)).toEqual([]);
  });
});
