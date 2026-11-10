import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_METHOD_JOB_MIN_PROTOCOL, DEPLOY_VERIFIER_ROLE, SCOPE_JOB_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { createJobIssuer, createJobSigner, createPgJobContext, insertAgentRun, type ExecutionRun } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] D#749 V3c: the deploy verifier's browser job through the REAL issuer and the REAL claim. The issuer signs `browser_method` into the job and records the protocol floor with it; the
 * claim then never offers the job to a runner below that floor, whatever browser capability the runner advertises (its strict parse would refuse the key and fail its whole claim), and the
 * job stays pending and unread for it. What the fake leaves out: a real runner's parse of the job (fx-runner's own tests hold that).
 */
describe("the browser job's protocol gate, issuer to claim [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let facade: RunnerClaimFacade;
  let A: SeedRefs;
  const { privateKey } = generateKeyPairSync("ed25519");
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  const SHA = "c".repeat(40);

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
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
  });

  async function runnerAt(protocolVersion: number, capabilities: string[]): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key", protocolVersion });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, [A.repoId], []]);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, A.accountId, capabilities]);
    return id;
  }
  /** A deploy verifier run issued by the real issuer. */
  async function issued(browserMethod: "chrome_runner" | "playwright_runner"): Promise<string> {
    const id = randomUUID();
    await insertAgentRun(writerPool, { id, accountId: A.accountId, role: DEPLOY_VERIFIER_ROLE, runtime: "runner", executionMode: "runner_local", dispatchRepoId: A.repoId, initiatedBy: A.userId, headSha: SHA });
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "job-key-1", privateKey }), visibility: { visibility: async () => "private" }, context: createPgJobContext(writerPool), now: () => new Date(T0) });
    const run = { id, accountId: A.accountId, role: DEPLOY_VERIFIER_ROLE, product: "team", repoId: A.repoId, headSha: SHA, roleCard: "You check the deploy.\n", prompt: `Check the journeys of ${SHA}.\n`, model: "windowless-model", capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" }, browserMethod } as unknown as ExecutionRun;
    await issuer.issue({ run });
    return id;
  }
  const holder = async (id: string) => (await admin.query<{ status: string; runner_id: string | null }>("SELECT status, runner_id FROM agent_runs WHERE id = $1", [id])).rows[0]!;
  const claim = (runnerId: string) => facade.claimRunnerRun({ accountId: A.accountId, runnerId });

  it.each([
    ["chrome_runner", "browser_chrome_v1"],
    ["playwright_runner", "browser_playwright_v1"],
  ] as const)("a %s job waits for a runner of protocol %s or later, however capable the older one is, and is claimed by an updated one", async (method, capability) => {
    expect(BROWSER_METHOD_JOB_MIN_PROTOCOL).toBe(SCOPE_JOB_MIN_PROTOCOL + 1);
    const job = await issued(method);
    const old = await runnerAt(BROWSER_METHOD_JOB_MIN_PROTOCOL - 1, [capability]);
    expect((await claim(old)).kind).toBe("idle");
    expect(await holder(job)).toEqual({ status: "pending", runner_id: null });
    const updated = await runnerAt(BROWSER_METHOD_JOB_MIN_PROTOCOL, [capability]);
    expect(await claim(updated)).toMatchObject({ kind: "claimed", runId: job });
    expect(await holder(job)).toEqual({ status: "running", runner_id: updated });
  });

  it("a runner that never said its version is not offered the job either", async () => {
    const job = await issued("playwright_runner");
    const unknown = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [unknown, [A.repoId], []]);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [unknown, A.accountId, ["browser_playwright_v1"]]);
    expect((await claim(unknown)).kind).toBe("idle");
    expect(await holder(job)).toEqual({ status: "pending", runner_id: null });
  });
});
