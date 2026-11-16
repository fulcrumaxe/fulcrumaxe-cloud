import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CURRENT_PROTOCOL_VERSION, type DoneCheck } from "@fulcrumaxe/runner-protocol";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { markBuildNeedsHuman, resumeAgentRun } from "@fx/pipeline";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { CLAIM_PATH, claimRun, createRunPullRequestPort, donePath, doneRun, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
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
      await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
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
      const deps: RunnerCloudDeps = {
        appUserPool: appPool,
        origin: ORIGIN,
        failRunnerLeases: null,
        leases: { ...claims, ...done, ...gitTickets },
        pullRequests: createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN }),
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
