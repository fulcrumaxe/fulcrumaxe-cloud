import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, PlanFile, setupPlanPath, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ENGINE_SOURCE_REPO, issueProjectSetup, machineJobClaimRun, retryInstall, setupPlanRun, type RunnerCloudDeps, type RunPullRequestPort } from "../src/index.js";
import { HELLO_PATH, runnerHello } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const SHA = "c".repeat(40);
const HEAD = "d".repeat(40);
const TAR = "e".repeat(64);
const ROADMAP = [
  { row_key: "A1", title: "First row", summary: "Do the first thing", size: "S", depends_on: [], keep: true },
  { row_key: "B2", title: "Second row", summary: "Then the second", size: "M", depends_on: ["A1"], keep: true },
  { row_key: "C3", title: "Dropped row", summary: "Not kept", size: "L", depends_on: [], keep: false },
];

/** [pg] D#845 ON-8b: issuing `project_setup` (real signature, real definers, row security forced) and the plan route, over the real signed HTTP path. */
describe("issuing project_setup and the plan route [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": jobKeys.publicKey };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; setupId: string; draftId: string }
  const github = (o: { head?: string | null; onRead?: () => Promise<void> } = {}): RunPullRequestPort =>
    ({
      defaultBranch: async () => "main",
      branchState: async () => {
        await o.onRead?.();
        const head = o.head === undefined ? HEAD : o.head;
        return { exists: head !== null, headOid: head, aheadBy: 0, defaultBranch: "main" };
      },
    }) as unknown as RunPullRequestPort;
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({
      pullRequests: github(),
      repoVisibility: async () => "private",
      engineCommandSigner: async () => ({ keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", jobKeys.privateKey) }) as never,
      ...over,
    });

  async function release(version: string, o: { minProtocol?: number; withdrawn?: boolean; at?: string; commit?: string } = {}) {
    await h.admin.query("INSERT INTO engine_releases (version, commit_sha, tarball_sha256, min_runner_protocol, published_by, published_at, withdrawn_at) VALUES ($1, $2, $3, $4, 'test', $5, $6)", [
      version, o.commit ?? SHA, TAR, o.minProtocol ?? 22, o.at ?? new Date().toISOString(), o.withdrawn ? new Date().toISOString() : null,
    ]);
  }
  /** A fresh account: a repo with a name, a machine (hello at protocol 22) holding the placement, a setup, and an approved draft whose approver has a login. */
  async function rig(o: { login?: string | null; draft?: boolean; place?: boolean; roadmap?: unknown; phase?: string } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    await h.admin.query("UPDATE users SET github_login = $2 WHERE id = $1", [who.userId, o.login === undefined ? "boss-login" : o.login]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, {
      protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" },
    })));
    expect(hello.status).toBe(200);
    if (o.place !== false) await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, $4) RETURNING id", [who.accountId, who.repoId, who.userId, o.phase ?? "plan"])).rows[0]!.id;
    const draftId = randomUUID();
    if (o.draft !== false) {
      await h.admin.query(
        "INSERT INTO project_drafts (id, account_id, repo_id, setup_id, source, prd_md, roadmap, status, approved_by, approved_at, final_at) VALUES ($1, $2, $3, $4, 'survey', $5, $6::jsonb, 'approved', $7, now(), now())",
        [draftId, who.accountId, who.repoId, setupId, "# Widgets\n\nA small thing.", JSON.stringify(o.roadmap ?? ROADMAP), who.userId],
      );
    }
    return { who, key, runnerId, setupId, draftId };
  }
  const principal = (r: Rig) => ({ accountId: r.who.accountId, userId: r.who.userId });
  const issue = (r: Rig, over: Partial<RunnerCloudDeps> = {}) => issueProjectSetup(depsFor(over), principal(r), r.setupId);
  const refusal = async (p: Promise<unknown>) => p.then(() => ({ status: 0, code: "none" }), (e: { status: number; code: string }) => ({ status: e.status, code: e.code }));
  const fetchPlan = (r: Rig, version: number, o: { setupId?: string; key?: TestKey } = {}) => {
    const path = setupPlanPath(o.setupId ?? r.setupId, version);
    return respond(() => setupPlanRun(depsFor(), signed(o.key ?? r.key, path, null, { method: "GET", rawBody: Buffer.alloc(0) }), `?version=${version}`, o.setupId ?? r.setupId));
  };
  const lastJob = async (setupId: string) => (await h.admin.query<{ id: string; job: { job: MachineJob; key_id: string }; state: string; attempt: number }>("SELECT id, job, state, attempt FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt DESC LIMIT 1", [setupId])).rows[0]!;

  it("issues a job the runner's keyring verifies, with the derived tarball URL, the newest compatible release and the plan hash, and moves the setup to install", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    await release("1.0.0", { at: "2026-01-01T00:00:00Z" });
    await release("1.2.0", { at: "2026-03-01T00:00:00Z", commit: "9".repeat(40) });
    await release("1.3.0", { at: "2026-04-01T00:00:00Z", withdrawn: true });
    await release("1.4.0", { at: "2026-05-01T00:00:00Z", minProtocol: 99 });
    const r = await rig();
    const out = await issue(r);
    expect(out.attempt).toBe(1);
    const row = await lastJob(r.setupId);
    const job = verifyMachineJob(row.job, keyring, r.runnerId);
    expect(job.kind).toBe("project_setup");
    if (job.kind !== "project_setup") throw new Error("kind");
    expect(job.args.engine).toEqual({ version: "1.2.0", commit_sha: "9".repeat(40), tarball_url: `https://codeload.github.com/${ENGINE_SOURCE_REPO}/tar.gz/${"9".repeat(40)}`, tarball_sha256: TAR });
    expect(job).toMatchObject({ setup_id: r.setupId, requires_engine: "any", args: { mode: "pr", base_sha: HEAD, branch: "fx/engine-install-1.2.0", plan_ref: { draft_id: r.draftId, version: 1 } } });
    const s = (await h.admin.query("SELECT phase, state, engine_version, attempt, plan_setup FROM project_setups WHERE id = $1", [r.setupId])).rows[0];
    expect(s).toMatchObject({ phase: "install", state: "started", engine_version: "1.2.0", attempt: 1, plan_setup: { repo_owner: "acme", repo_name: "widgets", default_branch: "main", visibility: "private", boss_github_username: "boss-login", kind: "existing" } });
    // The runner picks it up through the real claim route and the signed bytes are the issued ones.
    const picked = await respond(() => machineJobClaimRun(depsFor(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
    expect(picked.status).toBe(200);
    expect((picked.body as { signed_job: unknown }).signed_job).toEqual(row.job);
  });

  it("serves a plan whose bytes hash to plan_ref.sha256, kept rows only, parsed strictly", async () => {
    const r = await rig();
    await issue(r);
    const job = (await lastJob(r.setupId)).job.job;
    if (job.kind !== "project_setup") throw new Error("kind");
    const res = await fetchPlan(r, 1);
    expect(res.status).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("no-store");
    const bytes = JSON.stringify(res.body);
    expect(createHash("sha256").update(bytes, "utf8").digest("hex")).toBe(job.args.plan_ref.sha256);
    const plan = PlanFile.parse(res.body);
    expect(plan.roadmap.map((x) => x.row_key)).toEqual(["A1", "B2"]);
    expect(plan.setup).toEqual({ kind: "existing", repo_owner: "acme", repo_name: "widgets", default_branch: "main", visibility: "private", boss_github_username: "boss-login" });
  });

  it("refuses the plan route for another machine, another version, another account, a setup not in install, a bad query and an unsigned call", async () => {
    const r = await rig();
    await issue(r);
    const other = await rig();
    expect((await fetchPlan(r, 2)).status).toBe(404);
    expect((await fetchPlan(r, 1, { key: other.key })).status).toBe(404);
    // A second machine of the SAME account, not the one the project is placed on.
    const sibling = newKey();
    await registerKey(h.admin, r.who.accountId, r.who.userId, sibling);
    expect((await fetchPlan(r, 1, { key: sibling })).status).toBe(404);
    expect((await fetchPlan(other, 1, { setupId: r.setupId })).status).toBe(404);
    expect((await fetchPlan(r, 1, { setupId: randomUUID() })).status).toBe(404);
    await h.admin.query("UPDATE project_setups SET phase = 'await_merge' WHERE id = $1", [r.setupId]);
    expect((await fetchPlan(r, 1)).status).toBe(404);
    await h.admin.query("UPDATE project_setups SET phase = 'install' WHERE id = $1", [r.setupId]);
    await h.admin.query("UPDATE project_drafts SET status = 'discarded', approved_by = NULL, approved_at = NULL WHERE id = $1", [r.draftId]);
    expect((await fetchPlan(r, 1)).status).toBe(404);
    expect((await respond(() => setupPlanRun(depsFor(), signed(r.key, setupPlanPath(r.setupId, 1), null, { method: "GET", rawBody: Buffer.alloc(0) }), "?version=1&x=1", r.setupId))).status).toBe(400);
    expect((await respond(() => setupPlanRun(depsFor(), signed(r.key, setupPlanPath(r.setupId, 1), null, { method: "GET", rawBody: Buffer.alloc(0) }), "?version=01", r.setupId))).status).toBe(400);
    expect((await respond(() => setupPlanRun(depsFor(), { method: "GET", headers: {}, body: Buffer.alloc(0) }, "?version=1", r.setupId))).status).toBe(401);
  });

  it("refuses engine_release_unset, boss_login_missing, plan_not_approved, setup_not_placed and plan_invalid, and writes nothing", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    const noRelease = await rig();
    expect(await refusal(issue(noRelease))).toEqual({ status: 409, code: "engine_release_unset" });
    await release("2.0.0");
    for (const login of [null, "a--b", "-lead", "x".repeat(40)]) {
      const r = await rig({ login });
      expect(await refusal(issue(r))).toEqual({ status: 409, code: "boss_login_missing" });
    }
    expect(await refusal(issue(await rig({ draft: false })))).toEqual({ status: 409, code: "plan_not_approved" });
    // An approved draft of the same repo that belongs to no setup (an earlier, removed one) is not this setup's plan.
    const orphan = await rig({ draft: false });
    await h.admin.query("INSERT INTO project_drafts (account_id, repo_id, setup_id, source, prd_md, roadmap, status, approved_by, approved_at, final_at) VALUES ($1, $2, NULL, 'survey', '# Old', $3::jsonb, 'approved', $4, now(), now())", [orphan.who.accountId, orphan.who.repoId, JSON.stringify(ROADMAP), orphan.who.userId]);
    expect(await refusal(issue(orphan))).toEqual({ status: 409, code: "plan_not_approved" });
    expect(await refusal(issue(await rig({ place: false })))).toEqual({ status: 409, code: "setup_not_placed" });
    const none = await rig({ roadmap: ROADMAP.map((x) => ({ ...x, keep: false })) });
    expect(await refusal(issue(none))).toEqual({ status: 409, code: "plan_invalid" });
    const dangling = await rig({ roadmap: [{ ...ROADMAP[1]!, keep: true }, { ...ROADMAP[0]!, keep: false }] });
    expect(await refusal(issue(dangling))).toEqual({ status: 409, code: "plan_invalid" });
    expect((await h.admin.query("SELECT count(*)::int AS n FROM machine_jobs WHERE setup_id = $1", [dangling.setupId])).rows[0]!.n).toBe(0);
    expect((await h.admin.query("SELECT phase FROM project_setups WHERE id = $1", [dangling.setupId])).rows[0]!.phase).toBe("plan");
  });

  it("refuses a public or unknown repo, an empty default branch, a GitHub failure, an unconfigured signer or port, a phase that is not plan or install, and another account's setup", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    await release("2.0.0");
    const r = await rig();
    expect(await refusal(issue(r, { repoVisibility: async () => "public" }))).toEqual({ status: 409, code: "public_repo" });
    expect(await refusal(issue(r, { repoVisibility: async () => "unknown" }))).toEqual({ status: 409, code: "repo_visibility_unknown" });
    expect(await refusal(issue(r, { pullRequests: github({ head: null }) }))).toEqual({ status: 409, code: "default_branch_empty" });
    expect(await refusal(issue(r, { engineCommandSigner: async () => null }))).toEqual({ status: 503, code: "not_configured" });
    expect(await refusal(issue(r, { pullRequests: null }))).toEqual({ status: 503, code: "not_configured" });
    await h.admin.query("UPDATE project_setups SET phase = 'finish' WHERE id = $1", [r.setupId]);
    expect(await refusal(issue(r))).toEqual({ status: 409, code: "setup_phase" });
    expect(await refusal(issueProjectSetup(depsFor(), principal(await rig()), r.setupId))).toEqual({ status: 404, code: "not_found" });
  });

  it("writes nothing when the plan changes while the job is made", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    await release("2.0.0");
    const r = await rig();
    const code = await refusal(issue(r, { pullRequests: github({ onRead: async () => void (await h.admin.query("UPDATE project_drafts SET prd_md = 'changed' WHERE id = $1", [r.draftId])) }) }));
    expect(code).toEqual({ status: 409, code: "setup_changed" });
    expect((await h.admin.query("SELECT count(*)::int AS n FROM machine_jobs WHERE setup_id = $1", [r.setupId])).rows[0]!.n).toBe(0);
  });

  it("only an owner or admin of the account can issue: a plain member, a runner session and no person at all are refused by the definer itself", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    await release("2.0.0");
    const r = await rig();
    const member = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [member, `${member}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [r.who.accountId, member]);
    expect(await refusal(issueProjectSetup(depsFor(), { accountId: r.who.accountId, userId: member }, r.setupId))).toEqual({ status: 403, code: "forbidden" });
    const sql = "SELECT machine_job_issue($1, $2, $3, $4, 'project_setup', '{}'::jsonb, now(), now() + interval '1 minute')";
    const args = [randomUUID(), r.runnerId, r.who.repoId, r.setupId];
    for (const [label, run] of [
      ["member", () => withTenant(h.appPool, r.who.accountId, member, (c) => c.query(sql, args))],
      ["no person", () => withTenant(h.appPool, r.who.accountId, (c) => c.query(sql, args))],
      ["runner session", () => withTenant(h.appPool, r.who.accountId, r.who.userId, async (c) => { await c.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]); return c.query(sql, args); })],
    ] as const) {
      await expect(run(), label).rejects.toMatchObject({ code: "42501" });
    }
    await h.admin.query("UPDATE account_members SET role = 'admin' WHERE user_id = $1", [member]);
    expect((await issueProjectSetup(depsFor(), { accountId: r.who.accountId, userId: member }, r.setupId)).attempt).toBe(1);
  });

  it("retry: owner or admin, only phase install with a failed or expired job, and one click makes one job", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    await release("2.0.0");
    const r = await rig();
    await issue(r);
    const first = await lastJob(r.setupId);
    expect(await refusal(retryInstall(depsFor(), principal(r), r.setupId))).toEqual({ status: 409, code: "not_retryable" });
    expect(await refusal(retryInstall(depsFor(), principal(r), "not-an-id"))).toEqual({ status: 404, code: "not_found" });
    expect(await refusal(retryInstall(depsFor(), principal(await rig()), r.setupId))).toEqual({ status: 404, code: "not_found" });
    // A job that lapsed (expired by the clock) can be retried; the definer marks it expired before the new attempt is made.
    const past = { issued: new Date(Date.now() - 40 * 60_000).toISOString(), expires: new Date(Date.now() - 10 * 60_000).toISOString() };
    await h.admin.query(
      "UPDATE machine_jobs SET issued_at = $2::timestamptz, expires_at = $3::timestamptz, job = jsonb_set(jsonb_set(job, '{job,issued_at}', to_jsonb($2::text)), '{job,expires_at}', to_jsonb($3::text)) WHERE id = $1",
      [first.id, past.issued, past.expires],
    );
    const results = await Promise.all([refusal(retryInstall(depsFor(), principal(r), r.setupId)), refusal(retryInstall(depsFor(), principal(r), r.setupId))]);
    expect(results.filter((x) => x.code === "none")).toHaveLength(1);
    expect(results.filter((x) => x.code === "not_retryable")).toHaveLength(1);
    const second = await lastJob(r.setupId);
    expect(second.attempt).toBe(2);
    expect((await h.admin.query("SELECT state FROM machine_jobs WHERE id = $1", [first.id])).rows[0]!.state).toBe("expired");
    // A failed step makes it retryable again; a failed setup in another phase is not.
    await h.admin.query("UPDATE project_setups SET state = 'failed', failure_code = 'bootstrap_failed', failure_at = now() WHERE id = $1", [r.setupId]);
    expect((await retryInstall(depsFor(), principal(r), r.setupId)).status).toBe(200);
    expect((await h.admin.query("SELECT state, failure_code, attempt FROM project_setups WHERE id = $1", [r.setupId])).rows[0]).toMatchObject({ state: "started", failure_code: null, attempt: 3 });
    await h.admin.query("UPDATE project_setups SET phase = 'plan', state = 'failed', failure_code = 'bootstrap_failed', failure_at = now() WHERE id = $1", [r.setupId]);
    expect(await refusal(retryInstall(depsFor(), principal(r), r.setupId))).toEqual({ status: 409, code: "not_retryable" });
    const member = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [member, `${member}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [r.who.accountId, member]);
    expect(await refusal(retryInstall(depsFor(), { accountId: r.who.accountId, userId: member }, r.setupId))).toEqual({ status: 403, code: "forbidden" });
  });

  /** Moves a job's life into the past, in the row and in the signed bytes the row is bound to. */
  async function lapse(jobId: string, o: { delivered?: boolean; lastSeq?: number; progressAgoS?: number } = {}) {
    const issued = new Date(Date.now() - 40 * 60_000).toISOString();
    const expires = new Date(Date.now() - 10 * 60_000).toISOString();
    await h.admin.query(
      "UPDATE machine_jobs SET issued_at = $2::timestamptz, expires_at = $3::timestamptz, job = jsonb_set(jsonb_set(job, '{job,issued_at}', to_jsonb($2::text)), '{job,expires_at}', to_jsonb($3::text)) WHERE id = $1",
      [jobId, issued, expires],
    );
    if (o.delivered) {
      await h.admin.query("UPDATE machine_jobs SET state = 'delivered', delivered_at = now() - interval '35 minutes', last_seq = $2, last_progress_at = now() - ($3 || ' seconds')::interval WHERE id = $1", [jobId, o.lastSeq ?? null, String(o.progressAgoS ?? 0)]);
    }
  }

  it("retry: two clicks that really overlap on the row lock make one job", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    await release("2.0.0");
    const r = await rig();
    await issue(r);
    const first = await lastJob(r.setupId);
    await lapse(first.id);
    // Caller A is held just before machine_job_issue, holding the setup's row lock, until caller B is waiting on that lock.
    let aAtGate = false;
    const waitingOnLock = async () => (await h.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%' AND datname = current_database()")).rows[0]!.n;
    const gate = async () => {
      aAtGate = true;
      for (let i = 0; i < 200 && (await waitingOnLock()) === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await waitingOnLock()).toBeGreaterThan(0);
    };
    const gatedPool = new Proxy(h.appPool, {
      get(target, prop) {
        if (prop !== "connect") return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, p) {
              if (p === "query") {
                return async (...a: unknown[]) => {
                  if (typeof a[0] === "string" && a[0].startsWith("SELECT machine_job_issue(")) await gate();
                  return (c.query as (...x: unknown[]) => Promise<unknown>)(...a);
                };
              }
              const v = Reflect.get(c, p);
              return typeof v === "function" ? v.bind(c) : v;
            },
          });
        };
      },
    });
    const a = refusal(retryInstall(depsFor({ appUserPool: gatedPool as never }), principal(r), r.setupId));
    for (let i = 0; i < 200 && !aAtGate; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(aAtGate).toBe(true);
    const b = refusal(retryInstall(depsFor(), principal(r), r.setupId));
    const results = await Promise.all([a, b]);
    expect(results.map((x) => x.code).sort()).toEqual(["none", "not_retryable"]);
    const jobs = (await h.admin.query<{ attempt: number; state: string }>("SELECT attempt, state FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt", [r.setupId])).rows;
    expect(jobs).toEqual([{ attempt: 1, state: "expired" }, { attempt: 2, state: "issued" }]);
  });

  it("retry: a delivered job that is still reporting is not taken for a lapsed one, past expires_at or not", async () => {
    await h.admin.query("DELETE FROM engine_releases");
    await release("2.0.0");
    const r = await rig();
    await issue(r);
    const job = await lastJob(r.setupId);
    // Delivered 35 minutes ago, last report just now, expires_at 10 minutes in the past: 1053 does not cut it off.
    await lapse(job.id, { delivered: true, lastSeq: 5, progressAgoS: 5 });
    expect(await refusal(retryInstall(depsFor(), principal(r), r.setupId))).toEqual({ status: 409, code: "not_retryable" });
    expect((await h.admin.query("SELECT state FROM machine_jobs WHERE id = $1", [job.id])).rows[0]!.state).toBe("delivered");
    expect((await h.admin.query("SELECT count(*)::int AS n FROM machine_jobs WHERE setup_id = $1", [r.setupId])).rows[0]!.n).toBe(1);
    // Silent for 11 minutes: expired by the definer (job_silent), and then retryable.
    await h.admin.query("UPDATE machine_jobs SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [job.id]);
    expect((await retryInstall(depsFor(), principal(r), r.setupId)).status).toBe(200);
    expect((await h.admin.query("SELECT state FROM machine_jobs WHERE id = $1", [job.id])).rows[0]!.state).toBe("expired");
    // A job that never reported and is past expires_at is expired (job_expired) and retryable too.
    await lapse((await lastJob(r.setupId)).id);
    expect((await retryInstall(depsFor(), principal(r), r.setupId)).status).toBe(200);
    expect((await lastJob(r.setupId)).attempt).toBe(3);
  });

  it("retry: lapsing is the definer's, for a person only: a member, a runner session and no person are refused", async () => {
    const r = await rig();
    const member = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [member, `${member}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [r.who.accountId, member]);
    const sql = "SELECT machine_job_lapse($1::uuid)";
    await expect(withTenant(h.appPool, r.who.accountId, member, (c) => c.query(sql, [r.setupId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(h.appPool, r.who.accountId, (c) => c.query(sql, [r.setupId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(h.appPool, r.who.accountId, r.who.userId, async (c) => { await c.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]); return c.query(sql, [r.setupId]); })).rejects.toMatchObject({ code: "42501" });
    await expect(h.appPool.query("SELECT last_seq FROM machine_jobs")).rejects.toThrow(/permission denied/);
  });
});
