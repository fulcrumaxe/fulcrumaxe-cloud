import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DoneReply } from "@fulcrumaxe/runner-protocol";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, insertAgentRun, writeRunStatus, type ExecutionTargetRegistry } from "@fx/runner";
import { resumeAgentRun, startBuildForItem } from "@fx/pipeline";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { CLAIM_PATH, claimRun, createRunPullRequestPort, donePath, doneRun, loadAcceptanceScope, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { publishLightSpec } from "../../pipeline/src/advance/lightSpec.js";
import type { AdvanceRunPorts } from "../../pipeline/src/advance/runPorts.js";
import { runTriageStep } from "../../pipeline/src/plan/step.js";
import { OWNER, fixtureClassifier } from "../../pipeline/test/plan/helpers/panelFixtures.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { FAKE_APP_LOGIN, FakeGithub } from "../../runner-cloud/test/helpers/githubFake.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";
import { createAdvanceModule, type AdvanceReviewDeps } from "../src/advance.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createRetryModule, type RetrySeatSource } from "../src/retry.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../src/runnerDone.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { createSeatResolver } from "../src/seat.js";
import { createRunStarter } from "../src/starter.js";

/**
 * D#6 R4d-5c (C36) [pg]: a runner repo's fix round and retry carry the Spec version their parent was built against, and the done check holds them to it.
 * The world is the one the product makes: a Spec written by `publishLightSpec`, a build started by `startBuildForItem` over the production starter,
 * `RunnerTarget` and the real job issuer, claimed through the real claim route and finished by the real done route (so its pull request and branch are
 * recorded). THEN a second Spec version N+1 (acceptance_files src/z.ts, another body) is published. The fix round is started by the real
 * `advanceStartFix` over the pipeline's real `resumeAgentRun`, and read by the real `loadAcceptanceScope`, the real job context and the real done route over a
 * strict fake of GitHub. "Inherit the parent's" and "take the latest" give different answers everywhere below.
 */
describe("a runner follow-on run keeps its parent's Spec version [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const { privateKey } = generateKeyPairSync("ed25519");
  const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });
  let nextNumber = 9500;
  const N_FILES = ["src/a.ts"];
  const N1_BODY = "REVISED SPEC: version two, a different text";

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    registry = registryOf();
    starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    resolveRunSeat = createSeatResolver({ pool: writerPool });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
  });

  const visibility = { visibility: async () => "private" as const };
  function registryOf(): ExecutionTargetRegistry {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => "a".repeat(40) } });
    return { sandbox: new SandboxTarget(harness.deps), runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }) };
  }
  let registry: ExecutionTargetRegistry;
  let starter: ReturnType<typeof createRunStarter>;
  let resolveRunSeat: ReturnType<typeof createSeatResolver>;

  /** `resume` is the pipeline's real `resumeAgentRun`, as the web app wires it; the rest of the review pieces are never reached by a fix round. */
  const reviewDeps = (): AdvanceReviewDeps => ({
    load: async () => ({ ok: false, reason: "unused" }),
    recordRound: async () => {
      throw new Error("unused");
    },
    resume: (pool, reg, input) => resumeAgentRun(pool, reg, input),
    mergeGate: async () => {
      throw new Error("unused");
    },
  });
  const advanceModule = () => createAdvanceModule(writerPool, { starter, resolveRunSeat, startAdvance: async () => undefined, triage: null, registry, review: reviewDeps() });

  function ports(accountId: string, workItemId: string): AdvanceRunPorts {
    const m = advanceModule();
    return {
      startRun: (req) => m.advanceStartRun({ ...req, accountId, workItemId, haltEpoch: 0 }),
      outcome: (runId) => m.advanceRunOutcome(accountId, runId),
      cancel: async () => undefined,
    };
  }

  async function account(mode: "runner_local" | "sandbox" = "runner_local"): Promise<SeedRefs> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId, mode]);
    return a;
  }

  /** The short Spec path: a triaged bug and the real `publishLightSpec`, which publishes version N with the list N_FILES and the body below. */
  async function specN(a: SeedRefs): Promise<{ workItemId: string; versionN: string; bodyN: string }> {
    const t = await runTriageStep(
      { pool: writerPool, accountId: a.accountId, classifier: fixtureClassifier("bug") },
      { mode: "new", event: { ...OWNER, body: "The footer shows the wrong year." }, title: "Add the footer", sourceEventId: randomUUID(), repoId: a.repoId },
    );
    if (t.status !== "triaged") throw new Error(`fixture: ${JSON.stringify(t)}`);
    await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [t.workItemId, nextNumber++, a.repoId]);
    const out = await publishLightSpec(writerPool, a.accountId, t.workItemId, { feasible: true, reason: "", summary: "Fix the year.", spec: "1. The footer shows the year.\n2. A test pins it.", acceptance_files: N_FILES });
    if (out.status !== "published") throw new Error(`fixture: ${JSON.stringify(out)}`);
    const row = (await admin.query<{ id: string; body: string }>("SELECT id, body FROM spec_versions WHERE work_item_id = $1", [t.workItemId])).rows[0]!;
    return { workItemId: t.workItemId, versionN: row.id, bodyN: row.body };
  }

  /** Version N+1: published after the build, with another list and another text. */
  async function publishN1(a: SeedRefs, workItemId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind)
       VALUES ($1, $2, $3, 2, $4, encode(sha256(convert_to($4, 'UTF8')), 'hex'), $5::jsonb, 'system')`,
      [id, a.accountId, workItemId, N1_BODY, JSON.stringify({ acceptance_files: ["src/z.ts"] })],
    );
    return id;
  }

  /** Builds on the runner, claims and finishes it (a pull request and its branch are recorded), gives it a session, then publishes N+1. */
  async function builtWorld() {
    const a = await account();
    const spec = await specN(a);
    const out = await startBuildForItem(writerPool, a.accountId, spec.workItemId, randomUUID(), ports(a.accountId, spec.workItemId));
    if (out.status !== "started") throw new Error(`build not started: ${out.reason}`);
    const buildRunId = out.runId;
    expect((await admin.query("SELECT spec_version_id FROM agent_runs WHERE id = $1", [buildRunId])).rows[0].spec_version_id).toBe(spec.versionN);

    const fake = new FakeGithub();
    const repo = fake.addRepo("acme", "widgets");
    const claims = createRunnerClaimFacade(writerPool, { visibility, randomBetween: (min) => min });
    const done = createRunnerDoneFacade(writerPool);
    const deps: RunnerCloudDeps = {
      appUserPool: appPool,
      origin: ORIGIN,
      failRunnerLeases: null,
      leases: { ...claims, ...done, ...gitTickets },
      pullRequests: createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN }),
    };
    // Each claim comes from its own runner: a runner that has just claimed is held back from claiming again for a few seconds.
    let key: TestKey = newKey();
    const claimNext = async (expectRunId: string) => {
      key = newKey();
      const runnerId = await insertRunner(admin, a.accountId, a.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key" });
      await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerId, [a.repoId]]);
      const claim = await toResponse(() => claimRun(deps, signed(key, CLAIM_PATH, {})));
      const claimed = claim.body as { run_id?: string; lease_generation?: number };
      if (claim.status !== 200 || claimed.run_id !== expectRunId) throw new Error(`claim: ${claim.status} ${JSON.stringify(claim.body)}`);
      return claimed.lease_generation!;
    };
    const finish = (runId: string, g: number, branch: string, oid: string, files: string[]) => {
      fake.pushBranch(repo, branch, { oid, files: files.map((path) => ({ path, changeType: "ADDED" as const })), aheadBy: 1 });
      return toResponse(() => doneRun(deps, signed(key, donePath(runId), { run_id: runId, lease_generation: g }), runId));
    };

    const g = await claimNext(buildRunId);
    const buildBranch = `fx/${buildRunId}-g${g}`;
    const first = await finish(buildRunId, g, buildBranch, "b".repeat(40), N_FILES);
    expect(DoneReply.parse(first.body)).toMatchObject({ outcome: "succeeded", pr_number: 1 });
    // The build's session and the PR stage, as the advance driver and the runner's session report leave them.
    await admin.query("UPDATE agent_runs SET cc_session_id = 'cc-build-session' WHERE id = $1", [buildRunId]);
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [spec.workItemId]);
    } finally {
      await admin.query("SET session_replication_role = DEFAULT");
    }
    const versionN1 = await publishN1(a, spec.workItemId);
    expect(versionN1).not.toBe(spec.versionN);

    const fixRequest = (over: Partial<Parameters<ReturnType<typeof advanceModule>["advanceStartFix"]>[1]> = {}) => ({
      issue: nextNumber - 1,
      headSha: "b".repeat(40),
      prompt: "fix the review findings",
      round: 1,
      actionId: randomUUID(),
      reviewer: "code" as const,
      failingRunId: randomUUID(),
      expectedExecutionMode: "runner_local",
      ...over,
    });
    const who = { accountId: a.accountId, userId: a.userId, workItemId: spec.workItemId, haltEpoch: 0 };
    return {
      a, ...spec, versionN1, buildRunId, buildBranch, fake, repo,
      startFix: () => advanceModule().advanceStartFix(who, fixRequest()),
      claimNext,
      finish,
      scope: (runId: string) => withTenant(appPool, a.accountId, (client) => loadAcceptanceScope(client, { accountId: a.accountId, runId })),
    };
  }

  const pinOf = async (runId: string) => (await admin.query("SELECT spec_version_id FROM agent_runs WHERE id = $1", [runId])).rows[0].spec_version_id as string | null;
  const count = async (a: SeedRefs, where = "TRUE") => Number((await admin.query(`SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND ${where}`, [a.accountId])).rows[0].n);
  const stageOf = async (workItemId: string) => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0].stage as string;

  describe("G2 the advance fix round", () => {
    it("starts a fix-round run pinned to the build's version N, with the build as its parent, not the latest N+1", async () => {
      const w = await builtWorld();
      const out = await w.startFix();
      if (!out.ok) throw new Error(`fix round refused: ${out.reason}`);
      expect((await admin.query("SELECT parent_run_id, role, runtime FROM agent_runs WHERE id = $1", [out.runId])).rows[0]).toEqual({ parent_run_id: w.buildRunId, role: "executor", runtime: "runner" });
      expect(await pinOf(out.runId)).toBe(w.versionN);
      expect(await pinOf(out.runId)).not.toBe(w.versionN1);
    });
  });

  describe("G7 the job text matches the pin", () => {
    it("the job issued for the fix round carries version N's body and number, not N+1's", async () => {
      const w = await builtWorld();
      const out = await w.startFix();
      if (!out.ok) throw new Error(`fix round refused: ${out.reason}`);
      const job = (await admin.query<{ job_signed: { job: { spec: { version: number; text: string } | null; task: { kind: string } } } }>("SELECT job_signed FROM agent_runs WHERE id = $1", [out.runId])).rows[0]!.job_signed.job;
      expect(job.task.kind).toBe("fix");
      expect(job.spec).toMatchObject({ version: 1, text: w.bodyN });
      expect(job.spec!.text).not.toContain("REVISED SPEC");
    });
  });

  describe("G6 the done check reads the fix round's own scope", () => {
    it("loadAcceptanceScope for the fix round's run id is known with exactly src/a.ts; a change to src/a.ts does not end scope_unknown", async () => {
      const w = await builtWorld();
      const out = await w.startFix();
      if (!out.ok) throw new Error(`fix round refused: ${out.reason}`);
      expect(await w.scope(out.runId)).toEqual({ kind: "known", entries: ["src/a.ts"] });
      const g = await w.claimNext(out.runId);
      const res = await w.finish(out.runId, g, w.buildBranch, "c".repeat(40), ["src/a.ts"]);
      const reply = DoneReply.parse(res.body);
      expect(reply.failure_reason).not.toBe("scope_unknown");
      expect(reply).toMatchObject({ outcome: "succeeded", failure_reason: null });
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [out.runId])).rows[0].status).toBe("succeeded");
    });

    it("the same fix round reporting src/z.ts (N+1's file) ends scope_violation, with the pull request closed", async () => {
      const w = await builtWorld();
      const out = await w.startFix();
      if (!out.ok) throw new Error(`fix round refused: ${out.reason}`);
      const g = await w.claimNext(out.runId);
      const res = await w.finish(out.runId, g, w.buildBranch, "c".repeat(40), ["src/z.ts"]);
      expect(DoneReply.parse(res.body)).toMatchObject({ outcome: "failed", failure_reason: "scope_violation" });
      expect(w.repo.pulls[0]!.state).toBe("closed");
    });
  });

  describe("G1 retry", () => {
    const seats = (): RetrySeatSource => ({
      async retrySeat(input) {
        const { rows } = await admin.query("SELECT repo_id FROM work_items WHERE id = $1 AND account_id = $2", [input.workItemId, input.accountId]);
        return {
          ok: true,
          seat: {
            repoId: rows[0].repo_id, product: "team", roleCard: "role card", model: "haiku-4.5", capUsd: 5,
            spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
            limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
            timeoutMs: 40 * 60_000,
            maxExtensions: 3,
          },
        } as never;
      },
    });
    const retryOf = async (a: SeedRefs, runId: string) => {
      const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('retry_run', $1, NULL, $2)", [runId, "h".repeat(64)])).rows[0]);
      expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(row.action_id, 600)).not.toBeNull();
      return createRetryModule(writerPool, registry, { seats: seats(), authorCheck: () => null }).performRetryRun(row.action_id);
    };
    const runIdOf = (out: Awaited<ReturnType<typeof retryOf>>): string => (out as unknown as { outcome: { run_id: string } }).outcome.run_id;
    /** A pending runner run is ended `failed` the way a runner loss ends it, so it can be retried. */
    const fail = (a: SeedRefs, runId: string) => writeRunStatus(writerPool, { accountId: a.accountId, runId, from: "pending", to: "failed", failureReason: "internal_error" });

    it("a retry of a failed runner executor run pinned to N creates a child pinned to N, and a retry of a fix round pinned to N is pinned to N again", async () => {
      const w = await builtWorld();
      const fix = await w.startFix();
      if (!fix.ok) throw new Error(`fix round refused: ${fix.reason}`);
      await fail(w.a, fix.runId);
      // `resumeAgentRun` does not retain its prompt (no `run.input` row), and a retry refuses a run with none (`prompt_not_retained`); the one fact the test adds
      // to the fix round is that retained prompt, so that the retry can start. The child run itself is made by the real retry performer.
      await admin.query(
        "INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM run_events WHERE run_id = $2), 'run.input', $3::jsonb)",
        [w.a.accountId, fix.runId, JSON.stringify({ prompt: "fix the review findings", prompt_sha256: "0".repeat(64) })],
      );
      const retried = await retryOf(w.a, fix.runId);
      expect(retried).toMatchObject({ result: "done" });
      const child = runIdOf(retried);
      expect((await admin.query("SELECT parent_run_id FROM agent_runs WHERE id = $1", [child])).rows[0].parent_run_id).toBe(fix.runId);
      expect(await pinOf(child)).toBe(w.versionN);
      expect(await pinOf(child)).not.toBe(w.versionN1);

      // The build run itself: another world, a build that failed before its work was reported.
      const w2 = await (async () => {
        const a = await account();
        const spec = await specN(a);
        const started = await startBuildForItem(writerPool, a.accountId, spec.workItemId, randomUUID(), ports(a.accountId, spec.workItemId));
        if (started.status !== "started") throw new Error("fixture");
        await publishN1(a, spec.workItemId);
        return { a, ...spec, buildRunId: started.runId };
      })();
      await fail(w2.a, w2.buildRunId);
      const second = await retryOf(w2.a, w2.buildRunId);
      expect(second).toMatchObject({ result: "done" });
      expect(await pinOf(runIdOf(second))).toBe(w2.versionN);
    });
  });

  describe("G8 refusal when the parent has no Spec version (runner_local)", () => {
    /** A runner executor run built before the pin: no version, a session, an item at pr_opened. */
    async function unpinnedWorld(mode: "runner_local" | "sandbox") {
      const a = await account(mode);
      const workItemId = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [workItemId, a.accountId, a.repoId, nextNumber++]);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(), accountId: a.accountId, workItemId, role: "executor", runtime: mode === "runner_local" ? "runner" : "production", executionMode: mode, dispatchRepoId: a.repoId, dispatchPrNumber: nextNumber - 1,
        startPrompt: "the build prompt",
      });
      await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running", result: { sessionId: "cc-old" } });
      await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: "failed", failureReason: "internal_error" });
      expect(await pinOf(id)).toBeNull();
      return { a, workItemId, buildRunId: id, issue: nextNumber - 1 };
    }
    const fixReq = (issue: number, mode: string) => ({ issue, headSha: "b".repeat(40), prompt: "fix", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID(), expectedExecutionMode: mode });

    it("the advance fix round is refused no_spec_version: no new run row, no job; the stage write it already made is the only change", async () => {
      const u = await unpinnedWorld("runner_local");
      const before = await count(u.a);
      const out = await advanceModule().advanceStartFix({ accountId: u.a.accountId, userId: u.a.userId, workItemId: u.workItemId, haltEpoch: 0 }, fixReq(u.issue, "runner_local"));
      expect(out).toEqual({ ok: false, reason: "no_spec_version" });
      expect(await count(u.a)).toBe(before);
      expect(await count(u.a, "job_signed IS NOT NULL")).toBe(0);
      expect(await stageOf(u.workItemId)).toBe("changes_requested"); // recordStage ran before the start, as it always did
      expect((await admin.query("SELECT code FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'fix_round_refused'", [u.workItemId])).rows).toEqual([{ code: "no_spec_version" }]);
    });

    it("retry is refused no_spec_version: no new run row, no job, no idempotency claim, the stage unchanged", async () => {
      const u = await unpinnedWorld("runner_local");
      const row = await withTenant(appPool, u.a.accountId, u.a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('retry_run', $1, NULL, $2)", [u.buildRunId, "h".repeat(64)])).rows[0]);
      expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(row.action_id, 600)).not.toBeNull();
      const retry = createRetryModule(writerPool, registry, {
        seats: { retrySeat: async (i) => ({ ok: true, seat: { repoId: (await admin.query("SELECT repo_id FROM work_items WHERE id = $1", [i.workItemId])).rows[0].repo_id, product: "team", roleCard: "c", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 }, limits: { maxRunMs: 1_800_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 900_000 }, timeoutMs: 2_400_000, maxExtensions: 3 } as never }) },
        authorCheck: () => null,
      });
      const before = await count(u.a);
      expect(await retry.performRetryRun(row.action_id)).toEqual({ result: "refused", errorCode: "no_spec_version" });
      expect(await count(u.a)).toBe(before);
      expect(await count(u.a, "job_signed IS NOT NULL")).toBe(0);
      expect(Number((await admin.query("SELECT count(*) AS n FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [u.a.accountId, `run-action:${row.action_id}`])).rows[0].n)).toBe(0);
      expect(await stageOf(u.workItemId)).toBe("pr_opened");
    });

    it("control: on a sandbox repo the same fix round starts a run with a null version", async () => {
      const u = await unpinnedWorld("sandbox");
      const out = await advanceModule().advanceStartFix({ accountId: u.a.accountId, userId: u.a.userId, workItemId: u.workItemId, haltEpoch: 0 }, fixReq(u.issue, "sandbox"));
      if (!out.ok) throw new Error(`control refused: ${out.reason}`);
      expect(await pinOf(out.runId)).toBeNull();
    });
  });
});
