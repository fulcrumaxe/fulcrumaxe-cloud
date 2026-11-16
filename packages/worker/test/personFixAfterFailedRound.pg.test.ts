import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION, DoneReply } from "@fulcrumaxe/runner-protocol";
import { ExecutionModeChangedError, NoSpecVersionError, RunPrecheckRefusedError, WorkItemHaltedError, RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, writeRunStatus, type ExecutionTargetRegistry } from "@fx/runner";
import { resumeAgentRun } from "@fx/pipeline";
import { startBuildForItem } from "@fx/pipeline/testing/build";
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
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { FIX_ROUND_REFUSAL_FALLBACK_SENTENCE, FIX_ROUND_STOP_SENTENCE, RESUME_FAILED_SENTENCE, ROUND_ALREADY_RUNNING_SENTENCE } from "@fx/core/src/work-items/baseSync.js";
import { RUNNER_CHAIN_HOPS_MAX, createAdvanceModule, type AdvanceReviewDeps } from "../src/advance.js";
import { nearestExecutorNote, readExecutorNote } from "../src/fixRoundNote.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../src/runnerDone.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { createSeatResolver } from "../src/seat.js";
import { createRunStarter } from "../src/starter.js";

/**
 * [pg] A person presses Request changes on a runner item whose earlier fix round ended `failed` with no session (a refused push). A runner run has one runner child
 * for ever (`agent_runs_runner_follow_up_key`), and the newest run with a session is still the build, so the new round used to be refused by that key and ended
 * `resume_failed` with nothing on the card. The world is built as in specPinFollowOn.pg.test.ts: the real build start, claim and done routes over a strict GitHub fake.
 */
describe("a person Request changes after a failed round starts a new round [pg]", { timeout: 120_000 }, () => {
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
  // FIXROUND-REFRESH-HEAD: the pull request's branch on GitHub is at the head each fix round below is asked for.
  const advanceModule = () => createAdvanceModule(writerPool, { starter, resolveRunSeat, startAdvance: async () => undefined, triage: null, registry, review: reviewDeps(), fixHeads: { privateHead: async () => "b".repeat(40), syncBase: async () => ({ kind: "up_to_date", baseSha: "c".repeat(40), baseRef: "main", stacked: false }) } });

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
    const out = await publishLightSpec(writerPool, a.accountId, t.workItemId, { feasible: true, reason: "", split_proposed: false, summary: "Fix the year.", spec: "1. The footer shows the year.\n2. A test pins it.", acceptance_files: N_FILES });
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
      // A fresh-session fix round is a job in the cross-side shape (a null session), which only a runner that said hello with the current protocol is offered (D#600 CX-7).
      await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}', protocol_version = $3 WHERE id = $1", [runnerId, [a.repoId], CURRENT_PROTOCOL_VERSION]);
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
      // D#600 CX-7: every fix round is a fresh session on the pull request's branch, so the pair the review step found goes with the request.
      pr: { number: 1, branch: buildBranch },
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

  const advanceFix = (w: Awaited<ReturnType<typeof builtWorld>>, over: Record<string, unknown> = {}) =>
    advanceModule().advanceStartFix({ accountId: w.a.accountId, userId: w.a.userId, workItemId: w.workItemId, haltEpoch: 0 }, {
      issue: nextNumber - 1, headSha: "b".repeat(40), prompt: "the person asks for changes", round: 1, actionId: randomUUID(), person: true, reviewer: "code",
      expectedExecutionMode: "runner_local", pr: { number: 1, branch: w.buildBranch }, ...over,
    } as never);
  const stageOf = async (workItemId: string) => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0].stage as string;
  const refusals = async (workItemId: string) => (await admin.query("SELECT code FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'fix_round_refused' ORDER BY created_at", [workItemId])).rows.map((r) => r.code as string);

  it("a person's Request changes starts a round after an earlier fix round ended failed with no session", async () => {
    const w = await builtWorld();
    const first = await w.startFix();
    if (!first.ok) throw new Error(`first round refused: ${first.reason}`);
    // The earlier round: the push was refused, the run ended failed and recorded no session.
    await writeRunStatus(writerPool, { accountId: w.a.accountId, runId: first.runId, from: "pending", to: "failed", failureReason: "internal_error" });
    expect((await admin.query("SELECT status, cc_session_id FROM agent_runs WHERE id = $1", [first.runId])).rows[0]).toEqual({ status: "failed", cc_session_id: null });
    const second = await advanceFix(w, { headSha: "d".repeat(40) });
    expect(await refusals(w.workItemId)).toEqual([]);
    if (!second.ok) throw new Error(`second round refused: ${second.reason}`);
    expect((await admin.query("SELECT status, parent_run_id FROM agent_runs WHERE id = $1", [second.runId])).rows[0]).toEqual({ status: "pending", parent_run_id: first.runId });
    // A third round, after the second also ended with no session, goes under the end of the chain, not under the build.
    await writeRunStatus(writerPool, { accountId: w.a.accountId, runId: second.runId, from: "pending", to: "failed", failureReason: "internal_error" });
    const third = await advanceFix(w, { headSha: "e".repeat(40) });
    if (!third.ok) throw new Error(`third round refused: ${third.reason}`);
    expect((await admin.query("SELECT parent_run_id FROM agent_runs WHERE id = $1", [third.runId])).rows[0].parent_run_id).toBe(second.runId);
    expect(await refusals(w.workItemId)).toEqual([]);
  });

  const activity = (w: Awaited<ReturnType<typeof builtWorld>>) => getWorkItemActivity({ pool: adminPool, principal: { accountId: w.a.accountId, userId: w.a.userId } }, w.workItemId);
  const failingStarter = (err: unknown) => createAdvanceModule(writerPool, { starter: { start: async () => { throw err; } } as never, resolveRunSeat, startAdvance: async () => undefined, triage: null, registry, review: reviewDeps(), fixHeads: { privateHead: async () => "b".repeat(40), syncBase: async () => ({ kind: "up_to_date", baseSha: "c".repeat(40), baseRef: "main", stacked: false }) } });
  const press = (w: Awaited<ReturnType<typeof builtWorld>>, m: ReturnType<typeof failingStarter>) =>
    m.advanceStartFix({ accountId: w.a.accountId, userId: w.a.userId, workItemId: w.workItemId, haltEpoch: 0 }, { issue: nextNumber - 1, headSha: "d".repeat(40), prompt: "changes", round: 1, actionId: randomUUID(), person: true, reviewer: "code", expectedExecutionMode: "runner_local", pr: { number: 1, branch: w.buildBranch } } as never);

  it("a start that fails for another reason leaves a sentence on the card, and a later start clears it", async () => {
    const w = await builtWorld();
    const out = await press(w, failingStarter(new Error("boom")));
    expect(out).toEqual({ ok: false, reason: "resume_failed" });
    expect(await stageOf(w.workItemId)).toBe("changes_requested");
    expect((await activity(w)).notice).toEqual({ kind: "check_failed", reason: RESUME_FAILED_SENTENCE });
    expect(FIX_ROUND_STOP_SENTENCE["resume_failed"]).toBe(RESUME_FAILED_SENTENCE);
    // The person presses again and the round starts: the old refusal no longer speaks.
    const ok = await advanceFix(w, { headSha: "f".repeat(40) });
    expect(ok.ok).toBe(true);
    await writeRunStatus(writerPool, { accountId: w.a.accountId, runId: (ok as { runId: string }).runId, from: "pending", to: "cancelled" });
    expect((await activity(w)).notice).toBeNull();
  });

  it.each(["agent_runs_one_live_continuation_per_parent", "agent_runs_runner_follow_up_key"])("the database's %s refusing the new run is answered already_running, with a sentence the person sees", async (constraint) => {
    const w = await builtWorld();
    const out = await press(w, failingStarter(Object.assign(new Error("duplicate key"), { code: "23505", constraint })));
    expect(out).toEqual({ ok: false, reason: "already_running" });
    expect(await refusals(w.workItemId)).toEqual(["already_running"]);
    expect((await activity(w)).notice).toEqual({ kind: "check_failed", reason: ROUND_ALREADY_RUNNING_SENTENCE });
    // The notice only shows while no run is live, so it must not claim a round is still in progress.
    const shown = ((await activity(w)).notice as { reason: string }).reason;
    expect(shown).toContain("record was in the way");
    expect(shown).not.toMatch(/in progress|still recorded/);
  });

  // Every refusal after the item has moved to Changes requested shows the person a fixed, non-empty sentence (never the code); an unmapped code shows the generic one.
  it.each([
    ["no_spec_version", () => new NoSpecVersionError()],
    ["execution_mode_changed", () => new ExecutionModeChangedError()],
    ["item_halted", () => new WorkItemHaltedError()],
    ["verified_consent_stale", () => new RunPrecheckRefusedError("verified_consent_stale")],
  ])("a %s refusal leaves a non-empty sentence on the card", async (code, err) => {
    const w = await builtWorld();
    const out = await press(w, failingStarter(err()));
    expect(out).toEqual({ ok: false, reason: code });
    expect(await refusals(w.workItemId)).toEqual([code]);
    const notice = (await activity(w)).notice as { kind: string; reason: string } | null;
    expect(notice?.kind).toBe("check_failed");
    expect(notice?.reason.length ?? 0).toBeGreaterThan(20);
    expect(notice?.reason).not.toContain(code);
    expect(notice?.reason).not.toBe(FIX_ROUND_REFUSAL_FALLBACK_SENTENCE);
  });

  it("a refusal code with no sentence of its own shows the generic sentence and never the code", async () => {
    const w = await builtWorld();
    const out = await press(w, failingStarter(new RunPrecheckRefusedError("zzq_unmapped_reason" as never)));
    expect(out).toEqual({ ok: false, reason: "zzq_unmapped_reason" });
    const notice = (await activity(w)).notice as { kind: string; reason: string } | null;
    expect(notice).toEqual({ kind: "check_failed", reason: FIX_ROUND_REFUSAL_FALLBACK_SENTENCE });
    expect(JSON.stringify(notice)).not.toContain("zzq_unmapped_reason");
  });

  it.each([
    ["a pg error", { code: "23505", constraint: "agent_runs_other_key" }, "23505", "agent_runs_other_key"],
    ["a constraint name that fails the identifier check", { code: "23505", constraint: "bad name; DROP TABLE x" }, "23505", null],
  ])("advance.resume_failed logs the fixed pg identifiers and never the message: %s", async (_name, fields, pgCode, pgConstraint) => {
    const w = await builtWorld();
    const marker = `PLANTED_MARKER_${randomUUID()}`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await press(w, failingStarter(Object.assign(new Error(`row values ${marker}`), fields)));
      expect(out).toEqual({ ok: false, reason: "resume_failed" });
      const lines = warn.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes("advance.resume_failed"));
      expect(line).toBeDefined();
      expect(JSON.parse(line!)).toMatchObject({ event: "advance.resume_failed", pg_code: pgCode, pg_constraint: pgConstraint });
      for (const l of lines) expect(l).not.toContain(marker);
    } finally {
      warn.mockRestore();
    }
  });

  it("a chain of failed sessionless rounds is walked to its end, and one past the cap is refused with its own sentence", async () => {
    const w = await builtWorld();
    let headChar = 0;
    for (let i = 0; i < RUNNER_CHAIN_HOPS_MAX; i++) {
      const r = await advanceFix(w, { headSha: (headChar++).toString(16).padStart(2, "0").repeat(20) });
      if (!r.ok) throw new Error(`round ${i} refused: ${r.reason}`);
      await writeRunStatus(writerPool, { accountId: w.a.accountId, runId: r.runId, from: "pending", to: "failed", failureReason: "internal_error" });
    }
    const out = await advanceFix(w, { headSha: "ff".repeat(20) });
    expect(out).toEqual({ ok: false, reason: "parent_chain_too_long" });
    expect(await refusals(w.workItemId)).toEqual(["parent_chain_too_long"]);
    const notice = (await activity(w)).notice as { reason: string };
    expect(notice.reason).toContain("too many earlier rounds");
    expect(notice.reason).not.toContain("parent_chain_too_long");
  });

  it("the build's closing note is found from a failed sessionless round above it", async () => {
    const w = await builtWorld();
    await admin.query("UPDATE agent_runs SET envelope = $2::jsonb WHERE id = $1", [w.buildRunId, JSON.stringify({ summary: "BUILD CLOSING NOTE" })]);
    const first = await w.startFix();
    if (!first.ok) throw new Error(`first round refused: ${first.reason}`);
    await writeRunStatus(writerPool, { accountId: w.a.accountId, runId: first.runId, from: "pending", to: "failed", failureReason: "internal_error" });
    expect(await readExecutorNote(admin, w.a.accountId, first.runId, w.workItemId)).toBeUndefined();
    expect(await nearestExecutorNote(admin, w.a.accountId, w.workItemId, first.runId)).toBe("BUILD CLOSING NOTE");
    expect(await nearestExecutorNote(admin, w.a.accountId, randomUUID(), first.runId)).toBeUndefined();
  });
});
