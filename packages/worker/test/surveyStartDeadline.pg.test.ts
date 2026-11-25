import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURVEY_CAPABILITY, SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { RunnerHttpError, startSurvey, type RunnerCloudDeps, type RunPullRequestPort } from "@fx/runner-cloud";
import { createFakeRunnerLimits, createFakeVisibility } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createSeatResolver } from "../src/seat.js";
import { createSurveyStart } from "../src/surveyStart.js";

const HEAD = "d".repeat(40);

/**
 * [pg] D#845 ON-10b2 (Ruling 88 item 7, "Started after commit"): the cloud's `startSurvey` over the worker's real start and real deadline look. A Workflow that cannot be started leaves a cancelled run, an ended setup and a 503, never
 * a survey without a deadline; one that starts leaves a pending run and a live setup.
 */
describe("the survey start with its deadline [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const { privateKey } = generateKeyPairSync("ed25519");

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

  async function world(): Promise<SeedRefs & { setupId: string }> {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [refs.repoId]);
    const runnerId = await insertRunner(admin, refs.accountId, refs.userId, { credentialMode: "subscription" });
    await admin.query("UPDATE runners SET model_auth_present = true, allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerId, [refs.repoId]]);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [runnerId, refs.accountId, [SURVEY_CAPABILITY]]);
    await admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'os_sandbox')", [runnerId, refs.accountId]);
    await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [refs.repoId, refs.accountId, runnerId]);
    const setupId = randomUUID();
    await admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', 'survey', $4)", [setupId, refs.accountId, refs.repoId, refs.userId]);
    return { ...refs, setupId };
  }

  /** `issuerSees` is what the job issuer reads for the repo at issue time (the person's own read said private): `unknown` makes the issuer refuse AFTER the bind (D#845 ON-10e1: `public` no longer does, the survey may name a public repo). */
  function deps(starts: string[], fail: boolean, issuerSees: "private" | "unknown" = "private"): RunnerCloudDeps {
    const visibility = createFakeVisibility("private");
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "job-key-1", privateKey }), visibility: createFakeVisibility(issuerSees), context: createPgJobContext(writerPool) });
    const sandbox = new SandboxTarget(createSandboxTargetHarness(writerPool).deps);
    const registry: ExecutionTargetRegistry = { sandbox, runner_local: new RunnerTarget({ pool: writerPool, issuer, visibility, limits: createFakeRunnerLimits() }, "runner_local") };
    const worker = createSurveyStart({ pool: writerPool, registry, resolveRunSeat: createSeatResolver({ pool: writerPool }) });
    const github = { defaultBranch: async () => "main", branchState: async () => ({ exists: true, headOid: HEAD, aheadBy: 0, defaultBranch: "main" }) } as unknown as RunPullRequestPort;
    return {
      appUserPool: appPool,
      origin: "https://app.example.test",
      failRunnerLeases: null,
      pullRequests: github,
      repoVisibility: async () => "private",
      surveyRuns: async () => worker,
      surveyDeadline: {
        start: async (args: { runId: string }) => {
          starts.push(args.runId);
          if (fail) throw new Error("workflow start refused");
        },
      },
    } as unknown as RunnerCloudDeps;
  }
  const runsOf = async (w: SeedRefs) => (await admin.query("SELECT id, status FROM agent_runs WHERE account_id = $1 AND role = $2", [w.accountId, SURVEY_ROLE])).rows;
  const setupOf = async (id: string) => (await admin.query("SELECT state, survey_run_id, failure_code, failure_reason FROM project_setups WHERE id = $1", [id])).rows[0];

  it("starts the deadline Workflow for the run it made, and leaves a pending run on a live setup", async () => {
    const w = await world();
    const starts: string[] = [];
    const out = await startSurvey(deps(starts, false), { accountId: w.accountId, userId: w.userId }, w.setupId);
    expect(starts).toEqual([out.run_id]);
    expect(await runsOf(w)).toEqual([{ id: out.run_id, status: "pending" }]);
    expect(await setupOf(w.setupId)).toMatchObject({ state: "started", survey_run_id: out.run_id });
  });

  it("an issuer refusal AFTER the bind (setup started, run pending then failed) ends the setup survey_failed / refused_at_admit, with no deadline Workflow started", async () => {
    const w = await world();
    const starts: string[] = [];
    const error = await startSurvey(deps(starts, false, "unknown"), { accountId: w.accountId, userId: w.userId }, w.setupId).then(
      () => null,
      (e: unknown) => e as RunnerHttpError,
    );
    expect(error).toBeInstanceOf(RunnerHttpError);
    expect([error!.status, error!.code]).toEqual([409, "survey_not_started"]);
    expect(starts).toEqual([]);
    const runs = await runsOf(w);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(await setupOf(w.setupId)).toMatchObject({ state: "failed", survey_run_id: runs[0].id, failure_code: "survey_failed", failure_reason: "refused_at_admit" });
  });

  it("a Workflow start that throws gives 503 survey_unavailable, a cancelled run and a setup ended survey_failed / cancelled", async () => {
    const w = await world();
    const starts: string[] = [];
    const error = await startSurvey(deps(starts, true), { accountId: w.accountId, userId: w.userId }, w.setupId).then(
      () => null,
      (e: unknown) => e as RunnerHttpError,
    );
    expect(error).toBeInstanceOf(RunnerHttpError);
    expect([error!.status, error!.code]).toEqual([503, "survey_unavailable"]);
    expect(error!.message).not.toContain("refused");
    const runs = await runsOf(w);
    expect(runs).toEqual([{ id: starts[0], status: "cancelled" }]);
    expect(await setupOf(w.setupId)).toMatchObject({ state: "failed", survey_run_id: starts[0], failure_code: "survey_failed", failure_reason: "cancelled" });
  });
});
