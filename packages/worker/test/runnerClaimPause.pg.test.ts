import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { CLAIM_PATH, claimRun, eventsPath, ingestEvents, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { createRunnerDoneFacade } from "../src/runnerDone.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";

/**
 * [pg] D#6 C43-6: a usage-limit event ingested through the real events route, the real claim facade and the real definers sets the runner's
 * `claim_paused_until`, and the real claim route then answers idle until it has passed, whatever is queued.
 */
describe("claim gating on a usage limit [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const signing = generateKeyPairSync("ed25519").privateKey;
  let A: SeedRefs;
  let deps: RunnerCloudDeps;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    const claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
    const done = createRunnerDoneFacade(writerPool, {});
    const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });
    deps = { appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: { ...claims, ...done, ...gitTickets } };
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    // The claim looks at every account's queue through its own tenant only, but other files leave running runner runs behind.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
  });

  async function newRunner(key: TestKey, credentialMode: "subscription" | "api_key"): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [id, [A.repoId]]);
    return id;
  }

  /** A pending runner run with a real signed job, ready to be claimed. */
  async function pending(role: string): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "widgets", private: true },
      role: role as Job["role"],
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 72 * 3_600_000).toISOString(),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at)
       VALUES ($1, $2, $3, $4, 'runner', 'pending', 'runner_local', $5, $6::jsonb, $7, now() - interval '5 seconds')`,
      [id, A.accountId, A.workItemId, role, A.repoId, JSON.stringify(signJob(job, signing)), A.userId],
    );
    return id;
  }
  const status = async (id: string) => {
    const run = (await admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0] as { status: string };
    const last = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.payload as { failureReason?: string } | undefined;
    return { status: run.status, failure_reason: last?.failureReason ?? null };
  };
  const pausedFor = async (runnerId: string): Promise<number | null> =>
    (await admin.query<{ s: number | null }>("SELECT EXTRACT(EPOCH FROM (claim_paused_until - now()))::float8 AS s FROM runner_capacity WHERE runner_id = $1", [runnerId])).rows[0]?.s ?? null;
  const unthrottle = (runnerId: string) => admin.query("DELETE FROM runner_claim_stamps WHERE runner_id = $1", [runnerId]);

  async function scenario(credentialMode: "subscription" | "api_key") {
    const key = newKey();
    const runnerId = await newRunner(key, credentialMode);
    const send = (path: string, body: unknown) => signed(key, path, body);
    const claim = () => toResponse(() => claimRun(deps, send(CLAIM_PATH, {})));
    const first = await pending("executor");
    const claimedFirst = (await claim()).body as { run_id?: string; lease_generation?: number };
    expect(claimedFirst.run_id).toBe(first);
    const limit = (reset?: string) => ({ seq: 0, ts: new Date().toISOString(), type: "usage_limit_reached", ...(reset === undefined ? {} : { reset_at: reset }) });
    const report = (reset?: string) =>
      toResponse(() => ingestEvents(deps, send(eventsPath(first), { run_id: first, lease_generation: claimedFirst.lease_generation, events: [limit(reset)] }), first));
    return { runnerId, first, claim, report };
  }

  it("a subscription runner: the event ends the run, sets the pause, and claims are answered idle with a retry_after no longer than the time left, until it has passed", async () => {
    const s = await scenario("subscription");
    const second = await pending("code-reviewer");
    const reset = new Date(Date.now() + 600_000).toISOString();
    expect((await s.report(reset)).status).toBe(200);
    expect(await status(s.first)).toEqual({ status: "failed", failure_reason: "usage_limit" });
    const left = await pausedFor(s.runnerId);
    expect(left).toBeGreaterThan(590);
    expect(left).toBeLessThanOrEqual(600);

    await unthrottle(s.runnerId);
    const during = await s.claim();
    expect(during.status).toBe(200);
    expect(during.body).not.toHaveProperty("run_id");
    const retryAfter = (during.body as { retry_after: number }).retry_after;
    expect(retryAfter).toBeGreaterThan(580);
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(left!));
    expect((await status(second)).status).toBe("pending");

    // The time passes: claims go ahead, with nothing else touched.
    await admin.query("UPDATE runner_capacity SET claim_paused_until = now() - interval '1 second' WHERE runner_id = $1", [s.runnerId]);
    await unthrottle(s.runnerId);
    expect((await s.claim()).body).toMatchObject({ run_id: second });
  });

  it("an api_key runner is not paused: the same event leaves no pause and its next claim takes the queued run", async () => {
    const s = await scenario("api_key");
    const second = await pending("code-reviewer");
    expect((await s.report(new Date(Date.now() + 600_000).toISOString())).status).toBe(200);
    expect(await status(s.first)).toEqual({ status: "failed", failure_reason: "usage_limit" });
    expect(await pausedFor(s.runnerId)).toBeNull();
    await unthrottle(s.runnerId);
    expect((await s.claim()).body).toMatchObject({ run_id: second });
  });

  it("a report with no reset time pauses for an hour", async () => {
    const s = await scenario("subscription");
    await s.report();
    expect(Math.abs((await pausedFor(s.runnerId))! - 3600)).toBeLessThan(30);
  });
});
