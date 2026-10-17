import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkHeadroom, foregroundBudgetUsd, reserve, type ReserveParams } from "@fx/spend";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./build/helpers/seed.js";
import { discussingItem } from "./plan/helpers/panelFixtures.js";
import { RESERVATION_PAUSE_SENTENCES, readReservationPause, type ReservationPause } from "../src/advance/reservationPauses.js";
import { createFollowedRunner } from "../src/advance/followedRunner.js";
import { roundHeadroomOf, runPanelForItem, runSpecForItem } from "../src/advance/specFlow.js";
import { STAGE_WORD_PHRASES, stageWords } from "../src/advance/stageWords.js";
import { runPanel } from "../src/plan/panel.js";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest } from "../src/advance/runPorts.js";

/**
 * D#483 S5-k1e [pg]: the panel's seats under a spending limit, over real rows. Every denial comes from the REAL `reserve()` (a seat's start) or the REAL
 * `checkHeadroom()` (the whole-round check), not from a canned string, so a renamed or re-ordered denial in the spend package fails here. The fake run starter does
 * what the real one does around them: the run row exists as `pending` before the reservation, a denial ends it `refused_spend`, and a repeat of the same step key
 * finds that same run and gets its denial again (the real starter's `claimed()`), which is why a denied seat's next ask is a new attempt with its own key.
 *
 * What cannot be faked faithfully: the worker's real starter (seat resolution, sandbox and runner paths) is replaced by this small one, and the worker's own
 * `startedAttempts` and `headroom` ports are tested in packages/worker over real rows. This file holds the part between them: the seat keys, the typed denial, what
 * the panel does with it, and what a person reads afterwards.
 */
const h = pgHarness();

type Limits = Omit<ReserveParams, "accountId" | "runId" | "workItemId" | "workItemKind">;
const OK: Limits = { plan: "starter", estimateModelUsd: 1, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 40 };
const PM_ENVELOPE = { summary: "**technical-architect**: agrees.\n**product-owner**: agrees.\n**performance-expert**: agrees.", spec: "1. The thing works.\n2. The thing is tested.", acceptance_files: ["src/a.ts"] };
const ROLES = ["technical-architect", "product-owner", "performance-expert"] as const;
const SEAT_KEY = /^panel:[0-9a-f-]{36}(?::g\d+)?(?::s\d+)?:r([12]):([a-z-]+)$/;

class PanelWorld implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  private readonly held = new Map<string, { id: string; denial: string | null }>();
  private readonly roles = new Map<string, string>();
  /** The limits a seat's start is made under. A seat the test wants denied gets limits the real reserve() denies. */
  limitsOf: (role: string, step: string) => Limits = () => OK;
  /** Roles whose run ends `failed` (a model call that errors: not a spend denial). */
  failRoles = new Set<string>();
  /** Roles whose start is refused for a reason that is not a limit. */
  refuseNonSpend = new Set<string>();
  /** Roles whose envelope asks for a challenge round. */
  challengeRoles = new Set<string>();
  /** False: the whole-round check says "go ahead" (an answer that has gone stale by the time the seats start). */
  headroomLive = true;
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
  ) {}
  private chain: Promise<unknown> = Promise.resolve();
  /** The panel's seats start together and share one admin connection: one start at a time. */
  startRun(req: AdvanceRunRequest) {
    this.requests.push(req);
    const next = this.chain.then(() => this.start(req));
    this.chain = next.catch(() => undefined);
    return next;
  }
  private async start(req: AdvanceRunRequest): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    const held = this.held.get(req.step);
    if (held !== undefined) return held.denial === null ? { ok: true, runId: held.id } : { ok: false, reason: held.denial };
    const id = randomUUID();
    this.roles.set(id, req.role);
    const refuse = async (reason: string) => {
      this.held.set(req.step, { id, denial: reason });
      await h.admin.query("UPDATE agent_runs SET status = 'refused_spend' WHERE id = $1", [id]);
      return { ok: false as const, reason };
    };
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'pending')`, [id, this.accountId, this.workItemId, req.role]);
    await h.admin.query(`INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`, [this.accountId, `advance:${this.workItemId}:${req.step}`, id, "0".repeat(64)]);
    if (this.refuseNonSpend.has(req.role)) return refuse("account_not_active");
    if (req.role === "project-manager") {
      this.held.set(req.step, { id, denial: null });
      await h.admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [id]);
      return { ok: true, runId: id };
    }
    const result = await reserve(h.runWriterPool, { ...this.limitsOf(req.role, req.step), accountId: this.accountId, runId: id, workItemId: this.workItemId, workItemKind: "feature" });
    if (result.decision === "deny") return refuse(result.reason);
    this.held.set(req.step, { id, denial: null });
    await h.admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [id, this.failRoles.has(req.role) ? "failed" : "succeeded"]);
    return { ok: true, runId: id };
  }
  /** One admin query at a time: the admin connection is a single client and the seats ask together. */
  private q<T extends Record<string, unknown>>(text: string, params: unknown[]): Promise<{ rows: T[] }> {
    const next = this.chain.then(() => h.admin.query<T>(text, params));
    this.chain = next.catch(() => undefined);
    return next;
  }
  /** The worker's port, over the same rows: every key shaped `<head>[:s<n>]<tail>` of this item, oldest first. */
  async startedAttempts(head: string, tail: string): Promise<Array<{ attempt: number; status: string }>> {
    const rows = await this.q<{ idempotency_key: string; status: string }>(
      `SELECT k.idempotency_key, a.status FROM agent_run_idempotency_keys k JOIN agent_runs a ON a.id = k.run_id WHERE k.account_id = $1 AND a.work_item_id = $2 ORDER BY k.created_at, k.run_id`,
      [this.accountId, this.workItemId],
    );
    const re = new RegExp(`^advance:${this.workItemId}:${head}(?::s(\\d+))?${tail}$`);
    return rows.rows.flatMap((r) => {
      const m = re.exec(r.idempotency_key);
      return m ? [{ attempt: m[1] === undefined ? 0 : Number(m[1]), status: r.status }] : [];
    });
  }
  /** The worker's port: every seat on its own, then the round as one reservation (the estimates added up), by the real read-only check. */
  async headroom(roles: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.headroomLive) return { ok: true };
    const seats = roles.map((role) => this.limitsOf(role, `${role}`));
    for (const spend of seats) {
      const one = await checkHeadroom(h.runWriterPool, { ...spend, accountId: this.accountId, workItemId: this.workItemId, workItemKind: "feature" });
      if (one.decision === "deny") return { ok: false, reason: one.reason };
    }
    const whole = await checkHeadroom(h.runWriterPool, {
      ...seats[0]!,
      accountId: this.accountId,
      workItemId: this.workItemId,
      workItemKind: "feature",
      estimateModelUsd: seats.reduce((n, s) => n + (s.estimateModelUsd ?? 0), 0),
      perSpawnCapUsd: Number.MAX_SAFE_INTEGER,
    });
    return whole.decision === "deny" ? { ok: false, reason: whole.reason } : { ok: true };
  }
  async outcome(runId: string): Promise<AdvanceRunOutcome> {
    const role = this.roles.get(runId);
    const status = (await this.q<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0]?.status;
    if (role === undefined || status === undefined) return { status: "missing", done: true, envelope: null };
    if (status !== "succeeded") return { status, done: true, envelope: null };
    return { status, done: true, envelope: role === "project-manager" ? PM_ENVELOPE : { comment: `${role}: fine.`, stance: "agree", challenge: this.challengeRoles.has(role) } };
  }
  async cancel() {}
}

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
async function fixture(): Promise<{ accountId: string; workItemId: string; discussionId: string; world: PanelWorld }> {
  const accountId = await account();
  const repoId = randomUUID();
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
  const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, { title: "Retry failed syncs", body: "Retry a failed sync three times.", category: "feature", repoId });
  return { accountId, workItemId, discussionId, world: new PanelWorld(accountId, workItemId) };
}

const runsOf = async (workItemId: string, role: string): Promise<Array<{ id: string; status: string }>> =>
  (await h.admin.query<{ id: string; status: string }>("SELECT id, status FROM agent_runs WHERE work_item_id = $1 AND role = $2 ORDER BY created_at", [workItemId, role])).rows;
const allRuns = async (workItemId: string): Promise<number> => (await h.admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1", [workItemId])).rowCount ?? 0;
const signed = async (discussionId: string): Promise<string[]> => (await h.admin.query<{ role: string }>("SELECT role FROM discussion_comments WHERE discussion_id = $1 AND system_signed = true ORDER BY role", [discussionId])).rows.map((r) => r.role);
const reservations = async (accountId: string): Promise<number> => (await h.admin.query("SELECT 1 FROM spend_reservations WHERE account_id = $1", [accountId])).rowCount ?? 0;
const itemRow = async (id: string): Promise<{ stage: string; halted_at: Date | null }> => (await h.admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [id])).rows[0]!;
const stepsOf = (world: PanelWorld, role: string): string[] => world.requests.filter((r) => r.role === role).map((r) => r.step.replace(/^panel:[0-9a-f-]{36}/, "panel:D"));

/** The fact the workflow leaves for one denied ask of the panel (apps/web workItemAdvance.ts askUntilAllowed): the stage, the pause and the attempt. */
async function leaveFact(accountId: string, workItemId: string, pause: string, attempt: number): Promise<void> {
  await withTenant(h.runWriterPool, accountId, async (client) => {
    await recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage: "panel", code: pause, attempt, dedupeKey: `wait:panel:${randomUUID()}:${attempt}` });
  });
}

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

describe.each(CASES)("S5k1e: $denial becomes $pause", (c) => {
  it("S5k1e-1: the whole round is checked first: every seat denied means no seat starts, nothing is reserved, no seat shows DID NOT POST, and the item shows the pause with the panel words", async () => {
    const f = await fixture();
    const denying = await c.deny(f.accountId);
    f.world.limitsOf = () => denying;
    const out = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(out).toEqual({ status: "refused", reason: c.pause });
    // No seat ran at all: not one run row, not one request, nothing reserved, nothing posted.
    expect(f.world.requests).toEqual([]);
    expect(await allRuns(f.workItemId)).toBe(0);
    expect(await reservations(f.accountId)).toBe(0);
    expect(await signed(f.discussionId)).toEqual([]);
    expect(await itemRow(f.workItemId)).toMatchObject({ stage: "discussing", halted_at: null });

    await leaveFact(f.accountId, f.workItemId, c.pause, 0);
    const pause = await readReservationPause(h.runWriterPool, f.accountId, f.workItemId, "panel");
    expect(pause).toBe(c.pause);
    expect(RESERVATION_PAUSE_SENTENCES[pause!]).toMatch(/[A-Za-z]/);
    expect(stageWords("panel")).toBe("waiting for the panel");
    expect(STAGE_WORD_PHRASES).toContain(stageWords("panel"));
    for (const other of ["build", "classify", "spec", "review"] as const) expect(await readReservationPause(h.runWriterPool, f.accountId, f.workItemId, other)).toBeNull();
  });

  it("S5k1e-1: when the whole-round answer has gone stale and the real reserve() denies every seat, each seat is a pause (not DID NOT POST), none is reserved, and the panel is not complete", async () => {
    const f = await fixture();
    const denying = await c.deny(f.accountId);
    f.world.limitsOf = () => denying;
    f.world.headroomLive = false;
    const direct = await runPanel({ pool: h.runWriterPool, accountId: f.accountId, runner: createFollowedRunner(f.world, { pollMs: 5 }).panel }, { workItemId: f.workItemId });
    expect(direct).toMatchObject({ status: "paused", reason: c.pause, round: 1 });
    if (direct.status !== "paused") throw new Error("unreachable");
    expect([...direct.deniedRoles].sort()).toEqual([...ROLES].sort());
    expect(await reservations(f.accountId)).toBe(0);
    expect((await h.admin.query("SELECT status FROM agent_runs WHERE work_item_id = $1", [f.workItemId])).rows).toEqual(ROLES.map(() => ({ status: "refused_spend" })));
    expect(await signed(f.discussionId)).toEqual([]);
  });

  it("S5k1e-2: the third of three seats is denied after two posted: the two stay as they are (same runs, no second run), the third is retried at a fresh :s<n> key once the denial clears, and the panel completes with three seats", async () => {
    const f = await fixture();
    const denying = await c.deny(f.accountId);
    const denied = "performance-expert";
    f.world.limitsOf = (role) => (role === denied ? denying : OK);
    f.world.headroomLive = false; // the answer was yes when it was asked and is no by the time the third seat starts
    const first = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(first).toEqual({ status: "refused", reason: c.pause });
    expect(await signed(f.discussionId)).toEqual(["product-owner", "technical-architect"]);
    const posted = await Promise.all(["technical-architect", "product-owner"].map((r) => runsOf(f.workItemId, r)));
    expect(posted.map((r) => r.map((x) => x.status))).toEqual([["succeeded"], ["succeeded"]]);
    expect((await runsOf(f.workItemId, denied)).map((r) => r.status)).toEqual(["refused_spend"]);
    expect(await itemRow(f.workItemId)).toMatchObject({ stage: "discussing", halted_at: null });

    // Still denied: the next ask follows the two posted seats (no new run for them) and asks the third again at the next attempt, which is denied again.
    const second = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(second).toEqual({ status: "refused", reason: c.pause });
    expect((await runsOf(f.workItemId, denied)).map((r) => r.status)).toEqual(["refused_spend", "refused_spend"]);

    f.world.limitsOf = (role) => (role === denied ? c.cleared(denying) : OK);
    const third = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(third).toEqual({ status: "completed", complete: true, missingRoles: [], round2Ran: false });
    expect(await signed(f.discussionId)).toEqual(["performance-expert", "product-owner", "technical-architect"]);
    // The two posted seats were never run again: still exactly their one run, the same one, and the same one key asked three times.
    expect(await Promise.all(["technical-architect", "product-owner"].map((r) => runsOf(f.workItemId, r)))).toEqual(posted);
    for (const role of ["technical-architect", "product-owner"]) expect(new Set(stepsOf(f.world, role))).toEqual(new Set([`panel:D:r1:${role}`]));
    // The denied seat's keys: the key it always had, then :s1, then :s2 (the one that started).
    expect(stepsOf(f.world, denied)).toEqual([`panel:D:r1:${denied}`, `panel:D:s1:r1:${denied}`, `panel:D:s2:r1:${denied}`]);
    expect((await runsOf(f.workItemId, denied)).map((r) => r.status)).toEqual(["refused_spend", "refused_spend", "succeeded"]);
    expect(await reservations(f.accountId)).toBe(3);
  });

  it("S5k1e-2: a denial in the challenge round keeps the round-1 seats, and only the denied round-2 seats are asked again", async () => {
    const f = await fixture();
    const denying = await c.deny(f.accountId);
    f.world.challengeRoles.add("product-owner");
    f.world.limitsOf = (_role, step) => (step.includes(":r2:") ? denying : OK);
    f.world.headroomLive = false;
    const first = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(first).toEqual({ status: "refused", reason: c.pause });
    const round1 = await Promise.all(ROLES.map((r) => runsOf(f.workItemId, r)));
    // Round 1: three succeeded runs; round 2: the challenge round asked the seats that posted, and every one was denied.
    expect(round1.map((r) => r.filter((x) => x.status === "succeeded").length)).toEqual([1, 1, 1]);
    expect(round1.flat().filter((x) => x.status === "refused_spend")).toHaveLength(3);

    f.world.limitsOf = () => OK;
    const again = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(again).toMatchObject({ status: "completed", complete: true, round2Ran: true });
    const after = await Promise.all(ROLES.map((r) => runsOf(f.workItemId, r)));
    // Each seat has: its one round-1 run (unchanged), its denied round-2 run, and its round-2 run at :s1.
    for (let i = 0; i < ROLES.length; i += 1) expect(after[i]!.slice(0, 1)).toEqual(round1[i]!.filter((x) => x.status === "succeeded"));
    expect(stepsOf(f.world, "technical-architect").filter((s) => s.includes(":r2:"))).toEqual(["panel:D:r2:technical-architect", "panel:D:s1:r2:technical-architect"]);
    expect(stepsOf(f.world, "technical-architect").filter((s) => s.includes(":r1:"))).toEqual(["panel:D:r1:technical-architect", "panel:D:r1:technical-architect"]);
  });
});

describe("S5k1e: a seat that fails for a reason that is not a limit", () => {
  it("S5k1e-3: a model call that errors still shows DID NOT POST in the Spec and is not a pause", async () => {
    const f = await fixture();
    f.world.failRoles.add("performance-expert");
    const out = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(out).toEqual({ status: "completed", complete: false, missingRoles: ["performance-expert"], round2Ran: false });
    expect(await signed(f.discussionId)).toEqual(["product-owner", "technical-architect"]);
    const spec = await runSpecForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5, attempt: randomUUID() });
    expect(spec.status).toBe("published");
    const body = (await h.admin.query<{ body: string }>("SELECT body FROM spec_versions WHERE work_item_id = $1 ORDER BY version DESC LIMIT 1", [f.workItemId])).rows[0]!.body;
    expect(body).toContain("performance-expert: DID NOT POST (runner_failed)");
    // Nothing here names a limit: the workflow writes a panel waiting fact only for a pause answer, and a failed seat gives none.
    expect(await readReservationPause(h.runWriterPool, f.accountId, f.workItemId, "panel")).toBeNull();
  });

  it("S5k1e-3: a start refused for a reason that is not a limit (the account is not active) is a failed seat, not a pause, even beside a pause for another seat", async () => {
    const f = await fixture();
    f.world.refuseNonSpend.add("product-owner");
    f.world.headroomLive = false;
    const out = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(out).toEqual({ status: "completed", complete: false, missingRoles: ["product-owner"], round2Ran: false });
    const direct = await runPanel({ pool: h.runWriterPool, accountId: f.accountId, runner: createFollowedRunner(f.world, { pollMs: 5 }).panel }, { workItemId: f.workItemId });
    expect(direct).toMatchObject({ status: "completed", missingReasons: { "product-owner": "runner_failed" } });
  });

  it("S5k1e-3: a failed seat beside a limit-denied seat: the denied one pauses the panel, and the failed one is not retried as a pause", async () => {
    const f = await fixture();
    const denying = await CASES[2]!.deny(f.accountId);
    f.world.failRoles.add("technical-architect");
    f.world.limitsOf = (role) => (role === "performance-expert" ? denying : OK);
    f.world.headroomLive = false;
    const out = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(out).toEqual({ status: "refused", reason: "item_cap_reached" });
    // The failed seat's run stays the one run it has (a failure is not a refused_spend): asking again follows it and does not start another.
    f.world.limitsOf = () => OK;
    const again = await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    expect(again).toEqual({ status: "completed", complete: false, missingRoles: ["technical-architect"], round2Ran: false });
    expect((await runsOf(f.workItemId, "technical-architect")).map((r) => r.status)).toEqual(["failed"]);
  });
});

describe("S5k1e: the Spec step enters the panel again", () => {
  it("a seat a limit denied on that re-entry is the Spec step's pause (the same named pause the PM's start gives), not a Spec with a seat that DID NOT POST", async () => {
    const f = await fixture();
    const denying = await CASES[0]!.deny(f.accountId);
    f.world.limitsOf = (role) => (role === "performance-expert" ? denying : OK);
    f.world.headroomLive = false;
    // Nobody ran the panel step first, so the Spec step's own re-entry starts the seats and meets the denial.
    const spec = await runSpecForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5, attempt: randomUUID() });
    expect(spec).toEqual({ status: "refused", reason: "account_budget_reached" });
    expect(f.world.requests.filter((r) => r.role === "project-manager")).toEqual([]);
    expect(await itemRow(f.workItemId)).toMatchObject({ stage: "discussing", halted_at: null });
  });
});

describe("S5k1e: the whole-round check counts only the seats that would start a run", () => {
  it("seats that already have a finished run are followed and cost nothing new: a denying limit does not stop a round that only follows", async () => {
    const f = await fixture();
    expect(await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 })).toMatchObject({ status: "completed", complete: true });
    // Every seat has posted. A limit that would deny any new start must not pause a replay that starts nothing.
    const denying = await CASES[0]!.deny(f.accountId);
    f.world.limitsOf = () => denying;
    const before = await allRuns(f.workItemId);
    expect(await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 })).toMatchObject({ status: "completed", complete: true });
    expect(await allRuns(f.workItemId)).toBe(before);
  });

  it("with no headroom port the round is not checked as a whole (each seat is still handled on its own)", async () => {
    const f = await fixture();
    const bare: AdvanceRunPorts = { startRun: (r) => f.world.startRun(r), outcome: (id) => f.world.outcome(id), cancel: async () => undefined };
    expect(await roundHeadroomOf(bare)(1, ROLES, "panel:x")).toBeNull();
  });
});

describe("S5k1e: seat keys", () => {
  it("every key the panel used is one of the two shapes (the bare key, then :s<n> before the round)", async () => {
    const f = await fixture();
    const denying = await CASES[3]!.deny(f.accountId);
    f.world.limitsOf = (role) => (role === "product-owner" ? denying : OK);
    f.world.headroomLive = false;
    await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    await runPanelForItem(h.runWriterPool, f.accountId, f.workItemId, f.world, { pollMs: 5 });
    for (const r of f.world.requests) expect(SEAT_KEY.test(r.step), r.step).toBe(true);
  });
});
