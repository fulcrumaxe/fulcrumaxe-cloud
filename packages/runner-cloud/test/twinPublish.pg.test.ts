import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, MachineJobClaimReply, SetupPushTokenReply, setupProgressPath, setupPushTokenPath, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import {
  HELLO_PATH, RunnerHttpError, RunPullRequestError, TWIN_PUBLISH_CLOSE_COMMENT, checkTwinPublish, closeTwinPublishPr, issueTwinPublish, machineJobClaimRun, runnerHello, setupProgressRun, setupPushTokenRun,
  type PlanePushHostedPort, type RunnerCloudDeps, type RunPullRequestPort,
} from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { issueTestJob } from "./helpers/machineJobIssuer.js";

const TOKEN = "ghs_sentinel_twin_publish_token_0123456789";
const BASE = "a".repeat(40);
const PUB_TIP = "b".repeat(40);
const PRIV_HEAD = "c".repeat(40);
const PUSHED = "e".repeat(40);
const BRANCH = `fx/publish-${PRIV_HEAD.slice(0, 12)}`;

/**
 * [pg] D#845 ON-27c2 (migration 1110): the twin publish's cloud side, over the real signed HTTP path, real Ed25519 job signatures, the real SECURITY DEFINER functions as the runner and the app login, and row security forced.
 * GitHub is a fake that enforces what the real port does for these calls (one repository per token, fixed shapes of answer). What it cannot show: GitHub's own rate limits and permission model, and the push itself (the runner's test).
 */
describe("twin publish [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const seedMints: Array<{ id: string; owner: string; name: string }> = [];
  const setupPort = () => ({
    async mint(repo: { id: string; owner: string; name: string }) {
      seedMints.push(repo);
      return { token: "ghs_the_wrong_kind_of_token_for_a_publish", expiresAt: new Date(Date.now() + 3600_000) };
    },
    async revoke() {},
  });
  const calls = { mints: [] as Array<{ codeRepo: string; accountId: string }>, verifies: [] as unknown[], finds: [] as unknown[], closes: [] as Array<{ codeRepo: string; number: number; branch: string; comment: string }>, revokes: [] as string[] };
  /** The hosted public-push port, held to what the real one does: a token is for one repository, and a read checks the exact branch, head and parent. */
  const hosted = (o: { mintFail?: unknown; pushedOk?: boolean; pr?: number | null; throws?: unknown; noFind?: boolean; closeResult?: { result: "closed"; commented: boolean } | { result: "not_open" } | { result: "not_ours" } } = {}): PlanePushHostedPort =>
    ({
      async mintToken(codeRepo: string, accountId: string) {
        if (o.mintFail !== undefined) throw o.mintFail;
        calls.mints.push({ codeRepo, accountId });
        return { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) };
      },
      async verifyPushed(i: unknown) {
        calls.verifies.push(i);
        if (o.throws !== undefined) throw o.throws;
        return o.pushedOk !== false;
      },
      async verifyPullRequest() {
        return null;
      },
      ...(o.noFind === true
        ? {}
        : {
            async findOpenPullRequest(i: unknown) {
              calls.finds.push(i);
              return o.pr === null ? null : { number: o.pr ?? 7, url: `https://github.com/acme/widgets/pull/${o.pr ?? 7}` };
            },
          }),
      async closeRefusedPullRequest(i: { codeRepo: string; number: number; branch: string; comment: string }) {
        calls.closes.push(i);
        if (o.throws !== undefined) throw o.throws;
        return o.closeResult ?? { result: "closed", commented: true };
      },
      async revokeToken(t: string) {
        calls.revokes.push(t);
        return true;
      },
    }) as unknown as PlanePushHostedPort;
  /** `heads` maps a repository's owner/name to the tip of its branch (null: no commit); a name that is not listed fails like GitHub's 404. `asked` records `owner/name@branch`. */
  const github = (heads: Record<string, string | null>, asked: string[] = [], defaults: Record<string, string> = {}): RunPullRequestPort =>
    ({
      defaultBranch: async (repo: { owner: string; name: string }) => defaults[`${repo.owner}/${repo.name}`] ?? (repo.name.endsWith("-private") ? "trunk" : "main"),
      branchState: async ({ repo, branch }: { repo: { owner: string; name: string }; branch: string }) => {
        asked.push(`${repo.owner}/${repo.name}@${branch}`);
        const head = heads[`${repo.owner}/${repo.name}`];
        if (head === undefined) throw new RunPullRequestError("unavailable", 404);
        return { exists: head !== null, headOid: head, aheadBy: 0, defaultBranch: branch };
      },
    }) as unknown as RunPullRequestPort;
  const TIPS = { "acme/widgets-private": PRIV_HEAD, "acme/widgets": PUB_TIP };
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({ repoVisibility: async () => "private", setupPush: setupPort(), planePush: hosted(), pullRequests: github(TIPS), engineCommandSigner: async () => ({ keyId: "k1", signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", jobKeys.privateKey) }) as never, ...over });

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
  /** A fresh account with a public repo, a READY private twin (published up to BASE), the twin's setup, a machine that lists twin_v1 and the twin placed on it. */
  async function rig(o: { caps?: string[]; placed?: boolean; setup?: boolean; state?: string; published?: string | null; pr?: number } = {}): Promise<Rig> {
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
    if (o.setup !== false) await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, $3, 'existing', $4, 'done')", [setupId, who.accountId, privateId, who.userId]);
    const twinId = randomUUID();
    const published = o.published === undefined ? BASE : o.published;
    await h.admin.query(
      `INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state, removed_at, published_private_sha, synced_public_sha, publish_pr, overlay_globs, install_paths)
       VALUES ($1, $2, $3, $4, 'widgets-private', $5, $6, $7, CASE WHEN $7 = 'removed' THEN now() END, $8, $8, $9, ARRAY['docs/plan/**'], ARRAY['.github/workflows/engine.yml'])`,
      [twinId, who.accountId, who.repoId, privateId, privateGh, who.userId, o.state ?? "ready", published, o.pr ?? null],
    );
    return { who, key, runnerId, publicId: who.repoId, privateId, publicGh, privateGh, twinId, setupId, adminUser: await addUser(who.accountId, "admin"), memberUser: await addUser(who.accountId, "member") };
  }
  const principal = (r: Rig, userId: string | null = r.adminUser) => ({ accountId: r.who.accountId, userId });
  const issue = (r: Rig, o: { as?: string | null; deps?: RunnerCloudDeps; twin?: string } = {}) => issueTwinPublish(o.deps ?? depsFor(), principal(r, o.as === undefined ? r.adminUser : o.as), o.twin ?? r.twinId);
  const failureOf = async (run: () => Promise<unknown>): Promise<{ status: number; code: string } | null> => {
    try {
      await run();
      return null;
    } catch (error) {
      if (error instanceof RunnerHttpError) return { status: error.status, code: error.code };
      throw error;
    }
  };
  const twinRow = async (id: string) => (await h.admin.query("SELECT state, failure_code, failure_reason, published_private_sha, publish_pr, publish_head FROM repo_twins WHERE id = $1", [id])).rows[0];
  const setupRow = async (id: string) => (await h.admin.query("SELECT phase, state, failure_code FROM project_setups WHERE id = $1", [id])).rows[0];
  const jobRows = async (setupId: string) => (await h.admin.query<{ id: string; state: string; attempt: number; kind: string; repo_id: string; push_token_at: string | null; failure_code: string | null; job: { job: MachineJob } }>("SELECT id, state, attempt, kind, repo_id, push_token_at, failure_code, job FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt", [setupId])).rows;
  const issued = async (r: Rig): Promise<string> => {
    const out = await issue(r);
    if (out.outcome !== "issued") throw new Error("nothing was issued");
    return out.job_id;
  };
  /** Issues the publish and has the runner take it. */
  async function started(r: Rig): Promise<string> {
    const jobId = await issued(r);
    const taken = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
    expect(taken.status).toBe(200);
    expect(MachineJobClaimReply.parse(taken.body)).toHaveProperty("signed_job");
    return jobId;
  }
  const seqs = new Map<string, number>();
  const progress = (r: Rig, jobId: string, body: Record<string, unknown>, deps: RunnerCloudDeps = depsFor()) => {
    const seq = seqs.get(jobId) ?? 0;
    seqs.set(jobId, seq + 1);
    return respond(() => setupProgressRun(deps, signed(r.key, setupProgressPath(r.setupId), { job_id: jobId, seq, ...body }), r.setupId));
  };
  const reportedToPush = async (r: Rig, jobId: string) => {
    for (const b of [{ sub_step: "twin_fetch", state: "started" }, { sub_step: "twin_fetch", state: "ok" }, { sub_step: "push", state: "started" }]) expect((await progress(r, jobId, b)).status).toBe(200);
  };
  const token = (r: Rig, jobId: string, o: { setupId?: string; key?: TestKey; deps?: RunnerCloudDeps } = {}) => {
    const setupId = o.setupId ?? r.setupId;
    return respond(() => setupPushTokenRun(o.deps ?? depsFor(), signed(o.key ?? r.key, setupPushTokenPath(setupId), { job_id: jobId }), setupId));
  };
  const pushed = (r: Rig, jobId: string, head = PUSHED) => progress(r, jobId, { sub_step: "push", state: "ok", head_sha: head });
  /** The whole of a good publish, as the runner reports it. */
  async function finished(r: Rig): Promise<string> {
    const jobId = await started(r);
    await reportedToPush(r, jobId);
    expect((await token(r, jobId)).status).toBe(200);
    expect((await pushed(r, jobId)).status).toBe(200);
    expect((await progress(r, jobId, { sub_step: "pr_open", state: "ok" })).status).toBe(200);
    return jobId;
  }
  /** The webhook's call, in the session the webhook has: the account, no person, no runner. */
  async function prClosed(r: Rig, o: { repo?: string; pr?: number; merged?: boolean; ref?: string; account?: string; sha?: string | null } = {}): Promise<string> {
    const c = await h.appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.account_id', $1, true)", [o.account ?? r.who.accountId]);
      const out = (await c.query("SELECT twin_publish_pr_closed($1::uuid, $2::int, $3::boolean, $4, $5) AS r", [o.repo ?? r.publicId, o.pr ?? 7, o.merged ?? true, o.ref ?? BRANCH, o.sha === undefined ? PUSHED : o.sha])).rows[0].r as string;
      await c.query("COMMIT");
      return out;
    } finally {
      c.release();
    }
  }

  /** A second twin of the SAME account (its own public and private repositories, setup and machine), made ready and finished through the same steps. Its rows must never answer for the first's. */
  async function sibling(r: Rig): Promise<Rig> {
    const publicId = randomUUID();
    const privateId = randomUUID();
    const publicGh = r.publicGh + 100;
    const privateGh = r.publicGh + 101;
    for (const [id, gh, name] of [[publicId, publicGh, "gadgets"], [privateId, privateGh, "gadgets-private"]] as const) {
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', $5)", [id, r.who.accountId, r.who.installationId, gh, name]);
    }
    // a machine hosts one project, so the second twin has a machine of its own, in the same account
    const key = newKey();
    const runnerId = await registerKey(h.admin, r.who.accountId, r.who.userId, key);
    const hello = await respond(() =>
      runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1", "twin_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })),
    );
    expect(hello.status).toBe(200);
    await h.admin.query("INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [r.who.accountId, privateId, runnerId]);
    const setupId = randomUUID();
    await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, $3, 'existing', $4, 'done')", [setupId, r.who.accountId, privateId, r.who.userId]);
    const twinId = randomUUID();
    await h.admin.query(
      `INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state, published_private_sha, synced_public_sha, overlay_globs, install_paths)
       VALUES ($1, $2, $3, $4, 'gadgets-private', $5, $6, 'ready', $7, $7, ARRAY['docs/plan/**'], ARRAY['.github/workflows/engine.yml'])`,
      [twinId, r.who.accountId, publicId, privateId, privateGh, r.who.userId, BASE],
    );
    return { ...r, key, runnerId, publicId, privateId, publicGh, privateGh, twinId, setupId };
  }

  describe("the kind, the size of a signed job and the capability", () => {
    it("the kind CHECK takes twin_publish, keeps every kind that came before, and the signed job may be 256 KiB", async () => {
      const def = (await h.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'machine_jobs_kind_check'")).rows[0].def as string;
      for (const kind of ["project_setup", "engine_update", "engine_session_start", "engine_session_stop", "engine_session_delete", "project_remove", "twin_seed", "twin_publish"]) expect(def, kind).toContain(`'${kind}'`);
      expect((await h.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'machine_jobs_job_check'")).rows[0].def).toContain("262144");
    });

    it("a runner is offered the publish only when its latest hello lists twin_v1, and takes the job exactly as signed", async () => {
      const old = await rig({ caps: ["project_setup_v1"] });
      await issue(old);
      const idle = await respond(() => machineJobClaimRun(h.deps(), signed(old.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(MachineJobClaimReply.parse(idle.body)).toHaveProperty("retry_after");
      expect((await jobRows(old.setupId))[0]).toMatchObject({ state: "issued" });
      const hello = await respond(() => runnerHello(h.deps(), signed(old.key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1", "twin_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
      expect(hello.status).toBe(200);
      const taken = MachineJobClaimReply.parse((await respond(() => machineJobClaimRun(h.deps(), signed(old.key, MACHINE_JOB_CLAIM_PATH, {})))).body);
      const job = verifyMachineJob((taken as { signed_job: unknown }).signed_job, { k1: jobKeys.publicKey }, old.runnerId);
      expect(job).toMatchObject({
        kind: "twin_publish", repo_gh_id: old.privateGh, setup_id: old.setupId, requires_engine: "any",
        args: {
          twin_id: old.twinId, public: { owner: "acme", name: "widgets", gh_id: old.publicGh, tip: PUB_TIP }, private: { owner: "acme", name: "widgets-private", gh_id: old.privateGh, base: BASE, head: PRIV_HEAD }, branch: BRANCH,
          private_set: { overlay_globs: ["docs/plan/**"], install_paths: [".github/workflows/engine.yml"], blob_globs: [], identifier_rules_path: null, plan_data_rules_path: null },
        },
      });
    });
  });

  describe("the issue", () => {
    it("signs one job homed on the twin, with the last published commit as its base, the public main as its tip and the live private set; the twin stays ready", async () => {
      const r = await rig();
      const asked: string[] = [];
      const out = await issue(r, { deps: depsFor({ pullRequests: github(TIPS, asked) }) });
      expect(out).toMatchObject({ outcome: "issued", attempt: 1 });
      const [row] = await jobRows(r.setupId);
      expect(row).toMatchObject({ kind: "twin_publish", state: "issued", attempt: 1, repo_id: r.privateId });
      expect(row!.job.job).toMatchObject({ repo_gh_id: r.privateGh, setup_id: r.setupId, runner_id: r.runnerId, args: { branch: BRANCH } });
      // metadata only: one ref of each repository, the private default branch as GitHub names it and the public `main`
      expect(asked.sort()).toEqual(["acme/widgets-private@trunk", "acme/widgets@main"]);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", published_private_sha: BASE, publish_pr: null, publish_head: null });
      expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "publish_live" });
      expect(await jobRows(r.setupId)).toHaveLength(1);
    });

    it("signs nothing when the private tip is the last published commit", async () => {
      const r = await rig();
      expect(await issue(r, { deps: depsFor({ pullRequests: github({ "acme/widgets-private": BASE, "acme/widgets": PUB_TIP }) }) })).toEqual({ outcome: "in_sync" });
      expect(await jobRows(r.setupId)).toEqual([]);
    });

    it("is for an owner or admin, or the tick's session (no person): a member is 403, and no row is written", async () => {
      const r = await rig();
      expect(await failureOf(() => issue(r, { as: r.memberUser }))).toEqual({ status: 403, code: "forbidden" });
      expect(await jobRows(r.setupId)).toEqual([]);
      expect(await issue(r, { as: null })).toMatchObject({ outcome: "issued" });
    });

    it("holds the signed bytes to the rows: the definer refuses a job that is not exactly this twin's publish, in any of its places", async () => {
      const r = await rig();
      const good: Record<string, unknown> = {
        v: 1, job_id: randomUUID(), runner_id: r.runnerId, repo_gh_id: r.privateGh, setup_id: r.setupId, requires_engine: "any", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), kind: "twin_publish",
        args: {
          twin_id: r.twinId, public: { owner: "acme", name: "widgets", gh_id: r.publicGh, tip: PUB_TIP }, private: { owner: "acme", name: "widgets-private", gh_id: r.privateGh, base: BASE, head: PRIV_HEAD }, branch: BRANCH,
          private_set: { overlay_globs: ["docs/plan/**"], install_paths: [".github/workflows/engine.yml"], blob_globs: [], identifier_rules_path: null, plan_data_rules_path: null },
        },
      };
      const call = (job: Record<string, unknown>, user: string | null = r.adminUser, runnerSession?: string) =>
        h.appPool.connect().then(async (c) => {
          try {
            await c.query("BEGIN");
            await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [r.who.accountId, user ?? ""]);
            if (runnerSession !== undefined) await c.query("SELECT set_config('app.runner_id', $1, true)", [runnerSession]);
            return (await c.query("SELECT o_result FROM twin_publish_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [r.twinId, job["job_id"], JSON.stringify({ job, key_id: "k1", signature: "x" }), job["issued_at"], job["expires_at"]])).rows[0];
          } finally {
            await c.query("ROLLBACK");
            c.release();
          }
        });
      const args = good["args"] as { public: Record<string, unknown>; private: Record<string, unknown>; private_set: Record<string, unknown> };
      const forged: Record<string, Record<string, unknown>> = {
        "the job's home is the public repository": { ...good, repo_gh_id: r.publicGh },
        "the private side names the public repository": { ...good, args: { ...args, private: { ...args.private, owner: "acme", name: "widgets", gh_id: r.publicGh } } },
        "both sides name the public repository": { ...good, repo_gh_id: r.publicGh, args: { ...args, private: { ...args.private, name: "widgets", gh_id: r.publicGh } } },
        "the public side is the twin": { ...good, args: { ...args, public: { ...args.public, name: "widgets-private", gh_id: r.privateGh } } },
        "another machine": { ...good, runner_id: randomUUID() },
        "another setup": { ...good, setup_id: randomUUID() },
        "another twin": { ...good, args: { ...args, twin_id: randomUUID() } },
        "a microVM": { ...good, requires_engine: "microvm" },
        "another kind": { ...good, kind: "twin_seed" },
        "a base that is not the last published commit": { ...good, args: { ...args, private: { ...args.private, base: "d".repeat(40) } } },
        "a head equal to the base": { ...good, args: { ...args, private: { ...args.private, head: BASE }, branch: `fx/publish-${BASE.slice(0, 12)}` } },
        "a branch that is not named from the head": { ...good, args: { ...args, branch: "fx/publish-000000000000" } },
        "a tip that is not a commit": { ...good, args: { ...args, public: { ...args.public, tip: "main" } } },
        "a glob more than the live set has": { ...good, args: { ...args, private_set: { ...args.private_set, overlay_globs: ["docs/plan/**", "src/**"] } } },
        "a glob fewer than the live set has": { ...good, args: { ...args, private_set: { ...args.private_set, overlay_globs: [] } } },
        "an install path that is not the live one": { ...good, args: { ...args, private_set: { ...args.private_set, install_paths: [".github/workflows/other.yml"] } } },
        "a rule file the twin does not declare": { ...good, args: { ...args, private_set: { ...args.private_set, identifier_rules_path: ".autonomous-team/ids.txt" } } },
        "a binary allow list the twin does not have": { ...good, args: { ...args, private_set: { ...args.private_set, blob_globs: ["assets/**"] } } },
      };
      for (const [what, job] of Object.entries(forged)) await expect(call(job), what).rejects.toMatchObject({ code: "42501" });
      expect(await call(good)).toEqual({ o_result: "ok" });
      // the same valid bytes, from a member or from a runner's session: only the caller can refuse them
      await expect(call(good, r.memberUser)).rejects.toMatchObject({ code: "42501" });
      await expect(call(good, null, r.runnerId)).rejects.toMatchObject({ code: "42501" });
    });

    it("answers by the twin's state: only a ready, seeded twin with no publish pull request is published", async () => {
      for (const state of ["creating", "not_connected", "seeding", "paused", "conflict", "refused", "failed", "removed"]) {
        const r = await rig({ state });
        expect(await failureOf(() => issue(r)), state).toMatchObject({ status: state === "removed" ? 404 : 409 });
        expect(await jobRows(r.setupId), state).toEqual([]);
      }
      const unseeded = await rig({ published: null });
      expect(await failureOf(() => issue(unseeded))).toEqual({ status: 409, code: "twin_state" });
      const open = await rig({ pr: 7 });
      expect(await failureOf(() => issue(open))).toEqual({ status: 409, code: "publish_open" });
      expect(await jobRows(open.setupId)).toEqual([]);
    });

    it("needs the twin's setup, its placement on a live machine and both tips on GitHub", async () => {
      const noSetup = await rig({ setup: false });
      expect(await failureOf(() => issue(noSetup))).toEqual({ status: 409, code: "setup_not_found" });
      const unplaced = await rig({ placed: false });
      expect(await failureOf(() => issue(unplaced))).toEqual({ status: 409, code: "setup_not_placed" });
      const revoked = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked.runnerId]);
      expect(await failureOf(() => issue(revoked))).toEqual({ status: 409, code: "setup_not_placed" });
      const empty = await rig();
      expect(await failureOf(() => issue(empty, { deps: depsFor({ pullRequests: github({ ...TIPS, "acme/widgets": null }) }) }))).toEqual({ status: 409, code: "default_branch_empty" });
      expect(await failureOf(() => issue(empty, { deps: depsFor({ pullRequests: github({ ...TIPS, "acme/widgets-private": null }) }) }))).toEqual({ status: 409, code: "default_branch_empty" });
      expect(await failureOf(() => issue(empty, { deps: depsFor({ pullRequests: github({}) }) }))).toEqual({ status: 503, code: "github_unavailable" });
      expect(await failureOf(() => issue(empty, { deps: depsFor({ engineCommandSigner: async () => null }) }))).toEqual({ status: 503, code: "not_configured" });
      for (const x of [noSetup, unplaced, revoked, empty]) expect(await jobRows(x.setupId)).toEqual([]);
    });

    it("publishes only to a public repository whose default branch is main, and issues and mints nothing otherwise", async () => {
      const r = await rig();
      const mintsBefore = calls.mints.length;
      // the public repository's default is something else; a stale, non-default `main` exists too (the fake answers any branch name with the listed tip)
      const asked: string[] = [];
      const other = depsFor({ pullRequests: github(TIPS, asked, { "acme/widgets": "develop" }) });
      expect(await failureOf(() => issue(r, { deps: other }))).toEqual({ status: 409, code: "public_default_branch_not_main" });
      expect(asked).not.toContain("acme/widgets@main");
      expect(await jobRows(r.setupId)).toEqual([]);
      expect(calls.mints.length).toBe(mintsBefore);
      // when the default is main, the same twin is issued
      const ok = await issue(r, { deps: depsFor({ pullRequests: github(TIPS, [], { "acme/widgets": "main" }) }) });
      expect(ok.outcome).toBe("issued");
    });

    it("refuses a private set too large to sign", async () => {
      const r = await rig();
      await h.admin.query("UPDATE repo_twins SET install_paths = ARRAY(SELECT 'engine/' || repeat('x', 100) || g::text FROM generate_series(1, 2500) g) WHERE id = $1", [r.twinId]);
      expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "private_set_too_large" });
      expect(await jobRows(r.setupId)).toEqual([]);
    });

    it("is tenant-scoped: another account's person, and the app login with a foreign account, find no such twin", async () => {
      const a = await rig();
      const b = await rig();
      expect(await failureOf(() => issueTwinPublish(depsFor(), principal(b), a.twinId))).toEqual({ status: 404, code: "not_found" });
      const direct = await h.appPool.connect();
      try {
        await direct.query("BEGIN");
        await direct.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [b.who.accountId, b.who.userId]);
        expect((await direct.query("SELECT o_result FROM twin_publish_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now() + interval '1 minute')", [a.twinId, randomUUID()])).rows).toEqual([{ o_result: "not_found" }]);
        await direct.query("ROLLBACK");
      } finally {
        direct.release();
      }
      expect(await jobRows(a.setupId)).toEqual([]);
      await issue(a);
      expect(await jobRows(b.setupId)).toEqual([]);
      expect(await twinRow(b.twinId)).toMatchObject({ state: "ready", publish_head: null });
    });
  });

  describe("the push-token route, for the public repository", () => {
    it("hands over one credential only after the fetch was reported and the push began, for the PUBLIC repository alone, and never again", async () => {
      const r = await rig();
      const jobId = await started(r);
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "push_not_started" } } });
      await reportedToPush(r, jobId);
      calls.mints.length = 0;
      seedMints.length = 0;
      const got = await token(r, jobId);
      expect(got.status).toBe(200);
      expect(got.headers?.["cache-control"]).toBe("no-store");
      expect(SetupPushTokenReply.parse(got.body).token).toBe(TOKEN);
      // minted by the public-push port for owner/name of the PUBLIC repository, never by the setup's (private, contents-only) mint
      expect(calls.mints).toEqual([{ codeRepo: "acme/widgets", accountId: r.who.accountId }]);
      expect(seedMints).toEqual([]);
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "already_issued" } } });
      expect(calls.mints).toHaveLength(1);
      for (const table of ["machine_jobs", "repo_twins", "project_setups", "audit_log"]) expect(JSON.stringify((await h.admin.query(`SELECT t.* FROM ${table} t`)).rows)).not.toContain(TOKEN);
    });

    it("mints nothing once the private set or the base is no longer the signed one (pairing_changed), and the job can still go on when it is again", async () => {
      const edits: Record<string, string> = {
        "a glob was added": "UPDATE repo_twins SET overlay_globs = overlay_globs || ARRAY['src/**'] WHERE id = $1",
        "a glob was removed": "UPDATE repo_twins SET overlay_globs = '{}' WHERE id = $1",
        "an install path was added": "UPDATE repo_twins SET install_paths = install_paths || ARRAY['extra.yml'] WHERE id = $1",
        "a rule file was declared": "UPDATE repo_twins SET identifier_rules_path = '.autonomous-team/ids.txt' WHERE id = $1",
        "the binary allow list grew": "UPDATE repo_twins SET binary_globs = '{assets/**}' WHERE id = $1",
        "the last published commit moved": `UPDATE repo_twins SET published_private_sha = '${"9".repeat(40)}' WHERE id = $1`,
      };
      for (const [what, sql] of Object.entries(edits)) {
        const r = await rig();
        const jobId = await started(r);
        await reportedToPush(r, jobId);
        await h.admin.query(sql, [r.twinId]);
        calls.mints.length = 0;
        expect(await token(r, jobId), what).toMatchObject({ status: 409, body: { error: { code: "pairing_changed" } } });
        expect(calls.mints, what).toEqual([]);
        expect((await jobRows(r.setupId))[0]!.push_token_at, what).toBeNull();
      }
      // the same job, with the set back as it was signed, gets its one credential
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      await h.admin.query("UPDATE repo_twins SET overlay_globs = '{}' WHERE id = $1", [r.twinId]);
      expect((await token(r, jobId)).status).toBe(409);
      await h.admin.query("UPDATE repo_twins SET overlay_globs = ARRAY['docs/plan/**'] WHERE id = $1", [r.twinId]);
      expect((await token(r, jobId)).status).toBe(200);
    });

    it("refuses another machine's key, another job, another account's setup, and a twin that is no longer ready", async () => {
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
      for (const state of ["paused", "refused", "removed"]) {
        await h.admin.query("UPDATE repo_twins SET state = $2, removed_at = CASE WHEN $2 = 'removed' THEN now() END WHERE id = $1", [r.twinId, state]);
        expect((await token(r, jobId)).status, state).toBe(404);
      }
      await h.admin.query("UPDATE repo_twins SET state = 'ready', removed_at = NULL WHERE id = $1", [r.twinId]);
      expect((await token(r, jobId)).status).toBe(200);
    });

    it("maps a mint that cannot be made to a fixed status, and needs the public-push port at all", async () => {
      // a grant is once per job, so each answer is a job of its own
      const cases: Array<[Partial<RunnerCloudDeps>, number, string]> = [
        [{ planePush: hosted({ mintFail: Object.assign(new Error("x"), { code: "app_not_installed" }) }) }, 409, "app_not_installed"],
        [{ planePush: hosted({ mintFail: Object.assign(new Error("x"), { code: "token_scope_mismatch" }) }) }, 502, "token_scope_mismatch"],
        [{ planePush: hosted({ mintFail: Object.assign(new Error("x"), { code: "public_unavailable" }) }) }, 503, "github_unavailable"],
        [{ planePush: null }, 503, "not_configured"],
      ];
      for (const [over, status, code] of cases) {
        const r = await rig();
        const jobId = await started(r);
        await reportedToPush(r, jobId);
        expect(await token(r, jobId, { deps: depsFor(over) }), code).toMatchObject({ status, body: { error: { code } } });
      }
    });
  });

  describe("the reports", () => {
    it("the push ok carries the commit once the credential was handed out, and only the last step ends the job done", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect(await pushed(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "head_not_recorded" } } });
      expect((await token(r, jobId)).status).toBe(200);
      expect((await pushed(r, jobId)).status).toBe(200);
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "delivered" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", publish_head: PUSHED, publish_pr: null });
      expect((await progress(r, jobId, { sub_step: "pr_open", state: "ok" })).status).toBe(200);
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "done" });
      // the report alone never records a pull request or moves the anchor
      expect(await twinRow(r.twinId)).toMatchObject({ publish_pr: null, published_private_sha: BASE });
      expect(await progress(r, jobId, { sub_step: "pr_open", state: "started" })).toMatchObject({ status: 409 });
    });

    it("a refusal of the route refuses the twin with its code and one reason word; the job fails and the setup is untouched", async () => {
      for (const code of ["scan_refused", "private_path_change", "rule_files_not_private", "branch_exists", "base_not_ancestor", "app_not_installed", "pairing_changed", "pr_failed"]) {
        const r = await rig();
        const jobId = await started(r);
        await reportedToPush(r, jobId);
        expect((await progress(r, jobId, { sub_step: code === "pr_failed" ? "pr_open" : "push", state: "failed", failure_code: code, failure_reason: "secret_shaped" })).status, code).toBe(200);
        expect(await twinRow(r.twinId), code).toMatchObject({ state: "refused", failure_code: code, failure_reason: "secret_shaped", published_private_sha: BASE });
        expect((await jobRows(r.setupId))[0], code).toMatchObject({ state: "failed" });
        expect(await setupRow(r.setupId)).toMatchObject({ phase: "done", failure_code: null });
        expect((await progress(r, jobId, { sub_step: "push", state: "started" })).status).toBe(404);
        // a refused twin is not published again until it is checked again
        expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "twin_state" });
      }
    });

    it("a transient failure leaves the twin ready with the code on it, so the next pass issues again", async () => {
      for (const code of ["public_unavailable", "public_tip_moved", "twin_fetch_failed", "push_failed", "kind_unsupported"]) {
        const r = await rig();
        const jobId = await started(r);
        expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "failed", failure_code: code })).status, code).toBe(200);
        expect(await twinRow(r.twinId), code).toMatchObject({ state: "ready", failure_code: code, published_private_sha: BASE });
        expect((await issue(r)).outcome, code).toBe("issued");
      }
    });

    it("no_changes (the twin changed private paths only) ends the job done and moves the anchor to the job's head, with nothing to check", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect((await progress(r, jobId, { sub_step: "push", state: "failed", failure_code: "no_changes" })).status).toBe(200);
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "done" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", published_private_sha: PRIV_HEAD, failure_code: null, publish_head: null });
      expect(await checkTwinPublish(depsFor(), principal(r), r.twinId)).toBe("not_ready");
      // nothing more to publish: the private tip is the anchor
      expect(await issue(r, { deps: depsFor({ pullRequests: github({ "acme/widgets-private": PRIV_HEAD, "acme/widgets": PUB_TIP }) }) })).toEqual({ outcome: "in_sync" });
    });

    it("refuses a code that is not a publish's (a seed's, an install's, a topic), a step that is not its own, and a seq that does not climb", async () => {
      const r = await rig();
      const jobId = await started(r);
      for (const code of ["twin_head_moved", "bundle_refused", "engine_checksum", "missing_topic:interview", "republish_pr_closed"]) expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "failed", failure_code: code })).status, code).toBe(400);
      for (const step of ["engine_fetch", "gh_labels", "bootstrap"]) expect((await progress(r, jobId, { sub_step: step, state: "ok" })).status, step).toBe(400);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", failure_code: null });
      expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "started" })).status).toBe(200);
      const stale = await respond(() => setupProgressRun(depsFor(), signed(r.key, setupProgressPath(r.setupId), { job_id: jobId, seq: 0, sub_step: "twin_fetch", state: "ok" }), r.setupId));
      expect(stale).toMatchObject({ status: 409, body: { error: { code: "seq_not_increasing" } } });
    });

    it("a quiet publish job expires without failing the twin or its setup, and the next pass issues again", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      await h.admin.query("UPDATE machine_jobs SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [jobId]);
      const idle = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(MachineJobClaimReply.parse(idle.body)).toHaveProperty("retry_after");
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "expired", failure_code: "job_silent" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", failure_code: null });
      expect(await setupRow(r.setupId)).toMatchObject({ phase: "done", state: "started", failure_code: null });
      expect((await issue(r)).outcome).toBe("issued");
    });
  });

  describe("the cloud's check", () => {
    const check = (r: Rig, over: Partial<RunnerCloudDeps> = {}, who: { accountId: string; userId: string | null } = principal(r)) => checkTwinPublish(depsFor(over), who, r.twinId);

    it("reads GitHub for exactly the signed branch, the pushed head and the signed tip, and records the one open pull request", async () => {
      const r = await rig();
      await finished(r);
      calls.verifies.length = 0;
      calls.finds.length = 0;
      expect(await check(r)).toBe("recorded");
      expect(calls.verifies).toEqual([{ accountId: r.who.accountId, codeRepo: "acme/widgets", branch: BRANCH, headSha: PUSHED, tipSha: PUB_TIP }]);
      expect(calls.finds).toEqual([{ accountId: r.who.accountId, codeRepo: "acme/widgets", branch: BRANCH, headSha: PUSHED }]);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", publish_pr: 7, publish_head: PUSHED, failure_code: null });
      // recorded once; and while it is open and already carries the private tip, nothing more is issued (a newer tip updates it in place: twinSyncPr.pg.test.ts)
      expect(await check(r)).toBe("not_ready");
      const jobsBefore = (await jobRows(r.setupId)).length;
      expect(await issue(r)).toEqual({ outcome: "in_sync" });
      expect(await jobRows(r.setupId)).toHaveLength(jobsBefore);
    });

    it("refuses the twin (head_unconfirmed) when GitHub does not show the pushed head under the signed parent, or shows no single open pull request for it", async () => {
      const wrongHead = await rig();
      await finished(wrongHead);
      expect(await check(wrongHead, { planePush: hosted({ pushedOk: false }) })).toBe("refused");
      expect(await twinRow(wrongHead.twinId)).toMatchObject({ state: "refused", failure_code: "head_unconfirmed", publish_pr: null, publish_head: null });
      const noPr = await rig();
      await finished(noPr);
      expect(await check(noPr, { planePush: hosted({ pr: null }) })).toBe("refused");
      expect(await twinRow(noPr.twinId)).toMatchObject({ state: "refused", failure_code: "head_unconfirmed" });
    });

    it("leaves the twin where it is when GitHub cannot be asked, and when an older port cannot find a pull request at all", async () => {
      const r = await rig();
      await finished(r);
      expect(await check(r, { planePush: hosted({ throws: Object.assign(new Error("x"), { code: "public_unavailable" }) }) })).toBe("github_unavailable");
      expect(await check(r, { planePush: hosted({ noFind: true }) })).toBe("github_unavailable");
      expect(await check(r, { planePush: null })).toBe("github_unavailable");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", publish_pr: null, publish_head: PUSHED });
      // a bug in the port is a bug, not a quiet "unavailable"
      await expect(check(r, { planePush: hosted({ throws: new Error("boom") }) })).rejects.toThrow("boom");
      expect(await check(r)).toBe("recorded");
    });

    it("is for an owner or admin or the tick's session, and finds nothing for a foreign account or for a job still running", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect(await check(r)).toBe("not_ready");
      await token(r, jobId);
      await pushed(r, jobId);
      await progress(r, jobId, { sub_step: "pr_open", state: "ok" });
      await expect(check(r, {}, principal(r, r.memberUser))).rejects.toMatchObject({ code: "42501" });
      const other = await rig();
      expect(await checkTwinPublish(depsFor(), principal(other), r.twinId)).toBe("not_ready");
      expect(await check(r, {}, principal(r, null))).toBe("recorded");
    });
  });

  describe("the merge, in the webhook's session", () => {
    const recorded = async (r: Rig): Promise<void> => {
      await finished(r);
      expect(await checkTwinPublish(depsFor(), principal(r), r.twinId)).toBe("recorded");
    };

    it("a merged publish pull request moves the anchor to the job's private head and frees the twin for the next publish from there", async () => {
      const r = await rig();
      await recorded(r);
      expect(await prClosed(r)).toBe("merged");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", published_private_sha: PRIV_HEAD, publish_pr: null, publish_head: null, failure_code: null });
      expect(await prClosed(r)).toBe("none");
      const next = "f".repeat(40);
      const out = await issue(r, { deps: depsFor({ pullRequests: github({ "acme/widgets-private": next, "acme/widgets": PUB_TIP }) }) });
      expect(out.outcome).toBe("issued");
      expect((await jobRows(r.setupId))[1]!.job.job).toMatchObject({ args: { private: { base: PRIV_HEAD, head: next }, branch: `fx/publish-${next.slice(0, 12)}` } });
    });

    it("a pull request closed unmerged refuses the twin (publish_closed) and leaves the anchor", async () => {
      const r = await rig();
      await recorded(r);
      expect(await prClosed(r, { merged: false })).toBe("closed");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "publish_closed", published_private_sha: BASE, publish_pr: null, publish_head: null });
    });

    it("a pull request that closes before the check wrote its number is the same pull request (the pushed head is waiting)", async () => {
      const r = await rig();
      await finished(r);
      expect(await prClosed(r, { pr: 31 })).toBe("merged");
      expect(await twinRow(r.twinId)).toMatchObject({ published_private_sha: PRIV_HEAD, publish_pr: null, publish_head: null });
      expect(await checkTwinPublish(depsFor(), principal(r), r.twinId)).toBe("not_ready");
    });

    it("acts only for the twin's own recorded pull request: another number, another branch, another repository, another account, a removed twin and a twin with nothing pushed are all none", async () => {
      const r = await rig();
      await recorded(r);
      const before = await twinRow(r.twinId);
      expect(await prClosed(r, { pr: 8 })).toBe("none");
      expect(await prClosed(r, { ref: "fx/publish-000000000000" })).toBe("none");
      expect(await prClosed(r, { ref: "feature/x" })).toBe("none");
      expect(await prClosed(r, { repo: r.privateId })).toBe("none");
      expect(await prClosed(r, { repo: randomUUID() })).toBe("none");
      const stranger = await rig();
      expect(await prClosed(r, { account: stranger.who.accountId })).toBe("none");
      expect(await twinRow(r.twinId)).toEqual(before);
      const idle = await rig();
      expect(await prClosed(idle)).toBe("none");
      await h.admin.query("UPDATE repo_twins SET state = 'removed', removed_at = now() WHERE id = $1", [r.twinId]);
      expect(await prClosed(r)).toBe("none");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "removed", published_private_sha: BASE });
    });

    it("a paused twin takes the merge too, and stays paused", async () => {
      const r = await rig();
      await recorded(r);
      await h.admin.query("UPDATE repo_twins SET state = 'paused' WHERE id = $1", [r.twinId]);
      expect(await prClosed(r)).toBe("merged");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "paused", published_private_sha: PRIV_HEAD });
    });
  });

  describe("the removal", () => {
    it("closes the publish pull request a removed twin still has open, with the fixed comment and the signed branch, once", async () => {
      const r = await rig();
      await finished(r);
      await checkTwinPublish(depsFor(), principal(r), r.twinId);
      await h.admin.query("UPDATE repo_twins SET state = 'removed', removed_at = now() WHERE id = $1", [r.twinId]);
      calls.closes.length = 0;
      expect(await closeTwinPublishPr(depsFor(), principal(r), r.twinId)).toBe("closed");
      expect(calls.closes).toEqual([{ accountId: r.who.accountId, codeRepo: "acme/widgets", number: 7, branch: BRANCH, comment: TWIN_PUBLISH_CLOSE_COMMENT }]);
      expect(TWIN_PUBLISH_CLOSE_COMMENT).not.toMatch(/D#|acme|widgets|twin/i);
      // the close's own webhook finds a removed twin and changes nothing
      expect(await prClosed(r, { merged: false })).toBe("none");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "removed", published_private_sha: BASE });
    });

    it("answers by what GitHub says, and leaves it open (and says so) when GitHub cannot be asked", async () => {
      const r = await rig();
      await finished(r);
      await checkTwinPublish(depsFor(), principal(r), r.twinId);
      expect(await closeTwinPublishPr(depsFor({ planePush: hosted({ closeResult: { result: "not_open" } }) }), principal(r), r.twinId)).toBe("not_open");
      expect(await closeTwinPublishPr(depsFor({ planePush: hosted({ closeResult: { result: "not_ours" } }) }), principal(r), r.twinId)).toBe("none");
      expect(await closeTwinPublishPr(depsFor({ planePush: hosted({ throws: Object.assign(new Error("x"), { code: "public_unavailable" }) }) }), principal(r), r.twinId)).toBe("github_unavailable");
      expect(await closeTwinPublishPr(depsFor({ planePush: null }), principal(r), r.twinId)).toBe("github_unavailable");
    });

    it("has nothing to close for a twin with no recorded pull request, a foreign twin, or a member", async () => {
      const r = await rig();
      calls.closes.length = 0;
      expect(await closeTwinPublishPr(depsFor(), principal(r), r.twinId)).toBe("none");
      const other = await rig();
      await finished(other);
      await checkTwinPublish(depsFor(), principal(other), other.twinId);
      expect(await closeTwinPublishPr(depsFor(), principal(r), other.twinId)).toBe("none");
      await expect(closeTwinPublishPr(depsFor(), principal(other, other.memberUser), other.twinId)).rejects.toMatchObject({ code: "42501" });
      expect(calls.closes).toEqual([]);
    });
  });
  describe("a second twin of the same account", () => {
    it("is never touched by the first twin's issue, token, reports, check, merge or close, and never touches it", async () => {
      const a = await rig();
      const b = await sibling(a);
      const ghTips = { ...TIPS, "acme/gadgets": PUB_TIP, "acme/gadgets-private": PRIV_HEAD };
      const depsBoth = () => depsFor({ pullRequests: github(ghTips) });
      // the issue: a's job is homed on a's repository, and b has no row of any kind
      const jobId = await issued(a);
      expect(await jobRows(b.setupId)).toEqual([]);
      expect(await twinRow(b.twinId)).toMatchObject({ state: "ready", publish_head: null, publish_pr: null });
      // the machine takes a's job; the credential is for a's PUBLIC repository and for no other of the account's
      await respond(() => machineJobClaimRun(h.deps(), signed(a.key, MACHINE_JOB_CLAIM_PATH, {})));
      await reportedToPush(a, jobId);
      calls.mints.length = 0;
      expect((await token(a, jobId)).status).toBe(200);
      expect(calls.mints).toEqual([{ codeRepo: "acme/widgets", accountId: a.who.accountId }]);
      // a's job cannot be reported or given a credential through b's setup, and the other way round
      expect((await token(a, jobId, { setupId: b.setupId })).status).toBe(404);
      expect((await pushed(a, jobId)).status).toBe(200);
      expect((await progress(a, jobId, { sub_step: "pr_open", state: "ok" })).status).toBe(200);
      expect(await twinRow(b.twinId)).toMatchObject({ publish_head: null, publish_pr: null });
      // the check records a's pull request only
      expect(await checkTwinPublish(depsBoth(), principal(a), a.twinId)).toBe("recorded");
      expect(await checkTwinPublish(depsBoth(), principal(a), b.twinId)).toBe("not_ready");
      expect(await twinRow(b.twinId)).toMatchObject({ publish_head: null, publish_pr: null });
      // b publishes on its own, and a merge of a's number on a's branch is a's alone
      const bJob = ((await issue(b, { deps: depsBoth() })) as { job_id: string }).job_id;
      expect(bJob).not.toBe(jobId);
      expect(await prClosed(a, { repo: b.publicId })).toBe("none");
      expect(await prClosed(a)).toBe("merged");
      expect(await twinRow(a.twinId)).toMatchObject({ published_private_sha: PRIV_HEAD, publish_pr: null });
      expect(await twinRow(b.twinId)).toMatchObject({ state: "ready", published_private_sha: BASE });
      // the close names a's pull request, a's repository and a's branch, and only when a is asked about
      await h.admin.query("UPDATE repo_twins SET publish_pr = 9, publish_head = $2 WHERE id = $1", [b.twinId, PUSHED]);
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), ended_at = now() WHERE id = $1", [bJob]);
      calls.closes.length = 0;
      expect(await closeTwinPublishPr(depsBoth(), principal(a), b.twinId)).toBe("closed");
      expect(calls.closes).toEqual([{ accountId: a.who.accountId, codeRepo: "acme/gadgets", number: 9, branch: `fx/publish-${PRIV_HEAD.slice(0, 12)}`, comment: TWIN_PUBLISH_CLOSE_COMMENT }]);
      expect(await closeTwinPublishPr(depsBoth(), principal(a), a.twinId)).toBe("none");
    });

    it("a newer job of the sibling never answers for the first twin's check, verify or close", async () => {
      const B_HEAD = "d".repeat(40);
      const BRANCH_B = `fx/publish-${B_HEAD.slice(0, 12)}`;
      for (const newest of ["running", "done"] as const) {
        const a = await rig();
        const b = await sibling(a);
        const both = depsFor({ pullRequests: github({ ...TIPS, "acme/gadgets": PUB_TIP, "acme/gadgets-private": B_HEAD }) });
        // b has two jobs: the first ended, the second (a higher attempt than a's one) is the sibling's newest
        const first = ((await issue(b, { deps: both })) as { job_id: string }).job_id;
        await h.admin.query("UPDATE machine_jobs SET state = 'expired', ended_at = now() WHERE id = $1", [first]);
        const second = ((await issue(b, { deps: both })) as { job_id: string }).job_id;
        if (newest === "done") await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), ended_at = now() WHERE id = $1", [second]);
        expect((await jobRows(b.setupId)).map((j) => j.attempt)).toEqual([1, 2]);
        await finished(a);
        calls.verifies.length = 0;
        expect(await checkTwinPublish(depsFor(), principal(a), a.twinId), newest).toBe("recorded");
        expect(calls.verifies, newest).toEqual([{ accountId: a.who.accountId, codeRepo: "acme/widgets", branch: BRANCH, headSha: PUSHED, tipSha: PUB_TIP }]);
        calls.closes.length = 0;
        expect(await closeTwinPublishPr(depsFor(), principal(a), a.twinId), newest).toBe("closed");
        expect(calls.closes.map((c) => [c.codeRepo, c.branch]), newest).toEqual([["acme/widgets", BRANCH]]);
        expect(calls.closes[0]!.branch).not.toBe(BRANCH_B);
      }
    });

    it("a merge moves the anchor to the head of the job of ITS OWN twin, even when the sibling's newer job names a branch with the same twelve characters", async () => {
      const a = await rig();
      const b = await sibling(a);
      const B_HEAD = PRIV_HEAD.slice(0, 12) + "f".repeat(28);
      const both = depsFor({ pullRequests: github({ ...TIPS, "acme/gadgets": PUB_TIP, "acme/gadgets-private": B_HEAD }) });
      await finished(a);
      expect(await checkTwinPublish(depsFor(), principal(a), a.twinId)).toBe("recorded");
      const bJob = ((await issue(b, { deps: both })) as { job_id: string }).job_id;
      expect((await jobRows(b.setupId))[0]!.job.job).toMatchObject({ args: { branch: BRANCH, private: { head: B_HEAD } } });
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), ended_at = now() WHERE id = $1", [bJob]);
      expect(await prClosed(a)).toBe("merged");
      expect(await twinRow(a.twinId)).toMatchObject({ published_private_sha: PRIV_HEAD });
      expect(await twinRow(b.twinId)).toMatchObject({ published_private_sha: BASE });
    });

    it("a job forged onto one twin's repository that names the sibling's twin finds no twin, and a changed set of the first twin is not covered by the sibling's identical one", async () => {
      const a = await rig();
      const b = await sibling(a);
      // forged past the issuer: homed on a's repository and setup, naming b's twin; the machine has taken it and reported far enough
      const forged = await issueTestJob(h.appPool, h.admin, {
        accountId: a.who.accountId, userId: a.who.userId, runnerId: a.runnerId, repoId: a.privateId, setupId: a.setupId, kind: "twin_publish",
        args: {
          twin_id: b.twinId, public: { owner: "acme", name: "gadgets", gh_id: b.publicGh, tip: PUB_TIP }, private: { owner: "acme", name: "widgets-private", gh_id: a.privateGh, base: BASE, head: PRIV_HEAD }, branch: BRANCH,
          private_set: { overlay_globs: ["docs/plan/**"], install_paths: [".github/workflows/engine.yml"], blob_globs: [], identifier_rules_path: null, plan_data_rules_path: null },
        },
      });
      await h.admin.query("UPDATE machine_jobs SET state = 'delivered', delivered_at = now(), last_seq = 5, last_progress_at = now() WHERE id = $1", [forged.id]);
      calls.mints.length = 0;
      expect((await token(a, forged.id)).status).toBe(404);
      expect(calls.mints).toEqual([]);
      await h.admin.query("UPDATE machine_jobs SET state = 'failed', ended_at = now() WHERE id = $1", [forged.id]);
      // a real job of a, whose set is then edited: b's set is still exactly the signed one, and must not stand in for a's
      const jobId = await started(a);
      await reportedToPush(a, jobId);
      await h.admin.query("UPDATE repo_twins SET overlay_globs = ARRAY['other/**'] WHERE id = $1", [a.twinId]);
      expect(await token(a, jobId)).toMatchObject({ status: 409, body: { error: { code: "pairing_changed" } } });
      expect(calls.mints).toEqual([]);
    });

    it("the app login with a foreign account reads and writes nothing of the twin's through any of the functions", async () => {
      const a = await rig();
      await finished(a);
      await checkTwinPublish(depsFor(), principal(a), a.twinId);
      const other = await rig();
      const c = await h.appPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [other.who.accountId, other.who.userId]);
        expect((await c.query("SELECT * FROM twin_publish_to_verify($1::uuid)", [a.twinId])).rows).toEqual([]);
        expect((await c.query("SELECT * FROM twin_publish_open_pr($1::uuid)", [a.twinId])).rows).toEqual([]);
        expect((await c.query("SELECT o_result FROM twin_publish_check($1::uuid, 7)", [a.twinId])).rows).toEqual([{ o_result: "not_found" }]);
        expect((await c.query("SELECT twin_publish_pr_closed($1::uuid, 7, true, $2) AS r", [a.publicId, BRANCH])).rows).toEqual([{ r: "none" }]);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      expect(await twinRow(a.twinId)).toMatchObject({ publish_pr: 7, published_private_sha: BASE });
    });
  });

  /** FU-311 (migration 1116): what the visibility port answers for each repository of the rig; any repository not listed reads as unknown. */
  const seeing = (r: Rig, priv: "private" | "public" | "unknown", pub: "private" | "public" | "unknown" = "public"): Partial<RunnerCloudDeps> => ({ repoVisibility: async (_accountId: string, repoId: string) => (repoId === r.privateId ? priv : repoId === r.publicId ? pub : "unknown") });
  const noteOf = async (id: string) => (await h.admin.query<{ note: string | null }>("SELECT note FROM repo_twins WHERE id = $1", [id])).rows[0]!.note;

  describe("the private repository must stay private (FU-311)", () => {
    it("issues nothing for a twin whose private repository is public (refused twin_not_private, no job), nor when it cannot be read; a public side gone private is a note", async () => {
      const r = await rig();
      expect(await failureOf(() => issue(r, { deps: depsFor(seeing(r, "unknown")) }))).toEqual({ status: 409, code: "repo_visibility_unknown" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", failure_code: null });
      expect(await failureOf(() => issue(r, { deps: depsFor(seeing(r, "public")) }))).toEqual({ status: 409, code: "twin_not_private" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "twin_not_private" });
      expect(await jobRows(r.setupId)).toHaveLength(0);
      const n = await rig();
      expect(await issue(n, { deps: depsFor(seeing(n, "private", "private")) })).toMatchObject({ outcome: "issued" });
      expect(await noteOf(n.twinId)).toBe("public_repo_private");
    });

    it("the check records nothing for a twin whose private repository is public: refused, and GitHub is not asked", async () => {
      const r = await rig();
      await finished(r);
      calls.verifies.length = 0;
      expect(await checkTwinPublish(depsFor(seeing(r, "unknown")), principal(r), r.twinId)).toBe("github_unavailable");
      expect(await checkTwinPublish(depsFor(seeing(r, "public")), principal(r), r.twinId)).toBe("refused");
      expect(calls.verifies).toEqual([]);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "twin_not_private", publish_pr: null });
    });
  });
});
