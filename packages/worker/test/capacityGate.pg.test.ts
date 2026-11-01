import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxTarget, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createCapacityPort } from "@fx/pipeline";
import { startBuildForItem } from "@fx/pipeline/testing/build";
import { upToDateHeads } from "./withIssuePr.js";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createAdvanceModule } from "../src/advance.js";
import { CAPACITY_WAIT, CapacityWaitingError, createCapacityGate, type CapacityPort } from "../src/capacityGate.js";
import { createRunStarter } from "../src/starter.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#483 S5-k3b-2c [pg]: the capacity gate over the REAL path. The sandbox target is the real one over the strict fake sandbox (`failCreate(429)` throws
 * `SandboxPortError("createSandbox", 429)` as the real port does), the run starter, the advance module, the queue helper and the database are the real ones. The only
 * fakes are the sandbox and the seat. Not faked faithfully: the provider's real concurrency answer (C21: no live capture, it is cost-bearing).
 */
describe("the capacity gate [pg]", { timeout: 90_000 }, () => {
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
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await admin.query("DELETE FROM capacity_queue");
  });

  const SPEND = { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 };
  const seat = (spend: Record<string, unknown> = SPEND): SeatResult =>
    ({
      ok: true,
      seat: { repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5, spend, limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 }, timeoutMs: 40 * 60_000, maxExtensions: 3 },
    }) as never;

  let nextNumber = 9700;
  async function setup(mode = "sandbox") {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId, mode]);
    const items: string[] = [];
    for (let i = 0; i < 2; i++) {
      const w = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'discussing', $4)", [w, a.accountId, a.repoId, nextNumber++]);
      items.push(w);
    }
    return { a, w: items[0]!, w2: items[1]! };
  }
  /** The slots in use across the database, so a test can say "room for n more". */
  const inUse = async (): Promise<number> => Number((await admin.query("SELECT o_slots_in_use AS n FROM capacity_queue_state('hosted_sandbox')")).rows[0].n);
  /** The item writes its waiting fact, as the workflow does on every ask. */
  const asks = async (t: { a: SeedRefs }, w: string): Promise<void> => {
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', 'waiting_for_capacity', 0, $3)", [t.a.accountId, w, randomUUID()]);
  };
  const entries = async (w: string) => (await admin.query("SELECT * FROM capacity_queue WHERE work_item_id = $1 ORDER BY created_at, id", [w])).rows;
  const runsOf = async (w: string) => (await admin.query("SELECT id, status FROM agent_runs WHERE work_item_id = $1 ORDER BY created_at, id", [w])).rows as Array<{ id: string; status: string }>;
  const reasonOf = async (runId: string): Promise<string | null> =>
    (await admin.query("SELECT payload->>'failureReason' AS r FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' IN ('cancelled', 'failed') ORDER BY seq DESC LIMIT 1", [runId])).rows[0]?.r ?? null;
  const keysOf = async (w: string): Promise<string[]> => (await admin.query("SELECT idempotency_key FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.id = k.run_id WHERE r.work_item_id = $1 ORDER BY k.created_at", [w])).rows.map((r) => r.idempotency_key);

  /** The real advance module over the real sandbox target, with the capacity port over `total` (a function so a test can move it). */
  function build(total: () => number, resolve: () => SeatResult | Promise<SeatResult> = () => seat(), extra: Partial<Parameters<typeof createAdvanceModule>[1]> = {}) {
    const harness = createSandboxTargetHarness(writerPool, []);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    const starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    const port = createCapacityPort({ pool: writerPool, slotTotal: total });
    const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: vi.fn(async () => resolve()), startAdvance: async () => undefined, triage: null, registry, capacity: port, ...extra });
    return { m, port, fake: harness.fakeSandbox };
  }
  const req = (t: { a: SeedRefs }, w: string, step: string) => ({ accountId: t.a.accountId, workItemId: w, haltEpoch: 0, step, role: "project-manager", prompt: "go" });

  it("S5k3b-1/-3, count route: with every slot full the item waits (no run, no failed run, never halted) however often it asks; room frees and it starts exactly one run", async () => {
    const t = await setup();
    let total = await inUse();
    const { m } = build(() => total);
    for (let ask = 0; ask < 5; ask++) {
      expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
      await asks(t, t.w);
    }
    expect(await runsOf(t.w)).toEqual([]);
    expect(await entries(t.w)).toHaveLength(1);
    expect((await admin.query("SELECT halted_at FROM work_items WHERE id = $1", [t.w])).rows[0].halted_at).toBeNull();

    total += 1;
    const started = await m.advanceStartRun(req(t, t.w, "s1"));
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    expect((await runsOf(t.w)).map((r) => r.status)).toEqual(["running"]);
    expect(await keysOf(t.w)).toEqual([`advance:${t.w}:s1`]);
    // the claim is recorded beside the run, in its create transaction
    expect((await entries(t.w))[0]).toMatchObject({ started_run_id: started.runId });
    // a replay of the step returns the run and starts nothing more
    expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: true, runId: started.runId });
    expect(await runsOf(t.w)).toHaveLength(1);
    expect(await entries(t.w)).toHaveLength(1);
  });

  it("C23-7, direct start: a 429 ends the attempt cancelled / provider_capacity (never failed, never internal_error), the item waits, and the next ask restarts under :p1; a replay finds the :p1 run", async () => {
    const t = await setup();
    const total = (await inUse()) + 10;
    const { m, fake } = build(() => total);
    fake.failCreate(429);
    expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
    const [cut] = await runsOf(t.w);
    expect(cut).toMatchObject({ status: "cancelled" });
    expect(await reasonOf(cut!.id)).toBe("provider_capacity");
    expect((await runsOf(t.w)).filter((r) => r.status === "failed")).toEqual([]);
    expect(await entries(t.w)).toEqual([expect.objectContaining({ refused_status: 429, started_run_id: null })]);

    fake.healCreate();
    await asks(t, t.w);
    const again = await m.advanceStartRun(req(t, t.w, "s1"));
    if (!again.ok) throw new Error(`not started: ${again.reason}`);
    expect(await keysOf(t.w)).toEqual([`advance:${t.w}:s1`, `advance:${t.w}:s1:p1`]);
    expect(again.runId).not.toBe(cut!.id);
    expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: true, runId: again.runId });
    expect(await runsOf(t.w)).toHaveLength(2);
  });

  it("C23-7, claimed start: a 429 re-queues the SAME entry (id and enqueued_at kept, attempt + 1, the code recorded) and the item waits; provider_capacity generations are not counted against PLACEMENT_RESTARTS_MAX", async () => {
    const t = await setup();
    let total = await inUse();
    const { m, port, fake } = build(() => total);
    expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
    await asks(t, t.w);
    const [first] = await entries(t.w);
    total += 1;
    // five 429s in a row (more than the three a placement change is allowed), each on a claimed start
    for (let round = 1; round <= 5; round++) {
      expect(await port.claimPass()).toBeGreaterThanOrEqual(0);
      fake.failCreate(429, "rate_limited");
      expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
      const [now] = await entries(t.w);
      expect(now).toMatchObject({ id: first.id, started_run_id: null, claimed_at: null, attempt: first.attempt + round, refused_status: 429, refused_code: "rate_limited" });
      expect(now.enqueued_at).toEqual(first.enqueued_at);
      await asks(t, t.w);
    }
    expect(await entries(t.w)).toHaveLength(1);
    expect((await runsOf(t.w)).every((r) => r.status === "cancelled")).toBe(true);
    fake.healCreate();
    const done = await m.advanceStartRun(req(t, t.w, "s1"));
    if (!done.ok) throw new Error(`not started: ${done.reason}`);
    expect(await keysOf(t.w)).toEqual(["", ":p1", ":p2", ":p3", ":p4", ":p5"].map((tail) => `advance:${t.w}:s1${tail}`).slice(0, 6));
    expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: true, runId: done.runId });
    expect(await entries(t.w)).toEqual([expect.objectContaining({ id: first.id, started_run_id: done.runId })]);
  });

  it("C23-6: two concurrent asks of one item holding one claim start exactly one run; the loser answers waiting_for_capacity and has a new open entry", async () => {
    const t = await setup();
    let total = await inUse();
    const { m, port } = build(() => total);
    expect(await m.advanceStartRun(req(t, t.w, "a"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
    await asks(t, t.w);
    total += 1;
    expect(await port.claimPass()).toBe(1);
    const claimed = (await entries(t.w))[0];
    const [one, two] = await Promise.all([m.advanceStartRun(req(t, t.w, "a")), m.advanceStartRun(req(t, t.w, "b"))]);
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
    const loser = one.ok ? two : one;
    expect(loser).toEqual({ ok: false, reason: CAPACITY_WAIT });
    expect(await runsOf(t.w)).toHaveLength(1);
    expect(await keysOf(t.w)).toHaveLength(1);
    // the claim is the winner's; the loser holds a new place
    const all = await entries(t.w);
    expect(all).toHaveLength(2);
    expect(all.filter((e) => e.started_run_id === null && e.ended_at === null)).toHaveLength(1);
    expect(all.find((e) => e.id === claimed.id)).toMatchObject({ started_run_id: (await runsOf(t.w))[0]!.id });
    // a replay of the winner's step returns its run
    const winner = (one.ok ? one : two) as { ok: true; runId: string };
    expect(await m.advanceStartRun(req(t, t.w, one.ok ? "a" : "b"))).toEqual({ ok: true, runId: winner.runId });
  });

  it("a run that ended OUTSIDE the follower (this harness starts none; the reconcile tick calls the same capacityClaimPass): a run ending frees a slot, one claim pass claims the waiting item, and its next ask starts exactly one run; a second pass claims nothing", async () => {
    const t = await setup();
    const holder = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'executor', 'production', 'running', 'sandbox')", [holder, t.a.accountId, t.w2]);
    const total = await inUse(); // every slot in use, the holder's included
    const { m } = build(() => total);
    expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
    await asks(t, t.w);
    expect(await m.capacityClaimPass()).toBe(0);
    await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [holder]);
    expect(await m.capacityClaimPass()).toBe(1);
    expect(await m.capacityClaimPass()).toBe(0);
    const started = await m.advanceStartRun(req(t, t.w, "s1"));
    expect(started.ok).toBe(true);
    expect((await runsOf(t.w)).filter((r) => r.status === "running")).toHaveLength(1);
  });

  it("rule 1 first: an item at its own spend limit goes to the starter as today (refused_spend, never queued), and a runner-side repository passes through the gate untouched", async () => {
    const t = await setup();
    const admit = vi.fn();
    const port: CapacityPort = { holds: async () => false, admit, refused: async () => undefined };
    const gate = createCapacityGate(writerPool, port);
    const start = vi.fn(async (input: StartAgentRunInput) => input.accountId);
    const base = { accountId: t.a.accountId, repoId: t.a.repoId, workItemId: t.w, role: "project-manager", idempotency: { key: `k:${randomUUID()}`, requestHash: "h" } } as unknown as StartAgentRunInput;
    // the customer's own per-run limit is below the estimate: a deny from the real headroom check
    await gate.run({ ...base, spend: { ...SPEND, estimateModelUsd: 1000, perSpawnCapUsd: 5 } as never }, start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
    expect(await entries(t.w)).toEqual([]);
    // not a sandbox repository
    const r = await setup("runner_local");
    await gate.run({ ...base, accountId: r.a.accountId, repoId: r.a.repoId, workItemId: r.w, spend: SPEND as never }, start);
    expect(start).toHaveBeenCalledTimes(2);
    expect(admit).not.toHaveBeenCalled();
    // and with room and a sandbox repository the port is asked, and a "wait" never reaches the starter
    admit.mockResolvedValueOnce({ kind: "wait" });
    await expect(gate.run({ ...base, spend: SPEND as never }, start)).rejects.toBeInstanceOf(CapacityWaitingError);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("a repository that is no longer connected: an item holding a place keeps waiting (waiting_for_capacity); an item without one gets the refusal as before", async () => {
    const t = await setup();
    let total = await inUse();
    const { m } = build(() => total, () => ({ ok: false, reason: "no_installation" }) as never);
    expect(await m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: "no_installation" });
    await admin.query("INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class) VALUES ($1, $2, $3, 'executor', 'hosted_sandbox')", [t.a.accountId, t.a.repoId, t.w]);
    for (const reason of ["no_installation", "installation_not_writable"]) {
      const b = build(() => total, () => ({ ok: false, reason }) as never);
      expect(await b.m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
    }
    // a refusal that is not about the repository stays what it was
    const other = build(() => total, () => ({ ok: false, reason: "no_model" }) as never);
    expect(await other.m.advanceStartRun(req(t, t.w, "s1"))).toEqual({ ok: false, reason: "no_model" });
    total += 1;
  });

  it("C23-8: with no slot total in plan data a hosted start is not held back by the count, and a 429 still queues", async () => {
    const t = await setup();
    const missing = (): number => {
      throw new Error("plan data has no capacity.hostedSandboxConcurrency");
    };
    const { m, fake } = build(missing);
    const started = await m.advanceStartRun(req(t, t.w, "s1"));
    expect(started.ok).toBe(true);
    expect(await entries(t.w)).toEqual([]);
    fake.failCreate(429);
    expect(await m.advanceStartRun(req(t, t.w2, "s2"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
    expect(await entries(t.w2)).toHaveLength(1);
  });
  it("the build (Spec ready): a 429 leaves the item waiting, and the next ask starts the build under :p1 on the same item; the cancelled attempt is not read as an earlier run the person cancelled (prior_run_cancelled)", async () => {
    const t = await setup();
    await admin.query("UPDATE work_items SET stage = 'spec_ready' WHERE id = $1", [t.w]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, t.a.accountId, nextNumber++, t.w]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, t.w]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [t.a.accountId, t.w]);
    const total = (await inUse()) + 10;
    const { m, fake } = build(() => total, () => seat(), { build: startBuildForItem, fixHeads: upToDateHeads("a".repeat(40)) });
    const who = { accountId: t.a.accountId, userId: t.a.userId, workItemId: t.w, haltEpoch: 0 };
    const approval = randomUUID();
    fake.failCreate(429);
    expect(await m.advanceBuild(who, approval, 1)).toMatchObject({ status: "refused", reason: CAPACITY_WAIT });
    expect((await runsOf(t.w)).map((r) => r.status)).toEqual(["cancelled"]);
    expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [t.w])).rows[0].stage).toBe("spec_ready");
    fake.healCreate();
    await asks(t, t.w);
    const again = await m.advanceBuild(who, approval, 1);
    expect(again).toMatchObject({ status: "started" });
    expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [t.w])).rows[0].stage).toBe("in_progress");
    expect((await keysOf(t.w)).map((k) => k.endsWith(":p1"))).toEqual([false, true]);
  });
});
