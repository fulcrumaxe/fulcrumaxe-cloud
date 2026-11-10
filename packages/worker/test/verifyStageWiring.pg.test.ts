import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_METHOD_JOB_MIN_PROTOCOL, DEPLOY_VERIFIER_ROLE } from "@fulcrumaxe/runner-protocol";
import { createTestConnectionStatusPort, type ExecutionRun } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import type { CommitFacts, CommitRelation } from "@fx/core/src/verify/qualify.js";
import { createFakeModelConnectionPort } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { buildVerifyPrompt } from "../../pipeline/src/verify/prompt.js";
import { outcomeFromAnswer } from "../../pipeline/src/verify/rules.js";
import { buildWorker, type BuildWorkerOptions, type Worker } from "../src/compositionRoot.js";
import type { HealthRead, VerifyHostPort, VerifyTarget } from "../src/verifyStage.js";

/**
 * [pg] D#749 V3c: the post-merge verify stage wired the way production wires it, end to end. `buildWorker` gets the stage's injected pieces exactly as apps/web hands them (host, health, and
 * the tester hand-offs' prompt builder, answer rules and limits) and everything else is the composition root's own: the real seat resolver (purpose deploy_verify, the deploy verifier's platform
 * card), the real runner-accepting starter over the real runner target and admission, and the repository's browser driver read from its stored verify setting. Time and the network are
 * the only fakes: the host answers from a map, the app's /api/health from a variable, and the job issuer stands in for the signer (it writes the `browser_method` the run was asked for
 * into the signed job, which is what the real issuer does: packages/runner/test/jobIssuerBrowserMethod.pg.test.ts). What it cannot fake: a real runner's claim and a real browser.
 */
const BASE_URL = "https://app.example";
const MERGE = "c".repeat(40);
const RUN_USD = 1.25;

class FakeHost implements VerifyHostPort {
  async mergeCommit(_t: VerifyTarget, _pr: number): Promise<string | null> {
    return MERGE;
  }
  async commit(): Promise<CommitFacts | null> {
    return null;
  }
  async relation(): Promise<CommitRelation> {
    return "unknown";
  }
}

describe("the verify stage as production wires it [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let a: SeedRefs;
  let worker: Worker;
  const health: HealthRead = { kind: "ok", commit: MERGE };
  const signed: Array<{ runId: string; role: string; method: string | undefined }> = [];
  let withRun = true;
  let figures: () => { runUsd: number; perRepoDailyUsd: number } = () => ({ runUsd: RUN_USD, perRepoDailyUsd: 10 });

  async function build(): Promise<Worker> {
    const options: BuildWorkerOptions = {
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => "tok" },
      ports: {
        decryptTenantKey: async () => "fake-key",
        modelConnection: createFakeModelConnectionPort(),
        connectionStatus: createTestConnectionStatusPort(),
        hooks: { resume: async () => undefined },
        follow: async () => undefined,
        repoVisibility: { visibility: async () => "private" },
        runnerLimits: { runsPerDay: () => null },
        jobIssuer: {
          issue: async ({ run }: { run: ExecutionRun }) => {
            signed.push({ runId: run.id, role: run.role, method: run.browserMethod });
            // The real issuer records the protocol floor with the job (1007's guard refuses a browser method without 16 or more).
            await admin.query("BEGIN");
            try {
              await admin.query("SELECT set_config('fx.job_min_protocol', $1, true)", [String(BROWSER_METHOD_JOB_MIN_PROTOCOL)]);
              await admin.query("UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1", [run.id, JSON.stringify({ job: { role: run.role, browser_method: run.browserMethod } })]);
              await admin.query("COMMIT");
            } catch (err) {
              await admin.query("ROLLBACK");
              throw err;
            }
          },
        },
      },
      verifyStage: {
        host: new FakeHost(),
        health: async () => health,
        ...(withRun ? { run: { prompt: buildVerifyPrompt, outcome: outcomeFromAnswer, limits: () => figures() } } : {}),
      },
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: adminPool, receiptPool: adminPool, close: async () => undefined }),
    };
    return buildWorker(options);
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  // Verification is switched off for the world a test made, so the shared database's other suites never list its rows (and this suite no longer lists theirs).
  afterEach(async () => {
    await admin.query("UPDATE verify_settings SET enabled = false WHERE account_id = $1", [a.accountId]);
  });
  afterAll(async () => {
    await worker?.close();
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  /** A runner-mode repository with verification on, a product-merged item with a one-criterion Spec, and the account budget a seat needs. */
  async function world(driver?: string): Promise<{ repo: string; item: string }> {
    a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = 777 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [a.repoId]);
    await admin.query(`INSERT INTO verify_settings (repo_id, account_id, enabled, base_url, eligibility${driver === undefined ? "" : ", browser_driver"}) VALUES ($1, $2, true, $3, 'all'${driver === undefined ? "" : ", $4"})`, driver === undefined ? [a.repoId, a.accountId, BASE_URL] : [a.repoId, a.accountId, BASE_URL, driver]);
    await admin.query("ALTER TABLE verify_settings DISABLE TRIGGER verify_settings_stamp_enabled_since");
    try {
      await admin.query("UPDATE verify_settings SET enabled_since = now() - interval '1 hour' WHERE repo_id = $1", [a.repoId]);
    } finally {
      await admin.query("ALTER TABLE verify_settings ENABLE TRIGGER verify_settings_stamp_enabled_since");
    }
    const item = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [item, a.accountId, a.repoId]);
    await admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'review_passed', 'merged', now(), 'webhook', $3)`, [a.accountId, item, `d-${item}`]);
    await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merged_by_gate', 'merged', $3, 7, 'k')`, [a.accountId, item, "1".repeat(40)]);
    await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, '1. Open the page', encode(sha256(convert_to('1. Open the page', 'UTF8')), 'hex'), 'agent')`, [a.accountId, item]);
    return { repo: a.repoId, item };
  }
  const rowOf = async (repo: string) => (await admin.query(`SELECT id, status, method, run_id, reason_code, deployed_commit FROM verify_rows WHERE repo_id = $1`, [repo])).rows[0];
  async function toDeployed(repo: string): Promise<void> {
    // Pass 1 takes the merge into a row and places its deploy order; the order then succeeds (a runner ran the command: not this test's subject).
    await worker.sweepVerifyStage();
    await orderSucceeds(repo);
  }
  async function orderSucceeds(repo: string): Promise<void> {
    const order = (await admin.query(`SELECT id FROM verify_deploy_orders WHERE repo_id = $1`, [repo])).rows[0];
    await admin.query("ALTER TABLE verify_deploy_orders DISABLE TRIGGER verify_deploy_orders_guard");
    try {
      await admin.query(`UPDATE verify_deploy_orders SET state = 'succeeded', exit_code = 0, finished_at = now() WHERE id = $1`, [order.id]);
    } finally {
      await admin.query("ALTER TABLE verify_deploy_orders ENABLE TRIGGER verify_deploy_orders_guard");
    }
  }

  it("with everything configured the pass is not 'not_configured' and a qualified row gets its tester job: the deploy verifier role, the checkout pinned to the merge commit, the method from the signed job", async () => {
    worker = await build();
    const { repo } = await world();
    const first = await worker.sweepVerifyStage();
    expect(first.idle).toBeUndefined();
    // (The shared database may hold other suites' repositories: the counts are at least this one's, and the rest is read from its rows.)
    expect(first.opened).toBeGreaterThanOrEqual(1);
    expect(first.ordered).toBeGreaterThanOrEqual(1);
    await orderSucceeds(repo);
    const second = await worker.sweepVerifyStage();
    expect(second.ready).toBeGreaterThanOrEqual(1);
    expect(second.started).toBeGreaterThanOrEqual(1);
    const row = await rowOf(repo);
    expect(row).toMatchObject({ status: "running", method: "playwright_runner", deployed_commit: MERGE });
    const run = (await admin.query("SELECT role, head_sha, status, job_signed #>> '{job,browser_method}' AS signed FROM agent_runs WHERE id = $1", [row.run_id])).rows[0];
    expect(run).toMatchObject({ role: DEPLOY_VERIFIER_ROLE, head_sha: MERGE, signed: "playwright_runner" });
    expect(signed.at(-1)).toMatchObject({ runId: row.run_id, role: DEPLOY_VERIFIER_ROLE, method: "playwright_runner" });
    // The tester's prompt came from pipeline's builder, from the journeys the row held, and the seat's cap is the figure.
    const key = (await admin.query("SELECT 1 FROM agent_run_idempotency_keys WHERE idempotency_key = $1", [`verify-stage:${row.id}`])).rowCount;
    expect(key).toBe(1);
    // A pass again starts nothing: the row is the tester's now.
    expect((await worker.sweepVerifyStage()).started).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND role = $2", [a.accountId, DEPLOY_VERIFIER_ROLE])).rows[0].n).toBe(1);
  });

  it("the repository's stored browser driver reaches the job: chrome signs chrome_runner into the job and the row copies it from there", async () => {
    worker = await build();
    const { repo } = await world("chrome");
    await toDeployed(repo);
    expect((await worker.sweepVerifyStage()).started).toBeGreaterThanOrEqual(1);
    expect(signed.at(-1)!.method).toBe("chrome_runner");
    expect(await rowOf(repo)).toMatchObject({ status: "running", method: "chrome_runner" });
  });

  it("without the tester pieces a qualified row stays deploying and nothing starts (the state before this wiring)", async () => {
    withRun = false;
    try {
      worker = await build();
      const { repo } = await world();
      await toDeployed(repo);
      const second = await worker.sweepVerifyStage();
      expect(second.ready).toBeGreaterThanOrEqual(1);
      expect(second.started).toBe(0);
      expect(await rowOf(repo)).toMatchObject({ status: "deploying", method: null });
    } finally {
      withRun = true;
    }
  });

  it("figures that cannot be read hold the row deploying (fail closed) and a later pass with figures starts the job", async () => {
    worker = await build();
    const { repo } = await world();
    await toDeployed(repo);
    figures = () => {
      throw new Error("plan data unavailable");
    };
    try {
      const held = await worker.sweepVerifyStage();
      expect(held.held).toBeGreaterThanOrEqual(1);
      expect(held.started).toBe(0);
      expect(await rowOf(repo)).toMatchObject({ status: "deploying" });
    } finally {
      figures = () => ({ runUsd: RUN_USD, perRepoDailyUsd: 10 });
    }
    expect((await worker.sweepVerifyStage()).started).toBeGreaterThanOrEqual(1);
    expect(await rowOf(repo)).toMatchObject({ status: "running", method: "playwright_runner" });
  });
});
