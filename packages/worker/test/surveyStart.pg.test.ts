import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURVEY_CAPABILITY, SURVEY_ROLE, sha256Text, verifyJob } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { loadPlatformCard } from "@fx/roles/cards";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, startAgentRun, type ExecutionTargetRegistry } from "@fx/runner";
import { createFakeRunnerLimits, createFakeVisibility } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createSeatResolver, type SeatRequest, type SeatResult } from "../src/seat.js";
import { createSurveyStart, type StartSurveyRunInput, type StartSurveyRunResult } from "../src/surveyStart.js";

const HEAD = "d".repeat(40);

interface World extends SeedRefs {
  runnerId: string;
  setupId: string;
}

/**
 * [pg] D#845 ON-10b1 (Ruling 88 items 1, 4 and 6): the worker's survey start over the real seat, the real run starter, the real job issuer (a real Ed25519 key) and the real claim, on real rows. The bind commits with the
 * run or not at all, the hosted path is shut, and a survey goes only to the machine its repo is placed on.
 */
describe("the survey start [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = { "job-key-1": publicKey };

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), writerPool.end()]);
  });

  const passthrough = (target: object, key: string | symbol): unknown => {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  };

  /** The statements one connection saw, in order. A wrapper over the pool, so the real code runs against the real database. */
  function recording(pool: Pool, log: string[]): Pool {
    const wrap = (client: PoolClient): PoolClient =>
      new Proxy(client, {
        get(target, key) {
          if (key !== "query") return passthrough(target, key);
          return (...args: unknown[]) => {
            const [sql, params] = args as [unknown, unknown[] | undefined];
            if (typeof sql === "string" && /app\.user_id|survey_start_record/.test(sql)) log.push(`${sql.replace(/\s+/g, " ").trim()} ${JSON.stringify(params ?? [])}`);
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        },
      });
    return new Proxy(pool, {
      get(target, key) {
        if (key === "connect") return async () => wrap(await target.connect());
        return passthrough(target, key);
      },
    });
  }

  function build(o: { pool?: Pool; seat?: (request: SeatRequest) => Promise<SeatResult> } = {}) {
    const pool = o.pool ?? writerPool;
    const visibility = createFakeVisibility("private");
    const issuer = createJobIssuer({ pool, signer: createJobSigner({ keyId: "job-key-1", privateKey }), visibility, context: createPgJobContext(pool) });
    const harness = createSandboxTargetHarness(pool);
    const sandbox = new SandboxTarget(harness.deps);
    const registry: ExecutionTargetRegistry = { sandbox, runner_local: new RunnerTarget({ pool, issuer, visibility, limits: createFakeRunnerLimits() }, "runner_local") };
    const seat = o.seat ?? createSeatResolver({ pool });
    return { registry, sandbox, harness, start: createSurveyStart({ pool, registry, resolveRunSeat: seat }), seat };
  }

  /** An account whose repo is `runner_local` with a name, one machine placed on it (a login of `credential`, seen), and a setup waiting at the survey step. */
  async function world(o: { budget?: number; credential?: "subscription" | "api_key"; engine?: "os_sandbox" | "microvm"; role?: string } = {}): Promise<World> {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = $2 WHERE id = $1", [refs.accountId, o.budget ?? 0]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [refs.repoId]);
    if (o.role !== undefined) await admin.query("UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2", [refs.accountId, refs.userId, o.role]);
    const runnerId = await machine(refs, { credential: o.credential ?? "subscription", engine: o.engine ?? "os_sandbox", place: true });
    const setupId = randomUUID();
    await admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', 'survey', $4)", [setupId, refs.accountId, refs.repoId, refs.userId]);
    return { ...refs, runnerId, setupId };
  }
  /** A machine of the account that lists the repo and `survey_v1`, signed in, with its engine on record; `place` puts the repo on it. */
  async function machine(refs: SeedRefs, o: { credential: "subscription" | "api_key"; engine: "os_sandbox" | "microvm"; place: boolean }): Promise<string> {
    const id = await insertRunner(admin, refs.accountId, refs.userId, { credentialMode: o.credential });
    await admin.query("UPDATE runners SET model_auth_present = true, allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [id, [refs.repoId]]);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, refs.accountId, [SURVEY_CAPABILITY]]);
    await admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, $3)", [id, refs.accountId, o.engine]);
    if (o.place) await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [refs.repoId, refs.accountId, id]);
    return id;
  }
  const input = (w: World, over: Partial<StartSurveyRunInput> = {}): StartSurveyRunInput => ({ accountId: w.accountId, userId: w.userId, setupId: w.setupId, repoId: w.repoId, runnerId: w.runnerId, owner: "acme", name: "widgets", headSha: HEAD, priorRunId: null, ...over });
  const surveyRuns = async (w: SeedRefs) => (await admin.query("SELECT id, status, runtime, execution_mode, dispatch_repo_id, initiated_by, head_sha, runner_id, job_signed FROM agent_runs WHERE account_id = $1 AND role = $2 ORDER BY created_at", [w.accountId, SURVEY_ROLE])).rows;
  const keysOf = async (w: SeedRefs) => Number((await admin.query("SELECT count(*) FROM agent_run_idempotency_keys WHERE account_id = $1", [w.accountId])).rows[0].count);
  const eventsOf = async (w: SeedRefs) => Number((await admin.query("SELECT count(*) FROM run_events WHERE account_id = $1 AND run_id <> $2", [w.accountId, w.runId])).rows[0].count);
  /** A seeded account already holds one reservation row; the tests compare against `seeded`, so only what a start adds counts. */
  const reservations = async (w: SeedRefs) => Number((await admin.query("SELECT count(*) FROM spend_reservations WHERE account_id = $1", [w.accountId])).rows[0].count) - 1;
  const setupOf = async (id: string) => (await admin.query("SELECT phase, state, survey_run_id, survey_started_at FROM project_setups WHERE id = $1", [id])).rows[0];
  const started = (r: StartSurveyRunResult): string => {
    if (!r.ok) throw new Error(`not started: ${JSON.stringify(r)}`);
    return r.runId;
  };
  /** Nothing of a refused start is left: no run, no event, no key, no reservation, and the setup is as it was. */
  async function leftNothing(w: World): Promise<void> {
    expect(await surveyRuns(w)).toEqual([]);
    expect(await keysOf(w)).toBe(0);
    expect(await eventsOf(w)).toBe(0);
    expect(await reservations(w)).toBe(0);
    expect(await setupOf(w.setupId)).toMatchObject({ phase: "survey", survey_run_id: null });
  }

  describe("the bind", () => {
    it("one start makes one run: bound, pending, signed as a survey task on the pinned commit, with the card, the prompt and the model the seat resolved", async () => {
      const w = await world({ credential: "subscription" });
      const log: string[] = [];
      const { start } = build({ pool: recording(writerPool, log) });
      const runId = started(await start.startSurveyRun(input(w)));
      const [row, ...rest] = await surveyRuns(w);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({ id: runId, status: "pending", runtime: "runner", execution_mode: "runner_local", dispatch_repo_id: w.repoId, initiated_by: w.userId, head_sha: HEAD, runner_id: null });
      const job = verifyJob(row.job_signed, keys, { now: new Date() });
      expect(job.role).toBe(SURVEY_ROLE);
      expect(job.task.kind).toBe("survey");
      expect(job.review).toEqual({ head_sha: HEAD });
      expect(job.task.prompt).toContain(HEAD);
      expect(job.task.prompt).toContain("acme/widgets");
      expect(job.task.prompt_sha256).toBe(sha256Text(job.task.prompt));
      expect(job.role_card).toEqual({ text: loadPlatformCard(SURVEY_ROLE), sha256: sha256Text(loadPlatformCard(SURVEY_ROLE)!) });
      expect(job.repo).toEqual({ id: w.repoId, owner: "acme", name: "widgets", private: true });
      expect(job.spec).toBeNull();
      expect("requires_engine" in job).toBe(false);
      const seat = await createSeatResolver({ pool: writerPool })({ accountId: w.accountId, role: SURVEY_ROLE, repoId: w.repoId, runnerId: w.runnerId, purpose: "survey" });
      expect(seat.ok && job.model_hint).toBe(seat.ok ? seat.seat.model : "unreachable");
      expect(await setupOf(w.setupId)).toMatchObject({ phase: "survey", state: "started", survey_run_id: runId });
      expect((await setupOf(w.setupId)).survey_started_at).toBeInstanceOf(Date);
      // The key is `survey:<setup>:none`, and a $0 survey reserves nothing.
      expect((await admin.query("SELECT idempotency_key FROM agent_run_idempotency_keys WHERE account_id = $1", [w.accountId])).rows).toEqual([{ idempotency_key: `survey:${w.setupId}:none` }]);
      expect(await reservations(w)).toBe(0);
      // The user id the bind ran under is the session principal's, set, used, and cleared again, in that order and on one connection.
      const set = log.findIndex((l) => l.includes("set_config('app.user_id', $1, true)"));
      const call = log.findIndex((l) => l.includes("survey_start_record"));
      const clear = log.findIndex((l) => l.includes("set_config('app.user_id', '', true)"));
      expect(set).toBeGreaterThanOrEqual(0);
      expect(set).toBeLessThan(call);
      expect(call).toBeLessThan(clear);
      expect(log[set]).toContain(JSON.stringify([w.userId]));
      expect(log[call]).toContain(JSON.stringify([w.setupId, runId]));
    });

    it("two concurrent starts make one run: one is ok and the other is 409 survey_running", async () => {
      const w = await world();
      const { start } = build();
      const results = await Promise.all([start.startSurveyRun(input(w)), start.startSurveyRun(input(w))]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const lost = results.find((r) => !r.ok)!;
      expect(lost).toMatchObject({ ok: false, status: 409, code: "survey_running" });
      const rows = await surveyRuns(w);
      expect(rows).toHaveLength(1);
      expect(lost.ok === false && lost.code === "survey_running" ? lost.runId : null).toBe(rows[0].id);
      expect(await keysOf(w)).toBe(1);
      expect((await setupOf(w.setupId)).survey_run_id).toBe(rows[0].id);
    });

    it("a second click on the same prior run is survey_running; once the run has ended, the next start (naming it as the prior) makes a new one", async () => {
      const w = await world();
      const { start } = build();
      const first = started(await start.startSurveyRun(input(w)));
      expect(await start.startSurveyRun(input(w))).toMatchObject({ ok: false, status: 409, code: "survey_running", runId: first });
      expect(await surveyRuns(w)).toHaveLength(1);
      // A run that is still live blocks even a caller that read the new prior.
      expect(await start.startSurveyRun(input(w, { priorRunId: first }))).toMatchObject({ ok: false, status: 409, code: "survey_running" });
      await admin.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [first]);
      const second = started(await start.startSurveyRun(input(w, { priorRunId: first })));
      expect(second).not.toBe(first);
      expect((await setupOf(w.setupId)).survey_run_id).toBe(second);
    });

    it("a refused bind rolls the create back: no run row, no event, no job, no idempotency key (the setup is no longer at the survey step)", async () => {
      const w = await world();
      await admin.query("UPDATE project_setups SET phase = 'plan' WHERE id = $1", [w.setupId]);
      const { start } = build();
      expect(await start.startSurveyRun(input(w))).toMatchObject({ ok: false, status: 409, code: "survey_running" });
      expect(await surveyRuns(w)).toEqual([]);
      expect(await keysOf(w)).toBe(0);
      expect(await eventsOf(w)).toBe(0);
      expect(await reservations(w)).toBe(0);
      expect(await setupOf(w.setupId)).toMatchObject({ phase: "plan", survey_run_id: null });
    });

    it("a user who is not an owner or admin is 403 forbidden and nothing is left", async () => {
      const w = await world({ role: "member" });
      const { start } = build();
      expect(await start.startSurveyRun(input(w))).toEqual({ ok: false, status: 403, code: "forbidden" });
      await leftNothing(w);
    });

    it("another account's setup is no setup: the bind finds none and nothing is written", async () => {
      const w = await world();
      const other = await world();
      const { start } = build();
      expect(await start.startSurveyRun(input(w, { setupId: other.setupId }))).toMatchObject({ ok: false, status: 403, code: "forbidden" });
      await leftNothing(w);
      expect(await setupOf(other.setupId)).toMatchObject({ phase: "survey", survey_run_id: null });
      expect(await surveyRuns(other)).toEqual([]);
    });

    it("malformed ids are refused before anything is read", async () => {
      const w = await world();
      const { start } = build();
      for (const over of [{ setupId: "x" }, { runnerId: "x" }, { userId: "" }, { priorRunId: "nope" }]) expect(await start.startSurveyRun(input(w, over)), JSON.stringify(over)).toMatchObject({ ok: false, code: "survey_not_started", reason: "invalid_input" });
      for (const over of [{ owner: "a/b" }, { name: "../x" }, { headSha: "HEAD" }, { owner: "" }]) expect(await start.startSurveyRun(input(w, over)), JSON.stringify(over)).toMatchObject({ ok: false, code: "survey_not_started", reason: "survey_prompt_input" });
      await leftNothing(w);
    });

    it("a seat refusal is a closed survey_not_started reason and writes nothing", async () => {
      const w = await world({ credential: "api_key", budget: 0 });
      const { start } = build();
      expect(await start.startSurveyRun(input(w))).toEqual({ ok: false, status: 409, code: "survey_not_started", reason: "model_budget_unset" });
      await leftNothing(w);
    });
  });

  describe("the hosted path is shut four ways", () => {
    it("1. a repo that is not runner_local has no seat (sandbox and runner_verified), and the start writes nothing", async () => {
      for (const mode of ["sandbox", "runner_verified"]) {
        const w = await world({ budget: 500 });
        await admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [w.repoId, mode]);
        expect(await build().start.startSurveyRun(input(w)), mode).toEqual({ ok: false, status: 409, code: "survey_not_started", reason: "survey_needs_runner" });
        await leftNothing(w);
      }
    });

    it("2. a mode flipped to sandbox between the seat and the start throws execution_mode_changed before any row exists", async () => {
      const w = await world({ budget: 500 });
      const real = createSeatResolver({ pool: writerPool });
      const { start, harness } = build({
        seat: async (request) => {
          const seat = await real(request);
          await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [w.repoId]);
          return seat;
        },
      });
      expect(await start.startSurveyRun(input(w))).toEqual({ ok: false, status: 409, code: "survey_not_started", reason: "execution_mode_changed" });
      await leftNothing(w);
      expect(harness.fakeSandbox.state.created).toHaveLength(0);
    });

    it("3. a later move off the runner mode cancels the queued run (the existing mode-change path), so no hosted run is left to start", async () => {
      const w = await world({ budget: 500 });
      const runId = started(await build().start.startSurveyRun(input(w)));
      // The existing path (executionMode.ts) cancels queued runner runs when a repo leaves the runner mode; here the repo's own change is applied the way it does.
      const { setExecutionMode } = await import("@fx/runner-cloud");
      const appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
      try {
        await setExecutionMode({ appUserPool: appPool, origin: undefined, failRunnerLeases: null }, { accountId: w.accountId, userId: w.userId }, w.repoId, { mode: "sandbox", confirm_repo: "acme/widgets" });
      } finally {
        await appPool.end();
      }
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0]).toEqual({ status: "cancelled" });
      expect((await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [runId])).rows.map((r) => r.payload)).toEqual([{ from: "pending", to: "cancelled", failureReason: "execution_mode_changed" }]);
    });

    it("4. the sandbox target refuses the survey role at precheck and at admit with role_runner_only, and reserves nothing", async () => {
      const w = await world({ budget: 500 });
      const { sandbox, harness } = build();
      expect(await sandbox.precheck({ accountId: w.accountId, repoId: w.repoId, role: SURVEY_ROLE })).toEqual({ ok: false, reason: "role_runner_only" });
      expect(await sandbox.precheck({ accountId: w.accountId, repoId: w.repoId, role: "code-reviewer" })).toEqual({ ok: true });
      const run = {
        id: randomUUID(), accountId: w.accountId, role: SURVEY_ROLE, product: "team" as const, repoId: w.repoId, roleCard: "c", prompt: "p", model: "sonnet-5", capUsd: 5,
        spend: { plan: "starter" as const, estimateModelUsd: 5, estimateComputeUsd: 1, trigger: "foreground" as const, monthlyModelBudgetUsd: 500, perSpawnCapUsd: 5 },
      };
      expect(await sandbox.admit(run as never, admin)).toEqual({ admitted: false, reason: "role_runner_only" });
      expect(await reservations(w)).toBe(0);
      expect(harness.fakeSandbox.state.created).toHaveLength(0);
    });

    it("4. through the real starter: a survey on a sandbox-mode repo is refused by the sandbox target's precheck before a row exists", async () => {
      const w = await world({ budget: 500 });
      await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [w.repoId]);
      const { registry, harness } = build();
      await expect(
        startAgentRun(writerPool, registry, { accountId: w.accountId, repoId: w.repoId, role: SURVEY_ROLE, product: "team", roleCard: "c", prompt: "p", model: "sonnet-5", capUsd: 5, spend: { plan: "starter", estimateModelUsd: 5, estimateComputeUsd: 1, trigger: "foreground" } }),
      ).rejects.toMatchObject({ code: "run_precheck_refused", reason: "role_runner_only" });
      expect(await surveyRuns(w)).toEqual([]);
      expect(await reservations(w)).toBe(0);
      expect(harness.fakeSandbox.state.created).toHaveLength(0);
    });
  });

  describe("requires_engine", () => {
    it("a microVM placement signs requires_engine: microvm, an os_sandbox placement omits it, and an os_sandbox runner never claims the microVM one", async () => {
      const plain = await world({ credential: "api_key", budget: 500, engine: "os_sandbox" });
      const plainRun = started(await build().start.startSurveyRun(input(plain)));
      const plainJob = verifyJob((await surveyRuns(plain))[0].job_signed, keys, { now: new Date() });
      expect(plainJob).not.toHaveProperty("requires_engine");

      const vm = await world({ credential: "api_key", budget: 500, engine: "microvm" });
      const vmRun = started(await build().start.startSurveyRun(input(vm, { requiresEngine: "microvm" })));
      const vmJob = verifyJob((await surveyRuns(vm))[0].job_signed, keys, { now: new Date() });
      expect(vmJob.requires_engine).toBe("microvm");
      expect(plainRun).not.toBe(vmRun);

      // The microVM machine reports os_sandbox later: the run it was signed for is then never handed to it.
      const claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
      await admin.query("UPDATE runner_facts SET sandbox_engine = 'os_sandbox' WHERE runner_id = $1", [vm.runnerId]);
      expect(await claims.claimRunnerRun({ accountId: vm.accountId, runnerId: vm.runnerId })).toMatchObject({ kind: "idle" });
      expect((await surveyRuns(vm))[0].status).toBe("pending");
      await admin.query("UPDATE runner_facts SET sandbox_engine = 'microvm' WHERE runner_id = $1", [vm.runnerId]);
      expect(await claims.claimRunnerRun({ accountId: vm.accountId, runnerId: vm.runnerId })).toMatchObject({ kind: "claimed", runId: vmRun });
    });
  });

  describe("the claim pin", () => {
    it("another live runner of the same account that holds survey_v1 and lists the repo never claims the survey; the placed runner does", async () => {
      const w = await world({ credential: "api_key", budget: 500 });
      const other = await machine(w, { credential: "api_key", engine: "os_sandbox", place: false });
      const runId = started(await build().start.startSurveyRun(input(w)));
      const claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
      expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: other })).toMatchObject({ kind: "idle" });
      expect((await surveyRuns(w))[0]).toMatchObject({ id: runId, status: "pending", runner_id: null });
      expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: w.runnerId })).toMatchObject({ kind: "claimed", runId });
      expect((await surveyRuns(w))[0]).toMatchObject({ status: "running", runner_id: w.runnerId });
    });

    it("a setup that is no longer waiting for this run gives no claim, even to the placed runner", async () => {
      const w = await world({ credential: "api_key", budget: 500 });
      const runId = started(await build().start.startSurveyRun(input(w)));
      const claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
      for (const [sql, label] of [["UPDATE project_setups SET survey_run_id = NULL WHERE id = $1", "unbound"], ["UPDATE project_setups SET phase = 'plan' WHERE id = $1", "moved on"], ["UPDATE project_setups SET state = 'failed' WHERE id = $1", "failed"]] as const) {
        await admin.query(sql, [w.setupId]);
        expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: w.runnerId }), label).toMatchObject({ kind: "idle" });
        await admin.query("UPDATE project_setups SET survey_run_id = $2, phase = 'survey', state = 'started' WHERE id = $1", [w.setupId, runId]);
      }
      expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: w.runnerId })).toMatchObject({ kind: "claimed", runId });
    });

    it("a placement moved between the select and the claim gives taken: the run stays pending and neither machine is handed it", async () => {
      const w = await world({ credential: "api_key", budget: 500 });
      const other = await machine(w, { credential: "api_key", engine: "os_sandbox", place: false });
      const runId = started(await build().start.startSurveyRun(input(w)));
      let armed = true;
      // After the candidate query has answered, the repo is moved to the other machine, as a person's move would.
      const racing = new Proxy(writerPool, {
        get(target, key) {
          if (key !== "connect") return passthrough(target, key);
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(c, k) {
                if (k !== "query") return passthrough(c, k);
                return async (...args: unknown[]) => {
                  const result = await (c.query as (...a: unknown[]) => Promise<unknown>)(...args);
                  if (armed && typeof args[0] === "string" && args[0].includes("a.job_signed") && (result as { rows: unknown[] }).rows.length === 1) {
                    armed = false;
                    await admin.query("DELETE FROM project_placements WHERE account_id = $1 AND repo_id = $2", [w.accountId, w.repoId]);
                    await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [w.repoId, w.accountId, other]);
                  }
                  return result;
                };
              },
            });
          };
        },
      });
      const claims = createRunnerClaimFacade(racing, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
      expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: w.runnerId })).toMatchObject({ kind: "idle" });
      expect(armed).toBe(false);
      expect((await surveyRuns(w))[0]).toMatchObject({ id: runId, status: "pending", runner_id: null });
      // CWE-367: the machine the repo now sits on is NOT the one the seat was decided for, so it never takes the run either; the run waits for its deadline or a retry.
      const next = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
      expect(await next.claimRunnerRun({ accountId: w.accountId, runnerId: other })).toMatchObject({ kind: "idle" });
      expect(await next.claimRunnerRun({ accountId: w.accountId, runnerId: w.runnerId })).toMatchObject({ kind: "idle" });
      expect((await surveyRuns(w))[0]).toMatchObject({ id: runId, status: "pending", runner_id: null });
    });

    it("a $0 survey seated for a subscription machine is never claimed by the api_key machine the repo is moved to (CWE-367); moved back, the seated machine takes it", async () => {
      const w = await world({ credential: "subscription", budget: 0 });
      const other = await machine(w, { credential: "api_key", engine: "os_sandbox", place: false });
      const runId = started(await build().start.startSurveyRun(input(w)));
      // The seat decided $0 for the subscription machine: the run reserved nothing and carries that machine's id.
      expect(await reservations(w)).toBe(0);
      expect((await admin.query("SELECT payload #>> '{meta,survey_runner_id}' AS r FROM run_events WHERE run_id = $1 AND kind = 'run.input'", [runId])).rows).toEqual([{ r: w.runnerId }]);
      await admin.query("DELETE FROM project_placements WHERE account_id = $1 AND repo_id = $2", [w.accountId, w.repoId]);
      await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [w.repoId, w.accountId, other]);
      const claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
      // The api_key machine is placed but was not seated for; the subscription machine was seated for but is no longer placed. Neither claims.
      expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: other })).toMatchObject({ kind: "idle" });
      expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: w.runnerId })).toMatchObject({ kind: "idle" });
      expect((await surveyRuns(w))[0]).toMatchObject({ id: runId, status: "pending", runner_id: null });
      // Behaviour chosen: the placement back on the seated machine makes the run claimable again (both conditions hold), so a person undoing a move loses nothing.
      await admin.query("DELETE FROM project_placements WHERE account_id = $1 AND repo_id = $2", [w.accountId, w.repoId]);
      await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [w.repoId, w.accountId, w.runnerId]);
      expect(await claims.claimRunnerRun({ accountId: w.accountId, runnerId: w.runnerId })).toMatchObject({ kind: "claimed", runId });
    });
  });
});
