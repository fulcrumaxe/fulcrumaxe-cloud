import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./build/helpers/seed.js";
import { discussingItem } from "./plan/helpers/panelFixtures.js";
import { runPanelForItem, runSpecForItem, STEP_YIELD_MS, STEP_LIMIT_MS, SEAT_ROUND_TIMEOUT_MS, PM_TIMEOUT_MS } from "../src/advance/specFlow.js";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest, AdvanceRunStart } from "../src/advance/runPorts.js";

/**
 * D#6 C29 (R3c-2) [pg]: the panel and the PM Spec hand control back instead of overrunning the step while they wait for a one-job
 * runner. The world below behaves like the worker's ports: a step key names one run (a replay finds it), every run is a real
 * `agent_runs` row, and a run reports its runtime and how long it has been running. Nothing here is cancelled by a yield.
 */
const h = pgHarness();
const CRITICAL = ["technical-architect", "security-expert", "cost-analyst"];
const TEXT = { title: "Rotate the credentials store", body: "Store the secret token on the cloud server.", category: "critical" as const };
const DONE = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"];

class World implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  readonly cancelled: string[] = [];
  private readonly byStep = new Map<string, string>();
  readonly runs = new Map<string, { role: string; step: string; status: string; envelope: Record<string, unknown> | null; runningMs: number | null }>();
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
    /** Where the runs execute. A `runner` run reports `pending` until it is claimed. */
    private readonly runtime: "runner" | "production",
    private readonly initial: string,
  ) {}

  async startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
    this.requests.push(req);
    const known = this.byStep.get(req.step);
    if (known) return { ok: true, runId: known };
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'running')`, [id, this.accountId, this.workItemId, req.role]);
    this.byStep.set(req.step, id);
    this.runs.set(id, { role: req.role, step: req.step, status: this.initial, envelope: null, runningMs: null });
    return { ok: true, runId: id };
  }
  async outcome(runId: string): Promise<AdvanceRunOutcome> {
    const r = this.runs.get(runId);
    if (!r) return { status: "missing", done: true, envelope: null };
    const done = DONE.includes(r.status);
    return { status: r.status, done, envelope: done ? r.envelope : null, runtime: this.runtime, runningMs: r.runningMs };
  }
  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    const r = this.runs.get(runId);
    if (r && !DONE.includes(r.status)) r.status = "cancelled";
  }
  /** The runner claims the run, and `done` later lands its envelope. */
  finish(match: (r: { role: string; step: string }) => boolean, envelope?: Record<string, unknown>): void {
    for (const r of this.runs.values()) {
      if (!match(r) || DONE.includes(r.status)) continue;
      r.status = "succeeded";
      r.envelope =
        envelope ??
        (r.role === "project-manager"
          ? { summary: "**technical-architect**: agrees.\n**security-expert**: agrees.\n**cost-analyst**: agrees.", spec: "1. The thing works.\n2. The thing is tested.", acceptance_files: ["src/a.ts"] }
          : { comment: `${r.role}: fine.`, stance: "agree", challenge: false });
    }
  }
  claim(match: (r: { role: string }) => boolean, runningMs: number): void {
    for (const r of this.runs.values()) if (match(r) && r.status === "pending") Object.assign(r, { status: "running", runningMs });
  }
}

async function discussing(runtime: "runner" | "production", initial: string) {
  const accountId = randomUUID();
  await seedAccount(h.admin, accountId);
  const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, TEXT);
  return { accountId, workItemId, discussionId, world: new World(accountId, workItemId, runtime, initial) };
}
const runRows = async (workItemId: string) => (await h.admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1", [workItemId])).rowCount;
const signed = async (discussionId: string) => (await h.admin.query("SELECT role FROM discussion_comments WHERE discussion_id = $1 AND system_signed = true", [discussionId])).rows.map((r) => r.role as string).sort();
const stageOf = async (id: string) => (await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;
// A yield point of a few milliseconds: the step's own clock, not the queue's.
const YIELDING = { pollMs: 5, yieldAfterMs: 40 };

describe("a runner panel hands control back and is called again", () => {
  it("seats still queued at the yield point: the step answers waiting, nothing is cancelled, and a second call starts no new run", async () => {
    const t = await discussing("runner", "pending");
    const first = await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    expect(first).toEqual({ status: "waiting", reason: "queued_on_runner" });
    expect(t.world.cancelled).toEqual([]);
    expect(await runRows(t.workItemId)).toBe(3);

    const again = await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    expect(again).toEqual({ status: "waiting", reason: "queued_on_runner" });
    // The same keys came back; the count of run rows did not move.
    expect(await runRows(t.workItemId)).toBe(3);
    expect(new Set(t.world.requests.map((r) => r.step)).size).toBe(3);
    expect(t.world.cancelled).toEqual([]);
    expect(await signed(t.discussionId)).toEqual([]);

    // The runner works the seats one after another; the next call follows them to the end.
    t.world.finish(() => true);
    expect(await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING)).toEqual({ status: "completed", complete: true, missingRoles: [], round2Ran: false });
    expect(await runRows(t.workItemId)).toBe(3);
    expect(await signed(t.discussionId)).toEqual([...CRITICAL].sort());
    expect(t.world.cancelled).toEqual([]);
  });

  it("a seat that finished before the yield keeps its comment; a seat still queued is neither failed nor timed out", async () => {
    const t = await discussing("runner", "pending");
    // The runner has claimed and finished one seat by the time the step yields on the others.
    const world = t.world;
    const pendingStart = runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, world, YIELDING);
    await new Promise((r) => setTimeout(r, 15));
    world.finish((r) => r.role === "technical-architect");
    expect(await pendingStart).toEqual({ status: "waiting", reason: "queued_on_runner" });
    expect(await signed(t.discussionId)).toEqual(["technical-architect"]);

    world.finish(() => true);
    expect(await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, world, YIELDING)).toMatchObject({ status: "completed", complete: true, missingRoles: [] });
    expect(await signed(t.discussionId)).toEqual([...CRITICAL].sort());
    expect(await runRows(t.workItemId)).toBe(3);
    expect(world.cancelled).toEqual([]);
  });

  it("the Spec step: a queued PM run yields without being cancelled, the panel re-entry costs nothing, and the next call publishes", async () => {
    const t = await discussing("runner", "pending");
    const seatsFirst = await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    expect(seatsFirst).toEqual({ status: "waiting", reason: "queued_on_runner" });
    t.world.finish(() => true);
    expect(await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING)).toMatchObject({ status: "completed", complete: true });

    const waiting = await runSpecForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    expect(waiting).toEqual({ status: "waiting", reason: "queued_on_runner" });
    expect(t.world.cancelled).toEqual([]);
    expect(await stageOf(t.workItemId)).toBe("discussing");
    expect(await runRows(t.workItemId)).toBe(4); // three seats and one PM

    expect(await runSpecForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING)).toEqual({ status: "waiting", reason: "queued_on_runner" });
    expect(await runRows(t.workItemId)).toBe(4);

    t.world.finish((r) => r.role === "project-manager");
    expect(await runSpecForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING)).toMatchObject({ status: "published", stage: "spec_ready", version: 1 });
    expect(await runRows(t.workItemId)).toBe(4);
    expect(t.world.cancelled).toEqual([]);
  });

  it("a PM run that the runner has claimed and is working on yields at the step's own limit too", async () => {
    const t = await discussing("runner", "pending");
    await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    t.world.finish(() => true);
    await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    await runSpecForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    t.world.claim((r) => r.role === "project-manager", 200_000);
    expect(await runSpecForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING)).toEqual({ status: "waiting", reason: "queued_on_runner" });
    expect(t.world.cancelled).toEqual([]);
  });
});

describe("a sandbox panel is unchanged", () => {
  it("seats that are still running past the yield point do not make the step yield: it waits and completes", async () => {
    const t = await discussing("production", "running");
    const run = runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    await new Promise((r) => setTimeout(r, 150)); // well past the 40 ms yield point
    t.world.finish(() => true);
    expect(await run).toEqual({ status: "completed", complete: true, missingRoles: [], round2Ran: false });
    expect(t.world.cancelled).toEqual([]);
  });

  it("a seat that never ends is still cancelled at the round deadline and recorded as timed out", async () => {
    const t = await discussing("production", "running");
    const panel = await runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, { ...YIELDING, roundTimeoutMs: 120 });
    expect(panel).toMatchObject({ status: "completed", complete: false });
    expect(t.world.cancelled).toHaveLength(3);
  });

  it("the Spec step with a PM that never ends still ends pm_timed_out, not waiting", async () => {
    const t = await discussing("production", "running");
    const panel = runPanelForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, YIELDING);
    await new Promise((r) => setTimeout(r, 30));
    t.world.finish(() => true);
    await panel;
    expect(await runSpecForItem(h.runWriterPool, t.accountId, t.workItemId, t.world, { ...YIELDING, pmTimeoutMs: 100 })).toEqual({ status: "refused", reason: "pm_timed_out" });
    expect(t.world.cancelled).toHaveLength(1);
  });
});

describe("the yield point leaves room inside the step's time limit", () => {
  it("the yield point plus one seat round, and plus the PM run, are each under the step limit", () => {
    expect(STEP_YIELD_MS + SEAT_ROUND_TIMEOUT_MS).toBeLessThan(STEP_LIMIT_MS);
    expect(STEP_YIELD_MS + PM_TIMEOUT_MS).toBeLessThan(STEP_LIMIT_MS);
  });
});
