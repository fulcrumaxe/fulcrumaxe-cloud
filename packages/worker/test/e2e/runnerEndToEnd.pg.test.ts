import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createPublicKey, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jwkThumbprint, verifyJob, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { createAdvanceModule } from "../../src/advance.js";
import { createRunnerClaimFacade } from "../../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../../src/runnerDone.js";
import { createRunnerGitTicketFacade } from "../../src/runnerGitTicket.js";
import { createSeatResolver } from "../../src/seat.js";
import { createRunStarter } from "../../src/starter.js";
import { startBuildForItem } from "../../../pipeline/src/advance/build.js";
import { buildLightSpecPrompt, publishLightSpec } from "../../../pipeline/src/advance/lightSpec.js";
import type { AdvanceRunPorts } from "../../../pipeline/src/advance/runPorts.js";
import { loadRunsOnSha, reviewerReasons } from "../../../pipeline/src/build/mergeGate.js";
import { runTriageStep } from "../../../pipeline/src/plan/step.js";
import { OWNER, fixtureClassifier } from "../../../pipeline/test/plan/helpers/panelFixtures.js";
import { createSandboxTargetHarness } from "../../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../../runner/test/helpers/runnerTargetFakes.js";
import { GITHUB_GRAPHQL_DOCUMENTS, approveRun, type RunnerCloudDeps } from "@fx/runner-cloud";
import { FAKE_APP_LOGIN, FakeGithub, type FakeRepo } from "../../../runner-cloud/test/helpers/githubFake.js";
import { newKey } from "../../../runner-cloud/test/helpers.js";
import { backFakeWithBare, createBareGithub, type BareGithub } from "./harness/bareGithub.js";
import { startCloudServer, type CloudServer } from "./harness/cloudServer.js";
import { createFakeAgent, type FakeAgent } from "./harness/fakeAgent.js";
import { createHarnessPullRequestPort, createHarnessReadHttp, startGithubServer, type GithubServer } from "./harness/githubServer.js";
import { createHarnessReviewDeps, findRecordedPr, startReviewer } from "./harness/reviewDispatch.js";
import { createRunnerRig, type RunnerRig } from "./harness/runnerRig.js";

/**
 * D#6 R4d-6 (C34 section 5), Stage 1 sign-off: ONE test of the whole runner build path, from the product's own Spec writer to an opened pull request, with real
 * Postgres and real git and nothing on the path written by hand.
 *
 *   triage (fake classifier) -> the project manager's short-Spec run, a REAL runner job whose agent is a fake CLI printing a fake PM's AGENT_OUTPUT with two files
 *   -> the real `advanceLightSpec` / `publishLightSpec` (which store the file list) -> the real `startBuildForItem` and production run starter ->
 *   `RunnerTarget` and the real job issuer with a real Ed25519 signer -> the real fx-runner job path (signed-request client, `verifyJob`, mirror and workspace from a
 *   local bare repository, the Claude engine over a fake agent binary that commits two files, `publishBranch` to the bare repository) -> the real claim, events and
 *   done routes over HTTP -> the cloud's real GitHub client against a strict fake GitHub API over HTTP, which reads what the runner really pushed.
 *
 * What the harness writes by hand is the fixture accounts, repository, runner registration and the issue's work item (as every pg test here does); it writes no
 * Spec-version row, no run row, and it never records a signed job itself: a source scan at the end of this file holds that.
 *
 * The review job (R4d-6r, C35 section 3.5, E5 and E6): after the pull request opens, the review dispatch (harness/reviewDispatch.ts) finds it and starts a
 * `code-reviewer` run on its head; the issuer signs a job carrying `review.head_sha`; the same runner prepares a detached workspace at that commit; a fake reviewer
 * binary fails the run unless `git rev-parse HEAD` is the pull request's head, HEAD is detached and no branch of the run exists; the real done route records the
 * verdict, and the merge gate's reviewer half reads it for that head. The head is never typed by the test (E6's scan covers it).
 *
 * GitHub's side follows the real contract for what the product's pull-request token gets: markPullRequestReadyForReview is refused (C37), so a build's pull request
 * stays a draft; E5 also runs with a token that may mark it ready, since a review is dispatched on the number and head whatever the draft state.
 */
/** What this harness must never write itself, because the product writes it on this path (E3), and the reviewed commit of a review job (E6). */
const FORBIDDEN_WRITES = [
  ["INSERT INTO ", "spec_versions"],
  ["INSERT INTO ", "agent_runs"],
  ["agent_run_set_", "runner_job"],
  ["INSERT INTO ", "run_events"],
  ["INSERT INTO ", "work_item_stages"],
  // E6: the job's `review` key written with a head, the key assigned, the run row's head updated, or a literal sha handed over as the head.
  ["review[\"']?\\s*:\\s*\\{\\s*[\"']?head_", "sha"],
  ["\\.review(\\.head_", "sha)?\\s*=[^=>]"],
  ["UPDATE agent_runs SET[^;`\"']*head_", "sha"],
  ["head_?", "sha[\"']?\\s*[:=]\\s*[\"'`][0-9a-f]{7,}"],
].map((parts) => new RegExp(parts.join(""), "i"));

describe("the runner build path, end to end [pg]", { timeout: 180_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;

  const jobKey = generateKeyPairSync("ed25519").privateKey;
  const keyring: JobKeyring = { "e2e-key": { ...(createPublicKey(jobKey).export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string }) } };

  let agent: FakeAgent;
  let bare: BareGithub;
  let fake: FakeGithub;
  let repo: FakeRepo;
  let github: GithubServer;
  let cloud: CloudServer;
  /** The runner of the scenario under way: a new key and a new registration in each, since a key belongs to one runner row. */
  let rig: RunnerRig | undefined;
  let runnerKey: ReturnType<typeof newKey>;
  let cloudDeps: RunnerCloudDeps;
  let nextNumber = 9500;

  const FILES = { "src/footer.ts": "export const year = (): number => new Date().getFullYear();", "src/footer.test.ts": "import { year } from './footer'; if (year() < 2026) throw new Error('year');" };
  const PM_FILES = Object.keys(FILES);
  const PM_OUTPUT = { feasible: true, reason: "", summary: "Show the year in the footer.", spec: "1. The footer shows the year.\n2. A test pins it.", acceptance_files: PM_FILES };

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);

    agent = createFakeAgent();
    bare = createBareGithub();
    github = await startGithubServer(() => fake);
    const visibility = { visibility: async () => "private" as const };
    const claims = createRunnerClaimFacade(writerPool, { visibility, randomBetween: (min) => min });
    const done = createRunnerDoneFacade(writerPool);
    const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });
    const pullRequests = createHarnessPullRequestPort({ github, appLogin: FAKE_APP_LOGIN });
    cloud = await startCloudServer((origin) => (cloudDeps = { appUserPool: appPool, origin, failRunnerLeases: null, leases: { ...claims, ...done, ...gitTickets }, pullRequests }));
  });
  afterAll(async () => {
    await cloud?.close();
    await github?.close();
    admin?.release();
    for (const p of [adminPool, writerPool, appPool]) await p?.end();
  });
  beforeEach(async () => {
    // A new GitHub for each scenario: the same bare repository, but no pull requests and no calls yet.
    fake = new FakeGithub();
    repo = fake.addRepo("acme", "widgets");
    // The pull-request token the product uses on this path may open and close pull requests but is refused markPullRequestReadyForReview (C37, #133): a build's pull
    // request stays a draft. A scenario that wants a token with that right says so.
    fake.markReadyForbidden = true;
    backFakeWithBare(fake, bare, repo);
    github.seen.length = 0;
    cloud.replies.length = 0;
    // A queue of its own: other files leave runner runs behind, and the claim takes the oldest pending run of the account only.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
  });
  afterEach(() => {
    rig?.close();
    rig = undefined;
    // A GitHub that was asked for something the strict fake refuses is a cloud that sent a call it must never send.
    expect(github.violations).toEqual([]);
  });

  const visibility = { visibility: async () => "private" as const };
  /** The review driver's GitHub client for the scenario's repository (the local-only fence over the strict fake). */
  const readHttp = (repoId: string) => createHarnessReadHttp({ github, repo: { id: repoId, owner: "acme", name: "widgets" } })();

  /** The cloud's advance module, built as the production composition root does (its `lightSpec` is the pipeline's `publishLightSpec`). */
  function advance(accountId: string, workItemId: string) {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "e2e-key", privateKey: jobKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => null } });
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }),
    };
    const starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    const module = createAdvanceModule(writerPool, { starter, resolveRunSeat: createSeatResolver({ pool: writerPool }), startAdvance: async () => undefined, triage: null, registry, lightSpec: publishLightSpec, review: createHarnessReviewDeps() });
    const ports: AdvanceRunPorts = {
      startRun: (req) => module.advanceStartRun({ ...req, accountId, workItemId, haltEpoch: 0 }),
      outcome: (runId) => module.advanceRunOutcome(accountId, runId),
      cancel: async () => undefined,
    };
    return { module, ports, registry };
  }

  /** A fixture account with a `runner_local` repository whose "GitHub" is the local bare repository, and a runner registered under the harness's key. */
  async function account(): Promise<SeedRefs> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 4242 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    runnerKey = newKey();
    const runnerId = await insertRunner(admin, a.accountId, a.userId, { jwk: runnerKey.jwk, jkt: runnerKey.jkt, credentialMode: "subscription" });
    rig = createRunnerRig({
      cloudOrigin: cloud.origin,
      key: { privateKey: runnerKey.privateKey, publicJwk: runnerKey.jwk, jkt: jwkThumbprint(runnerKey.jwk) },
      keyring,
      binary: agent.binary,
      remoteUrl: () => bare.url,
    });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerId, [a.repoId]]);
    return a;
  }

  /**
   * The short-Spec path, as far as the Spec is stored: a triaged bug, the PM's run on the runner with the real short-Spec prompt, and the real `advanceLightSpec`.
   * `pm` is what the fake PM model answers as its AGENT_OUTPUT.
   */
  async function specWritten(pm: unknown = PM_OUTPUT) {
    const a = await account();
    const triage = await runTriageStep(
      { pool: writerPool, accountId: a.accountId, classifier: fixtureClassifier("bug") },
      { mode: "new", event: { ...OWNER, body: "The footer shows the wrong year." }, title: "Show the year in the footer", sourceEventId: randomUUID(), repoId: a.repoId },
    );
    if (triage.status !== "triaged") throw new Error(`triage: ${JSON.stringify(triage)}`);
    const workItemId = triage.workItemId;
    await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [workItemId, nextNumber++, a.repoId]);
    const { module, ports } = advance(a.accountId, workItemId);
    const who = { accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 };

    agent.pmPhase(pm);
    const actionId = randomUUID();
    const started = await module.advanceStartRun({
      accountId: a.accountId,
      workItemId,
      haltEpoch: 0,
      step: `light-spec:${actionId}`,
      role: "project-manager",
      prompt: buildLightSpecPrompt({ category: "bug", title: "Show the year in the footer", body: "The footer shows the wrong year." }),
      clone: true,
    });
    if (!started.ok) throw new Error(`PM run not started: ${started.reason}`);
    await approve(a, started.runId);
    const pmRun = await rig!.runNext();
    const outcome = await module.advanceRunOutcome(a.accountId, started.runId);
    const published = await module.advanceLightSpec(who, started.runId, actionId);
    return { a, workItemId, module, ports, who, pmRun, pmRunId: started.runId, outcome, published };
  }

  /** A subscription runner takes only runs its registrant started or approved: the registrant approves, through the cloud's own approval route. */
  async function approve(a: SeedRefs, runId: string): Promise<void> {
    const out = await approveRun(cloudDeps, { accountId: a.accountId, userId: a.userId }, runId);
    expect(out).toMatchObject({ status: 200 });
  }

  const agentRunRow = async (runId: string) => (await admin.query("SELECT status, spec_version_id, runtime FROM agent_runs WHERE id = $1", [runId])).rows[0] as Record<string, unknown>;
  /** The cloud's verdict as the done route recorded it on the run. */
  const verdictOf = async (runId: string) =>
    (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'viaRunnerDone' = 'true'", [runId])).rows[0]?.payload as Record<string, unknown> | undefined;
  const stageOf = async (workItemId: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0]!.stage;

  it("E1: the product's own Spec writer, build start, job issuer, the runner's job path and the done route end in an opened pull request with exactly the two files", async () => {
    const spec = await specWritten();
    // The PM ran as a real runner job and its AGENT_OUTPUT is what the product stored.
    expect(spec.pmRun).toMatchObject({ status: "completed", outcome: "succeeded" });
    expect(spec.outcome).toMatchObject({ status: "succeeded", done: true, envelope: PM_OUTPUT });
    expect(spec.published).toEqual({ status: "published", reason: null, version: 1 });
    const stored = (await admin.query<{ id: string; frontmatter: unknown; body: string }>("SELECT id, frontmatter, body FROM spec_versions WHERE work_item_id = $1", [spec.workItemId])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.frontmatter).toEqual({ acceptance_files: PM_FILES });
    expect(stored[0]!.body).toContain("### Files this Spec allows");
    expect(await stageOf(spec.workItemId)).toBe("spec_ready");

    // The real build start: the run pins the Spec version, a job is issued and signed by the real signer, and the item moves to in_progress.
    agent.executorPhase(FILES);
    const build = await startBuildForItem(writerPool, spec.a.accountId, spec.workItemId, randomUUID(), spec.ports);
    if (build.status !== "started") throw new Error(`build not started: ${JSON.stringify(build)}`);
    expect(await agentRunRow(build.runId)).toMatchObject({ status: "pending", runtime: "runner", spec_version_id: stored[0]!.id });
    expect(await stageOf(spec.workItemId)).toBe("in_progress");

    // The runner claims it over HTTP, checks the signature against its pinned keyring, mirrors the bare repository, runs the agent in a workspace, pushes the
    // branch, and tells the cloud it is done; the cloud asks GitHub what the branch holds and opens the pull request.
    await approve(spec.a, build.runId);
    const ran = await rig!.runNext();
    expect(ran).toEqual({ status: "completed", outcome: "succeeded", failureReason: null, prNumber: 1 });
    // Every answer the runner got was a success, but the claim throttle's 429 (which the runner waits out).
    expect(cloud.replies.filter((r) => r.status >= 400 && r.status !== 429)).toEqual([]);
    expect(await agentRunRow(build.runId)).toMatchObject({ status: "succeeded", runtime: "runner" });
    expect(await verdictOf(build.runId)).toMatchObject({ to: "succeeded", prNumber: 1 });

    // The branch is on the "GitHub" the runner pushed to, with the agent's one commit and exactly the two files.
    const branch = `fx/${build.runId}-g1`;
    expect(bare.git("rev-list", "--count", `main..${branch}`).trim()).toBe("1");
    expect(bare.git("diff", "--name-only", `main...${branch}`).trim().split("\n").sort()).toEqual([...PM_FILES].sort());
    // The pull request: opened as a draft by the cloud's installation client (a User-Agent on every call, the allowlisted calls only). The cloud then asks to mark it
    // ready and the fake refuses that to this token, as GitHub does (C37), so it stays an open draft and the run still succeeded.
    expect(repo.pulls).toHaveLength(1);
    expect(repo.pulls[0]).toMatchObject({ head: branch, base: "main", state: "open", draft: true, author: { login: FAKE_APP_LOGIN, type: "Bot" } });
    const opened = github.seen.find((r) => r.method === "POST" && r.path === "/repos/acme/widgets/pulls");
    expect(JSON.parse(opened!.body)).toMatchObject({ head: branch, base: "main", draft: true });
    expect(github.seen.some((r) => r.method === "POST" && r.path === "/graphql" && r.body.includes("markPullRequestReadyForReview"))).toBe(true);
    expect(github.seen.length).toBeGreaterThan(0);
    for (const call of github.seen) expect(call.headers["user-agent"], `${call.method} ${call.path}`).toBeTruthy();
    // The item reaches pr_opened the way the driver records it once it finds the pull request ("Check the build"; the GitHub webhook is not part of this harness).
    expect(await spec.module.advancePrFound(spec.who, 1)).toMatchObject({ status: "recorded", stage: "pr_opened" });
    expect(await stageOf(spec.workItemId)).toBe("pr_opened");
    expect(agent.runs()).toEqual(["pm", "executor"]);
    // Both runs went through the cloud's real routes over HTTP: a claim, a done, and a verdict for each.
    expect(cloud.paths.filter((p) => p === "/api/runner/claim").length).toBeGreaterThanOrEqual(2);
    expect(cloud.paths.filter((p) => p.endsWith("/done"))).toEqual([`/api/runner/runs/${spec.pmRunId}/done`, `/api/runner/runs/${build.runId}/done`]);
  });

  /**
   * The review job (R4d-6r, C35 section 3.5), on the pull request the build opened. `markReady` is whether the pull-request token may mark it ready: with it the pull
   * request is ready, without it (what the product's token really gets) it is a draft, and a review is dispatched on the number and the head either way.
   */
  it.each([
    ["a draft pull request (the token cannot mark it ready)", false],
    ["a ready pull request", true],
  ] as const)("E5: a code-reviewer job on %s is checked out at the pull request's head, detached, and its verdict is recorded on that head", async (_name, markReady) => {
    fake.markReadyForbidden = !markReady;
    const spec = await specWritten();
    agent.executorPhase(FILES);
    const build = await startBuildForItem(writerPool, spec.a.accountId, spec.workItemId, randomUUID(), spec.ports);
    if (build.status !== "started") throw new Error(`build not started: ${JSON.stringify(build)}`);
    await approve(spec.a, build.runId);
    expect(await rig!.runNext()).toEqual({ status: "completed", outcome: "succeeded", failureReason: null, prNumber: 1 });
    expect(repo.pulls[0]).toMatchObject({ state: "open", draft: !markReady });
    expect(await spec.module.advancePrFound(spec.who, 1)).toMatchObject({ status: "recorded", stage: "pr_opened" });

    // The real review dispatch: the pull request is found the way the driver finds it (the number and branch the build's done recorded, through the local-only fence),
    // and the head it reports is what the fake GitHub reads from the repository.
    const branch = `fx/${build.runId}-g1`;
    const found = await findRecordedPr(spec.module, spec.who, await readHttp(spec.a.repoId));
    const prHead = bare.git("rev-parse", `refs/heads/${branch}`).trim();
    const mainTip = bare.git("rev-parse", "refs/heads/main").trim();
    expect(found.pr).toEqual({ number: 1, headSha: prHead, baseRef: "main", branch });
    expect(prHead).not.toBe(mainTip);

    agent.reviewPhase(prHead);
    const started = await startReviewer(spec.module, spec.who, found, "code-reviewer");
    if (!started.ok) throw new Error(`review not started: ${started.reason}`);
    // The job the issuer signed carries the head, and the run row has it.
    const row = (await admin.query("SELECT head_sha, job_signed, role FROM agent_runs WHERE id = $1", [started.runId])).rows[0] as { head_sha: string; job_signed: string; role: string };
    expect(row).toMatchObject({ head_sha: prHead, role: "code-reviewer" });
    const job = verifyJob(row.job_signed, { "e2e-key": createPublicKey(jobKey) }, { now: new Date() });
    expect(job.task.kind).toBe("review");
    expect(job.review).toEqual({ head_sha: prHead });

    // The runner prepares a detached workspace at that head (the fake reviewer fails the run unless `git rev-parse HEAD` is the head, HEAD is detached, and no branch of the
    // run exists) and the real done route records the verdict.
    const runsBefore = agent.runs().length;
    await approve(spec.a, started.runId);
    expect(await rig!.runNext()).toMatchObject({ status: "completed", outcome: "succeeded", failureReason: null });
    expect(agent.runs().slice(runsBefore)).toEqual(["reviewer"]);
    expect(await agentRunRow(started.runId)).toMatchObject({ status: "succeeded", runtime: "runner" });
    expect(await verdictOf(started.runId)).toMatchObject({ to: "succeeded" });
    expect(cloud.paths.filter((p) => p.endsWith("/done")).at(-1)).toBe(`/api/runner/runs/${started.runId}/done`);
    const stored = (await admin.query("SELECT head_sha, envelope->>'verdict' AS verdict FROM agent_runs WHERE id = $1", [started.runId])).rows[0];
    expect(stored).toEqual({ head_sha: prHead, verdict: "pass" });

    // The merge gate's reviewer half reads that row for the pull request's head, and for no other commit.
    const rows = await loadRunsOnSha(writerPool, spec.a.accountId, spec.workItemId, prHead);
    expect(reviewerReasons(["code-reviewer"], rows, "runner_local_on")).toEqual([]);
    const elsewhere = await loadRunsOnSha(writerPool, spec.a.accountId, spec.workItemId, mainTip);
    expect(reviewerReasons(["code-reviewer"], elsewhere, "runner_local_on")).not.toEqual([]);
    // The round for the head is recorded by the pipeline's own function: one required reviewer, one pass.
    expect(await spec.module.advanceRecordRound(spec.who, { headSha: prHead, prNumber: 1, requiredRoles: ["code-reviewer"], verdicts: [{ role: "code-reviewer", runId: started.runId, verdict: "pass" }] })).toMatchObject({ decision: "all_passed" });
  });

  it("E2a: an agent that also writes a third file ends scope_violation, with the pull request closed", async () => {
    const spec = await specWritten();
    expect(spec.published).toMatchObject({ status: "published" });
    agent.executorPhase({ ...FILES, "src/other.ts": "export const other = 1;" });
    const build = await startBuildForItem(writerPool, spec.a.accountId, spec.workItemId, randomUUID(), spec.ports);
    if (build.status !== "started") throw new Error(`build not started: ${JSON.stringify(build)}`);
    await approve(spec.a, build.runId);
    const ran = await rig!.runNext();
    expect(ran).toEqual({ status: "completed", outcome: "failed", failureReason: "scope_violation", prNumber: 1 });
    expect(await agentRunRow(build.runId)).toMatchObject({ status: "failed" });
    expect(await verdictOf(build.runId)).toMatchObject({ to: "failed", failureReason: "scope_violation", prNumber: 1 });
    expect(repo.pulls).toHaveLength(1);
    expect(repo.pulls[0]).toMatchObject({ state: "closed" });
    expect(bare.git("diff", "--name-only", `main...fx/${build.runId}-g1`).trim().split("\n").sort()).toEqual(["src/footer.test.ts", "src/footer.ts", "src/other.ts"]);
  });

  it("E2b: a Spec stored with {} (as before the file list existed) is refused at build start, with no run written and no job issued", async () => {
    const spec = await specWritten();
    expect(spec.published).toMatchObject({ status: "published" });
    // The pre-fix state: the product wrote this row with its file list; the column goes back to what every row written before the list existed holds.
    await admin.query("UPDATE spec_versions SET frontmatter = '{}'::jsonb WHERE work_item_id = $1", [spec.workItemId]);
    const before = Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND role = 'executor'", [spec.workItemId])).rows[0].n);
    const build = await startBuildForItem(writerPool, spec.a.accountId, spec.workItemId, randomUUID(), spec.ports);
    expect(build).toEqual({ status: "refused", reason: "spec_has_no_file_list" });
    expect(Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND role = 'executor'", [spec.workItemId])).rows[0].n)).toBe(before);
    expect(await stageOf(spec.workItemId)).toBe("spec_ready");
    expect(await rig!.runNext()).toEqual({ status: "idle" });
  });

  it("the fake GitHub is as strict as the real one where the cloud relies on it: a User-Agent on every call, a rename listed as RENAMED, a pull request on a missing branch refused", async () => {
    const env = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
    const run = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const scratch = path.join(mkdtempSync(path.join(tmpdir(), "r4d6-rename-")), "clone");
    run("clone", "-q", bare.url, scratch);
    run("-C", scratch, "mv", "README.md", "DOCS.md");
    run("-C", scratch, "commit", "-q", "-m", "rename");
    run("-C", scratch, "push", "-q", "origin", "HEAD:refs/heads/rename-demo");
    const headers = { accept: "application/vnd.github+json", "content-type": "application/json" };
    // No User-Agent at all (fetch adds one, so this goes through node:http, where nothing is added): GitHub's 403.
    const bareReply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(`${github.origin}/repos/acme/widgets`, { headers: { accept: "application/vnd.github+json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(bareReply.status).toBe(403);
    expect(bareReply.text).toContain("User-Agent");
    const pull = (head: string) => fetch(`${github.origin}/repos/acme/widgets/pulls`, { method: "POST", headers, body: JSON.stringify({ title: "t", head, base: "main", body: "b", draft: true }) });
    // A draft pull request on a branch that does not exist is a 422.
    expect((await pull("no-such-branch")).status).toBe(422);
    // A branch really pushed to the repository above: opened, and its files read from the repository, with the rename as GitHub lists it.
    const opened = await pull("rename-demo");
    expect(opened.status).toBe(201);
    const number = ((await opened.json()) as { number: number }).number;
    const files = await fetch(`${github.origin}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: GITHUB_GRAPHQL_DOCUMENTS.PullRequestFiles, variables: { owner: "acme", name: "widgets", number, cursor: null } }),
    });
    const listed = (await files.json()) as { data: { repository: { pullRequest: { files: { nodes: unknown[] } } } } };
    expect(listed.data.repository.pullRequest.files.nodes).toEqual([{ path: "DOCS.md", changeType: "RENAMED" }]);
  });

  it("E3: the harness writes none of the rows the product writes on this path", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = [path.join(here, "runnerEndToEnd.pg.test.ts"), ...readdirSync(path.join(here, "harness")).map((f) => path.join(here, "harness", f))];
    // Built from pieces so that this file does not contain what it forbids.
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_WRITES) expect(pattern.test(text), `${path.basename(file)} must not contain ${pattern}`).toBe(false);
    }
  });

  it("E6: the scan also refuses a hand-written review.head_sha, and it bites on every way of writing one", () => {
    // Each of these is a harness writing the reviewed commit itself: into the job, onto the run row, or as a literal head handed to the dispatch. Built from pieces so that this
    // file does not contain them.
    const sha = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
    const handWritten = [
      ["const job = { role: 'code-reviewer', review: { head_", `sha: '${sha}' } };`],
      ["job.review", `.head_sha = '${sha}';`],
      ["UPDATE agent_runs SET head_", `sha = '${sha}' WHERE id = $1`],
      ["await startReviewer(module, who, found, 'code-reviewer', { head", `Sha: '${sha}' });`],
      ["head_", `sha: "${sha}"`],
    ].map((parts) => parts.join(""));
    for (const text of handWritten) expect(FORBIDDEN_WRITES.some((pattern) => pattern.test(text)), text).toBe(true);
    // What the test does instead is read the head from the pull request and compare: those lines pass the scan.
    for (const text of ["expect(job.review).toEqual({ head_sha: prHead });", "headSha: pr.headSha,", "SELECT head_sha, job_signed, role FROM agent_runs WHERE id = $1", "step: `review:${pr.headSha}:${role}`"]) {
      expect(FORBIDDEN_WRITES.some((pattern) => pattern.test(text)), text).toBe(false);
    }
  });
});
