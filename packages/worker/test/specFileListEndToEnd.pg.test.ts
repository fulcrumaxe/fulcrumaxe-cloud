import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DoneReply } from "@fulcrumaxe/runner-protocol";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { CLAIM_PATH, claimRun, createRunPullRequestPort, donePath, doneRun, loadAcceptanceScope, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { startBuildForItem } from "../../pipeline/src/advance/build.js";
import { publishLightSpec } from "../../pipeline/src/advance/lightSpec.js";
import type { AdvanceRunPorts } from "../../pipeline/src/advance/runPorts.js";
import { runSpecStep, type SpecStepDeps } from "../../pipeline/src/plan/spec.js";
import { runTriageStep } from "../../pipeline/src/plan/step.js";
import { OWNER, FixtureRunner, FixtureWriter, discussingItem, fixtureClassifier } from "../../pipeline/test/plan/helpers/panelFixtures.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { FAKE_APP_LOGIN, FakeGithub } from "../../runner-cloud/test/helpers/githubFake.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";
import { createAdvanceModule } from "../src/advance.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../src/runnerDone.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { createSeatResolver } from "../src/seat.js";
import { createRunStarter } from "../src/starter.js";

/**
 * D#6 R4d-5a (C34 section 4, F4) [pg]: the whole path from the product's own Spec writer to the done decision, with nothing on it written by hand.
 * The Spec is written by the REAL `runSpecStep` (panel Spec) or `publishLightSpec` (short Spec) from a fake project manager's AGENT_OUTPUT; the build is
 * started by the REAL `startBuildForItem` over the worker's advance module, the production starter, `RunnerTarget` and the real job issuer; the run
 * is claimed through the real claim route; the scope is read by the REAL `loadAcceptanceScope`; and the REAL done route decides, over the real GitHub
 * port and a strict fake of GitHub. The only rows the test writes are the fixtures' accounts, repository and work item. Before this test every done-path
 * test inserted its own `spec_versions` row with a hand-written `acceptance_files`, which hid that no product code ever wrote one (and that no run was
 * ever pinned to a Spec version).
 */
describe("a Spec the product wrote is a scope the done check reads [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const { privateKey } = generateKeyPairSync("ed25519");
  const PM_FILES = ["src/a.ts", "src/{b,c}.test.ts"];
  const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });
  let nextNumber = 9100;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    // The claim looks at the queue of its own tenant only, but other files leave running runner runs behind.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
  });

  const visibility = { visibility: async () => "private" as const };
  function ports(accountId: string, workItemId: string): AdvanceRunPorts {
    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => "a".repeat(40) } });
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }),
    };
    const starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: createSeatResolver({ pool: writerPool }), startAdvance: async () => undefined, triage: null, registry });
    return {
      startRun: (req) => m.advanceStartRun({ ...req, accountId, workItemId, haltEpoch: 0 }),
      outcome: (runId) => m.advanceRunOutcome(accountId, runId),
      cancel: async () => undefined,
    };
  }

  async function account(): Promise<SeedRefs> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    return a;
  }

  /** The panel path: a discussing feature, the real panel and the real `runSpecStep` over a fake project manager. */
  async function panelSpec(output: unknown): Promise<{ a: SeedRefs; workItemId: string; spec: Awaited<ReturnType<typeof runSpecStep>> }> {
    const a = await account();
    const { workItemId } = await discussingItem(writerPool, a.accountId, { title: "Add the footer", body: "Show the year in the footer.", category: "feature", repoId: a.repoId });
    await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [workItemId, nextNumber++, a.repoId]);
    const writer = new FixtureWriter(admin, a.accountId);
    writer.output = () => output;
    const deps: SpecStepDeps = { pool: writerPool, accountId: a.accountId, runner: new FixtureRunner(admin, a.accountId), writer, trigger: async () => undefined };
    return { a, workItemId, spec: await runSpecStep(deps, { workItemId }) };
  }

  /** The short Spec path: a triaged bug and the real `publishLightSpec`. */
  async function lightSpec(output: unknown): Promise<{ a: SeedRefs; workItemId: string; spec: Awaited<ReturnType<typeof publishLightSpec>> }> {
    const a = await account();
    const t = await runTriageStep(
      { pool: writerPool, accountId: a.accountId, classifier: fixtureClassifier("bug") },
      { mode: "new", event: { ...OWNER, body: "The footer shows the wrong year." }, title: "Add the footer", sourceEventId: randomUUID(), repoId: a.repoId },
    );
    if (t.status !== "triaged") throw new Error(`fixture: ${JSON.stringify(t)}`);
    await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [t.workItemId, nextNumber++, a.repoId]);
    return { a, workItemId: t.workItemId, spec: await publishLightSpec(writerPool, a.accountId, t.workItemId, output) };
  }

  const PANEL_OUTPUT = { summary: "**technical-architect**: agrees.", spec: "1. The footer shows the year.\n2. A test pins it.", acceptance_files: PM_FILES };
  const LIGHT_OUTPUT = { feasible: true, reason: "", summary: "Fix the year.", spec: "1. The footer shows the year.\n2. A test pins it.", acceptance_files: PM_FILES };

  /** Starts the real build, claims the run through the real claim route, and returns what the done route needs. */
  async function startAndClaim(a: SeedRefs, workItemId: string) {
    const out = await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), ports(a.accountId, workItemId));
    if (out.status !== "started") throw new Error(`build not started: ${out.reason}`);
    const key: TestKey = newKey();
    const runnerId = await insertRunner(admin, a.accountId, a.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerId, [a.repoId]]);
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
    const claim = await toResponse(() => claimRun(deps, signed(key, CLAIM_PATH, {})));
    const claimed = claim.body as { run_id?: string; lease_generation?: number };
    if (claim.status !== 200 || claimed.run_id !== out.runId) throw new Error(`claim: ${claim.status} ${JSON.stringify(claim.body)}`);
    const g = claimed.lease_generation!;
    return {
      runId: out.runId,
      g,
      fake,
      repo,
      scope: () => withTenant(appPool, a.accountId, (client) => loadAcceptanceScope(client, { accountId: a.accountId, runId: out.runId })),
      finish: (files: string[]) => {
        fake.pushBranch(repo, `fx/${out.runId}-g${g}`, { files: files.map((path) => ({ path, changeType: "ADDED" as const })), aheadBy: 1 });
        return toResponse(() => doneRun(deps, signed(key, donePath(out.runId), { run_id: out.runId, lease_generation: g }), out.runId));
      },
    };
  }

  const PATHS = [
    ["the panel Spec path (runSpecStep)", async () => ({ ...(await panelSpec(PANEL_OUTPUT)), ok: true }) as const],
    ["the short Spec path (publishLightSpec)", async () => ({ ...(await lightSpec(LIGHT_OUTPUT)), ok: true }) as const],
  ] as const;

  describe.each(PATHS)("%s", (_label, write) => {
    it("publishes a Spec whose stored list the build start accepts, the run pins it, loadAcceptanceScope reads it as known, and two in-scope files open a ready pull request", async () => {
      const { a, workItemId, spec } = await write();
      expect(spec).toMatchObject({ status: "published" });
      const stored = (await admin.query<{ id: string; frontmatter: unknown }>("SELECT id, frontmatter FROM spec_versions WHERE work_item_id = $1", [workItemId])).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.frontmatter).toEqual({ acceptance_files: PM_FILES });

      const run = await startAndClaim(a, workItemId);
      expect((await admin.query("SELECT spec_version_id FROM agent_runs WHERE id = $1", [run.runId])).rows[0].spec_version_id).toBe(stored[0]!.id);
      expect(await run.scope()).toEqual({ kind: "known", entries: ["src/a.ts", "src/b.test.ts", "src/c.test.ts"] });

      const res = await run.finish(["src/a.ts", "src/b.test.ts"]);
      expect(res.status).toBe(200);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 1 });
      expect(run.repo.pulls).toHaveLength(1);
      expect(run.repo.pulls[0]).toMatchObject({ draft: false, state: "open" });
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [run.runId])).rows[0].status).toBe("succeeded");
    });

    it("the same run with a third file, src/d.ts, ends scope_violation with the pull request closed", async () => {
      const { a, workItemId } = await write();
      const run = await startAndClaim(a, workItemId);
      const res = await run.finish(["src/a.ts", "src/b.test.ts", "src/d.ts"]);
      expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "failed", failure_reason: "scope_violation", pr_number: 1 });
      expect(run.repo.pulls[0]!.state).toBe("closed");
      expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [run.runId])).rows[0].status).toBe("failed");
      const verdict = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'viaRunnerDone' = 'true'", [run.runId])).rows[0].payload;
      expect(verdict).toMatchObject({ to: "failed", failureReason: "scope_violation", prNumber: 1 });
    });
  });
});
