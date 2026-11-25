import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, setupProgressPath, setupPushTokenPath, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { HELLO_PATH, machineJobClaimRun, readEngineBehind, removeProjectRoute, runnerHello, setupProgressRun, setupPushTokenRun, toResponse, updateEngine, type RunnerCloudDeps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const SHA = "c".repeat(40);
const TAR = "e".repeat(64);
const PUSHED = "f".repeat(40);
const TOKEN = "ghs_sentinel_engine_update_token_0123456789";

/** [pg] D#845 ON-15a: the engine update of an installed project: the behind-read, the route's issuer, the update row, and the push fence, through the real definers with row security forced. */
describe("engine update [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": jobKeys.publicKey };
  beforeAll(async () => {
    h = await harness();
    await h.admin.query("DELETE FROM engine_releases");
  });
  afterAll(() => h.close());

  const minted: string[] = [];
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({
      setupPush: { mint: async (repo) => (minted.push(repo.id), { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) }), revoke: async () => undefined },
      engineCommandSigner: async () => ({ keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", jobKeys.privateKey) }) as never,
      ...over,
    });
  async function release(version: string, o: { minProtocol?: number; withdrawn?: boolean; at?: string; commit?: string } = {}) {
    await h.admin.query("INSERT INTO engine_releases (version, commit_sha, tarball_sha256, min_runner_protocol, published_by, published_at, withdrawn_at) VALUES ($1, $2, $3, $4, 'test', $5, $6)", [
      version, o.commit ?? SHA, TAR, o.minProtocol ?? 22, o.at ?? new Date().toISOString(), o.withdrawn ? new Date().toISOString() : null,
    ]);
  }
  async function reset(...releases: Array<[string, Parameters<typeof release>[1]?]>) {
    await h.admin.query("DELETE FROM engine_releases");
    for (const [v, o] of releases) await release(v, o);
  }
  async function addMember(accountId: string, role: "admin" | "member"): Promise<string> {
    const userId = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, userId, role]);
    return userId;
  }

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; setupId: string; repo2: string; setup2: string }
  /** A fresh account with TWO installed repos (engine 1.0.0), both placed on one machine (hello at protocol 22). */
  async function rig(o: { version?: string | null; phase?: string } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const repo2 = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'acme', 'gadgets')", [repo2, who.accountId]);
    const machine = async () => {
      const key = newKey();
      const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
      const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
      expect(hello.status).toBe(200);
      return { key, runnerId };
    };
    // one project per machine: the second repo has a machine of its own
    const setup = async (repo: string, runnerId: string) => {
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repo, who.accountId, runnerId]);
      return (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, engine_version) VALUES ($1, $2, 'existing', $3, $4, $5) RETURNING id", [who.accountId, repo, who.userId, o.phase ?? "done", o.version === undefined ? "1.0.0" : o.version])).rows[0]!.id;
    };
    const [m1, m2] = [await machine(), await machine()];
    return { who, key: m1.key, runnerId: m1.runnerId, setupId: await setup(who.repoId, m1.runnerId), repo2, setup2: await setup(repo2, m2.runnerId) };
  }
  const as = (r: Rig, userId = r.who.userId, accountId = r.who.accountId) => ({ accountId, userId });
  const refusal = (p: Promise<unknown>) => p.then(() => ({ status: 0, code: "none" }), (e: { status: number; code: string }) => ({ status: e.status, code: e.code }));
  const update = (r: Rig, repo = r.who.repoId, principal = as(r), deps = depsFor()) => updateEngine(deps, principal, repo);
  const updates = async (accountId: string) => (await h.admin.query<{ repo_id: string; setup_id: string; from_version: string; to_version: string; phase: string; sub_step: string | null; state: string; attempt: number; head_sha: string | null; failure_code: string | null }>("SELECT * FROM engine_updates WHERE account_id = $1 ORDER BY created_at", [accountId])).rows;
  const setupRow = async (id: string) => (await h.admin.query("SELECT phase, sub_step, state, failure_code, engine_version, attempt FROM project_setups WHERE id = $1", [id])).rows[0];
  const jobRow = async (setupId: string) => (await h.admin.query<{ id: string; kind: string; state: string; attempt: number; job: { job: MachineJob } }>("SELECT id, kind, state, attempt, job FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt DESC LIMIT 1", [setupId])).rows[0]!;

  it("issues the update of an installed repo: the newest release the machine can run, a signed engine_update job, one update row, and the installed setup untouched", async () => {
    await reset(["1.0.0", { at: "2026-01-01T00:00:00Z" }], ["1.2.0", { at: "2026-03-01T00:00:00Z", commit: "9".repeat(40) }], ["1.3.0", { at: "2026-04-01T00:00:00Z", withdrawn: true }], ["1.4.0", { at: "2026-05-01T00:00:00Z", minProtocol: 99 }]);
    const r = await rig();
    const res = await update(r);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attempt: 1, from_version: "1.0.0", to_version: "1.2.0", branch: "fx/engine-update-1.2.0" });
    const job = verifyMachineJob((await jobRow(r.setupId)).job, keyring, r.runnerId);
    expect(job).toMatchObject({ kind: "engine_update", setup_id: r.setupId, requires_engine: "any", args: { branch: "fx/engine-update-1.2.0", engine: { version: "1.2.0", commit_sha: "9".repeat(40), tarball_sha256: TAR } } });
    expect(await updates(r.who.accountId)).toMatchObject([{ repo_id: r.who.repoId, setup_id: r.setupId, from_version: "1.0.0", to_version: "1.2.0", phase: "push", state: "started", attempt: 1 }]);
    expect(await setupRow(r.setupId)).toMatchObject({ phase: "done", sub_step: null, state: "started", failure_code: null, engine_version: "1.0.0", attempt: 1 });
    expect((await jobRow(r.setupId)).kind).toBe("engine_update");
  });

  it("refuses a second live update of the repo (even two at once) and leaves the account's other repo free", async () => {
    await reset(["1.2.0"]);
    const r = await rig();
    expect(await refusal(update(r))).toEqual({ status: 0, code: "none" });
    expect(await refusal(update(r))).toEqual({ status: 409, code: "update_live" });
    expect(await updates(r.who.accountId)).toHaveLength(1);
    expect((await update(r, r.repo2)).status).toBe(200);
    const raced = await rig();
    const both = await Promise.all([refusal(update(raced)), refusal(update(raced))]);
    expect(both.map((x) => x.code).sort()).toEqual(["none", "update_live"]);
    expect(await updates(raced.who.accountId)).toHaveLength(1);
  });

  it("is not behind when the newest release is the installed one or older, compares number by number, and never offers a withdrawn or too-new release", async () => {
    const r = await rig({ version: "1.9.0" });
    await reset(["1.9.0"]);
    expect(await refusal(update(r))).toEqual({ status: 409, code: "not_behind" });
    await reset(["1.9.0", { at: "2026-01-01T00:00:00Z" }], ["1.10.0", { at: "2026-02-01T00:00:00Z", withdrawn: true }]);
    expect(await refusal(update(r))).toEqual({ status: 409, code: "not_behind" });
    await reset(["1.9.0", { at: "2026-01-01T00:00:00Z" }], ["1.10.0", { at: "2026-02-01T00:00:00Z", minProtocol: 23 }]);
    expect(await refusal(update(r))).toEqual({ status: 409, code: "not_behind" });
    await reset(["2.0.0", { at: "2026-01-01T00:00:00Z" }], ["1.5.0", { at: "2026-02-01T00:00:00Z" }]);
    expect(await refusal(update(r))).toEqual({ status: 409, code: "not_behind" });
    await reset(["1.9.0", { at: "2026-01-01T00:00:00Z" }], ["1.10.0", { at: "2026-02-01T00:00:00Z" }]);
    expect((await update(r)).status).toBe(200);
    expect(await updates(r.who.accountId)).toMatchObject([{ to_version: "1.10.0" }]);
    const unknown = await rig({ version: null });
    expect(await refusal(update(unknown))).toEqual({ status: 409, code: "not_behind" });
    expect(await updates(r.who.accountId)).toHaveLength(1);
  });

  it("is for an owner or admin: a member is 403 and writes nothing; an admin may; a foreign account's repo and a repo with no installed setup are 404", async () => {
    await reset(["1.2.0"]);
    const r = await rig();
    const member = await addMember(r.who.accountId, "member");
    expect(await refusal(update(r, r.who.repoId, as(r, member)))).toEqual({ status: 403, code: "forbidden" });
    expect(await updates(r.who.accountId)).toEqual([]);
    expect((await update(r, r.who.repoId, as(r, await addMember(r.who.accountId, "admin")))).status).toBe(200);
    const other = await rig();
    expect(await refusal(update(r, other.who.repoId))).toEqual({ status: 404, code: "not_found" });
    expect(await refusal(update(r, randomUUID()))).toEqual({ status: 404, code: "not_found" });
    expect(await refusal(update(r, "not-a-uuid"))).toEqual({ status: 404, code: "not_found" });
    expect(await updates(other.who.accountId)).toEqual([]);
    const notInstalled = await rig({ phase: "install" });
    expect(await refusal(update(notInstalled))).toEqual({ status: 404, code: "not_found" });
    expect(await refusal(update(r, r.who.repoId, as(r, other.who.userId)))).toMatchObject({ status: 403 });
  });

  it("503s with no signer, and 409s a project that is not placed", async () => {
    await reset(["1.2.0"]);
    const r = await rig();
    expect(await refusal(update(r, r.who.repoId, as(r), depsFor({ engineCommandSigner: null })))).toEqual({ status: 503, code: "not_configured" });
    await h.admin.query("DELETE FROM project_placements WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, r.who.repoId]);
    expect(await refusal(update(r))).toEqual({ status: 409, code: "setup_not_placed" });
    expect(await updates(r.who.accountId)).toEqual([]);
  });

  it("reads tenant-scoped: the behind-read through the RLS-bypassing client with a foreign account finds nothing, and app_user reads only its own account's updates and writes none", async () => {
    await reset(["1.2.0"]);
    const a = await rig();
    const b = await rig();
    await update(a);
    expect(await readEngineBehind(h.admin, b.who.accountId, a.who.repoId)).toBeNull();
    expect(await readEngineBehind(h.admin, a.who.accountId, b.who.repoId)).toBeNull();
    expect(await readEngineBehind(h.admin, a.who.accountId, a.who.repoId)).toMatchObject({ setupId: a.setupId, from: "1.0.0", behind: true, release: { version: "1.2.0" } });
    expect(await readEngineBehind(h.admin, a.who.accountId, a.repo2)).toMatchObject({ setupId: a.setup2 });
    const seen = (r: Rig, acct: string) => withTenant(h.appPool, acct, r.who.userId, async (c) => (await c.query("SELECT repo_id FROM engine_updates")).rows);
    expect(await seen(a, a.who.accountId)).toHaveLength(1);
    expect(await seen(b, b.who.accountId)).toEqual([]);
    expect(await seen(b, a.who.accountId)).toHaveLength(1);
    await expect(withTenant(h.appPool, a.who.accountId, a.who.userId, (c) => c.query("UPDATE engine_updates SET phase = 'done'"))).rejects.toThrow();
    await expect(withTenant(h.appPool, a.who.accountId, a.who.userId, (c) => c.query("DELETE FROM engine_updates"))).rejects.toThrow();
    // another repo's live update (the same account's second repo) is not this repo's
    const live = await withTenant(h.appPool, a.who.accountId, a.who.userId, async (c) => (await c.query("SELECT 1 FROM engine_updates WHERE repo_id = $1", [a.repo2])).rows);
    expect(live).toEqual([]);
  });

  it("refuses the definer to a runner session, a signed job that is not the newest release's, and another account's setup", async () => {
    await reset(["1.2.0", { commit: "a".repeat(40) }]);
    const r = await rig();
    const other = await rig();
    const call = (accountId: string, userId: string, env: unknown, setupId = r.setupId, repoId = r.who.repoId, runnerSession = false) =>
      withTenant(h.appPool, accountId, userId, async (c) => {
        if (runnerSession) await c.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]);
        const iso = (d: number) => new Date(Date.now() + d).toISOString();
        return (await c.query("SELECT o_result FROM engine_update_issue($1, $2, $3, $4, $5::jsonb, $6, $7)", [randomUUID(), (env as { job: { job_id: string } }).job.job_id, repoId, setupId, JSON.stringify(env), iso(-1000), iso(600_000)])).rows[0]?.o_result as string;
      });
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [r.who.repoId])).rows[0]!.gh_repo_id);
    const env = (over: Record<string, unknown> = {}, args: Record<string, unknown> = {}) => ({
      job: { v: 1, job_id: randomUUID(), runner_id: r.runnerId, repo_gh_id: ghRepoId, setup_id: r.setupId, requires_engine: "any", kind: "engine_update", issued_at: "x", expires_at: "y", args: { branch: "fx/engine-update-1.2.0", engine: { version: "1.2.0", commit_sha: "a".repeat(40), tarball_sha256: TAR, tarball_url: `https://codeload.github.com/fulcrumaxe/fulcrumaxe/tar.gz/${"a".repeat(40)}` }, ...args }, ...over },
    });
    await expect(call(r.who.accountId, r.who.userId, env(), r.setupId, r.who.repoId, true)).rejects.toThrow(/refused/);
    await expect(call(r.who.accountId, await addMember(r.who.accountId, "member"), env())).rejects.toThrow(/refused/);
    await expect(call(r.who.accountId, r.who.userId, env({ kind: "project_setup" }))).rejects.toThrow(/not an engine_update job/);
    expect(await call(r.who.accountId, r.who.userId, env({}, { branch: "fx/engine-update-1.9.9" }))).toBe("setup_changed");
    expect(await call(r.who.accountId, r.who.userId, env({}, { engine: { version: "1.2.0", commit_sha: "b".repeat(40), tarball_sha256: TAR, tarball_url: `https://codeload.github.com/fulcrumaxe/fulcrumaxe/tar.gz/${"b".repeat(40)}` } }))).toBe("setup_changed");
    expect(await call(r.who.accountId, r.who.userId, env({ runner_id: other.runnerId }))).toBe("not_placed");
    expect(await call(other.who.accountId, other.who.userId, env(), r.setupId, r.who.repoId)).toBe("not_found");
    expect(await call(r.who.accountId, r.who.userId, env(), r.setupId, r.repo2)).toBe("not_found");
    // the definer holds the release rules on its own, whatever the caller read: a withdrawn or too-new newest release and an installed one that is already current are not behind
    await reset(["1.2.0", { commit: "a".repeat(40), withdrawn: true }]);
    expect(await call(r.who.accountId, r.who.userId, env())).toBe("not_behind");
    await reset(["1.2.0", { commit: "a".repeat(40), minProtocol: 23 }]);
    expect(await call(r.who.accountId, r.who.userId, env())).toBe("not_behind");
    await reset(["1.2.0", { commit: "a".repeat(40) }]);
    await h.admin.query("UPDATE project_setups SET engine_version = '1.2.0' WHERE id = $1", [r.setupId]);
    expect(await call(r.who.accountId, r.who.userId, env())).toBe("not_behind");
    expect(await updates(r.who.accountId)).toEqual([]);
    expect(await updates(other.who.accountId)).toEqual([]);
  });

  describe("the runner's side: the push credential, the pushed commit and the steps", () => {
    let seq = 0;
    const issued = async () => {
      await reset(["1.2.0"]);
      const r = await rig();
      const res = await update(r);
      const jobId = (res.body as { job_id: string }).job_id;
      const taken = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((taken.body as { signed_job?: { job: { job_id: string } } }).signed_job?.job.job_id).toBe(jobId);
      return { r, jobId };
    };
    const progress = (r: Rig, jobId: string, body: Record<string, unknown>, setupId = r.setupId) => respond(() => setupProgressRun(depsFor(), signed(r.key, setupProgressPath(setupId), { job_id: jobId, seq: seq++, ...body }), setupId));
    const token = (r: Rig, jobId: string, setupId = r.setupId) => respond(() => setupPushTokenRun(depsFor(), signed(r.key, setupPushTokenPath(setupId), { job_id: jobId }), setupId));

    it("hands over one credential once the update reported the push step started, then the pushed commit is recorded on the update and the installed setup keeps its own state", async () => {
      const { r, jobId } = await issued();
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "push_not_started" } } });
      expect((await progress(r, jobId, { sub_step: "push", state: "started" })).status).toBe(200);
      minted.length = 0;
      expect((await token(r, jobId)).status).toBe(200);
      expect(minted).toEqual([r.who.repoId]);
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "already_issued" } } });
      expect((await progress(r, jobId, { sub_step: "push", state: "ok" })).status).toBe(400);
      expect((await progress(r, jobId, { sub_step: "push", state: "ok", head_sha: PUSHED })).status).toBe(200);
      expect(await progress(r, jobId, { sub_step: "push", state: "ok", head_sha: "a".repeat(40) })).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
      expect(await updates(r.who.accountId)).toMatchObject([{ phase: "push", sub_step: "push", state: "ok", head_sha: PUSHED }]);
      expect(await setupRow(r.setupId)).toMatchObject({ phase: "done", sub_step: null, state: "started", failure_code: null });
      expect(JSON.stringify((await h.admin.query("SELECT t.* FROM engine_updates t")).rows)).not.toContain(TOKEN);
    });

    it("answers a foreign runner, another setup and a job that is no longer current as the install does, and a failed step ends the job and the update and frees the repo", async () => {
      const { r, jobId } = await issued();
      await progress(r, jobId, { sub_step: "push", state: "started" });
      const other = await rig();
      expect((await respond(() => setupPushTokenRun(depsFor(), signed(other.key, setupPushTokenPath(r.setupId), { job_id: jobId }), r.setupId))).status).toBe(404);
      expect((await token(r, jobId, r.setup2)).status).toBe(404);
      expect((await progress(r, randomUUID(), { sub_step: "push", state: "ok", head_sha: PUSHED })).status).toBe(404);
      expect((await progress(r, jobId, { sub_step: "push", state: "failed", failure_code: "push_failed" })).status).toBe(200);
      expect(await updates(r.who.accountId)).toMatchObject([{ phase: "failed", state: "failed", failure_code: "push_failed" }]);
      expect((await jobRow(r.setupId)).state).toBe("failed");
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
      expect(await setupRow(r.setupId)).toMatchObject({ phase: "done", state: "started", failure_code: null });
      expect((await update(r)).status).toBe(200);
      expect((await jobRow(r.setupId)).attempt).toBe(2);
      expect(await progress(r, jobId, { sub_step: "push", state: "started" })).toMatchObject({ status: 409 });
    });

    it("ends the job in the transaction that records the head: eleven quiet minutes later the update is still push/ok with its head, the job is done and the machine holds no delivered job", async () => {
      const { r, jobId } = await issued();
      expect((await progress(r, jobId, { sub_step: "push", state: "started" })).status).toBe(200);
      expect((await token(r, jobId)).status).toBe(200);
      expect((await progress(r, jobId, { sub_step: "push", state: "ok", head_sha: PUSHED })).status).toBe(200);
      expect((await jobRow(r.setupId)).state).toBe("done");
      await h.admin.query("UPDATE machine_jobs SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [jobId]);
      const next = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((next.body as { signed_job?: unknown }).signed_job).toBeUndefined();
      expect(await updates(r.who.accountId)).toMatchObject([{ phase: "push", sub_step: "push", state: "ok", head_sha: PUSHED, failure_code: null }]);
      const job = (await h.admin.query<{ state: string; failure_code: string | null; ended_at: Date | null }>("SELECT state, failure_code, ended_at FROM machine_jobs WHERE id = $1", [jobId])).rows[0]!;
      expect(job).toMatchObject({ state: "done", failure_code: null });
      expect(job.ended_at).not.toBeNull();
      expect((await h.admin.query("SELECT 1 FROM machine_jobs WHERE account_id = $1 AND runner_id = $2 AND state IN ('issued', 'delivered')", [r.who.accountId, r.runnerId])).rows).toEqual([]);
      // a step after the end is not accepted
      expect((await progress(r, jobId, { sub_step: "push", state: "started" })).status).toBe(409);
    });

    it("takes the removal's lock: a removal and an update at once leave no live update on a removed project, and a removed project gets no push grant", async () => {
      await reset(["1.2.0"]);
      const r = await rig();
      const waiting = async () => (await h.admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows.length > 0;
      let raced: Promise<{ status: number; code: string }> | undefined;
      const removal = await toResponse(() => removeProjectRoute(depsFor(), as(r), r.who.repoId, { delete_sandbox: false, removal_pr: false }, {
        beforeCommit: async () => {
          raced = refusal(update(r));
          for (let i = 0; i < 100 && !(await waiting()); i++) await new Promise((res) => setTimeout(res, 50));
          expect(await waiting()).toBe(true);
        },
      }));
      expect(removal.status).toBe(200);
      expect(await raced).toEqual({ status: 404, code: "not_found" });
      expect(await updates(r.who.accountId)).toEqual([]);
      expect((await h.admin.query("SELECT 1 FROM machine_jobs WHERE account_id = $1 AND kind = 'engine_update'", [r.who.accountId])).rows).toEqual([]);
      expect(await setupRow(r.setupId)).toMatchObject({ phase: "removed" });

      // the other order: an update that holds the lock first makes the removal wait for its job, and refuse it
      const live = await rig();
      expect((await update(live)).status).toBe(200);
      expect(await toResponse(() => removeProjectRoute(depsFor(), as(live), live.who.repoId, { delete_sandbox: false, removal_pr: false }))).toMatchObject({ status: 409, body: { error: { code: "setup_running" } } });
    });

    it("refuses the push credential and the steps once the setup is no longer installed", async () => {
      const { r, jobId } = await issued();
      expect((await progress(r, jobId, { sub_step: "push", state: "started" })).status).toBe(200);
      await h.admin.query("UPDATE project_setups SET phase = 'removed' WHERE id = $1", [r.setupId]);
      minted.length = 0;
      expect((await token(r, jobId)).status).toBe(404);
      expect(minted).toEqual([]);
      expect((await progress(r, jobId, { sub_step: "push", state: "ok", head_sha: PUSHED })).status).toBe(404);
      expect(await updates(r.who.accountId)).toMatchObject([{ phase: "push", sub_step: "push", state: "started", head_sha: null }]);
    });

    it("lets an expired job fail its update and never the installed setup, and frees the repo for the next one", async () => {
      await reset(["1.2.0"]);
      const r = await rig();
      const past = new Date(Date.now() - 40 * 60_000);
      const res = await update(r, r.who.repoId, as(r), depsFor({ now: () => past }));
      expect(res.status).toBe(200);
      const taken = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((taken.body as { signed_job?: unknown }).signed_job).toBeUndefined();
      expect(await updates(r.who.accountId)).toMatchObject([{ phase: "failed", state: "failed", failure_code: "job_expired" }]);
      expect((await jobRow(r.setupId)).state).toBe("expired");
      expect(await setupRow(r.setupId)).toMatchObject({ phase: "done", state: "started", failure_code: null });
      expect((await update(r)).status).toBe(200);
    });
  });
});
