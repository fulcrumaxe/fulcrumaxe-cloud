import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foregroundBudgetUsd, reserve, type ReserveParams } from "@fx/spend";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./build/helpers/seed.js";
import { RESERVATION_PAUSE_SENTENCES, readReservationPause, type ReservationPause } from "../src/advance/reservationPauses.js";
import { attemptKey } from "../src/advance/attemptKeys.js";
import { pauseOnDenial } from "../src/advance/stageStarts.js";
import { reviewStep } from "../src/advance/reviewStarts.js";
import { STAGE_WORD_PHRASES, stageWords } from "../src/advance/stageWords.js";
import type { WaitingStage } from "../src/advance/waitingStages.js";

/**
 * D#483 S5-k1d [pg]: the reviewer start and the fix-round start under a spending limit, over real rows. The denial comes from the REAL `reserve()` (not a canned
 * string), so a renamed or re-ordered denial in the spend package fails here. The fake run starter does what the real one does around it: the run row exists as
 * `pending` before the reservation, a denial ends it `refused_spend`, and a repeat of the same step key finds that same run (the real starter's `claimed()`), which is
 * why each later ask is a new attempt with its own key.
 *
 * What cannot be faked faithfully: the worker's real starter and the fix round's resume (their seat resolution, sandbox and runner paths) are replaced by this small
 * starter; the workflow's own loop is tested in apps/web with a fake worker, the worker's key and denial handling in packages/worker over real rows, and the sweep there
 * too. This file holds the part between them: the keys, the mapping of a denial to a pause, and what a person reads afterwards.
 */
const h = pgHarness();

type Limits = Omit<ReserveParams, "accountId" | "runId" | "workItemId" | "workItemKind">;
const HEAD = "a".repeat(40);

class SpendWorld {
  readonly steps: string[] = [];
  private readonly keys = new Map<string, string>();
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
    /** The limits a role's start meets (a reviewer may be limited when another is not). */
    public limitsOf: (role: string) => Limits,
  ) {}
  async start(step: string, role: string): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    this.steps.push(step);
    const held = this.keys.get(step);
    // The real starter: a key that already has a run answers that run, a refused one included.
    if (held !== undefined) return { ok: true, runId: held };
    const id = randomUUID();
    this.keys.set(step, id);
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'pending')`, [id, this.accountId, this.workItemId, role]);
    const result = await reserve(h.runWriterPool, { ...this.limitsOf(role), accountId: this.accountId, runId: id, workItemId: this.workItemId, workItemKind: "feature" });
    if (result.decision === "deny") {
      await h.admin.query("UPDATE agent_runs SET status = 'refused_spend' WHERE id = $1", [id]);
      return { ok: false, reason: result.reason };
    }
    await h.admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [id]);
    return { ok: true, runId: id };
  }
}

const OK_LIMITS: Limits = { plan: "starter", estimateModelUsd: 1, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 40 };

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
let ghNumber = 700;
async function item(accountId: string, stage: string): Promise<string> {
  const r = randomUUID();
  await seedRepo(h.admin, accountId, r);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [r]);
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage) VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4, $5)`, [id, accountId, r, ghNumber++, stage]);
  return id;
}
const runsOf = async (workItemId: string, role?: string): Promise<string[]> =>
  (await h.admin.query<{ status: string }>(`SELECT status FROM agent_runs WHERE work_item_id = $1 ${role ? "AND role = $2" : ""} ORDER BY created_at`, role ? [workItemId, role] : [workItemId])).rows.map((r) => r.status);
const reservations = async (accountId: string): Promise<number> => (await h.admin.query("SELECT 1 FROM spend_reservations WHERE account_id = $1", [accountId])).rowCount ?? 0;
const itemRow = async (id: string): Promise<{ stage: string; halted_at: Date | null }> => (await h.admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [id])).rows[0]!;

/** The fact the workflow leaves for one denied ask (apps/web workItemAdvance.ts waitOnHead): the stage, the pause, the attempt and the head. */
async function leaveFact(accountId: string, workItemId: string, stage: "review" | "fix_round", pause: string, attempt: number): Promise<void> {
  await withTenant(h.runWriterPool, accountId, async (client) => {
    await recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage, code: pause, attempt, dedupeKey: `wait:${stage}:${HEAD}:0:${attempt}`, headSha: HEAD, prNumber: 7, round: 0 });
  });
}

interface Site {
  name: string;
  stage: "review" | "fix_round";
  /** The item stage the start waits at. */
  at: string;
  role: string;
  /** The key of one ask (the web step's for a reviewer, the worker's for the fix round). */
  step(approval: string, rereview: number, attempt: number): string;
}
const SITES: Site[] = [
  { name: "review start", stage: "review", at: "pr_opened", role: "code-reviewer", step: (_a, rereview, attempt) => reviewStep(HEAD, "code-reviewer", rereview, attempt) },
  // The worker's fix key: `fix:<head>:<approval>[:r<retry>]` then `:s<n>` (advance.ts advanceStartFix; pinned there).
  { name: "fix-round start", stage: "fix_round", at: "changes_requested", role: "executor", step: (approval, rereview, attempt) => attemptKey(`fix:${HEAD}:${approval}${rereview > 0 ? `:r${rereview}` : ""}`, attempt) },
];

interface Case {
  pause: ReservationPause;
  denial: string;
  deny(accountId: string): Promise<Limits>;
  cleared(denying: Limits): Limits;
}
const priorRun = async (accountId: string): Promise<string> => {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, NULL, 'executor', 'production', 'running')`, [id, accountId]);
  return id;
};
const CASES: Case[] = [
  {
    pause: "account_budget_reached",
    denial: "model_budget_exceeded",
    async deny(accountId) {
      await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 45, $2, 'model')`, [accountId, await priorRun(accountId)]);
      return { plan: "starter", estimateModelUsd: 10, monthlyModelBudgetUsd: 50, perSpawnCapUsd: 40 };
    },
    cleared: (l) => ({ ...l, monthlyModelBudgetUsd: 500 }),
  },
  {
    pause: "compute_cap_reached",
    denial: "compute_cap_exceeded",
    async deny(accountId) {
      await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', $3, $2, 'foreground_compute')`, [accountId, await priorRun(accountId), foregroundBudgetUsd("starter") - 5]);
      return { plan: "starter", trigger: "foreground", estimateComputeUsd: 10 };
    },
    cleared: (l) => ({ ...l, now: new Date(Date.now() + 40 * 24 * 3600 * 1000) }),
  },
  {
    pause: "item_cap_reached",
    denial: "work_item_cap_exceeded",
    async deny() {
      return { plan: "starter", estimateModelUsd: 2, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40, featureCapUsd: 1 };
    },
    cleared: (l) => ({ ...l, featureCapUsd: 100 }),
  },
  {
    pause: "run_limit_below_estimate",
    denial: "per_spawn_cap_exceeded",
    async deny() {
      return { plan: "starter", estimateModelUsd: 50, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40 };
    },
    cleared: (l) => ({ ...l, perSpawnCapUsd: 60 }),
  },
];

describe.each(SITES)("S5k1d: the $name", (s) => {
  const ask = async (world: SpendWorld, approval: string, rereview: number, attempt: number) => {
    const out = pauseOnDenial(await world.start(s.step(approval, rereview, attempt), s.role));
    return out.ok ? { started: true, reason: null } : { started: false, reason: out.reason };
  };

  describe.each(CASES)("$denial becomes $pause", (c) => {
    it("S5k1d-1: the real denial gives the item that pause, its sentence and the stage words; nothing is reserved and the stage is unchanged", async () => {
      const a = await account();
      const denying = await c.deny(a);
      const w = await item(a, s.at);
      const world = new SpendWorld(a, w, () => denying);
      expect(await ask(world, randomUUID(), 0, 0)).toEqual({ started: false, reason: c.pause });
      expect(await runsOf(w)).toEqual(["refused_spend"]);
      expect(await reservations(a)).toBe(0);
      expect(await itemRow(w)).toMatchObject({ stage: s.at, halted_at: null });

      await leaveFact(a, w, s.stage, c.pause, 0);
      const pause = await readReservationPause(h.runWriterPool, a, w, s.stage);
      expect(pause).toBe(c.pause);
      expect(RESERVATION_PAUSE_SENTENCES[pause!]).toMatch(/[A-Za-z]/);
      expect(STAGE_WORD_PHRASES).toContain(stageWords(s.stage));
      expect(stageWords(s.stage)).toBe(s.stage === "review" ? "waiting for a review" : "waiting for a fix round");
      for (const other of ["build", "classify", "spec", "respec", "panel"] as WaitingStage[]) expect(await readReservationPause(h.runWriterPool, a, w, other), other).toBeNull();
    });

    it("S5k1d-2: clearing the denial lets the next ask start the run at a fresh :s<n> key with no person action; the earlier refused_spend runs are not replayed", async () => {
      const a = await account();
      const denying = await c.deny(a);
      const w = await item(a, s.at);
      const world = new SpendWorld(a, w, () => denying);
      const approval = randomUUID();
      expect(await ask(world, approval, 0, 0)).toEqual({ started: false, reason: c.pause });
      expect(await ask(world, approval, 0, 1)).toEqual({ started: false, reason: c.pause });
      expect(await runsOf(w)).toEqual(["refused_spend", "refused_spend"]);

      world.limitsOf = () => c.cleared(denying);
      expect(await ask(world, approval, 0, 2)).toEqual({ started: true, reason: null });
      expect(await runsOf(w)).toEqual(["refused_spend", "refused_spend", "running"]);
      expect(await reservations(a)).toBe(1);
      const base = world.steps[0]!;
      expect(world.steps).toEqual([base, `${base}:s1`, `${base}:s2`]);
    });

    it("S5k1d-2: a re-review round asked while an attempt is pending has its own key and does not reuse the attempt number", async () => {
      const a = await account();
      const denying = await c.deny(a);
      const w = await item(a, s.at);
      const world = new SpendWorld(a, w, () => denying);
      const approval = randomUUID();
      await ask(world, approval, 0, 0);
      await ask(world, approval, 0, 1);
      // Round 1 is a different family: its first ask is its bare key, not `:s2`, and it is a run of its own.
      await ask(world, approval, 1, 0);
      await ask(world, approval, 1, 1);
      const [k0, k1, r0, r1] = world.steps as [string, string, string, string];
      expect(new Set([k0, k1, r0, r1]).size).toBe(4);
      expect(k1).toBe(`${k0}:s1`);
      expect(r1).toBe(`${r0}:s1`);
      expect(r0).not.toBe(`${k0}:s2`);
      expect(await runsOf(w)).toEqual(["refused_spend", "refused_spend", "refused_spend", "refused_spend"]);
    });
  });

  it("S5k1d-6: a refusal that is not a pause (the account is not active) is not a pause: it is handed back as it came, and no pause is read", async () => {
    const a = await account();
    const w = await item(a, s.at);
    const out = pauseOnDenial({ ok: false as const, reason: "account_not_active" });
    expect(out).toEqual({ ok: false, reason: "account_not_active" });
    expect(await itemRow(w)).toMatchObject({ stage: s.at, halted_at: null });
    expect(await readReservationPause(h.runWriterPool, a, w, s.stage)).toBeNull();
  });

  it("a pause fact that is older than the window, or for an item that has moved on, is not a pause", async () => {
    const a = await account();
    const w = await item(a, s.at);
    await leaveFact(a, w, s.stage, "account_budget_reached", 0);
    expect(await readReservationPause(h.runWriterPool, a, w, s.stage)).toBe("account_budget_reached");
    await h.admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [w]);
    expect(await readReservationPause(h.runWriterPool, a, w, s.stage)).toBeNull();
    await h.admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [w, s.at]);
    await h.admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '2 hours' WHERE work_item_id = $1", [w]);
    expect(await readReservationPause(h.runWriterPool, a, w, s.stage)).toBeNull();
  });
});

describe("S5k1d: a review whose reviewers meet different limits", () => {
  it("one reviewer starts and another is denied by its own per-run limit: the started run stays, the denied one is a pause, and a later attempt starts the rest without a second run for the first", async () => {
    const a = await account();
    const w = await item(a, "pr_opened");
    const limits = (role: string): Limits => ({ plan: "starter", estimateModelUsd: role === "security-reviewer" ? 50 : 1, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 40 });
    const world = new SpendWorld(a, w, limits);
    const first = await Promise.all(["code-reviewer", "security-reviewer"].map(async (role) => ({ role, out: pauseOnDenial(await world.start(reviewStep(HEAD, role, 0, 0), role)) })));
    expect(first.find((x) => x.role === "code-reviewer")!.out.ok).toBe(true);
    expect(first.find((x) => x.role === "security-reviewer")!.out).toEqual({ ok: false, reason: "run_limit_below_estimate" });
    expect(await runsOf(w, "code-reviewer")).toEqual(["running"]);
    expect(await runsOf(w, "security-reviewer")).toEqual(["refused_spend"]);
    // The limit is raised; only the denied role is asked again, at attempt 1.
    world.limitsOf = () => OK_LIMITS;
    const again = pauseOnDenial(await world.start(reviewStep(HEAD, "security-reviewer", 0, 1), "security-reviewer"));
    expect(again.ok).toBe(true);
    expect(await runsOf(w, "code-reviewer")).toEqual(["running"]);
    expect(await runsOf(w, "security-reviewer")).toEqual(["refused_spend", "running"]);
    expect(world.steps).toEqual([reviewStep(HEAD, "code-reviewer", 0, 0), reviewStep(HEAD, "security-reviewer", 0, 0), `${reviewStep(HEAD, "security-reviewer", 0, 0)}:s1`]);
  });
});
