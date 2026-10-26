import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { recordStage, startAgentRun, writeRunStatus, type ExecutionTargetRegistry } from "@fx/runner";
import { continueAfterLimit, runActionSteps, type RunActionsWorker } from "@fx/pipeline";
import { createFakeExecutionTarget } from "../../pipeline/test/build/helpers/fakeExecutionTarget.js";
import { createSeatResolver, type SeatRequest, type SeatResult } from "../src/seat.js";
import { createRunActionFacade, type PerformResult } from "../src/runActions.js";
import { CONTINUE_FIXED_CODES, createContinueModule, ContinueBusyError } from "../src/continueAction.js";
import type { AdvanceStartArgs } from "../src/advance.js";

/**
 * [pg] D#2 H14c-3-3b-4 (C88 section 3 / 3b-4, C89): the `continue_work_item` performer against the real definers, real Postgres, the real library and the real seat
 * resolver. The only stand-ins are the execution target (records the calls) and the workflow starter.
 */
describe("continue_work_item performer [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let resolve: (r: SeatRequest) => Promise<SeatResult>;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    resolve = createSeatResolver({ pool: writerPool });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  const MANUAL_HASH = createHash("sha256").update("continue:manual").digest("hex");
  const seen: string[] = [];

  /** A team account whose owner can request, an item on an executor build, and the target that records what runs. */
  async function world() {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = 480 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE work_items SET gh_number = 7 WHERE id = $1", [a.workItemId]);
    await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    // The seed gives the item a run of its own; these tests count the runs they make.
    await admin.query("DELETE FROM agent_runs WHERE work_item_id = $1", [a.workItemId]);
    const fake = createFakeExecutionTarget();
    const registry: ExecutionTargetRegistry = { sandbox: fake.target };
    const advances: AdvanceStartArgs[] = [];
    const startAdvance = vi.fn(async (args: AdvanceStartArgs) => void advances.push(args));
    const module = createContinueModule(writerPool, registry, { resolveRunSeat: resolve, startAdvance });
    await toStage(a, "spec_ready");
    await toStage(a, "in_progress");
    return { a, fake, registry, advances, module };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const toStage = (a: SeedRefs, stage: "spec_ready" | "in_progress" | "closed" | "merged") =>
    withTenant(writerPool, a.accountId, (c) => recordStage(c, { workItemId: a.workItemId, toStage: stage, at: new Date(), source: "control_plane", sourceRef: `t-${randomUUID()}` }));

  /** An executor run that ended at a limit with the owned session, as the sandbox target leaves it. */
  async function ended(w: W, o: { status?: "timed_out" | "killed_spend"; abortReason?: "per_run_cap" | "monthly_budget"; checkpoint?: boolean; role?: string } = {}): Promise<string> {
    const r = await resolve({ accountId: w.a.accountId, role: o.role ?? "executor", workItemId: w.a.workItemId });
    if (!r.ok) throw new Error(`seat refused: ${r.reason}`);
    const started = await startAgentRun(writerPool, w.registry, { ...r.seat, accountId: w.a.accountId, repoId: w.a.repoId, workItemId: w.a.workItemId, role: o.role ?? "executor", product: "team", pr: 7, prompt: "implement" });
    if (started.status !== "running") throw new Error("test setup: not running");
    const status = o.status ?? "timed_out";
    await writeRunStatus(writerPool, {
      accountId: w.a.accountId, runId: started.id, from: "running", to: status, result: { sessionId: "cc-owned" },
      ...(status === "killed_spend" ? { abortReason: o.abortReason ?? "per_run_cap" } : {}),
      ...(o.checkpoint === false ? {} : { checkpoint: { kind: status === "killed_spend" ? "per_run_usd" : "run_time", ccSessionId: "cc-forged", meteredUsd: 1, extensionsUsed: 0 } }),
    });
    return started.id;
  }
  /** The real park: the automatic path with `auto_resume` off (or the ceiling / a monthly kill) writes the item's needs_human move and its reason. */
  async function parked(w: W, o: Parameters<typeof ended>[1] = {}, autoResume = false): Promise<string> {
    if (!autoResume) await admin.query("INSERT INTO run_limits (account_id, role, auto_resume) VALUES ($1, '*', false) ON CONFLICT DO NOTHING", [w.a.accountId]);
    const id = await ended(w, o);
    const out = await continueAfterLimit(writerPool, w.registry, { accountId: w.a.accountId, runId: id, resumeInput: {} as never });
    expect(out.outcome).toBe("parked");
    return id;
  }
  /** A park by the book without a run behind it (the item's needs_human move and the reason the park event carries). */
  async function parkRaw(w: W, reason: string) {
    await withTenant(writerPool, w.a.accountId, (c) => recordStage(c, { workItemId: w.a.workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: `raw-${randomUUID()}` }));
    await admin.query("INSERT INTO domain_events (account_id, type, subject_id, payload) VALUES ($1, 'work_item.needs_human', $2, $3)", [w.a.accountId, w.a.workItemId, JSON.stringify({ reason })]);
  }
  const open = new Map<string, string>();
  async function request(w: W, kind = "continue_work_item", target = w.a.workItemId, userId = w.a.userId): Promise<string> {
    // The definer hands back the open request of the same kind and target, so an earlier one is settled first (as the workflow would).
    const prior = open.get(`${w.a.accountId}:${kind}`);
    if (prior) await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).settleRunAction(prior, { state: "refused", errorCode: "test_done" });
    const row = await withTenant(appPool, w.a.accountId, userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request($1, $2, NULL, $3)", [kind, target, randomUUID().replace(/-/g, "").repeat(2)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(row.action_id, 600)).not.toBeNull();
    open.set(`${w.a.accountId}:${kind}`, row.action_id);
    return row.action_id;
  }
  const refusedWith = async (p: Promise<PerformResult>, code: string) => {
    const out = await p;
    expect(out).toEqual({ result: "refused", errorCode: code });
    seen.push(code);
  };
  const n = async (sql: string, ...args: unknown[]) => Number((await admin.query(`SELECT count(*) AS n FROM ${sql}`, args)).rows[0].n);
  const runs = (w: W) => n("agent_runs WHERE account_id = $1 AND work_item_id = $2", w.a.accountId, w.a.workItemId);
  const reservations = (w: W) => n("spend_reservations WHERE account_id = $1", w.a.accountId);
  const stageOf = async (w: W) => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [w.a.workItemId])).rows[0].stage as string;
  const moves = (w: W) => n("work_item_transitions WHERE account_id = $1 AND work_item_id = $2 AND source_ref LIKE 'continue:%'", w.a.accountId, w.a.workItemId);
  /** Nothing was started, reserved or moved. */
  async function untouched(w: W, before: { runs: number; reservations: number }) {
    expect(await runs(w)).toBe(before.runs);
    expect(await reservations(w)).toBe(before.reservations);
    expect(await moves(w)).toBe(0);
    expect(w.advances).toEqual([]);
  }

  it("starts one run from the parked run's own session, moves the item back to In progress and follows the run", async () => {
    const w = await world();
    const endedId = await parked(w);
    expect(await stageOf(w)).toBe("needs_human");
    const id = await request(w);
    const out = await w.module.performContinueWorkItem(id);
    expect(out).toMatchObject({ result: "done", outcome: { run_id: expect.any(String) } });
    const runId = (out as unknown as { outcome: { run_id: string } }).outcome.run_id;
    expect((await admin.query("SELECT parent_run_id, role, status FROM agent_runs WHERE id = $1", [runId])).rows[0]).toEqual({ parent_run_id: endedId, role: "executor", status: "running" });
    expect(w.fake.calls.filter((c) => c.method === "resume")).toMatchObject([{ sessionId: "cc-owned", run: { parentRunId: endedId } }]);
    expect((await admin.query("SELECT k.idempotency_key, k.request_hash FROM agent_run_idempotency_keys k WHERE k.run_id = $1", [runId])).rows[0]).toEqual({ idempotency_key: `${endedId}:manual-continue:${id}`, request_hash: MANUAL_HASH });
    expect(await stageOf(w)).toBe("in_progress");
    expect((await admin.query("SELECT source, source_ref FROM work_item_transitions WHERE account_id = $1 AND source_ref LIKE 'continue:%'", [w.a.accountId])).rows).toEqual([{ source: "control_plane", source_ref: `continue:${id}` }]);
    expect(w.advances).toEqual([{ accountId: w.a.accountId, userId: w.a.userId, workItemId: w.a.workItemId, actionId: id, haltEpoch: 0, specVersion: null, resumeRunId: runId }]);
  });

  it("a double click or a replay never starts two runs: the same request answers with the first run, one resume, one stage move", async () => {
    const w = await world();
    await parked(w);
    const id = await request(w);
    const first = await w.module.performContinueWorkItem(id);
    const reservedBefore = await reservations(w);
    const again = await w.module.performContinueWorkItem(id);
    expect(again).toEqual(first);
    expect(await runs(w)).toBe(2);
    expect(w.fake.calls.filter((c) => c.method === "resume")).toHaveLength(1);
    expect(await moves(w)).toBe(1);
    expect(await reservations(w)).toBe(reservedBefore);
  });

  it("two performers at once start one run (the item lock and the request's key): every answer that comes back names that run", async () => {
    const w = await world();
    await parked(w);
    const id = await request(w);
    const settled = await Promise.allSettled([w.module.performContinueWorkItem(id), w.module.performContinueWorkItem(id), w.module.performContinueWorkItem(id)]);
    expect(await runs(w)).toBe(2);
    expect(w.fake.calls.filter((c) => c.method === "resume")).toHaveLength(1);
    const ids = new Set(settled.flatMap((s) => (s.status === "fulfilled" && s.value.result === "done" ? [s.value.outcome.run_id] : [])));
    expect(ids.size).toBe(1);
    for (const s of settled) if (s.status === "rejected") expect(s.reason).toBeInstanceOf(ContinueBusyError);
  });

  it("two requests on one parked run: the second is a new request after the first, so the first run is live and the second is not continuable", async () => {
    const w = await world();
    await parked(w);
    const first = await w.module.performContinueWorkItem(await request(w));
    expect(first.result).toBe("done");
    await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable");
    expect(await runs(w)).toBe(2);
  });

  describe("who: re-checked at perform time", () => {
    it("a member who is not an owner or admin is refused, whatever the request definer allowed: no run, reservation, stage move or workflow", async () => {
      const w = await world();
      await parked(w);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [w.a.accountId, w.a.userId]);
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "principal_not_authorised");
      await untouched(w, before);
    });

    it("an owner demoted AFTER the request was filed is refused; an admin is allowed", async () => {
      const w = await world();
      await parked(w);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      const id = await request(w);
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [w.a.accountId, w.a.userId]);
      await refusedWith(w.module.performContinueWorkItem(id), "principal_not_authorised");
      await untouched(w, before);
      await admin.query("UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2", [w.a.accountId, w.a.userId]);
      expect((await w.module.performContinueWorkItem(id)).result).toBe("done");
    });

    it("a member removed since the request is refused (the definer answers not allowed)", async () => {
      const w = await world();
      await parked(w);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      const id = await request(w);
      await admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [w.a.accountId, w.a.userId]);
      await refusedWith(w.module.performContinueWorkItem(id), "principal_not_authorised");
      await untouched(w, before);
    });

    it("another kind of request is kind_mismatch; a request with no live lease is a database refusal, never a start", async () => {
      const w = await world();
      await parked(w);
      await refusedWith(w.module.performContinueWorkItem(await request(w, "cancel_work_item")), "kind_mismatch");
      const id = await request(w);
      await admin.query("UPDATE run_action_requests SET claimed_until = now() - interval '1 minute' WHERE id = $1", [id]);
      await expect(w.module.performContinueWorkItem(id)).rejects.toMatchObject({ name: "RunActionRefusedError" });
      expect(await runs(w)).toBe(1);
      await expect(w.module.performContinueWorkItem("not-a-uuid")).rejects.toMatchObject({ name: "RunActionInputError" });
    });

    it("an item that is gone by perform time is target_not_found (the lookup is tenant-scoped), and nothing starts", async () => {
      const w = await world();
      await parked(w);
      const id = await request(w);
      await admin.query("DELETE FROM work_items WHERE id = $1", [w.a.workItemId]);
      await refusedWith(w.module.performContinueWorkItem(id), "target_not_found");
      expect(w.advances).toEqual([]);
    });

    it("a leased row whose target is another tenant's item never reaches it: target_not_found, and the other item and its runs are untouched", async () => {
      const w = await world();
      const other = await world();
      await parked(other);
      const otherRuns = await runs(other);
      const forged = randomUUID();
      await admin.query(
        "INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash) VALUES ($1, $2, 'continue_work_item', $3, $4, 'session', NULL, $5)",
        [forged, w.a.accountId, other.a.workItemId, `session:${w.a.userId}`, "f".repeat(64)],
      );
      expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(forged, 600)).not.toBeNull();
      await refusedWith(w.module.performContinueWorkItem(forged), "target_not_found");
      expect(await runs(other)).toBe(otherRuns);
      expect(await stageOf(other)).toBe("needs_human");
      expect(w.advances).toEqual([]);
      expect(other.advances).toEqual([]);
    });

    it("the account is the leased row's: a request filed in another account never reaches this account's item", async () => {
      const w = await world();
      const other = await world();
      await parked(w);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      // The definer refuses a foreign target at the request; the performer would also see no such item under the other tenant.
      await expect(request(other, "continue_work_item", w.a.workItemId)).rejects.toMatchObject({ code: "P0002" });
      await admin.query("DELETE FROM agent_runs WHERE work_item_id = $1", [other.a.workItemId]);
      await untouched(w, before);
    });
  });

  describe("fail closed", () => {
    it("a closed item is work_item_closed and nothing starts or moves", async () => {
      const w = await world();
      await parked(w);
      await toStage(w.a, "closed");
      const before = { runs: await runs(w), reservations: await reservations(w) };
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "work_item_closed");
      await untouched(w, before);
      expect(await stageOf(w)).toBe("closed");
    });

    it("a halted item is work_item_halted", async () => {
      const w = await world();
      await parked(w);
      await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [w.a.workItemId, randomUUID()]);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "work_item_halted");
      await untouched(w, before);
    });

    it("an item that is not parked by a run limit is not continuable: still In progress, parked for another reason, or no park on record", async () => {
      const w = await world();
      await ended(w); // In progress, the latest run timed out, but nothing parked it
      const before = { runs: await runs(w), reservations: await reservations(w) };
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable");
      await withTenant(writerPool, w.a.accountId, (c) => recordStage(c, { workItemId: w.a.workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: "other-park" }));
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable"); // needs_human, but no park reason on record
      for (const reason of ["fix_rounds_used", "check_rounds_used", "run_limit_reached_x", ""]) {
        await admin.query("INSERT INTO domain_events (account_id, type, subject_id, payload) VALUES ($1, 'work_item.needs_human', $2, $3)", [w.a.accountId, w.a.workItemId, JSON.stringify({ reason })]);
        await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable");
      }
      await untouched(w, before);
      expect(await stageOf(w)).toBe("needs_human");
    });

    it("the latest run decides: a seat's run, a run that did not end at a limit, and an item with no run are not continuable", async () => {
      const w = await world();
      await parked(w);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      // A reviewer that ended at a limit WITH a checkpoint: continuable by the advance workflow's own wait, never by this performer.
      const reviewer = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, backend) VALUES ($1, $2, $3, 'code-reviewer', 'production', 'timed_out', 'sandbox', $4, 'claude')", [reviewer, w.a.accountId, w.a.workItemId, w.a.repoId]);
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'checkpoint', $3)", [w.a.accountId, reviewer, JSON.stringify({ reason: "limit", kind: "run_time", extensions_used: 0 })]);
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable");
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, backend) VALUES ($1, $2, $3, 'executor', 'production', 'failed', 'sandbox', $4, 'claude')", [randomUUID(), w.a.accountId, w.a.workItemId, w.a.repoId]);
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable");
      await admin.query("DELETE FROM agent_runs WHERE work_item_id = $1", [w.a.workItemId]);
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable");
      expect(await runs(w)).toBe(0);
      expect(before.runs).toBe(1);
      expect(await moves(w)).toBe(0);
    });

    it("a run that ended without a checkpoint is not continued (the library's gate), and a killed_spend with no recorded cause is refused spend", async () => {
      const w = await world();
      await ended(w, { checkpoint: false });
      await parkRaw(w, "run_limit_reached");
      const before = { runs: await runs(w), reservations: await reservations(w) };
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "not_continuable");
      await untouched(w, before);
      const legacy = await world();
      await ended(legacy, { status: "killed_spend" });
      await parkRaw(legacy, "run_limit_reached");
      await admin.query("UPDATE run_events SET payload = payload - 'abortReason' WHERE account_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'killed_spend'", [legacy.a.accountId]);
      await refusedWith(legacy.module.performContinueWorkItem(await request(legacy)), "spend");
      expect(await runs(legacy)).toBe(1);
    });

    it("the ceiling is counted from stored runs: ten earlier continuations refuse work_item_ceiling, and the ninth does not", async () => {
      const w = await world();
      const addContinuations = async (x: W, count: number) => {
        // An earlier run of the item, and `count` stored continuations of it (each with the manual hash, as the library stamps them).
        const prior = randomUUID();
        await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, backend, created_at) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox', $4, 'claude', now() - interval '2 hours')", [prior, x.a.accountId, x.a.workItemId, x.a.repoId]);
        for (let i = 0; i < count; i++) {
          const id = randomUUID();
          await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, backend, parent_run_id, created_at) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox', $4, 'claude', $5, now() - interval '1 hour')", [id, x.a.accountId, x.a.workItemId, x.a.repoId, prior]);
          await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [x.a.accountId, `old-${id}`, id, MANUAL_HASH]);
        }
      };
      await parked(w);
      await addContinuations(w, 10);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "work_item_ceiling");
      await untouched(w, before);
      const nine = await world();
      await parked(nine);
      await addContinuations(nine, 9);
      expect((await nine.module.performContinueWorkItem(await request(nine))).result).toBe("done");
    });

    it("a seat refusal keeps its own word and starts nothing", async () => {
      const w = await world();
      await parked(w);
      const before = { runs: await runs(w), reservations: await reservations(w) };
      await admin.query("UPDATE accounts SET model_budget_usd_month = 0 WHERE id = $1", [w.a.accountId]);
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "model_budget_unset");
      await untouched(w, before);
    });
  });

  describe("spend", () => {
    it("a monthly-budget kill parks monthly_budget_reached and a manual Continue works once the budget allows; the spend refusal parks and starts no run", async () => {
      const w = await world();
      await parked(w, { status: "killed_spend", abortReason: "monthly_budget", checkpoint: false });
      expect((await admin.query("SELECT payload->>'reason' AS r FROM domain_events WHERE account_id = $1 AND type = 'work_item.needs_human' ORDER BY seq DESC LIMIT 1", [w.a.accountId])).rows[0].r).toBe("monthly_budget_reached");
      // While the budget still refuses, the answer is the budget's own code and the item stays parked.
      w.fake.admitResult = { admitted: false, reason: "monthly" } as never;
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "monthly_budget_reached");
      expect(await stageOf(w)).toBe("needs_human");
      w.fake.admitResult = { admitted: true };
      const out = await w.module.performContinueWorkItem(await request(w));
      expect(out.result).toBe("done");
      expect(await stageOf(w)).toBe("in_progress");
    });

    it("a manual Continue after an automatic attempt the spend gate refused starts a run (its key is its own); two request ids on one run each get their own decision", async () => {
      const w = await world();
      const endedId = await ended(w);
      w.fake.admitResult = { admitted: false, reason: "cap" } as never;
      const auto = await continueAfterLimit(writerPool, w.registry, { accountId: w.a.accountId, runId: endedId, resumeInput: { ...(await resolve({ accountId: w.a.accountId, role: "executor", workItemId: w.a.workItemId }) as { seat: object }).seat, repoId: w.a.repoId, product: "team", pr: 7, prompt: "p" } as never });
      expect(auto).toMatchObject({ outcome: "parked", reason: "run_limit_reached", refusedBy: "spend" });
      // The first click meets the same refusal; the second request, after the budget is raised, is a real attempt and starts one run.
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "spend");
      expect(await stageOf(w)).toBe("needs_human");
      w.fake.admitResult = { admitted: true };
      const out = await w.module.performContinueWorkItem(await request(w));
      expect(out).toMatchObject({ result: "done" });
      expect((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE parent_run_id = $1 AND status <> 'refused_spend'", [endedId])).rows[0].n).toBe("1");
      expect(await stageOf(w)).toBe("in_progress");
    });

    it("a start the spend gate denies is refused with its code, leaves no live run and moves nothing", async () => {
      const w = await world();
      await parked(w);
      w.fake.admitResult = { admitted: false, reason: "cap" } as never;
      await refusedWith(w.module.performContinueWorkItem(await request(w)), "spend");
      expect((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND status NOT IN ('refused_spend', 'timed_out')", [w.a.workItemId])).rows[0].n).toBe("0");
      expect(await stageOf(w)).toBe("needs_human");
      expect(await moves(w)).toBe(0);
      expect(w.advances).toEqual([]);
    });
  });

  describe("busy", () => {
    it("is retried by the run-action workflow with backoff and, at the fifth attempt, settles failed busy; nothing is started meanwhile", async () => {
      const w = await world();
      await parked(w);
      const id = await request(w);
      const facade = createRunActionFacade(writerPool, {} as ExecutionTargetRegistry);
      // Another caller holds the item's decision lock (the library's advisory key).
      const holder = await adminPool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`continue_work_item:${w.a.accountId}:${w.a.workItemId}`]);
      try {
        const port = { ...facade, performContinueWorkItem: w.module.performContinueWorkItem } as unknown as RunActionsWorker;
        const state = async () => (await admin.query("SELECT state, error_code, attempts FROM run_action_requests WHERE id = $1", [id])).rows[0];
        // The request is already claimed (attempt 1): hand it back as the workflow does, then claim it for each further attempt.
        await admin.query("UPDATE run_action_requests SET state = 'accepted', claimed_until = NULL, attempts = 0 WHERE id = $1", [id]);
        for (let attempt = 1; attempt <= 5; attempt++) {
          await admin.query("UPDATE run_action_requests SET not_before = now() WHERE id = $1", [id]);
          await runActionSteps(port, id);
          // A retry is stored without a code; the settle that gives up (the fifth attempt) writes the failure with the performer's code.
          expect(await state()).toMatchObject(attempt < 5 ? { state: "accepted", error_code: null, attempts: attempt } : { state: "failed", error_code: "busy", attempts: 5 });
        }
        expect(await runs(w)).toBe(1);
        expect(await moves(w)).toBe(0);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      seen.push("busy");
    });
  });

  it("every code the performer settled with in this file is in the fixed list, none a platform-budget code", () => {
    // A seat refusal keeps the resolver's own word (model_budget_unset here); busy is the retried one. Nothing else may appear.
    const allowed = new Set<string>([...CONTINUE_FIXED_CODES, "model_budget_unset", "busy"]);
    expect(seen.filter((c) => !allowed.has(c))).toEqual([]);
    expect(CONTINUE_FIXED_CODES.filter((c) => /platform|hosting|our_/.test(c))).toEqual([]);
    expect(seen).toEqual(expect.arrayContaining(["principal_not_authorised", "kind_mismatch", "target_not_found", "work_item_closed", "work_item_halted", "not_continuable", "work_item_ceiling", "spend", "model_budget_unset", "busy"]));
  });
});
