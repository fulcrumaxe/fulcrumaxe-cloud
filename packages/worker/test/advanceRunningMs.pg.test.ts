import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RunnerTarget, SandboxTarget, createJobIssuer, createJobSigner, createPgJobContext, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createFakeRunnerLimits } from "../../runner/test/helpers/runnerTargetFakes.js";
import { createAdvanceModule } from "../src/advance.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunStarter } from "../src/starter.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#6 C29 (R3c-2) [pg]: the panel's and the PM's wait budgets are measured from the run's own record, so a step that is handed
 * back and called again does not start them over. The record is `agent_runs.started_at`, which the database stamps the first time a
 * run moves to `running` (the claim does that move); `advanceRunOutcome` reports it as `runningMs` on the database's clock.
 * The runner chain is the real one: the real job issuer and signer, and the claim through the real claim facade.
 */
describe("a runner run's running time as the workflow reads it [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const { privateKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const visibility = { visibility: async () => "private" as const };
  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused",
      product: "team",
      roleCard: "card",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
      timeoutMs: 40 * 60_000,
      maxExtensions: 3,
    } as never,
  };

  it("is null while the run is pending, is stamped by the claim (started_at), and counts up from the claim; a second read never moves the stamp", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const workItemId = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'discussing', 9901)", [workItemId, a.accountId, a.repoId]);

    const harness = createSandboxTargetHarness(writerPool, []);
    const issuer = createJobIssuer({ pool: writerPool, signer: createJobSigner({ keyId: "k1", privateKey }), visibility, context: createPgJobContext(writerPool), continuationBase: { headOid: async () => "a".repeat(40) } });
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: writerPool, issuer, visibility }),
    };
    const starter = createRunStarter({ pool: writerPool, registry, follow: async () => undefined, queued: "accept" });
    const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry });

    const started = await m.advanceStartRun({ accountId: a.accountId, workItemId, haltEpoch: 0, step: "panel:abc:r1:security-expert", role: "security-expert", prompt: "give your view" });
    if (!started.ok) throw new Error(`not started: ${started.reason}`);

    const pending = await m.advanceRunOutcome(a.accountId, started.runId);
    expect(pending).toMatchObject({ status: "pending", done: false, runtime: "runner", runningMs: null });

    const runnerId = await insertRunner(admin, a.accountId, a.userId, { credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runnerId, [a.repoId]]);
    const claims = createRunnerClaimFacade(writerPool, { visibility, randomBetween: (min) => min });
    const claimed = await claims.claimRunnerRun({ accountId: a.accountId, runnerId });
    if (claimed.kind !== "claimed") throw new Error("nothing to claim");

    // The stamp is written by the claim's own move out of pending, and nothing else writes it.
    const stamp = async () => (await admin.query<{ started_at: Date | null }>("SELECT started_at FROM agent_runs WHERE id = $1", [started.runId])).rows[0]!.started_at;
    const first = await stamp();
    expect(first).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const running = await m.advanceRunOutcome(a.accountId, started.runId);
    expect(running).toMatchObject({ status: "running", done: false, runtime: "runner" });
    // About 1.2 s after the claim, measured on the database's clock and never negative.
    expect(running.runningMs).toBeGreaterThanOrEqual(1_000);
    expect(running.runningMs).toBeLessThan(30_000);
    expect(await stamp()).toEqual(first);
  });
});
