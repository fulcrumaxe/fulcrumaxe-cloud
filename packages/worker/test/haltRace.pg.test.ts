import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAgentRun, startAgentRun, WorkItemHaltedError, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStartArgs } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] DP8 / DP-C6: a customer halt is a marker on the work item, checked by the database inside the run's create
 * transaction. Every interleaving here is forced by a promise the test holds or by a lock it observes, never by a sleep.
 */
const HASH = "h".repeat(64);
const SEAT: SeatResult = {
  ok: true,
  seat: {
    repoId: "unused",
    product: "team",
    roleCard: "card",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
    limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
    timeoutMs: 40 * 60_000,
    maxExtensions: 3,
  } as never,
};

describe("halt marker [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  let nextNumber = 5000;
  let nextDiscussion = 500;
  /** An item at `stage` with a discussion and a Spec, so every advance action that needs them is available. */
  async function item(a: SeedRefs, stage = "in_progress", kind = "feature"): Promise<string> {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', $4, $5)", [id, a.accountId, a.repoId, stage, nextNumber++]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, $4, 't', $5, 'internal', 'user')", [d, a.accountId, nextDiscussion++, kind, id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, id]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    return id;
  }
  /** A request through the real definer; `claim` leases it like the workflow does. */
  async function request(a: SeedRefs, kind: "cancel_work_item" | "advance_work_item", workItemId: string, claim = true): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request($1, $2, NULL, $3)", [kind, workItemId, HASH])).rows[0]);
    if (claim) expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  const liveRunsOf = async (workItemId: string) =>
    (await admin.query("SELECT id FROM agent_runs WHERE work_item_id = $1 AND status NOT IN ('succeeded','failed','timed_out','killed_spend','refused_spend','cancelled')", [workItemId])).rows.map((r) => r.id as string);
  const marker = async (workItemId: string) => (await admin.query("SELECT stage, halted_at, halt_action_id, halt_epoch FROM work_items WHERE id = $1", [workItemId])).rows[0];
  const runCount = async (workItemId: string) => (await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [workItemId])).rows[0].n as number;

  /** A registry whose sandbox target counts what a real start would do (admit, dispatch) and records cancels. */
  function registry() {
    const cancels: string[] = [];
    const calls = { admit: 0, dispatch: 0 };
    const unused = async () => {
      throw new Error("unused");
    };
    const target = {
      runtime: "production",
      admit: async () => (calls.admit++, { admitted: false, reason: "test" }),
      dispatch: async () => (calls.dispatch++, unused()),
      resume: unused,
      finalize: unused,
      cancel: async (run: { id: string }) => (cancels.push(run.id), { settled_usd: 0, released_usd: 0 }),
    };
    return { registry: { sandbox: target } as unknown as ExecutionTargetRegistry, cancels, calls };
  }

  /** A starter that creates a real run through the real insert (and so through the trigger), optionally holding the create open. */
  function starter(a: SeedRefs, hold?: { inside: () => Promise<void> }) {
    const calls: string[] = [];
    const started: string[] = [];
    const s: RunStarter = {
      async start(input) {
        calls.push(input.idempotency!.key);
        const { id } = await insertAgentRun(writerPool, {
          id: randomUUID(),
          accountId: a.accountId,
          workItemId: input.workItemId!,
          role: "code-reviewer",
          runtime: "production",
          executionMode: "sandbox",
          dispatchRepoId: a.repoId,
          idempotency: input.idempotency,
          ...(hold ? { inCreateTransaction: hold.inside } : {}),
        });
        started.push(id);
        return { runId: id };
      },
    };
    return { starter: s, calls, started };
  }
  /** Pipeline stand-ins that must never be reached on a halted item. */
  const reached: string[] = [];
  const mustNotRun = (name: string) => (async () => (reached.push(name), { status: "ok" })) as never;
  function advance(s: RunStarter, reg: ExecutionTargetRegistry, over: Partial<AdvanceModuleDeps> = {}, pool: Pool = writerPool) {
    const args: AdvanceStartArgs[] = [];
    const deps: AdvanceModuleDeps = {
      starter: s,
      resolveRunSeat: async () => SEAT,
      startAdvance: async (x) => void args.push(x),
      triage: null,
      registry: reg,
      panel: mustNotRun("panel"),
      spec: mustNotRun("spec"),
      build: mustNotRun("build"),
      review: {} as never,
      ...over,
    };
    return { module: createAdvanceModule(pool, deps), args };
  }
  const startReq = (a: SeedRefs, workItemId: string, step: string, haltEpoch = 0) => ({ accountId: a.accountId, workItemId, step, role: "code-reviewer", prompt: "review", haltEpoch });
  /** Halts an item through the real performer. */
  async function halt(a: SeedRefs, workItemId: string, reg: ExecutionTargetRegistry) {
    const id = await request(a, "cancel_work_item", workItemId);
    return { id, out: await createRunActionFacade(writerPool, reg).performCancelWorkItem(id) };
  }
  /** Polls the database (not a clock) until some backend waits on a row lock with `fragment` in its statement. */
  async function waitUntilBlocked(fragment: string): Promise<void> {
    for (let i = 0; i < 20_000; i++) {
      const { rowCount } = await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()", [`%${fragment}%`]);
      if (rowCount) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("nobody ever blocked on " + fragment);
  }

  // ---- criterion 1: create-then-halt ---------------------------------------------------------------------------

  it("1 (inside the create transaction): a create in flight holds the halt back; the halt's list then sees the run and cancels it", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a);
    const { registry: reg, cancels } = registry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inside!: () => void;
    const insideCreate = new Promise<void>((resolve) => (inside = resolve));
    // The create transaction is open and holds the trigger's share lock on the item when `inside` runs.
    const s = starter(a, { inside: async () => (inside(), gate) });
    const t = advance(s.starter, reg);
    const starting = t.module.advanceStartRun(startReq(a, wi, "review:race"));
    await insideCreate;

    const haltId = await request(a, "cancel_work_item", wi);
    const halting = createRunActionFacade(writerPool, reg).performCancelWorkItem(haltId);
    // The halt's marker write is waiting on the create's lock: observed, not assumed.
    await waitUntilBlocked("SELECT halt_action_id");
    expect((await marker(wi)).halted_at).toBeNull();

    release();
    const start = await starting;
    expect(start.ok).toBe(true);
    const out = await halting;
    expect(out).toMatchObject({ result: "done", outcome: { halted: true, runs_cancelled: 1 } });
    expect(cancels).toEqual([s.started[0]]);
    expect(await liveRunsOf(wi)).toEqual([]);
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [s.started[0]])).rows[0].status).toBe("cancelled");
  });

  it("1 (between the guard's read and the insert): a create paused after the trigger read the marker still holds the halt back, so the halt's list sees its run", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a);
    const { registry: reg, cancels } = registry();
    // A fixture trigger that sorts AFTER the guard and parks the insert on an advisory lock this test holds: the create has
    // read the marker (and, with FOR SHARE, locked the row) but has not inserted, so the foreign-key lock is not yet taken.
    await admin.query("CREATE FUNCTION dp8_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('dp8_pause')); RETURN NEW; END $$");
    await admin.query(`CREATE TRIGGER zz_dp8_pause BEFORE INSERT ON agent_runs FOR EACH ROW WHEN (NEW.work_item_id = '${wi}') EXECUTE FUNCTION dp8_pause()`);
    await admin.query("SELECT pg_advisory_lock(hashtext('dp8_pause'))");
    try {
      const s = starter(a);
      const starting = advance(s.starter, reg).module.advanceStartRun(startReq(a, wi, "review:between"));
      // The create is parked on the advisory lock: observed in pg_locks.
      for (let i = 0; i < 20_000 && !(await admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rowCount; i++) await new Promise<void>((resolve) => setImmediate(resolve));

      const haltId = await request(a, "cancel_work_item", wi);
      const halting = createRunActionFacade(writerPool, reg).performCancelWorkItem(haltId);
      // With the share lock the halt's marker write waits for the create. With a plain read it would not, and would commit first.
      await waitUntilBlocked("SELECT halt_action_id");
      expect((await marker(wi)).halted_at).toBeNull();

      await admin.query("SELECT pg_advisory_unlock(hashtext('dp8_pause'))");
      expect((await starting).ok).toBe(true);
      const out = await halting;
      expect(out).toMatchObject({ result: "done", outcome: { halted: true, runs_cancelled: 1 } });
      expect(cancels).toEqual([s.started[0]]);
      expect(await liveRunsOf(wi)).toEqual([]);
    } finally {
      await admin.query("SELECT pg_advisory_unlock_all()");
      await admin.query("DROP TRIGGER zz_dp8_pause ON agent_runs");
      await admin.query("DROP FUNCTION dp8_pause()");
    }
  });

  // ---- criterion 2: halt-then-create ---------------------------------------------------------------------------

  it("2: after the marker commits a start is refused with no run, no claim and no sandbox call; so is a direct insert", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "triaged");
    const { registry: reg, calls } = registry();
    await halt(a, wi, reg);
    const before = await runCount(wi);

    // The database is the authority: the real start path is refused at the insert, before admit or dispatch.
    const input: StartAgentRunInput = {
      ...SEAT.seat,
      accountId: a.accountId,
      repoId: a.repoId,
      workItemId: wi,
      role: "project-manager",
      product: "team",
      prompt: "p",
      idempotency: { key: `advance:${wi}:classify:y`, requestHash: "r".repeat(64) },
    } as never;
    await expect(startAgentRun(writerPool, reg, input)).rejects.toBeInstanceOf(WorkItemHaltedError);
    expect(calls).toEqual({ admit: 0, dispatch: 0 });
    expect(await runCount(wi)).toBe(before);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [a.accountId, input.idempotency!.key])).rows[0].n).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM run_events e JOIN agent_runs r ON r.id = e.run_id WHERE r.work_item_id = $1", [wi])).rows[0].n).toBe(0);
  });

  // ---- criterion 11: replay safety -----------------------------------------------------------------------------

  it("11: performing the same halt twice, and a paged second call, leave the marker as the first call set it", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "in_progress");
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode)
       SELECT gen_random_uuid(), $1, $2, 'code-reviewer', 'production', 'running', 'sandbox' FROM generate_series(1, 101)`,
      [a.accountId, wi],
    );
    const { registry: reg } = registry();
    const perform = createRunActionFacade(writerPool, reg);
    const id = await request(a, "cancel_work_item", wi);
    expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { runs_cancelled: 100, remaining: true, halted: true } });
    const first = await marker(wi);
    expect(first.halt_epoch).toBe(1);
    expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { runs_cancelled: 1, halted: true } });
    expect(await perform.performCancelWorkItem(id)).toMatchObject({ outcome: { runs_cancelled: 0, halted: true } });
    expect(await marker(wi)).toEqual(first);
    // A second, different halt is a new halt: it bumps the epoch and names its own action.
    await createRunActionFacade(writerPool, reg).settleRunAction(id, { state: "done" });
    const again = await request(a, "cancel_work_item", wi);
    await perform.performCancelWorkItem(again);
    expect(await marker(wi)).toMatchObject({ halt_epoch: 2, halt_action_id: again });
  });

  // ---- control --------------------------------------------------------------------------------------------------

  it("a start on an item that was never halted still starts (the check is not a blanket refusal)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "pr_opened");
    const s = starter(a);
    const { registry: reg } = registry();
    const out = await advance(s.starter, reg).module.advanceStartRun(startReq(a, wi, "review:ok"));
    expect(out).toEqual({ ok: true, runId: s.started[0] });
  });
});
