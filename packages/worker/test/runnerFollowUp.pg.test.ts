import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RunnerTarget, createJobIssuer, createJobSigner, type ExecutionRun, type ExecutionTarget, type ExecutionTargetRegistry } from "@fx/runner";
import { markBuildNeedsHuman } from "@fx/pipeline";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerLeaseSweeper, type RunnerLeaseSweepResult } from "../src/runnerLeaseSweep.js";
import { createFollowUpPorts, requestFollowUp, type FollowUpPorts, type FollowUpPortsDeps } from "../src/runnerFollowUp.js";
import { createAdvanceModule, FOLLOW_UP_CHAIN_MAX_RUNS } from "../src/advance.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";

/**
 * [pg] D#6 R2b-3 (C21 section 4): the run that follows a lost lease or a usage limit, against the real definer
 * `runner_follow_up_run` (0754), the real sweeper and claim facade, and a real run-writer login.
 */
describe("runner follow-up runs [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  // The definer uses the database clock for the reset-time clamp, so the facade's clock stays near the real one.
  const HOUR = 3_600_000;
  let A: SeedRefs;
  let B: SeedRefs;
  let runnerA: string;
  let runnerB: string;
  let specVersion: string;
  let approver: string;
  let clock = Date.now();
  let nextPr = 100;
  let calls: { dispatched: string[]; failed: { workItemId: string; runId: string; reason: string }[] };
  let ports: FollowUpPorts;

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
    // The sweep is cross-tenant and other files leave running runner runs behind.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, A.accountId, A.userId);
    runnerB = await insertRunner(admin, B.accountId, B.userId);
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerA, [A.repoId]]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    specVersion = randomUUID();
    await admin.query(
      `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, 1, 'spec', $4, 'system')`,
      [specVersion, A.accountId, A.workItemId, sha256Text("spec")],
    );
    approver = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [approver, `${approver}@example.test`]);
    clock = Date.now();
    nextPr = 100;
    calls ={ dispatched: [], failed: [] };
    ports = {
      dispatchChild: async ({ runId }) => void calls.dispatched.push(runId),
      failWorkItem: async ({ workItemId, runId, reason }) => void calls.failed.push({ workItemId, runId, reason }),
    };
  });

  const job = (runId: string, over: Partial<Job> = {}): Job => ({
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
    issued_at: new Date(clock - 1000).toISOString(),
    expires_at: new Date(clock + 72 * HOUR).toISOString(),
    key_id: "k1",
    ...over,
  });

  /** A runner run of account A, inserted past the live-session triggers the way a fixture may. */
  async function run(o: { status?: string; parent?: string | null; runtime?: string; account?: SeedRefs; reasons?: string[]; lease?: number; workItem?: boolean; job?: Partial<Job> } = {}): Promise<string> {
    const account = o.account ?? A;
    const id = randomUUID();
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, parent_run_id, role, runtime, status, execution_mode, dispatch_repo_id, dispatch_pr_number, head_sha, spec_version_id,
                                 resolved_exposure, exposure_digest, initiated_by, approved_by, model, runner_id, lease_generation, lease_expires_at, started_at, job_signed)
         VALUES ($1, $2, $3, $4, 'executor', $5, $6, CASE WHEN $5 = 'runner' THEN 'runner_local' ELSE 'sandbox' END, $7, $15, 'abc123', $8, jsonb_build_object('accountId', $2::uuid::text), $9, $10, $11, 'sonnet-5', $12, 1, to_timestamp($13 / 1000.0), now(), $14::jsonb)`,
        [
          id,
          account.accountId,
          o.workItem === false ? null : account.workItemId,
          o.parent ?? null,
          o.runtime ?? "runner",
          o.status ?? "running",
          account.repoId,
          account === A ? specVersion : null,
          "e".repeat(64),
          account.userId,
          account === A ? approver : null,
          account === A ? runnerA : runnerB,
          o.lease ?? clock - 1,
          JSON.stringify(signJob(job(id, { repo: { id: account.repoId, owner: "acme", name: "app", private: true }, ...o.job }), key)),
          nextPr++,
        ],
      );
      let seq = 1;
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'run.status_changed', $4::jsonb)", [account.accountId, id, seq++, JSON.stringify({ from: "pending", to: "running" })]);
      for (const reason of o.reasons ?? []) {
        await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'run.status_changed', $4::jsonb)", [account.accountId, id, seq++, JSON.stringify({ from: "running", to: "failed", failureReason: reason })]);
      }
    } finally {
      await admin.query("SET session_replication_role = DEFAULT");
    }
    return id;
  }
  const failed = (o: { parent?: string | null; reasons: string[]; account?: SeedRefs; job?: Partial<Job> }) => run({ status: "failed", ...o });
  /** A chain of failed runner runs, top first: each is the parent of the next. Answers the ids, the last being the run that failed most recently. */
  async function chain(reasons: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const reason of reasons) ids.push(await failed({ parent: ids[ids.length - 1] ?? null, reasons: [reason] }));
    return ids;
  }
  const child = async (parent: string) => (await admin.query("SELECT * FROM agent_runs WHERE parent_run_id = $1 /* agent-run-columns: allow admin connection, not app_user */", [parent])).rows;
  const sweep = (over: { followUp?: FollowUpPorts } = {}): Promise<RunnerLeaseSweepResult> => createRunnerLeaseSweeper(writerPool, { now: () => clock, followUp: over.followUp ?? ports }).sweepRunnerLeases();
  const askFor = async (parent: string, account: SeedRefs = A) => withTenant(writerPool, account.accountId, (client) => requestFollowUp(client, parent));

  describe("after a lost lease", () => {
    it("makes a pending child that copies the parent's identity, is claimable at once, and is dispatched after the commit", async () => {
      const parent = await run({ lease: clock - 1 });
      expect(await sweep()).toMatchObject({ lost: 1, followUpsCreated: 1, followUpsExhausted: 0, followUpsFailed: 0 });
      const [c, ...others] = await child(parent);
      expect(others).toEqual([]);
      expect(c).toMatchObject({
        account_id: A.accountId,
        parent_run_id: parent,
        work_item_id: A.workItemId,
        role: "executor",
        runtime: "runner",
        status: "pending",
        execution_mode: "runner_local",
        dispatch_repo_id: A.repoId,
        dispatch_pr_number: String(100),
        head_sha: "abc123",
        spec_version_id: specVersion,
        initiated_by: A.userId,
        approved_by: approver,
        // `model` is the parent's hint in its signed job (checked under the real ports below); the column itself is never written.
        model: null,
        exposure_digest: "e".repeat(64),
        runner_id: null,
        lease_generation: 0,
        lease_expires_at: null,
        claimable_after: null,
        job_signed: null,
      });
      expect(c.id).not.toBe(parent);
      expect(calls.dispatched).toEqual([c.id]);
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [parent])).rows[0].status).toBe("failed");
    });

    it("the child commits with the status move or not at all: a follow-up that fails leaves the run running and no child behind", async () => {
      const parent = await run({ lease: clock - 1 });
      // A pool of its own, so the patched clients are never handed to another test.
      const own = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
      const failing = {
        query: own.query.bind(own),
        connect: async () => {
          const client = await own.connect();
          const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = (...args: unknown[]) =>
            typeof args[0] === "string" && args[0].includes("runner_follow_up_run") ? Promise.reject(new Error("follow-up unavailable")) : original(...args);
          return client;
        },
      } as unknown as Pool;
      const errors: string[] = [];
      const result = await createRunnerLeaseSweeper(failing, { now: () => clock, followUp: ports, onError: (runId) => errors.push(runId) }).sweepRunnerLeases();
      await own.end();
      expect(result).toMatchObject({ leasesFailed: 1, lost: 0, followUpsCreated: 0 });
      expect(errors).toEqual([parent]);
      expect(await child(parent)).toEqual([]);
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [parent])).rows[0].status).toBe("running");
      expect(calls.dispatched).toEqual([]);
    });

    it("a child that is claimable at once is handed to the next runner (it has a job once dispatched)", async () => {
      const parent = await run({ lease: clock - 1 });
      await sweep();
      const [c] = await child(parent);
      await admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [c.id, JSON.stringify(signJob(job(c.id), key))]);
      const facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
      expect(await facade.claimRunnerRun({ accountId: A.accountId, runnerId: runnerA })).toMatchObject({ kind: "claimed", runId: c.id, leaseGeneration: 1 });
    });

    it("a second loss fails the work item instead of making a child", async () => {
      const first = await run({ lease: clock - 1 });
      await sweep();
      const [second] = await child(first);
      // The child is claimed by a runner and lost in its turn.
      await admin.query("SET session_replication_role = replica");
      await admin.query("UPDATE agent_runs SET status = 'running', runner_id = $2, lease_generation = 1, lease_expires_at = to_timestamp($3 / 1000.0), started_at = now() WHERE id = $1", [second.id, runnerA, clock - 1]);
      await admin.query("SET session_replication_role = DEFAULT");
      calls.dispatched.length = 0;
      expect(await sweep()).toMatchObject({ lost: 1, followUpsCreated: 0, followUpsExhausted: 1 });
      expect(await child(second.id)).toEqual([]);
      expect(calls.dispatched).toEqual([]);
      expect(calls.failed).toEqual([{ workItemId: A.workItemId, runId: second.id, reason: "runner_lost" }]);
    });

    it("a usage limit never counts toward the two losses", async () => {
      const lost = await failed({ reasons: ["runner_lost"] });
      const limited = await failed({ parent: lost, reasons: ["usage_limit"] });
      expect(await askFor(limited)).toMatchObject({ kind: "created" });
      const onlyLimits = await failed({ parent: await failed({ reasons: ["usage_limit"] }), reasons: ["usage_limit", "runner_lost"] });
      expect(await askFor(onlyLimits)).toMatchObject({ kind: "created" });
      // Two losses anywhere in the chain exhaust it, with usage limits in between.
      const chainTop = await failed({ reasons: ["runner_lost"] });
      const chainMid = await failed({ parent: chainTop, reasons: ["usage_limit"] });
      const chainEnd = await failed({ parent: chainMid, reasons: ["runner_lost"] });
      expect(await askFor(chainEnd)).toEqual({ kind: "exhausted", workItemId: A.workItemId, reason: "runner_lost" });
      expect(await child(chainEnd)).toEqual([]);
    });
  });

  describe("the definer re-derives everything from the parent", () => {
    it("answers exists for a parent that already has its child, and makes one child only", async () => {
      const parent = await failed({ reasons: ["runner_lost"] });
      const made = await askFor(parent);
      expect(made.kind).toBe("created");
      const again = await askFor(parent);
      expect(again).toMatchObject({ kind: "exists", childRunId: (made as { childRunId: string }).childRunId });
      expect(await child(parent)).toHaveLength(1);
    });

    it("a unique index on parent_run_id for runner runs decides a race the definer's own check would lose", async () => {
      const parent = await failed({ reasons: ["runner_lost"] });
      const made = (await askFor(parent)) as { childRunId: string };
      // 0680 already allows one LIVE continuation per parent and role; once the child is over, this index is what stops a second.
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [made.childRunId]);
      await expect(
        admin.query(`INSERT INTO agent_runs (account_id, parent_run_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local')`, [A.accountId, parent]),
      ).rejects.toMatchObject({ code: "23505", constraint: "agent_runs_runner_follow_up_key" });
    });

    it("makes nothing for a run that did not end failed for runner_lost or usage_limit", async () => {
      const others = [
        await failed({ reasons: ["credential_mismatch"] }),
        await failed({ reasons: ["queue_ttl"] }),
        await failed({ reasons: [] }),
        await run({ status: "timed_out" }),
        await run({ status: "cancelled" }),
        await run({ status: "running" }),
        await run({ status: "pending" }),
        await run({ status: "failed", runtime: "production", reasons: ["runner_lost"] }),
        randomUUID(),
      ];
      for (const parent of others) expect(await askFor(parent), parent).toEqual({ kind: "not_eligible" });
      expect(await admin.query("SELECT 1 FROM agent_runs WHERE parent_run_id = ANY($1::uuid[])", [others])).toHaveProperty("rowCount", 0);
    });

    it("reads the parent under the session's tenant only: another tenant's failed run is not eligible", async () => {
      const theirs = await failed({ reasons: ["runner_lost"], account: B });
      expect(await askFor(theirs, A)).toEqual({ kind: "not_eligible" });
      expect(await child(theirs)).toEqual([]);
    });

    it("makes no child for a halted work item (0750), and leaves the failed parent as it is", async () => {
      const parent = await failed({ reasons: ["runner_lost"] });
      await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1", [A.workItemId, randomUUID()]);
      expect(await askFor(parent)).toEqual({ kind: "halted" });
      expect(await child(parent)).toEqual([]);
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [parent])).rows[0].status).toBe("failed");
      await admin.query("UPDATE work_items SET halted_at = NULL, halt_action_id = NULL WHERE id = $1", [A.workItemId]);
      expect(await askFor(parent)).toMatchObject({ kind: "created" });
    });

    it("makes no child when the pull request already has another live executor (the one-live-executor index)", async () => {
      const parent = await failed({ reasons: ["usage_limit"] });
      await admin.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [parent]);
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, dispatch_pr_number) SELECT account_id, work_item_id, role, 'runner', 'pending', 'runner_local', dispatch_repo_id, dispatch_pr_number FROM agent_runs WHERE id = $1`,
        [parent],
      );
      await admin.query("SET session_replication_role = DEFAULT");
      expect(await askFor(parent)).toEqual({ kind: "not_eligible" });
      expect(await child(parent)).toEqual([]);
    });

    it("a cancelled child creates no grandchild", async () => {
      const parent = await failed({ reasons: ["usage_limit"] });
      const made = (await askFor(parent)) as { childRunId: string };
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [made.childRunId]);
      expect(await askFor(made.childRunId)).toEqual({ kind: "not_eligible" });
      expect(await child(made.childRunId)).toEqual([]);
    });

    it("is not callable by the web tier's logins or an unrelated session, and refuses a session with no tenant", async () => {
      const app = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
      const ops = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
      const parent = await failed({ reasons: ["runner_lost"] });
      try {
        await expect(app.query("SELECT * FROM runner_follow_up_run($1)", [parent])).rejects.toThrow(/permission denied/);
        await expect(ops.query("SELECT * FROM runner_follow_up_run($1)", [parent])).rejects.toThrow(/permission denied/);
        await expect(writerPool.query("SELECT * FROM runner_follow_up_run($1)", [parent])).rejects.toThrow(/no active tenant context/);
      } finally {
        await app.end();
        await ops.end();
      }
      expect(await child(parent)).toEqual([]);
    });
  });

  describe("the loss is recorded whatever the create step does (C22 section 8)", () => {
    /** The run's initiator is no longer a member of the account (agent_run_create then refuses with 42501). The runner itself is untouched. */
    async function initiatorLeaves(runId: string): Promise<void> {
      const gone = randomUUID();
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [gone, `${gone}@example.test`]);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("UPDATE agent_runs SET initiated_by = $2 WHERE id = $1", [runId, gone]);
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
    }
    it("a user who started the run and has since left the account: the run still ends failed, on the first sweep, with no child, and the slot is free", async () => {
      const parent = await run({ lease: clock - 1 });
      await initiatorLeaves(parent);
      expect(await sweep()).toMatchObject({ leasesListed: 1, lost: 1, followUpsCreated: 0, followUpsFailed: 0, leasesFailed: 0 });
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [parent])).rows[0].status).toBe("failed");
      expect(await child(parent)).toEqual([]);
      // The second sweep has nothing left to do for it: the run is not stuck `running` and is not retried.
      expect(await sweep()).toMatchObject({ leasesListed: 0, lost: 0, leasesFailed: 0 });
      expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND runtime = 'runner' AND status = 'running'", [A.accountId])).rows[0].n).toBe(0);
      expect(calls.dispatched).toEqual([]);
    });

    it("the same for a usage limit: the events batch is accepted, the run is failed and no child is made", async () => {
      const id = await run({ lease: clock + 60_000 });
      await initiatorLeaves(id);
      const f = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, followUp: ports });
      const out = await f.ingestRunnerEvents({ accountId: A.accountId, runnerId: runnerA, runId: id, leaseGeneration: 1, events: [{ seq: 0, ts: new Date(clock).toISOString(), type: "usage_limit_reached" }] });
      expect(out).toMatchObject({ outcome: "accepted", stored: 1, ended: "usage_limit" });
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status).toBe("failed");
      expect(await child(id)).toEqual([]);
    });

    it("answers not_eligible for a create that was refused, leaving no partial child behind", async () => {
      const parent = await failed({ reasons: ["runner_lost"] });
      await initiatorLeaves(parent);
      expect(await askFor(parent)).toEqual({ kind: "not_eligible" });
      expect(await child(parent)).toEqual([]);
    });
  });

  describe("the follow-up chain the allowances count (C22 sections 4 and 5)", () => {
    it("a fix round is a new attempt: its build parent's earlier loss does not count, so its own first loss makes a child", async () => {
      const [build] = await chain(["runner_lost"]);
      const recovered = await run({ status: "succeeded", parent: build });
      const fix = await failed({ parent: recovered, reasons: ["runner_lost"] });
      expect(await askFor(fix)).toMatchObject({ kind: "created" });
    });

    it("the fix round's second loss exhausts it, and says runner_lost", async () => {
      const [build] = await chain(["runner_lost"]);
      const recovered = await run({ status: "succeeded", parent: build });
      const fix1 = await failed({ parent: recovered, reasons: ["runner_lost"] });
      const second = await failed({ parent: fix1, reasons: ["runner_lost"] });
      expect(await askFor(second)).toEqual({ kind: "exhausted", workItemId: A.workItemId, reason: "runner_lost" });
      expect(await child(second)).toEqual([]);
    });

    it("the walk stops at a parent that ended for another reason, or that is not a runner run", async () => {
      const internal = await failed({ reasons: ["internal_error"] });
      const lostUnderInternal = await failed({ parent: internal, reasons: ["runner_lost"] });
      const lostAbove = await failed({ reasons: ["runner_lost"] });
      await admin.query("UPDATE agent_runs SET parent_run_id = $2 WHERE id = $1", [internal, lostAbove]);
      // The loss above the internal_error run is not reached through it.
      expect(await askFor(lostUnderInternal)).toMatchObject({ kind: "created" });
      const productionParent = await run({ status: "failed", runtime: "production", reasons: ["runner_lost"] });
      const underProduction = await failed({ parent: productionParent, reasons: ["runner_lost"] });
      expect(await askFor(underProduction)).toMatchObject({ kind: "created" });
    });

    it("the eighth usage limit in one chain makes no child and says usage_limit; the seventh still does", async () => {
      const seven = await chain(Array(7).fill("usage_limit"));
      expect(await askFor(seven[6]!)).toMatchObject({ kind: "created" });
      const eight = await chain(Array(8).fill("usage_limit"));
      expect(await askFor(eight[7]!)).toEqual({ kind: "exhausted", workItemId: A.workItemId, reason: "usage_limit" });
      expect(await child(eight[7]!)).toEqual([]);
    });

    it("usage limits and losses are counted apart: seven usage limits then a first loss still gets a child", async () => {
      const ids = await chain([...Array(7).fill("usage_limit"), "runner_lost"]);
      expect(await askFor(ids[7]!)).toMatchObject({ kind: "created" });
    });

    it("the walk looks at 16 runs and no more: a loss 16 runs up counts, a loss 17 runs up does not", async () => {
      const within = await chain(["runner_lost", ...Array(14).fill("usage_limit"), "runner_lost"]);
      expect(within).toHaveLength(16);
      expect(await askFor(within[15]!)).toMatchObject({ kind: "exhausted", reason: "runner_lost" });
      const beyond = await chain(["runner_lost", ...Array(15).fill("usage_limit"), "runner_lost"]);
      expect(beyond).toHaveLength(17);
      expect(await askFor(beyond[16]!)).toMatchObject({ kind: "created" });
    });

    it("the parent read names the session's tenant itself, not only through the row policy (the definer's source is pinned)", async () => {
      // Row security already hides a foreign row from the locking read, so no outcome and no lock can tell the filter from its absence;
      // the source is what pins it. Removing the account filter makes this fail.
      const { rows } = await admin.query("SELECT pg_get_functiondef('runner_follow_up_run(uuid)'::regprocedure) AS def");
      expect(String(rows[0].def)).toMatch(/WHERE a\.account_id = v_acct AND a\.id = p_parent_run_id\s+FOR UPDATE/);
    });

    it("reads the parent under the tenant filter: a foreign tenant's failed run is not locked by the call (lock probe)", async () => {
      const theirs = await failed({ reasons: ["runner_lost"], account: B });
      const holder = await adminPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE", [theirs]);
        // If the definer reached for the foreign row it would wait on the holder's lock and hit this timeout.
        const answer = await withTenant(writerPool, A.accountId, async (client) => {
          await client.query("SET LOCAL lock_timeout = '300ms'");
          return requestFollowUp(client, theirs);
        });
        expect(answer).toEqual({ kind: "not_eligible" });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });
  });

  describe("after a usage limit", () => {
    const facade = () => createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min, followUp: ports });
    const limit = async (resetAt: string | undefined) => {
      const id = await run({ lease: clock + 60_000 });
      const event = { seq: 0, ts: new Date(clock).toISOString(), type: "usage_limit_reached" as const, ...(resetAt === undefined ? {} : { reset_at: resetAt }) };
      const out = await facade().ingestRunnerEvents({ accountId: A.accountId, runnerId: runnerA, runId: id, leaseGeneration: 1, events: [event] });
      expect(out).toMatchObject({ outcome: "accepted", ended: "usage_limit" });
      const [c] = await child(id);
      return { parent: id, child: c };
    };
    const after = async (childRow: { claimable_after: Date | null }) => {
      const { rows } = await admin.query("SELECT extract(epoch FROM now()) * 1000 AS now");
      return childRow.claimable_after!.getTime() - Number(rows[0].now);
    };

    it("waits until the reset time the runner reported", async () => {
      const reset = new Date(Date.now() + 5 * HOUR);
      const { child: c } = await limit(reset.toISOString());
      expect(c.claimable_after.getTime()).toBe(reset.getTime());
      expect(c.status).toBe("pending");
    });

    it("holds a reset time to between now and 24 hours from now, and falls back to an hour when none was reported", async () => {
      expect(await after((await limit(new Date(Date.now() + 100 * HOUR).toISOString())).child)).toBeGreaterThan(24 * HOUR - 60_000);
      expect(await after((await limit(new Date(Date.now() + 100 * HOUR).toISOString())).child)).toBeLessThanOrEqual(24 * HOUR);
      expect(Math.abs(await after((await limit(new Date(Date.now() - 5 * HOUR).toISOString())).child))).toBeLessThan(60_000);
      const none = await after((await limit(undefined)).child);
      expect(none).toBeGreaterThan(HOUR - 60_000);
      expect(none).toBeLessThanOrEqual(HOUR);
    });

    it("an unreadable reset time stored in the event falls back to an hour instead of failing the batch", async () => {
      const id = await run({ lease: clock + 60_000, status: "failed", reasons: ["usage_limit"] });
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 9, 'runner.event', '{"type":"usage_limit_reached","reset_at":"not a time"}')`, [A.accountId, id]);
      const made = (await askFor(id)) as { childRunId: string };
      const [c] = await child(id);
      expect(c.id).toBe(made.childRunId);
      const wait = await after(c);
      expect(wait).toBeGreaterThan(HOUR - 60_000);
      expect(wait).toBeLessThanOrEqual(HOUR);
    });

    it("is not claimable before the reset time, claimable from it, and does not shorten the idle poll while it waits", async () => {
      const reset = Date.now() + 2 * HOUR;
      const { child: c } = await limit(new Date(reset).toISOString());
      await admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [c.id, JSON.stringify(signJob(job(c.id), key))]);
      const f = facade();
      clock = reset - 1;
      expect(await f.claimRunnerRun({ accountId: A.accountId, runnerId: runnerA })).toEqual({ kind: "idle", retryAfter: 60 });
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [c.id])).rows[0].status).toBe("pending");
      clock = reset;
      expect(await f.claimRunnerRun({ accountId: A.accountId, runnerId: runnerA })).toMatchObject({ kind: "claimed", runId: c.id });
    });

    it("the claim definer itself refuses a run held back until a later time", async () => {
      const reset = Date.now() + 2 * HOUR;
      const { child: c } = await limit(new Date(reset).toISOString());
      // `pending -> running` is the compare-and-set writer's job; the fixture moves it as the superuser so only the definer is under test.
      await admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [c.id]);
      const claimWith = (now: number) =>
        withTenant(writerPool, A.accountId, async (client) => {
          const claimed = await client.query<{ generation: number | null }>("SELECT agent_run_runner_claim($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, 90) AS generation", [A.accountId, c.id, runnerA, new Date(now)]);
          return claimed.rows[0]!.generation;
        });
      expect(await claimWith(reset - 1)).toBeNull();
      expect(await claimWith(reset)).toBe(1);
    });

    it("dispatches the child after the commit, and a dispatch that fails does not fail the accepted batch", async () => {
      const errors: string[] = [];
      ports = { ...ports, dispatchChild: async () => Promise.reject(new Error("no signer")) };
      const id = await run({ lease: clock + 60_000 });
      const f = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, followUp: ports, onError: (runId) => errors.push(runId) });
      const out = await f.ingestRunnerEvents({ accountId: A.accountId, runnerId: runnerA, runId: id, leaseGeneration: 1, events: [{ seq: 0, ts: new Date(clock).toISOString(), type: "usage_limit_reached" }] });
      expect(out).toMatchObject({ outcome: "accepted", stored: 1, ended: "usage_limit" });
      expect(errors).toEqual([id]);
      expect(await child(id)).toHaveLength(1);
    });

    it("a credential mismatch makes no follow-up", async () => {
      const id = await run({ lease: clock + 60_000 });
      const out = await createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, followUp: ports }).ingestRunnerEvents({
        accountId: A.accountId,
        runnerId: runnerA,
        runId: id,
        leaseGeneration: 1,
        events: [{ seq: 0, ts: new Date(clock).toISOString(), type: "credential_mismatch" }],
      });
      expect(out).toMatchObject({ outcome: "accepted", ended: "credential_mismatch" });
      expect(await child(id)).toEqual([]);
      expect(calls.dispatched).toEqual([]);
    });
  });

  describe("a pending runner run with no job (C22 section 3)", () => {
    const MIN = 60_000;
    /** A follow-up child with no job. Answers its id and when it was made (database clock); the sweeper's clock is then set relative to that. */
    async function jobless(): Promise<{ id: string; made: number }> {
      const parent = await failed({ reasons: ["runner_lost"] });
      const made = (await askFor(parent)) as { childRunId: string };
      const { rows } = await admin.query("SELECT extract(epoch FROM created_at) * 1000 AS ms FROM agent_runs WHERE id = $1", [made.childRunId]);
      return { id: made.childRunId, made: Math.floor(Number(rows[0].ms)) };
    }
    const statusOf = async (id: string) => (await admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status as string;
    const setJob = (id: string) => admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [id, JSON.stringify(signJob(job(id), key))]);

    it("is left alone at one minute, its dispatch is tried again once at two minutes, and it is failed internal_error at fifteen", async () => {
      const { id, made } = await jobless();
      clock = made + 1 * MIN;
      expect(await sweep()).toMatchObject({ joblessRetried: 0, joblessFailed: 0, nextDueAt: made + 2 * MIN });
      expect(calls.dispatched).toEqual([]);

      clock = made + 2 * MIN;
      expect(await sweep()).toMatchObject({ joblessRetried: 1, joblessFailed: 0, nextDueAt: made + 15 * MIN });
      expect(calls.dispatched).toEqual([id]);
      expect(await statusOf(id)).toBe("pending");

      clock = made + 15 * MIN;
      calls.dispatched.length = 0;
      expect(await sweep()).toMatchObject({ joblessRetried: 0, joblessFailed: 1 });
      expect(calls.dispatched).toEqual([]);
      expect(await statusOf(id)).toBe("failed");
      expect((await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq DESC LIMIT 1", [id])).rows[0].payload).toEqual({ from: "pending", to: "failed", failureReason: "internal_error" });
    });

    it("a first run (no parent) is not retried, and is failed at fifteen minutes too", async () => {
      const id = await run({ status: "pending", lease: clock });
      await admin.query("SET session_replication_role = replica");
      await admin.query("UPDATE agent_runs SET job_signed = NULL, runner_id = NULL, lease_generation = 0, lease_expires_at = NULL, started_at = NULL WHERE id = $1", [id]);
      await admin.query("SET session_replication_role = DEFAULT");
      const { rows } = await admin.query("SELECT extract(epoch FROM created_at) * 1000 AS ms FROM agent_runs WHERE id = $1", [id]);
      const made = Math.floor(Number(rows[0].ms));
      clock = made + 14 * MIN;
      expect(await sweep()).toMatchObject({ joblessRetried: 0, joblessFailed: 0, nextDueAt: made + 15 * MIN });
      expect(calls.dispatched).toEqual([]);
      clock = made + 15 * MIN;
      expect(await sweep()).toMatchObject({ joblessFailed: 1 });
      expect(await statusOf(id)).toBe("failed");
    });

    /** A pending runner run with no job and the given parent, made the way the resume and retry paths make theirs (inserted, then dispatched). */
    async function joblessChildOf(parent: string): Promise<{ id: string; made: number }> {
      const id = await run({ status: "pending", parent, lease: clock });
      await admin.query("SET session_replication_role = replica");
      await admin.query("UPDATE agent_runs SET job_signed = NULL, runner_id = NULL, lease_generation = 0, lease_expires_at = NULL, started_at = NULL WHERE id = $1", [id]);
      await admin.query("SET session_replication_role = DEFAULT");
      const { rows } = await admin.query("SELECT extract(epoch FROM created_at) * 1000 AS ms FROM agent_runs WHERE id = $1", [id]);
      return { id, made: Math.floor(Number(rows[0].ms)) };
    }
    /** `n` pending runner runs of account B that HAVE their job, created `ageMs` before now (a queue of runs waiting for offline runners). */
    async function queuedWithJob(n: number, ageMs: number): Promise<void> {
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, job_signed, created_at)
           SELECT gen_random_uuid(), $1, 'executor', 'runner', 'pending', 'runner_local', '{"job":{}}'::jsonb, now() - ($3::bigint * interval '1 millisecond') + g * interval '1 millisecond'
             FROM generate_series(1, $2::int) g`,
          [B.accountId, n, ageMs],
        );
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
    }

    it("is not starved by other accounts' queued runs that have a job: with 60 older ones waiting, the jobless child is still retried at two minutes and failed internal_error at fifteen", async () => {
      const { id, made } = await jobless();
      await queuedWithJob(60, 2 * 24 * HOUR);
      clock = made + 2 * MIN;
      expect(await sweep()).toMatchObject({ joblessRetried: 1, joblessFailed: 0, joblessErrors: 0 });
      expect(calls.dispatched).toEqual([id]);
      clock = made + 15 * MIN;
      calls.dispatched.length = 0;
      expect(await sweep()).toMatchObject({ joblessRetried: 0, joblessFailed: 1 });
      expect(await statusOf(id)).toBe("failed");
      expect((await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq DESC LIMIT 1", [id])).rows[0].payload).toEqual({ from: "pending", to: "failed", failureReason: "internal_error" });
      // The queued runs that have their job are nobody's to fail here.
      expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND status = 'pending' AND job_signed IS NOT NULL", [B.accountId])).rows[0].n).toBe(60);
    });

    it("lists only pending runner runs with no job, to the run-writer login only", async () => {
      const { id } = await jobless();
      await queuedWithJob(3, 3 * HOUR);
      const listed = await writerPool.query<{ run_id: string }>("SELECT run_id FROM agent_run_list_jobless_runner_runs(50)");
      expect(listed.rows.map((r) => r.run_id)).toEqual([id]);
      await expect(writerPool.query("SELECT * FROM agent_run_list_jobless_runner_runs(0)")).rejects.toThrow(/bad limit/);
      await expect(writerPool.query("SELECT * FROM agent_run_list_jobless_runner_runs(51)")).rejects.toThrow(/bad limit/);
      const app = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
      const ops = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
      try {
        await expect(app.query("SELECT * FROM agent_run_list_jobless_runner_runs(10)")).rejects.toThrow(/permission denied/);
        await expect(ops.query("SELECT * FROM agent_run_list_jobless_runner_runs(10)")).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
        await ops.end();
      }
    });

    it("a full batch of jobless runs that were failed asks for another tick at once", async () => {
      for (let i = 0; i < 50; i++) await joblessChildOf(await failed({ reasons: ["internal_error"] }));
      clock = Date.now() + 16 * MIN;
      const result = await sweep();
      expect(result).toMatchObject({ joblessFailed: 50, joblessErrors: 0, nextDueAt: clock });
    });

    it("retries a jobless child only when its parent is a failed runner run that ended runner_lost or usage_limit", async () => {
      const lost = await joblessChildOf(await failed({ reasons: ["runner_lost"] }));
      const limited = await joblessChildOf(await failed({ reasons: ["usage_limit"] }));
      // A fix-round resume run or a retry: a parent that failed for another reason, one that succeeded, one still running, and one whose LAST move to failed was another reason.
      const afterOther = await joblessChildOf(await failed({ reasons: ["internal_error"] }));
      const afterDone = await joblessChildOf(await run({ status: "succeeded" }));
      const afterRunning = await joblessChildOf(await run({ status: "running", lease: clock + HOUR }));
      const lastMove = await joblessChildOf(await failed({ reasons: ["runner_lost", "internal_error"] }));
      const all = [lost, limited, afterOther, afterDone, afterRunning, lastMove];
      clock = Math.max(...all.map((c) => c.made)) + 3 * MIN;
      expect(await sweep()).toMatchObject({ joblessRetried: 2, joblessFailed: 0, joblessErrors: 0 });
      expect(calls.dispatched.sort()).toEqual([lost.id, limited.id].sort());
      // The others keep the failure at fifteen minutes, and are not dispatched then either.
      calls.dispatched.length = 0;
      clock = Math.max(...all.map((c) => c.made)) + 16 * MIN;
      expect(await sweep()).toMatchObject({ joblessRetried: 0, joblessFailed: 6 });
      expect(calls.dispatched).toEqual([]);
      for (const c of all) expect(await statusOf(c.id)).toBe("failed");
    });

    it("a child whose job is already written is not retried and not failed, however old it is", async () => {
      const { id, made } = await jobless();
      await setJob(id);
      clock = made + 20 * MIN;
      expect(await sweep()).toMatchObject({ joblessRetried: 0, joblessFailed: 0 });
      expect(calls.dispatched).toEqual([]);
      expect(await statusOf(id)).toBe("pending");
    });

    it("a retry that finds the job already written (the first dispatch was only slow) does nothing: the real port leaves the child pending", async () => {
      const { id, made } = await jobless();
      const target = {
        runtime: "runner",
        dispatch: async () => {
          await setJob(id);
          throw new Error("job issuer: job_not_recorded");
        },
      } as unknown as ExecutionTarget;
      const real = createFollowUpPorts({ pool: writerPool, registry: { runner_local: target }, buildFailed: async () => ({ status: "recorded", stage: "needs_human" }) });
      clock = made + 3 * MIN;
      expect(await sweep({ followUp: real })).toMatchObject({ joblessRetried: 1, joblessFailed: 0, joblessErrors: 0, leasesFailed: 0 });
      expect(await statusOf(id)).toBe("pending");
    });

    it("a retry the real port cannot do fails the child, and the tick reports it", async () => {
      const { id, made } = await jobless();
      const target = { runtime: "runner", dispatch: async () => Promise.reject(new Error("job issuer: job_invalid")) } as unknown as ExecutionTarget;
      const real = createFollowUpPorts({ pool: writerPool, registry: { runner_local: target }, buildFailed: async () => ({ status: "recorded", stage: "needs_human" }) });
      const errors: string[] = [];
      clock = made + 3 * MIN;
      const result = await createRunnerLeaseSweeper(writerPool, { now: () => clock, followUp: real, onError: (runId) => errors.push(runId) }).sweepRunnerLeases();
      expect(result).toMatchObject({ joblessRetried: 0, joblessErrors: 1, leasesFailed: 0 });
      expect(errors).toEqual([id]);
      expect(await statusOf(id)).toBe("failed");
    });

    it("a jobless run does not shorten the idle poll of any runner in the account (the claim's idle query counts only runs with a job)", async () => {
      const { id } = await jobless();
      // A runner that may take nothing only learns how long to wait.
      await admin.query("UPDATE runners SET allowed_repo_ids = '{}' WHERE id = $1", [runnerA]);
      const f = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
      expect(await f.claimRunnerRun({ accountId: A.accountId, runnerId: runnerA })).toEqual({ kind: "idle", retryAfter: 60 });
      // Once the job is there, the same run is work a runner could take: the poll shortens.
      await setJob(id);
      expect(await f.claimRunnerRun({ accountId: A.accountId, runnerId: runnerA })).toEqual({ kind: "idle", retryAfter: 5 });
    });

    it("marks the sweeper due two minutes after a child is made, so the retry does not wait for the backstop tick", async () => {
      const marks = new Map<string, number>();
      setPendingHooks({ store: { get: async (k) => marks.get(k), set: async (k, v) => void marks.set(k, v), delete: async (k) => void marks.delete(k) } });
      try {
        const parent = await run({ lease: clock - 1 });
        const before = Date.now();
        await sweep();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const due = [...marks].filter(([k]) => k.includes("runner-sweeper")).map(([, v]) => v);
        expect(due.some((t) => t >= before + 2 * MIN && t < before + 3 * MIN)).toBe(true);
        expect(await child(parent)).toHaveLength(1);
      } finally {
        setPendingHooks(null);
      }
    });
  });

  describe("the stage driver follows the follow-up chain (C22 sections 5 and 7)", () => {
    const advance = () => createAdvanceModule(writerPool, { starter: { start: async () => Promise.reject(new Error("unused")) }, resolveRunSeat: async () => Promise.reject(new Error("unused")), startAdvance: null, triage: null });
    const outcome = (id: string, account: SeedRefs = A) => advance().advanceRunOutcome(account.accountId, id);
    /** Links a chain: each run's child is the next. Answers the ids top first. */
    async function linked(reasons: Array<string | "pending" | "running">): Promise<string[]> {
      const ids: string[] = [];
      for (const r of reasons) {
        const parent = ids[ids.length - 1] ?? null;
        ids.push(r === "pending" || r === "running" ? await run({ status: r, parent, lease: clock + 60_000 }) : await failed({ parent, reasons: [r] }));
      }
      return ids;
    }

    it("a first loss is not the end: the outcome is the follow-up's, pending on a runner, with the child as the run to cancel", async () => {
      const parent = await run({ lease: clock - 1 });
      await sweep();
      const [c] = await child(parent);
      expect(await outcome(parent)).toEqual({ status: "pending", done: false, envelope: null, runtime: "runner", tailRunId: c.id, failureReason: null });
      // The child is claimed and runs: still not done.
      await admin.query("SET session_replication_role = replica");
      await admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [c.id]);
      await admin.query("SET session_replication_role = DEFAULT");
      expect(await outcome(parent)).toMatchObject({ status: "running", done: false, tailRunId: c.id });
    });

    it("a usage limit is not the end either", async () => {
      const [limited, next] = await linked(["usage_limit", "pending"]);
      expect(await outcome(limited!)).toMatchObject({ status: "pending", done: false, tailRunId: next });
    });

    it("the second loss is final: done, failed, runner_lost, and the item is failed exactly once (the sweeper and the driver write the same code)", async () => {
      await admin.query("UPDATE work_items SET stage = 'in_progress' WHERE id = $1", [A.workItemId]);
      const first = await run({ lease: clock - 1 });
      await sweep();
      const [second] = await child(first);
      expect(await outcome(first)).toMatchObject({ status: "pending", done: false });
      await admin.query("SET session_replication_role = replica");
      await admin.query("UPDATE agent_runs SET status = 'running', runner_id = $2, lease_generation = 1, lease_expires_at = to_timestamp($3 / 1000.0), started_at = now() WHERE id = $1", [second.id, runnerA, clock - 1]);
      await admin.query("SET session_replication_role = DEFAULT");
      const real = createFollowUpPorts({ pool: writerPool, registry: {}, buildFailed: (a, w, r, c) => markBuildNeedsHuman(writerPool, a, w, r, c) });
      expect(await sweep({ followUp: real })).toMatchObject({ lost: 1, followUpsExhausted: 1, followUpsFailed: 0 });
      const end = await outcome(first);
      expect(end).toEqual({ status: "failed", done: true, envelope: null, runtime: "runner", tailRunId: second.id, failureReason: "runner_lost" });
      // The driver's write, for the same run and code, finds the item already failed by the sweeper.
      expect(await markBuildNeedsHuman(writerPool, A.accountId, A.workItemId, end.tailRunId!, "runner_lost")).toEqual({ status: "unchanged", stage: "needs_human" });
      const rows = (await admin.query("SELECT source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'needs_human'", [A.workItemId])).rows;
      expect(rows).toEqual([{ source_ref: `build_failed:runner_lost:${second.id}` }]);
    });

    it("a failed run with no child is final whatever the reason: a chain whose follow-up could not be made ends the item", async () => {
      const lost = await failed({ reasons: ["runner_lost"] });
      expect(await outcome(lost)).toMatchObject({ status: "failed", done: true, tailRunId: lost, failureReason: "runner_lost" });
    });

    it("only the two follow-up reasons are followed: a failed run that ended for another reason, or that is not a runner run, is read as it stands", async () => {
      const [internal] = await linked(["internal_error", "pending"]);
      expect(await outcome(internal!)).toMatchObject({ status: "failed", done: true, tailRunId: internal, failureReason: "internal_error" });
      const production = await run({ status: "failed", runtime: "production", reasons: ["runner_lost"] });
      await run({ status: "pending", parent: production });
      expect(await outcome(production)).toMatchObject({ status: "failed", done: true, tailRunId: production, failureReason: null });
    });

    it("follows at most 16 runs and reports the last of them", async () => {
      const ids = await linked([...Array(19).fill("runner_lost"), "pending"]);
      expect(FOLLOW_UP_CHAIN_MAX_RUNS).toBe(16);
      expect(await outcome(ids[0]!)).toMatchObject({ status: "failed", done: true, tailRunId: ids[15] });
      // 16 runs from the start of a shorter chain still reach its pending end.
      const short = await linked([...Array(14).fill("usage_limit"), "pending"]);
      expect(await outcome(short[0]!)).toMatchObject({ status: "pending", done: false, tailRunId: short[14] });
    });

    it("a run of another account is not followed into, and a run that is gone is done 'missing'", async () => {
      const mine = await failed({ reasons: ["runner_lost"] });
      expect(await outcome(mine, B)).toEqual({ status: "missing", done: true, envelope: null });
    });
  });

  describe("the real ports", () => {
    function registryOf(dispatch: (run: ExecutionRun) => Promise<unknown>): { registry: ExecutionTargetRegistry; seen: ExecutionRun[] } {
      const seen: ExecutionRun[] = [];
      const target = { runtime: "runner", dispatch: async (r: ExecutionRun) => (seen.push(r), dispatch(r)) } as unknown as ExecutionTarget;
      return { registry: { runner_local: target }, seen };
    }
    // The statuses the real `markBuildNeedsHuman` returns: `recorded` and `unchanged`, never anything else.
    const built = (registry: ExecutionTargetRegistry, buildFailed: FollowUpPortsDeps["buildFailed"] = async () => ({ status: "recorded", stage: "needs_human" })) => createFollowUpPorts({ pool: writerPool, registry, buildFailed });

    /** The real chain: `RunnerTarget` over the real job issuer, signer and `agent_run_set_runner_job`; only the repo and issue lookup is a stand-in. */
    function realRegistry(issueNumber: number | null = 7) {
      const issuer = createJobIssuer({
        pool: writerPool,
        signer: createJobSigner({ keyId: "k1", privateKey: key }),
        visibility: { visibility: async () => "private" },
        context: { load: async () => ({ repo: { owner: "acme", name: "app" }, spec: null, issueNumber }) },
        now: () => new Date(clock),
      });
      const target = new RunnerTarget({ limits: createFakeRunnerLimits(30), pool: writerPool, issuer, visibility: { visibility: async () => "private" } });
      return { registry: { runner_local: target } as unknown as ExecutionTargetRegistry, target };
    }
    const jobOf = async (runId: string) => ((await admin.query("SELECT job_signed FROM agent_runs WHERE id = $1", [runId])).rows[0].job_signed as { job: Job }).job;
    const childOf = async (parentJob?: Partial<Job>, reasons = ["runner_lost"]) => {
      const parent = await failed({ reasons, ...(parentJob ? { job: parentJob } : {}) });
      const made = (await askFor(parent)) as { childRunId: string };
      return { parent, childId: made.childRunId };
    };
    const FIX_PARENT: Partial<Job> = { task: { kind: "fix", prompt: "the task", prompt_sha256: sha256Text("the task") }, continues: { parent_run_id: randomUUID(), session_id: "sess-fix-1", branch: "fx/issue-7" } };

    it("the child's issued job carries the parent's model hint verbatim: a hint stays, and a null stays null (C22 section 1)", async () => {
      const withHint = await childOf({ model_hint: "sonnet-5" });
      await built(realRegistry().registry).dispatchChild({ accountId: A.accountId, runId: withHint.childId });
      expect((await jobOf(withHint.childId)).model_hint).toBe("sonnet-5");
      const noHint = await childOf({ model_hint: null });
      await built(realRegistry().registry).dispatchChild({ accountId: A.accountId, runId: noHint.childId });
      expect((await jobOf(noHint.childId)).model_hint).toBeNull();
      // The child row's own `model` column is not written.
      expect((await admin.query("SELECT model FROM agent_runs WHERE id = ANY($1::uuid[])", [[withHint.childId, noHint.childId]])).rows).toEqual([{ model: null }, { model: null }]);
    });

    it("a follow-up of a lost fix round is a fix again: the parent's branch and session, and the lost run as its parent (C22 section 2)", async () => {
      const { parent, childId } = await childOf(FIX_PARENT);
      await built(realRegistry(7).registry).dispatchChild({ accountId: A.accountId, runId: childId });
      const issued = await jobOf(childId);
      expect(issued.task.kind).toBe("fix");
      expect(issued.continues).toEqual({ parent_run_id: parent, session_id: "sess-fix-1", branch: "fx/issue-7" });
    });

    it("a follow-up of a lost fresh run stays a fresh run (continues is null)", async () => {
      const { childId } = await childOf();
      await built(realRegistry(7).registry).dispatchChild({ accountId: A.accountId, runId: childId });
      const issued = await jobOf(childId);
      expect(issued.task.kind).toBe("implement");
      expect(issued.continues).toBeNull();
    });

    it("a follow-up whose branch is not the lost round's is failed internal_error, with no job (C22 section 2)", async () => {
      const { childId } = await childOf(FIX_PARENT);
      // The issue's number is 8 now, so the branch the issuer derives is fx/issue-8, not the parent's fx/issue-7.
      await expect(built(realRegistry(8).registry).dispatchChild({ accountId: A.accountId, runId: childId })).rejects.toThrow(/continues_branch_mismatch/);
      const row = (await admin.query("SELECT status, job_signed FROM agent_runs WHERE id = $1", [childId])).rows[0];
      expect(row).toEqual({ status: "failed", job_signed: null });
      expect((await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [childId])).rows.map((r) => r.payload)).toEqual([{ from: "pending", to: "failed", failureReason: "internal_error" }]);
    });

    it("a follow-up is exempt from the daily run limit, and still counts toward the day: the next fresh run is refused runner_daily_limit (C22 section 4)", async () => {
      // 31 runner runs started today already: a fresh run is over the limit of 30.
      for (let i = 0; i < 31; i++) await run({ status: "cancelled" });
      const { childId } = await childOf();
      const { registry, target } = realRegistry();
      await built(registry).dispatchChild({ accountId: A.accountId, runId: childId });
      expect((await jobOf(childId)).run_id).toBe(childId);
      const fresh: ExecutionRun = { id: randomUUID(), accountId: A.accountId, role: "executor", product: "team", repoId: A.repoId, roleCard: "c", prompt: "p", model: "", capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" } };
      expect(await target.admit(fresh, undefined as never)).toEqual({ admitted: false, reason: "runner_daily_limit" });
    });

    it("a child that already has its job is left alone", async () => {
      const { childId } = await childOf();
      await admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [childId, JSON.stringify(signJob(job(childId), key))]);
      const { registry, seen } = registryOf(async () => ({ queued: true }));
      await built(registry).dispatchChild({ accountId: A.accountId, runId: childId });
      expect(seen).toEqual([]);
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [childId])).rows[0].status).toBe("pending");
    });

    it("a dispatch that fails because the job was written meanwhile (a slow first dispatch) is a success: the child stays pending", async () => {
      const { childId } = await childOf();
      const { registry } = registryOf(async () => {
        await admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [childId, JSON.stringify(signJob(job(childId), key))]);
        throw new Error("job issuer: job_not_recorded");
      });
      await expect(built(registry).dispatchChild({ accountId: A.accountId, runId: childId })).resolves.toBeUndefined();
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [childId])).rows[0].status).toBe("pending");
    });

    describe("failing the work item through the real stage driver write (markBuildNeedsHuman)", () => {
      const real = (a: string, w: string, r: string, c: string) => markBuildNeedsHuman(writerPool, a, w, r, c);
      const inProgress = () => admin.query("UPDATE work_items SET stage = 'in_progress' WHERE id = $1", [A.workItemId]);
      const stage = async () => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage;
      const refs = async () => (await admin.query("SELECT source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'needs_human'", [A.workItemId])).rows.map((r) => r.source_ref);

      it("a second loss moves an in-progress item to needs_human under runner_lost, with the run", async () => {
        await inProgress();
        const exhausted = await failed({ reasons: ["runner_lost"] });
        await built(registryOf(async () => ({})).registry, real).failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: exhausted, reason: "runner_lost" });
        expect(await stage()).toBe("needs_human");
        expect(await refs()).toEqual([`build_failed:runner_lost:${exhausted}`]);
      });

      it("the eighth usage limit moves it under runner_usage_limit", async () => {
        await inProgress();
        const exhausted = await failed({ reasons: ["usage_limit"] });
        await built(registryOf(async () => ({})).registry, real).failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: exhausted, reason: "usage_limit" });
        expect(await stage()).toBe("needs_human");
        expect(await refs()).toEqual([`build_failed:runner_usage_limit:${exhausted}`]);
      });

      it("is idempotent against the driver: whichever writes second finds the item no longer in progress, writes nothing and does not throw", async () => {
        await inProgress();
        const exhausted = await failed({ reasons: ["runner_lost"] });
        const ports2 = built(registryOf(async () => ({})).registry, real);
        // The driver's write (the same code, against the same tail run), then the sweeper's.
        expect(await real(A.accountId, A.workItemId, exhausted, "runner_lost")).toEqual({ status: "recorded", stage: "needs_human" });
        await ports2.failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: exhausted, reason: "runner_lost" });
        await ports2.failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: exhausted, reason: "runner_lost" });
        expect(await refs()).toEqual([`build_failed:runner_lost:${exhausted}`]);
      });

      it("a write that did not happen is an error, not a success: a work item that does not exist", async () => {
        const exhausted = await failed({ reasons: ["runner_lost"] });
        await expect(built(registryOf(async () => ({})).registry, real).failWorkItem({ accountId: A.accountId, workItemId: randomUUID(), runId: exhausted, reason: "runner_lost" })).rejects.toThrow(/not recorded/);
      });

      it("and so is a code the driver does not know (the closed list is what makes the write happen)", async () => {
        await inProgress();
        const exhausted = await failed({ reasons: ["runner_lost"] });
        const unknown = createFollowUpPorts({ pool: writerPool, registry: {}, buildFailed: (a, w, r) => real(a, w, r, "not_a_code") });
        await expect(unknown.failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: exhausted, reason: "runner_lost" })).rejects.toThrow(/not recorded/);
        expect(await stage()).toBe("in_progress");
      });
    });

    it("dispatches the child from its own row and the parent's signed job, with the parent's model hint and no escalation", async () => {
      const parent = await failed({ reasons: ["runner_lost"] });
      const made = (await askFor(parent)) as { childRunId: string };
      const { registry, seen } = registryOf(async () => ({ queued: true }));
      await built(registry).dispatchChild({ accountId: A.accountId, runId: made.childRunId });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        id: made.childRunId,
        accountId: A.accountId,
        workItemId: A.workItemId,
        parentRunId: parent,
        initiatedBy: A.userId,
        role: "executor",
        repoId: A.repoId,
        pr: 100 + 0,
        headSha: "abc123",
        roleCard: "the card",
        prompt: "the task",
        model: "sonnet-5",
        capUsd: 0,
      });
    });

    it("fails a child it could not dispatch (internal_error) so it does not sit queued without a job, and tells the caller", async () => {
      const parent = await failed({ reasons: ["usage_limit"] });
      const made = (await askFor(parent)) as { childRunId: string };
      const { registry } = registryOf(async () => Promise.reject(new Error("job issuer: job_invalid")));
      await expect(built(registry).dispatchChild({ accountId: A.accountId, runId: made.childRunId })).rejects.toThrow(/job_invalid/);
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [made.childRunId])).rows[0].status).toBe("failed");
      expect((await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'", [made.childRunId])).rows.map((r) => r.payload)).toEqual([{ from: "pending", to: "failed", failureReason: "internal_error" }]);
    });

    it("leaves a child alone that is no longer pending (cancelled while waiting)", async () => {
      const parent = await failed({ reasons: ["usage_limit"] });
      const made = (await askFor(parent)) as { childRunId: string };
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [made.childRunId]);
      const { registry, seen } = registryOf(async () => ({ queued: true }));
      await built(registry).dispatchChild({ accountId: A.accountId, runId: made.childRunId });
      expect(seen).toEqual([]);
    });

    it("fails the work item through the stage driver with the code of the allowance that ran out, and says so when the driver refuses", async () => {
      const codes: string[][] = [];
      const ok = createFollowUpPorts({ pool: writerPool, registry: {}, buildFailed: async (...args) => (codes.push(args.slice(1)), { status: "recorded", stage: "needs_human" }) });
      await ok.failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: "r1", reason: "runner_lost" });
      await ok.failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: "r2", reason: "usage_limit" });
      expect(codes).toEqual([
        [A.workItemId, "r1", "runner_lost"],
        [A.workItemId, "r2", "runner_usage_limit"],
      ]);
      const refusing = createFollowUpPorts({ pool: writerPool, registry: {}, buildFailed: async () => ({ status: "refused" }) });
      await expect(refusing.failWorkItem({ accountId: A.accountId, workItemId: A.workItemId, runId: "r1", reason: "runner_lost" })).rejects.toThrow(/refused/);
    });
  });
});
