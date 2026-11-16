import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CURRENT_PROTOCOL_VERSION, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, ORDERED_FACTS_CAPABILITY, TIP_PUBLISH_CAPABILITY, type DoneCheck } from "@fulcrumaxe/runner-protocol";
import { PREVIEW_WORKDIR, RunnerTarget, SandboxTarget, acceptQueuedRunnerRun, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { markBuildNeedsHuman, resumeAgentRun } from "@fx/pipeline";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { CLAIM_PATH, claimRun, createRunPullRequestPort, donePath, doneRun, planePushReportRun, planePushTokenRun, toResponse, type PlanePushHostedPort, type RunnerCloudDeps } from "@fx/runner-cloud";
import { startBuildForItem } from "../../../pipeline/src/advance/buildTesting.js";
import { publishLightSpec } from "../../../pipeline/src/advance/lightSpec.js";
import type { AdvanceRunPorts } from "../../../pipeline/src/advance/runPorts.js";
import { runTriageStep } from "../../../pipeline/src/plan/step.js";
import { OWNER, fixtureClassifier } from "../../../pipeline/test/plan/helpers/panelFixtures.js";
import { createSandboxTargetHarness } from "../../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../../runner/test/helpers/runnerTargetFakes.js";
import { FAKE_APP_LOGIN, FakeGithub, type FakeRepo } from "../../../runner-cloud/test/helpers/githubFake.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../../runner-cloud/test/helpers.js";
import { createAdvanceModule } from "../../src/advance.js";
import { createRunnerClaimFacade } from "../../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../../src/runnerDone.js";
import { createRunnerGitTicketFacade } from "../../src/runnerGitTicket.js";
import { createRunnerPlanePushFacade } from "../../src/runnerPlanePush.js";
import { createSeatResolver } from "../../src/seat.js";
import { createRunStarter } from "../../src/starter.js";
import type { CheckFixDeps } from "../../src/checkFix.js";

/**
 * D#483 PIPELINE-SCENARIO-HARNESS: the shared world of the scenario tests in this directory. Everything on the path is the product's own: the triage and the
 * short-Spec writer, the build start, the production run starter and fix-round resume over `RunnerTarget` and the real job issuer, the claim and done routes, and
 * the cloud's GitHub client over the strict GitHub fake of runner-cloud's tests. What a scenario writes by hand is the fixture account, repository and runner (as
 * every pg test here does), and the runner's own words (the check report it sends on done, the branch it pushed).
 *
 * Fictional paths only: the files a scenario names exist in no package.
 */
export interface World {
  admin: PoolClient;
  writerPool: Pool;
  appPool: Pool;
  close(): Promise<void>;
  account(): Promise<SeedRefs>;
  /** A triaged bug with a published short Spec naming `files`. Returns the work item. */
  itemWithSpec(a: SeedRefs, files: string[]): Promise<string>;
  /** Registers a runner (at the current protocol unless told) with its own key. */
  runner(a: SeedRefs, protocolVersion?: number): Promise<Runner>;
  ports(accountId: string, workItemId: string): AdvanceRunPorts;
  registry(): ExecutionTargetRegistry;
  checkFixDeps(accountId: string): CheckFixDeps;
  /** Pairs the account's repository with the public one (`PUBLIC_REPO`), with the overlay paths private. */
  pairRepo(a: SeedRefs): Promise<void>;
  /** The build-start stamp of an item's public-push record, through the product's own module, as the build step writes it. */
  stampPush(a: SeedRefs, workItemId: string): Promise<void>;
  /**
   * The runner's hello listed `tip_publish_v1` (it may ask to publish the branch tip) and `ordered_facts_v1` (the merge check can hold order on its repository, so the repository's one-build
   * limit lifts and a second item of the paired repository can build while the first is still open).
   */
  allowTipPublish(a: SeedRefs, runner: Runner): Promise<void>;
  /**
   * A fix round on a published item, started with the product's own run start (`resumeAgentRun` over the real issuer, as `startCheckFixRound` and the review fix start make it), signed with
   * `base` as its diff base on the branch the parent run left. The review driver that normally starts such a round (`startFix`) needs the review stage's ports, which this harness does not run.
   */
  startUpdateRound(a: SeedRefs, workItemId: string, parentRunId: string, base: { sha: string; branch: string }, tag: string): Promise<string>;
}

export const PUBLIC_REPO = "acme/widgets-public";

/**
 * The hosted side's view of the paired public repository, as a strict stand-in (the real one is exercised over TLS in packages/github): a token is minted only for the paired repository,
 * a pushed branch counts only if the runner's side put exactly that head and parent on it, a pull request exists only on a branch that was pushed, and every minted token is accounted
 * for (handed out or revoked). It cannot fake what GitHub's own rate limits and permissions do; those are the real adapter's tests.
 */
export class FakePublicPlane implements PlanePushHostedPort {
  mints: string[] = [];
  revoked: string[] = [];
  mainTip = "9".repeat(40);
  private readonly branches = new Map<string, { head: string; tip: string }>();
  async mintToken(codeRepo: string): Promise<{ token: string; expiresAt: Date }> {
    if (codeRepo !== PUBLIC_REPO) throw Object.assign(new Error("not the paired repository"), { code: "public_unavailable" });
    this.mints.push(codeRepo);
    return { token: ["g", "hs", String(this.mints.length).padStart(36, "w")].join("_"), expiresAt: new Date(Date.now() + 55 * 60_000) };
  }
  /** The runner's push of `branch` to the public repository: its head, on the parent `tip`. */
  push(branch: string, head: string, tip: string): void {
    this.branches.set(branch, { head, tip });
  }
  async verifyPushed(i: { codeRepo: string; branch: string; headSha: string; tipSha: string }): Promise<boolean> {
    const b = this.branches.get(i.branch);
    return i.codeRepo === PUBLIC_REPO && b?.head === i.headSha && b.tip === i.tipSha;
  }
  async branchHead(i: { codeRepo: string; branch: string }): Promise<string | null> {
    if (i.codeRepo !== PUBLIC_REPO) return null;
    return i.branch === "main" ? this.mainTip : (this.branches.get(i.branch)?.head ?? null);
  }
  async verifyPullRequest(i: { codeRepo: string; branch: string; number: number }): Promise<{ url: string } | null> {
    return i.codeRepo === PUBLIC_REPO && this.branches.has(i.branch) ? { url: `https://github.com/${PUBLIC_REPO}/pull/${i.number}` } : null;
  }
  async revokeToken(token: string): Promise<boolean> {
    this.revoked.push(token);
    return true;
  }
}

/** A claimed run: its id and lease generation. */
export interface Held {
  runId: string;
  g: number;
}

export interface Runner {
  id: string;
  key: TestKey;
  fake: FakeGithub;
  repo: FakeRepo;
  /** The runner asks for work; the run it was handed, with its lease generation. */
  claim(expectRunId: string): Promise<{ runId: string; g: number }>;
  /** The runner pushed `files` on the run's branch and reports done with `check`. */
  finish(c: { runId: string; g: number }, o: { files: string[]; check?: DoneCheck; branch?: string }): Promise<{ status: number; body: unknown }>;
  /** The public-push routes, signed with this runner's key. */
  plane: {
    publicRepo: FakePublicPlane;
    /** The runner asks for a token (`atTip`: for the branch tip, a round that added nothing). */
    token(c: Held, o?: { atTip?: boolean }): Promise<{ status: number; body: unknown }>;
    /** The runner's report of its push, echoing the pairing digest it read, as the hook does. */
    report(c: Held, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  };
}

export const HEADER_END = "--- end of check header ---";

/** A failed check the way a runner at the current protocol reports it: names of the failed files, the import graph line and the end-of-header marker. */
export function failedCheck(o: { failed: string[]; changed: string[]; linked: string[] }): DoneCheck {
  const list = (names: string[]) => names.join(", ");
  const summary = `failed test files (${o.failed.length}): ${list(o.failed)}\nchanged files (${o.changed.length}): ${list(o.changed)}\nfailed test files that import changed code (${o.linked.length}): ${list(o.linked)}\n${HEADER_END}\nFAIL ${o.failed[0]}`;
  return { exit_code: 1, duration_ms: 60_000, timed_out: false, skipped_tests: 0, summary, failed_files: o.failed } as DoneCheck;
}

export const passedCheck = (): DoneCheck => ({ exit_code: 0, duration_ms: 60_000, timed_out: false, skipped_tests: 0, summary: "ok" });

export async function createWorld(): Promise<World> {
  const adminPool = createPool(process.env.WORKER_DATABASE_URL!);
  const admin = await adminPool.connect();
  const writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  const appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  const { privateKey } = generateKeyPairSync("ed25519");
  const visibility = { visibility: async () => "private" as const };
  const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });
  let nextNumber = 9400 + Math.floor(Math.random() * 500);

  const registry = (): ExecutionTargetRegistry => {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => "a".repeat(40) } });
    return { sandbox: new SandboxTarget(harness.deps), runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }) };
  };

  const world: World = {
    admin,
    writerPool,
    appPool,
    registry,
    async close() {
      admin.release();
      for (const p of [adminPool, writerPool, appPool]) await p.end();
    },
    async account() {
      // The claim looks at the queue of its own tenant only, but other files leave running runner runs behind.
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
      const a = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
      await admin.query("UPDATE accounts SET model_budget_usd_month = 437 WHERE id = $1", [a.accountId]);
      await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
      // The repository's approved check: its jobs carry it and the runner reports it on done.
      await admin.query(
        `INSERT INTO repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by, check_argv, check_dev_shell, check_timeout_s)
         VALUES ($1, $2, 1, $6::jsonb, 900, $3, false, $4, $5, true, 5400)`,
        [a.accountId, a.repoId, "e".repeat(64), a.userId, ["bash", "scripts/check.sh"], JSON.stringify([{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "pnpm install fetches the locked packages" }])],
      );
      return a;
    },
    async itemWithSpec(a, files) {
      const t = await runTriageStep(
        { pool: writerPool, accountId: a.accountId, classifier: fixtureClassifier("bug") },
        { mode: "new", event: { ...OWNER, body: "The widget shows the wrong total." }, title: "Fix the widget total", sourceEventId: randomUUID(), repoId: a.repoId },
      );
      if (t.status !== "triaged") throw new Error(`fixture: ${JSON.stringify(t)}`);
      await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [t.workItemId, nextNumber++, a.repoId]);
      const spec = await publishLightSpec(writerPool, a.accountId, t.workItemId, { feasible: true, reason: "", split_proposed: false, summary: "Fix the total.", spec: "1. The widget total is right.\n2. A test pins it.", acceptance_files: files });
      if (spec.status !== "published") throw new Error(`fixture spec: ${JSON.stringify(spec)}`);
      return t.workItemId;
    },
    async runner(a, protocolVersion = CURRENT_PROTOCOL_VERSION) {
      const key = newKey();
      const id = await insertRunner(admin, a.accountId, a.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key", protocolVersion });
      await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [id, [a.repoId]]);
      const fake = new FakeGithub();
      const repo = fake.addRepo("acme", "widgets");
      const claims = createRunnerClaimFacade(writerPool, { visibility, randomBetween: (min) => min });
      const done = createRunnerDoneFacade(writerPool);
      const publicRepo = new FakePublicPlane();
      const planeFacade = createRunnerPlanePushFacade(writerPool, { publicHead: (i) => publicRepo.branchHead(i), pullRequestState: async () => "open" });
      const deps: RunnerCloudDeps = {
        appUserPool: appPool,
        origin: ORIGIN,
        failRunnerLeases: null,
        leases: { ...claims, ...done, ...gitTickets, ...planeFacade } as unknown as RunnerCloudDeps["leases"],
        pullRequests: createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN }),
        planePush: publicRepo,
        planePushIdentity: () => ({ name: "Fulcrumaxe Bot", email: "bot@example.com" }),
      };
      return {
        id,
        key,
        fake,
        repo,
        async claim(expectRunId) {
          // The cloud lets one runner claim once every few seconds (`runner_claim_throttle`); like the daemon's poll loop, wait out the answer it gives.
          let res = await toResponse(() => claimRun(deps, signed(key, CLAIM_PATH, {})));
          for (let waits = 0; res.status === 429 && waits < 3; waits++) {
            await new Promise((resolve) => setTimeout(resolve, ((res.body as { retry_after: number }).retry_after ?? 4) * 1000 + 150));
            res = await toResponse(() => claimRun(deps, signed(key, CLAIM_PATH, {})));
          }
          const body = res.body as { run_id?: string; lease_generation?: number };
          if (res.status !== 200 || body.run_id !== expectRunId) throw new Error(`claim: ${res.status} ${JSON.stringify(res.body)} (wanted ${expectRunId})`);
          return { runId: expectRunId, g: body.lease_generation! };
        },
        async finish(c, o) {
          fake.pushBranch(repo, o.branch ?? `fx/${c.runId}-g${c.g}`, { files: o.files.map((path) => ({ path, changeType: "MODIFIED" as const })), aheadBy: 1 });
          // The runner's agent session, which a later fix round resumes.
          const body = { run_id: c.runId, lease_generation: c.g, session_id: `sess-${c.runId.slice(0, 8)}`, ...(o.check ? { check: o.check } : {}) };
          return toResponse(() => doneRun(deps, signed(key, donePath(c.runId), body), c.runId));
        },
        plane: {
          publicRepo,
          token: (c, o = {}) => toResponse(() => planePushTokenRun(deps, signed(key, PLANE_PUSH_TOKEN_PATH, { run_id: c.runId, lease_generation: c.g, ...(o.atTip === true ? { at_tip: true } : {}) }))),
          async report(c, body) {
            const row = (await admin.query<{ digest: string }>("SELECT p.pairing_digest AS digest FROM plane_pushes p JOIN agent_runs r ON r.work_item_id = p.work_item_id AND r.account_id = p.account_id WHERE r.id = $1 ORDER BY p.created_at DESC LIMIT 1", [c.runId])).rows[0];
            return toResponse(() => planePushReportRun(deps, signed(key, PLANE_PUSH_REPORT_PATH, { run_id: c.runId, lease_generation: c.g, ...(row ? { pairing_digest: row.digest } : {}), ...body })));
          },
        },
      };
    },
    ports(accountId, workItemId) {
      const reg = registry();
      const starter = createRunStarter({ pool: writerPool, registry: reg, follow: async () => undefined, queued: "accept" });
      const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: createSeatResolver({ pool: writerPool }), startAdvance: async () => undefined, triage: null, registry: reg });
      return {
        startRun: (req) => m.advanceStartRun({ ...req, accountId, workItemId, haltEpoch: 0 }),
        outcome: (runId) => m.advanceRunOutcome(accountId, runId),
        cancel: async () => undefined,
      };
    },
    async pairRepo(a) {
      await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4) ON CONFLICT (repo_id) DO UPDATE SET code_repo = EXCLUDED.code_repo, overlay_globs = EXCLUDED.overlay_globs", [a.repoId, a.accountId, PUBLIC_REPO, ["docs/ops/"]]);
    },
    async stampPush(a, workItemId) {
      await withTenant(appPool, a.accountId, (c) => stampPlanePush(c, { accountId: a.accountId, workItemId, repoId: a.repoId }));
    },
    async allowTipPublish(a, r) {
      await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[]) ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities", [r.id, a.accountId, [TIP_PUBLISH_CAPABILITY, ORDERED_FACTS_CAPABILITY]]);
    },
    async startUpdateRound(a, workItemId, parentRunId, base, tag) {
      const reg = registry();
      const seatFor = createSeatResolver({ pool: writerPool });
      const seat = await seatFor({ accountId: a.accountId, role: "executor", workItemId });
      if (!seat.ok) throw new Error(`fixture seat: ${seat.reason}`);
      const issue = (await admin.query<{ n: number }>("SELECT gh_number AS n FROM work_items WHERE id = $1", [workItemId])).rows[0]!.n;
      const key = `advance:${workItemId}:scenario-round:${tag}`;
      const run = await resumeAgentRun(writerPool, reg, {
        ...seat.seat,
        accountId: a.accountId,
        repoId: a.repoId,
        workItemId,
        role: "executor",
        product: "team",
        pr: issue,
        parentRunId,
        prompt: "Address the review findings.",
        fixRoundKind: "review_fix" as const,
        base,
        workdir: PREVIEW_WORKDIR,
        idempotency: { key, requestHash: createHash("sha256").update(`${key}:executor`).digest("hex") },
      });
      return (await acceptQueuedRunnerRun(writerPool, a.accountId, run)).id;
    },
    checkFixDeps() {
      const reg = registry();
      return { pool: writerPool, registry: reg, resume: (pool, r, input) => resumeAgentRun(pool, r, input), resolveRunSeat: createSeatResolver({ pool: writerPool }) } as CheckFixDeps;
    },
  };
  return world;
}

/** Starts the real build and returns the run id it queued. */
export async function startBuild(w: World, a: SeedRefs, workItemId: string): Promise<string> {
  const out = await startBuildForItem(w.writerPool, a.accountId, workItemId, randomUUID(), w.ports(a.accountId, workItemId));
  if (out.status !== "started") throw new Error(`build not started: ${out.reason}`);
  return out.runId;
}

/** The signed job's scope patterns, as the issuer wrote them for a run. */
export async function jobScope(w: World, runId: string): Promise<string[] | null> {
  const r = await w.admin.query<{ scope: string[] | null }>("SELECT job_signed #> '{job,scope}' AS scope FROM agent_runs WHERE id = $1", [runId]);
  return r.rows[0]?.scope ?? null;
}

export const failureReasonOf = async (w: World, runId: string): Promise<string | null> =>
  (await w.admin.query<{ r: string | null }>("SELECT payload->>'failureReason' AS r FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'failed' ORDER BY seq DESC LIMIT 1", [runId])).rows[0]?.r ?? null;

/** What the advance driver does when it reads a failed build: the item goes to a person with the run's failure code (the step production wires as `buildFailed`). */
export const buildFailed = async (w: World, a: SeedRefs, workItemId: string, runId: string, code: string) => markBuildNeedsHuman(w.writerPool, a.accountId, workItemId, runId, code);

export const stageOf =async (w: World, a: SeedRefs, workItemId: string): Promise<string> =>
  withTenant(w.appPool, a.accountId, async (c) => (await c.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0]!.stage);
