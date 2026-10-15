import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_MAX_RUN_WALL_CLOCK_MS, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { branchOf } from "@fx/runner-cloud";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { HANDOFF_CONTINUE_HASH } from "@fx/pipeline";
import { RUN_HANDOFF_KIND, type ContinuationBasePort } from "@fx/runner";
import { HANDOFF_KIND } from "@fx/core/src/onboarding/previewProgress.js";
import { createAdvanceModule } from "../src/advance.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunHandoffs, runBranchOf, type RunHandoffPorts } from "../src/runHandoffs.js";

/**
 * [pg] D#599 HO-2b: finishing a handoff against the real definers (0794), the real compare-and-set status writer, the real claim facade and a
 * real run-writer login. GitHub is a strict fake: it answers the head of the branch it is asked about and refuses anything else.
 */
describe("run handoff completion, sweep and child run [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const HEAD = "a".repeat(40);
  let A: SeedRefs;
  let runnerA: string;
  let approver: string;
  let specVersion: string;
  let nextPr = 300;
  let github: { head: string | null; down: boolean; asked: { repo: { id: string; owner: string; name: string }; branch: string }[] };
  let started: { runId: string; toSide: string }[];
  let parked: { workItemId: string; code: string }[];
  let errors: unknown[];
  let startFails: boolean;

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
    // The sweep is cross-tenant and other files leave live handoffs and running runs behind.
    await admin.query("UPDATE run_handoffs SET state = 'failed' WHERE state IN ('requested', 'checkpointing')");
    A = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "subscription" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerA, [A.repoId]]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'app' WHERE id = $1", [A.repoId]);
    specVersion = randomUUID();
    await admin.query(`INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, 1, 'spec', $4, 'system')`, [specVersion, A.accountId, A.workItemId, sha256Text("spec")]);
    approver = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [approver, `${approver}@example.test`]);
    github = { head: HEAD, down: false, asked: [] };
    started = [];
    parked = [];
    errors = [];
    startFails = false;
  });

  const base: ContinuationBasePort = {
    headOid: async (input) => {
      github.asked.push(input);
      if (github.down) throw new Error("github: 503");
      return github.head;
    },
  };
  const ports = (over: Partial<RunHandoffPorts> = {}): RunHandoffPorts => ({
    base,
    dispatchChild: async ({ runId, toSide }) => {
      if (startFails) throw new Error("the child could not start");
      started.push({ runId, toSide });
    },
    park: async ({ workItemId, code }) => void parked.push({ workItemId, code }),
    limits: () => ({ maxConcurrentRunnerJobs: 5, maxConcurrentHeavyRunnerJobs: 5, maxRunWallClockMs: RUNNER_MAX_RUN_WALL_CLOCK_MS }),
    onError: (_runId, error) => void errors.push(error),
    ...over,
  });
  const handoffs = (over: Partial<RunHandoffPorts> = {}) => createRunHandoffs(writerPool, ports(over));

  const job = (runId: string): Job => ({
    schema_version: 1,
    job_id: randomUUID(),
    run_id: runId,
    repo: { id: A.repoId, owner: "acme", name: "app", private: true },
    role: "executor",
    mode: "local",
    spec: null,
    task: { kind: "implement", prompt: "the task", prompt_sha256: sha256Text("the task") },
    role_card: { text: "the card", sha256: sha256Text("the card") },
    role_tools_sha256: "a".repeat(64),
    continues: null,
    branch_prefix: "fx/",
    model_hint: "sonnet-5",
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
    key_id: "k1",
  });

  /** The run being moved: a running runner run of account A, past the live-session triggers the way a fixture may be. */
  async function parentRun(o: { mode?: string } = {}): Promise<string> {
    const id = randomUUID();
    const sandbox = o.mode === "sandbox";
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, dispatch_pr_number, head_sha, spec_version_id,
                                 resolved_exposure, exposure_digest, initiated_by, approved_by, model, runner_id, lease_generation, lease_expires_at, started_at, job_signed)
         VALUES ($1, $2, $3, 'executor', $4, 'running', $5, $6, $7, 'abc123', $8, jsonb_build_object('accountId', $2::uuid::text), $9, $10, $11, 'sonnet-5', $12, $13, now() + interval '1 hour', now(), $14::jsonb)`,
        [id, A.accountId, A.workItemId, sandbox ? "production" : "runner", sandbox ? "sandbox" : "runner_local", A.repoId, nextPr++, specVersion, "e".repeat(64), A.userId, approver, sandbox ? null : runnerA, sandbox ? 0 : 1, sandbox ? null : JSON.stringify(signJob(job(id), key))],
      );
    } finally {
      await admin.query("SET session_replication_role = DEFAULT");
    }
    return id;
  }
  async function hold(budget = "model", runId: string | null = null): Promise<string> {
    return (await admin.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, 'open', $3, 'run') RETURNING id", [A.accountId, runId, budget])).rows[0]!.id;
  }
  /** A live handoff row, as HO-2a leaves it. The deadline is relative to the database clock, which the definer reads. */
  async function liveHandoff(run: string, o: { to?: "cloud" | "runner"; from?: "cloud" | "runner"; state?: string; deadlineSecs?: number; reserveSecs?: number; prior?: string | null; holds?: string[] } = {}): Promise<string> {
    const to = o.to ?? "cloud";
    const [model, compute] = o.holds ?? (to === "cloud" ? [await hold("model"), await hold("foreground_compute")] : []);
    await admin.query("UPDATE work_items SET placement = $2 WHERE id = $1", [A.workItemId, to]);
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, state, deadline, reserve_until, requested_by, prior_placement, reservation_id, compute_reservation_id)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), now() + make_interval(secs => $8), $9, $10, $11, $12) RETURNING id`,
        [A.accountId, run, A.workItemId, o.from ?? "runner", to, o.state ?? "checkpointing", o.deadlineSecs ?? 300, o.reserveSecs ?? 1200, A.userId, o.prior === undefined ? "runner" : o.prior, model ?? null, compute ?? null],
      )
    ).rows[0]!.id;
  }
  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0];
  const rows = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows;
  const handoffRow = (run: string) => one("SELECT * FROM run_handoffs WHERE run_id = $1 /* run-handoffs: admin */", [run]);
  const children = (run: string) => rows("SELECT * FROM agent_runs WHERE parent_run_id = $1 /* agent-run-columns: allow admin connection, not app_user */", [run]);
  /** The state and attachment of the two holds a handoff names, the model one first. */
  const holdsOf = async (run: string) => {
    const h = await handoffRow(run);
    return rows("SELECT state, run_id FROM spend_reservations WHERE id = ANY($1::uuid[]) ORDER BY budget", [[h.reservation_id, h.compute_reservation_id]]);
  };
  const status = async (run: string) => (await one("SELECT status FROM agent_runs WHERE id = $1", [run])).status as string;

  describe("finishing a handoff the side reported (run_ended handed_off, or done)", () => {
    it("ends the parent handed off, makes the child on the target side from the head GitHub answered, and moves the holds to it, in one transaction", async () => {
      const run = await parentRun();
      const handoff = await liveHandoff(run, { to: "cloud" });
      const before = await handoffRow(run);
      const result = await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false });
      expect(result).toMatchObject({ kind: "created", toSide: "cloud", workItemId: A.workItemId, forced: false });
      const [kid, ...others] = await children(run);
      expect(others).toEqual([]);
      expect(kid).toMatchObject({ parent_run_id: run, work_item_id: A.workItemId, role: "executor", runtime: "production", execution_mode: "sandbox", status: "pending", dispatch_repo_id: A.repoId, initiated_by: A.userId, approved_by: approver, excluded_runner_id: null });
      // The parent: terminal, with the one reason, and its work named.
      expect(await status(run)).toBe("cancelled");
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'cancelled'", [run])).payload).toMatchObject({ from: "running", to: "cancelled", failureReason: "handed_off" });
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.handoff'", [run])).payload).toEqual({ state: "handed_off", branch: `fx/${run}-g1` });
      // The base is what GitHub answered for the parent's own branch, and the question was exactly that.
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.dispatch_base'", [kid.id])).payload).toEqual({ head_oid: HEAD });
      expect(github.asked).toEqual([{ repo: { id: A.repoId, owner: "acme", name: "app" }, branch: `fx/${run}-g1` }]);
      // The handoff, its child, and the holds: attached to the child, still open, none released or deleted.
      expect(await handoffRow(run)).toMatchObject({ id: handoff, state: "handed_off", child_run_id: kid.id });
      expect(await holdsOf(run)).toEqual([
        { run_id: kid.id, state: "open" },
        { run_id: kid.id, state: "open" },
      ]);
      expect(before.reservation_id).not.toBeNull();
      // It counts as a continuation, keyed on the parent, with the handoff's own hash.
      expect(await one("SELECT idempotency_key, request_hash FROM agent_run_idempotency_keys WHERE run_id = $1", [kid.id])).toEqual({ idempotency_key: `${run}:continue`, request_hash: HANDOFF_CONTINUE_HASH });
      expect((await one("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'run.handoff.completed'", [A.accountId])).payload).toMatchObject({ handoff_id: handoff, run_id: run, child_run_id: kid.id, forced: false });
      expect(started).toEqual([{ runId: kid.id, toSide: "cloud" }]);
    });

    it("a runner target excludes the machine the run was on from the child's claim, and the child still has to pass the full claim predicate", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "runner", prior: "runner" });
      const result = await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false });
      if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
      expect(await one("SELECT runtime, execution_mode, excluded_runner_id FROM agent_runs WHERE id = $1", [result.childRunId])).toEqual({ runtime: "runner", execution_mode: "runner_local", excluded_runner_id: runnerA });

      // Dispatch (a signed job) is what makes it claimable; the issuer is not under test here.
      await admin.query("SET session_replication_role = replica");
      await admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [result.childRunId, JSON.stringify(signJob(job(result.childRunId), key))]);
      await admin.query("SET session_replication_role = DEFAULT");
      const claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
      // The source is excluded, though it is its registrant's own run and the machine is idle.
      expect(await claims.claimRunnerRun({ accountId: A.accountId, runnerId: runnerA })).toMatchObject({ kind: "idle" });
      // A subscription runner of another registrant is held back by the same gate that holds back any run (initiated_by / approved_by are copied).
      const stranger = randomUUID();
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [stranger, `${stranger}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, stranger]);
      const other = await insertRunner(admin, A.accountId, stranger, { credentialMode: "subscription" });
      await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [other, [A.repoId]]);
      expect(await claims.claimRunnerRun({ accountId: A.accountId, runnerId: other })).toMatchObject({ kind: "idle" });
      // A second machine of the person who approved the run takes it.
      const second = await insertRunner(admin, A.accountId, approver, { credentialMode: "subscription" });
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, approver]);
      await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [second, [A.repoId]]);
      expect(await claims.claimRunnerRun({ accountId: A.accountId, runnerId: second })).toMatchObject({ kind: "claimed", runId: result.childRunId });
    });

    it("both ways: a cloud run (no signed job) moves to a runner from the branch its caller names, and without one nothing is written", async () => {
      const run = await parentRun({ mode: "sandbox" });
      await liveHandoff(run, { from: "cloud", to: "runner", holds: [], prior: "cloud" });
      const sandboxBranch = `fx/${run}-g1`;
      expect(await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false })).toEqual({ kind: "unavailable" });
      expect(await status(run)).toBe("running");
      expect(github.asked).toEqual([]);
      // A branch that is not a plain ref name is refused before GitHub is asked.
      expect(await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false, branch: "has a space" })).toEqual({ kind: "unavailable" });
      expect(github.asked).toEqual([]);
      const result = await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false, branch: sandboxBranch });
      if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
      expect(github.asked).toEqual([{ repo: { id: A.repoId, owner: "acme", name: "app" }, branch: sandboxBranch }]);
      // The new run is on the runner side, in the repo's own runner mode, and has nothing to exclude (the source was not a runner).
      expect(await one("SELECT runtime, execution_mode, excluded_runner_id, initiated_by, approved_by, parent_run_id FROM agent_runs WHERE id = $1", [result.childRunId])).toEqual({ runtime: "runner", execution_mode: "runner_local", excluded_runner_id: null, initiated_by: A.userId, approved_by: approver, parent_run_id: run });
      expect(started).toEqual([{ runId: result.childRunId, toSide: "runner" }]);
    });

    it("reads the head from GitHub and nothing else: a GitHub that cannot answer writes nothing, and the run, the handoff and the holds are as they were", async () => {
      const run = await parentRun();
      await liveHandoff(run);
      github.down = true;
      expect(await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false })).toEqual({ kind: "retry" });
      expect(await status(run)).toBe("running");
      expect(await children(run)).toEqual([]);
      expect(await handoffRow(run)).toMatchObject({ state: "checkpointing", child_run_id: null });
      expect(await holdsOf(run)).toEqual([
        { state: "open", run_id: null },
        { state: "open", run_id: null },
      ]);
      // A branch that does not exist yet is a base of null, not an error.
      github.down = false;
      github.head = null;
      const created = await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false });
      if (created.kind !== "created") throw new Error("expected created");
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.dispatch_base'", [created.childRunId])).payload).toEqual({ head_oid: null });
    });

    it("does nothing for a run with no live handoff, a handoff that is only requested, one not yet due, a run that is not running, and without a GitHub read", async () => {
      const plain = await parentRun();
      expect(await handoffs().completeRunHandoff({ accountId: A.accountId, runId: plain, forced: false })).toEqual({ kind: "none" });
      const requested = await parentRun();
      await liveHandoff(requested, { state: "requested" });
      expect(await handoffs().completeRunHandoff({ accountId: A.accountId, runId: requested, forced: false })).toEqual({ kind: "none" });
      expect(await handoffs().completeRunHandoff({ accountId: A.accountId, runId: requested, forced: true })).toEqual({ kind: "none" });
      expect(await status(requested)).toBe("running");
      const ended = await parentRun();
      await liveHandoff(ended, { holds: [] , to: "runner" });
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [ended]);
      expect(await handoffs().completeRunHandoff({ accountId: A.accountId, runId: ended, forced: false })).toEqual({ kind: "none" });
      const noGithub = await parentRun();
      await liveHandoff(noGithub, { holds: [], to: "runner" });
      expect(await createRunHandoffs(writerPool, { ...ports(), base: null }).completeRunHandoff({ accountId: A.accountId, runId: noGithub, forced: false })).toEqual({ kind: "unavailable" });
      expect(await status(noGithub)).toBe("running");
      expect(github.asked).toEqual([]);
    });

    it("done is fenced to the runner and generation that sent it, and a run with no handoff goes on to the ordinary done", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "runner", holds: [] });
      const h = handoffs();
      expect(await h.completeHandoffOnDone({ accountId: A.accountId, runnerId: runnerA, runId: run, leaseGeneration: 7 })).toMatchObject({ kind: "fenced", reason: "stale_generation" });
      expect(await status(run)).toBe("running");
      expect(await h.completeHandoffOnDone({ accountId: A.accountId, runnerId: runnerA, runId: run, leaseGeneration: 1 })).toEqual({ kind: "completed" });
      expect(await status(run)).toBe("cancelled");
      expect(await h.completeHandoffOnDone({ accountId: A.accountId, runnerId: runnerA, runId: await parentRun(), leaseGeneration: 1 })).toEqual({ kind: "none" });
    });

    it("a run_ended handed_off event with no detail is stored, ends nothing by itself, and finishes the handoff once the batch has committed", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "runner", holds: [] });
      const facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, onHandedOff: (i) => handoffs().completeRunHandoff({ ...i, forced: false }), onError: (_id, error) => void errors.push(error) });
      const batch = (events: object[]) => facade.ingestRunnerEvents({ accountId: A.accountId, runnerId: runnerA, runId: run, leaseGeneration: 1, events: events as never });
      expect(await batch([{ seq: 0, ts: new Date().toISOString(), type: "run_ended", reason: "handed_off" }])).toMatchObject({ outcome: "accepted", stored: 1, ended: null });
      expect(errors).toEqual([]);
      expect(await status(run)).toBe("cancelled");
      expect(await children(run)).toHaveLength(1);
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.event' AND payload->>'type' = 'run_ended'", [run])).payload).toMatchObject({ reason: "handed_off" });
      // The same event again (a replay) neither fails the batch nor makes a second child.
      expect(await batch([{ seq: 0, ts: new Date().toISOString(), type: "run_ended", reason: "handed_off" }])).toMatchObject({ outcome: "fenced" });
      expect(await children(run)).toHaveLength(1);
    });
  });

  describe("two paths at once", () => {
    it("`done` and the sweep firing together make exactly one child (the status move decides, and the 0680 and handoff indexes hold behind it)", async () => {
      const run = await parentRun();
      await liveHandoff(run, { deadlineSecs: -5, reserveSecs: 600 });
      const h = handoffs();
      const results = await Promise.all([
        h.completeHandoffOnDone({ accountId: A.accountId, runnerId: runnerA, runId: run, leaseGeneration: 1 }),
        h.sweepRunHandoffs(),
        h.completeRunHandoff({ accountId: A.accountId, runId: run, forced: true }),
        h.completeRunHandoff({ accountId: A.accountId, runId: run, forced: false }),
      ]);
      expect(results).toHaveLength(4);
      expect(await children(run)).toHaveLength(1);
      expect(await status(run)).toBe("cancelled");
      expect(["handed_off", "forced"]).toContain((await handoffRow(run)).state);
      expect(errors).toEqual([]);
      expect(started).toHaveLength(1);
      // The unique indexes are the backstop: a second live continuation of the same parent seat is refused outright, as is a second key.
      await admin.query("SET session_replication_role = replica");
      await expect(admin.query("INSERT INTO agent_runs (account_id, work_item_id, parent_run_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'runner', 'pending', 'runner_local', $4)", [A.accountId, A.workItemId, run, A.repoId])).rejects.toMatchObject({ code: "23505" });
      await admin.query("SET session_replication_role = DEFAULT");
    });
  });

  describe("the old side after the handoff", () => {
    it("a late heartbeat, ordinary event and git request from the parent's generation are all answered not_running (the lease generation is not bumped; the terminal run is the fence)", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "runner", holds: [] });
      expect(await handoffs().completeHandoffOnDone({ accountId: A.accountId, runnerId: runnerA, runId: run, leaseGeneration: 1 })).toEqual({ kind: "completed" });
      expect(await status(run)).toBe("cancelled");
      const [kid] = await children(run);
      const facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, onError: (_id, error) => void errors.push(error) });
      const late = { accountId: A.accountId, runnerId: runnerA, runId: run, leaseGeneration: 1 };
      expect(await facade.heartbeatRunnerRun(late)).toMatchObject({ verdict: "not_running" });
      const ordinary = [{ seq: 5, ts: new Date().toISOString(), type: "tool_use", tool_name: "Edit" }];
      expect(await facade.ingestRunnerEvents({ ...late, events: ordinary as never })).toMatchObject({ outcome: "fenced", verdict: "not_running" });
      expect((await one("SELECT verdict FROM resolve_runner_git_request($1, $2, $3, 1, $4, false)", [runnerA, A.accountId, run, A.repoId])).verdict).toBe("not_running");
      // Nothing the old side sent landed, and the child is untouched.
      expect(await one("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'runner.event' AND payload->>'type' = 'tool_use'", [run])).toMatchObject({ n: 0 });
      expect(await status(run)).toBe("cancelled");
      expect(await children(run)).toHaveLength(1);
      expect(kid.id).toBeTruthy();
      expect(errors).toEqual([]);
    });
  });

  describe("the deadline sweep", () => {
    it("a checkpointing handoff past its deadline continues from the head GitHub shows, as forced, and the old side is fenced", async () => {
      const run = await parentRun();
      await liveHandoff(run, { deadlineSecs: -1, reserveSecs: 600, to: "runner", holds: [] });
      github.head = "b".repeat(40);
      const sweep = await handoffs().sweepRunHandoffs();
      expect(sweep).toMatchObject({ completed: 1, failed: 0, errors: 0 });
      const [kid] = await children(run);
      expect(await handoffRow(run)).toMatchObject({ state: "forced", child_run_id: kid.id });
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.handoff'", [run])).payload).toMatchObject({ state: "forced" });
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.dispatch_base'", [kid.id])).payload).toEqual({ head_oid: "b".repeat(40) });

      // The old side's lease is gone (the run is terminal), so the git path refuses it at the old generation, whatever its message says.
      const verdict = await one("SELECT verdict FROM resolve_runner_git_request($1, $2, $3, 1, $4, false)", [runnerA, A.accountId, run, A.repoId]);
      expect(verdict.verdict).toBe("not_running");
      const remote = pushFake("b".repeat(40));
      const lateFromOldSide = () => (verdict.verdict === "ok" ? remote.pushWithLease({ expect: "b".repeat(40), to: "c".repeat(40) }) : "push_rejected");
      expect(lateFromOldSide()).toBe("push_rejected");
      expect(remote.head).toBe("b".repeat(40));
      // The child's base is unchanged, and it is the lease its own pushes use: a moved branch is refused, the recorded base is accepted.
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.dispatch_base'", [kid.id])).payload).toEqual({ head_oid: "b".repeat(40) });
      remote.head = "d".repeat(40);
      expect(remote.pushWithLease({ expect: "b".repeat(40), to: "e".repeat(40) })).toBe("push_rejected");
      expect(remote.pushWithLease({ expect: "d".repeat(40), to: "e".repeat(40) })).toBe("ok");
    });

    it("a requested handoff past its deadline is forced too (the state table allows it)", async () => {
      const run = await parentRun();
      await liveHandoff(run, { state: "requested", deadlineSecs: -1, reserveSecs: 600, to: "runner", holds: [] });
      expect(await handoffs().sweepRunHandoffs()).toMatchObject({ completed: 1 });
      expect(await handoffRow(run)).toMatchObject({ state: "forced" });
    });

    it("finishes a checkpointing handoff whose runner said it stopped before the deadline", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "runner", holds: [] });
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'runner.event', $3::jsonb)", [A.accountId, run, JSON.stringify({ type: "run_ended", reason: "handed_off", detail: "pushed" })]);
      expect(await handoffs().sweepRunHandoffs()).toMatchObject({ completed: 1 });
      expect(await handoffRow(run)).toMatchObject({ state: "handed_off" });
    });

    it("leaves a handoff that is not due alone and asks to come back at its deadline", async () => {
      const run = await parentRun();
      await liveHandoff(run, { deadlineSecs: 120, to: "runner", holds: [] });
      const at = Date.now();
      const sweep = await handoffs().sweepRunHandoffs();
      expect(sweep).toMatchObject({ completed: 0, waiting: 1 });
      expect(sweep.nextDueAt).toBeGreaterThan(at + 100_000);
      expect(sweep.nextDueAt).toBeLessThan(at + 140_000);
      expect(await status(run)).toBe("running");
      expect(github.asked).toEqual([]);
    });

    it("releases the holds of a handoff that outlived its reservation window (state released, never deleted), fails it and puts the placement back", async () => {
      const run = await parentRun();
      const handoff = await liveHandoff(run, { deadlineSecs: -10, reserveSecs: -1, to: "cloud", prior: "runner" });
      expect(await handoffs().sweepRunHandoffs()).toMatchObject({ failed: 1, completed: 0 });
      expect(await handoffRow(run)).toMatchObject({ id: handoff, state: "failed", child_run_id: null });
      expect(await holdsOf(run)).toEqual([
        { state: "released", run_id: null },
        { state: "released", run_id: null },
      ]);
      expect((await one("SELECT placement FROM work_items WHERE id = $1", [A.workItemId])).placement).toBe("runner");
      expect(await status(run)).toBe("running");
      expect((await one("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'run.handoff.failed'", [A.accountId])).payload).toMatchObject({ reason: "expired", placement_reverted: true });
    });

    it("fails a handoff whose run ended some other way, and releases what it held", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "cloud" });
      await admin.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [run]);
      expect(await handoffs().sweepRunHandoffs()).toMatchObject({ failed: 1 });
      expect(await handoffRow(run)).toMatchObject({ state: "failed" });
      expect((await holdsOf(run)).map((r) => r.state)).toEqual(["released", "released"]);
    });
  });

  describe("a move that cannot go on", () => {
    it("the 11th continuation is refused with work_item_ceiling: the handoff fails, the holds are released, the parent stays ended and the item is parked", async () => {
      const run = await parentRun();
      for (let i = 0; i < 10; i++) {
        const prior = randomUUID();
        await admin.query("SET session_replication_role = replica");
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, parent_run_id, role, runtime, status, execution_mode, dispatch_repo_id, resolved_exposure, exposure_digest)
           VALUES ($1, $2, $3, $4, 'executor', 'runner', 'failed', 'runner_local', $5, jsonb_build_object('accountId', $2::uuid::text), $6)`,
          [prior, A.accountId, A.workItemId, randomUUID(), A.repoId, "e".repeat(64)],
        );
        await admin.query("SET session_replication_role = DEFAULT");
        await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)", [A.accountId, `prior-${prior}`, prior, HANDOFF_CONTINUE_HASH]);
      }
      expect(Number((await one("SELECT count(*) AS n FROM agent_run_idempotency_keys WHERE account_id = $1", [A.accountId])).n)).toBe(10);
      await liveHandoff(run, { to: "cloud" });
      const result = await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false });
      expect(result).toEqual({ kind: "failed", reason: "work_item_ceiling", workItemId: A.workItemId, branch: `fx/${run}-g1` });
      expect(await children(run)).toEqual([]);
      expect(await status(run)).toBe("cancelled");
      expect(await handoffRow(run)).toMatchObject({ state: "failed" });
      expect((await holdsOf(run)).map((r) => r.state)).toEqual(["released", "released"]);
      expect(parked).toEqual([{ workItemId: A.workItemId, code: "work_item_ceiling" }]);
      expect((await one("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.handoff'", [run])).payload).toEqual({ state: "failed", branch: `fx/${run}-g1` });
    });

    it("a child that cannot start fails the handoff: the child ends failed, the holds that moved to it are released, the placement goes back and the item is parked", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "cloud", prior: "runner" });
      startFails = true;
      const result = await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false });
      expect(result).toEqual({ kind: "failed", reason: "child_not_started", workItemId: A.workItemId, branch: `fx/${run}-g1` });
      const [kid] = await children(run);
      expect(kid.status).toBe("failed");
      expect(await handoffRow(run)).toMatchObject({ state: "failed", child_run_id: kid.id });
      expect(await holdsOf(run)).toEqual([
        { state: "released", run_id: kid.id },
        { state: "released", run_id: kid.id },
      ]);
      expect((await one("SELECT placement FROM work_items WHERE id = $1", [A.workItemId])).placement).toBe("runner");
      expect(parked).toEqual([{ workItemId: A.workItemId, code: "handoff_failed" }]);
      // Written for the item's feed: the branch the work is saved on.
      expect((await rows("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.handoff' ORDER BY seq", [run])).map((r) => r.payload)).toEqual([{ state: "handed_off", branch: `fx/${run}-g1` }, { state: "failed", branch: `fx/${run}-g1` }]);
    });

    it("with no dispatcher configured a child cannot start, so the handoff fails closed the same way", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "runner", holds: [], prior: null });
      const bare = createRunHandoffs(writerPool, { base, park: ports().park, limits: ports().limits, onError: () => undefined });
      expect(await bare.completeRunHandoff({ accountId: A.accountId, runId: run, forced: false })).toMatchObject({ kind: "failed", reason: "child_not_started" });
      expect(await handoffRow(run)).toMatchObject({ state: "failed" });
      expect((await one("SELECT placement FROM work_items WHERE id = $1", [A.workItemId])).placement).toBeNull();
    });
  });

  describe("the stage driver follows the handed-off run to the one that continues it", () => {
    const advance = () => createAdvanceModule(writerPool, { starter: { start: async () => Promise.reject(new Error("unused")) }, resolveRunSeat: async () => Promise.reject(new Error("unused")), startAdvance: null, triage: null });

    it("a handed-off parent reads as its child (pending, not done), and as the child's end once it ends; a run cancelled by a person is the end", async () => {
      const run = await parentRun();
      await liveHandoff(run, { to: "runner", holds: [] });
      const created = await handoffs().completeRunHandoff({ accountId: A.accountId, runId: run, forced: false });
      if (created.kind !== "created") throw new Error("expected created");
      expect(await advance().advanceRunOutcome(A.accountId, run)).toMatchObject({ status: "pending", done: false, tailRunId: created.childRunId });
      await admin.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [created.childRunId]);
      expect(await advance().advanceRunOutcome(A.accountId, run)).toMatchObject({ status: "failed", done: true, tailRunId: created.childRunId });
      const cancelled = await parentRun();
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [cancelled]);
      expect(await advance().advanceRunOutcome(A.accountId, cancelled)).toMatchObject({ status: "cancelled", done: true, tailRunId: cancelled });
    });
  });

  it("the run-view event kind of the runner package and of the feed are the same word", () => {
    expect(RUN_HANDOFF_KIND).toBe(HANDOFF_KIND);
  });

  it("derives a run branch the way done does", () => {
    const j = job("11111111-1111-4111-8111-111111111111");
    expect(runBranchOf(j, j.run_id, 3)).toBe(branchOf(j, { runId: j.run_id, leaseGeneration: 3 }));
    const continued = { ...j, continues: { parent_run_id: randomUUID(), session_id: "s".repeat(36), branch: "fx/11111111-1111-4111-8111-111111111111-g2" } };
    expect(runBranchOf(continued, j.run_id, 3)).toBe(branchOf(continued, { runId: j.run_id, leaseGeneration: 3 }));
  });
});

/** A remote branch that answers a push the way `git push --force-with-lease=<ref>:<expect>` does: only when the branch is still where the pusher last saw it. */
function pushFake(head: string): { head: string; pushWithLease(i: { expect: string; to: string }): "ok" | "push_rejected" } {
  const remote = {
    head,
    pushWithLease(i: { expect: string; to: string }): "ok" | "push_rejected" {
      if (remote.head !== i.expect) return "push_rejected";
      remote.head = i.to;
      return "ok";
    },
  };
  return remote;
}
