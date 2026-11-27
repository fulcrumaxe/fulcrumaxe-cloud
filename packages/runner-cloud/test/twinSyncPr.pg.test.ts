import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, MachineJobClaimReply, setupProgressPath, setupPushTokenPath, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { LocalOnlyGithubError } from "../src/localOnlyGithub.js";
import { HELLO_PATH, RunnerHttpError, RunPullRequestError, checkTwinPublish, checkTwinSync, closeTwinSyncPr, issueTwinPublish, issueTwinSync, machineJobClaimRun, openTwinSyncPr, runnerHello, setupProgressRun, setupPushTokenRun, type PlanePushHostedPort, type RunnerCloudDeps, type RunPullRequestPort, type SetupInstallPort } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const TOKEN = "ghs_sentinel_twin_sync_token_0123456789abc";
const SYNCED = "a".repeat(40);
const PUB_TIP = "b".repeat(40);
const PRIV_TIP = "c".repeat(40);
const PUSHED = "e".repeat(40);
const BRANCH = `fx/twin-sync-${PUB_TIP.slice(0, 12)}`;
const PATHS = ["src/new.ts", "docs/guide.md"];

/**
 * [pg] D#845 ON-27d3 (migration 1115): the sync pull request, the watch on it, the removal and the update of an open publish pull request, on top of ON-27d2's rig (1111) and ON-27c2's (1110), over the real signed HTTP path, real Ed25519 job signatures, the real SECURITY DEFINER functions as the runner and the app login, and row security forced.
 * GitHub is a fake that enforces what the real port does for these calls (one token per repository, fixed shapes of answer). What it cannot show: GitHub's own rate limits and permission model, and the push itself (the runner's test).
 */
describe("twin sync pull request and publish update [pg]", () => {
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
    h.deps({ repoVisibility: async () => "private", setupPush: setupPort(), planePush: hosted(), pullRequests: github(TIPS), setupInstall: install(), engineCommandSigner: async () => ({ keyId: "k1", signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", jobKeys.privateKey) }) as never, ...over });

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

  // ---- what ON-27d3 adds: the sync pull request, the watch on it, the removal, and the update of an open publish pull request ----------------------------------

  interface Pr { number: number; branch: string; headSha: string; draft: boolean; labels: string[]; title: string; body: string; state: "open" | "closed" }
  /** The twin's GitHub as the open step sees it. A pull request is keyed by its branch (a second open of a branch finds the first, as the real port does), shows its files, and takes a label only once it exists. */
  function twinGithub(o: { head?: string | null; prHead?: string; files?: string[]; complete?: boolean; changes?: Array<{ path: string; previousPath: string | null; status: string }>; changesComplete?: boolean; failAt?: string; failWith?: unknown } = {}) {
    const prs: Pr[] = [];
    const calls: string[] = [];
    const step = (name: string): void => {
      calls.push(name);
      if (o.failAt === name) throw o.failWith ?? new RunPullRequestError("unavailable", 503);
    };
    const byNumber = (n: number): Pr => prs.find((p) => p.number === n)!;
    const port = {
      defaultBranch: async () => "trunk",
      branchState: async () => {
        step("branchState");
        const head = o.head === undefined ? PUSHED : o.head;
        return { exists: head !== null, headOid: head, aheadBy: 1, defaultBranch: "trunk" };
      },
      commitParents: async () => [PRIV_TIP],
      openDraft: async ({ branch, text }: { branch: string; text: { title: string; body: string } }) => {
        step("openDraft");
        const found = prs.find((p) => p.branch === branch && p.state === "open");
        if (found) return { number: found.number, nodeId: `n${found.number}`, draft: found.draft, reused: true, headSha: found.headSha };
        const made: Pr = { number: 40 + prs.length, branch, headSha: o.prHead ?? PUSHED, draft: true, labels: [], title: text.title, body: text.body, state: "open" };
        prs.push(made);
        return { number: made.number, nodeId: `n${made.number}`, draft: true, reused: false, headSha: made.headSha };
      },
      changedFiles: async () => {
        step("changedFiles");
        const files = (o.files ?? PATHS).map((path) => ({ path, changeType: "MODIFIED" }));
        return { files, totalCount: files.length, complete: o.complete ?? true };
      },
      /** REST compare of the verified commit against its base: by default exactly the signed paths, each modified. */
      commitChanges: async () => {
        step("commitChanges");
        return { files: o.changes ?? (o.files ?? PATHS).map((path) => ({ path, previousPath: null, status: "modified" })), complete: o.changesComplete ?? true };
      },
      labelTwinSync: async ({ number }: { number: number }) => {
        step("labelTwinSync");
        byNumber(number).labels.push("fx-twin-sync");
      },
      markReady: async ({ pullRequest }: { pullRequest: { number: number } }) => {
        step("markReady");
        byNumber(pullRequest.number).draft = false;
      },
      close: async ({ number }: { number: number }) => {
        step("close");
        byNumber(number).state = "closed";
      },
    } as unknown as SetupInstallPort;
    return { port, prs, calls };
  }
  const authored = (logins: string[] | Error, asked: unknown[] = []) => ({ ...hosted(), commitAuthors: async (i: unknown) => (asked.push(i), logins instanceof Error ? Promise.reject(logins) : logins) }) as unknown as PlanePushHostedPort;
  const verified = async (r: Rig, gh: ReturnType<typeof twinGithub>): Promise<void> => {
    await finished(r);
    expect(await checkTwinSync(depsFor({ setupInstall: gh.port }), principal(r), r.twinId)).toBe("verified");
  };
  const open = (r: Rig, gh: ReturnType<typeof twinGithub>, over: Partial<RunnerCloudDeps> = {}, who: { accountId: string; userId: string | null } = principal(r)) => openTwinSyncPr(depsFor({ setupInstall: gh.port, ...over }), who, r.twinId);
  /** The App's `pull_request` delivery of the PRIVATE repository, in its own tenant session (no person), committed. */
  const webhook = async (account: string, repo: string, pr: number, merged: boolean, ref: string): Promise<string> => {
    const c = await h.appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.account_id', $1, true)", [account]);
      const out = (await c.query<{ r: string }>("SELECT twin_sync_pr_closed($1::uuid, $2::int, $3::boolean, $4) AS r", [repo, pr, merged, ref])).rows[0]!.r;
      await c.query("COMMIT");
      return out;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  };
  const hook = (r: Rig, pr: number, merged: boolean, ref = BRANCH) => webhook(r.who.accountId, r.privateId, pr, merged, ref);

  describe("who may call the functions", () => {
    const FUNCTIONS: Array<[string, string, string]> = [
      ["twin_sync_pr_target", "uuid", "SELECT * FROM twin_sync_pr_target($1::uuid)"],
      ["twin_sync_pr_record", "uuid, text, integer", "SELECT * FROM twin_sync_pr_record($1::uuid, $2, 3)"],
      ["twin_sync_pr_closed", "uuid, integer, boolean, text", "SELECT twin_sync_pr_closed($1::uuid, 3, true, $2)"],
      ["twin_sync_open_pr", "uuid", "SELECT * FROM twin_sync_open_pr($1::uuid)"],
      ["twin_publish_update_issue", "uuid, uuid, jsonb, timestamptz, timestamptz", "SELECT * FROM twin_publish_update_issue($1::uuid, gen_random_uuid(), '{}'::jsonb, now(), now())"],
    ];
    it("are owned by machine_jobs_owner, SECURITY DEFINER, closed to PUBLIC and to platform_ops, and open to app_user alone", async () => {
      for (const [name, args] of FUNCTIONS) {
        const row = (await h.admin.query("SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops, has_function_privilege(0::oid, p.oid, 'EXECUTE') AS everyone FROM pg_proc p WHERE p.oid = ($1)::regprocedure", [`public.${name}(${args})`])).rows[0];
        expect(row, name).toMatchObject({ owner: "machine_jobs_owner", definer: true, app: true, ops: false, everyone: false });
      }
    });

    it("refuse a member, a runner's session and a platform_ops login, whatever the twin; the webhook's close takes no person at all and no runner's", async () => {
      const r = await rig();
      for (const [name, , sql] of FUNCTIONS) {
        const args = name === "twin_sync_pr_closed" ? [r.privateId, BRANCH] : name === "twin_sync_pr_record" ? [r.twinId, PUSHED] : [r.twinId];
        if (name !== "twin_sync_pr_closed") await expect(call(sql, args, r, { user: r.memberUser }), `${name} as a member`).rejects.toMatchObject({ code: "42501" });
        if (name !== "twin_sync_pr_closed") await expect(call(sql, args, r, { runner: r.runnerId }), `${name} as a runner`).rejects.toMatchObject({ code: "42501" });
        await expect(h.opsPool.query(sql.replace("$2", "'x'"), name === "twin_sync_pr_closed" ? [r.privateId] : [r.twinId]), `${name} as platform_ops`).rejects.toMatchObject({ code: "42501" });
      }
      // an account with no session at all reads nothing and closes nothing
      const c = await h.appPool.connect();
      try {
        expect((await c.query("SELECT twin_sync_pr_closed($1::uuid, 3, true, $2) AS r", [r.privateId, BRANCH])).rows[0].r).toBe("none");
      } finally {
        c.release();
      }
    });
  });

  describe("the sync pull request", () => {
    it("opens it on the twin as a draft, holds its files to the signed paths, labels it, marks it ready and records its number; the pushed head is then forgotten", async () => {
      const r = await rig();
      const gh = twinGithub();
      await verified(r, gh);
      const before = gh.calls.length;
      const asked: unknown[] = [];
      expect(await open(r, gh, { planePush: authored(["alice", "dependabot[bot]"], asked) })).toBe("recorded");
      expect(gh.calls.slice(before)).toEqual(["branchState", "openDraft", "changedFiles", "commitChanges", "labelTwinSync", "markReady"]);
      expect(gh.prs).toHaveLength(1);
      expect(gh.prs[0]).toMatchObject({ branch: BRANCH, draft: false, labels: ["fx-twin-sync"], state: "open" });
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", sync_pr: 40, sync_head: null, verified: false, synced_public_sha: SYNCED });
      // public facts only: the public repository, the signed paths and the authors; nothing of the private side
      const text = `${gh.prs[0]!.title}\n${gh.prs[0]!.body}`;
      expect(text).toContain("acme/widgets");
      for (const p of PATHS) expect(text).toContain(p);
      expect(gh.prs[0]!.body).toContain("alice\ndependabot[bot]");
      for (const secret of ["widgets-private", r.twinId, r.privateId, PRIV_TIP, PUSHED]) expect(text).not.toContain(secret);
      expect(asked).toEqual([{ accountId: r.who.accountId, codeRepo: "acme/widgets", base: SYNCED, head: PUB_TIP }]);
    });

    it("opens no second pull request: a second pass has nothing waiting, and a pass after a GitHub failure reuses the one already open", async () => {
      const r = await rig();
      const failing = twinGithub({ failAt: "labelTwinSync" });
      await verified(r, failing);
      expect(await open(r, failing)).toBe("github_unavailable");
      expect(await twinRow(r.twinId)).toMatchObject({ sync_pr: null, sync_head: PUSHED, verified: true });
      // the same GitHub, healthy again (it keeps its pull requests): the open draft is found, not made again
      const healthy = twinGithub();
      healthy.prs.push(...failing.prs);
      expect(await open(r, healthy)).toBe("recorded");
      expect(healthy.prs).toHaveLength(1);
      expect(healthy.prs[0]).toMatchObject({ draft: false, labels: ["fx-twin-sync"] });
      expect(await open(r, healthy)).toBe("not_ready");
      expect(healthy.prs).toHaveLength(1);
    });

    it("closes the pull request and refuses the twin (head_unconfirmed) when it is not exactly what was verified: a file outside the signed paths, an incomplete or empty list, another head, a branch that moved", async () => {
      const wrong: Array<[string, Parameters<typeof twinGithub>[0], string[]]> = [
        ["a file the job did not name", { files: [...PATHS, "src/other.ts"] }, ["close"]],
        ["a path of the private set", { files: [".github/workflows/engine.yml"] }, ["close"]],
        ["an incomplete list", { complete: false }, ["close"]],
        ["no files", { files: [] }, ["close"]],
        ["another head", { prHead: "f".repeat(40) }, ["close"]],
      ];
      for (const [what, o, closed] of wrong) {
        const r = await rig();
        const gh = twinGithub(o);
        await verified(r, gh);
        const before = gh.calls.length;
        expect(await open(r, gh), what).toBe("refused");
        expect(gh.calls.slice(before), what).toContain(closed[0]);
        expect(gh.calls.slice(before), what).not.toContain("labelTwinSync");
        expect(gh.calls.slice(before), what).not.toContain("markReady");
        expect(gh.prs.map((p) => p.state), what).toEqual(["closed"]);
        expect(await twinRow(r.twinId), what).toMatchObject({ state: "refused", failure_code: "head_unconfirmed", sync_pr: null, sync_head: null, verified: false });
      }
      const r = await rig();
      const gh = twinGithub();
      await verified(r, gh);
      const moved = twinGithub({ head: "9".repeat(40) });
      expect(await open(r, moved)).toBe("refused");
      expect(moved.prs).toEqual([]);
    });

    describe("renames, unknown change types and the draft a refusal leaves behind", () => {
      /** The pull request GitHub shows lists a renamed file by its new path (GraphQL gives no old path); the verified commit's compare gives both. */
      const withRename = (previousPath: string, status = "renamed") => ({ files: PATHS, changes: [{ path: PATHS[0]!, previousPath, status }, { path: PATHS[1]!, previousPath: null, status: "modified" }] });
      const refusedWith = async (o: Parameters<typeof twinGithub>[0], what: string) => {
        const r = await rig();
        const gh = twinGithub(o);
        await verified(r, gh);
        const before = gh.calls.length;
        expect(await open(r, gh), what).toBe("refused");
        expect(gh.calls.slice(before), what).not.toContain("labelTwinSync");
        expect(gh.calls.slice(before), what).not.toContain("markReady");
        expect(gh.prs.map((p) => p.state), what).toEqual(["closed"]);
        expect(await twinRow(r.twinId), what).toMatchObject({ state: "refused", failure_code: "head_unconfirmed", sync_pr: null, sync_head: null, verified: false });
      };

      it("opens a pull request for a real rename whose old and new paths the job both named", async () => {
        const r = await rig();
        const gh = twinGithub(withRename(PATHS[1]!));
        await verified(r, gh);
        expect(await open(r, gh)).toBe("recorded");
        expect(gh.prs[0]).toMatchObject({ draft: false, labels: ["fx-twin-sync"], state: "open" });
      });

      it("closes the pull request when a rename's OLD path is one the job did not name (a delete folded into a named path), and for a private path as the old side", async () => {
        await refusedWith(withRename("src/unnamed-old.ts"), "an old path the job did not name");
        await refusedWith(withRename(".github/workflows/engine.yml"), "an old path of the private set");
        await refusedWith({ files: PATHS, changes: [{ path: PATHS[0]!, previousPath: "src/unnamed-old.ts", status: "copied" }, { path: PATHS[1]!, previousPath: null, status: "modified" }] }, "a copy from an unnamed path");
      });

      it("closes the pull request for a change type it does not know, a rename that names no old path, an old path on a plain change, an incomplete compare and an empty one", async () => {
        await refusedWith({ files: PATHS, changes: [{ path: PATHS[0]!, previousPath: null, status: "mystery" }, { path: PATHS[1]!, previousPath: null, status: "modified" }] }, "an unknown change type");
        await refusedWith({ files: PATHS, changes: [{ path: PATHS[0]!, previousPath: null, status: "renamed" }, { path: PATHS[1]!, previousPath: null, status: "modified" }] }, "a rename with no old path");
        await refusedWith({ files: PATHS, changes: [{ path: PATHS[0]!, previousPath: PATHS[1]!, status: "modified" }, { path: PATHS[1]!, previousPath: null, status: "modified" }] }, "an old path on a plain change");
        await refusedWith({ changesComplete: false }, "a compare that may be cut short");
        await refusedWith({ changes: [] }, "a compare with no change");
        await refusedWith({ changes: [{ path: "src/other.ts", previousPath: null, status: "added" }, ...PATHS.map((path) => ({ path, previousPath: null, status: "modified" }))] }, "a compare that shows a path the pull request does not");
      });

      it("closes the draft, best effort, when a call after it opened fails for good, for each of the three calls (and the compare), and leaves it for a failure a retry fixes", async () => {
        for (const failAt of ["changedFiles", "commitChanges", "labelTwinSync", "markReady"]) {
          for (const failWith of [new RunPullRequestError("rejected", 403), new LocalOnlyGithubError("not_allowlisted")]) {
            const r = await rig();
            const gh = twinGithub({ failAt, failWith });
            await verified(r, gh);
            const before = gh.calls.length;
            expect(await open(r, gh), `${failAt} ${failWith.name}`).toBe("refused");
            expect(gh.calls.slice(before), failAt).toContain("close");
            expect(gh.prs.map((p) => p.state), failAt).toEqual(["closed"]);
            expect(await twinRow(r.twinId), failAt).toMatchObject({ state: "refused", failure_code: "head_unconfirmed", sync_pr: null });
          }
          // a failure a retry fixes leaves the draft open, the twin ready and the head waiting: the next pass reuses it
          const r = await rig();
          const gh = twinGithub({ failAt, failWith: new RunPullRequestError("unavailable", 503) });
          await verified(r, gh);
          expect(await open(r, gh), failAt).toBe("github_unavailable");
          expect(gh.prs.map((p) => p.state), failAt).toEqual(["open"]);
          expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", sync_pr: null, sync_head: PUSHED, verified: true });
        }
      });

      it("a close that fails too does not hide the refusal, and a failure before any draft opened closes nothing", async () => {
        const r = await rig();
        const gh = twinGithub({ failAt: "labelTwinSync", failWith: new RunPullRequestError("rejected", 403) });
        const failingClose = gh.port.close.bind(gh.port);
        (gh.port as unknown as { close: unknown }).close = async (i: { repo: unknown; number: number }) => {
          await failingClose(i as never);
          throw new RunPullRequestError("rejected", 404);
        };
        await verified(r, gh);
        expect(await open(r, gh)).toBe("refused");
        expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "head_unconfirmed", sync_pr: null });
        const r2 = await rig();
        const early = twinGithub({ failAt: "openDraft", failWith: new RunPullRequestError("rejected", 422) });
        await verified(r2, early);
        expect(await open(r2, early)).toBe("refused");
        expect(early.calls).not.toContain("close");
      });
    });

    it("refuses on a failure no retry fixes, leaves the twin on one that does, and throws a bug", async () => {
      const r = await rig();
      await verified(r, twinGithub());
      expect(await open(r, twinGithub({ failAt: "openDraft", failWith: new RunPullRequestError("unavailable", 502) }))).toBe("github_unavailable");
      expect(await open(r, twinGithub(), { setupInstall: null })).toBe("github_unavailable");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", sync_head: PUSHED, verified: true });
      await expect(open(r, twinGithub({ failAt: "openDraft", failWith: new Error("a bug") }))).rejects.toThrow("a bug");
      expect(await open(r, twinGithub({ failAt: "openDraft", failWith: new RunPullRequestError("rejected", 422) }))).toBe("refused");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "head_unconfirmed", sync_head: null });
    });

    it("lists no authors when the public repository cannot be read for them, and still opens", async () => {
      const r = await rig();
      const gh = twinGithub();
      await verified(r, gh);
      expect(await open(r, gh, { planePush: authored(new Error("down")) })).toBe("recorded");
      expect(gh.prs[0]!.body).not.toContain("Authors:");
    });

    it("opens nothing for a pushed head the cloud has not verified yet, and does once it has", async () => {
      const r = await rig();
      const gh = twinGithub();
      await finished(r);
      expect(await open(r, gh)).toBe("not_ready");
      expect(gh.prs).toEqual([]);
      expect(gh.calls).toEqual([]);
      expect(await checkTwinSync(depsFor({ setupInstall: gh.port }), principal(r), r.twinId)).toBe("verified");
      expect(await open(r, gh)).toBe("recorded");
    });

    it("is for an owner or admin or the tick's session, and finds nothing for a foreign account, a twin that is not ready, or one with no verified head", async () => {
      const r = await rig();
      const gh = twinGithub();
      expect(await open(r, gh)).toBe("not_ready");
      await verified(r, gh);
      await expect(open(r, gh, {}, principal(r, r.memberUser))).rejects.toMatchObject({ code: "42501" });
      const other = await rig();
      expect(await openTwinSyncPr(depsFor({ setupInstall: gh.port }), principal(other), r.twinId)).toBe("not_ready");
      for (const state of ["paused", "conflict", "refused", "removed"]) {
        await h.admin.query("UPDATE repo_twins SET state = $2, removed_at = CASE WHEN $2 = 'removed' THEN now() END WHERE id = $1", [r.twinId, state]);
        expect(await open(r, gh), state).toBe("not_ready");
      }
      await h.admin.query("UPDATE repo_twins SET state = 'ready', removed_at = NULL WHERE id = $1", [r.twinId]);
      expect(gh.prs).toEqual([]);
      expect(await open(r, gh, {}, principal(r, null))).toBe("recorded");
      expect(await call("SELECT o_result FROM twin_sync_pr_record($1::uuid, $2, 3)", [randomUUID(), PUSHED], r)).toEqual([{ o_result: "not_found" }]);
      await expect(call("SELECT o_result FROM twin_sync_pr_record($1::uuid, 'main', 3)", [r.twinId], r)).rejects.toMatchObject({ code: "22023" });
      await expect(call("SELECT o_result FROM twin_sync_pr_record($1::uuid, $2, 0)", [r.twinId, PUSHED], r)).rejects.toMatchObject({ code: "22023" });
      await expect(h.opsPool.query("SELECT * FROM twin_sync_pr_target($1::uuid)", [r.twinId])).rejects.toMatchObject({ code: "42501" });
      await expect(call("SELECT * FROM twin_sync_pr_target($1::uuid)", [r.twinId], r, { runner: r.runnerId })).rejects.toMatchObject({ code: "42501" });
    });

    it("records a number only for the head that was verified, and not twice", async () => {
      const r = await rig();
      await verified(r, twinGithub());
      expect(await call("SELECT o_result FROM twin_sync_pr_record($1::uuid, $2, 5)", [r.twinId, "1".repeat(40)], r)).toEqual([{ o_result: "not_ready" }]);
      expect(await call("SELECT o_result FROM twin_sync_pr_record($1::uuid, $2, 5)", [r.twinId, PUSHED], r)).toEqual([{ o_result: "recorded" }]);
      await h.admin.query("UPDATE repo_twins SET sync_pr = 5 WHERE id = $1", [r.twinId]);
      expect(await call("SELECT o_result FROM twin_sync_pr_record($1::uuid, $2, 6)", [r.twinId, PUSHED], r)).toEqual([{ o_result: "not_ready" }]);
    });
  });

  describe("the merge and the close, in the webhook's session", () => {
    const withOpenPr = async (o: { state?: string } = {}): Promise<{ r: Rig; pr: number }> => {
      const r = await rig();
      const gh = twinGithub();
      await verified(r, gh);
      expect(await open(r, gh)).toBe("recorded");
      if (o.state !== undefined) await h.admin.query("UPDATE repo_twins SET state = $2 WHERE id = $1", [r.twinId, o.state]);
      return { r, pr: gh.prs[0]!.number };
    };

    it("a merged sync pull request advances synced_public_sha to the public tip the job brought in, and frees the twin for the next sync", async () => {
      const { r, pr } = await withOpenPr();
      expect(await hook(r, pr, true)).toBe("merged");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready", synced_public_sha: PUB_TIP, sync_pr: null, sync_head: null, verified: false });
      expect(await hook(r, pr, true)).toBe("none");
    });

    it("a sync pull request closed unmerged refuses a ready twin (sync_closed) and leaves the synced tip", async () => {
      const { r, pr } = await withOpenPr();
      expect(await hook(r, pr, false)).toBe("closed");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "sync_closed", synced_public_sha: SYNCED, sync_pr: null, sync_head: null });
    });

    it("a conflict stays a conflict, and a paused twin stays paused, whichever way the pull request ends", async () => {
      for (const state of ["conflict", "paused"]) {
        const merged = await withOpenPr({ state });
        expect(await hook(merged.r, merged.pr, true), state).toBe("merged");
        expect(await twinRow(merged.r.twinId), state).toMatchObject({ state, synced_public_sha: PUB_TIP, sync_pr: null });
        const closed = await withOpenPr({ state });
        expect(await hook(closed.r, closed.pr, false), state).toBe("closed");
        expect(await twinRow(closed.r.twinId), state).toMatchObject({ state, failure_code: null, synced_public_sha: SYNCED, sync_pr: null });
      }
    });

    it("a conflict twin is issued no sync and no update, so nothing leaves the twin while the two sides disagree", async () => {
      const r = await rig({ state: "conflict" });
      expect(await failureOf(() => issue(r))).toEqual({ status: 409, code: "twin_state" });
      expect(await jobRows(r.setupId)).toEqual([]);
    });

    it("a pull request that closes before the check wrote its number is the same pull request (the verified head is waiting)", async () => {
      const r = await rig();
      await verified(r, twinGithub());
      expect(await hook(r, 77, true)).toBe("merged");
      expect(await twinRow(r.twinId)).toMatchObject({ synced_public_sha: PUB_TIP, sync_head: null, verified: false });
      const late = await rig();
      await verified(late, twinGithub());
      expect(await hook(late, 78, false)).toBe("closed");
      expect(await twinRow(late.twinId)).toMatchObject({ state: "refused", failure_code: "sync_closed", sync_head: null });
    });

    it("acts only for the twin's own recorded pull request: another number, another branch, another repository, another account, a removed twin, and a twin with nothing open", async () => {
      const { r, pr } = await withOpenPr();
      const before = await twinRow(r.twinId);
      expect(await hook(r, pr + 1, true), "another number").toBe("none");
      expect(await hook(r, pr, true, "fx/twin-sync-000000000000"), "a branch no job of this twin named").toBe("none");
      expect(await hook(r, pr, true, "fx/publish-bbbbbbbbbbbb"), "the publish branch").toBe("none");
      expect(await hook(r, pr, true, "main"), "no branch").toBe("none");
      expect(await webhook(r.who.accountId, r.publicId, pr, true, BRANCH), "the public repository").toBe("none");
      expect(await webhook(r.who.accountId, randomUUID(), pr, true, BRANCH), "an unknown repository").toBe("none");
      const other = await rig();
      expect(await webhook(other.who.accountId, r.privateId, pr, true, BRANCH), "another account").toBe("none");
      expect(await twinRow(r.twinId)).toEqual(before);
      await h.admin.query("UPDATE repo_twins SET state = 'removed', removed_at = now() WHERE id = $1", [r.twinId]);
      expect(await hook(r, pr, true), "a removed twin").toBe("none");
      expect((await twinRow(r.twinId)).synced_public_sha).toBe(SYNCED);
      const idle = await rig();
      expect(await hook(idle, 5, true), "nothing open").toBe("none");
      expect(await call("SELECT twin_sync_pr_closed($1::uuid, $2, true, $3) AS r", [idle.privateId, 5, "x"], idle)).toEqual([{ r: "none" }]);
      expect(await call("SELECT twin_sync_pr_closed($1::uuid, NULL, true, $2) AS r", [idle.privateId, BRANCH], idle)).toEqual([{ r: "none" }]);
    });

    it("never touches a sibling twin of the same account, even when its job names a branch with the same twelve characters", async () => {
      const a = await rig();
      const ghA = twinGithub();
      await verified(a, ghA);
      expect(await open(a, ghA)).toBe("recorded");
      const b = await sibling(a);
      await h.admin.query("UPDATE repo_twins SET sync_pr = 40 WHERE id = $1", [b.twinId]);
      const before = await twinRow(b.twinId);
      expect(await hook(a, 40, true)).toBe("merged");
      expect(await twinRow(b.twinId)).toEqual(before);
      expect(await twinRow(a.twinId)).toMatchObject({ synced_public_sha: PUB_TIP });
      // the sibling's own repository, the same number, the same branch name, but a job that is not its own
      expect(await hook(b, 40, true)).toBe("none");
      expect(await twinRow(b.twinId)).toEqual(before);
    });
  });

  describe("the removal", () => {
    it("closes the sync pull request a removed twin still has open, on the private repository and by its recorded number, once", async () => {
      const r = await rig();
      const gh = twinGithub();
      await verified(r, gh);
      expect(await open(r, gh)).toBe("recorded");
      await h.admin.query("UPDATE repo_twins SET state = 'removed', removed_at = now() WHERE id = $1", [r.twinId]);
      const closes: unknown[] = [];
      const port = { ...gh.port, close: async (i: unknown) => (closes.push(i), undefined) } as unknown as SetupInstallPort;
      expect(await closeTwinSyncPr(depsFor({ setupInstall: port }), principal(r), r.twinId)).toBe("closed");
      expect(closes).toEqual([{ repo: { id: r.privateId, owner: "acme", name: "widgets-private" }, number: 40 }]);
    });

    it("answers by what GitHub says and never throws for it: a GitHub that cannot be asked leaves the pull request open (and says so), one that has no such pull request is `none`", async () => {
      const r = await rig({ pr: 12 });
      const gh = twinGithub();
      for (const [error, want] of [[new RunPullRequestError("unavailable", 503), "github_unavailable"], [new RunPullRequestError("rejected", 404), "none"]] as const) {
        const port = { ...gh.port, close: async () => Promise.reject(error) } as unknown as SetupInstallPort;
        expect(await closeTwinSyncPr(depsFor({ setupInstall: port }), principal(r), r.twinId)).toBe(want);
      }
      expect(await closeTwinSyncPr(depsFor({ setupInstall: null }), principal(r), r.twinId)).toBe("github_unavailable");
      const bug = { ...gh.port, close: async () => Promise.reject(new Error("a bug")) } as unknown as SetupInstallPort;
      await expect(closeTwinSyncPr(depsFor({ setupInstall: bug }), principal(r), r.twinId)).rejects.toThrow("a bug");
    });

    it("has nothing to close for a twin with no recorded pull request or a foreign twin, and refuses a member; a sibling's pull request is never the one closed", async () => {
      const a = await rig({ pr: 12 });
      const closes: Array<{ repo: { id: string }; number: number }> = [];
      const port = { close: async (i: { repo: { id: string }; number: number }) => (closes.push(i), undefined) } as unknown as SetupInstallPort;
      const deps = () => depsFor({ setupInstall: port });
      const b = await sibling(a);
      expect(await closeTwinSyncPr(deps(), principal(a), b.twinId)).toBe("none");
      expect(await closeTwinSyncPr(deps(), principal(a), randomUUID())).toBe("none");
      const other = await rig({ pr: 3 });
      expect(await closeTwinSyncPr(deps(), principal(a), other.twinId)).toBe("none");
      await expect(closeTwinSyncPr(deps(), principal(a, a.memberUser), a.twinId)).rejects.toMatchObject({ code: "42501" });
      expect(closes).toEqual([]);
      await h.admin.query("UPDATE repo_twins SET sync_pr = 9 WHERE id = $1", [b.twinId]);
      expect(await closeTwinSyncPr(deps(), principal(a), a.twinId)).toBe("closed");
      expect(await closeTwinSyncPr(deps(), principal(a), b.twinId)).toBe("closed");
      expect(closes.map((c) => [c.repo.id, c.number])).toEqual([[a.privateId, 12], [b.privateId, 9]]);
    });

    it("the app login with a foreign account reads and writes nothing of the twin's through any of the new functions", async () => {
      const a = await rig({ pr: 12 });
      const other = await rig();
      const asOther = { account: other.who.accountId, user: null };
      expect(await call("SELECT * FROM twin_sync_open_pr($1::uuid)", [a.twinId], a, asOther)).toEqual([]);
      expect(await call("SELECT * FROM twin_sync_pr_target($1::uuid)", [a.twinId], a, asOther)).toEqual([]);
      expect(await call("SELECT o_result FROM twin_sync_pr_record($1::uuid, $2, 3)", [a.twinId, PUSHED], a, asOther)).toEqual([{ o_result: "not_found" }]);
      expect(await call("SELECT o_result FROM twin_publish_update_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now())", [a.twinId, randomUUID()], a, asOther)).toEqual([{ o_result: "not_found" }]);
    });
  });

  describe("an open publish pull request is updated in place", () => {
    const HEAD1 = "d".repeat(40);
    const HEAD2 = "1".repeat(40);
    const PUB_PUSHED = "7".repeat(40);
    const UPDATED = "8".repeat(40);
    const FIRST = `fx/publish-${HEAD1.slice(0, 12)}`;
    const tips = (head: string) => ({ "acme/widgets-private": head, "acme/widgets": PUB_TIP, "acme/gadgets-private": head, "acme/gadgets": PUB_TIP });
    const mints: string[] = [];
    const publishHosted = () => ({ mintToken: async (repo: string) => (mints.push(repo), { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) }) }) as unknown as PlanePushHostedPort;
    const publish = (r: Rig, head: string, who: string | null = r.adminUser) => issueTwinPublish(depsFor({ pullRequests: github(tips(head)) }), principal(r, who), r.twinId);
    const jobArgs = async (r: Rig) => (await jobRows(r.setupId)).map((j) => (j.job.job as unknown as { args: Record<string, unknown> }).args);
    /** A twin whose publish of HEAD1 was pushed (as PUB_PUSHED) and whose pull request #7 is open: the first publish issued for real, then ended and recorded as the cloud's check does. */
    async function withOpenPublish(): Promise<Rig> {
      const r = await rig();
      expect(await publish(r, HEAD1)).toMatchObject({ outcome: "issued" });
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), ended_at = now(), last_seq = 2, push_token_at = now() WHERE setup_id = $1", [r.setupId]);
      await h.admin.query("UPDATE repo_twins SET publish_pr = 7, publish_head = $2 WHERE id = $1", [r.twinId, PUB_PUSHED]);
      return r;
    }

    it("signs a job for the SAME branch and base, to the new private head, carrying the recorded head as replaces_head; nothing else of the twin or its pull request moves", async () => {
      const r = await withOpenPublish();
      const out = await publish(r, HEAD2);
      expect(out).toMatchObject({ outcome: "issued", attempt: 2 });
      const [first, update] = await jobArgs(r);
      expect(update).toMatchObject({ branch: FIRST, replaces_head: PUB_PUSHED, private: { base: PRIV_TIP, head: HEAD2 }, public: { tip: PUB_TIP } });
      expect(update).not.toHaveProperty("branch", `fx/publish-${HEAD2.slice(0, 12)}`);
      expect(first).not.toHaveProperty("replaces_head");
      expect(await twinRow(r.twinId)).toMatchObject({ state: "ready" });
      expect((await h.admin.query("SELECT publish_pr, publish_head FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]).toEqual({ publish_pr: 7, publish_head: PUB_PUSHED });
      // a second issue while the update is under way finds the job live, and writes no second
      expect(await failureOf(() => publish(r, "2".repeat(40)))).toEqual({ status: 409, code: "publish_live" });
      expect(await jobRows(r.setupId)).toHaveLength(2);
    });

    it("signs nothing when the pull request already carries the private tip, and keeps the old refusal when no head was recorded for it", async () => {
      const r = await withOpenPublish();
      expect(await publish(r, HEAD1)).toEqual({ outcome: "in_sync" });
      expect(await jobRows(r.setupId)).toHaveLength(1);
      await h.admin.query("UPDATE repo_twins SET publish_head = NULL WHERE id = $1", [r.twinId]);
      expect(await failureOf(() => publish(r, HEAD2))).toEqual({ status: 409, code: "publish_open" });
      expect(await jobRows(r.setupId)).toHaveLength(1);
    });

    it("is for an owner or admin or the tick, only for a ready twin, and finds the twin of its own account only", async () => {
      const r = await withOpenPublish();
      expect(await failureOf(() => publish(r, HEAD2, r.memberUser))).toEqual({ status: 403, code: "forbidden" });
      for (const state of ["paused", "conflict", "refused"]) {
        await h.admin.query("UPDATE repo_twins SET state = $2 WHERE id = $1", [r.twinId, state]);
        expect(await failureOf(() => publish(r, HEAD2)), state).toEqual({ status: 409, code: "twin_state" });
      }
      await h.admin.query("UPDATE repo_twins SET state = 'ready' WHERE id = $1", [r.twinId]);
      const other = await rig();
      expect(await failureOf(() => issueTwinPublish(depsFor({ pullRequests: github(tips(HEAD2)) }), principal(other), r.twinId))).toEqual({ status: 404, code: "not_found" });
      expect(await publish(r, HEAD2, null)).toMatchObject({ outcome: "issued" });
      expect(await jobRows(r.setupId)).toHaveLength(2);
    });

    it("holds the signed bytes to the open pull request's own job and row: the definer refuses a different branch, base, replaces_head, head, set or kind", async () => {
      const r = await withOpenPublish();
      const [first] = await jobArgs(r);
      const good = {
        v: 1, job_id: randomUUID(), runner_id: r.runnerId, repo_gh_id: r.privateGh, setup_id: r.setupId, requires_engine: "any", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), kind: "twin_publish",
        args: { ...first, replaces_head: PUB_PUSHED, private: { ...(first!["private"] as object), head: HEAD2 } },
      };
      const args = good.args as Record<string, unknown>;
      const withArgs = (a: Record<string, unknown>) => ({ ...good, args: { ...args, ...a } });
      const update = (job: Record<string, unknown>, o: Parameters<typeof call>[3] = {}) =>
        call("SELECT o_result FROM twin_publish_update_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [r.twinId, job["job_id"], JSON.stringify({ job, key_id: "k1", signature: "x" }), job["issued_at"], job["expires_at"]], r, o);
      const forged: Record<string, Record<string, unknown>> = {
        "a branch named from the new head": withArgs({ branch: `fx/publish-${HEAD2.slice(0, 12)}` }),
        "another publish branch": withArgs({ branch: "fx/publish-000000000000" }),
        "a branch that is not a publish's": withArgs({ branch: "main" }),
        "a base that is not the pull request's": withArgs({ private: { ...(args["private"] as object), base: "9".repeat(40) } }),
        "no replaces_head": withArgs({ replaces_head: undefined }),
        "another replaces_head": withArgs({ replaces_head: "6".repeat(40) }),
        "a head equal to the base": withArgs({ private: { ...(args["private"] as object), head: PRIV_TIP } }),
        "a public side that is the twin": withArgs({ public: { ...(args["public"] as object), name: "widgets-private", gh_id: r.privateGh } }),
        "a set that is not the live one": withArgs({ private_set: { ...(args["private_set"] as object), overlay_globs: [] } }),
        "another twin": withArgs({ twin_id: randomUUID() }),
        "another machine": { ...good, runner_id: randomUUID() },
        "another kind": { ...good, kind: "twin_sync" },
      };
      for (const [what, job] of Object.entries(forged)) await expect(update(job), what).rejects.toMatchObject({ code: "42501" });
      await expect(update(good, { user: r.memberUser })).rejects.toMatchObject({ code: "42501" });
      await expect(update(good, { runner: r.runnerId })).rejects.toMatchObject({ code: "42501" });
      await expect(h.opsPool.query("SELECT * FROM twin_publish_update_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now())", [r.twinId, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      expect(await update(good)).toEqual([{ o_result: "ok" }]);
      // a twin whose pull request is not (or no longer) open is not updated, whatever job it once had
      await h.admin.query("UPDATE repo_twins SET publish_pr = NULL WHERE id = $1", [r.twinId]);
      expect(await update(good)).toEqual([{ o_result: "no_open_pr" }]);
      await h.admin.query("UPDATE repo_twins SET publish_pr = 7, publish_head = NULL WHERE id = $1", [r.twinId]);
      expect(await update(good)).toEqual([{ o_result: "no_open_pr" }]);
      await h.admin.query("UPDATE repo_twins SET publish_head = $2 WHERE id = $1", [r.twinId, PUB_PUSHED]);
      // 1110's own issue still turns an open pull request away: the update is its own definer's alone
      expect(await call("SELECT o_result FROM twin_publish_issue($1::uuid, $2::uuid, $3::jsonb, now(), now())", [r.twinId, good.job_id, JSON.stringify({ job: good })], r)).toEqual([{ o_result: "publish_open" }]);
      expect(await call("SELECT o_result FROM twin_publish_update_issue($1::uuid, $2::uuid, '{}'::jsonb, now(), now())", [randomUUID(), randomUUID()], r)).toEqual([{ o_result: "not_found" }]);
    });

    it("goes through the whole job on the open pull request's branch: the credential is the public repository's, the pushed head replaces the recorded one, the pull request is unchanged and nothing waits to be checked", async () => {
      const r = await withOpenPublish();
      mints.length = 0;
      expect(await publish(r, HEAD2)).toMatchObject({ outcome: "issued" });
      const taken = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      const job = verifyMachineJob((MachineJobClaimReply.parse(taken.body) as { signed_job: unknown }).signed_job, { k1: jobKeys.publicKey }, r.runnerId);
      expect(job).toMatchObject({ kind: "twin_publish", args: { branch: FIRST, replaces_head: PUB_PUSHED } });
      const jobId = job.job_id;
      await reportedToPush(r, jobId);
      const tokenRes = await respond(() => setupPushTokenRun(depsFor({ planePush: publishHosted() }), signed(r.key, setupPushTokenPath(r.setupId), { job_id: jobId }), r.setupId));
      expect(tokenRes.status).toBe(200);
      expect(mints).toEqual(["acme/widgets"]);
      expect((await pushed(r, jobId, UPDATED)).status).toBe(200);
      expect((await progress(r, jobId, { sub_step: "pr_open", state: "ok" })).status).toBe(200);
      expect((await jobRows(r.setupId))[1]).toMatchObject({ state: "done" });
      expect((await h.admin.query("SELECT publish_pr, publish_head, state FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]).toEqual({ publish_pr: 7, publish_head: UPDATED, state: "ready" });
      // no second pull request to find, and the merge anchors the twin on the UPDATE's private head
      expect(await checkTwinPublish(depsFor({ planePush: publishHosted() }), principal(r), r.twinId)).toBe("not_ready");
      const merged = await h.appPool.connect();
      try {
        await merged.query("BEGIN");
        await merged.query("SELECT set_config('app.account_id', $1, true)", [r.who.accountId]);
        expect((await merged.query("SELECT twin_publish_pr_closed($1::uuid, 7, true, $2, $3) AS r", [r.publicId, FIRST, UPDATED])).rows[0].r).toBe("merged");
        await merged.query("COMMIT");
      } finally {
        merged.release();
      }
      expect((await h.admin.query("SELECT published_private_sha, publish_pr, publish_head FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]).toEqual({ published_private_sha: HEAD2, publish_pr: null, publish_head: null });
    });

    /** The App's merge delivery of the PUBLIC repository for pull request 7 of the publish branch, with the head commit GitHub merged, in its own committed tenant session. */
    const publishMerged = async (r: Rig, sha: string | null): Promise<string> => {
      const c = await h.appPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true)", [r.who.accountId]);
        const out = (await c.query<{ r: string }>("SELECT twin_publish_pr_closed($1::uuid, 7, true, $2, $3) AS r", [r.publicId, FIRST, sha])).rows[0]!.r;
        await c.query("COMMIT");
        return out;
      } finally {
        c.release();
      }
    };
    const anchor = async (r: Rig) => (await h.admin.query("SELECT published_private_sha, publish_pr, publish_head FROM repo_twins WHERE id = $1", [r.twinId])).rows[0];

    it("a merge while an update is claimed but has not pushed anchors the twin on the head that was merged, not the update's (the race)", async () => {
      const r = await withOpenPublish();
      expect(await publish(r, HEAD2)).toMatchObject({ outcome: "issued" });
      await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((await jobRows(r.setupId))[1]).toMatchObject({ state: "delivered" });
      // GitHub merged the pull request at the first push (PUB_PUSHED); the update has pushed nothing
      expect(await publishMerged(r, PUB_PUSHED)).toBe("merged");
      expect(await anchor(r)).toEqual({ published_private_sha: HEAD1, publish_pr: null, publish_head: null });
    });

    it("an update that has pushed and reported is the anchor of a merge of ITS head, and the older head merged after it, or a merge naming no head, anchors nothing", async () => {
      const r = await withOpenPublish();
      expect(await publish(r, HEAD2)).toMatchObject({ outcome: "issued" });
      await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      const jobId = (await jobRows(r.setupId))[1]!.id;
      await reportedToPush(r, jobId);
      expect((await respond(() => setupPushTokenRun(depsFor({ planePush: publishHosted() }), signed(r.key, setupPushTokenPath(r.setupId), { job_id: jobId }), r.setupId))).status).toBe(200);
      expect((await pushed(r, jobId, UPDATED)).status).toBe(200);
      // pushed and reported: a merge of the update's head anchors on the update
      await h.admin.query("UPDATE repo_twins SET published_private_sha = $2 WHERE id = $1", [r.twinId, PRIV_TIP]);
      expect(await publishMerged(r, UPDATED)).toBe("merged");
      expect(await anchor(r)).toMatchObject({ published_private_sha: HEAD2 });
      // the older head merged after the update pushed (a stale delivery) anchors nothing: the base stays, the pull request is cleared
      await h.admin.query("UPDATE repo_twins SET published_private_sha = $2, publish_pr = 7, publish_head = $3 WHERE id = $1", [r.twinId, PRIV_TIP, UPDATED]);
      expect(await publishMerged(r, PUB_PUSHED)).toBe("merged");
      expect(await anchor(r)).toEqual({ published_private_sha: PRIV_TIP, publish_pr: null, publish_head: null });
      // and so does a merge that names no head
      await h.admin.query("UPDATE repo_twins SET publish_pr = 7, publish_head = $2 WHERE id = $1", [r.twinId, UPDATED]);
      expect(await publishMerged(r, null)).toBe("merged");
      expect(await anchor(r)).toEqual({ published_private_sha: PRIV_TIP, publish_pr: null, publish_head: null });
      // a head that is not a commit id is refused outright
      await h.admin.query("UPDATE repo_twins SET published_private_sha = $2, publish_pr = 7, publish_head = $3 WHERE id = $1", [r.twinId, PRIV_TIP, UPDATED]);
      expect(await publishMerged(r, "not-a-sha")).toBe("none");
    });

    it("a merge of the old head delivered AFTER the update pushed and finished never claims the update's changes: the base stays and the pull request is cleared", async () => {
      const r = await withOpenPublish();
      expect(await publish(r, HEAD2)).toMatchObject({ outcome: "issued" });
      await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      const jobId = (await jobRows(r.setupId))[1]!.id;
      await reportedToPush(r, jobId);
      // GitHub merged HEAD1's pull request, but the webhook has not landed: the update still gets its credential, pushes and finishes
      expect((await respond(() => setupPushTokenRun(depsFor({ planePush: publishHosted() }), signed(r.key, setupPushTokenPath(r.setupId), { job_id: jobId }), r.setupId))).status).toBe(200);
      expect((await pushed(r, jobId, UPDATED)).status).toBe(200);
      expect((await progress(r, jobId, { sub_step: "pr_open", state: "ok" })).status).toBe(200);
      expect((await jobRows(r.setupId))[1]).toMatchObject({ state: "done" });
      const before = (await anchor(r)).published_private_sha;
      expect(await publishMerged(r, PUB_PUSHED)).toBe("merged");
      expect(await anchor(r)).toEqual({ published_private_sha: before, publish_pr: null, publish_head: null });
      expect(before).toBe(PRIV_TIP);
    });

    it("an update job gets no push credential once the pull request has merged, whatever its progress", async () => {
      const r = await withOpenPublish();
      expect(await publish(r, HEAD2)).toMatchObject({ outcome: "issued" });
      await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      const jobId = (await jobRows(r.setupId))[1]!.id;
      await reportedToPush(r, jobId);
      expect(await publishMerged(r, PUB_PUSHED)).toBe("merged");
      mints.length = 0;
      const refused = await respond(() => setupPushTokenRun(depsFor({ planePush: publishHosted() }), signed(r.key, setupPushTokenPath(r.setupId), { job_id: jobId }), r.setupId));
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain("job_superseded");
      expect(mints).toEqual([]);
      expect((await h.admin.query("SELECT push_token_at FROM machine_jobs WHERE id = $1", [jobId])).rows[0]).toEqual({ push_token_at: null });
    });

    it("a branch someone else pushed to (public_branch_moved) refuses the twin with that code and leaves the pull request recorded", async () => {
      const r = await withOpenPublish();
      expect(await publish(r, HEAD2)).toMatchObject({ outcome: "issued" });
      await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      const jobId = (await jobRows(r.setupId))[1]!.id;
      await reportedToPush(r, jobId);
      expect((await progress(r, jobId, { sub_step: "push", state: "failed", failure_code: "public_branch_moved" })).status).toBe(200);
      expect((await jobRows(r.setupId))[1]).toMatchObject({ state: "failed" });
      expect((await h.admin.query("SELECT state, failure_code, publish_pr, publish_head FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]).toEqual({ state: "refused", failure_code: "public_branch_moved", publish_pr: 7, publish_head: PUB_PUSHED });
    });

    it("never updates a sibling twin's pull request, and the sibling's own open pull request is updated on its own branch", async () => {
      const a = await withOpenPublish();
      const b = await sibling(a);
      await h.admin.query("UPDATE repo_twins SET publish_pr = 9, publish_head = $2 WHERE id = $1", [b.twinId, PUB_PUSHED]);
      expect(await failureOf(() => publish(b, HEAD2))).toEqual({ status: 409, code: "publish_open" });
      expect(await jobRows(b.setupId)).toEqual([]);
      expect(await publish(a, HEAD2)).toMatchObject({ outcome: "issued" });
      expect(await jobRows(b.setupId)).toEqual([]);
      expect(await jobRows(a.setupId)).toHaveLength(2);
    });
  });

  /** FU-311 (migration 1116): what the visibility port answers for each repository of the rig; any repository not listed reads as unknown. */
  const seeing = (r: Rig, priv: "private" | "public" | "unknown", pub: "private" | "public" | "unknown" = "public"): Partial<RunnerCloudDeps> => ({ repoVisibility: async (_accountId: string, repoId: string) => (repoId === r.privateId ? priv : repoId === r.publicId ? pub : "unknown") });

  describe("the private repository must stay private (FU-311)", () => {
    it("opens no pull request for a twin whose private repository is public: refused, and nothing is sent to GitHub", async () => {
      const r = await rig();
      const gh = twinGithub();
      await verified(r, gh);
      const before = gh.calls.length;
      expect(await open(r, gh, seeing(r, "unknown"))).toBe("github_unavailable");
      expect(await open(r, gh, seeing(r, "public"))).toBe("refused");
      expect(gh.calls.length).toBe(before);
      expect(gh.prs).toHaveLength(0);
      expect(await twinRow(r.twinId)).toMatchObject({ state: "refused", failure_code: "twin_not_private" });
    });
  });
});
