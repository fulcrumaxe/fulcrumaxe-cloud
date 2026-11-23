import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { guardedPools } from "@fx/db/test/support/pool-teardown.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { githubRoutes, githubRouteDeps } from "@fx/api/src/routes/github.js";
import { InstallationTokenCache, createCustomerRepo, type CreateRepoDeps } from "@fx/github";
import { createGithubRepoVisibility, type RepoReadHttp } from "@fx/worker";
import { placeProjectRoute } from "@fx/runner-cloud";
import { pagedListing, strictGithubFetch } from "../../../../../../../../packages/github/test/helpers/strictGithub";

/**
 * [pg] D#845 ON-7a: create, then pick, then set up. A new repo is made through the real create-intent route and the real creation service (GitHub is the strict fake: User-Agent,
 * Accept, version and JSON rules, listings with total_count), lands in `repos`, and is then confirmed onto a machine. Its visibility is read through the real
 * `GET /repos/{owner}/{repo}` contract. What the fake cannot do faithfully: GitHub's rate limits, abuse detection and the exact wording of every error.
 */
describe("create a repo, pick it, set it up [pg]", () => {
  let pg: EphemeralPostgres;
  const pools = guardedPools();
  let admin: Pool;
  let platformOps: Pool;
  let appUser: Pool;

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: "fx_web_place_test", tmpPrefix: "fx-web-place-" });
    admin = pools.create(pg.url);
    await runMigrations(admin);
    platformOps = pools.create(pg.platformOpsUrl);
    appUser = pools.create(pg.appUserUrl);
  }, 180_000);
  afterAll(async () => {
    await pools.stop(() => pg?.cleanup());
  });

  it("the repo made by create-intent is placed with its setup at plan, and GitHub is asked about it", async () => {
    const SECRET = "state-secret-state-secret-state-secret!!";
    const env = { GITHUB_INSTALL_STATE_SECRET: SECRET, GITHUB_APP_TEAM_CLIENT_ID: "cid", GITHUB_APP_TEAM_CLIENT_SECRET: "csecret", FX_GITHUB_CALLBACK_URL: "https://app.example.test/api/auth/github/callback" };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const accountId = randomUUID();
    const userId = randomUUID();
    const inst = { id: randomUUID(), gh: 9_700_001 };
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [inst.id, accountId, inst.gh]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 1)`, [inst.gh]);

    // 1. create-intent: the real route validates and signs the state.
    githubRouteDeps.getPlatformOpsPool = () => platformOps;
    const intent = githubRoutes.find((r) => r.operationId === "createRepoIntent")!;
    const out = (await intent.handler({ pool: appUser, principal: { accountId, userId, role: "owner", kind: "session" } } as never, { body: { owner_gh_id: 500, name: "widgets", visibility: "private", auto_init: true } } as never)) as { authorize_url: string };
    const state = new URL(out.authorize_url).searchParams.get("state")!;

    // 2. the callback's service, against the strict GitHub fake.
    const NEW_ID = 424242;
    const calls: string[] = [];
    const strict = strictGithubFetch((async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${new URL(u).pathname}`);
      if (u.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "ghu_user" });
      if (u.endsWith("/user")) return Response.json({ id: 500 });
      if (u.includes("/user/installations?")) return pagedListing("installations", [{ id: inst.gh, app_id: 7, account: { id: 500, login: "acme", type: "User" } }], u);
      if (method === "POST" && /\/user\/repos$/.test(u)) return new Response(JSON.stringify({ id: NEW_ID }), { status: 201 });
      if (u.includes("/installation/repositories")) return pagedListing("repositories", [{ id: NEW_ID, name: "widgets", owner: { login: "acme" } }], u);
      if (u.endsWith("/repos/acme/widgets")) return Response.json({ id: NEW_ID, full_name: "acme/widgets", private: true });
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
    const deps: CreateRepoDeps = { platformOpsPool: platformOps, appUserPool: appUser, appCredentials: () => ({ appId: "7", privateKeyPem: pem, webhookSecret: "" }), requester: async () => ({ token: "ghs_install", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), cache: new InstallationTokenCache(), fetchImpl: strict, warn: () => undefined, env };
    expect((await createCustomerRepo(deps, { accountId, userId, code: "one-time-code", state })).outcome).toBe("ok");
    const created = (await admin.query(`SELECT id, execution_mode FROM repos WHERE account_id = $1 AND gh_repo_id = $2`, [accountId, NEW_ID])).rows;
    expect(created).toHaveLength(1);

    // 3. pick and set up: a live machine, and the visibility read through GET /repos/acme/widgets.
    const client = await admin.connect();
    const runner = await insertRunner(client, accountId, userId).finally(() => client.release());
    await admin.query(`UPDATE runners SET protocol_version = 22, model_auth_present = true, last_seen_at = now() WHERE id = $1`, [runner]);
    await admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, host_mem_avail_mb, host_disk_free_mb, host_setups_running, host_load_at) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'microvm', 9000, 50000, 0, now())`, [runner, accountId]);
    const http: RepoReadHttp = {
      async request(req) {
        const res = await strict(`https://api.github.com${req.path}`, { headers: { authorization: "Bearer ghs_install", "user-agent": "fx-test", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
    };
    const reader = createGithubRepoVisibility({ resolveRepo: async () => ({ owner: "acme", name: "widgets" }), open: async () => http });
    const res = await placeProjectRoute({ appUserPool: appUser, origin: "https://runner.example.test", failRunnerLeases: null, repoVisibility: (a, r) => reader.visibility({ accountId: a, repoId: r }) }, { accountId, userId }, created[0].id as string, { kind: "new" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "new", phase: "plan", runner_id: runner });
    expect(calls).toContain("GET /repos/acme/widgets");
    expect((await admin.query(`SELECT execution_mode FROM repos WHERE id = $1`, [created[0].id])).rows).toEqual([{ execution_mode: "runner_local" }]);
    expect((await admin.query(`SELECT runner_id FROM project_placements WHERE account_id = $1`, [accountId])).rows).toEqual([{ runner_id: runner }]);
    vi.unstubAllEnvs();
  }, 60_000);
});
