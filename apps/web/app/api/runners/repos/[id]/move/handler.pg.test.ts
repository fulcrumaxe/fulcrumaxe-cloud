import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { guardedPools } from "@fx/db/test/support/pool-teardown.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";

/**
 * [pg] D#845 MC-9b1: the product's own move route, end to end. The REAL handler, `handleSessionRequest`, `runnerDeps()` and `@fx/runner-cloud` run against real Postgres with row security forced and real Ed25519 job
 * signatures. Only the four edges that need the outside world are replaced: the session cookie (a fixed signed-in person), the database pools, the worker that holds the job-signing key, and GitHub's default branch.
 */
const jobKeys = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": jobKeys.publicKey };
const HEAD = "f".repeat(40);
const state = vi.hoisted(() => ({ pools: null as null | { appUserPool: unknown; platformOpsPool: unknown }, session: null as null | { accountId: string; userId: string }, signerKey: null as unknown }));

vi.mock("../../../../auth/_lib/deps", () => ({ defaultAuthDeps: () => state.pools }));
vi.mock("../../../../../../lib/shell/session-guard", () => ({
  resolveActiveSession: async () => (state.session ? { session: state.session, refreshedToken: null } : null),
  applyRefreshedSessionCookie: (res: unknown) => res,
}));
vi.mock("../../../../../../lib/worker", () => ({
  getWorker: async () => ({ engineCommandSigner: { keyId: "job-key-1", signEngineCommand: () => { throw new Error("unused"); }, signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", state.signerKey as never) } }),
}));
vi.mock("../../../../../../lib/github/runnerPullRequest", () => ({
  createAppRunPullRequestPort: () => ({ defaultBranch: async () => "main", branchState: async () => ({ exists: true, headOid: "f".repeat(40), aheadBy: 0, defaultBranch: "main" }) }),
}));

describe("POST /api/runners/repos/:id/move, the real route [pg]", () => {
  let pg: EphemeralPostgres;
  const pools = guardedPools();
  let adminPool: Pool;
  let admin: PoolClient;
  let handler: typeof import("./handler");

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: "fx_web_move_route_test", tmpPrefix: "fx-web-move-" });
    adminPool = pools.create(pg.url);
    await runMigrations(adminPool);
    admin = await adminPool.connect();
    state.pools = { appUserPool: pools.create(pg.appUserUrl), platformOpsPool: pools.create(pg.platformOpsUrl) };
    state.signerKey = jobKeys.privateKey;
    handler = await import("./handler");
  }, 180_000);
  afterAll(async () => {
    admin?.release();
    await pools.stop(() => pg?.cleanup());
  });

  interface Rig { who: SeedRefs; ghRepoId: number; from: string; to: string; member: string }
  async function rig(o: { operate?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const ghRepoId = Number((await admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const machine = async (): Promise<string> => {
      const id = await insertRunner(admin, who.accountId, who.userId, {});
      await admin.query("UPDATE runners SET protocol_version = 22, model_auth_present = true, last_seen_at = now() WHERE id = $1", [id]);
      await admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, host_mem_avail_mb, host_disk_free_mb, host_setups_running, host_load_at) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'microvm', 9000, 50000, 0, now())", [id, who.accountId]);
      return id;
    };
    const from = await machine();
    const to = await machine();
    await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, from]);
    await admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [from, who.repoId]);
    await admin.query("UPDATE accounts SET engine_quantity = 1, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId]);
    await admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    await admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    // The old machine ran this engine: a start it has not finished is its evidence, so the move leaves it a cleanup request.
    const startId = randomUUID();
    const issued = new Date(Date.now() - 60_000);
    const startJob = { job: { job_id: startId, kind: "engine_session_start", runner_id: from, issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 1_800_000).toISOString() } };
    await admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, 'engine_session_start', $5::jsonb, 'delivered', $6, $7, $6)", [startId, who.accountId, from, who.repoId, JSON.stringify(startJob), issued, new Date(issued.getTime() + 1_800_000)]);
    const member = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [member, `${member}@example.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [who.accountId, member]);
    return { who, ghRepoId, from, to, member };
  }
  const post = async (repoId: string, body: unknown) => {
    const res = await handler.moveProjectHandler(new NextRequest(`http://localhost/api/runners/repos/${repoId}/move`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), repoId);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const world = async (r: Rig) => ({
    placement: (await admin.query<{ runner_id: string }>("SELECT runner_id FROM project_placements WHERE account_id = $1", [r.who.accountId])).rows.map((x) => x.runner_id),
    jobs: (await admin.query<{ kind: string; runner_id: string; job: { job: MachineJob; key_id: string } }>("SELECT kind, runner_id, job FROM machine_jobs WHERE account_id = $1", [r.who.accountId])).rows,
    cleanups: (await admin.query<{ runner_id: string; reason: string }>("SELECT runner_id, reason FROM machine_cleanups WHERE account_id = $1", [r.who.accountId])).rows,
  });

  it("moves the project through the product's own route: the placement, a start on the new machine, and the old machine's move request", async () => {
    const r = await rig();
    state.session = { accountId: r.who.accountId, userId: r.who.userId };
    const res = await post(r.who.repoId, { to_runner_id: r.to });
    expect(res).toEqual({ status: 200, body: { repo_id: r.who.repoId, from_runner_id: r.from, to_runner_id: r.to, old_copy: "queued" } });
    const w = await world(r);
    expect(w.placement).toEqual([r.to]);
    // The start the old machine already held is left alone; the new machine gets its own.
    const mine = w.jobs.filter((j) => j.runner_id === r.to);
    expect(w.jobs.filter((j) => j.runner_id === r.from).map((j) => j.kind)).toEqual(["engine_session_start"]);
    expect(mine.map((j) => j.kind)).toEqual(["engine_session_start"]);
    expect(verifyMachineJob(mine[0]!.job, keyring, r.to)).toMatchObject({ repo_gh_id: r.ghRepoId, args: { at_sha: HEAD, resume: false, operate_epoch: 1 } });
    expect(w.cleanups).toEqual([{ runner_id: r.from, reason: "move" }]);
  });

  it("refuses with the codes the screen reads, and a refused move changes nothing: signed out 401, a member 403, operate off 409, a body that is not the route's 400", async () => {
    const r = await rig();
    const before = JSON.stringify(await world(r));
    state.session = null;
    expect((await post(r.who.repoId, { to_runner_id: r.to })).status).toBe(401);
    state.session = { accountId: r.who.accountId, userId: r.member };
    const member = await post(r.who.repoId, { to_runner_id: r.to });
    expect([member.status, (member.body as { error: { code: string } }).error.code]).toEqual([403, "forbidden"]);
    state.session = { accountId: r.who.accountId, userId: r.who.userId };
    const bad = await post(r.who.repoId, { to_runner_id: r.to, extra: 1 });
    expect([bad.status, (bad.body as { error: { code: string } }).error.code]).toEqual([400, "invalid_message"]);
    expect(JSON.stringify(await world(r))).toBe(before);
    const off = await rig({ operate: false });
    state.session = { accountId: off.who.accountId, userId: off.who.userId };
    const refused = await post(off.who.repoId, { to_runner_id: off.to });
    expect([refused.status, (refused.body as { error: { code: string } }).error.code]).toEqual([409, "operate_off"]);
    expect((await world(off)).placement).toEqual([off.from]);
    // Another account's person never reaches this repo.
    state.session = { accountId: off.who.accountId, userId: off.who.userId };
    expect((await post(r.who.repoId, { to_runner_id: r.to })).status).toBe(404);
    expect(JSON.stringify(await world(r))).toBe(before);
  });
});
