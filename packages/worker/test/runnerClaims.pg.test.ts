import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_ELIGIBLE_ROLES, RUNNER_MAX_RUN_WALL_CLOCK_MS, RUNNER_SETUP_DETAILS, jobRefusedText, runnerSetupText, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { insertRunnerEvent, type RepoVisibility } from "@fx/runner";
import { resetPlanDataCache } from "@fx/plan-data";
import { runnerLimitsFor } from "@fx/spend";
import { RunActionRefusedError } from "../src/index.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";
import { runnerLimits } from "../src/runnerLimits.js";

/** [pg] D#6 R2b-3: claim, heartbeat and events against the real definers (0754), the real compare-and-set writer and a real run-writer login. */
describe("runner claim, heartbeat and events [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  // Near the real time: started_at is stamped by the database's own clock when a run first becomes running.
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let visibility: RepoVisibility = "private";
  let A: SeedRefs;
  let runner: string;
  let facade: RunnerClaimFacade;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => visibility }, now: () => clock, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool, opsPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    visibility = "private";
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    runner = await newRunner();
  });

  async function newRunner(o: { mode?: string; repos?: string[]; roles?: string[]; registeredBy?: string } = {}): Promise<string> {
    const id = await insertRunner(admin, A.accountId, o.registeredBy ?? A.userId, { credentialMode: o.mode ?? "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, o.repos ?? [A.repoId], o.roles ?? ["executor", "code-reviewer"]]);
    return id;
  }
  async function user(): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    return id;
  }
  /** A pending runner run with a real signed job. */
  async function pending(o: { role?: string; columnRole?: string; repoId?: string; initiatedBy?: string | null; approvedBy?: string | null; parent?: string | null; expiresAt?: number; mode?: string; createdAt?: number } = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: o.repoId ?? A.repoId, owner: "acme", name: "app", private: true },
      role: (o.role ?? "executor") as Job["role"],
      mode: o.mode === "runner_verified" ? "verified" : "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(T0 - 1000).toISOString(),
      expires_at: new Date(o.expiresAt ?? T0 + 72 * 3_600_000).toISOString(),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, approved_by, parent_run_id, created_at)
       VALUES ($1, $2, $3, 'runner', 'pending', $4, $5, $6::jsonb, $7, $8, $9, to_timestamp($10 / 1000.0))`,
      [id, A.accountId, o.columnRole ?? job.role, o.mode ?? "runner_local", o.repoId ?? A.repoId, JSON.stringify(signJob(job, key)), o.initiatedBy === undefined ? A.userId : o.initiatedBy, o.approvedBy ?? null, o.parent ?? null, o.createdAt ?? T0 - 5000],
    );
    return id;
  }
  const row = async (id: string) => (await admin.query("SELECT status, runner_id, lease_generation, lease_expires_at, started_at FROM agent_runs WHERE id = $1", [id])).rows[0];
  const claim = (runnerId = runner) => facade.claimRunnerRun({ accountId: A.accountId, runnerId });
  const events = async (id: string, kind: string) => (await admin.query("SELECT payload, runner_seq FROM run_events WHERE run_id = $1 AND kind = $2 ORDER BY seq", [id, kind])).rows;
  const statusEvents = (id: string) => events(id, "run.status_changed");
  /** Claims `id` for `runner` and returns its generation. */
  async function claimed(id: string): Promise<number> {
    const result = await claim();
    if (result.kind !== "claimed" || result.runId !== id) throw new Error("not claimed");
    return result.leaseGeneration;
  }
  const hb = (runId: string, leaseGeneration: number, runnerId = runner) => facade.heartbeatRunnerRun({ accountId: A.accountId, runnerId, runId, leaseGeneration });

  describe("claim", () => {
    // D#6 R5b-1 (C38): a run whose own mode is runner_verified is claimable while its repo is on either runner mode, and never on sandbox.
    it("hands a verified run to an eligible runner, its job still saying verified, whether the repo is verified or has moved to runner_local", async () => {
      await admin.query("UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1", [A.repoId]);
      const id = await pending({ mode: "runner_verified" });
      const first = await claim();
      expect(first).toMatchObject({ kind: "claimed", runId: id, leaseGeneration: 1 });
      expect(first.kind === "claimed" && first.signedJob.job.mode).toBe("verified");
      expect(await row(id)).toMatchObject({ status: "running", runner_id: runner });
      await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
      const moved = await pending({ mode: "runner_verified" });
      const second = await claim(await newRunner()); // the first runner still holds its job, and one declaring no capacity holds one at a time
      expect(second).toMatchObject({ kind: "claimed", runId: moved });
      expect(second.kind === "claimed" && second.signedJob.job.mode).toBe("verified");
    });

    it("hands out nothing for a verified run whose repo is on sandbox", async () => {
      const id = await pending({ mode: "runner_verified" });
      await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [A.repoId]);
      expect((await claim()).kind).toBe("idle");
      expect((await row(id)).status).toBe("pending");
    });

    it("hands out a pending run: running, this runner, generation 1, lease 90 s, one status event", async () => {
      const id = await pending();
      const result = await claim();
      expect(result).toMatchObject({ kind: "claimed", runId: id, leaseGeneration: 1 });
      const r = await row(id);
      expect(r).toMatchObject({ status: "running", runner_id: runner, lease_generation: 1 });
      expect(r.started_at).not.toBeNull();
      expect(r.lease_expires_at.getTime()).toBe(T0 + 90_000);
      expect((await statusEvents(id)).map((e) => e.payload)).toEqual([{ from: "pending", to: "running" }]);
      expect(result.kind === "claimed" && result.signedJob.job.run_id).toBe(id);
    });

    it("never gives one run to two concurrent claimers", async () => {
      const id = await pending();
      const second = await newRunner();
      const results = await Promise.all([claim(runner), claim(second)]);
      expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
      expect((await row(id)).lease_generation).toBe(1);
    });

    it("hands out nothing while the account already has the plan's limit of running runner runs", async () => {
      // The figure is the runner plan's (the public fixture's here), read through the one limits function: N claims succeed and the (N+1)th gets no run.
      const limit = runnerLimitsFor().maxConcurrentRunnerJobs;
      expect(limit).toBeGreaterThan(0);
      const ids: string[] = [];
      for (let i = 0; i <= limit; i++) ids.push(await pending({ createdAt: T0 - 9000 + i }));
      // One runner holds one job at a time when it declares no capacity, so each claim comes from its own runner.
      for (let i = 0; i < limit; i++) expect(await claim(await newRunner()), ids[i]).toMatchObject({ kind: "claimed", runId: ids[i] });
      expect((await claim(await newRunner())).kind).toBe("idle");
      expect((await row(ids[limit]!)).status).toBe("pending");
    });

    it("answers retry_after 60 with nothing queued and 5 to 15 with work queued that it cannot take", async () => {
      expect(await claim()).toEqual({ kind: "idle", retryAfter: 60 });
      await pending({ repoId: A.repoId, role: "debater" }); // a role this runner may not run
      expect(await claim()).toEqual({ kind: "idle", retryAfter: 5 });
      const range = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock });
      for (let i = 0; i < 20; i++) {
        const r = await range.claimRunnerRun({ accountId: A.accountId, runnerId: runner });
        expect(r.kind === "idle" && r.retryAfter >= 5 && r.retryAfter <= 15).toBe(true);
      }
    });

    it("respects the runner's repos and roles, the repo's mode and the runner-eligible set", async () => {
      const other = await newRunner({ repos: [randomUUID()] });
      const outsider = await newRunner({ roles: ["not-a-role"] });
      const id = await pending();
      for (const r of [other, outsider]) expect((await claim(r)).kind, r).toBe("idle");
      await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [A.repoId]);
      expect((await claim()).kind).toBe("idle");
      await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
      expect(RUNNER_ELIGIBLE_ROLES).toContain("code-reviewer");
      expect((await claim()).kind).toBe("claimed");
      expect((await row(id)).status).toBe("running");
    });

    describe("allowed_roles (C21 section 3)", () => {
      it("an empty allowed_roles means every runner-eligible role: a fresh runner claims each of them", async () => {
        const fresh = await newRunner({ roles: [] });
        expect((await admin.query("SELECT allowed_roles FROM runners WHERE id = $1", [fresh])).rows[0].allowed_roles).toEqual([]);
        for (const role of RUNNER_ELIGIBLE_ROLES) {
          const id = await pending({ role });
          const result = await claim(fresh);
          expect(result, role).toMatchObject({ kind: "claimed", runId: id });
          // The account's one slot is free again for the next role.
          await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [id]);
        }
      });

      it("a non-empty allowed_roles narrows the set: { executor } claims no reviewer run", async () => {
        const executorOnly = await newRunner({ roles: ["executor"] });
        const reviewer = await pending({ role: "code-reviewer" });
        expect((await claim(executorOnly)).kind).toBe("idle");
        expect((await row(reviewer)).status).toBe("pending");
        const executor = await pending({ role: "executor", createdAt: T0 - 1000 });
        expect(await claim(executorOnly)).toMatchObject({ kind: "claimed", runId: executor });
      });

      it("a role outside the eligible set is never claimed, whether allowed_roles is empty or names it", async () => {
        // The job schema admits only eligible roles, so the run's own role column is what differs from the job here.
        expect(RUNNER_ELIGIBLE_ROLES as readonly string[]).not.toContain("tester");
        const empty = await newRunner({ roles: [] });
        const naming = await newRunner({ roles: ["tester"] });
        const id = await pending({ role: "executor", columnRole: "tester" });
        expect((await claim(empty)).kind).toBe("idle");
        expect((await claim(naming)).kind).toBe("idle");
        expect((await row(id)).status).toBe("pending");
      });
    });

    it("binds a subscription runner to runs its registrant started or approved; an api_key runner needs no approval", async () => {
      const teammate = await user();
      const sub = await newRunner({ mode: "subscription" });
      const id = await pending({ initiatedBy: teammate });
      expect((await claim(sub)).kind).toBe("idle");
      await admin.query("UPDATE agent_runs SET approved_by = $2 WHERE id = $1", [id, A.userId]);
      expect(await claim(sub)).toMatchObject({ kind: "claimed", runId: id });
      const id2 = await pending({ initiatedBy: teammate });
      // The first run still holds the account's one slot; finish it so the api_key runner can show the other half.
      await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [id]);
      expect(await claim(runner)).toMatchObject({ kind: "claimed", runId: id2 });
    });

    it("fails a run whose repo is public, or whose visibility is unknown, instead of handing it out", async () => {
      const a = await pending();
      visibility = "public";
      expect((await claim()).kind).toBe("idle");
      expect((await row(a)).status).toBe("failed");
      expect((await statusEvents(a)).map((e) => e.payload)).toEqual([{ from: "pending", to: "failed", failureReason: "public_repo" }]);
      const b = await pending();
      visibility = "unknown";
      expect((await claim()).kind).toBe("idle");
      expect((await statusEvents(b)).map((e) => e.payload)).toEqual([{ from: "pending", to: "failed", failureReason: "repo_visibility_unknown" }]);
    });

    it("prefers the runner that ran the parent run, and skips a job past its expiry", async () => {
      const parentRunner = await newRunner();
      const parent = await pending();
      await admin.query("UPDATE agent_runs SET status = 'failed', runner_id = $2, lease_generation = 1 WHERE id = $1", [parent, parentRunner]);
      const older = await pending({ createdAt: T0 - 9000 });
      const child = await pending({ parent, createdAt: T0 - 1000 });
      expect(await claim(parentRunner)).toMatchObject({ kind: "claimed", runId: child });
      await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [child]);
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [older]);
      const stale = await pending({ expiresAt: T0 - 1 });
      expect((await claim()).kind).toBe("idle");
      expect((await row(stale)).status).toBe("pending");
    });

    it("refuses a revoked or unknown runner", async () => {
      await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runner]);
      await expect(claim()).rejects.toBeInstanceOf(RunActionRefusedError);
      await expect(claim(randomUUID())).rejects.toBeInstanceOf(RunActionRefusedError);
    });
  });

  describe("the lease fence", () => {
    it("a heartbeat extends the lease to 90 s from now", async () => {
      const id = await pending();
      const g = await claimed(id);
      clock = T0 + 60_000;
      expect(await hb(id, g)).toEqual({ verdict: "ok", leaseExpiresAt: new Date(T0 + 150_000) });
      expect((await row(id)).lease_expires_at.getTime()).toBe(T0 + 150_000);
    });

    it("a wrong generation or a wrong runner is stale and writes nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      const before = await row(id);
      const other = await newRunner();
      expect(await hb(id, g + 1)).toEqual({ verdict: "stale", reason: "stale_generation" });
      expect(await hb(id, g - 1)).toEqual({ verdict: "stale", reason: "stale_generation" });
      expect(await hb(id, g, other)).toEqual({ verdict: "stale", reason: "stale_generation" });
      expect(await hb(randomUUID(), g)).toEqual({ verdict: "unknown", reason: "stale_generation" });
      expect(await row(id)).toEqual(before);
    });

    it("the lease is lost AT lease_expires_at, with no sweep run, and an expired lease is never revived", async () => {
      const id = await pending();
      const g = await claimed(id);
      clock = T0 + 90_000 - 1;
      expect(await hb(id, g)).toMatchObject({ verdict: "ok" }); // 1 ms before: held (and extended)
      clock = T0 + 90_000 - 1 + 90_000;
      expect(await hb(id, g)).toEqual({ verdict: "expired", reason: "lease_expired" }); // exactly at the end: lost
      const after = await row(id);
      expect(after.lease_expires_at.getTime()).toBe(T0 + 90_000 - 1 + 90_000);
      clock += 1;
      expect(await hb(id, g)).toEqual({ verdict: "expired", reason: "lease_expired" });
      expect((await row(id)).lease_expires_at).toEqual(after.lease_expires_at);
      expect((await row(id)).status).toBe("running");
    });

    it("a run past the plan's wall clock from its start is answered wall_clock", async () => {
      const id = await pending();
      const g = await claimed(id);
      const started = (await row(id)).started_at.getTime();
      await admin.query("UPDATE agent_runs SET lease_expires_at = to_timestamp($2 / 1000.0) WHERE id = $1", [id, started + 3 * 3_600_000]);
      const wall = runnerLimitsFor().maxRunWallClockMs;
      clock = started + wall - 1;
      expect(await hb(id, g)).toMatchObject({ verdict: "ok" });
      clock = started + wall + 1; // started_at has microseconds; getTime() truncates them
      expect(await hb(id, g)).toEqual({ verdict: "wall_clock", reason: "wall_clock_limit" });
    });

    it("a finished, cancelled or revoked-runner run is not held", async () => {
      const id = await pending();
      const g = await claimed(id);
      await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runner]);
      expect(await hb(id, g)).toEqual({ verdict: "revoked", reason: "run_terminal" });
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [id]);
      expect(await hb(id, g)).toEqual({ verdict: "not_running", reason: "run_terminal" });
    });
  });

  describe("events", () => {
    const ev = (seq: number, extra: object = {}) => ({ seq, ts: "2026-10-10T12:00:00.000Z", type: "tool_use" as const, tool_name: "Edit", ...extra });
    const send = (id: string, g: number, list: object[]) => facade.ingestRunnerEvents({ accountId: A.accountId, runnerId: runner, runId: id, leaseGeneration: g, events: list as never });

    it("stores a batch, keyed by the runner's seq, and extends the lease", async () => {
      const id = await pending();
      const g = await claimed(id);
      clock = T0 + 30_000;
      expect(await send(id, g, [ev(0), ev(1, { file_path: "src/a.ts" })])).toEqual({ outcome: "accepted", stored: 2, duplicates: 0, conflicts: 0, ended: null, leaseExpiresAt: new Date(T0 + 120_000) });
      expect((await events(id, "runner.event")).map((e) => e.runner_seq)).toEqual(["0", "1"]);
      expect((await row(id)).lease_expires_at.getTime()).toBe(T0 + 120_000);
    });

    it("answers a batch that starts at or below the last accepted seq with seq_not_increasing, naming it, and stores nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      await send(id, g, [ev(0), ev(1)]);
      const lease = (await row(id)).lease_expires_at;
      clock = T0 + 10_000;
      expect(await send(id, g, [ev(1)])).toEqual({ outcome: "seq_not_increasing", lastAcceptedSeq: 1 });
      expect(await send(id, g, [ev(0), ev(1), ev(2)])).toEqual({ outcome: "seq_not_increasing", lastAcceptedSeq: 1 });
      expect(await events(id, "runner.event")).toHaveLength(2);
      expect((await row(id)).lease_expires_at).toEqual(lease);
      // The recovery the reply exists for: drop what is at or below the number and send the rest.
      expect(await send(id, g, [ev(2)])).toMatchObject({ outcome: "accepted", stored: 1, duplicates: 0 });
    });

    it("refuses a batch whose own numbers do not strictly increase as seq_order, before it reads or writes anything", async () => {
      const id = await pending();
      const g = await claimed(id);
      const lease = (await row(id)).lease_expires_at;
      for (const list of [[ev(1), ev(1)], [ev(2), ev(1)], [ev(0), ev(3), ev(3)]]) expect(await send(id, g, list), JSON.stringify(list.map((e) => e.seq))).toEqual({ outcome: "seq_order" });
      // Not even a fenced run is told anything else first: the order is a property of the body.
      expect(await send(id, g + 1, [ev(1), ev(1)])).toEqual({ outcome: "seq_order" });
      expect(await events(id, "runner.event")).toHaveLength(0);
      expect((await row(id)).lease_expires_at).toEqual(lease);
    });

    it("the database guard drops a direct duplicate insert, and counts it as a conflict when the body differs", async () => {
      const id = await pending();
      await claimed(id);
      const insert = (body: string, payload: Record<string, unknown>) =>
        withTenant(writerPool, A.accountId, (client) => insertRunnerEvent(client, { accountId: A.accountId, runId: id, runnerSeq: 5, bodySha256: body, payload }));
      expect(await insert("a".repeat(64), { type: "tool_use" })).toBe("stored");
      expect(await insert("a".repeat(64), { type: "tool_use" })).toBe("duplicate");
      expect(await insert("b".repeat(64), { type: "usage" })).toBe("conflict");
      expect(await events(id, "runner.event")).toHaveLength(1);
      expect((await events(id, "runner.event_conflict")).map((e) => e.payload)).toEqual([{ runner_seq: 5 }]);
    });

    it("is fenced like a heartbeat: a stale generation or an expired lease stores nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      expect(await send(id, g + 1, [ev(0)])).toEqual({ outcome: "fenced", verdict: "stale", reason: "stale_generation" });
      clock = T0 + 90_000;
      expect(await send(id, g, [ev(0)])).toEqual({ outcome: "fenced", verdict: "expired", reason: "lease_expired" });
      expect(await events(id, "runner.event")).toHaveLength(0);
    });

    it("redacts a credential-shaped value before it is stored", async () => {
      const id = await pending();
      const g = await claimed(id);
      const secret = `sk-ant-${"api03"}-${"A".repeat(30)}`;
      await send(id, g, [ev(0, { file_path: `notes/${secret}.txt` })]);
      const stored = JSON.stringify((await events(id, "runner.event"))[0].payload);
      expect(stored).not.toContain(secret);
    });

    it("a taken_over event is stored and ends nothing: the run goes on until its done decides (D#6 R4a-7)", async () => {
      const id = await pending();
      const g = await claimed(id);
      expect(await send(id, g, [{ seq: 0, ts: "2026-10-10T12:00:00.000Z", type: "taken_over" }])).toMatchObject({ outcome: "accepted", stored: 1, ended: null });
      expect((await row(id)).status).toBe("running");
      expect((await events(id, "runner.event")).map((e) => e.payload)).toEqual([{ seq: 0, ts: "2026-10-10T12:00:00.000Z", type: "taken_over" }]);
    });

    it("usage_limit_reached ends the run failed with usage_limit, credential_mismatch with credential_mismatch", async () => {
      const a = await pending();
      const g = await claimed(a);
      expect(await send(a, g, [ev(0), ev(1, { type: "usage_limit_reached", reset_at: "2026-10-10T17:00:00.000Z" })])).toMatchObject({ outcome: "accepted", ended: "usage_limit" });
      expect((await row(a)).status).toBe("failed");
      expect((await statusEvents(a)).map((e) => e.payload)).toEqual([{ from: "pending", to: "running" }, { from: "running", to: "failed", failureReason: "usage_limit" }]);
      const b = await pending();
      const g2 = await claimed(b);
      expect(await send(b, g2, [ev(0, { type: "credential_mismatch" })])).toMatchObject({ ended: "credential_mismatch" });
      expect((await statusEvents(b)).at(-1)?.payload).toEqual({ from: "running", to: "failed", failureReason: "credential_mismatch" });
    });

    describe("run_ended (D#6 R4a-2, C24 section 1)", () => {
      const bare = (seq: number, extra: object) => ({ seq, ts: "2026-10-10T12:00:00.000Z", ...extra });
      const ended = (seq: number, reason: string, detail?: string) => bare(seq, { type: "run_ended", reason, ...(detail === undefined ? {} : { detail }) });
      const children = async (id: string) => (await admin.query("SELECT id FROM agent_runs WHERE parent_run_id = $1", [id])).rows;
      /** What each reason records, exactly as the correction's table lists it. `runner_shutdown` is in the follow-up test file, where the work item it needs is seeded. */
      const TABLE: Array<[reason: string, detail: string | undefined, status: string, failureReason: string]> = [
        ["job_refused", "job_signature_invalid", "failed", "job_refused"],
        ["job_refused", "duplicate_job", "failed", "job_refused"],
        // D#6 R4d-4a (C33 section 1.1): a review job the runner refused. (`review_sha_not_in_mirror` is a setup detail, in the slice below.)
        ["job_refused", "review_sha_missing", "failed", "job_refused"],
        ["job_refused", "review_wrong_role", "failed", "job_refused"],
        ["repo_not_private", undefined, "failed", "public_repo"],
        ["agent_failed", undefined, "failed", "agent_failed"],
        ["wall_clock", undefined, "timed_out", "wall_clock_limit"],
        ["runner_setup", "claude_binary_missing", "failed", "runner_setup_failed"],
        ["runner_setup", "other", "failed", "runner_setup_failed"],
        ["runner_setup", "continuation_branch_missing", "failed", "runner_setup_failed"],
        ["push_rejected", undefined, "failed", "push_rejected"],
        // D#6 R4d-2 (C32 section 3): every closed detail the runner's git path can send. The strict event accepts each, and each ends the run like any setup failure.
        ...[...RUNNER_SETUP_DETAILS.slice(RUNNER_SETUP_DETAILS.indexOf("model_unsupported") + 1)].map((detail): [string, string, string, string] => ["runner_setup", detail, "failed", "runner_setup_failed"]),
      ];

      for (const [reason, detail, status, failureReason] of TABLE) {
        it(`${reason}${detail === undefined ? "" : ` (${detail})`} ends the run ${status} with ${failureReason}, in one status event, and makes no follow-up`, async () => {
          const id = await pending();
          const g = await claimed(id);
          expect(await send(id, g, [ended(0, reason, detail)])).toMatchObject({ outcome: "accepted", stored: 1, ended: failureReason });
          expect((await row(id)).status).toBe(status);
          expect((await statusEvents(id)).map((e) => e.payload)).toEqual([{ from: "pending", to: "running" }, { from: "running", to: status, failureReason }]);
          expect(await children(id)).toEqual([]);
          // The closed code the runner sent is on the stored event, which is where the dashboard reads it from.
          expect((await events(id, "runner.event"))[0]!.payload).toMatchObject({ type: "run_ended", reason, ...(detail === undefined ? {} : { detail }) });
        });
      }

      it("G9: the stored review details are the ones the Needs-human notice has a line for", async () => {
        for (const [reason, detail, line] of [
          ["runner_setup", "review_sha_not_in_mirror", runnerSetupText("review_sha_not_in_mirror")],
          ["job_refused", "review_sha_missing", jobRefusedText("review_sha_missing")],
          ["job_refused", "review_wrong_role", jobRefusedText("review_wrong_role")],
        ] as const) {
          const id = await pending();
          const g = await claimed(id);
          expect(await send(id, g, [ended(0, reason, detail)])).toMatchObject({ outcome: "accepted", stored: 1 });
          const stored = (await events(id, "runner.event"))[0]!.payload as { reason: string; detail: string };
          expect(stored).toMatchObject({ type: "run_ended", reason, detail });
          const shown = reason === "runner_setup" ? runnerSetupText(stored.detail) : jobRefusedText(stored.detail);
          expect(shown).toBe(line);
          expect(shown).not.toContain(detail);
        }
      });

      it("is fenced like every other event: a stale generation or a finished run stores nothing and changes nothing", async () => {
        const id = await pending();
        const g = await claimed(id);
        expect(await send(id, g + 1, [ended(0, "agent_failed")])).toMatchObject({ outcome: "fenced", reason: "stale_generation" });
        expect((await row(id)).status).toBe("running");
        expect(await send(id, g, [ended(0, "agent_failed")])).toMatchObject({ outcome: "accepted" });
        expect(await send(id, g, [ended(1, "job_refused", "duplicate_job")])).toMatchObject({ outcome: "fenced", reason: "run_terminal" });
        expect((await statusEvents(id)).at(-1)?.payload).toEqual({ from: "running", to: "failed", failureReason: "agent_failed" });
      });

      it("follows the seq rule: a run_ended at or below the last accepted number is seq_not_increasing and ends nothing", async () => {
        const id = await pending();
        const g = await claimed(id);
        await send(id, g, [ev(0), ev(1)]);
        expect(await send(id, g, [ended(1, "agent_failed")])).toEqual({ outcome: "seq_not_increasing", lastAcceptedSeq: 1 });
        expect((await row(id)).status).toBe("running");
        expect(await send(id, g, [ended(2, "agent_failed")])).toMatchObject({ outcome: "accepted", ended: "agent_failed" });
      });

      it("after a usage limit in the same batch, the usage limit is what is recorded (the first ending event wins)", async () => {
        const id = await pending();
        const g = await claimed(id);
        expect(await send(id, g, [bare(0, { type: "usage_limit_reached" }), ended(1, "agent_failed")])).toMatchObject({ outcome: "accepted", stored: 2, ended: "usage_limit" });
        expect((await statusEvents(id)).at(-1)?.payload).toEqual({ from: "running", to: "failed", failureReason: "usage_limit" });
      });

      it("after a credential mismatch in the same batch, the mismatch is what is recorded", async () => {
        const id = await pending();
        const g = await claimed(id);
        expect(await send(id, g, [bare(0, { type: "credential_mismatch" }), ended(1, "runner_setup", "other")])).toMatchObject({ ended: "credential_mismatch" });
        expect((await statusEvents(id)).at(-1)?.payload).toEqual({ from: "running", to: "failed", failureReason: "credential_mismatch" });
      });

      /**
       * A pool whose clients, right after the batch reads the last accepted number, store a row under `runnerSeq` with another body.
       * The run row's lock normally keeps that from happening; this puts the row in the one window the database guard exists for,
       * so the batch's own event for that number reaches `insertRunnerEvent` as a duplicate or a conflict.
       */
      const racingPool = (runId: string, runnerSeq: number, bodySha256: string): Pool =>
        new Proxy(writerPool, {
          get(target, prop) {
            if (prop !== "connect") {
              const value: unknown = Reflect.get(target, prop);
              return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
            }
            return async () => {
              const client = await target.connect();
              const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
              const release = client.release.bind(client);
              (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
                const result = await query(...args);
                if (typeof args[0] === "string" && args[0].includes("max(runner_seq)")) {
                  await insertRunnerEvent(client, { accountId: A.accountId, runId, runnerSeq, bodySha256, payload: { type: "usage" } });
                }
                return result;
              };
              (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
                (client as unknown as { query: unknown }).query = query;
                (client as unknown as { release: unknown }).release = release;
                return (release as (...a: unknown[]) => void)(...args);
              };
              return client;
            };
          },
        });
      const racingSend = (pool: Pool, id: string, g: number, list: object[]) =>
        createRunnerClaimFacade(pool, { visibility: { visibility: async () => visibility }, now: () => clock, randomBetween: (min) => min }).ingestRunnerEvents({
          accountId: A.accountId,
          runnerId: runner,
          runId: id,
          leaseGeneration: g,
          events: list as never,
        });

      it("a run_ended whose number is already stored with another body is a conflict, is dropped and ends nothing", async () => {
        const id = await pending();
        const g = await claimed(id);
        // Number 0 is stored by another writer after the batch read the last accepted number: the run_ended that reuses it is dropped.
        expect(await racingSend(racingPool(id, 0, "c".repeat(64)), id, g, [ended(0, "agent_failed")])).toMatchObject({ outcome: "accepted", stored: 0, duplicates: 1, conflicts: 1, ended: null });
        expect((await row(id)).status).toBe("running");
        expect((await statusEvents(id)).map((e) => e.payload)).toEqual([{ from: "pending", to: "running" }]);
        expect(await children(id)).toEqual([]);
        // The same for the events that end a run without a reason.
        expect(await racingSend(racingPool(id, 1, "d".repeat(64)), id, g, [bare(1, { type: "usage_limit_reached" })])).toMatchObject({ outcome: "accepted", stored: 0, conflicts: 1, ended: null });
        expect((await row(id)).status).toBe("running");
        expect(await children(id)).toEqual([]);
      });

      it("a reason that is not a key of the ending table, such as an inherited property name, ends nothing", async () => {
        const id = await pending();
        const g = await claimed(id);
        // The protocol schema refuses these on the events route; the table lookup must hold on its own too.
        expect(await send(id, g, [ended(0, "constructor"), ended(1, "toString"), ended(2, "__proto__")])).toMatchObject({ outcome: "accepted", stored: 3, ended: null });
        expect((await row(id)).status).toBe("running");
      });

      it("a usage limit that arrives first ends the run, so the run_ended sent after it is answered run_terminal", async () => {
        const id = await pending();
        const g = await claimed(id);
        await send(id, g, [bare(0, { type: "usage_limit_reached" })]);
        expect(await send(id, g, [ended(1, "agent_failed")])).toMatchObject({ outcome: "fenced", reason: "run_terminal" });
      });
    });
  });

  describe("who may write the lease columns", () => {
    it("neither the web tier's logins nor a direct platform_ops session can", async () => {
      const id = await pending();
      await claimed(id);
      await expect(appPool.query("UPDATE agent_runs SET lease_expires_at = now() + interval '1 day' WHERE id = $1", [id])).rejects.toThrow(/permission denied/);
      await expect(appPool.query("SELECT agent_run_runner_lease($1, $2, $3, 1, now(), 90, 7200000)", [A.accountId, id, runner])).rejects.toThrow(/permission denied/);
      const ops = await opsPool.connect();
      try {
        await ops.query("SELECT set_config('app.account_id', $1, false)", [A.accountId]);
        await expect(ops.query("UPDATE agent_runs SET lease_expires_at = now() + interval '1 day' WHERE id = $1", [id])).rejects.toThrow(/permission denied/);
      } finally {
        ops.release();
      }
    });

    it("lease_generation never goes down and a claimed run's runner never changes", async () => {
      const id = await pending();
      await claimed(id);
      await expect(admin.query("UPDATE agent_runs SET lease_generation = 0 WHERE id = $1", [id])).rejects.toThrow(/never goes down/);
      await expect(admin.query("UPDATE agent_runs SET runner_id = $2 WHERE id = $1", [id, await newRunner()])).rejects.toThrow(/write-once/);
    });

    it("only the run-writer login may write run_events.runner_seq", async () => {
      const id = await pending();
      await expect(
        appPool.query("SELECT set_config('app.account_id', $1, false)", [A.accountId]).then(() =>
          appPool.query("INSERT INTO run_events (account_id, run_id, seq, kind, runner_seq, runner_body_sha256) VALUES ($1, $2, 99, 'runner.event', 1, $3)", [A.accountId, id, "a".repeat(64)]),
        ),
      ).rejects.toThrow();
    });
  });

  describe("the claim throttle", () => {
    it("lets a runner claim once in 4 s and tells it how long to wait", async () => {
      const c = await appPool.connect();
      try {
        const call = async () => {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.runner_id', $2, true)", [A.accountId, runner]);
          const { rows } = await c.query("SELECT runner_claim_throttle(4000) AS wait");
          await c.query("COMMIT");
          return rows[0].wait as number;
        };
        expect(await call()).toBe(0);
        const wait = await call();
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(4000);
        await admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '4 seconds' WHERE runner_id = $1", [runner]);
        expect(await call()).toBe(0);
      } finally {
        c.release();
      }
    });
  });

  describe("limits come from one function (C21 section 8)", () => {
    it("with a figure of N concurrent jobs, the (N+1)th claim gets no run", async () => {
      const three = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min, limits: () => ({ maxConcurrentRunnerJobs: 3, maxConcurrentHeavyRunnerJobs: 3, maxRunWallClockMs: 7_200_000 }) });
      const ids = [await pending({ createdAt: T0 - 4000 }), await pending({ createdAt: T0 - 3000 }), await pending({ createdAt: T0 - 2000 }), await pending({ createdAt: T0 - 1000 })];
      const mine = (r: string) => three.claimRunnerRun({ accountId: A.accountId, runnerId: r });
      for (const id of ids.slice(0, 3)) expect(await mine(await newRunner()), id).toMatchObject({ kind: "claimed", runId: id });
      expect((await mine(await newRunner())).kind).toBe("idle");
      expect((await row(ids[3]!)).status).toBe("pending");
      // One job ends, and the slot is free again.
      await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [ids[0]]);
      expect(await mine(await newRunner())).toMatchObject({ kind: "claimed", runId: ids[3] });
    });

    describe("the default reads the runner plan's data and fails closed without it", () => {
      const saved = process.env.FX_PLAN_DATA;
      afterEach(() => {
        if (saved === undefined) delete process.env.FX_PLAN_DATA;
        else process.env.FX_PLAN_DATA = saved;
        resetPlanDataCache();
      });
      const withFigures = (over: Record<string, number>) => {
        const data = JSON.parse(saved!);
        data.runnerPlan.limits = { ...data.runnerPlan.limits, ...over };
        process.env.FX_PLAN_DATA = JSON.stringify(data);
        resetPlanDataCache();
      };

      it("gives the plan's two figures, and follows the data when it changes", () => {
        const plan = runnerLimitsFor();
        // The fixture has no heavy figure, so it reads as 1 (fail closed); one with the figure is followed.
        expect(runnerLimits(A.accountId)).toEqual({ maxConcurrentRunnerJobs: plan.maxConcurrentRunnerJobs, maxConcurrentHeavyRunnerJobs: plan.maxConcurrentHeavyRunnerJobs ?? 1, maxRunWallClockMs: plan.maxRunWallClockMs });
        withFigures({ maxConcurrentRunnerJobs: 7, maxConcurrentHeavyRunnerJobs: 3, maxRunWallClockMs: 123_456 });
        expect(runnerLimits(A.accountId)).toEqual({ maxConcurrentRunnerJobs: 7, maxConcurrentHeavyRunnerJobs: 3, maxRunWallClockMs: 123_456 });
      });

      it("with a figure of N, the (N+1)th claim of the real facade gets no run", async () => {
        withFigures({ maxConcurrentRunnerJobs: 2, maxConcurrentHeavyRunnerJobs: 2 });
        const ids = [await pending({ createdAt: T0 - 3000 }), await pending({ createdAt: T0 - 2000 }), await pending({ createdAt: T0 - 1000 })];
        for (const id of ids.slice(0, 2)) expect(await claim(await newRunner()), id).toMatchObject({ kind: "claimed", runId: id });
        expect((await claim(await newRunner())).kind).toBe("idle");
        expect((await row(ids[2]!)).status).toBe("pending");
      });

      it("with no plan data, or none for the runner tier, nothing is handed out and the wall clock stays at the class constant", async () => {
        delete process.env.FX_PLAN_DATA;
        resetPlanDataCache();
        expect(runnerLimits(A.accountId)).toEqual({ maxConcurrentRunnerJobs: 0, maxConcurrentHeavyRunnerJobs: 0, maxRunWallClockMs: RUNNER_MAX_RUN_WALL_CLOCK_MS });
        const id = await pending({ createdAt: T0 - 1000 });
        expect((await claim(await newRunner())).kind).toBe("idle");
        expect((await row(id)).status).toBe("pending");
        const data = JSON.parse(saved!);
        delete data.runnerPlan;
        process.env.FX_PLAN_DATA = JSON.stringify(data);
        resetPlanDataCache();
        expect(runnerLimits(A.accountId)).toEqual({ maxConcurrentRunnerJobs: 0, maxConcurrentHeavyRunnerJobs: 0, maxRunWallClockMs: RUNNER_MAX_RUN_WALL_CLOCK_MS });
      });
    });

    it("the wall clock the fence uses is the one the limits function gives for the account", async () => {
      const id = await pending();
      const g = await claimed(id);
      const started = (await row(id)).started_at.getTime();
      await admin.query("UPDATE agent_runs SET lease_expires_at = to_timestamp($2 / 1000.0) WHERE id = $1", [id, started + 3 * 3_600_000]);
      const short = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => started + 600_001, limits: () => ({ maxConcurrentRunnerJobs: 2, maxConcurrentHeavyRunnerJobs: 2, maxRunWallClockMs: 600_000 }) });
      expect(await short.heartbeatRunnerRun({ accountId: A.accountId, runnerId: runner, runId: id, leaseGeneration: g })).toEqual({ verdict: "wall_clock", reason: "wall_clock_limit" });
      clock = started + 600_001;
      expect(await hb(id, g)).toMatchObject({ verdict: "ok" });
    });
  });

  describe("concurrent event batches", () => {
    const ev = (seq: number) => ({ seq, ts: "2026-10-10T12:00:00.000Z", type: "tool_use" as const, tool_name: "Edit" });

    it("a batch resent while the first is still being written is told seq_not_increasing, never stored twice", async () => {
      const id = await pending();
      const g = await claimed(id);
      const send = () => facade.ingestRunnerEvents({ accountId: A.accountId, runnerId: runner, runId: id, leaseGeneration: g, events: [ev(0), ev(1), ev(2)] });
      const results = await Promise.all([send(), send(), send()]);
      expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "seq_not_increasing")).toEqual([{ outcome: "seq_not_increasing", lastAcceptedSeq: 2 }, { outcome: "seq_not_increasing", lastAcceptedSeq: 2 }]);
      expect(await events(id, "runner.event")).toHaveLength(3);
    });
  });
});
