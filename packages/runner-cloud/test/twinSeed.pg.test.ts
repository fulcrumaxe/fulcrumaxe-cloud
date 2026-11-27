import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, MachineJobClaimReply, SetupPushTokenReply, setupProgressPath, setupPushTokenPath, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { HELLO_PATH, RunnerHttpError, RunPullRequestError, checkTwinSeed, issueTwinSeed, machineJobClaimRun, runnerHello, setupProgressRun, setupPushTokenRun, type RunnerCloudDeps, type RunPullRequestPort } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { issueTestJob } from "./helpers/machineJobIssuer.js";

const TOKEN = "ghs_sentinel_twin_seed_token_0123456789";
const PUB_HEAD = "c".repeat(40);

/**
 * [pg] D#845 ON-27b (migration 1108): the twin seed's cloud side, over the real signed HTTP path, real Ed25519 job signatures, the real SECURITY DEFINER functions as the runner and the app login, and row security forced.
 * The GitHub App is a fake that enforces what the real port does for these calls (one repository per token, a fixed shape of answer). What it cannot show: GitHub's own rate limits and permission model.
 */
describe("twin seed [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const minted: Array<{ id: string; owner: string; name: string }> = [];
  const port = (over: { fail?: unknown } = {}) => ({
    async mint(repo: { id: string; owner: string; name: string }) {
      if (over.fail !== undefined) throw over.fail;
      minted.push(repo);
      return { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) };
    },
    async revoke() {},
  });
  /** `heads` maps a repository's owner/name to the tip of its default branch (null: no commit); asking for a name that is not listed fails like GitHub's 404. */
  const github = (heads: Record<string, string | null>, asked: string[] = []): RunPullRequestPort =>
    ({
      defaultBranch: async (repo: { owner: string; name: string }) => (asked.push(`${repo.owner}/${repo.name}`), "main"),
      branchState: async ({ repo, branch }: { repo: { owner: string; name: string }; branch: string }) => {
        const head = heads[`${repo.owner}/${repo.name}`];
        if (head === undefined) throw new RunPullRequestError("unavailable", 404);
        return { exists: head !== null, headOid: head, aheadBy: 0, defaultBranch: branch };
      },
    }) as unknown as RunPullRequestPort;
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({ repoVisibility: async () => "private", setupPush: port(), pullRequests: github({ "acme/widgets": PUB_HEAD }), engineCommandSigner: async () => ({ keyId: "k1", signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", jobKeys.privateKey) }) as never, ...over });

  interface Rig {
    who: SeedRefs;
    key: TestKey;
    runnerId: string;
    publicId: string;
    privateId: string;
    publicGh: number;
    privateGh: number;
    twinId: string;
    setupId: string;
    adminUser: string;
    memberUser: string;
  }
  async function addUser(accountId: string, role: string): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
    return id;
  }
  /** A fresh account with a public repo, a private twin (seeding), the twin's setup at the survey step, a machine that lists the capabilities given and the twin placed on it. */
  async function rig(o: { caps?: string[]; placed?: boolean; setup?: boolean; state?: string } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const publicGh = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const privateId = randomUUID();
    const privateGh = publicGh + 1;
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets-private')", [privateId, who.accountId, who.installationId, privateGh]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() =>
      runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: o.caps ?? ["project_setup_v1", "twin_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })),
    );
    expect(hello.status).toBe(200);
    if (o.placed !== false) await h.admin.query("INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.accountId, privateId, runnerId]);
    const setupId = randomUUID();
    if (o.setup !== false) await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, $3, 'existing', $4, 'survey')", [setupId, who.accountId, privateId, who.userId]);
    const twinId = randomUUID();
    await h.admin.query("INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state, removed_at) VALUES ($1, $2, $3, $4, 'widgets-private', $5, $6, $7, CASE WHEN $7 = 'removed' THEN now() END)", [twinId, who.accountId, who.repoId, privateId, privateGh, who.userId, o.state ?? "seeding"]);
    return { who, key, runnerId, publicId: who.repoId, privateId, publicGh, privateGh, twinId, setupId, adminUser: await addUser(who.accountId, "admin"), memberUser: await addUser(who.accountId, "member") };
  }
  const principal = (r: Rig, userId = r.adminUser) => ({ accountId: r.who.accountId, userId });
  const issue = (r: Rig, o: { as?: string; deps?: RunnerCloudDeps; twin?: string } = {}) => issueTwinSeed(o.deps ?? depsFor(), principal(r, o.as), o.twin ?? r.twinId);
  const failureOf = async (run: () => Promise<unknown>): Promise<{ status: number; code: string } | null> => {
    try {
      await run();
      return null;
    } catch (error) {
      if (error instanceof RunnerHttpError) return { status: error.status, code: error.code };
      throw error;
    }
  };
  const twinRow = async (id: string) => (await h.admin.query("SELECT state, failure_code, failure_reason, published_private_sha, synced_public_sha FROM repo_twins WHERE id = $1", [id])).rows[0];
  const setupRow = async (id: string) => (await h.admin.query("SELECT phase, state, failure_code, sub_step FROM project_setups WHERE id = $1", [id])).rows[0];
  const jobRows = async (setupId: string) => (await h.admin.query<{ id: string; state: string; attempt: number; kind: string; repo_id: string; push_token_at: string | null; job: { job: MachineJob } }>("SELECT id, state, attempt, kind, repo_id, push_token_at, job FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt", [setupId])).rows;
  /** Issues the seed and has the runner take it. */
  async function started(r: Rig): Promise<string> {
    const { job_id } = await issue(r);
    const taken = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
    expect(taken.status).toBe(200);
    expect(MachineJobClaimReply.parse(taken.body)).toHaveProperty("signed_job");
    return job_id;
  }
  const seqs = new Map<string, number>();
  const progress = (r: Rig, jobId: string, body: Record<string, unknown>, deps: RunnerCloudDeps = depsFor()) => {
    const seq = seqs.get(jobId) ?? 0;
    seqs.set(jobId, seq + 1);
    return respond(() => setupProgressRun(deps, signed(r.key, setupProgressPath(r.setupId), { job_id: jobId, seq, ...body }), r.setupId));
  };
  /** The reports the runner makes before it asks for the credential: the fetch (started, ok) and the push started. */
  const reportedToPush = async (r: Rig, jobId: string) => {
    for (const b of [{ sub_step: "twin_fetch", state: "started" }, { sub_step: "twin_fetch", state: "ok" }, { sub_step: "push", state: "started" }]) expect((await progress(r, jobId, b)).status).toBe(200);
  };
  const token = (r: Rig, jobId: string, o: { setupId?: string; key?: TestKey; deps?: RunnerCloudDeps } = {}) => {
    const setupId = o.setupId ?? r.setupId;
    return respond(() => setupPushTokenRun(o.deps ?? depsFor(), signed(o.key ?? r.key, setupPushTokenPath(setupId), { job_id: jobId }), setupId));
  };
  const pushed = (r: Rig, jobId: string, head = PUB_HEAD) => progress(r, jobId, { sub_step: "push", state: "ok", head_sha: head });

  describe("the kind, the capability and the claim", () => {
    it("the kind CHECK takes twin_seed and still refuses any other word", async () => {
      const r = await rig();
      const { job_id } = await issue(r);
      expect((await jobRows(r.setupId)).map((j) => j.kind)).toEqual(["twin_seed"]);
      expect(job_id).toBe((await jobRows(r.setupId))[0]!.id);
      await expect(h.admin.query("UPDATE machine_jobs SET kind = 'twin_publish' WHERE id = $1", [job_id])).rejects.toMatchObject({ code: "23514" });
      // the kinds that came before it are all still there
      for (const kind of ["project_setup", "engine_update", "engine_session_start", "engine_session_stop", "engine_session_delete", "project_remove"]) {
        const probe = await h.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'machine_jobs_kind_check'");
        expect(probe.rows[0].def, kind).toContain(`'${kind}'`);
      }
    });

    it("a runner is offered the seed only when its latest hello lists twin_v1, and then takes the job exactly as signed", async () => {
      const old = await rig({ caps: ["project_setup_v1"] });
      await issue(old);
      const idle = await respond(() => machineJobClaimRun(h.deps(), signed(old.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(MachineJobClaimReply.parse(idle.body)).toHaveProperty("retry_after");
      expect((await jobRows(old.setupId))[0]).toMatchObject({ state: "issued" });
      // a hello that lists it later is offered the same job
      const hello = await respond(() => runnerHello(h.deps(), signed(old.key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1", "twin_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
      expect(hello.status).toBe(200);
      const taken = MachineJobClaimReply.parse((await respond(() => machineJobClaimRun(h.deps(), signed(old.key, MACHINE_JOB_CLAIM_PATH, {})))).body);
      expect(taken).toHaveProperty("signed_job");
      const job = verifyMachineJob((taken as { signed_job: unknown }).signed_job, { k1: jobKeys.publicKey }, old.runnerId);
      expect(job).toMatchObject({ kind: "twin_seed", repo_gh_id: old.privateGh, setup_id: old.setupId, requires_engine: "any", args: { twin_id: old.twinId, public: { owner: "acme", name: "widgets", gh_id: old.publicGh, default_branch: "main", head_sha: PUB_HEAD }, private: { owner: "acme", name: "widgets-private", gh_id: old.privateGh } } });
    });

    it("another machine's twin job is never handed over, and a runner with no twin_v1 gets nothing even when the job is its own", async () => {
      const a = await rig();
      const b = await rig();
      await issue(a);
      const other = await respond(() => machineJobClaimRun(h.deps(), signed(b.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(MachineJobClaimReply.parse(other.body)).toHaveProperty("retry_after");
      expect((await jobRows(a.setupId))[0]!.state).toBe("issued");
    });
  });

  describe("the issue", () => {
    it("signs one job bound to the twin's own repository and setup and machine, writes it once, and keeps the twin seeding", async () => {
      const r = await rig();
      const out = await issue(r);
      expect(out.attempt).toBe(1);
      const [row] = await jobRows(r.setupId);
      expect(row).toMatchObject({ id: out.job_id, kind: "twin_seed", state: "issued", attempt: 1, repo_id: r.privateId });
      expect(row!.job.job).toMatchObject({ repo_gh_id: r.privateGh, setup_id: r.setupId, runner_id: r.runnerId });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding", published_private_sha: null, synced_public_sha: null });
      expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "seed_live" });
    });

    it("is for an owner or admin: a member is 403, and no row is written", async () => {
      const r = await rig();
      expect(await failureOf(() => issue(r, { as: r.memberUser }))).toEqual({ status: 403, code: "forbidden" });
      expect(await jobRows(r.setupId)).toEqual([]);
      // the definer holds the same line on its own, for a caller that skips the service
      const direct = await h.appPool.connect();
      try {
        await direct.query("BEGIN");
        await direct.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [r.who.accountId, r.memberUser]);
        await expect(direct.query("SELECT o_result FROM twin_seed_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now() + interval '1 minute')", [r.twinId, randomUUID()])).rejects.toMatchObject({ code: "42501" });
        await direct.query("ROLLBACK");
      } finally {
        direct.release();
      }
      expect((await issue(r, { as: r.adminUser })).attempt).toBe(1);
    });

    it("never signs for the public repository: the definer refuses a job that names it as the target, in any of its places", async () => {
      const r = await rig();
      const good = { v: 1, job_id: randomUUID(), runner_id: r.runnerId, repo_gh_id: r.privateGh, setup_id: r.setupId, requires_engine: "any", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), kind: "twin_seed",
        args: { twin_id: r.twinId, public: { owner: "acme", name: "widgets", gh_id: r.publicGh, default_branch: "main", head_sha: PUB_HEAD }, private: { owner: "acme", name: "widgets-private", gh_id: r.privateGh } } };
      const call = (job: Record<string, unknown>, twin = r.twinId, user = r.adminUser) =>
        h.appPool.connect().then(async (c) => {
          try {
            await c.query("BEGIN");
            await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [r.who.accountId, user]);
            return (await c.query("SELECT o_result FROM twin_seed_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [twin, job["job_id"], JSON.stringify({ job, key_id: "k1", signature: "x" }), job["issued_at"], job["expires_at"]])).rows[0];
          } finally {
            await c.query("ROLLBACK");
            c.release();
          }
        });
      const args = good.args;
      const forged: Record<string, Record<string, unknown>> = {
        "the job's repository is the public one": { ...good, repo_gh_id: r.publicGh },
        "the private side names the public repository": { ...good, args: { ...args, private: { owner: "acme", name: "widgets", gh_id: r.publicGh } } },
        "both sides name the public repository": { ...good, repo_gh_id: r.publicGh, args: { ...args, private: { owner: "acme", name: "widgets", gh_id: r.publicGh } } },
        "the public side is the twin": { ...good, args: { ...args, public: { owner: "acme", name: "widgets-private", gh_id: r.privateGh, default_branch: "main", head_sha: PUB_HEAD } } },
        "another machine": { ...good, runner_id: randomUUID() },
        "another setup": { ...good, setup_id: randomUUID() },
        "another twin": { ...good, args: { ...args, twin_id: randomUUID() } },
        "a microVM": { ...good, requires_engine: "microvm" },
        "another kind": { ...good, kind: "engine_update" },
        "a head that is not a commit": { ...good, args: { ...args, public: { ...args.public, head_sha: "main" } } },
      };
      for (const [what, job] of Object.entries(forged)) await expect(call(job), what).rejects.toMatchObject({ code: "42501" });
      expect(await call(good)).toEqual({ o_result: "ok" });
      // the same valid bytes, from a member: only the role can refuse them
      await expect(call(good, r.twinId, r.memberUser)).rejects.toMatchObject({ code: "42501" });
    });

    it("answers by the twin's state: only a seeding twin, or one that failed, is copied; a seeded one never again", async () => {
      for (const state of ["creating", "not_connected", "ready", "paused", "conflict", "refused", "removed"]) {
        const r = await rig({ state });
        expect(await failureOf(() => issue(r)), state).toMatchObject({ status: state === "removed" ? 404 : 409 });
        expect(await jobRows(r.setupId), state).toEqual([]);
      }
      const seeded = await rig();
      await h.admin.query("UPDATE repo_twins SET published_private_sha = $2 WHERE id = $1", [seeded.twinId, PUB_HEAD]);
      expect(await failureOf(() => issue(seeded))).toEqual({ status: 409, code: "twin_state" });
    });

    it("needs the twin's setup at the survey step and its placement on a live machine, and a public tip on GitHub", async () => {
      const noSetup = await rig({ setup: false });
      expect(await failureOf(() => issue(noSetup))).toEqual({ status: 409, code: "setup_not_found" });
      const unplaced = await rig({ placed: false });
      expect(await failureOf(() => issue(unplaced))).toEqual({ status: 409, code: "setup_not_placed" });
      const revoked = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked.runnerId]);
      expect(await failureOf(() => issue(revoked))).toEqual({ status: 409, code: "setup_not_placed" });
      const empty = await rig();
      expect(await failureOf(() => issue(empty, { deps: depsFor({ pullRequests: github({ "acme/widgets": null }) }) }))).toEqual({ status: 409, code: "default_branch_empty" });
      expect(await failureOf(() => issue(empty, { deps: depsFor({ pullRequests: github({}) }) }))).toEqual({ status: 503, code: "github_unavailable" });
      expect(await failureOf(() => issue(empty, { deps: depsFor({ engineCommandSigner: async () => null }) }))).toEqual({ status: 503, code: "not_configured" });
      for (const x of [noSetup, unplaced, revoked, empty]) expect(await jobRows(x.setupId)).toEqual([]);
    });

    it("is tenant-scoped: another account's person, and the admin client with a foreign account, find no such twin", async () => {
      const a = await rig();
      const b = await rig();
      expect(await failureOf(() => issueTwinSeed(depsFor(), principal(b), a.twinId))).toEqual({ status: 404, code: "not_found" });
      const direct = await h.appPool.connect();
      try {
        await direct.query("BEGIN");
        await direct.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [b.who.accountId, b.who.userId]);
        const out = await direct.query("SELECT o_result FROM twin_seed_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now() + interval '1 minute')", [a.twinId, randomUUID()]);
        expect(out.rows).toEqual([{ o_result: "not_found" }]);
        await direct.query("ROLLBACK");
      } finally {
        direct.release();
      }
      expect(await jobRows(a.setupId)).toEqual([]);
      // the same account's SECOND twin is a different twin: issuing for A touches nothing of B's
      await issue(a);
      expect(await jobRows(b.setupId)).toEqual([]);
      expect(await twinRow(b.twinId)).toMatchObject({ state: "seeding" });
    });

    it("issues again for a twin that failed (a new tip, a new job, the failure cleared) and not while a finished copy awaits its check", async () => {
      const r = await rig();
      const first = await started(r);
      await progress(r, first, { sub_step: "twin_fetch", state: "failed", failure_code: "twin_head_moved", failure_reason: "tip" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "failed", failure_code: "twin_head_moved", failure_reason: "tip" });
      const again = await issue(r);
      expect(again.attempt).toBe(2);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding", failure_code: null, failure_reason: null });
      expect((await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})))).status).toBe(200);
      await reportedToPush(r, again.job_id);
      expect((await token(r, again.job_id)).status).toBe(200);
      expect((await pushed(r, again.job_id)).status).toBe(200);
      // the copy is finished and only the check is missing: a second one would find the twin not empty
      expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "seed_live" });
    });
  });

  describe("the push-token route, generalised", () => {
    it("hands over one credential only after the fetch was reported and the push began, for the TWIN's repository, and never again", async () => {
      const r = await rig();
      const jobId = await started(r);
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "push_not_started" } } });
      await progress(r, jobId, { sub_step: "twin_fetch", state: "started" });
      await progress(r, jobId, { sub_step: "twin_fetch", state: "ok" });
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "push_not_started" } } });
      await progress(r, jobId, { sub_step: "push", state: "started" });
      minted.length = 0;
      const got = await token(r, jobId);
      expect(got.status).toBe(200);
      expect(got.headers?.["cache-control"]).toBe("no-store");
      expect(SetupPushTokenReply.parse(got.body).token).toBe(TOKEN);
      expect(minted).toEqual([{ id: r.privateId, owner: "acme", name: "widgets-private" }]);
      expect(minted.some((m) => m.id === r.publicId || m.name === "widgets")).toBe(false);
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "already_issued" } } });
      expect(minted).toHaveLength(1);
      for (const table of ["machine_jobs", "repo_twins", "project_setups", "audit_log"]) expect(JSON.stringify((await h.admin.query(`SELECT t.* FROM ${table} t`)).rows)).not.toContain(TOKEN);
    });

    it("refuses another machine's key, another job, another account's setup, and a twin that is no longer seeding", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      const other = await rig();
      const otherJob = await started(other);
      await reportedToPush(other, otherJob);
      expect((await token(r, jobId, { key: other.key })).status).toBe(404);
      expect((await token(r, randomUUID())).status).toBe(404);
      expect((await token(r, jobId, { setupId: other.setupId })).status).toBe(404);
      expect((await token(r, jobId, { setupId: randomUUID() })).status).toBe(404);
      await h.admin.query("UPDATE repo_twins SET state = 'paused' WHERE id = $1", [r.twinId]);
      expect((await token(r, jobId)).status).toBe(404);
      await h.admin.query("UPDATE repo_twins SET state = 'seeding' WHERE id = $1", [r.twinId]);
      expect((await token(r, jobId)).status).toBe(200);
    });

    it("mints for no repository but the twin's: a job whose targets are swapped (the public repository as its own) gets no credential", async () => {
      const r = await rig();
      const publicSetup = randomUUID();
      await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, $3, 'existing', $4, 'survey')", [publicSetup, r.who.accountId, r.publicId, r.who.userId]);
      // forged past the issuer: the job's repository is the PUBLIC one and the sides are swapped; the runner has taken it and reported far enough
      const forged = await issueTestJob(h.appPool, h.admin, {
        accountId: r.who.accountId, userId: r.who.userId, runnerId: r.runnerId, repoId: r.publicId, setupId: publicSetup, kind: "twin_seed",
        args: { twin_id: r.twinId, public: { owner: "acme", name: "widgets-private", gh_id: r.privateGh, default_branch: "main", head_sha: PUB_HEAD }, private: { owner: "acme", name: "widgets", gh_id: r.publicGh } },
      });
      await h.admin.query("UPDATE machine_jobs SET state = 'delivered', delivered_at = now(), last_seq = 5, last_progress_at = now() WHERE id = $1", [forged.id]);
      minted.length = 0;
      expect((await token(r, forged.id, { setupId: publicSetup })).status).toBe(404);
      expect(minted).toEqual([]);
      expect(await jobRows(publicSetup)).toHaveLength(1);
      expect((await h.admin.query("SELECT push_token_at FROM machine_jobs WHERE id = $1", [forged.id])).rows[0].push_token_at).toBeNull();
    });

    it("maps a mint that cannot be made to a fixed status, as the install's does", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect(await token(r, jobId, { deps: depsFor({ setupPush: port({ fail: Object.assign(new Error("x"), { code: "app_not_installed" }) }) }) })).toMatchObject({ status: 409, body: { error: { code: "app_not_installed" } } });
    });
  });

  describe("the reports", () => {
    it("a failed step ends the job and fails the twin with the seed's own code; the setup is untouched", async () => {
      for (const code of ["twin_head_moved", "twin_too_large", "twin_not_empty", "twin_fetch_failed", "push_failed"]) {
        const r = await rig();
        const jobId = await started(r);
        expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "failed", failure_code: code, failure_reason: "tip" })).status).toBe(200);
        expect(await twinRow(r.twinId), code).toMatchObject({ state: "failed", failure_code: code, failure_reason: "tip" });
        expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "failed" });
        expect(await setupRow(r.setupId)).toMatchObject({ phase: "survey", state: "started", failure_code: null });
        expect((await progress(r, jobId, { sub_step: "push", state: "started" })).status).toBe(404);
      }
    });

    it("refuses a failure code that is not the seed's (an install code, an engine code, a topic), and a step order that does not climb", async () => {
      const r = await rig();
      const jobId = await started(r);
      for (const code of ["bundle_refused", "engine_checksum", "missing_topic:interview", "direct_raced"]) expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "failed", failure_code: code })).status, code).toBe(400);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding", failure_code: null });
      expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "started" })).status).toBe(200);
      const stale = await respond(() => setupProgressRun(depsFor(), signed(r.key, setupProgressPath(r.setupId), { job_id: jobId, seq: 0, sub_step: "twin_fetch", state: "ok" }), r.setupId));
      expect(stale).toMatchObject({ status: 409, body: { error: { code: "seq_not_increasing" } } });
    });

    it("a kind the runner cannot run is a failure of the twin too (kind_unsupported), not of the setup", async () => {
      const r = await rig();
      const jobId = await started(r);
      expect((await progress(r, jobId, { sub_step: "engine_fetch", state: "failed", failure_code: "kind_unsupported" })).status).toBe(200);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "failed", failure_code: "kind_unsupported" });
      expect(await setupRow(r.setupId)).toMatchObject({ state: "started", failure_code: null });
    });

    it("the push ok carries the commit the job signed, once the credential was handed out, and then the job is done", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      // no credential yet: the head is refused and its report undone
      expect(await pushed(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "head_not_recorded" } } });
      expect((await token(r, jobId)).status).toBe(200);
      expect((await progress(r, jobId, { sub_step: "push", state: "ok" })).status).toBe(400);
      expect(await pushed(r, jobId, "d".repeat(40))).toMatchObject({ status: 409, body: { error: { code: "head_not_recorded" } } });
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "delivered" });
      expect((await pushed(r, jobId)).status).toBe(200);
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "done" });
      // the twin waits for the cloud's check; the report alone never makes it ready
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding", published_private_sha: null });
      expect(await progress(r, jobId, { sub_step: "push", state: "started" })).toMatchObject({ status: 409 });
    });
  });

  describe("the cloud's check", () => {
    const finished = async (r: Rig): Promise<string> => {
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect((await token(r, jobId)).status).toBe(200);
      expect((await pushed(r, jobId)).status).toBe(200);
      return jobId;
    };
    const check = (r: Rig, heads: Record<string, string | null>, asked: string[] = [], who: { accountId: string; userId: string | null } = principal(r)) =>
      checkTwinSeed(depsFor({ pullRequests: github(heads, asked) }), who, r.twinId);

    it("makes the twin ready, both anchors at the signed head, when the twin's tip is that commit", async () => {
      const r = await rig();
      await finished(r);
      expect(await check(r, { "acme/widgets-private": PUB_HEAD })).toBe("ready");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", published_private_sha: PUB_HEAD, synced_public_sha: PUB_HEAD, failure_code: null });
      expect(await check(r, { "acme/widgets-private": PUB_HEAD })).toBe("not_ready");
    });

    it("makes nothing ready for a copy that has not finished, whatever tip it is given", async () => {
      const r = await rig();
      const jobId = await started(r);
      const direct = async () => {
        const c = await h.appPool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.account_id', $1, true)", [r.who.accountId]);
          const out = (await c.query("SELECT o_result FROM twin_seed_check($1::uuid, $2)", [r.twinId, PUB_HEAD])).rows[0].o_result;
          await c.query("ROLLBACK");
          return out;
        } finally {
          c.release();
        }
      };
      expect(await direct()).toBe("not_ready");
      await reportedToPush(r, jobId);
      expect(await direct()).toBe("not_ready");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding", published_private_sha: null });
    });

    it("works for the tick's own session, which has no person", async () => {
      const r = await rig();
      await finished(r);
      expect(await check(r, { "acme/widgets-private": PUB_HEAD }, [], { accountId: r.who.accountId, userId: null })).toBe("ready");
    });

    it("fails the twin when its tip is another commit or it has none, and the seed is then issued again", async () => {
      const moved = await rig();
      await finished(moved);
      expect(await check(moved, { "acme/widgets-private": "e".repeat(40) })).toBe("failed");
      expect(await twinRow(moved.twinId)).toMatchObject({ state: "failed", failure_code: "twin_head_moved", published_private_sha: null, synced_public_sha: null });
      const none = await rig();
      await finished(none);
      expect(await check(none, { "acme/widgets-private": null })).toBe("failed");
      expect(await twinRow(none.twinId)).toMatchObject({ state: "failed", failure_code: "push_failed" });
      expect((await issue(none)).attempt).toBe(2);
    });

    it("asks GitHub about no twin whose copy has not finished, and leaves a twin alone when GitHub cannot be asked", async () => {
      const waiting = await rig();
      const asked: string[] = [];
      expect(await check(waiting, { "acme/widgets-private": PUB_HEAD }, asked)).toBe("not_ready");
      await started(waiting);
      expect(await check(waiting, { "acme/widgets-private": PUB_HEAD }, asked)).toBe("not_ready");
      expect(asked).toEqual([]);
      const r = await rig();
      await finished(r);
      expect(await check(r, {})).toBe("github_unavailable");
      expect(await checkTwinSeed({ appUserPool: h.appPool, pullRequests: null }, principal(r), r.twinId)).toBe("github_unavailable");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding" });
    });

    it("is tenant-scoped and person-scoped: another account sees no twin, a member is refused, and a second twin of the same account is left alone", async () => {
      const a = await rig();
      await finished(a);
      const other = await rig();
      const asked: string[] = [];
      expect(await checkTwinSeed(depsFor({ pullRequests: github({ "acme/widgets-private": PUB_HEAD }, asked) }), principal(other), a.twinId)).toBe("not_ready");
      expect(asked).toEqual([]);
      await expect(checkTwinSeed(depsFor({ pullRequests: github({ "acme/widgets-private": PUB_HEAD }) }), principal(a, a.memberUser), a.twinId)).rejects.toMatchObject({ code: "42501" });
      const direct = await h.appPool.connect();
      try {
        await direct.query("BEGIN");
        await direct.query("SELECT set_config('app.account_id', $1, true)", [other.who.accountId]);
        expect((await direct.query("SELECT o_result FROM twin_seed_check($1::uuid, $2)", [a.twinId, PUB_HEAD])).rows).toEqual([{ o_result: "not_found" }]);
        await direct.query("ROLLBACK");
      } finally {
        direct.release();
      }
      expect(await twinRow(a.twinId)).toMatchObject({ state: "seeding" });
      // the same account's second twin, finished too: checking one never moves the other
      const second = await rig();
      await finished(second);
      expect(await check(second, { "acme/widgets-private": PUB_HEAD })).toBe("ready");
      expect(await twinRow(a.twinId)).toMatchObject({ state: "seeding", published_private_sha: null });
    });
  });

  describe("a job that went quiet", () => {
    it("fails the twin with the cloud's own code, never the twin's setup; an install job's expiry still fails its setup", async () => {
      const r = await rig();
      // signed 40 minutes ago, so its 30 minutes are over before anyone takes it
      await issueTwinSeed(depsFor({ now: () => new Date(Date.now() - 40 * 60_000) }), principal(r), r.twinId);
      await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(await twinRow(r.twinId)).toMatchObject({ state: "failed", failure_code: "job_expired" });
      expect(await setupRow(r.setupId)).toMatchObject({ phase: "survey", state: "started", failure_code: null });
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "expired" });
      // 1093's rule for every other kind is untouched
      const s = await rig();
      await issueTestJob(h.appPool, h.admin, { accountId: s.who.accountId, userId: s.who.userId, runnerId: s.runnerId, repoId: s.privateId, setupId: s.setupId, lifeS: 60, issuedAgoS: 600 });
      await respond(() => machineJobClaimRun(h.deps(), signed(s.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(await setupRow(s.setupId)).toMatchObject({ state: "failed", failure_code: "job_expired" });
      expect(await twinRow(s.twinId)).toMatchObject({ state: "seeding" });
    });
  });

  describe("who may run what", () => {
    it("the functions are owned by machine_jobs_owner and executable by app_user alone (the helper by nobody), and the twin's table stays unwritable by app_user", async () => {
      const { rows } = await h.admin.query<{ name: string; owner: string; grantees: string[] }>(
        `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.proname LIKE 'twin_seed_%' ORDER BY 1`,
      );
      expect(rows.map((x) => x.name)).toEqual(["twin_seed_check", "twin_seed_head_record", "twin_seed_issue", "twin_seed_job_lock", "twin_seed_progress_record", "twin_seed_push_grant"]);
      for (const row of rows) {
        expect(row.owner, row.name).toBe("machine_jobs_owner");
        expect(row.grantees, row.name).toEqual(row.name === "twin_seed_job_lock" ? [] : ["app_user"]);
      }
      const r = await rig();
      const probe = await h.appPool.connect();
      try {
        await probe.query("BEGIN");
        await probe.query("SELECT set_config('app.account_id', $1, true)", [r.who.accountId]);
        await expect(probe.query("UPDATE repo_twins SET state = 'ready' WHERE id = $1", [r.twinId])).rejects.toMatchObject({ code: "42501" });
        await probe.query("ROLLBACK");
        await probe.query("BEGIN");
        await expect(probe.query("SELECT * FROM twin_seed_job_lock($1::uuid, $2::uuid)", [r.setupId, randomUUID()])).rejects.toMatchObject({ code: "42501" });
        await probe.query("ROLLBACK");
      } finally {
        probe.release();
      }
    });
  });

  /** FU-311 (migration 1116): what the visibility port answers for each repository of the rig; any repository not listed reads as unknown. */
  const seeing = (r: Rig, priv: "private" | "public" | "unknown", pub: "private" | "public" | "unknown" = "public"): Partial<RunnerCloudDeps> => ({ repoVisibility: async (_accountId: string, repoId: string) => (repoId === r.privateId ? priv : repoId === r.publicId ? pub : "unknown") });
  const noteOf = async (id: string) => (await h.admin.query<{ note: string | null }>("SELECT note FROM repo_twins WHERE id = $1", [id])).rows[0]!.note;

  describe("the private repository must stay private (FU-311)", () => {
    it("issues nothing for a twin whose private repository is public: the twin is refused twin_not_private, and no job is written", async () => {
      const r = await rig();
      expect(await failureOf(() => issue(r, { deps: depsFor(seeing(r, "public")) }))).toEqual({ status: 409, code: "twin_not_private" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "twin_not_private" });
      expect(await jobRows(r.setupId)).toHaveLength(0);
    });

    it("fails closed on a visibility that cannot be read: nothing is issued and the twin is left as it was", async () => {
      const r = await rig();
      for (const priv of ["unknown", "throws"] as const) {
        const deps = depsFor(priv === "throws" ? { repoVisibility: async () => { throw new Error("boom"); } } : seeing(r, "unknown"));
        expect(await failureOf(() => issue(r, { deps })), priv).toEqual({ status: 409, code: "repo_visibility_unknown" });
      }
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding", failure_code: null });
      expect(await jobRows(r.setupId)).toHaveLength(0);
    });

    it("a public repository that turned private is a note, not a refusal: the copy is issued, and the note clears when it is public again", async () => {
      const r = await rig();
      expect((await issue(r, { deps: depsFor(seeing(r, "private", "private")) })).attempt).toBe(1);
      expect(await noteOf(r.twinId)).toBe("public_repo_private");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "seeding", failure_code: null });
      expect(await failureOf(() => issue(r, { deps: depsFor(seeing(r, "private", "public")) }))).toEqual({ status: 409, code: "seed_live" });
      expect(await noteOf(r.twinId)).toBeNull();
    });

    it("the check finishes nothing for a twin whose private repository is public (refused, GitHub not asked), and waits when it cannot be read", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect((await token(r, jobId)).status).toBe(200);
      expect((await pushed(r, jobId)).status).toBe(200);
      const asked: string[] = [];
      const gh = github({ "acme/widgets-private": PUB_HEAD }, asked);
      expect(await checkTwinSeed(depsFor({ pullRequests: gh, ...seeing(r, "unknown") }), principal(r), r.twinId)).toBe("github_unavailable");
      expect(await checkTwinSeed(depsFor({ pullRequests: gh, ...seeing(r, "public") }), principal(r), r.twinId)).toBe("refused");
      expect(asked).toEqual([]);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "twin_not_private", published_private_sha: null, synced_public_sha: null });
    });
  });
});
