import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, MachineJobClaimReply, SetupPushTokenReply, setupProgressPath, setupPushTokenPath, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { HELLO_PATH, RunnerHttpError, RunPullRequestError, checkTwinSync, issueTwinSync, machineJobClaimRun, runnerHello, setupProgressRun, setupPushTokenRun, type PlanePushHostedPort, type RunnerCloudDeps, type RunPullRequestPort, type SetupInstallPort } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const TOKEN = "ghs_sentinel_twin_sync_token_0123456789abc";
const SYNCED = "a".repeat(40);
const PUB_TIP = "b".repeat(40);
const PRIV_TIP = "c".repeat(40);
const PUSHED = "e".repeat(40);
const BRANCH = `fx/twin-sync-${PUB_TIP.slice(0, 12)}`;
const PATHS = ["src/new.ts", "docs/guide.md"];
const SET = { overlay_globs: ["docs/plan/**"], install_paths: [".github/workflows/engine.yml"], blob_globs: [] as string[], identifier_rules_path: null, plan_data_rules_path: null };

/**
 * [pg] D#845 ON-27d2 (migration 1111): the twin sync's cloud side, over the real signed HTTP path, real Ed25519 job signatures, the real SECURITY DEFINER functions as the runner and the app login, and row security forced.
 * GitHub is a fake that enforces what the real port does for these calls (one token per repository, fixed shapes of answer). What it cannot show: GitHub's own rate limits and permission model, and the push itself (the runner's test).
 */
describe("twin sync [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const mints: Array<{ id: string; owner: string; name: string }> = [];
  const hostedMints: string[] = [];
  /** The setup mint, held to what the real one does: a token is for exactly one repository. */
  const setupPort = () => ({
    async mint(repo: { id: string; owner: string; name: string }) {
      mints.push(repo);
      return { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) };
    },
    async revoke() {},
  });
  /** The public-push port is for a publish; a sync must never reach it. */
  const hosted = (): PlanePushHostedPort => ({ mintToken: async (repo: string) => (hostedMints.push(repo), { token: "ghs_wrong", expiresAt: new Date(Date.now() + 3600_000) }) }) as unknown as PlanePushHostedPort;
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
  const TIPS = { "acme/widgets-private": PRIV_TIP, "acme/widgets": PUB_TIP, "acme/gadgets-private": PRIV_TIP, "acme/gadgets": PUB_TIP };
  /** What the cloud's check reads: the branch's head on the twin and that commit's parents. */
  const install = (o: { head?: string | null; parents?: string[] | null; throws?: unknown } = {}, asked: unknown[] = []): SetupInstallPort =>
    ({
      async branchState(i: unknown) {
        asked.push(i);
        if (o.throws !== undefined) throw o.throws;
        const head = o.head === undefined ? PUSHED : o.head;
        return { exists: head !== null, headOid: head, aheadBy: 1, defaultBranch: "trunk" };
      },
      async commitParents(i: unknown) {
        asked.push(i);
        return o.parents === undefined ? [PRIV_TIP] : o.parents;
      },
    }) as unknown as SetupInstallPort;
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({ setupPush: setupPort(), planePush: hosted(), pullRequests: github(TIPS), setupInstall: install(), engineCommandSigner: async () => ({ keyId: "k1", signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", jobKeys.privateKey) }) as never, ...over });

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
  const hello = (key: TestKey, caps: string[]) =>
    respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: caps, facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
  /** A fresh account with a public repo, a READY private twin (synced up to SYNCED), the twin's setup, a machine that lists twin_v1 and the twin placed on it. */
  async function rig(o: { caps?: string[]; placed?: boolean; setup?: boolean; state?: string; synced?: string | null; pr?: number } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const publicGh = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const privateId = randomUUID();
    const privateGh = publicGh + 1;
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets-private')", [privateId, who.accountId, who.installationId, privateGh]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    expect((await hello(key, o.caps ?? ["project_setup_v1", "twin_v1"])).status).toBe(200);
    if (o.placed !== false) await h.admin.query("INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.accountId, privateId, runnerId]);
    const setupId = randomUUID();
    if (o.setup !== false) await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, $3, 'existing', $4, 'done')", [setupId, who.accountId, privateId, who.userId]);
    const twinId = randomUUID();
    const synced = o.synced === undefined ? SYNCED : o.synced;
    await h.admin.query(
      `INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state, removed_at, published_private_sha, synced_public_sha, sync_pr, overlay_globs, install_paths)
       VALUES ($1, $2, $3, $4, 'widgets-private', $5, $6, $7, CASE WHEN $7 = 'removed' THEN now() END, $8, $9, $10, ARRAY['docs/plan/**'], ARRAY['.github/workflows/engine.yml'])`,
      [twinId, who.accountId, who.repoId, privateId, privateGh, who.userId, o.state ?? "ready", PRIV_TIP, synced, o.pr ?? null],
    );
    return { who, key, runnerId, publicId: who.repoId, privateId, publicGh, privateGh, twinId, setupId, adminUser: await addUser(who.accountId, "admin"), memberUser: await addUser(who.accountId, "member") };
  }
  const principal = (r: Rig, userId: string | null = r.adminUser) => ({ accountId: r.who.accountId, userId });
  const issue = (r: Rig, o: { as?: string | null; deps?: RunnerCloudDeps; paths?: string[]; twin?: string } = {}) => issueTwinSync(o.deps ?? depsFor(), principal(r, o.as === undefined ? r.adminUser : o.as), o.twin ?? r.twinId, o.paths ?? PATHS);
  const failureOf = async (run: () => Promise<unknown>): Promise<{ status: number; code: string } | null> => {
    try {
      await run();
      return null;
    } catch (error) {
      if (error instanceof RunnerHttpError) return { status: error.status, code: error.code };
      throw error;
    }
  };
  const twinRow = async (id: string) => (await h.admin.query("SELECT state, failure_code, failure_reason, synced_public_sha, published_private_sha, sync_pr, sync_head, sync_verified_at IS NOT NULL AS verified FROM repo_twins WHERE id = $1", [id])).rows[0];
  const setupRow = async (id: string) => (await h.admin.query("SELECT phase, state, failure_code FROM project_setups WHERE id = $1", [id])).rows[0];
  const jobRows = async (setupId: string) => (await h.admin.query<{ id: string; state: string; attempt: number; kind: string; repo_id: string; push_token_at: string | null; failure_code: string | null; job: { job: MachineJob } }>("SELECT id, state, attempt, kind, repo_id, push_token_at, failure_code, job FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt", [setupId])).rows;
  const issued = async (r: Rig): Promise<string> => {
    const out = await issue(r);
    if (out.outcome !== "issued") throw new Error("nothing was issued");
    return out.job_id;
  };
  async function started(r: Rig): Promise<string> {
    const jobId = await issued(r);
    const taken = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
    expect(MachineJobClaimReply.parse(taken.body)).toHaveProperty("signed_job");
    return jobId;
  }
  const seqs = new Map<string, number>();
  const progress = (r: Rig, jobId: string, body: Record<string, unknown>) => {
    const seq = seqs.get(jobId) ?? 0;
    seqs.set(jobId, seq + 1);
    return respond(() => setupProgressRun(depsFor(), signed(r.key, setupProgressPath(r.setupId), { job_id: jobId, seq, ...body }), r.setupId));
  };
  const reportedToPush = async (r: Rig, jobId: string) => {
    for (const b of [{ sub_step: "twin_fetch", state: "started" }, { sub_step: "twin_fetch", state: "ok" }, { sub_step: "push", state: "started" }]) expect((await progress(r, jobId, b)).status).toBe(200);
  };
  const token = (r: Rig, jobId: string, o: { setupId?: string; key?: TestKey } = {}) => {
    const setupId = o.setupId ?? r.setupId;
    return respond(() => setupPushTokenRun(depsFor(), signed(o.key ?? r.key, setupPushTokenPath(setupId), { job_id: jobId }), setupId));
  };
  const pushed = (r: Rig, jobId: string, head = PUSHED) => progress(r, jobId, { sub_step: "push", state: "ok", head_sha: head });
  /** The whole of a good sync, as the runner reports it. */
  async function finished(r: Rig): Promise<string> {
    const jobId = await started(r);
    await reportedToPush(r, jobId);
    expect((await token(r, jobId)).status).toBe(200);
    expect((await pushed(r, jobId)).status).toBe(200);
    return jobId;
  }
  async function sibling(r: Rig): Promise<Rig> {
    const publicId = randomUUID();
    const privateId = randomUUID();
    const publicGh = r.publicGh + 100;
    const privateGh = r.publicGh + 101;
    for (const [id, gh, name] of [[publicId, publicGh, "gadgets"], [privateId, privateGh, "gadgets-private"]] as const) {
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', $5)", [id, r.who.accountId, r.who.installationId, gh, name]);
    }
    const key = newKey();
    const runnerId = await registerKey(h.admin, r.who.accountId, r.who.userId, key);
    expect((await hello(key, ["project_setup_v1", "twin_v1"])).status).toBe(200);
    await h.admin.query("INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [r.who.accountId, privateId, runnerId]);
    const setupId = randomUUID();
    await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, $3, 'existing', $4, 'done')", [setupId, r.who.accountId, privateId, r.who.userId]);
    const twinId = randomUUID();
    await h.admin.query(
      `INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state, published_private_sha, synced_public_sha, overlay_globs, install_paths)
       VALUES ($1, $2, $3, $4, 'gadgets-private', $5, $6, 'ready', $7, $8, ARRAY['docs/plan/**'], ARRAY['.github/workflows/engine.yml'])`,
      [twinId, r.who.accountId, publicId, privateId, privateGh, r.who.userId, PRIV_TIP, SYNCED],
    );
    return { ...r, key, runnerId, publicId, privateId, publicGh, privateGh, twinId, setupId };
  }
  /** The definer called directly in a rolled-back transaction, as `user` (null: the tick) and optionally from a runner's session. */
  const call = <T = Record<string, unknown>>(sql: string, args: unknown[], r: Rig, o: { user?: string | null; runner?: string; account?: string } = {}): Promise<T[]> =>
    h.appPool.connect().then(async (c) => {
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [o.account ?? r.who.accountId, o.user === undefined ? r.adminUser : (o.user ?? "")]);
        if (o.runner !== undefined) await c.query("SELECT set_config('app.runner_id', $1, true)", [o.runner]);
        return (await c.query(sql, args)).rows as T[];
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  const goodJob = (r: Rig): Record<string, unknown> => ({
    v: 1, job_id: randomUUID(), runner_id: r.runnerId, repo_gh_id: r.privateGh, setup_id: r.setupId, requires_engine: "any", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), kind: "twin_sync",
    args: { twin_id: r.twinId, public: { owner: "acme", name: "widgets", gh_id: r.publicGh, tip: PUB_TIP }, private: { owner: "acme", name: "widgets-private", gh_id: r.privateGh, base: PRIV_TIP }, branch: BRANCH, paths: [...PATHS], private_set: SET },
  });
  const issueSql = (r: Rig, job: Record<string, unknown>, o: Parameters<typeof call>[3] = {}) =>
    call("SELECT o_result FROM twin_sync_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [r.twinId, job["job_id"], JSON.stringify({ job, key_id: "k1", signature: "x" }), job["issued_at"], job["expires_at"]], r, o);

  describe("the kind and the capability", () => {
    it("the kind CHECK takes twin_sync and keeps every kind that came before; 1108's capability list is untouched", async () => {
      const def = (await h.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'machine_jobs_kind_check'")).rows[0].def as string;
      for (const kind of ["project_setup", "engine_update", "engine_session_start", "engine_session_stop", "engine_session_delete", "project_remove", "twin_seed", "twin_publish", "twin_sync"]) expect(def, kind).toContain(`'${kind}'`);
      expect((await h.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'machine_jobs_job_check'")).rows[0].def).toContain("262144");
      expect((await h.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'runner_capabilities_values_check'")).rows[0].def).toContain("'twin_v1'");
    });

    it("a runner is offered the sync only when its latest hello lists twin_v1, and takes the job exactly as signed", async () => {
      const old = await rig({ caps: ["project_setup_v1"] });
      await issue(old);
      const idle = await respond(() => machineJobClaimRun(h.deps(), signed(old.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(MachineJobClaimReply.parse(idle.body)).toHaveProperty("retry_after");
      expect((await jobRows(old.setupId))[0]).toMatchObject({ state: "issued" });
      expect((await hello(old.key, ["project_setup_v1", "twin_v1"])).status).toBe(200);
      const taken = MachineJobClaimReply.parse((await respond(() => machineJobClaimRun(h.deps(), signed(old.key, MACHINE_JOB_CLAIM_PATH, {})))).body);
      const job = verifyMachineJob((taken as { signed_job: unknown }).signed_job, { k1: jobKeys.publicKey }, old.runnerId);
      expect(job).toMatchObject({
        kind: "twin_sync", repo_gh_id: old.privateGh, setup_id: old.setupId, requires_engine: "any",
        args: { twin_id: old.twinId, public: { owner: "acme", name: "widgets", gh_id: old.publicGh, tip: PUB_TIP }, private: { owner: "acme", name: "widgets-private", gh_id: old.privateGh, base: PRIV_TIP }, branch: BRANCH, paths: PATHS, private_set: SET },
      });
    });
  });

  describe("who may call the functions", () => {
    const FUNCTIONS: Array<[string, string]> = [
      ["twin_sync_issue", "uuid, uuid, jsonb, timestamptz, timestamptz"],
      ["twin_sync_job_lock", "uuid, uuid"],
      ["twin_sync_push_grant", "uuid, uuid"],
      ["twin_sync_head_record", "uuid, uuid, text"],
      ["twin_sync_progress_record", "uuid, uuid, integer, text, text, text, text"],
      ["twin_sync_to_verify", "uuid"],
      ["twin_sync_check", "uuid, boolean"],
    ];
    it("are owned by machine_jobs_owner, closed to PUBLIC and to platform_ops, and open to app_user alone (the job lock is nobody's but its callers')", async () => {
      for (const [name, args] of FUNCTIONS) {
        const row = (await h.admin.query("SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops, has_function_privilege('public', p.oid, 'EXECUTE') AS everyone FROM pg_proc p WHERE p.oid = $1::regprocedure", [`public.${name}(${args})`])).rows[0];
        expect(row, name).toMatchObject({ owner: "machine_jobs_owner", definer: name !== "twin_sync_job_lock", app: name !== "twin_sync_job_lock", ops: false, everyone: false });
      }
    });

    it("a platform_ops login cannot call any of them", async () => {
      const r = await rig();
      await expect(h.opsPool.query("SELECT o_result FROM twin_sync_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now())", [r.twinId, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      await expect(h.opsPool.query("SELECT o_result FROM twin_sync_check($1::uuid, true)", [r.twinId])).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("the issue", () => {
    it("signs one job homed on the twin, with the twin's tip as its base and the public main as its tip; the twin stays ready, and a second issue finds the job live", async () => {
      const r = await rig();
      const asked: string[] = [];
      const out = await issue(r, { deps: depsFor({ pullRequests: github(TIPS, asked) }) });
      expect(out).toMatchObject({ outcome: "issued", attempt: 1 });
      expect((await jobRows(r.setupId))[0]).toMatchObject({ kind: "twin_sync", state: "issued", attempt: 1, repo_id: r.privateId });
      expect(asked.sort()).toEqual(["acme/widgets-private@trunk", "acme/widgets@main"]);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", synced_public_sha: SYNCED, sync_head: null, verified: false });
      expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "sync_live" });
      expect(await jobRows(r.setupId)).toHaveLength(1);
    });

    it("signs nothing when the public tip is the one already synced", async () => {
      const r = await rig({ synced: PUB_TIP });
      expect(await issue(r)).toEqual({ outcome: "in_sync" });
      expect(await jobRows(r.setupId)).toEqual([]);
    });

    it("is for an owner or admin, or the tick's session (no person): a member is 403 and no row is written", async () => {
      const r = await rig();
      expect(await failureOf(() => issue(r, { as: r.memberUser }))).toEqual({ status: 403, code: "forbidden" });
      expect(await jobRows(r.setupId)).toEqual([]);
      expect(await issue(r, { as: null })).toMatchObject({ outcome: "issued" });
    });

    it("refuses a list of paths that is not 1 to 200 distinct plain repository paths, before anything is read", async () => {
      const r = await rig();
      const bad: string[][] = [[], Array.from({ length: 201 }, (_, n) => `f${n}`), ["a", "a"], ["/abs"], ["a/../b"], [".git/config"], ["a//b"], ["a\\b"], ["a\u0000b"]];
      for (const paths of bad) expect(await failureOf(() => issue(r, { paths })), JSON.stringify(paths).slice(0, 30)).toEqual({ status: 400, code: "bad_paths" });
      expect(await issue(r, { paths: Array.from({ length: 200 }, (_, n) => `f${n}`) })).toMatchObject({ outcome: "issued" });
    });

    it("holds the signed bytes to the rows: the definer refuses a job that is not exactly this twin's sync, in any of its places", async () => {
      const r = await rig();
      const good = goodJob(r);
      const args = good["args"] as { public: Record<string, unknown>; private: Record<string, unknown>; private_set: Record<string, unknown>; paths: unknown };
      const withArgs = (a: Record<string, unknown>) => ({ ...good, args: { ...args, ...a } });
      const forged: Record<string, Record<string, unknown>> = {
        "the job's home is the public repository": { ...good, repo_gh_id: r.publicGh },
        "the private side names the public repository": withArgs({ private: { ...args.private, name: "widgets", gh_id: r.publicGh } }),
        "both sides name the public repository": { ...withArgs({ private: { ...args.private, name: "widgets", gh_id: r.publicGh } }), repo_gh_id: r.publicGh },
        "the public side is the twin": withArgs({ public: { ...args.public, name: "widgets-private", gh_id: r.privateGh } }),
        "the private side's gh id alone": withArgs({ private: { ...args.private, gh_id: r.privateGh + 7 } }),
        "the public side's gh id alone": withArgs({ public: { ...args.public, gh_id: r.publicGh + 7 } }),
        "another machine": { ...good, runner_id: randomUUID() },
        "another setup": { ...good, setup_id: randomUUID() },
        "another twin": withArgs({ twin_id: randomUUID() }),
        "a microVM": { ...good, requires_engine: "microvm" },
        "another kind": { ...good, kind: "twin_publish" },
        "a base that is not a commit": withArgs({ private: { ...args.private, base: "trunk" } }),
        "a tip that is not a commit": withArgs({ public: { ...args.public, tip: "main" } }),
        "a branch that is not named from the tip": withArgs({ branch: "fx/twin-sync-000000000000" }),
        "a glob more than the live set has": withArgs({ private_set: { ...args.private_set, overlay_globs: ["docs/plan/**", "src/**"] } }),
        "a glob fewer than the live set has": withArgs({ private_set: { ...args.private_set, overlay_globs: [] } }),
        "an install path that is not the live one": withArgs({ private_set: { ...args.private_set, install_paths: [".github/workflows/other.yml"] } }),
        "a rule file the twin does not declare": withArgs({ private_set: { ...args.private_set, identifier_rules_path: ".autonomous-team/ids.txt" } }),
        "a binary allow list the twin does not have": withArgs({ private_set: { ...args.private_set, blob_globs: ["assets/**"] } }),
        "no paths": withArgs({ paths: [] }),
        "too many paths": withArgs({ paths: Array.from({ length: 201 }, (_, n) => `f${n}`) }),
        "paths that are not a list": withArgs({ paths: "src/a.ts" }),
        "a path that is not a string": withArgs({ paths: ["a", 7] }),
        "a path twice": withArgs({ paths: ["a", "a"] }),
        "an absolute path": withArgs({ paths: ["/abs/a"] }),
        "an empty segment": withArgs({ paths: ["a//b"] }),
        "a dot segment": withArgs({ paths: ["a/./b"] }),
        "a parent segment": withArgs({ paths: ["a/../b"] }),
        "a .git segment": withArgs({ paths: ["a/.Git/b"] }),
        "a backslash": withArgs({ paths: ["a\\b"] }),
        "a control character": withArgs({ paths: ["a\tb"] }),
        "a path of 1025 characters": withArgs({ paths: ["x".repeat(1025)] }),
      };
      for (const [what, job] of Object.entries(forged)) await expect(issueSql(r, job), what).rejects.toMatchObject({ code: "42501" });
      expect(await issueSql(r, good)).toEqual([{ o_result: "ok" }]);
      expect(await issueSql(r, withArgs({ paths: ["a/.gitignore", "docs/.github.md", "x".repeat(1024)] }))).toEqual([{ o_result: "ok" }]);
      // the same valid bytes, from a member, from a runner's session or from a login with no person and no account
      await expect(issueSql(r, good, { user: r.memberUser })).rejects.toMatchObject({ code: "42501" });
      await expect(issueSql(r, good, { runner: r.runnerId })).rejects.toMatchObject({ code: "42501" });
      expect(await issueSql(r, good, { user: null })).toEqual([{ o_result: "ok" }]);
    });

    it("answers by the twin's state: only a ready, seeded twin with no sync pull request is synced", async () => {
      for (const state of ["creating", "not_connected", "seeding", "paused", "conflict", "refused", "failed", "removed"]) {
        const r = await rig({ state });
        expect(await failureOf(() => issue(r)), state).toMatchObject({ status: state === "removed" ? 404 : 409 });
        expect(await jobRows(r.setupId), state).toEqual([]);
      }
      const unseeded = await rig({ synced: null });
      expect(await failureOf(() => issue(unseeded))).toEqual({ status: 409, code: "twin_state" });
      const open = await rig({ pr: 7 });
      expect(await failureOf(() => issue(open))).toEqual({ status: 409, code: "sync_open" });
    });

    it("needs the twin's setup, its placement on a live machine and both tips on GitHub, and only a public main", async () => {
      const noSetup = await rig({ setup: false });
      expect(await failureOf(() => issue(noSetup))).toEqual({ status: 409, code: "setup_not_found" });
      const unplaced = await rig({ placed: false });
      expect(await failureOf(() => issue(unplaced))).toEqual({ status: 409, code: "setup_not_placed" });
      const r = await rig();
      expect(await failureOf(() => issue(r, { deps: depsFor({ pullRequests: github({ "acme/widgets-private": PRIV_TIP }) }) }))).toEqual({ status: 503, code: "github_unavailable" });
      expect(await failureOf(() => issue(r, { deps: depsFor({ pullRequests: github({ "acme/widgets-private": null, "acme/widgets": PUB_TIP }) }) }))).toEqual({ status: 409, code: "default_branch_empty" });
      expect(await failureOf(() => issue(r, { deps: depsFor({ pullRequests: github({ "acme/widgets-private": PRIV_TIP, "acme/widgets": null }) }) }))).toEqual({ status: 409, code: "default_branch_empty" });
      expect(await failureOf(() => issue(r, { deps: depsFor({ pullRequests: github(TIPS, [], { "acme/widgets": "develop" }) }) }))).toEqual({ status: 409, code: "public_default_branch_not_main" });
      expect(await failureOf(() => issue(r, { deps: depsFor({ pullRequests: null }) }))).toEqual({ status: 503, code: "not_configured" });
      expect(await jobRows(r.setupId)).toEqual([]);
    });

    it("is tenant-scoped: another account's person, and the app login with a foreign account, find no such twin", async () => {
      const a = await rig();
      const b = await rig();
      expect(await failureOf(() => issueTwinSync(depsFor(), principal(b), a.twinId, PATHS))).toEqual({ status: 404, code: "not_found" });
      expect(await call("SELECT o_result FROM twin_sync_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now() + interval '1 minute')", [a.twinId, randomUUID()], b)).toEqual([{ o_result: "not_found" }]);
      expect(await jobRows(a.setupId)).toEqual([]);
      await issue(a);
      expect(await jobRows(b.setupId)).toEqual([]);
      expect(await twinRow(b.twinId)).toMatchObject({ state: "ready", sync_head: null });
    });
  });

  describe("the definers answer by the rows themselves, whatever the cloud checked before", () => {
    const answer = async (r: Rig, job: Record<string, unknown> = goodJob(r)) => (await issueSql(r, job))[0];
    it("the issue answers bad_state, sync_open, repo_unnamed, no_setup, not_placed and job_live by the twin's own rows", async () => {
      for (const state of ["creating", "not_connected", "seeding", "paused", "conflict", "refused", "failed", "removed"]) expect(await answer(await rig({ state })), state).toEqual({ o_result: "bad_state" });
      expect(await answer(await rig({ synced: null }))).toEqual({ o_result: "bad_state" });
      expect(await answer(await rig({ pr: 7 }))).toEqual({ o_result: "sync_open" });
      const unnamedPublic = await rig();
      await h.admin.query("UPDATE repos SET gh_name = NULL WHERE id = $1", [unnamedPublic.publicId]);
      expect(await answer(unnamedPublic)).toEqual({ o_result: "repo_unnamed" });
      const unnamedPrivate = await rig();
      await h.admin.query("UPDATE repos SET gh_owner = NULL WHERE id = $1", [unnamedPrivate.privateId]);
      expect(await answer(unnamedPrivate)).toEqual({ o_result: "repo_unnamed" });
      expect(await answer(await rig({ setup: false }))).toEqual({ o_result: "no_setup" });
      expect(await answer(await rig({ placed: false }))).toEqual({ o_result: "not_placed" });
      const revoked = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked.runnerId]);
      expect(await answer(revoked)).toEqual({ o_result: "not_placed" });
      expect(await answer(await rig({ synced: PUB_TIP }))).toEqual({ o_result: "in_sync" });
      // a job live on the twin's repository, of any kind, and a finished sync whose head is not yet turned into a pull request, each keep the next from being issued
      const live = await rig();
      await issued(live);
      expect(await answer(live)).toEqual({ o_result: "job_live" });
      const waiting = await rig();
      await finished(waiting);
      expect(await answer(waiting)).toEqual({ o_result: "job_live" });
      await h.admin.query("UPDATE repo_twins SET sync_head = NULL WHERE id = $1", [waiting.twinId]);
      expect(await answer(waiting)).toEqual({ o_result: "ok" });
    });

    it("the next attempt of a setup counts the jobs the setup already had", async () => {
      const r = await rig();
      const first = await started(r);
      await h.admin.query("UPDATE machine_jobs SET state = 'failed', ended_at = now() WHERE id = $1", [first]);
      expect((await issue(r)).outcome).toBe("issued");
      expect((await jobRows(r.setupId)).map((j) => j.attempt)).toEqual([1, 2]);
    });

    it("the runner's job is fenced by the rows: a newer attempt, a job marked superseded, a job over three hours old, a job that went quiet and one never reported on are not active", async () => {
      const cases: Array<[string, (r: Rig, jobId: string) => Promise<void>, string]> = [
        ["a newer attempt", async (_r, jobId) => void (await h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at) SELECT $2::uuid, account_id, runner_id, repo_id, setup_id, kind, jsonb_set(job, '{job,job_id}', to_jsonb($2::text)), attempt + 1, issued_at, expires_at FROM machine_jobs WHERE id = $1", [jobId, randomUUID()])), "job_superseded"],
        ["superseded", async (_r, jobId) => void (await h.admin.query("UPDATE machine_jobs SET state = 'superseded' WHERE id = $1", [jobId])), "job_superseded"],
        ["over three hours", async (_r, jobId) => void (await h.admin.query("UPDATE machine_jobs SET delivered_at = now() - interval '4 hours' WHERE id = $1", [jobId])), "job_not_active"],
        ["quiet", async (_r, jobId) => void (await h.admin.query("UPDATE machine_jobs SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [jobId])), "job_not_active"],
        ["not delivered any more", async (_r, jobId) => void (await h.admin.query("UPDATE machine_jobs SET state = 'failed', ended_at = now() WHERE id = $1", [jobId])), "job_not_active"],
      ];
      for (const [what, undo, code] of cases) {
        const r = await rig();
        const jobId = await started(r);
        await progress(r, jobId, { sub_step: "twin_fetch", state: "started" });
        await undo(r, jobId);
        expect(await progress(r, jobId, { sub_step: "twin_fetch", state: "ok" }), what).toMatchObject({ status: 409, body: { error: { code } } });
      }
      // a job nothing was reported on whose time ran out
      const unreported = await rig();
      const jobId = await started(unreported);
      const stamp = (expr: string) => `to_jsonb(to_char((${expr}) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`;
      await h.admin.query(`UPDATE machine_jobs SET issued_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute', job = jsonb_set(jsonb_set(job, '{job,issued_at}', ${stamp("now() - interval '2 minutes'")}), '{job,expires_at}', ${stamp("now() - interval '1 minute'")}) WHERE id = $1`, [jobId]);
      expect(await progress(unreported, jobId, { sub_step: "twin_fetch", state: "started" })).toMatchObject({ status: 409 });
    });
  });

  describe("the runner's functions and the check's, called directly", () => {
    const asRunner = (r: Rig) => ({ runner: r.runnerId, user: null as string | null });
    /** A copy of the job's row as another kind of job, a failed one, one attempt newer: what a later job of the same setup looks like. */
    async function newerOtherJob(jobId: string, kind: string): Promise<string> {
      const id = randomUUID();
      await h.admin.query("DROP TABLE IF EXISTS fx_copy");
      await h.admin.query("CREATE TEMP TABLE fx_copy AS SELECT * FROM machine_jobs WHERE id = $1", [jobId]);
      await h.admin.query("UPDATE fx_copy SET id = $1::uuid, kind = $2::text, attempt = attempt + 1, state = 'failed', ended_at = now(), job = jsonb_set(jsonb_set(job, '{job,job_id}', to_jsonb($1::text)), '{job,kind}', to_jsonb($2::text))", [id, kind]);
      const cols = (await h.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'machine_jobs' AND table_schema = 'public' AND is_generated = 'NEVER' ORDER BY ordinal_position")).rows.map((c) => `"${c.column_name}"`).join(", ");
      await h.admin.query(`INSERT INTO machine_jobs (${cols}) SELECT ${cols} FROM fx_copy`);
      await h.admin.query("DROP TABLE fx_copy");
      return id;
    }

    it("the lock finds a job only for its own kind, setup and twin", async () => {
      const a = await rig();
      const b = await sibling(a);
      const jobId = await started(a);
      await reportedToPush(a, jobId);
      const grant = (setup: string, job: string) => call("SELECT o_result FROM twin_sync_push_grant($1::uuid, $2::uuid)", [setup, job], a, asRunner(a));
      // another setup's id for this job
      expect(await grant(b.setupId, jobId)).toEqual([{ o_result: "not_found" }]);
      // a job whose signed twin id names the sibling is the sibling's twin's job, not this one's
      await h.admin.query("UPDATE machine_jobs SET job = jsonb_set(job, '{job,args,twin_id}', to_jsonb($2::text)) WHERE id = $1", [jobId, b.twinId]);
      expect(await grant(a.setupId, jobId)).toEqual([{ o_result: "not_found" }]);
      await h.admin.query("UPDATE machine_jobs SET job = jsonb_set(job, '{job,args,twin_id}', to_jsonb($2::text)) WHERE id = $1", [jobId, a.twinId]);
      // another kind of job under this setup, which the lock must not take for a sync (it would answer not_active, not not_found)
      const other = await newerOtherJob(jobId, "twin_publish");
      expect(await grant(a.setupId, other)).toEqual([{ o_result: "not_found" }]);
    });

    it("the head is a commit id, or nothing is recorded", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect((await token(r, jobId)).status).toBe(200);
      for (const bad of ["xyz", "E".repeat(40), "e".repeat(39)]) expect(await call("SELECT twin_sync_head_record($1::uuid, $2::uuid, $3) AS ok", [r.setupId, jobId, bad], r, asRunner(r)), bad).toEqual([{ ok: false }]);
      expect(await call("SELECT twin_sync_head_record($1::uuid, $2::uuid, NULL) AS ok", [r.setupId, jobId], r, asRunner(r))).toEqual([{ ok: false }]);
    });

    it("the read and the record of the check refuse a runner's session and a member, and answer only what is waiting, by the twin's own rows", async () => {
      const r = await rig();
      await finished(r);
      for (const sql of ["SELECT o_repo_id FROM twin_sync_to_verify($1::uuid)", "SELECT o_result FROM twin_sync_check($1::uuid, true)"]) {
        await expect(call(sql, [r.twinId], r, { runner: r.runnerId }), sql).rejects.toMatchObject({ code: "42501" });
        await expect(call(sql, [r.twinId], r, { user: r.memberUser }), sql).rejects.toMatchObject({ code: "42501" });
      }
      const waiting = async () => [(await call("SELECT o_repo_id FROM twin_sync_to_verify($1::uuid)", [r.twinId], r)).length, (await call<{ o_result: string }>("SELECT o_result FROM twin_sync_check($1::uuid, true)", [r.twinId], r))[0]!.o_result] as const;
      expect(await waiting()).toEqual([1, "verified"]);
      // a newer job of another kind under the same setup does not hide it
      await newerOtherJob((await jobRows(r.setupId))[0]!.id, "twin_publish");
      expect(await waiting()).toEqual([1, "verified"]);
      const undo: Array<[string, string, string]> = [
        ["a twin that is not ready", "UPDATE repo_twins SET state = 'paused' WHERE id = $1", "UPDATE repo_twins SET state = 'ready' WHERE id = $1"],
        ["an open sync pull request", "UPDATE repo_twins SET sync_pr = 7 WHERE id = $1", "UPDATE repo_twins SET sync_pr = NULL WHERE id = $1"],
        ["no pushed head", "UPDATE repo_twins SET sync_head = NULL WHERE id = $1", `UPDATE repo_twins SET sync_head = '${PUSHED}' WHERE id = $1`],
        ["a head already verified", "UPDATE repo_twins SET sync_verified_at = now() WHERE id = $1", "UPDATE repo_twins SET sync_verified_at = NULL WHERE id = $1"],
      ];
      for (const [what, sql, restore] of undo) {
        await h.admin.query(sql, [r.twinId]);
        expect(await waiting(), what).toEqual([0, "not_ready"]);
        await h.admin.query(restore, [r.twinId]);
      }
      expect(await waiting()).toEqual([1, "verified"]);
      await h.admin.query("UPDATE machine_jobs SET state = 'failed' WHERE setup_id = $1 AND kind = 'twin_sync'", [r.setupId]);
      expect(await waiting()).toEqual([0, "not_ready"]);
    });
  });

  describe("the push-token route, for the twin", () => {
    it("hands over one credential only after the fetch was reported and the push began, for the TWIN alone and never the public repository, and never again", async () => {
      const r = await rig();
      const jobId = await started(r);
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "push_not_started" } } });
      await reportedToPush(r, jobId);
      mints.length = 0;
      const got = await token(r, jobId);
      expect(got.status).toBe(200);
      expect(got.headers?.["cache-control"]).toBe("no-store");
      expect(SetupPushTokenReply.parse(got.body).token).toBe(TOKEN);
      expect(mints).toEqual([{ id: r.privateId, owner: "acme", name: "widgets-private" }]);
      expect(hostedMints).toEqual([]);
      expect(await token(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "already_issued" } } });
      expect(mints).toHaveLength(1);
      for (const table of ["machine_jobs", "repo_twins", "project_setups", "audit_log"]) expect(JSON.stringify((await h.admin.query(`SELECT t.* FROM ${table} t`)).rows)).not.toContain(TOKEN);
    });

    it("mints nothing once the private set is no longer the signed one (pairing_changed), and the job can still go on when it is again", async () => {
      const edits: Record<string, string> = {
        "a glob was added": "UPDATE repo_twins SET overlay_globs = overlay_globs || ARRAY['src/**'] WHERE id = $1",
        "a glob was removed": "UPDATE repo_twins SET overlay_globs = '{}' WHERE id = $1",
        "an install path was added": "UPDATE repo_twins SET install_paths = install_paths || ARRAY['extra.yml'] WHERE id = $1",
        "a rule file was declared": "UPDATE repo_twins SET plan_data_rules_path = '.autonomous-team/plan.txt' WHERE id = $1",
        "the binary allow list grew": "UPDATE repo_twins SET binary_globs = '{assets/**}' WHERE id = $1",
      };
      for (const [what, sql] of Object.entries(edits)) {
        const r = await rig();
        const jobId = await started(r);
        await reportedToPush(r, jobId);
        await h.admin.query(sql, [r.twinId]);
        mints.length = 0;
        expect(await token(r, jobId), what).toMatchObject({ status: 409, body: { error: { code: "pairing_changed" } } });
        expect(mints, what).toEqual([]);
        expect((await jobRows(r.setupId))[0]!.push_token_at, what).toBeNull();
      }
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
      for (const state of ["paused", "refused", "removed"]) {
        await h.admin.query("UPDATE repo_twins SET state = $2, removed_at = CASE WHEN $2 = 'removed' THEN now() END WHERE id = $1", [r.twinId, state]);
        expect((await token(r, jobId)).status, state).toBe(404);
      }
      await h.admin.query("UPDATE repo_twins SET state = 'ready', removed_at = NULL WHERE id = $1", [r.twinId]);
      expect((await token(r, jobId)).status).toBe(200);
    });
  });

  describe("the reports", () => {
    it("the push ok carries the commit once the credential was handed out, records it, and ends the job done", async () => {
      const r = await rig();
      const jobId = await started(r);
      await reportedToPush(r, jobId);
      expect(await pushed(r, jobId)).toMatchObject({ status: 409, body: { error: { code: "head_not_recorded" } } });
      expect((await token(r, jobId)).status).toBe(200);
      expect((await pushed(r, jobId)).status).toBe(200);
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "done" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", sync_head: PUSHED, verified: false, sync_pr: null, synced_public_sha: SYNCED });
      expect(await progress(r, jobId, { sub_step: "push", state: "started" })).toMatchObject({ status: 409 });
      // a finished sync that has not been checked keeps the twin from a second one
      expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "sync_live" });
    });

    it("a refusal refuses the twin with its code and one reason word; the job fails and the setup is untouched", async () => {
      for (const code of ["private_path_change", "sync_unsafe_path", "branch_exists", "twin_too_large", "bad_input"]) {
        const r = await rig();
        const jobId = await started(r);
        await reportedToPush(r, jobId);
        expect((await progress(r, jobId, { sub_step: "push", state: "failed", failure_code: code, failure_reason: "private" })).status, code).toBe(200);
        expect(await twinRow(r.twinId), code).toMatchObject({ state: "refused", failure_code: code, failure_reason: "private", synced_public_sha: SYNCED });
        expect((await jobRows(r.setupId))[0], code).toMatchObject({ state: "failed" });
        expect(await setupRow(r.setupId)).toMatchObject({ phase: "done", failure_code: null });
        expect((await progress(r, jobId, { sub_step: "push", state: "started" })).status).toBe(404);
        expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "twin_state" });
      }
    });

    it("a transient failure leaves the twin ready with the code on it, so the next pass issues again", async () => {
      for (const code of ["public_unavailable", "public_tip_moved", "private_tip_moved", "pairing_changed", "twin_fetch_failed", "push_failed", "kind_unsupported"]) {
        const r = await rig();
        const jobId = await started(r);
        expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "failed", failure_code: code })).status, code).toBe(200);
        expect(await twinRow(r.twinId), code).toMatchObject({ state: "ready", failure_code: code, synced_public_sha: SYNCED });
        expect((await issue(r)).outcome, code).toBe("issued");
      }
    });

    it("no_changes (what the twin published came back) ends the job done and moves the sync anchor to the job's public tip, with nothing to check", async () => {
      const r = await rig();
      const jobId = await started(r);
      expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "failed", failure_code: "no_changes", failure_reason: "equal" })).status).toBe(200);
      expect((await jobRows(r.setupId))[0]).toMatchObject({ state: "done" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", synced_public_sha: PUB_TIP, failure_code: null, sync_head: null });
      expect(await checkTwinSync(depsFor(), principal(r), r.twinId)).toBe("not_ready");
      expect(await issue(r)).toEqual({ outcome: "in_sync" });
    });

    it("refuses a code that is not a sync's (a seed's, a publish's, an install's), a step that is not its own, and a seq that does not climb", async () => {
      const r = await rig();
      const jobId = await started(r);
      for (const code of ["twin_head_moved", "scan_refused", "base_not_ancestor", "bundle_refused", "missing_topic:interview"]) expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "failed", failure_code: code })).status, code).toBe(400);
      for (const step of ["engine_fetch", "gh_labels", "pr_open"]) expect((await progress(r, jobId, { sub_step: step, state: "ok" })).status, step).toBe(400);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", failure_code: null });
      expect((await progress(r, jobId, { sub_step: "twin_fetch", state: "started" })).status).toBe(200);
      const stale = await respond(() => setupProgressRun(depsFor(), signed(r.key, setupProgressPath(r.setupId), { job_id: jobId, seq: 0, sub_step: "twin_fetch", state: "ok" }), r.setupId));
      expect(stale).toMatchObject({ status: 409, body: { error: { code: "seq_not_increasing" } } });
    });

    it("a quiet sync job expires without failing the twin or its setup, and the next pass issues again", async () => {
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
    const check = (r: Rig, over: Partial<RunnerCloudDeps> = {}, who: { accountId: string; userId: string | null } = principal(r)) => checkTwinSync(depsFor(over), who, r.twinId);

    it("reads the twin's own branch and the pushed commit's parents, and marks the head verified once", async () => {
      const r = await rig();
      await finished(r);
      const asked: unknown[] = [];
      expect(await check(r, { setupInstall: install({}, asked) })).toBe("verified");
      expect(asked).toEqual([
        { repo: { id: r.privateId, owner: "acme", name: "widgets-private" }, branch: BRANCH, base: BRANCH },
        { repo: { id: r.privateId, owner: "acme", name: "widgets-private" }, sha: PUSHED },
      ]);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", sync_head: PUSHED, verified: true, sync_pr: null, failure_code: null });
      expect(await check(r)).toBe("not_ready");
      expect(await check(r, {}, principal(r, null))).toBe("not_ready");
    });

    it("refuses the twin (head_unconfirmed) when GitHub shows another head, no branch, a merge commit, another parent or none", async () => {
      const wrong: Array<[string, Parameters<typeof install>[0]]> = [
        ["another head", { head: "9".repeat(40) }],
        ["no branch", { head: null }],
        ["a merge commit", { parents: [PRIV_TIP, "8".repeat(40)] }],
        ["another parent", { parents: ["8".repeat(40)] }],
        ["no commit", { parents: null }],
        ["no parent", { parents: [] }],
      ];
      for (const [what, o] of wrong) {
        const r = await rig();
        await finished(r);
        expect(await check(r, { setupInstall: install(o) }), what).toBe("refused");
        expect(await twinRow(r.twinId), what).toMatchObject({ state: "refused", failure_code: "head_unconfirmed", sync_head: null, verified: false });
      }
    });

    it("leaves the twin where it is when GitHub cannot be asked, and when no port is configured", async () => {
      const r = await rig();
      await finished(r);
      expect(await check(r, { setupInstall: install({ throws: new RunPullRequestError("unavailable", 503) }) })).toBe("github_unavailable");
      expect(await check(r, { setupInstall: null })).toBe("github_unavailable");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", sync_head: PUSHED, verified: false });
      await expect(check(r, { setupInstall: install({ throws: new Error("a bug") }) })).rejects.toThrow("a bug");
      expect(await check(r)).toBe("verified");
    });

    it("has nothing to check before a push, after a failure, for a twin that is not ready, or for a member; the definers refuse a bad argument", async () => {
      const r = await rig();
      expect(await check(r)).toBe("not_ready");
      const jobId = await started(r);
      expect(await check(r)).toBe("not_ready");
      await reportedToPush(r, jobId);
      expect((await token(r, jobId)).status).toBe(200);
      expect((await pushed(r, jobId)).status).toBe(200);
      await h.admin.query("UPDATE repo_twins SET state = 'paused' WHERE id = $1", [r.twinId]);
      expect(await check(r)).toBe("not_ready");
      await h.admin.query("UPDATE repo_twins SET state = 'ready' WHERE id = $1", [r.twinId]);
      await expect(check(r, {}, principal(r, r.memberUser))).rejects.toMatchObject({ code: "42501" });
      await expect(call("SELECT o_result FROM twin_sync_check($1::uuid, NULL)", [r.twinId], r)).rejects.toMatchObject({ code: "22023" });
      expect(await check(r)).toBe("verified");
      expect(await checkTwinSync(depsFor(), principal(r), randomUUID())).toBe("not_ready");
      expect(await call("SELECT o_result FROM twin_sync_check($1::uuid, true)", [randomUUID()], r)).toEqual([{ o_result: "not_found" }]);
    });
  });

  describe("a second twin of the same account", () => {
    it("is never touched by the first twin's issue, token, reports or check, and never touches it", async () => {
      const a = await rig();
      const b = await sibling(a);
      const jobA = await finished(a);
      expect(await jobRows(b.setupId)).toEqual([]);
      expect(await twinRow(b.twinId)).toMatchObject({ state: "ready", sync_head: null, verified: false });
      // the sibling's own sync, finished after the first's, is checked against ITS OWN branch and repository
      const jobB = await finished(b);
      expect((await jobRows(b.setupId))[0]).toMatchObject({ repo_id: b.privateId, state: "done" });
      const seen: unknown[] = [];
      expect(await checkTwinSync(depsFor({ setupInstall: install({}, seen) }), principal(a), a.twinId)).toBe("verified");
      expect(JSON.stringify(seen)).toContain(a.privateId);
      expect(JSON.stringify(seen)).not.toContain(b.privateId);
      expect(await twinRow(a.twinId)).toMatchObject({ verified: true });
      expect(await twinRow(b.twinId)).toMatchObject({ sync_head: PUSHED, verified: false });
      expect(await checkTwinSync(depsFor({ setupInstall: install({ head: null }) }), principal(b), b.twinId)).toBe("refused");
      expect(await twinRow(a.twinId)).toMatchObject({ state: "ready", sync_head: PUSHED, verified: true });
      // the first twin's job id on the sibling's setup finds nothing, and the sibling's key cannot report on it
      expect((await token(b, jobA)).status).toBe(404);
      expect((await token(a, jobA, { key: b.key })).status).toBe(404);
      expect(jobB).not.toBe(jobA);
    });

    it("a job forged onto one twin's repository and setup that names the sibling's twin is refused, in every place the sibling's rows could stand in", async () => {
      const a = await rig();
      const b = await sibling(a);
      const forged = goodJob(a);
      (forged["args"] as { twin_id: string }).twin_id = b.twinId;
      await expect(issueSql(a, forged)).rejects.toMatchObject({ code: "42501" });
      // the sibling's twin called with a's job: its repository and setup are not a's
      expect(await call("SELECT o_result FROM twin_sync_issue($1::uuid, $2::uuid, $3::jsonb, now(), now() + interval '1 minute')", [b.twinId, randomUUID(), JSON.stringify({ job: goodJob(a) })], b).catch((e: { code?: string }) => e.code)).toBe("42501");
      expect(await jobRows(a.setupId)).toEqual([]);
      expect(await jobRows(b.setupId)).toEqual([]);
    });

    it("holds on the explicit account predicates alone: with row security off on every table the functions read, a foreign account still finds no twin to issue, verify or check", async () => {
      const a = await rig();
      const b = await rig();
      await finished(a);
      const tables = ["repo_twins", "repos", "project_setups", "project_placements", "machine_jobs", "runners", "account_members"];
      const asForeign = async <T>(sql: string, args: unknown[]): Promise<T[]> => {
        const c = await h.adminPool.connect();
        try {
          await c.query("BEGIN");
          for (const t of tables) await c.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
          await c.query("SET LOCAL ROLE app_user");
          await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [b.who.accountId, b.adminUser]);
          return (await c.query(sql, args)).rows as T[];
        } finally {
          await c.query("ROLLBACK");
          c.release();
        }
      };
      // the same call, as the twin's own account, with row security off, does find it (so the empty answers below are the predicates' and not the setup's)
      expect(await call("SELECT o_result FROM twin_sync_check($1::uuid, true)", [a.twinId], a)).toEqual([{ o_result: "verified" }]);
      expect(await asForeign("SELECT o_result FROM twin_sync_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now() + interval '1 minute')", [a.twinId, randomUUID()])).toEqual([{ o_result: "not_found" }]);
      expect(await asForeign("SELECT o_repo_id FROM twin_sync_to_verify($1::uuid)", [a.twinId])).toEqual([]);
      expect(await asForeign("SELECT o_result FROM twin_sync_check($1::uuid, true)", [a.twinId])).toEqual([{ o_result: "not_found" }]);
      expect(await twinRow(a.twinId)).toMatchObject({ sync_head: PUSHED, verified: false });
    });

    it("the app login with a foreign account reads and writes nothing of the twin's through any of the functions", async () => {
      const a = await rig();
      const b = await rig();
      const jobId = await finished(a);
      const asB = { account: b.who.accountId, user: b.adminUser };
      expect(await call("SELECT o_repo_id FROM twin_sync_to_verify($1::uuid)", [a.twinId], a, asB)).toEqual([]);
      expect(await call("SELECT o_result FROM twin_sync_check($1::uuid, true)", [a.twinId], a, asB)).toEqual([{ o_result: "not_found" }]);
      expect(await call("SELECT o_result FROM twin_sync_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now())", [a.twinId, randomUUID()], a, asB)).toEqual([{ o_result: "not_found" }]);
      // the runner's functions with another account's session: no job, no twin
      const asRunner = async (sql: string, args: unknown[]) => call(sql, args, a, { account: b.who.accountId, user: null });
      expect(await asRunner("SELECT o_result FROM twin_sync_push_grant($1::uuid, $2::uuid)", [a.setupId, jobId])).toEqual([{ o_result: "not_found" }]);
      expect(await asRunner("SELECT twin_sync_head_record($1::uuid, $2::uuid, $3) AS ok", [a.setupId, jobId, PUSHED])).toEqual([{ ok: false }]);
      expect(await asRunner("SELECT o_result FROM twin_sync_progress_record($1::uuid, $2::uuid, 99, 'push', 'started', NULL, NULL)", [a.setupId, jobId])).toEqual([{ o_result: "not_found" }]);
      expect(await twinRow(a.twinId)).toMatchObject({ sync_head: PUSHED, verified: false });
    });
  });
});
