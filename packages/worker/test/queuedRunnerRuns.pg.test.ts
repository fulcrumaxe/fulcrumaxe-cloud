import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgentRun, RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, writeRunStatus, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { resumeAgentRun } from "../../pipeline/src/build/resumeAgentRun.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceRunRequest } from "../src/advance.js";
import { createRetryModule, type RetrySeatSource } from "../src/retry.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../src/runnerDone.js";
import type { SeatResult } from "../src/seat.js";
import { WATCHDOG_MARGIN_MS, createRunStarter, type FollowArgs } from "../src/starter.js";

/**
 * D#6 C29 (R3c-1) [pg]: a run the runner target queued is accepted where the caller polls the run's status (the advance
 * module's starts and fix round, retry), and refused where it cannot be waited for. The runner chain is the real one:
 * `RunnerTarget` over the real job issuer, signer and `agent_run_set_runner_job`; the claim and `done` go through the real
 * facades. Only the repository's visibility and the commit base of a continuation are stand-ins.
 */
describe("queued runner runs [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const { privateKey } = generateKeyPairSync("ed25519");

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

  let infoLines: Array<Record<string, unknown>>;
  beforeEach(() => {
    infoLines = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      try {
        infoLines.push(JSON.parse(String(line)));
      } catch {
        // fx-swallow-ok: a test spy; a line that is not JSON is not one of the structured lines under test
      }
    });
  });
  afterEach(() => vi.restoreAllMocks());

  // ---- the world -------------------------------------------------------------------------------

  const visibility = { visibility: async () => "private" as const };
  function chain() {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => "a".repeat(40) } });
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }),
    };
    return { registry, harness };
  }
  const SEAT_OK = {
    repoId: "unused",
    product: "team",
    roleCard: "card",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
    limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
    timeoutMs: 40 * 60_000,
    maxExtensions: 3,
  };
  const SEAT: SeatResult = { ok: true, seat: SEAT_OK as never };

  let nextNumber = 9000;
  /** An account whose repo runs in `mode`, with a work item at `stage` that has an issue number. */
  async function world(mode: "runner_local" | "sandbox", stage = "triaged") {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId, mode]);
    const workItemId = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', $4, $5)", [workItemId, a.accountId, a.repoId, stage, nextNumber++]);
    return { a, workItemId };
  }
  const row = async (id: string) => (await admin.query("SELECT status, runtime, job_signed, lease_generation FROM agent_runs WHERE id = $1", [id])).rows[0];
  const statusEvents = async (id: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [id])).rows.map((r) => r.payload as Record<string, unknown>);
  const queuedLines = () => infoLines.filter((l) => l.event === "run.queued");
  const classifyReq = (a: SeedRefs, workItemId: string, step = "classify:abc"): AdvanceRunRequest => ({ accountId: a.accountId, workItemId, haltEpoch: 0, step, role: "project-manager", prompt: "classify this issue" });

  /** The advance module over the PRODUCTION starter in the "accept" policy, as compositionRoot builds it. */
  function advanceOver(registry: ExecutionTargetRegistry, follow: (args: FollowArgs) => Promise<void>, over: Partial<AdvanceModuleDeps> = {}) {
    const starter = createRunStarter({ pool: writerPool, registry, follow, queued: "accept" });
    return createAdvanceModule(writerPool, { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, ...over });
  }

  // ---- 1, 2: classify on a runner repo -----------------------------------------------------------

  it("1: the advance starter on a runner_local repo leaves the classify run pending: no cancel, no follower, one run.queued line with ids only", async () => {
    const { a, workItemId } = await world("runner_local");
    const { registry } = chain();
    const follow = vi.fn(async () => undefined);
    const out = await advanceOver(registry, follow).advanceStartRun(classifyReq(a, workItemId));
    expect(out).toEqual({ ok: true, runId: expect.any(String) });
    const runId = (out as { runId: string }).runId;
    expect(await row(runId)).toMatchObject({ status: "pending", runtime: "runner" });
    // The run holds a real signed job, so a runner can claim it.
    expect(((await row(runId)).job_signed as { job: { run_id: string } }).job.run_id).toBe(runId);
    expect((await statusEvents(runId)).filter((p) => p.to === "cancelled")).toEqual([]);
    expect(await statusEvents(runId)).toEqual([]);
    expect(follow).toHaveBeenCalledTimes(0);
    expect(queuedLines()).toEqual([{ event: "run.queued", run_id: runId, account_id: a.accountId }]);
    // A replay of the same step returns the same run and starts nothing.
    expect(await advanceOver(registry, follow).advanceStartRun(classifyReq(a, workItemId))).toEqual({ ok: true, runId });
    expect(follow).toHaveBeenCalledTimes(0);
  });

  it("2: the queued run is claimed, finished by done with a category word and no commit, and the workflow's status read sees it end", async () => {
    const { a, workItemId } = await world("runner_local");
    const { registry } = chain();
    const m = advanceOver(registry, async () => undefined);
    const started = await m.advanceStartRun(classifyReq(a, workItemId));
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const runId = started.runId;

    // Pending, and read as queued on a runner (the poll credits it).
    expect(await m.advanceRunOutcome(a.accountId, runId)).toMatchObject({ status: "pending", done: false, runtime: "runner" });

    const runnerId = await insertRunner(admin, a.accountId, a.userId, { credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerId, [a.repoId]]);
    const claims = createRunnerClaimFacade(writerPool, { visibility, randomBetween: (min) => min });
    const claimed = await claims.claimRunnerRun({ accountId: a.accountId, runnerId });
    if (claimed.kind !== "claimed") throw new Error("nothing to claim");
    expect(claimed.runId).toBe(runId);
    expect(await row(runId)).toMatchObject({ status: "running", lease_generation: claimed.leaseGeneration });

    const done = createRunnerDoneFacade(writerPool);
    const lease = { accountId: a.accountId, runnerId, runId, leaseGeneration: claimed.leaseGeneration };
    expect(await done.beginRunnerDone(lease)).toEqual({ kind: "proceed" });
    const verdict = { outcome: "succeeded" as const, failureReason: null, prNumber: null };
    expect(await done.finishRunnerDone({ ...lease, verdict, sessionId: "7f0c1d2e-aaaa-bbbb", agentOutput: { category: "bug", summary: "a bug" } })).toEqual({ kind: "recorded", verdict });

    expect(await row(runId)).toMatchObject({ status: "succeeded" });
    const outcome = await m.advanceRunOutcome(a.accountId, runId);
    expect(outcome).toMatchObject({ status: "succeeded", done: true, runtime: "runner", tailRunId: runId });
    // The envelope the workflow's category read looks at (categoryOf in apps/web reads this key).
    expect(outcome.envelope).toMatchObject({ category: "bug" });
  });

  // ---- 5: the fix round -----------------------------------------------------------------------------

  it("5: a fix round on a runner_local repo is accepted: it returns the run, which stays pending with a job that continues the build's branch and session", async () => {
    const { a, workItemId } = await world("runner_local", "pr_opened");
    const { registry } = chain();
    const issue = Number((await admin.query("SELECT gh_number FROM work_items WHERE id = $1", [workItemId])).rows[0].gh_number);
    // The build's executor run: ended through `done` on its run branch, holding a session.
    const BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
    // D#6 R4d-5c (C36): a build made after the pin carries its Spec version, which the fix round inherits; a runner fix round of an unpinned build is refused.
    const specVersionId = randomUUID();
    // The job names the Spec's discussion, so the item has one.
    await admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [a.accountId, a.repoId, workItemId]);
    await admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [a.accountId, workItemId]);
    await admin.query("INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [specVersionId, a.accountId, workItemId]);
    const { id: parent } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, specVersionId, role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: a.repoId, dispatchPrNumber: issue });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: parent, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: parent, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { summary: "built" } }, runnerDone: { prNumber: 41, branch: BRANCH } });

    const review = { load: vi.fn(), recordRound: vi.fn(), mergeGate: vi.fn(), resume: resumeAgentRun } as never;
    const m = advanceOver(registry, async () => undefined, { review });
    const HEAD = "b".repeat(40);
    const out = await m.advanceStartFix({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 }, { issue, headSha: HEAD, prompt: "fix the failing test", round: 1, actionId: randomUUID(), reviewer: "code", failingRunId: randomUUID() });
    if (!out.ok) throw new Error(`fix refused: ${out.reason}`);

    expect(await row(out.runId)).toMatchObject({ status: "pending", runtime: "runner" });
    expect(await statusEvents(out.runId)).toEqual([]);
    const job = ((await row(out.runId)).job_signed as { job: { task: { kind: string }; continues: unknown } }).job;
    expect(job.task.kind).toBe("fix");
    expect(job.continues).toEqual({ parent_run_id: parent, session_id: "cc-session-1", branch: BRANCH });
    expect(queuedLines()).toEqual([{ event: "run.queued", run_id: out.runId, account_id: a.accountId }]);
    // Not recorded as a refused round: the round is recorded as started.
    const events = (await admin.query("SELECT kind, run_id FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [workItemId])).rows;
    expect(events).toEqual([{ kind: "fix_round_started", run_id: out.runId }]);
  });

  // ---- 6: retry ----------------------------------------------------------------------------------------

  it("6: retrying a runner run that expired in the queue returns done with a new pending run on the same model (A5)", async () => {
    const { a, workItemId } = await world("runner_local");
    const { registry } = chain();
    const { id: old } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: "project-manager", runtime: "runner", executionMode: "runner_local", dispatchRepoId: a.repoId, startPrompt: "classify this issue" });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: old, from: "pending", to: "timed_out", failureReason: "queue_ttl" });
    const seats: RetrySeatSource = { retrySeat: async () => ({ ok: true, seat: { ...SEAT_OK, repoId: a.repoId } as never }) };
    const requested = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('retry_run', $1, NULL, $2)", [old, "h".repeat(64)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(requested.action_id, 600)).not.toBeNull();

    const out = await createRetryModule(writerPool, registry, { seats, authorCheck: () => null }).performRetryRun(requested.action_id);
    expect(out).toMatchObject({ result: "done", outcome: { model: "haiku-4.5", escalated_from_model: null } });
    const runId = (out as unknown as { outcome: { run_id: string } }).outcome.run_id;
    expect(await row(runId)).toMatchObject({ status: "pending", runtime: "runner" });
    expect(await statusEvents(runId)).toEqual([]);
    expect(((await row(runId)).job_signed as { job: { model_hint: string } }).job.model_hint).toBe("haiku-4.5");
    expect((await admin.query("SELECT parent_run_id FROM agent_runs WHERE id = $1", [runId])).rows[0].parent_run_id).toBe(old);
    expect(queuedLines()).toEqual([{ event: "run.queued", run_id: runId, account_id: a.accountId }]);
  });

  // ---- 7: the sandbox does not change -----------------------------------------------------------------

  it("7 (sandbox regression): on a sandbox repo the advance starter's classify start is a running run, followed once with the target's hook token and the run's timeout plus the margin", async () => {
    const { a, workItemId } = await world("sandbox");
    const { registry, harness } = chain();
    const follows: FollowArgs[] = [];
    const out = await advanceOver(registry, async (args) => void follows.push(args)).advanceStartRun(classifyReq(a, workItemId));
    if (!out.ok) throw new Error(`not started: ${out.reason}`);
    expect(await row(out.runId)).toMatchObject({ status: "running", runtime: "production" });
    expect(follows).toHaveLength(1);
    expect(follows[0]).toMatchObject({ runId: out.runId, accountId: a.accountId, watchdogMs: SEAT_OK.timeoutMs + WATCHDOG_MARGIN_MS });
    expect(follows[0]!.hookToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.fakeSandbox.state.created).toHaveLength(1);
    expect(queuedLines()).toEqual([]);
  });

  // ---- 8: the backstop ----------------------------------------------------------------------------------

  it("8: a pending result that is not a runner's is still cancelled by the accepting starter (the backstop)", async () => {
    const { a, workItemId } = await world("sandbox");
    const harness = createSandboxTargetHarness(writerPool, []);
    const sandbox = new SandboxTarget(harness.deps);
    // A sandbox target that queues: it cannot happen today, which is why the starter must not trust the flag alone.
    const queuing = Object.assign(Object.create(sandbox), { dispatch: async () => ({ queued: true as const }) }) as SandboxTarget;
    const registry: ExecutionTargetRegistry = { sandbox: queuing };
    const follow = vi.fn(async () => undefined);
    await expect(advanceOver(registry, follow).advanceStartRun(classifyReq(a, workItemId))).rejects.toThrow(/queued for a runner/);
    expect((await admin.query("SELECT status, runtime FROM agent_runs WHERE account_id = $1 AND work_item_id = $2", [a.accountId, workItemId])).rows).toEqual([{ status: "cancelled", runtime: "production" }]);
    expect(queuedLines()).toEqual([]);
    expect(follow).toHaveBeenCalledTimes(0);
  });

  // ---- section 6: halt and cancel of a queued run ---------------------------------------------------------

  it("a halted item's queued runner run reads as done (cancelled) on the next poll", async () => {
    const { a, workItemId } = await world("runner_local", "in_progress");
    const { registry } = chain();
    const m = advanceOver(registry, async () => undefined);
    const started = await m.advanceStartRun(classifyReq(a, workItemId));
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    expect(await m.advanceRunOutcome(a.accountId, started.runId)).toMatchObject({ status: "pending", done: false });

    const requested = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('cancel_work_item', $1, NULL, $2)", [workItemId, "h".repeat(64)])).rows[0]);
    const facade = createRunActionFacade(writerPool, registry);
    expect(await facade.claimRunAction(requested.action_id, 600)).not.toBeNull();
    expect(await facade.performCancelWorkItem(requested.action_id)).toMatchObject({ result: "done" });

    expect(await m.advanceRunOutcome(a.accountId, started.runId)).toMatchObject({ status: "cancelled", done: true });
    // And the halt fence refuses a new start on the item.
    expect(await m.advanceStartRun(classifyReq(a, workItemId, "classify:next"))).toMatchObject({ ok: false });
  });
});
