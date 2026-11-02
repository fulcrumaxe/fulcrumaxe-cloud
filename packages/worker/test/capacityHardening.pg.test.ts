import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxTarget, insertAgentRun, writeRunStatus, type ExecutionRun, type ExecutionTarget, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createCapacityPort } from "@fx/pipeline";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createAdvanceModule } from "../src/advance.js";
import { CAPACITY_WAIT, CapacityWaitingError, createCapacityGate } from "../src/capacityGate.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createRetryModule, type RetrySeatSource } from "../src/retry.js";
import { createRunStarter } from "../src/starter.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#483 S5-k3b-h [pg]: the capacity queue's hardening, over the real path (the real sandbox target over the strict fake sandbox, the real starter, advance module,
 * retry performer, queue port and database). The cancel write's failure is injected IN THE DATABASE: a test-only trigger refuses the next n `pending` ->
 * `cancelled` moves of one account's runs (a sequence counts them, so the count survives the refused transaction). Not faked faithfully: the provider's real
 * concurrency answer (C21: no live capture, it is cost-bearing).
 */
describe("capacity queue hardening [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    await admin.query(`CREATE TABLE IF NOT EXISTS fx_test_cancel_faults (account_id uuid PRIMARY KEY, upto bigint NOT NULL)`);
    await admin.query(`CREATE SEQUENCE IF NOT EXISTS fx_test_cancel_fault_seq`);
    await admin.query(`CREATE OR REPLACE FUNCTION fx_test_cancel_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
      DECLARE u bigint;
      BEGIN
        SELECT upto INTO u FROM public.fx_test_cancel_faults WHERE account_id = NEW.account_id;
        IF u IS NOT NULL AND nextval('public.fx_test_cancel_fault_seq') <= u THEN RAISE EXCEPTION 'injected cancel write fault'; END IF;
        RETURN NEW;
      END $$`);
    await admin.query(`CREATE OR REPLACE TRIGGER fx_test_cancel_fault BEFORE UPDATE OF status ON agent_runs FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status IN ('cancelled', 'failed')) EXECUTE FUNCTION fx_test_cancel_fault()`);
  });
  afterAll(async () => {
    await admin.query(`DROP TRIGGER IF EXISTS fx_test_cancel_fault ON agent_runs`);
    await admin.query(`DROP FUNCTION IF EXISTS fx_test_cancel_fault()`);
    await admin.query(`DROP TABLE IF EXISTS fx_test_cancel_faults`);
    await admin.query(`DROP SEQUENCE IF EXISTS fx_test_cancel_fault_seq`);
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await admin.query("DELETE FROM capacity_queue");
  });

  /** The next `n` cancel writes of the account's runs fail. */
  async function failCancels(a: SeedRefs, n: number): Promise<void> {
    const v = Number((await admin.query(`SELECT nextval('fx_test_cancel_fault_seq') AS v`)).rows[0].v);
    await admin.query(`INSERT INTO fx_test_cancel_faults (account_id, upto) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET upto = EXCLUDED.upto`, [a.accountId, v + n]);
  }

  const SPEND = { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 };
  const LIMITS = { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 };
  const seat = (): SeatResult => ({ ok: true, seat: { repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5, spend: SPEND, limits: LIMITS, timeoutMs: 40 * 60_000, maxExtensions: 3 } }) as never;

  let nextNumber = 9900;
  async function setup() {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = 'sandbox', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const items: string[] = [];
    for (let i = 0; i < 2; i++) {
      const w = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'discussing', $4)", [w, a.accountId, a.repoId, nextNumber++]);
      items.push(w);
    }
    return { a, w: items[0]!, w2: items[1]! };
  }
  const inUse = async (): Promise<number> => Number((await admin.query("SELECT o_slots_in_use AS n FROM capacity_queue_state('hosted_sandbox')")).rows[0].n);
  const asks = async (a: SeedRefs, w: string): Promise<void> => {
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', 'waiting_for_capacity', 0, $3)", [a.accountId, w, randomUUID()]);
  };
  const entries = async (w: string) => (await admin.query("SELECT * FROM capacity_queue WHERE work_item_id = $1 ORDER BY created_at, id", [w])).rows;
  const runsOf = async (w: string) => (await admin.query("SELECT id, status FROM agent_runs WHERE work_item_id = $1 ORDER BY created_at, id", [w])).rows as Array<{ id: string; status: string }>;
  const live = async (w: string) => (await runsOf(w)).filter((r) => ["pending", "running", "paused"].includes(r.status));
  const reasonOf = async (runId: string): Promise<string | null> =>
    (await admin.query("SELECT payload->>'failureReason' AS r FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'cancelled' ORDER BY seq DESC LIMIT 1", [runId])).rows[0]?.r ?? null;
  const keyOf = async (a: SeedRefs, key: string) => (await admin.query("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [a.accountId, key])).rows[0]?.run_id ?? null;
  const failedWrites = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("run.capacity_cancel_write_failed"));

  function build(total: () => number) {
    const harness = createSandboxTargetHarness(writerPool, []);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    const starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    const port = createCapacityPort({ pool: writerPool, slotTotal: total });
    const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: vi.fn(async () => seat()), startAdvance: async () => undefined, triage: null, registry, capacity: port });
    return { m, port, fake: harness.fakeSandbox };
  }
  const req = (a: SeedRefs, w: string, step: string) => ({ accountId: a.accountId, workItemId: w, haltEpoch: 0, step, role: "project-manager", prompt: "go" });

  describe("C27-k3h-1: the provider_capacity cancel write", () => {
    it("fails once: the second try ends the run cancelled / provider_capacity, no line is logged, and the item waits", async () => {
      const t = await setup();
      const { m, fake } = build(() => Number.MAX_SAFE_INTEGER);
      await failCancels(t.a, 1);
      fake.failCreate(429);
      expect(await m.advanceStartRun(req(t.a, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
      const [run] = await runsOf(t.w);
      expect(run).toMatchObject({ status: "cancelled" });
      expect(await reasonOf(run!.id)).toBe("provider_capacity");
      expect(failedWrites()).toEqual([]);
      expect(await entries(t.w)).toEqual([expect.objectContaining({ refused_status: 429, started_run_id: null, ended_at: null })]);
    });

    it("fails twice: one fixed line with the run id only; the next start ends the stuck run and starts exactly one fresh run under the gate; never two live runs", async () => {
      const t = await setup();
      const { m, fake } = build(() => Number.MAX_SAFE_INTEGER);
      await failCancels(t.a, 2);
      fake.failCreate(429);
      expect(await m.advanceStartRun(req(t.a, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
      const [stuck] = await runsOf(t.w);
      expect(stuck).toMatchObject({ status: "pending" });
      expect(failedWrites()).toEqual([JSON.stringify({ event: "run.capacity_cancel_write_failed", run_id: stuck!.id })]);
      expect(await live(t.w)).toHaveLength(1);
      // without the fix the key replays the pending run for ever; with it the next ask ends it and starts one fresh run under the same key
      fake.healCreate();
      await asks(t.a, t.w);
      const next = await m.advanceStartRun(req(t.a, t.w, "s1"));
      if (!next.ok) throw new Error(`not started: ${next.reason}`);
      expect(next.runId).not.toBe(stuck!.id);
      expect(await reasonOf(stuck!.id)).toBe("provider_capacity");
      expect(await live(t.w)).toEqual([{ id: next.runId, status: "running" }]);
      expect(await keyOf(t.a, `advance:${t.w}:s1`)).toBe(next.runId);
      // the fresh start came out of the queue: the item's entry records it
      expect((await entries(t.w)).filter((e) => e.started_run_id === next.runId)).toHaveLength(1);
      // a replay finds the fresh run and starts nothing more
      expect(await m.advanceStartRun(req(t.a, t.w, "s1"))).toEqual({ ok: true, runId: next.runId });
      expect(await runsOf(t.w)).toHaveLength(2);
      expect(failedWrites()).toHaveLength(1);
    });

    it("fails twice with every slot full: the next start ends the stuck run and the fresh attempt waits at the gate; room frees and exactly one run starts", async () => {
      const t = await setup();
      let total = Number.MAX_SAFE_INTEGER;
      const { m, port, fake } = build(() => total);
      await failCancels(t.a, 2);
      fake.failCreate(429);
      expect(await m.advanceStartRun(req(t.a, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
      const [stuck] = await runsOf(t.w);
      fake.healCreate();
      // every slot in use once the stuck run (counted now) has ended
      total = (await inUse()) - 1;
      await asks(t.a, t.w);
      expect(await m.advanceStartRun(req(t.a, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
      expect(await runsOf(t.w)).toEqual([{ id: stuck!.id, status: "cancelled" }]);
      expect(await keyOf(t.a, `advance:${t.w}:s1`)).toBeNull();
      expect(await entries(t.w)).toEqual([expect.objectContaining({ started_run_id: null, ended_at: null })]);
      total += 1;
      await asks(t.a, t.w);
      expect(await port.claimPass()).toBe(1);
      const started = await m.advanceStartRun(req(t.a, t.w, "s1"));
      expect(started.ok).toBe(true);
      expect(await live(t.w)).toHaveLength(1);
    });

    it("a pending run whose dispatch is still at work (no stop mark) is never ended by a replay, whatever the item's entry says", async () => {
      const t = await setup();
      const key = `k:${randomUUID()}`;
      const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: t.a.accountId, workItemId: t.w, role: "project-manager", runtime: "production", executionMode: "sandbox", dispatchRepoId: t.a.repoId, idempotency: { key, requestHash: "a".repeat(64) } });
      await admin.query("INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class, refused_status) VALUES ($1, $2, $3, 'project_manager', 'hosted_sandbox', 429)", [t.a.accountId, t.a.repoId, t.w]);
      const port = createCapacityPort({ pool: writerPool, slotTotal: () => 0 });
      const start = vi.fn(async () => "replayed");
      const input = { accountId: t.a.accountId, repoId: t.a.repoId, workItemId: t.w, role: "project-manager", spend: SPEND, idempotency: { key, requestHash: "a".repeat(64) } } as unknown as StartAgentRunInput;
      expect(await createCapacityGate(writerPool, port).run(input, start)).toBe("replayed");
      expect(await runsOf(t.w)).toEqual([{ id, status: "pending" }]);
      expect(await keyOf(t.a, key)).toBe(id);
    });

    /** A pending sandbox run under a key, its stop mark set, with the given session ids and one open entry for its item. */
    async function stoppedPending(o: { sessions: string[]; refusedStatus: number | null; entryBeforeRun: boolean }) {
      const t = await setup();
      const key = `k:${randomUUID()}`;
      const entry = () => admin.query("INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class, refused_status, created_at) VALUES ($1, $2, $3, 'project_manager', 'hosted_sandbox', $4, $5)", [t.a.accountId, t.a.repoId, t.w, o.refusedStatus, o.entryBeforeRun ? new Date(Date.now() - 60_000) : new Date(Date.now() + 60_000)]);
      if (o.entryBeforeRun) await entry();
      const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: t.a.accountId, workItemId: t.w, role: "project-manager", runtime: "production", executionMode: "sandbox", dispatchRepoId: t.a.repoId, idempotency: { key, requestHash: "a".repeat(64) } });
      await admin.query("UPDATE agent_runs SET sandbox_requested_at = now(), sandbox_session_ids = $2, sandbox_stopped_at = now() WHERE id = $1", [id, o.sessions]);
      if (!o.entryBeforeRun) await entry();
      const start = vi.fn(async () => "replayed");
      const input = { accountId: t.a.accountId, repoId: t.a.repoId, workItemId: t.w, role: "project-manager", spend: SPEND, idempotency: { key, requestHash: "a".repeat(64) } } as unknown as StartAgentRunInput;
      const out = await createCapacityGate(writerPool, createCapacityPort({ pool: writerPool, slotTotal: () => 0 })).run(input, start).catch((e: unknown) => e);
      return { out, runs: await runsOf(t.w), key: await keyOf(t.a, key), id };
    }

    it("the control: a stopped pending run with no session and a 429 entry made after it IS ended (the marker's four parts all hold)", async () => {
      const r = await stoppedPending({ sessions: [], refusedStatus: 429, entryBeforeRun: false });
      expect(r.runs).toEqual([{ id: r.id, status: "cancelled" }]);
      // with no slot free, the fresh attempt waits at the gate and the key is free for it
      expect(r.out).toBeInstanceOf(CapacityWaitingError);
      expect(r.key).toBeNull();
    });

    it.each([
      ["a recorded sandbox session", { sessions: ["sess-1"], refusedStatus: 429, entryBeforeRun: false }],
      ["an entry refused with something other than 429", { sessions: [], refusedStatus: 500, entryBeforeRun: false }],
      ["an entry with no refusal at all", { sessions: [], refusedStatus: null, entryBeforeRun: false }],
      ["a 429 entry older than the run (an earlier attempt's)", { sessions: [], refusedStatus: 429, entryBeforeRun: true }],
    ] as const)("a stopped pending run with %s is never ended by a replay: it passes through, keyed as before", async (_name, o) => {
      const r = await stoppedPending({ ...o, sessions: [...o.sessions] });
      expect(r.out).toBe("replayed");
      expect(r.runs).toEqual([{ id: r.id, status: "pending" }]);
      expect(r.key).toBe(r.id);
    });

    it("a run the internal-error path left pending (its failed write refused) is never ended as provider_capacity, even with an older 429 entry open", async () => {
      const t = await setup();
      const { m, fake } = build(() => Number.MAX_SAFE_INTEGER);
      // an earlier attempt's 429 left the item an open entry
      await admin.query("INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class, refused_status, created_at) VALUES ($1, $2, $3, 'project_manager', 'hosted_sandbox', 429, now() - interval '1 minute')", [t.a.accountId, t.a.repoId, t.w]);
      await failCancels(t.a, 1);
      fake.failCreate(500);
      await m.advanceStartRun(req(t.a, t.w, "s1")).catch(() => undefined);
      const [left] = await runsOf(t.w);
      expect(left).toMatchObject({ status: "pending" });
      expect((await admin.query("SELECT sandbox_stopped_at IS NOT NULL AS stopped, cardinality(sandbox_session_ids) AS n FROM agent_runs WHERE id = $1", [left!.id])).rows[0]).toEqual({ stopped: true, n: 0 });
      fake.healCreate();
      await asks(t.a, t.w);
      await m.advanceStartRun(req(t.a, t.w, "s1")).catch(() => undefined);
      expect(await runsOf(t.w)).toEqual([{ id: left!.id, status: "pending" }]);
      expect(await reasonOf(left!.id)).toBeNull();
    });

    it("must-fix 1: a racer that reads the key between the stuck run's end and its key release still meets the gate; no fresh run starts ungated", async () => {
      const t = await setup();
      let total = Number.MAX_SAFE_INTEGER;
      const first = build(() => total);
      await failCancels(t.a, 2);
      first.fake.failCreate(429);
      expect(await first.m.advanceStartRun(req(t.a, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
      const [stuck] = await runsOf(t.w);
      expect(stuck).toMatchObject({ status: "pending" });
      first.fake.healCreate();
      total = (await inUse()) - 1; // every slot in use once the stuck run has ended
      await asks(t.a, t.w);

      // The racer asks the gate itself with the SAME key, as a start site that does not re-key does (the advance step's own key loop would move it to :p1).
      // The winner's pool holds its key release until the racer reaches its starter, or 500 ms pass: the racer reads the key inside that window.
      const winnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
      const key = `advance:${t.w}:s1`;
      let racer: Promise<unknown> | null = null;
      let racerStarted!: () => void;
      const racerAtStart = new Promise<void>((r) => (racerStarted = r));
      const harness = createSandboxTargetHarness(writerPool, []);
      const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
      const racerPort = createCapacityPort({ pool: writerPool, slotTotal: () => total });
      const racerAdmit = vi.fn(racerPort.admit);
      const racerStart = vi.fn(async () => (racerStarted(), "started without the gate"));
      const racerInput = { accountId: t.a.accountId, repoId: t.a.repoId, workItemId: t.w, role: "project-manager", spend: SPEND, idempotency: { key, requestHash: "a".repeat(64) } } as unknown as StartAgentRunInput;
      const connect = winnerPool.connect.bind(winnerPool);
      let held = false;
      // Only the promise form is wrapped (pool.query uses the callback form internally and goes through untouched); every other statement passes straight on.
      (winnerPool as { connect: unknown }).connect = (...args: unknown[]) => {
        if (args.length > 0) return (connect as (...a: unknown[]) => unknown)(...args);
        return connect().then((c) => {
          const query = c.query.bind(c) as (...a: unknown[]) => unknown;
          (c as { query: unknown }).query = (...a: unknown[]) => {
            if (held || typeof a[0] !== "string" || !a[0].includes("agent_run_release_idempotency_key")) return query(...a);
            held = true;
            racer = createCapacityGate(writerPool, { ...racerPort, admit: racerAdmit }).run(racerInput, racerStart).catch((e: unknown) => e);
            return Promise.race([racerAtStart, new Promise((r) => setTimeout(r, 500))]).then(() => query(...a));
          };
          return c;
        });
      };
      try {
        const winnerStarter = createRunStarter({ pool: winnerPool, registry, follow: async () => undefined, queued: "accept" });
        const winner = createAdvanceModule(winnerPool, { starter: winnerStarter, resolveRunSeat: vi.fn(async () => seat()), startAdvance: async () => undefined, triage: null, registry, capacity: createCapacityPort({ pool: winnerPool, slotTotal: () => total }) });
        expect(await winner.advanceStartRun(req(t.a, t.w, "s1"))).toEqual({ ok: false, reason: CAPACITY_WAIT });
        expect(held).toBe(true);
        expect(await racer).toBeInstanceOf(CapacityWaitingError);
      } finally {
        await winnerPool.end();
      }
      expect(racerStart).not.toHaveBeenCalled();
      expect(racerAdmit).toHaveBeenCalled();
      expect(await runsOf(t.w)).toEqual([{ id: stuck!.id, status: "cancelled" }]);
      expect(await keyOf(t.a, `advance:${t.w}:s1`)).toBeNull();
    });
  });

  describe("C27-k3h-3: a replayed claim is consumed", () => {
    it("a claimed entry whose start is a replay of the item's run ends with started_run_id = that run, and the next entry moves up", async () => {
      const t = await setup();
      let total = await inUse();
      const { port } = build(() => total);
      for (const w of [t.w, t.w2]) {
        expect((await port.admit({ accountId: t.a.accountId, repoId: t.a.repoId, workItemId: w, runKind: "project_manager" })).kind).toBe("wait");
        await asks(t.a, w);
      }
      // the item's step already holds a run (an earlier start), and its entry gets the claim
      const key = `advance:${t.w}:s1`;
      const { id: runId } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: t.a.accountId, workItemId: t.w, role: "project-manager", runtime: "production", executionMode: "sandbox", dispatchRepoId: t.a.repoId, idempotency: { key, requestHash: "a".repeat(64) } });
      await writeRunStatus(writerPool, { accountId: t.a.accountId, runId, from: "pending", to: "running" });
      total = (await inUse()) + 1;
      expect(await port.claimPass()).toBe(1);
      const place = async (w: string) => withTenant(writerPool, t.a.accountId, async (c) => (await c.query("SELECT o_place FROM capacity_queue_place($1)", [w])).rows[0]?.o_place ?? null);
      const [claimed] = await entries(t.w);
      expect(claimed.claimed_at).not.toBeNull();
      expect((await entries(t.w2))[0].claimed_at).toBeNull();
      const start = vi.fn(async () => "replayed");
      const input = { accountId: t.a.accountId, repoId: t.a.repoId, workItemId: t.w, role: "project-manager", spend: SPEND, idempotency: { key, requestHash: "a".repeat(64) } } as unknown as StartAgentRunInput;
      expect(await createCapacityGate(writerPool, port).run(input, start)).toBe("replayed");
      expect(start).toHaveBeenCalledTimes(1);
      expect(await entries(t.w)).toEqual([expect.objectContaining({ id: claimed.id, started_run_id: runId })]);
      // the lease runs out: an unconsumed claim would come back ahead of the next entry; a consumed one is gone, and the next entry is first and is claimed next
      await admin.query("UPDATE capacity_queue SET claim_expires_at = claimed_at WHERE id = $1", [claimed.id]);
      await asks(t.a, t.w2);
      expect(await place(t.w2)).toBe(1);
      total = (await inUse()) + 1;
      expect(await port.claimPass()).toBe(1);
      expect((await entries(t.w2))[0].claimed_at).not.toBeNull();
    });
  });

  describe("C27-k3h-2: a person's Retry meets the gate", () => {
    function stubTarget(admit?: ExecutionTarget["admit"]) {
      const started: string[] = [];
      const target = {
        runtime: "production",
        admit: admit ?? (async () => ({ admitted: true })),
        cancel: async () => ({ settled_usd: 0, released_usd: 0 }),
        finalize: async () => {},
        dispatch: async (run: ExecutionRun) => (started.push(run.id), { hookToken: "t" }),
        resume: async () => ({ hookToken: "t" }),
      } as unknown as ExecutionTarget;
      return { registry: { sandbox: target } as ExecutionTargetRegistry, started };
    }
    const seats: RetrySeatSource = {
      async retrySeat(input) {
        const { rows } = await admin.query("SELECT repo_id FROM work_items WHERE id = $1", [input.workItemId]);
        return { ok: true, seat: { repoId: rows[0].repo_id, product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5, spend: SPEND, limits: LIMITS, timeoutMs: 40 * 60_000, maxExtensions: 3 } as never };
      },
    };
    /** A run the provider refused: `cancelled` / `provider_capacity`, with its prompt kept. */
    async function refusedRun(t: { a: SeedRefs; w: string }): Promise<string> {
      const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: t.a.accountId, workItemId: t.w, role: "project-manager", runtime: "production", executionMode: "sandbox", dispatchRepoId: t.a.repoId, startPrompt: "go" });
      await writeRunStatus(writerPool, { accountId: t.a.accountId, runId: id, from: "pending", to: "cancelled", failureReason: "provider_capacity" });
      return id;
    }
    async function retryAction(t: { a: SeedRefs }, runId: string): Promise<string> {
      const row = await withTenant(appPool, t.a.accountId, t.a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('retry_run', $1, NULL, $2)", [runId, "h".repeat(64)])).rows[0]);
      expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(row.action_id, 600)).not.toBeNull();
      return row.action_id;
    }
    const retryWith = (target: ReturnType<typeof stubTarget>, total: () => number) =>
      createRetryModule(writerPool, target.registry, { seats, authorCheck: () => null, capacity: createCapacityPort({ pool: writerPool, slotTotal: total }) });

    it("every slot full: the Retry answers waiting_for_capacity, queues the item and starts nothing; with a slot free it starts one run", async () => {
      const t = await setup();
      const parent = await refusedRun(t);
      let total = await inUse();
      const target = stubTarget();
      const retry = retryWith(target, () => total);
      expect(await retry.performRetryRun(await retryAction(t, parent))).toEqual({ result: "refused", errorCode: CAPACITY_WAIT });
      expect(target.started).toEqual([]);
      expect(await runsOf(t.w)).toEqual([{ id: parent, status: "cancelled" }]);
      expect(await entries(t.w)).toEqual([expect.objectContaining({ work_item_id: t.w, started_run_id: null, ended_at: null })]);

      const s = await setup();
      const other = await refusedRun(s);
      total = (await inUse()) + 1;
      const out = await retry.performRetryRun(await retryAction(s, other));
      expect(out).toMatchObject({ result: "done" });
      expect(target.started).toHaveLength(1);
      expect(await live(s.w)).toHaveLength(1);
      expect(await entries(s.w)).toEqual([]);
    });

    it("a spend deny still refuses as before, and is never queued", async () => {
      const t = await setup();
      const parent = await refusedRun(t);
      const target = stubTarget(async () => ({ admitted: false, reason: "per_spawn_cap_exceeded" }));
      const retry = retryWith(target, () => Number.MAX_SAFE_INTEGER);
      expect(await retry.performRetryRun(await retryAction(t, parent))).toEqual({ result: "refused", errorCode: "per_spawn_cap_exceeded" });
      expect(target.started).toEqual([]);
      expect(await entries(t.w)).toEqual([]);
    });
  });
});
