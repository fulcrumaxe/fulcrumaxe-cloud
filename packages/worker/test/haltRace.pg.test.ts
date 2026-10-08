import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAgentRun, startAgentRun, WorkItemHaltedError, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { startBuildForItem } from "@fx/pipeline";
import { sendBackToDiscussion } from "@fx/core/src/work-items/operatorMoves.js";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStartArgs, type AdvanceStepPorts } from "../src/advance.js";
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
  async function liveRun(a: SeedRefs, workItemId: string, role = "code-reviewer"): Promise<string> {
    const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: role as never, runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId });
    await admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [id]);
    return id;
  }
  /** A request through the real definer; `claim` leases it like the workflow does. */
  async function request(a: SeedRefs, kind: "cancel_work_item" | "advance_work_item", workItemId: string, claim = true): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request($1, $2, NULL, $3)", [kind, workItemId, HASH])).rows[0]);
    if (claim) expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  const claim = async (id: string) => expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(id, 600)).not.toBeNull();
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
  /** The pool with one change: the customer's halt commits just before the first statement containing `fragment` runs. */
  function haltedBefore(fragment: string, workItemId: string): Pool {
    return new Proxy(writerPool, {
      get(target, prop) {
        if (prop === "connect") {
          return async (...args: unknown[]) => {
            const client = await (target.connect as (...a: unknown[]) => Promise<{ query: (...q: unknown[]) => Promise<unknown> }>)(...args);
            const query = client.query.bind(client);
            client.query = async (...q: unknown[]) => {
              if (typeof q[0] === "string" && q[0].includes(fragment)) {
                // On the statement's own connection: a second session would wait for the row lock this transaction may already
                // hold. The write is the halt's own (marker + epoch); what is under test is the code path after it.
                await query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1 AND halted_at IS NULL", [workItemId, randomUUID()]);
              }
              return query(...q);
            };
            return client;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }
  const startReq = (a: SeedRefs, workItemId: string, step: string, haltEpoch = 0) => ({ accountId: a.accountId, workItemId, step, role: "code-reviewer", prompt: "review", haltEpoch });
  const whoOf = (a: SeedRefs, workItemId: string, haltEpoch = 0) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch });
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

    // The advisory read refuses before the seat and the environment...
    const s = starter(a);
    expect(await advance(s.starter, reg).module.advanceStartRun(startReq(a, wi, "classify:x", 1))).toEqual({ ok: false, reason: "item_halted" });
    expect(s.calls).toEqual([]);

    // ...and the database is the authority: the real start path is refused at the insert, before admit or dispatch.
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

  // ---- criterion 4: Build again works --------------------------------------------------------------------------

  it("4: halt at in_progress parks the item; an Approve requested after it clears the marker, and the build starts and moves needs_human -> in_progress", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "in_progress");
    const { registry: reg } = registry();
    await liveRun(a, wi);
    const h = await halt(a, wi, reg);
    expect(h.out).toMatchObject({ result: "done", outcome: { stage: "needs_human", halted: true } });
    expect(await marker(wi)).toMatchObject({ stage: "needs_human", halt_epoch: 1 });
    expect((await marker(wi)).halted_at).not.toBeNull();

    // The approval is requested AFTER the halt (a person pressing Build again).
    const approval = await request(a, "advance_work_item", wi);
    const s = starter(a);
    const t = advance(s.starter, reg, {
      build: startBuildForItem as never,
      // The pipeline's build asks the module's own start port, which is what the workflow's step does.
    });
    expect(await t.module.performAdvanceWorkItem(approval)).toEqual({ result: "done", outcome: { work_item_id: wi, advance: "started" } });
    expect(await marker(wi)).toMatchObject({ halted_at: null, halt_action_id: null, halt_epoch: 1 });
    expect(t.args[0]).toMatchObject({ haltEpoch: 1 });

    const out = await t.module.advanceBuild(whoOf(a, wi, t.args[0]!.haltEpoch), approval, 1);
    expect(out).toMatchObject({ status: "started" });
    expect(s.started).toHaveLength(1);
    expect((await marker(wi)).stage).toBe("in_progress");
  });

  // ---- criterion 5: a stale approval does not resume -----------------------------------------------------------

  it("5: an approval requested before the halt and performed after it is refused item_halted; the marker stays", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "in_progress");
    const { registry: reg } = registry();
    const stale = await request(a, "advance_work_item", wi, false); // pressed first
    await liveRun(a, wi);
    const h = await halt(a, wi, reg); // the halt cancels the live run, so the approval's own already_running check passes
    expect(h.out).toMatchObject({ outcome: { runs_cancelled: 1 } });
    await claim(stale);
    const t = advance(starter(a).starter, reg);
    expect(await t.module.performAdvanceWorkItem(stale)).toEqual({ result: "refused", errorCode: "item_halted" });
    expect(t.args).toEqual([]);
    expect((await marker(wi)).halted_at).not.toBeNull();
  });

  // ---- criterion 6 (worker half): a review cannot un-park ------------------------------------------------------

  it("6: advanceStartFix on a halted item refuses item_halted, leaves the stage and starts no run", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "review_passed");
    const { registry: reg } = registry();
    await halt(a, wi, reg);
    expect((await marker(wi)).stage).toBe("needs_human");
    const before = await runCount(wi);
    const t = advance(starter(a).starter, reg, { review: { resume: async () => { throw new Error("must not resume"); } } as never });
    const fix = await t.module.advanceStartFix(whoOf(a, wi, 1), { actionId: randomUUID(), failingRunId: randomUUID(), issue: 7, headSha: "a".repeat(40), prompt: "fix", round: 1, reviewer: "code" });
    expect(fix).toEqual({ ok: false, reason: "item_halted" });
    expect((await marker(wi)).stage).toBe("needs_human");
    expect(await runCount(wi)).toBe(before);
  });

  it("6: a halt that lands between advanceStartFix's guard and its stage write refuses item_halted: the stage stays, no run starts", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "review_passed");
    const { registry: reg } = registry();
    // The build's executor run with its session, ended: what a fix round resumes.
    const executor = await liveRun(a, wi, "executor");
    await admin.query("UPDATE agent_runs SET status = 'succeeded', cc_session_id = 's1' WHERE id = $1", [executor]);
    const before = await runCount(wi);
    const t = advance(starter(a).starter, reg, { review: { resume: async () => { throw new Error("must not resume"); } } as never }, haltedBefore("now() AS db_now, halted_at", wi));
    const fix = await t.module.advanceStartFix(whoOf(a, wi, 0), { actionId: randomUUID(), failingRunId: randomUUID(), issue: 7, headSha: "a".repeat(40), prompt: "fix", round: 1, reviewer: "code" });
    expect(fix).toEqual({ ok: false, reason: "item_halted" });
    expect((await marker(wi)).stage).toBe("review_passed");
    expect(await runCount(wi)).toBe(before);
  });

  it("6: a halt that lands between the build run's start and its stage write refuses item_halted, cancels the run just started, and leaves the stage", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "spec_ready");
    const cancels: string[] = [];
    const ports = {
      startRun: async () => ({ ok: true as const, runId: "run-just-started" }),
      outcome: async () => ({ status: "running", done: false }),
      cancel: async (id: string) => void cancels.push(id),
    };
    const out = await startBuildForItem(haltedBefore("now() AS db_now, halted_at", wi), a.accountId, wi, randomUUID(), ports as never, {});
    expect(out).toEqual({ status: "refused", reason: "item_halted" });
    expect(cancels).toEqual(["run-just-started"]);
    expect((await marker(wi)).stage).toBe("spec_ready");
  });

  it("6: Check the build finding the pull request while a halt lands records nothing: unchanged item_halted, the stage stays in_progress", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "in_progress");
    const { registry: reg } = registry();
    const t = advance(starter(a).starter, reg, {}, haltedBefore("now() AS db_now, halted_at", wi));
    expect(await t.module.advancePrFound(whoOf(a, wi, 0), 12)).toEqual({ status: "unchanged", reason: "item_halted", stage: "in_progress" });
    expect((await marker(wi)).stage).toBe("in_progress");
    expect((await admin.query("SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'pr_opened'", [wi])).rows[0].n).toBe(0);
  });

  // ---- criterion 6 (worker half), the database's refusal as the last line ----------------------------------------

  /** The halt's own marker write, as the real performer makes it, committed on its own connection. */
  const markHalted = (workItemId: string) =>
    admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1 AND halted_at IS NULL", [workItemId, randomUUID()]);

  it("2: a halt that commits after advanceStartRun's guard but before the run's insert is refused by the database: item_halted, no run and no claim", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "pr_opened");
    const { registry: reg } = registry();
    const inner = starter(a);
    // The guard has read an unhalted item and the seat is resolved; the halt lands, then the real insert runs the trigger.
    const s: RunStarter = { start: async (input) => (await markHalted(wi), inner.starter.start(input)) };
    const before = await runCount(wi);
    expect(await advance(s, reg).module.advanceStartRun(startReq(a, wi, "review:late"))).toEqual({ ok: false, reason: "item_halted" });
    expect(inner.started).toEqual([]);
    expect(await runCount(wi)).toBe(before);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [a.accountId, `advance:${wi}:review:late`])).rows[0].n).toBe(0);
  });

  it("6: a halt that commits after advanceStartFix's stage write but before the resume's insert ends item_halted, not resume_failed; no run starts", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "review_passed");
    const { registry: reg } = registry();
    const executor = await liveRun(a, wi, "executor");
    await admin.query("UPDATE agent_runs SET status = 'succeeded', cc_session_id = 's1' WHERE id = $1", [executor]);
    const before = await runCount(wi);
    let resumed = 0;
    // The resume's create is a real insert (so the real trigger and the real error mapping), made after the halt commits.
    const review = {
      resume: async () => {
        resumed++;
        await markHalted(wi);
        const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId: wi, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId });
        return { id, status: "pending" };
      },
    };
    const t = advance(starter(a).starter, reg, { review: review as never });
    const fix = await t.module.advanceStartFix(whoOf(a, wi, 0), { actionId: randomUUID(), failingRunId: randomUUID(), issue: 7, headSha: "a".repeat(40), prompt: "fix", round: 1, reviewer: "code" });
    expect(resumed).toBe(1);
    expect(fix).toEqual({ ok: false, reason: "item_halted" });
    expect((await marker(wi)).halted_at).not.toBeNull();
    expect(await runCount(wi)).toBe(before);
  });

  // ---- criterion 7: the epoch fence ----------------------------------------------------------------------------

  it("7: after halt and resume, a step under the previous epoch is refused halted_since_approval and the current epoch passes", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "in_progress");
    const { registry: reg } = registry();
    await liveRun(a, wi);
    await halt(a, wi, reg);
    const s = starter(a);
    const t = advance(s.starter, reg);
    expect((await t.module.performAdvanceWorkItem(await request(a, "advance_work_item", wi))).result).toBe("done");
    const epoch = t.args[0]!.haltEpoch;
    expect(epoch).toBe(1);
    const old = epoch - 1;

    expect(await t.module.advanceStartRun(startReq(a, wi, "classify:old", old))).toEqual({ ok: false, reason: "halted_since_approval" });
    expect(await t.module.advanceRecordRound(whoOf(a, wi, old), { headSha: "a".repeat(40), prNumber: 1, requiredRoles: ["code-reviewer"], verdicts: [] } as never)).toMatchObject({ decision: "refused", reason: "halted_since_approval" });
    expect(await t.module.advanceStartFix(whoOf(a, wi, old), { actionId: randomUUID(), failingRunId: randomUUID(), issue: 7, headSha: "a".repeat(40), prompt: "fix", round: 1, reviewer: "code" })).toEqual({ ok: false, reason: "halted_since_approval" });
    expect(s.calls).toEqual([]);
    // The current epoch passes the fence and starts.
    expect((await t.module.advanceStartRun(startReq(a, wi, "classify:new", epoch))).ok).toBe(true);
  });

  // ---- criterion 8: halting at stages with no edge to needs_human ----------------------------------------------

  it.each(["triaged", "discussing", "spec_ready"])("8: a halt at %s keeps the stage, bumps the epoch, and every start and step is refused", async (stage) => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, stage);
    const { registry: reg } = registry();
    const h = await halt(a, wi, reg);
    expect(h.out).toMatchObject({ result: "done", outcome: { stage: "unchanged", halted: true } });
    expect(await marker(wi)).toMatchObject({ stage, halt_epoch: 1 });
    const s = starter(a);
    const t = advance(s.starter, reg);
    // classify, light-spec and the first build start through advanceStartRun
    for (const [step, role] of [["classify:z", "project-manager"], ["light-spec:z", "project-manager"], ["build:v1:z", "executor"]] as const) {
      expect(await t.module.advanceStartRun({ ...startReq(a, wi, step, 1), role })).toEqual({ ok: false, reason: "item_halted" });
    }
    // the panel, the Spec writer and the build step are refused by the step guard
    expect(await t.module.advancePanel(whoOf(a, wi, 1))).toMatchObject({ status: "refused", reason: "item_halted" });
    expect(await t.module.advanceSpec(whoOf(a, wi, 1))).toMatchObject({ status: "refused", reason: "item_halted" });
    expect(await t.module.advanceBuild(whoOf(a, wi, 1), randomUUID(), 1)).toMatchObject({ status: "refused", reason: "item_halted" });
    expect(s.calls).toEqual([]);
    expect(reached).toEqual([]);
    expect(await runCount(wi)).toBe(0);
  });

  // ---- criterion 10 (worker half): Back to discussion, then Approve, clears -----------------------------------

  it("10: Back to discussion is a person's move on a halted item; its approval, requested after the halt, clears the marker", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "in_progress");
    const { registry: reg } = registry();
    await liveRun(a, wi);
    await halt(a, wi, reg);
    expect((await marker(wi)).stage).toBe("needs_human");
    await sendBackToDiscussion({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId, role: "owner" } }, wi);
    expect(await marker(wi)).toMatchObject({ stage: "discussing" });
    expect((await marker(wi)).halted_at).not.toBeNull();
    const t = advance(starter(a).starter, reg);
    expect((await t.module.performAdvanceWorkItem(await request(a, "advance_work_item", wi))).result).toBe("done");
    expect((await marker(wi)).halted_at).toBeNull();
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

  it("ports: the step's start port carries the workflow's epoch (a start under another epoch is refused through it)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await item(a, "spec_ready");
    const { registry: reg } = registry();
    let ports: AdvanceStepPorts | undefined;
    const t = advance(starter(a).starter, reg, { build: (async (_p: Pool, ..._rest: unknown[]) => {
      ports = _rest.find((r) => typeof r === "object" && r !== null && "startRun" in r) as AdvanceStepPorts;
      return { status: "started", runId: "r" };
    }) as never });
    await t.module.advanceBuild(whoOf(a, wi, 0), randomUUID());
    await admin.query("UPDATE work_items SET halt_epoch = 3 WHERE id = $1", [wi]);
    expect(await ports!.startRun({ step: "build:v1:x", role: "executor", prompt: "p" })).toEqual({ ok: false, reason: "halted_since_approval" });
  });
});
