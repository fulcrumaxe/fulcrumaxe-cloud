import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foregroundBudgetUsd, reserve, type ReserveParams } from "@fx/spend";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./build/helpers/seed.js";
import { discussingItem } from "./plan/helpers/panelFixtures.js";
import { RESERVATION_PAUSE_SENTENCES, readReservationPause, type ReservationPause } from "../src/advance/reservationPauses.js";
import { runPanelForItem, runSpecForItem } from "../src/advance/specFlow.js";
import { START_SITE_STAGE, pauseOnDenial, siteStep, type StartSite } from "../src/advance/stageStarts.js";
import { STAGE_WORD_PHRASES, stageWords } from "../src/advance/stageWords.js";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest } from "../src/advance/runPorts.js";

/**
 * D#483 S5-k1c [pg]: the four starts before the build under a spending limit, over real rows. The denial comes from the REAL `reserve()` (not a canned string),
 * so a renamed or re-ordered denial in the spend package fails here. The fake run starter does what the real one does around it: the run row exists as
 * `pending` before the reservation, a denial ends it `refused_spend`, and a repeat of the same step key finds that same run (the real starter's `claimed()`),
 * which is why each later ask is a new attempt with its own key.
 *
 * What cannot be faked faithfully: the worker's real starter (its seat resolution, its sandbox and runner paths) is replaced by this small one; the workflow's
 * own loop is tested in apps/web with a fake worker, and the sweep in packages/worker over real rows. This file holds the part between them: the keys, the
 * mapping of a denial to a pause, and what a person reads afterwards.
 */
const h = pgHarness();

type Limits = Omit<ReserveParams, "accountId" | "runId" | "workItemId" | "workItemKind">;
const OK_LIMITS: Limits = { plan: "starter", estimateModelUsd: 1, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 40 };
const PM_ENVELOPE = { summary: "**technical-architect**: agrees.\n**security-expert**: agrees.\n**cost-analyst**: agrees.", spec: "1. The thing works.\n2. The thing is tested.", acceptance_files: ["src/a.ts"] };

class SpendWorld implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  private readonly keys = new Map<string, string>();
  private readonly roles = new Map<string, string>();
  /** Answers the limits for the project manager's starts; the panel's seats are never limited here (they are another row's). */
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
    public limits: Limits,
    /** A refusal that is not a spend denial, for the PM's start (S5k1c-6). */
    public refuseWith: string | null = null,
  ) {}
  private chain: Promise<unknown> = Promise.resolve();
  /** The panel's seats start together and share one admin connection: one start at a time. */
  startRun(req: AdvanceRunRequest) {
    this.requests.push(req);
    const next = this.chain.then(() => this.start(req));
    this.chain = next.catch(() => undefined);
    return next;
  }
  private async start(req: AdvanceRunRequest) {
    const held = this.keys.get(req.step);
    if (held !== undefined) return { ok: true as const, runId: held };
    const id = randomUUID();
    this.keys.set(req.step, id);
    this.roles.set(id, req.role);
    const isPm = req.role === "project-manager";
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'pending')`, [id, this.accountId, this.workItemId, req.role]);
    if (!isPm) {
      await h.admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [id]);
      return { ok: true as const, runId: id };
    }
    if (this.refuseWith !== null) {
      await h.admin.query("UPDATE agent_runs SET status = 'refused_spend' WHERE id = $1", [id]);
      return { ok: false as const, reason: this.refuseWith };
    }
    const result = await reserve(h.runWriterPool, { ...this.limits, accountId: this.accountId, runId: id, workItemId: this.workItemId, workItemKind: "feature" });
    if (result.decision === "deny") {
      await h.admin.query("UPDATE agent_runs SET status = 'refused_spend' WHERE id = $1", [id]);
      return { ok: false as const, reason: result.reason };
    }
    await h.admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [id]);
    return { ok: true as const, runId: id };
  }
  async outcome(runId: string): Promise<AdvanceRunOutcome> {
    const role = this.roles.get(runId);
    if (role === undefined) return { status: "missing", done: true, envelope: null };
    return { status: "succeeded", done: true, envelope: role === "project-manager" ? PM_ENVELOPE : { comment: `${role}: fine.`, stance: "agree", challenge: false } };
  }
  async cancel() {}
}

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
async function repo(accountId: string): Promise<string> {
  const id = randomUUID();
  await seedRepo(h.admin, accountId, id);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [id]);
  return id;
}
let ghNumber = 500;
async function plainItem(accountId: string, stage: string, spec: boolean): Promise<string> {
  const r = await repo(accountId);
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage) VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4, $5)`, [id, accountId, r, ghNumber++, stage]);
  if (spec) await h.admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'Do the thing.', encode(sha256(convert_to('Do the thing.', 'UTF8')), 'hex'), 'system')`, [accountId, id]);
  return id;
}

const runsOf = async (workItemId: string, role = "project-manager"): Promise<string[]> => (await h.admin.query<{ status: string }>("SELECT status FROM agent_runs WHERE work_item_id = $1 AND role = $2 ORDER BY created_at", [workItemId, role])).rows.map((r) => r.status);
const reservations = async (accountId: string): Promise<number> => (await h.admin.query("SELECT 1 FROM spend_reservations WHERE account_id = $1", [accountId])).rowCount ?? 0;
const itemRow = async (id: string): Promise<{ stage: string; halted_at: Date | null }> => (await h.admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [id])).rows[0]!;

/** The fact the workflow leaves for one denied ask (apps/web workItemAdvance.ts askUntilAllowed): the stage, the pause and the attempt. */
async function leaveFact(accountId: string, workItemId: string, stage: "classify" | "spec" | "respec", pause: string, attempt: number): Promise<void> {
  await withTenant(h.runWriterPool, accountId, async (client) => {
    await recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage, code: pause, attempt, dedupeKey: `wait:${stage}:${randomUUID()}:${attempt}` });
  });
}

interface Site {
  site: StartSite;
  /** The item stage the start waits at. */
  at: string;
  prepare(accountId: string, limits: Limits): Promise<{ w: string; world: SpendWorld; approval: string; ask(attempt: number): Promise<{ started: boolean; reason: string | null }> }>;
}

function stepSite(site: Exclude<StartSite, "spec_pm">, at: string, spec: boolean): Site {
  return {
    site,
    at,
    async prepare(accountId, limits) {
      const w = await plainItem(accountId, at, spec);
      const world = new SpendWorld(accountId, w, limits);
      const approval = randomUUID();
      return {
        w,
        world,
        approval,
        // The same two helpers the web steps use: the key of this attempt, and the answer with a denial turned into its pause.
        ask: async (attempt) => {
          const out = pauseOnDenial(await world.startRun({ step: siteStep(site, approval, attempt), role: "project-manager", prompt: "p", clone: true }));
          return out.ok ? { started: true, reason: null } : { started: false, reason: out.reason };
        },
      };
    },
  };
}

const SITES: Site[] = [
  stepSite("classify", "triaged", false),
  stepSite("light_spec", "triaged", false),
  stepSite("respec", "spec_ready", true),
  {
    site: "spec_pm",
    at: "discussing",
    async prepare(accountId, limits) {
      const r = await repo(accountId);
      const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, { title: "Rotate the credentials store", body: "Store the secret token on the cloud server.", category: "critical", repoId: r });
      const world = new SpendWorld(accountId, workItemId, limits);
      const approval = randomUUID();
      await runPanelForItem(h.runWriterPool, accountId, workItemId, world, { pollMs: 5 });
      void discussionId;
      return {
        w: workItemId,
        world,
        approval,
        ask: async (attempt) => {
          const out = await runSpecForItem(h.runWriterPool, accountId, workItemId, world, { pollMs: 5, attempt: approval, spendAttempt: attempt });
          return out.status === "published" ? { started: true, reason: null } : { started: false, reason: out.status === "refused" ? (out.reason ?? null) : out.status };
        },
      };
    },
  },
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

describe.each(SITES)("S5k1c: the $site start", (s) => {
  const stage = START_SITE_STAGE[s.site];

  describe.each(CASES)("$denial becomes $pause", (c) => {
    it("S5k1c-1: the real denial gives the item that pause, its sentence and the stage words; nothing is reserved and the stage is unchanged", async () => {
      const a = await account();
      const denying = await c.deny(a);
      const t = await s.prepare(a, denying);
      const out = await t.ask(0);
      expect(out).toEqual({ started: false, reason: c.pause });
      // The run the denied start left is terminal and was never reserved; the item did not move and was not halted.
      expect(await runsOf(t.w)).toEqual(["refused_spend"]);
      expect(await reservations(a)).toBe(0);
      expect(await itemRow(t.w)).toMatchObject({ stage: s.at, halted_at: null });

      // The workflow leaves one waiting fact per denied ask; the pause is read from it, at this stage only.
      await leaveFact(a, t.w, stage as "classify" | "spec" | "respec", c.pause, 0);
      const pause = await readReservationPause(h.runWriterPool, a, t.w, stage);
      expect(pause).toBe(c.pause);
      expect(RESERVATION_PAUSE_SENTENCES[pause!]).toMatch(/[A-Za-z]/);
      expect(STAGE_WORD_PHRASES).toContain(stageWords(stage));
      for (const other of ["build", "review", "panel"] as const) expect(await readReservationPause(h.runWriterPool, a, t.w, other)).toBeNull();
    });

    it("S5k1c-2: clearing the denial lets the next ask start the run at a fresh :s<n> key, with no person action; the earlier refused_spend runs are not replayed", async () => {
      const a = await account();
      const denying = await c.deny(a);
      const t = await s.prepare(a, denying);
      expect(await t.ask(0)).toEqual({ started: false, reason: c.pause });
      // Still denied: the next ask is a new attempt, denied again, and leaves its own run.
      expect(await t.ask(1)).toEqual({ started: false, reason: c.pause });
      expect(await runsOf(t.w)).toEqual(["refused_spend", "refused_spend"]);

      t.world.limits = c.cleared(denying);
      expect(await t.ask(2)).toEqual({ started: true, reason: null });
      expect(await runsOf(t.w)).toEqual(["refused_spend", "refused_spend", "running"]);
      expect(await reservations(a)).toBe(1);
      // Each ask had its own key: the first is the key it always had, the later ones carry the attempt, and none is the denied one again.
      const pm = t.world.requests.filter((r) => r.role === "project-manager").map((r) => r.step);
      const base = pm[0]!;
      expect(pm).toEqual([base, `${base}:s1`, `${base}:s2`]);
      expect(base).toContain(t.approval);
    });
  });

  it("S5k1c-6: a refusal that is not a pause (the account is not active) is not a pause: it ends the way it does today, and a pause is not read", async () => {
    const a = await account();
    const t = await s.prepare(a, OK_LIMITS);
    t.world.refuseWith = "account_not_active";
    const out = await t.ask(0);
    // The step-keyed starts hand the refusal back as it came; the Spec step's PM has always turned it into its own `pm_failed`.
    expect(out).toEqual({ started: false, reason: s.site === "spec_pm" ? "pm_failed" : "account_not_active" });
    expect(await itemRow(t.w)).toMatchObject({ stage: s.at, halted_at: null });
    expect(await readReservationPause(h.runWriterPool, a, t.w, stage)).toBeNull();
  });
});
