import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus, type SdkCreateParams, type SdkSandbox, type VercelSandboxSdk } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { buildWorker } from "../src/compositionRoot.js";
import { productionVercelCredentials } from "../src/vercelCredentials.js";

/**
 * [pg] A cancel, end to end: the real run-action facade and the real sandbox target over a real
 * database, with the production credentials builder, a fake Vercel SDK, and a hooks port that
 * rejects on every call (the go-live wiring's stance until the hook body exists).
 */
const TEAM = "team_fixture";
const PROJECT = "prj_fixture";
const HOOKS_ERROR = "worker: hooks not wired (H14c-3-3)";

function jwt(marker: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc({ owner_id: TEAM, project_id: PROJECT, exp: Date.now() / 1000 + 3600, marker })}.c2ln`;
}

describe("cancel with production credentials and a fail-closed hooks port [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let opsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, opsPool]) await p.end();
  });

  it("the cancel stops the sandbox through the SDK with the env ids and the invocation's header token; a hooks call settles with the fixed error", async () => {
    const acct = await seedAccount(admin, randomUUID());
    const { id: runId } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: acct.accountId, workItemId: acct.workItemId, role: "code-reviewer", runtime: "production", executionMode: "sandbox" });
    await writeRunStatus(writerPool, { accountId: acct.accountId, runId, from: "pending", to: "running" });
    await admin.query(
      "INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, 'open', 'foreground_compute', 'run')",
      [acct.accountId, runId],
    );

    const stops: { teamId: string; projectId: string; token: string; name: string }[] = [];
    const sdk: VercelSandboxSdk = {
      async create(_params: SdkCreateParams): Promise<SdkSandbox> {
        throw new Error("a cancel must not create a sandbox");
      },
      async get(params) {
        stops.push({ teamId: params.teamId, projectId: params.projectId, token: params.token, name: params.name });
        return { name: params.name, stop: async () => undefined } as unknown as SdkSandbox;
      },
    };
    const token = jwt("this-invocation");
    const worker = await buildWorker({
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      sdk,
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: opsPool, close: async () => {} }),
      vercel: productionVercelCredentials(
        { VERCEL_TEAM_ID: TEAM, VERCEL_PROJECT_ID: PROJECT },
        { getContext: () => ({ headers: { "x-vercel-oidc-token": token } }) },
      ),
      ports: {
        decryptTenantKey: async () => "k",
        modelConnection: { get: async () => { throw new Error("unused"); } },
        connectionStatus: { markBroken: async () => {} },
        hooks: { resume: async () => { throw new Error(HOOKS_ERROR); } },
      },
    });

    const result = await worker.cancelRun({ accountId: acct.accountId, userId: acct.userId }, runId);

    expect(result).toMatchObject({ status: "cancelled", settled_usd: 0, released_usd: 0 }); // CS-2a: never released (no sandbox requested: $0, no_sandbox)
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status).toBe("cancelled");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ teamId: TEAM, projectId: PROJECT, token });
    await expect(worker.targetDeps.hooks.resume("hook", {} as never)).rejects.toThrow(HOOKS_ERROR);
  });
});
