import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { createRunnerGitResolver, FULL_CLONES_PER_REPO_PER_DAY, type RunnerGitRequest } from "../src/runnerGitResolver.js";
import { captureReports } from "./helpers/captureReports.js";
import { ensureGhProxyTestLogin } from "./helpers/ghProxyLogin.js";
import { seedAccountWithRepo, setRepoGithubNames, type SeedRefs } from "./helpers/seed.js";

/**
 * D#6 R5a-2a: createRunnerGitResolver against the real migration 0765 function, on the real narrow gh-proxy login (a member of
 * run_binding_resolver and of nothing else). The verdict-by-verdict matrix lives in packages/db; this proves the wrapper and the
 * login fit the function end to end.
 */
describe("createRunnerGitResolver on the narrow login (0765)", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let proxyPool: Pool;
  let refs: SeedRefs;
  let runner: string;
  let run: string;
  let request: RunnerGitRequest;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    admin = await adminPool.connect();
    proxyPool = createPool(await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!));
    refs = await seedAccountWithRepo(admin, 6_363);
    await setRepoGithubNames(admin, refs.repoId, "acme-corp", "widgets");
    const user = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [user, `${user}@example.test`]);
    runner = randomUUID();
    await admin.query(
      `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')`,
      [runner, refs.accountId, user, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: randomBytes(32).toString("base64url") }), randomBytes(32).toString("base64url")],
    );
    run = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at, dispatch_repo_id)
       VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_verified', $3, 1, now() + interval '10 minutes', $4)`,
      [run, refs.accountId, runner, refs.repoId],
    );
    request = { runnerId: runner, accountId: refs.accountId, runId: run, generation: 1, repoId: refs.repoId, fullClone: false };
  });
  afterAll(async () => {
    admin.release();
    await proxyPool.end();
    await adminPool.end();
  });

  it("grants a live lease its repository, role and installation", async () => {
    expect(await createRunnerGitResolver(proxyPool)(request)).toEqual({
      verdict: "ok", role: "executor", product: "team", installationId: refs.ghInstallationId, appKind: "team", owner: "acme-corp", repo: "widgets",
    });
  });

  it("refuses a stale generation, a foreign repository and a lease that has ended", async () => {
    const resolve = createRunnerGitResolver(proxyPool);
    expect(await resolve({ ...request, generation: 2 })).toEqual({ verdict: "stale" });
    expect(await resolve({ ...request, repoId: randomUUID() })).toEqual({ verdict: "no_repo" });
    await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE id = $1`, [runner]);
    expect(await resolve(request)).toEqual({ verdict: "revoked" });
    await admin.query(`UPDATE runners SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [runner]);
  });

  it(`allows ${FULL_CLONES_PER_REPO_PER_DAY} full clones a day and then answers clone_limited`, async () => {
    const resolve = createRunnerGitResolver(proxyPool);
    for (let i = 0; i < FULL_CLONES_PER_REPO_PER_DAY; i++) expect((await resolve({ ...request, fullClone: true }))?.verdict).toBe("ok");
    expect(await resolve({ ...request, fullClone: true })).toEqual({ verdict: "clone_limited" });
  });

  it("answers null and reports a coded class when the database refuses (a pool that is not the proxy login)", async () => {
    const reports = captureReports();
    const appPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    try {
      expect(await createRunnerGitResolver(appPool)(request)).toBeNull();
    } finally {
      await appPool.end();
    }
    expect(reports.everything()).toContain("42501");
  });
});
