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
 * D#483 S5-k1d [pg]: the parked-stage sweep for a review and for a fix round, over real rows and the REAL registry entries. The cross-tenant list, the tenant-scoped
 * checks and the spend check are the real ones; the seat is the only fake (it hands the sweep the limits this test moves). A run row is a real `agent_runs` row with
 * its real idempotency key, as the denied asks leave them.
 */
describe("the parked-stage sweep for the reviewers and the fix round [pg]", { timeout: 90_000 }, () => {
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

  type StageName = "review" | "fix_round";
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

  const HEAD = "a".repeat(40);
  const NEW_HEAD = "b".repeat(40);
  const ITEM_STAGE: Record<StageName, string> = { review: "pr_opened", fix_round: "changes_requested" };

  let n = 31000;
  interface Parked {
    a: SeedRefs;
    w: string;
    approval: string;
  }
  interface Opts {
    stage?: string;
    pause?: string;
    ageSeconds?: number;
    halted?: boolean;
    head?: string | null;
    round?: number;
    specAfterApproval?: boolean;
    provenance?: string;
    /** A push of this head recorded before the wait began. */
    pushedBefore?: string;
    /** Rows written after the item exists and before its waiting fact (a hold must predate the wait: a later escalation would read as the stage moving on). */
    beforeWait?: (a: SeedRefs, w: string) => Promise<void>;
  }

  /** An item parked at `stage` on `HEAD`: its person-given approval, a published Spec older than it, and a waiting fact on the head `ageSeconds` old. */
  async function parked(stage: StageName, o: Opts = {}): Promise<Parked> {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    const w = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', $4, $5, $6)", [w, a.accountId, a.repoId, o.provenance ?? "internal", o.stage ?? ITEM_STAGE[stage], n++]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    await admin.query("UPDATE spec_versions SET created_at = now() - interval '2 days' WHERE work_item_id = $1", [w]);
    const approval = randomUUID();
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - interval '1 day', $6::jsonb)`,
      [approval, a.accountId, w, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: w, advance: "started" })],
    );
    if (o.specAfterApproval) await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 2, 'spec 2', encode(sha256(convert_to('spec 2', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    if (o.pushedBefore) await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, head_sha, dedupe_key) VALUES ($1, $2, 'pr_head_pushed', $3, $4)", [a.accountId, w, o.pushedBefore, randomUUID()]);
    if (o.beforeWait) await o.beforeWait(a, w);
    await waitingFact(a.accountId, w, stage, { pause: o.pause, head: o.head === undefined ? HEAD : o.head, round: o.round });
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1", [w, o.ageSeconds ?? 5 * 3600]);
    if (o.halted) await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [w, randomUUID()]);
    return { a, w, approval };
  }
  async function waitingFact(accountId: string, w: string, stage: StageName, o: { pause?: string; head: string | null; round?: number }): Promise<void> {
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, head_sha, pr_number, round, dedupe_key) VALUES ($1, $2, 'stage_waiting', $3, $4, 0, $5, 7, $6, $7)", [accountId, w, stage, o.pause ?? "account_budget_reached", o.head, o.round ?? null, randomUUID()]);
  }
  async function event(p: Parked, kind: string, head: string | null = null, code: string | null = null): Promise<void> {
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6)", [p.a.accountId, p.w, kind, code, head, randomUUID()]);
  }

  /** An earlier ask's run row and its key. */
  async function earlierRun(p: Parked, key: string, status = "refused_spend", role = "code-reviewer"): Promise<void> {
    const run = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', $5)", [run, p.a.accountId, p.w, role, status]);
    await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [p.a.accountId, key, run, "0".repeat(64)]);
  }
  const reviewKey = (p: Parked, role: string, suffix = "", head = HEAD) => `advance:${p.w}:review:${head}:${role}${suffix}`;
  const fixKey = (p: Parked, suffix = "", head = HEAD) => `advance:${p.w}:fix:${head}:${p.approval}${suffix}`;
  /** The keys a stage's own denied asks left: the bare key, then `:s1`, `:s2`. */
  async function deniedAsks(stage: StageName, p: Parked): Promise<void> {
    for (const s of ["", ":s1", ":s2"]) {
      if (stage === "review") await earlierRun(p, reviewKey(p, "code-reviewer", s));
      else await earlierRun(p, fixKey(p, s), "refused_spend", "executor");
    }
  }

  const counts = async (accountId: string) => ({
    runs: Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n),
    reservations: Number((await admin.query("SELECT count(*) AS n FROM spend_reservations WHERE account_id = $1", [accountId])).rows[0].n),
    facts: Number((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE account_id = $1 AND kind = 'stage_waiting'", [accountId])).rows[0].n),
  });
  const itemOf = async (w: string) => (await admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [w])).rows[0]!;

  const STAGES: StageName[] = ["review", "fix_round"];

  describe.each(STAGES)("%s", (stage) => {
    it("S5k1d-4: three days with the limit still denied, the sweep makes no run row, no reservation and no workflow, and refreshes the wait fact ON THE SAME HEAD; once the limit allows it, it starts at an attempt above every earlier one", async () => {
      const p = await parked(stage, { round: 1 });
      await deniedAsks(stage, p);
      const l = limits(1); // the monthly model budget is below the 5 dollar estimate
      const started: AdvanceStartArgs[] = [];
      const clock = { t: Date.now() };
      const before = await counts(p.a.accountId);
      for (let day = 0; day < 3; day += 1) {
        for (let pass = 0; pass < 3; pass += 1) {
          clock.t += 15 * 60_000;
          await stale(p.w);
          const out = await sweeper(l, started, clock).sweepParkedStages([entryOf(stage)]);
          expect(out.nextDueAt).not.toBeNull();
        }
      }
      expect(mine(started, p.w)).toEqual([]);
      const after = await counts(p.a.accountId);
      expect(after.runs).toBe(before.runs);
      expect(after.reservations).toBe(before.reservations);
      expect(after.facts).toBeGreaterThan(before.facts);
      const last = await admin.query("SELECT code, stage, head_sha, pr_number, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1", [p.w]);
      expect(last.rows[0]).toEqual({ code: "account_budget_reached", stage, head_sha: HEAD, pr_number: 7, round: 1 });
      // The item did not move and nothing was stamped.
      expect(await itemOf(p.w)).toEqual({ stage: ITEM_STAGE[stage], halted_at: null });

      // The limit is raised: the next pass starts the workflow, with no person, at an attempt above the three earlier ones, in the round the review was in.
      l.current = 600;
      clock.t += 15 * 60_000;
      await stale(p.w);
      const out = await sweeper(l, started, clock).sweepParkedStages([entryOf(stage)]);
      expect(out.resumed).toBe(1);
      const calls = mine(started, p.w);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ accountId: p.a.accountId, workItemId: p.w, actionId: p.approval, startAttempt: 3, startRereview: 1, specVersion: 1 });
      const claim = await admin.query("SELECT head_sha, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1", [p.w]);
      expect(claim.rows[0]).toEqual({ head_sha: HEAD, round: 1 });
    });

    it("S5k1d-4: no earlier run row at all starts at attempt 0 (the bare key), with no round in the arguments", async () => {
      const p = await parked(stage);
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      const call = mine(started, p.w)[0]!;
      expect(call).toBeDefined();
      expect(call.startAttempt).toBeUndefined();
      expect(call.startRereview).toBeUndefined();
    });

    it("S5k1d-5: a new head seen after the wait began ends the parking; the sweep does not restart the old head's review", async () => {
      const p = await parked(stage);
      await deniedAsks(stage, p);
      await event(p, "pr_head_pushed", NEW_HEAD);
      const started: AdvanceStartArgs[] = [];
      const out = await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toEqual([]);
      expect(out.skipped).toBeGreaterThanOrEqual(1);
    });

    it("S5k1d-5: a push of the very head that was waited on (the same commit seen again) does not end the parking", async () => {
      const p = await parked(stage);
      await event(p, "pr_head_pushed", HEAD, "observed");
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toHaveLength(1);
    });

    it("S5k1d-5: a push of another head BEFORE the wait began (an older head) does not end it", async () => {
      const p = await parked(stage, { pushedBefore: "c".repeat(40) });
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toHaveLength(1);
    });

    it("S5k1d-5: a merged or closed change (the item left the review positions) is not resumed", async () => {
      const merged = await parked(stage, { stage: "merged" });
      const closed = await parked(stage, { stage: "closed_unmerged" });
      const done = await parked(stage, { stage: "closed" });
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      for (const x of [merged, closed, done]) expect(mine(started, x.w), x.w).toEqual([]);
    });

    it("S5k1d-7 (mutation): without the head check the old head's review would be started again; the real sweep, over the same rows, starts none", async () => {
      const mutated = { ...entryOf(stage), headBound: false };
      const p = await parked(stage);
      await event(p, "pr_head_pushed", NEW_HEAD);
      const started: AdvanceStartArgs[] = [];
      const clock = { t: Date.now() };
      await createStageResume(writerPool, { resolveRunSeat: seatFor(limits(600)) as never, startAdvance: async (args) => void started.push(args), now: () => clock.t, log: () => undefined }).sweepParkedStages([mutated]);
      // (The mutated entry has no head to match run keys with, so it matches none and restarts at attempt 0.)
      expect(mine(started, p.w)).toHaveLength(1);
      const real: AdvanceStartArgs[] = [];
      const q = await parked(stage);
      await event(q, "pr_head_pushed", NEW_HEAD);
      await sweeper(limits(600), real, clock).sweepParkedStages([entryOf(stage)]);
      expect(mine(real, q.w)).toEqual([]);
    });

    it("a fact with no head is not resumed (nothing says which head the wait was for)", async () => {
      const p = await parked(stage, { head: null });
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toEqual([]);
    });

    it("a halted item, a changed Spec, a lowered approver and an external item are not resumed", async () => {
      const started: AdvanceStartArgs[] = [];
      const halted = await parked(stage, { halted: true });
      const specChanged = await parked(stage, { specAfterApproval: true });
      const lowered = await parked(stage);
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [lowered.a.accountId, lowered.a.userId]);
      const external = await parked(stage, { provenance: "external" });
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      for (const x of [halted, specChanged, lowered, external]) expect(mine(started, x.w), x.w).toEqual([]);
    });

    it("moved on after the wait: a fact the stage writes once it goes on (a started reviewer, a verdict, a fix round, a stop) ends the sweep's claim; a later limit pause makes it the sweep's again", async () => {
      for (const kind of ["review_started", "review_verdicts", "fix_round_started", "fix_round_refused", "merge_gate", "stopped", "escalated"]) {
        const p = await parked(stage);
        await event(p, kind, HEAD, kind === "stopped" ? "no_pr" : null);
        const started: AdvanceStartArgs[] = [];
        await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
        expect(mine(started, p.w), kind).toEqual([]);
        // A new waiting fact on the head (a later limit pause) is newer than the progress fact.
        await waitingFact(p.a.accountId, p.w, stage, { head: HEAD });
        await admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '20 minutes' WHERE work_item_id = $1", [p.w]);
        await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
        expect(mine(started, p.w), kind).toHaveLength(1);
      }
    });

    it("a live run of the item blocks the restart (a live run is never stopped, nor started over)", async () => {
      const p = await parked(stage);
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'code-reviewer', 'production', 'running')", [randomUUID(), p.a.accountId, p.w]);
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      expect(mine(started, p.w)).toEqual([]);
    });

    it("another head's run keys do not count against this head (the key names the head)", async () => {
      const p = await parked(stage);
      if (stage === "review") await earlierRun(p, reviewKey(p, "code-reviewer", "", NEW_HEAD), "succeeded");
      else await earlierRun(p, fixKey(p, "", NEW_HEAD), "succeeded", "executor");
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf(stage)]);
      const call = mine(started, p.w)[0]!;
      expect(call).toBeDefined();
      expect(call.startAttempt).toBeUndefined();
    });
  });

  describe("the review: a partial start", () => {
    it("a reviewer that started beside a reviewer that was denied does not stop the restart; the attempt is above the denied ask's, and the started one is not asked for again by the sweep", async () => {
      const p = await parked("review");
      await earlierRun(p, reviewKey(p, "code-reviewer"), "succeeded");
      await earlierRun(p, reviewKey(p, "acceptance-tester"), "refused_spend", "acceptance-tester");
      await earlierRun(p, reviewKey(p, "acceptance-tester", ":s1"), "refused_spend", "acceptance-tester");
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("review")]);
      expect(mine(started, p.w)).toHaveLength(1);
      expect(mine(started, p.w)[0]!.startAttempt).toBe(2);
    });

    it("the attempt reads through a re-review round and a placement generation: `:rr2:s3:p1` is attempt 3", async () => {
      const p = await parked("review");
      await earlierRun(p, reviewKey(p, "code-reviewer", ":rr2:s3:p1"));
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("review")]);
      expect(mine(started, p.w)[0]!.startAttempt).toBe(4);
    });

    it("a fix round that really started is the workflow's own outcome and is not started again every pass", async () => {
      const p = await parked("fix_round");
      await earlierRun(p, fixKey(p), "succeeded", "executor");
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("fix_round")]);
      expect(mine(started, p.w)).toEqual([]);
    });
  });
  describe("the review re-entered from Needs a person", () => {
    /** At Needs a person because a reviewer kept ending without a verdict: the transition into it, then the escalation (what `readReviewHold` reads). */
    const held = async (a: SeedRefs, w: string): Promise<void> => {
      await admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'pr_opened', 'needs_human', now(), 'control_plane', $3)", [a.accountId, w, `escalated:${randomUUID()}`]);
      // The test ages every event of the item afterwards; the transition is aged too, so it still predates the escalation.
      await admin.query("UPDATE work_item_transitions SET created_at = now() - interval '2 days', at = now() - interval '2 days' WHERE work_item_id = $1 AND to_stage = 'needs_human'", [w]);
      await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'escalated', 'reviewer_no_verdict', $3)", [a.accountId, w, randomUUID()]);
    };

    it("REVIEW-NH-SPEND-SWEEP: spend-paused at Needs a person, it stays parked while the limit holds and resumes exactly once when the limit lifts, as a first-entry review does", async () => {
      const p = await parked("review", { stage: "needs_human", round: 1, beforeWait: held });
      const l = limits(1);
      const started: AdvanceStartArgs[] = [];
      const clock = { t: Date.now() };
      for (let pass = 0; pass < 2; pass += 1) {
        clock.t += 15 * 60_000;
        await stale(p.w);
        const before = (await counts(p.a.accountId)).facts;
        await sweeper(l, started, clock).sweepParkedStages([entryOf("review")]);
        // Still denied: the wait is refreshed on the same head, and nothing starts.
        expect((await counts(p.a.accountId)).facts).toBe(before + 1);
      }
      expect(mine(started, p.w)).toEqual([]);
      expect(await itemOf(p.w)).toEqual({ stage: "needs_human", halted_at: null });

      l.current = 600;
      clock.t += 15 * 60_000;
      await stale(p.w);
      await sweeper(l, started, clock).sweepParkedStages([entryOf("review")]);
      expect(mine(started, p.w)).toHaveLength(1);
      // The same pass again (a retried cron) finds the claim and starts nothing more.
      await stale(p.w);
      await sweeper(l, started, clock).sweepParkedStages([entryOf("review")]);
      const calls = mine(started, p.w);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ accountId: p.a.accountId, workItemId: p.w, actionId: p.approval, startRereview: 1, specVersion: 1 });
    });

    it("an item at Needs a person for another cause (no missing-verdict hold) is not resumed as a review", async () => {
      const p = await parked("review", { stage: "needs_human" });
      const started: AdvanceStartArgs[] = [];
      await sweeper(limits(600), started, { t: Date.now() }).sweepParkedStages([entryOf("review")]);
      expect(mine(started, p.w)).toEqual([]);
    });
  });
});
