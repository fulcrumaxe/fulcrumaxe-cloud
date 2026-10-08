import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DoneReply, DoneRetryReply, RUNNER_ELIGIBLE_ROLES, StopReply, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RUNNER_DISPATCH_BASE_KIND, readRecordedRunnerBranch } from "@fx/runner";
import { withTenant } from "@fx/db/src/withTenant.js";
import { CLAIM_PATH, DISPATCH_BASE_KIND, claimRun, createRunPullRequestPort, donePath, doneRun, eventsPath, heartbeatRun, HEARTBEAT_PATH, ingestEvents, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { RunActionInputError } from "../src/index.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { DONE_FAILURE_REASONS, DROPPED_AGENT_OUTPUT, createRunnerDoneFacade, type RunnerDoneFacade, type RunnerDoneVerdict } from "../src/runnerDone.js";
import { FAKE_APP_LOGIN, FakeGithub } from "../../runner-cloud/test/helpers/githubFake.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";

/**
 * [pg] D#6 R2b-3f: the `done` half of the lease facade against the real definers (0754), the real compare-and-set writer and a real
 * run-writer login; then the whole claim -> events -> done run through the real routes, the real facades and the real GitHub port over a
 * strict fake, which is the fixture that replaces #63's listed sequence.
 */
describe("runner done [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let A: SeedRefs;
  let runner: string;
  let facade: RunnerDoneFacade;
  let claims: ReturnType<typeof createRunnerClaimFacade>;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    facade = createRunnerDoneFacade(writerPool, { now: () => clock });
    claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    // The claim looks at every account's queue through its own tenant only, but other files leave running runner runs behind.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await admin.query("UPDATE work_items SET title = 'Add the footer' WHERE id = $1", [A.workItemId]);
    runner = await newRunner();
  });

  async function newRunner(key?: TestKey): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, key ? { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key" } : { credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [id, [A.repoId]]);
    return id;
  }

  async function spec(files: unknown): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind)
       VALUES ($1, $2, $3, (SELECT COALESCE(max(version), 0) + 1 FROM spec_versions WHERE work_item_id = $3), 'spec', $4, $5::jsonb, 'system')`,
      [id, A.accountId, A.workItemId, sha256Text("spec"), JSON.stringify({ acceptance_files: files })],
    );
    return id;
  }

  /** A pending runner run with a real signed job, ready to be claimed. */
  async function pending(o: { role?: string; specVersion?: string | null; continues?: { branch: string } } = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "widgets", private: true },
      role: (o.role ?? "executor") as Job["role"],
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: o.continues ? { parent_run_id: randomUUID(), session_id: "sess-1", branch: o.continues.branch } : null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(T0 - 1000).toISOString(),
      expires_at: new Date(T0 + 72 * 3_600_000).toISOString(),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, spec_version_id, created_at)
       VALUES ($1, $2, $3, $4, 'runner', 'pending', 'runner_local', $5, $6::jsonb, $7, $8, to_timestamp($9 / 1000.0))`,
      [id, A.accountId, A.workItemId, job.role, A.repoId, JSON.stringify(signJob(job, signing)), A.userId, o.specVersion ?? null, T0 - 5000],
    );
    return id;
  }
  const claimed = async (id: string, runnerId = runner): Promise<number> => {
    const r = await claims.claimRunnerRun({ accountId: A.accountId, runnerId });
    if (r.kind !== "claimed" || r.runId !== id) throw new Error("not claimed");
    return r.leaseGeneration;
  };
  const lease = (runId: string, leaseGeneration: number, runnerId = runner) => ({ accountId: A.accountId, runnerId, runId, leaseGeneration });
  const row = async (id: string) => (await admin.query("SELECT status, runner_id, lease_generation, lease_expires_at, cc_session_id, envelope, usd, tokens_in FROM agent_runs WHERE id = $1", [id])).rows[0];
  const statusEvents = async (id: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [id])).rows.map((r) => r.payload as Record<string, unknown>);
  const ok: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 5 };
  const nothingWritten = async (id: string, status = "running") => {
    const r = await row(id);
    expect(r.status).toBe(status);
    expect(r.cc_session_id).toBeNull();
    expect(r.envelope).toBeNull();
    expect((await statusEvents(id)).filter((p) => p.viaRunnerDone === true)).toEqual([]);
  };

  describe("begin", () => {
    it("proceeds for the runner that holds the run, renews the lease like a heartbeat, and changes nothing else", async () => {
      const id = await pending();
      const g = await claimed(id);
      clock = T0 + 30_000;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      expect((await row(id)).lease_expires_at.getTime()).toBe(T0 + 30_000 + 90_000);
      expect((await row(id)).status).toBe("running");
      expect(await statusEvents(id)).toEqual([{ from: "pending", to: "running" }]);
    });

    it("is fenced: a stale generation, another runner's, an unknown run, an expired lease and a run past its wall clock are each told why, and nothing moves", async () => {
      const id = await pending();
      const g = await claimed(id);
      const before = (await row(id)).lease_expires_at;
      expect(await facade.beginRunnerDone(lease(id, g + 1))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.beginRunnerDone(lease(id, g, await newRunner()))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.beginRunnerDone(lease(randomUUID(), g))).toEqual({ kind: "fenced", reason: "stale_generation" });
      clock = T0 + 90_000;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "fenced", reason: "lease_expired" });
      expect((await row(id)).lease_expires_at).toEqual(before);
      clock = T0;
      const started = (await admin.query("SELECT started_at FROM agent_runs WHERE id = $1", [id])).rows[0].started_at.getTime() as number;
      await admin.query("UPDATE agent_runs SET lease_expires_at = to_timestamp($2 / 1000.0) WHERE id = $1", [id, started + 3 * 3_600_000]);
      clock = started + 7_200_001;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "fenced", reason: "wall_clock_limit" });
      expect((await row(id)).status).toBe("running");
    });

    it("a run that finished some other way is a stop, never a replay: cancelled, failed by the sweeper's reason, or ended by a usage limit", async () => {
      for (const [status, failureReason] of [["cancelled", null], ["failed", "runner_lost"], ["failed", "usage_limit"], ["failed", "internal_error"], ["failed", "no_commit"], ["succeeded", null], ["timed_out", null]] as const) {
        const id = await pending();
        const g = await claimed(id);
        await admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [id, status]);
        await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 99, 'run.status_changed', $3::jsonb)", [A.accountId, id, JSON.stringify({ from: "running", to: status, ...(failureReason ? { failureReason } : {}) })]);
        expect(await facade.beginRunnerDone(lease(id, g)), `${status} ${failureReason}`).toEqual({ kind: "fenced", reason: "run_terminal" });
        await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [id]);
        clock = T0;
      }
    });
  });

  describe("finish", () => {
    it("records a success under the fence: status, the pull request number on the status event, the session id and the redacted envelope, usd still NULL", async () => {
      const id = await pending();
      const g = await claimed(id);
      const token = `ghp_${"A1b2".repeat(9)}`;
      const result = await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, sessionId: "7f0c1d2e-aaaa-bbbb", agentOutput: { verdict: "pass", note: `token ${token} leaked`, nested: { items: [1, 2] } } });
      expect(result).toEqual({ kind: "recorded", verdict: ok });
      const r = await row(id);
      expect(r).toMatchObject({ status: "succeeded", cc_session_id: "7f0c1d2e-aaaa-bbbb", usd: null, tokens_in: null });
      expect(JSON.stringify(r.envelope)).not.toContain(token);
      expect(r.envelope).toMatchObject({ verdict: "pass", nested: { items: [1, 2] } });
      expect(await statusEvents(id)).toEqual([{ from: "pending", to: "running" }, { from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 5 }]);
    });

    it("records the run branch next to the pull request number, and a replay gives it back (C25 section 1.2)", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      const verdict: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 5, branch };
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict })).toEqual({ kind: "recorded", verdict });
      expect((await statusEvents(id)).at(-1)).toEqual({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 5, branch });
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict });
      // The same reading the job issuer uses for a fix round.
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: id }))).toBe(branch);
    });

    it("a failed verdict with a pull request records its branch too; one without a pull request records none", async () => {
      const id = await pending();
      const g = await claimed(id);
      const branch = `fx/${id}-g${g}`;
      await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "scope_violation", prNumber: 4, branch } });
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict: { outcome: "failed", failureReason: "scope_violation", prNumber: 4, branch } });
      const none = await pending();
      const g2 = await claimed(none);
      await facade.finishRunnerDone({ ...lease(none, g2), verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null } });
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: none }))).toBeNull();
    });

    it("records every failure reason with its pull request number, HTTP status and detail", async () => {
      const cases: RunnerDoneVerdict[] = [
        { outcome: "failed", failureReason: "no_commit", prNumber: null },
        { outcome: "failed", failureReason: "scope_unknown", prNumber: null },
        { outcome: "failed", failureReason: "scope_unknown", prNumber: 3, detail: "renamed" },
        { outcome: "failed", failureReason: "scope_unknown", prNumber: 3, detail: "unknown_change_type" },
        { outcome: "failed", failureReason: "scope_violation", prNumber: 4 },
        { outcome: "failed", failureReason: "pr_rejected", prNumber: null, prHttpStatus: 422 },
        { outcome: "failed", failureReason: "pr_rejected", prNumber: null },
        { outcome: "failed", failureReason: "internal_error", prNumber: 9 },
      ];
      expect(new Set(cases.map((c) => c.failureReason))).toEqual(new Set(DONE_FAILURE_REASONS));
      for (const verdict of cases) {
        const id = await pending();
        const g = await claimed(id);
        expect(await facade.finishRunnerDone({ ...lease(id, g), verdict })).toEqual({ kind: "recorded", verdict });
        expect((await row(id)).status).toBe("failed");
        const event = (await statusEvents(id)).at(-1)!;
        expect(event).toMatchObject({ from: "running", to: "failed", failureReason: verdict.failureReason, viaRunnerDone: true, prNumber: verdict.prNumber });
        // A replay gives back exactly what was recorded.
        expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict });
        clock = T0;
      }
    });

    it("stores a session id and envelope on a failed run too (the fix round resumes from it)", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null }, sessionId: "sess-9", agentOutput: { verdict: "fail" } });
      expect(await row(id)).toMatchObject({ status: "failed", cc_session_id: "sess-9", envelope: { verdict: "fail" } });
    });

    it("drops an envelope that is still over the byte cap once redacted, instead of storing it", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, agentOutput: { big: "€".repeat(90_000) } });
      expect((await row(id)).envelope).toEqual(DROPPED_AGENT_OUTPUT);
    });

    it("is fenced inside the write transaction: a stale generation, another runner, and a lease that ended while GitHub was asked write nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      const extra = { sessionId: "sess-1", agentOutput: { a: 1 } };
      expect(await facade.finishRunnerDone({ ...lease(id, g + 1), verdict: ok, ...extra })).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.finishRunnerDone({ ...lease(id, g, await newRunner()), verdict: ok, ...extra })).toEqual({ kind: "fenced", reason: "stale_generation" });
      // begin passed, then the lease ended before finish: the second fence refuses.
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      clock = T0 + 90_000;
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, ...extra })).toEqual({ kind: "fenced", reason: "lease_expired" });
      await nothingWritten(id);
    });

    it("a lease renewed by begin lets finish through later in the same minute", async () => {
      const id = await pending();
      const g = await claimed(id);
      clock = T0 + 80_000;
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      clock = T0 + 80_000 + 60_000;
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok })).toMatchObject({ kind: "recorded" });
    });

    it("a run cancelled while GitHub was asked stays cancelled: finish is a stop and writes nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "proceed" });
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [id]);
      expect(await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, sessionId: "s", agentOutput: { a: 1 } })).toEqual({ kind: "fenced", reason: "run_terminal" });
      await nothingWritten(id, "cancelled");
    });

    it("refuses an invalid verdict, session id or ids before any SQL", async () => {
      const id = await pending();
      const g = await claimed(id);
      const bad: Array<Partial<Parameters<RunnerDoneFacade["finishRunnerDone"]>[0]>> = [
        { verdict: { outcome: "succeeded", failureReason: "no_commit", prNumber: null } as never },
        { verdict: { outcome: "failed", failureReason: null, prNumber: null } as never },
        { verdict: { outcome: "failed", failureReason: "usage_limit", prNumber: null } as never },
        { verdict: { outcome: "failed", failureReason: "runner_lost", prNumber: null } as never },
        { verdict: { outcome: "paused", failureReason: null, prNumber: null } as never },
        { verdict: { ...ok, prNumber: 0 } },
        { verdict: { ...ok, prNumber: 1.5 } },
        // A branch must be a run branch and may only accompany a pull request number.
        { verdict: { ...ok, branch: "fx/issue-12" } },
        { verdict: { ...ok, branch: "main" } },
        { verdict: { ...ok, branch: "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g0" } },
        { verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null, branch: "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1" } as never },
        { verdict: { outcome: "failed", failureReason: "pr_rejected", prNumber: null, prHttpStatus: 99 } },
        { verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null, detail: "renamed" } },
        { verdict: ok, sessionId: "bad session" },
        { verdict: null as never },
        { ...lease(id, -1), verdict: ok },
      ];
      for (const patch of bad) await expect(facade.finishRunnerDone({ ...lease(id, g), verdict: ok, ...patch }), JSON.stringify(patch)).rejects.toBeInstanceOf(RunActionInputError);
      await nothingWritten(id);
    });
  });

  describe("a repeat done replays what was stored (C21 section 1)", () => {
    it("begin after a recorded done answers the stored verdict, and writes nothing", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok });
      const events = await statusEvents(id);
      expect(await facade.beginRunnerDone(lease(id, g))).toEqual({ kind: "replay", verdict: ok });
      expect(await statusEvents(id)).toEqual(events);
    });

    it("a second finish answers the FIRST verdict, even one that differs, and records once", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok, sessionId: "first" });
      const second = await facade.finishRunnerDone({ ...lease(id, g), verdict: { outcome: "failed", failureReason: "no_commit", prNumber: null }, sessionId: "second" });
      expect(second).toEqual({ kind: "replay", verdict: ok });
      expect(await row(id)).toMatchObject({ status: "succeeded", cc_session_id: "first" });
      expect((await statusEvents(id)).filter((p) => p.viaRunnerDone === true)).toHaveLength(1);
    });

    it("only for the same runner and the same generation: any other is a stop", async () => {
      const id = await pending();
      const g = await claimed(id);
      await facade.finishRunnerDone({ ...lease(id, g), verdict: ok });
      expect(await facade.beginRunnerDone(lease(id, g + 1))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.beginRunnerDone(lease(id, g, await newRunner()))).toEqual({ kind: "fenced", reason: "stale_generation" });
      expect(await facade.finishRunnerDone({ ...lease(id, g + 1), verdict: ok })).toEqual({ kind: "fenced", reason: "stale_generation" });
    });

    it("two done attempts at the same moment record once; the other is told the winner's verdict", async () => {
      const id = await pending();
      const g = await claimed(id);
      const a: RunnerDoneVerdict = { outcome: "succeeded", failureReason: null, prNumber: 11 };
      const b: RunnerDoneVerdict = { outcome: "failed", failureReason: "scope_violation", prNumber: 12 };
      const results = await Promise.all([facade.finishRunnerDone({ ...lease(id, g), verdict: a }), facade.finishRunnerDone({ ...lease(id, g), verdict: b })]);
      expect(results.filter((r) => r.kind === "recorded")).toHaveLength(1);
      const winner = results.find((r) => r.kind === "recorded")!;
      const loser = results.find((r) => r.kind === "replay")!;
      expect(loser).toEqual({ kind: "replay", verdict: (winner as { verdict: RunnerDoneVerdict }).verdict });
      expect((await statusEvents(id)).filter((p) => p.viaRunnerDone === true)).toHaveLength(1);
    });
  });

  it("the dispatch record's event kind is the same string in the issuer and in the route", () => {
    expect(DISPATCH_BASE_KIND).toBe(RUNNER_DISPATCH_BASE_KIND);
  });

  describe("claim -> events -> done through the routes, the facades and the real GitHub port", () => {
    let key: TestKey;
    const BRANCH = (runId: string, g: number) => `fx/${runId}-g${g}`;
    let fake: FakeGithub;
    let deps: RunnerCloudDeps;
    let runnerKeyed: string;

    beforeEach(async () => {
      key = newKey();
      fake = new FakeGithub();
      fake.addRepo("acme", "widgets");
      const port = createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN });
      deps = { appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: { ...claims, ...facade }, pullRequests: port };
      runnerKeyed = await newRunner(key);
    });

    const send = (path: string, body: unknown) => signed(key, path, body);
    const run = (fn: () => Promise<{ status: number; body: unknown }>) => toResponse(fn);

    /** Claims `id` as the keyed runner, through the claim route. */
    async function claimRoute(id: string): Promise<number> {
      const res = await run(() => claimRun(deps, send(CLAIM_PATH, {})));
      const body = res.body as { run_id?: string; lease_generation?: number };
      if (res.status !== 200 || body.run_id !== id) throw new Error(`claim route: ${res.status} ${JSON.stringify(res.body)}`);
      return body.lease_generation!;
    }
    const done = (id: string, g: number, extra: object = {}) => run(() => doneRun(deps, send(donePath(id), { run_id: id, lease_generation: g, ...extra }), id));

    it("an executor's whole run: claim, heartbeat, events, done -> a ready pull request, status succeeded, only A1 to A5 and zero refusals", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      expect((await run(() => heartbeatRun(deps, send(HEARTBEAT_PATH, { run_id: id, lease_generation: g })))).status).toBe(200);
      const ev = { seq: 0, ts: new Date().toISOString(), type: "tool_use", tool_name: "Edit" };
      expect((await run(() => ingestEvents(deps, send(eventsPath(id), { run_id: id, lease_generation: g, events: [ev] }), id))).status).toBe(200);

      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "src/footer.ts", changeType: "ADDED" }], aheadBy: 2 });
      const res = await done(id, g, { session_id: "7f0c1d2e-aaaa", agentOutput: { verdict: "pass" } });
      expect(res.status).toBe(200);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(await row(id)).toMatchObject({ status: "succeeded", cc_session_id: "7f0c1d2e-aaaa", envelope: { verdict: "pass" }, usd: null });
      expect(repo.pulls).toHaveLength(1);
      expect(repo.pulls[0]).toMatchObject({ draft: false, state: "open", head: BRANCH(id, g), title: "Add the footer" });
      expect(fake.denied).toBe(0);
      expect([...new Set(fake.calls.map((c) => c.label.split(" ")[0]))].sort()).toEqual(["A1", "A2", "A3", "A4"]);
      expect(fake.calls.map((c) => c.label)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
      expect(runnerKeyed).toBeTruthy();

      // The idempotent repeat: the same reply, no GitHub call, no second write.
      const calls = fake.calls.length;
      const events = await statusEvents(id);
      const again = await done(id, g, { session_id: "other-session", agentOutput: { verdict: "fail" } });
      expect(again).toEqual({ ...res });
      expect(fake.calls.length).toBe(calls);
      expect(await statusEvents(id)).toEqual(events);
      expect(await row(id)).toMatchObject({ cc_session_id: "7f0c1d2e-aaaa", envelope: { verdict: "pass" } });
    });

    it("a violation ends the run failed with the pull request closed, and the repeat replays it", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "src/a.ts", changeType: "MODIFIED" }, { path: ".github/workflows/ci.yml", changeType: "MODIFIED" }] });
      const res = await done(id, g);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "failed", failure_reason: "scope_violation", pr_number: 1 });
      expect(repo.pulls[0]!.state).toBe("closed");
      expect((await row(id)).status).toBe("failed");
      expect(await done(id, g)).toEqual(res);
    });

    it("a reviewer's done succeeds with no GitHub call at all", async () => {
      const id = await pending({ role: "code-reviewer" });
      const g = await claimRoute(id);
      const res = await done(id, g, { agentOutput: { verdict: "pass" } });
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: null });
      expect(fake.calls).toEqual([]);
      expect((await row(id)).status).toBe("succeeded");
    });

    it("GitHub down: 503 { retry_after }, the run's outcome is not written, and the retry finishes it without a second pull request", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "src/a.ts", changeType: "MODIFIED" }] });
      fake.inject = { label: /^A1 PullRequestFiles$/, reply: { status: 502, body: {} } };
      const down = await done(id, g, { session_id: "sess-1", agentOutput: { v: 1 } });
      expect(down.status).toBe(503);
      expect(DoneRetryReply.parse(down.body)).toEqual({ retry_after: 15 });
      await nothingWritten(id);
      // The runner keeps heartbeating, and sends done again.
      expect((await run(() => heartbeatRun(deps, send(HEARTBEAT_PATH, { run_id: id, lease_generation: g })))).status).toBe(200);
      const retry = await done(id, g, { session_id: "sess-1", agentOutput: { v: 1 } });
      expect(DoneReply.parse(retry.body)).toMatchObject({ outcome: "succeeded", pr_number: 1 });
      expect(repo.pulls).toHaveLength(1);
    });

    it("a stale generation's done is a stop and its branch is never looked at; a done for a run another runner holds is a stop", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g + 1), { files: [{ path: "src/a.ts", changeType: "MODIFIED" }] });
      const res = await done(id, g + 1);
      expect(res.status).toBe(409);
      expect(StopReply.parse(res.body)).toEqual({ continue: false, reason: "stale_generation" });
      expect(fake.calls).toEqual([]);
      expect((await row(id)).status).toBe("running");
    });

    it("a revoked runner's done never reaches the facade", async () => {
      const id = await pending({ specVersion: await spec(["src/**"]) });
      const g = await claimRoute(id);
      await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerKeyed]);
      expect((await done(id, g)).status).toBe(401);
      expect(fake.calls).toEqual([]);
    });

    it("a docs-writer's whole run goes through the executor's path: its own branch, the scope check, a ready pull request, and its branch recorded (C25 section 3.1)", async () => {
      const id = await pending({ role: "docs-writer", specVersion: await spec(["docs/**"]) });
      const g = await claimRoute(id);
      const repo = fake.repos.get("acme/widgets")!;
      fake.pushBranch(repo, BRANCH(id, g), { files: [{ path: "docs/guide.md", changeType: "MODIFIED" }], aheadBy: 1 });
      const res = await done(id, g);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(repo.pulls[0]).toMatchObject({ head: BRANCH(id, g), draft: false });
      expect(await withTenant(writerPool, A.accountId, (c) => readRecordedRunnerBranch(c, { accountId: A.accountId, runId: id }))).toBe(BRANCH(id, g));
    });

    it("a docs-writer that pushed nothing ends succeeded with no pull request", async () => {
      const id = await pending({ role: "docs-writer", specVersion: await spec(["docs/**"]) });
      const g = await claimRoute(id);
      expect(DoneReply.parse((await done(id, g)).body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: null });
      expect(fake.repos.get("acme/widgets")!.pulls).toHaveLength(0);
    });

    it("the role list the route judges is the protocol's: every eligible role other than the executor and the docs-writer ends succeeded without GitHub", async () => {
      for (const role of RUNNER_ELIGIBLE_ROLES.filter((r) => r !== "executor" && r !== "docs-writer")) {
        const id = await pending({ role });
        const g = await claimRoute(id);
        expect(DoneReply.parse((await done(id, g)).body).outcome, role).toBe("succeeded");
        clock = T0;
        await admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour'");
      }
      expect(fake.calls).toEqual([]);
    });
  });
});
