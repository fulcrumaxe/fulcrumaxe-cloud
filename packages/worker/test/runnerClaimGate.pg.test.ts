import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHECK_JOB_MIN_PROTOCOL, CONTINUES_CROSS_SIDE_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION, EXCLUDES_JOB_MIN_PROTOCOL, MEMORY_JOB_MIN_PROTOCOL, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] D#599 PL-2b-1: the claim keeps a job in the cross-side shape away from a runner that predates it. The gate reads the job row's
 * `min_protocol_version` and the runner's stored `protocol_version`, and nothing else in the claim changes. Real Postgres, the real claim query.
 */
describe("the claim's protocol gate [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  const V = CONTINUES_CROSS_SIDE_MIN_PROTOCOL;
  let A: SeedRefs;
  let facade: RunnerClaimFacade;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
  });

  async function runnerAt(protocolVersion: number | null): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[], protocol_version = $4 WHERE id = $1", [id, [A.repoId], ["executor"], protocolVersion]);
    return id;
  }

  /** A pending executor run with a real signed job and the given gate (null: any runner). */
  async function pending(minProtocolVersion: number | null, extra: Partial<Job> = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "app", private: true },
      role: "executor",
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(T0 - 1000).toISOString(),
      expires_at: new Date(T0 + 72 * 3_600_000).toISOString(),
      key_id: "k1",
      ...extra,
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, min_protocol_version)
       VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3, $4::jsonb, $5, $6)`,
      [id, A.accountId, A.repoId, JSON.stringify(signJob(job, key)), A.userId, minProtocolVersion],
    );
    return id;
  }
  const holder = async (id: string) => (await admin.query<{ status: string; runner_id: string | null }>("SELECT status, runner_id FROM agent_runs WHERE id = $1", [id])).rows[0]!;
  const claim = (runnerId: string) => facade.claimRunnerRun({ accountId: A.accountId, runnerId });

  it("a runner one version below the job's gets the idle answer, and the job stays pending and unread", async () => {
    const old = await runnerAt(V - 1);
    const job = await pending(V);
    const answer = await claim(old);
    expect(answer.kind).toBe("idle");
    expect(await holder(job)).toEqual({ status: "pending", runner_id: null });
  });

  it("a runner at the job's version claims it", async () => {
    const current = await runnerAt(V);
    const job = await pending(V);
    const answer = await claim(current);
    expect(answer).toMatchObject({ kind: "claimed", runId: job });
    expect(await holder(job)).toEqual({ status: "running", runner_id: current });
  });

  it("a runner above the job's version claims it too", async () => {
    const newer = await runnerAt(V + 4);
    const job = await pending(V);
    expect(await claim(newer)).toMatchObject({ kind: "claimed", runId: job });
  });

  it("D#600 CX-5c: a job gated at the excludes floor waits for a runner that applies excludes: a memory-era runner gets the idle answer, an updated one claims it", async () => {
    const memoryEra = await runnerAt(MEMORY_JOB_MIN_PROTOCOL);
    const job = await pending(EXCLUDES_JOB_MIN_PROTOCOL);
    expect((await claim(memoryEra)).kind).toBe("idle");
    expect(await holder(job)).toEqual({ status: "pending", runner_id: null });
    const updated = await runnerAt(EXCLUDES_JOB_MIN_PROTOCOL);
    expect(await claim(updated)).toMatchObject({ kind: "claimed", runId: job });
  });

  // D#6 R-CHK-1: a job that carries the repo's approved check is refused to a runner below protocol 8 and claimed by one at it.
  it("a job with the repo's check is not given to a runner below the check floor, and is claimed at it", async () => {
    const check = { argv: ["bash", "scripts/check.sh"], dev_shell: true, timeout_s: 5400 };
    const before = await runnerAt(CHECK_JOB_MIN_PROTOCOL - 1);
    // A runner built from this tree declares the current version, which is below the floor: until the check step exists, no runner can take a job with a check.
    const shipped = await runnerAt(CURRENT_PROTOCOL_VERSION);
    const job = await pending(CHECK_JOB_MIN_PROTOCOL, { check });
    expect((await claim(before)).kind).toBe("idle");
    expect((await claim(shipped)).kind).toBe("idle");
    expect(await holder(job)).toEqual({ status: "pending", runner_id: null });
    const current = await runnerAt(CHECK_JOB_MIN_PROTOCOL);
    expect(await claim(current)).toMatchObject({ kind: "claimed", runId: job });
  });

  it("a job with no gate is claimed by an old runner and by a current one", async () => {
    const old = await runnerAt(1);
    const current = await runnerAt(V);
    const first = await pending(null);
    const second = await pending(null);
    expect(await claim(old)).toMatchObject({ kind: "claimed", runId: first });
    expect(await claim(current)).toMatchObject({ kind: "claimed", runId: second });
  });

  it("a runner that never said hello (no stored version) counts as below every gate, and is not blocked from ungated work", async () => {
    const silent = await runnerAt(null);
    const gated = await pending(V);
    expect((await claim(silent)).kind).toBe("idle");
    expect((await holder(gated)).status).toBe("pending");
    const open = await pending(null);
    expect(await claim(silent)).toMatchObject({ kind: "claimed", runId: open });
  });

  it("is derived from stored rows: the same pending job is claimed as soon as the runner's stored version reaches the gate, with nothing stamped on either row", async () => {
    const runner = await runnerAt(V - 1);
    const job = await pending(V);
    expect((await claim(runner)).kind).toBe("idle");
    await admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [runner, V]);
    expect(await claim(runner)).toMatchObject({ kind: "claimed", runId: job });
  });

  it("an old runner is offered the ungated job queued behind a gated one", async () => {
    const old = await runnerAt(V - 1);
    const gated = await pending(V);
    const open = await pending(null);
    expect(await claim(old)).toMatchObject({ kind: "claimed", runId: open });
    expect((await holder(gated)).status).toBe("pending");
  });
  describe("the claim definer enforces the gate itself (agent_run_runner_claim, migration 0805)", () => {
    /** A run already moved to running with no holder, the state the definer claims from. */
    async function running(minProtocolVersion: number | null): Promise<string> {
      const id = await pending(minProtocolVersion);
      await admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [id]);
      return id;
    }
    const callDefiner = (runId: string, runnerId: string) =>
      withTenant(writerPool, A.accountId, async (client) => (await client.query<{ g: number | null }>("SELECT agent_run_runner_claim($1::uuid, $2::uuid, $3::uuid, now(), 90) AS g", [A.accountId, runId, runnerId])).rows[0]!.g);

    it("answers NULL for a runner one version too old, and leaves the run unclaimed", async () => {
      const old = await runnerAt(V - 1);
      const id = await running(V);
      expect(await callDefiner(id, old)).toBeNull();
      expect((await admin.query("SELECT runner_id, lease_generation FROM agent_runs WHERE id = $1", [id])).rows[0]).toEqual({ runner_id: null, lease_generation: 0 });
    });

    it("answers NULL for a runner with no stored version, and a generation for a runner at the version, above it, or for an ungated run", async () => {
      expect(await callDefiner(await running(V), await runnerAt(null))).toBeNull();
      expect(await callDefiner(await running(V), await runnerAt(V))).toBe(1);
      expect(await callDefiner(await running(V), await runnerAt(V + 2))).toBe(1);
      expect(await callDefiner(await running(null), await runnerAt(1))).toBe(1);
    });
  });
});
